import { withFleetReadSlot } from './concurrency.js';

/**
 * O prazo de uma leitura da COLEÇÃO INTEIRA de dispositivos.
 *
 * Os 15 s do conector são para um aparelho. A frota toda, numa rede de 20k
 * ONTs, passa disso — e a leitura que estoura o prazo não falha uma vez: falha
 * a cada ciclo, porque o próximo ciclo pede a mesma frota do mesmo tamanho. A
 * sincronização de IDs e o mapa já usavam 60 s; o painel, a telemetria, a
 * listagem e a marcação automática usavam os 15 s e caíam sempre no mesmo
 * "aborted" nas redes grandes. Um prazo só para todas as leituras de frota.
 */
export const FLEET_READ_TIMEOUT_MS = 60_000;

const registry = new Set();

/**
 * Uma família de leituras de frota compartilhadas, por chave.
 *
 * Duas coisas, e a primeira não muda resultado nenhum:
 *
 * - **Em voo:** quem pede uma chave que já está sendo lida espera a MESMA
 *   requisição. O painel, a varredura de alertas e a sincronização de IDs
 *   acordam no mesmo minuto e pediam a mesma frota três vezes ao mesmo ACS.
 * - **Prazo curto (`ttlMs`):** o resultado que acabou de chegar serve a quem
 *   pedir logo depois. Só onde quem chama aceita dado de alguns segundos — o
 *   prazo é escolha de cada chamador, e zero (o padrão) é "só em voo".
 *
 * `fresh` pula o resultado guardado (mas ainda se junta a uma leitura em voo,
 * que é tão nova quanto uma que começasse agora) — é o "atualizar" do operador.
 *
 * Falha nunca é guardada: o próximo pedido tenta de novo, como sempre tentou.
 * `maxEntries` limita quantas chaves ficam guardadas, porque cada uma é uma
 * frota inteira no heap; a mais antiga sai primeiro.
 *
 * A chave é de quem chama, e TEM de levar o provedor (ou o ACS, numa leitura
 * fora do escopo): uma chave sem provedor entregaria a frota de um ao outro.
 */
export function createFleetReads({ maxEntries = 64 } = {}) {
  const entries = new Map();

  const prune = (now) => {
    for (const [key, entry] of entries) {
      if (!entry.promise && !(entry.expiresAt > now)) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = [...entries.entries()].find(([, entry]) => !entry.promise);
      if (!oldest) break;
      entries.delete(oldest[0]);
    }
  };

  const family = {
    async read(key, load, { ttlMs = 0, fresh = false, gate = true } = {}) {
      const now = Date.now();
      const entry = entries.get(key);
      if (entry?.promise) return entry.promise;
      if (!fresh && entry && entry.expiresAt > now) return entry.value;

      const work = (gate ? withFleetReadSlot(load) : load());
      const slot = { promise: work, value: undefined, expiresAt: 0 };
      entries.set(key, slot);
      try {
        const value = await work;
        if (entries.get(key) === slot) {
          if (ttlMs > 0) {
            slot.value = value;
            slot.expiresAt = Date.now() + ttlMs;
            slot.promise = null;
          } else {
            entries.delete(key);
          }
        }
        prune(Date.now());
        return value;
      } catch (error) {
        if (entries.get(key) === slot) entries.delete(key);
        throw error;
      }
    },

    /** Esquece uma chave, ou todas as que começam com `prefix`. */
    forget(prefix = '') {
      for (const key of [...entries.keys()]) {
        if (!prefix || key.startsWith(prefix)) entries.delete(key);
      }
    },

    get size() {
      return entries.size;
    }
  };
  registry.add(family);
  return family;
}

/**
 * Esquece toda leitura guardada, de toda família. O console chama (por
 * `forgetSharedAcs`) quando muda o endereço, o modo ou a tag de um provedor —
 * a frota que estava guardada pode não ser mais a dele — e os testes, entre um
 * caso e outro.
 */
export function forgetFleetReads() {
  for (const family of registry) family.forget();
}

/**
 * Quantos bytes de URL uma leitura da NBI pode ter, com folga.
 *
 * A NBI do GenieACS é o `http` do Node: a linha do pedido conta no limite de
 * cabeçalho dele (`--max-http-header-size`, 16 KiB por padrão), e um proxy na
 * frente costuma cortar antes — o nginx recusa com 414 a linha que não cabe
 * num buffer de `large_client_header_buffers` (8 KiB por padrão). A projeção e
 * a busca vão na URL do GET, então uma projeção unida (ou uma busca) grande
 * demais deixaria de chegar. 6 KiB fica abaixo dos dois.
 */
export const NBI_URL_BUDGET = 6 * 1024;

/**
 * Uma foto da frota por provedor e escopo, servida a quem pedir um
 * subconjunto da projeção dela.
 *
 * `createFleetReads` só junta pedidos IGUAIS; o painel, a telemetria, o mapa e
 * a identidade pedem a mesma frota com projeções diferentes, e cada um era uma
 * frota inteira a mais. Aqui a leitura é UMA, com a projeção unida de quem
 * costuma ler (`union`, calculada só quando é preciso ir ao ACS), e quem pede
 * um subconjunto dela recebe a mesma resposta:
 *
 * - **Em voo:** quem pede campos que uma leitura em voo já traz espera por
 *   ela — também com `fresh`, porque ela é tão nova quanto uma que começasse
 *   agora.
 * - **Guardada (`ttlMs`):** a foto que acabou de chegar serve quem pedir
 *   campos dela até vencer; ao vencer, sai da memória (um temporizador, não a
 *   próxima leitura, para um provedor quieto não segurar a frota no heap).
 * - **`fresh`:** vai ao ACS, e a foto nova substitui a guardada.
 *
 * Uma foto por chave, e falha nunca é guardada. A chave é de quem chama e TEM
 * de levar o provedor, o escopo de equipamentos e o ACS: é ela que impede a
 * foto de um ir a outro. As linhas podem ter mais campos do que cada um pediu
 * — quem lê só lê o que conhece, e nunca altera a linha.
 */
export function createFleetSnapshots({ maxEntries = 128 } = {}) {
  const snapshots = new Map();
  const loads = new Map();
  let sequence = 0;

  const covers = (fields, wanted) => wanted.every((field) => fields.has(field));

  const drop = (key, snapshot) => {
    if (snapshots.get(key) !== snapshot) return;
    clearTimeout(snapshot.timer);
    snapshots.delete(key);
  };

  const family = {
    /**
     * `fields`: o que quem chama precisa. `union(fields)`: a projeção de
     * todos os consumidores conhecidos, pedida junto com `fields` — ou `null`,
     * e então `separate(fields)` lê sem foto. `load(projection)`: a leitura de
     * verdade, com a projeção dada.
     */
    async read(key, fields, {
      union = async () => [], load, separate = null, ttlMs = 0, fresh = false, gate = true
    }) {
      const wanted = [...new Set(fields)];
      // Uma leitura em voo cuja projeção ainda está sendo decidida (a união é
      // assíncrona) também conta: quem chega espera a decisão e então vê se
      // ela traz o que ele precisa.
      for (const pending of [...(loads.get(key) ?? [])]) {
        const pendingFields = await pending.fields;
        if (pendingFields && covers(pendingFields, wanted)) return pending.promise;
      }
      const guardada = snapshots.get(key);
      if (!fresh && guardada && guardada.expiresAt > Date.now() && covers(guardada.fields, wanted)) {
        return guardada.rows;
      }

      sequence += 1;
      const seq = sequence;
      let decide;
      const pending = {
        fields: new Promise((resolve) => { decide = resolve; }),
        promise: null,
        forgotten: false
      };
      loads.set(key, [...(loads.get(key) ?? []), pending]);
      try {
        let extra;
        try {
          extra = await union(wanted);
        } catch (error) {
          decide(null);
          throw error;
        }
        // `null`: a projeção unida não cabe numa leitura (`NBI_URL_BUDGET`), e
        // quem chama lê só o que pediu, pelo caminho de sempre.
        if (extra === null && separate) {
          decide(null);
          return await separate(wanted);
        }
        const projection = [...new Set([...wanted, ...(extra ?? [])])];
        const fieldSet = new Set(projection);
        // A promessa antes da decisão: quem acordar com a decisão já a encontra.
        pending.promise = gate ? withFleetReadSlot(() => load(projection)) : load(projection);
        decide(fieldSet);
        const rows = await pending.promise;
        const atual = snapshots.get(key);
        if (ttlMs > 0 && !pending.forgotten && (!atual || atual.seq < seq)) {
          if (atual) drop(key, atual);
          const snapshot = { seq, fields: fieldSet, rows, expiresAt: Date.now() + ttlMs, timer: null };
          snapshot.timer = setTimeout(() => drop(key, snapshot), ttlMs);
          snapshot.timer.unref?.();
          snapshots.set(key, snapshot);
          while (snapshots.size > maxEntries) {
            const [oldestKey, oldest] = snapshots.entries().next().value;
            drop(oldestKey, oldest);
          }
        }
        return rows;
      } finally {
        const restantes = (loads.get(key) ?? []).filter((item) => item !== pending);
        if (restantes.length) loads.set(key, restantes);
        else loads.delete(key);
      }
    },

    /** Esquece uma chave, ou todas as que começam com `prefix`. */
    forget(prefix = '') {
      for (const [key, snapshot] of [...snapshots.entries()]) {
        if (!prefix || key.startsWith(prefix)) drop(key, snapshot);
      }
      // A leitura em voo é do endereço ou da tag de antes: ninguém mais se
      // junta a ela, e o que ela trouxer não vira foto.
      for (const [key, pendentes] of [...loads.entries()]) {
        if (prefix && !key.startsWith(prefix)) continue;
        for (const item of pendentes) item.forgotten = true;
        loads.delete(key);
      }
    },

    /** Os campos da foto guardada de `key`, ou `null`. Para os testes. */
    fieldsOf(key) {
      const snapshot = snapshots.get(key);
      return snapshot ? [...snapshot.fields] : null;
    },

    get size() {
      return snapshots.size;
    }
  };
  registry.add(family);
  return family;
}
