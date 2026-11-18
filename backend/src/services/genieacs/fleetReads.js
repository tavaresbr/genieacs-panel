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
