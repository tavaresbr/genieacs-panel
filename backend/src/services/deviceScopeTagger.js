import AppState from '../models/AppState.js';
import { currentTenantId } from '../config/tenantContext.js';
import Setting from '../models/Setting.js';
import DeviceService from './deviceService.js';
import DirectConnector, { DEVICE_SCOPE_KEY, withoutDeviceScope } from './genieacs/direct.js';
import { connectorFor } from './genieacs/connector.js';
import { NBI_URL_BUDGET } from './genieacs/fleetReads.js';

/** Onde ficam os prefixos PPPoE da marcação automática, em texto separado por vírgula. */
export const AUTO_PREFIXES_KEY = 'deviceScopeAutoPrefixes';

/** Até quantos prefixos um provedor tem, e o tamanho de cada um. */
export const AUTO_PREFIXES_MAX = 20;
export const AUTO_PREFIX_MAX_LENGTH = 64;

/** O resumo da última passada automática, que o console mostra. */
const LAST_AUTO_KEY = 'device_scope_auto_tag';

/** De quanto em quanto tempo o agendador passa pela frota. */
export const AUTO_TAG_INTERVAL_MS = 15 * 60_000;

/** `'TA100, ta200'` ou `['TA100']` → `['ta100', 'ta200']`: sem vazios nem repetidos. */
export function parsePrefixes(raw) {
  const texto = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return [...new Set(texto.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean))];
}

/** Um prefixo é começo do outro — os dois reivindicariam as mesmas ONTs. */
export function prefixesOverlap(a, b) {
  return a.startsWith(b) || b.startsWith(a);
}

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * O "casa com os prefixos ou com os seriais" como busca da NBI, ou `null`
 * quando não há o que casar.
 *
 * É um SUPERCONJUNTO do que `run` casa do lado de cá: qualquer caminho de
 * login (`loginPaths`) que comece com um prefixo, sem diferenciar maiúsculas
 * — e `run` confere de novo, pelo login que `resolvePppoeUsername` escolhe.
 * Assim a busca só tira do caminho quem com certeza não casa.
 */
export function matchQuery({ prefixes = [], serials = new Set(), loginPaths = [] } = {}) {
  const ou = [];
  if (prefixes.length > 0) {
    const expressao = `^\\s*(?:${prefixes.map(escapeRegex).join('|')})`;
    for (const caminho of loginPaths) {
      ou.push({ [`${caminho}._value`]: { $regex: expressao, $options: 'i' } });
    }
  }
  if (serials.size > 0) {
    const expressao = `^\\s*(?:${[...serials].map(escapeRegex).join('|')})\\s*$`;
    ou.push({ '_deviceId._SerialNumber': { $regex: expressao, $options: 'i' } });
  }
  return ou.length > 0 ? { $or: ou } : null;
}

/**
 * A NBI recusou a busca (4xx que não é de credencial): a forma da busca, e
 * não o ACS, é o problema. O erro é o de `DeviceService.genieAcsError`.
 */
function refusedQuery(error) {
  const status = Number(/responded with status: (\d{3})/.exec(String(error?.message ?? ''))?.[1]);
  return status >= 400 && status < 500 && status !== 401 && status !== 403;
}

/** `{ $and: [a, b] }` sem os vazios. */
function juntar(...partes) {
  const cheias = partes.filter(Boolean);
  return cheias.length > 1 ? { $and: cheias } : (cheias[0] ?? null);
}

/**
 * Marca com a tag do provedor em escopo as ONTs do GenieACS que casam com
 * prefixos de login PPPoE ou com uma lista de seriais.
 *
 * Roda SEM o escopo do provedor, porque o que se procura é justamente o que
 * ainda não tem tag. Equipamento que já carrega a tag de OUTRO provedor não é
 * tocado — ele volta como conflito, para a plataforma decidir à mão. E só
 * acrescenta: nenhuma tag sai de equipamento algum por aqui.
 *
 * É o mesmo caminho da ferramenta manual do console e da varredura periódica
 * do agendador, para as duas nunca discordarem sobre o que é "de quem".
 */
class DeviceScopeTagger {
  /**
   * A passada automática em andamento, por provedor. O agendador a solta no
   * fundo (`startAuto`) e não espera: a leitura do ACS inteiro não pode segurar
   * a cobrança, os lembretes e a suspensão do provedor na mesma volta.
   */
  static running = new Map();

  static async autoPrefixes() {
    return parsePrefixes(await Setting.getByKey(AUTO_PREFIXES_KEY));
  }

  /**
   * `{ prefixes: string[], serials: Set<string>, apply: boolean }` →
   * `{ tag, matched, alreadyTagged, toTag, tagged, conflicts, conflictCount }`,
   * ou `{ error }` quando o provedor não tem tag.
   *
   * O ACS devolve só quem casa e ainda NÃO tem a tag do provedor
   * (`_tags $nin [tag]`): numa frota já marcada, quase nada. Por isso
   * `alreadyTagged` sai de outra pergunta — uma contagem (`total` da NBI, ou
   * só os `_id`) de quem casa e já tem a tag — e `matched` é a soma
   * `alreadyTagged + toTag + conflictCount`. A contagem casa pela busca, que
   * olha todo caminho de login, e não pelo login escolhido do lado de cá:
   * um aparelho com dois logins diferentes pode contar onde a lista não o
   * poria. É um número para o console, e nada é marcado por ele.
   *
   * Um ACS que não honra a busca estreita (responde nada, ou 4xx) faz esta
   * passada cair na leitura inteira de antes, e o ACS fica lembrado por
   * `FULL_READ_MS` — ver `readNarrowed`.
   *
   * `fresh: false` aceita a leitura que a mesma busca fez há pouco
   * (`DeviceService.FLEET_IDENTITY_TTL_MS`) — é o que a passada automática
   * usa. A ferramenta do console lê na hora (o padrão).
   */
  static async run({ prefixes = [], serials = new Set(), apply = false, fresh = true } = {}) {
    const tag = String((await Setting.getByKey(DEVICE_SCOPE_KEY)) ?? '').trim();
    if (!tag) return { error: 'Set the provider device tag first' };
    const prefixos = prefixes.map((p) => String(p).toLowerCase()).filter(Boolean);
    if (prefixos.length === 0 && serials.size === 0) {
      return { tag, matched: 0, alreadyTagged: 0, toTag: 0, tagged: 0, conflicts: [], conflictCount: 0 };
    }
    const tagsDeProvedor = await DirectConnector.allScopeTags();
    const casa = (d) => {
      const login = String(d.pppoe || '').toLowerCase();
      return (login && prefixos.some((p) => login.startsWith(p)))
        || (serials.size > 0 && serials.has(String(d.serial || '').toUpperCase()));
    };

    return withoutDeviceScope(async () => {
      const connector = await connectorFor();
      const acs = `${connector.mode}|${await connector.rootUrl()}`;
      const filtro = matchQuery({ prefixes: prefixos, serials, loginPaths: await DeviceService.pppoeLoginPaths() });

      let leitura = null;
      if (!this.usesFullRead(acs)) {
        leitura = await this.readNarrowed({ tag, filtro, casa, fresh });
        if (!leitura) {
          this.fullReadAcs.set(acs, Date.now() + this.FULL_READ_MS);
          console.warn('Device scope auto-tag: the ACS did not honour the narrowed query; using the full fleet read');
        }
      }
      // O caminho antigo: a frota inteira fora do escopo, separada aqui.
      if (!leitura) leitura = await this.readFull({ tag, fresh });

      const conflitos = [];
      const marcar = [];
      let jaMarcados = leitura.alreadyTagged;
      for (const d of leitura.frota) {
        if (!casa(d)) continue;
        if (d.tags.includes(tag)) {
          // Na leitura estreita, quem tem a tag já está na contagem (marcado
          // depois da leitura guardada); na inteira, é contado aqui.
          if (leitura.countHere) jaMarcados += 1;
          continue;
        }
        if (d.tags.some((t) => tagsDeProvedor.has(t))) conflitos.push(d);
        else marcar.push(d);
      }
      let marcados = 0;
      if (apply) {
        for (const d of marcar) {
          // eslint-disable-next-line no-await-in-loop -- um por vez: o ACS é compartilhado
          await DeviceService.mutateDeviceTag(d._id, tag, 'POST');
          // Na lista de tags da própria leitura (que pode ser a guardada):
          // quem a ler de novo dentro do prazo vê o equipamento já marcado.
          if (!d.tags.includes(tag)) d.tags.push(tag);
          marcados += 1;
        }
      }
      return {
        tag,
        matched: jaMarcados + marcar.length + conflitos.length,
        alreadyTagged: jaMarcados,
        toTag: marcar.length,
        tagged: marcados,
        conflicts: conflitos.slice(0, 50).map((d) => ({
          id: d._id, serial: d.serial, pppoe: d.pppoe, tags: d.tags.filter((t) => tagsDeProvedor.has(t))
        })),
        conflictCount: conflitos.length
      };
    });
  }

  /**
   * Os ACS que não entenderam a busca estreita, e até quando usam a leitura
   * inteira direto: `<modo>|<raiz>` → validade. Em memória; 6 h, e então a
   * busca estreita é tentada de novo (o ACS pode ter sido atualizado).
   */
  static fullReadAcs = new Map();
  static FULL_READ_MS = 6 * 60 * 60_000;

  static usesFullRead(acs) {
    const ate = this.fullReadAcs.get(acs);
    if (ate && ate > Date.now()) return true;
    if (ate) this.fullReadAcs.delete(acs);
    return false;
  }

  /**
   * A leitura estreita: o ACS devolve só quem casa e não tem a tag, e os já
   * marcados vêm de uma contagem à parte, feita ANTES de marcar (quem é
   * marcado nesta passada conta em `toTag`, não em `alreadyTagged`).
   *
   * `null` quando o ACS não honrou a busca — ver `narrowedIgnored` — ou a
   * recusou com 4xx: quem chama cai na leitura inteira.
   */
  static async readNarrowed({ tag, filtro, casa, fresh }) {
    const semATag = { _tags: { $nin: [tag] } };
    try {
      // Uma lista de seriais grande demais para a URL vai só com o `$nin`, e
      // o casamento fica todo do lado de cá.
      const frota = await DeviceService.listFleetIdentity({
        fresh, query: juntar(semATag, filtro), fallbackQuery: semATag
      });
      const alreadyTagged = await this.countAlreadyTagged(tag, filtro, casa);
      if (frota.length === 0 && await this.narrowedIgnored(tag, filtro, alreadyTagged)) return null;
      return { frota, alreadyTagged, countHere: false };
    } catch (error) {
      if (refusedQuery(error)) return null;
      throw error;
    }
  }

  /**
   * A busca estreita voltou vazia: o ACS a entendeu, ou a ignorou? Um ACS que
   * não conhece `$nin` pode responder nada a uma busca que não entende —
   * e a marcação pararia calada. A conferência é barata (o `total` da NBI):
   * quantos casam SEM o `$nin`. Mais do que os já marcados quer dizer que
   * havia quem devolver.
   */
  static async narrowedIgnored(tag, filtro, alreadyTagged) {
    const consulta = filtro ? JSON.stringify(filtro) : null;
    const connector = await connectorFor();
    const url = consulta
      ? await connector.urlFor(DeviceService.devicePath(''), { query: consulta, projection: '_id', limit: 1 })
      : null;
    if (url && url.toString().length <= NBI_URL_BUDGET) {
      return (await DeviceService.countDevicesFromGenieAcs(consulta)) > alreadyTagged;
    }
    // A busca foi só o `$nin` (a lista de seriais não cabia): a frota inteira
    // contra os que têm a tag.
    const total = await DeviceService.countDevicesFromGenieAcs(null);
    return total > await DeviceService.countDevicesFromGenieAcs(JSON.stringify({ _tags: tag }));
  }

  /** A leitura de antes: a frota inteira fora do escopo, contada aqui. */
  static async readFull({ fresh }) {
    return { frota: await DeviceService.listFleetIdentity({ fresh }), alreadyTagged: 0, countHere: true };
  }

  /**
   * Quantos equipamentos que casam já têm a tag. Uma contagem da NBI (o
   * header `total`, como a paginação da lista) quando a busca cabe na URL;
   * senão, os já marcados só com serial, login e tags, casados do lado de cá.
   * Roda dentro do `withoutDeviceScope` de `run`.
   */
  static async countAlreadyTagged(tag, filtro, casa) {
    const comATag = juntar({ _tags: tag }, filtro);
    const consulta = JSON.stringify(comATag);
    const connector = await connectorFor();
    const url = await connector.urlFor(DeviceService.devicePath(''), { query: consulta, projection: '_id', limit: 1 });
    if (filtro && url.toString().length <= NBI_URL_BUDGET) {
      return DeviceService.countDevicesFromGenieAcs(consulta);
    }
    const marcados = await DeviceService.listFleetIdentity({ fresh: true, query: { _tags: tag } });
    return marcados.filter(casa).length;
  }

  /**
   * A passada periódica: os prefixos configurados, aplicando. `null` quando
   * não há o que fazer — sem tag ou sem prefixo, a marcação automática está
   * desligada para este provedor.
   */
  static async runAuto() {
    const prefixes = await this.autoPrefixes();
    if (prefixes.length === 0) return null;
    const tag = String((await Setting.getByKey(DEVICE_SCOPE_KEY)) ?? '').trim();
    if (!tag) return null;
    let resumo;
    try {
      const r = await this.run({ prefixes, apply: true, fresh: false });
      resumo = { at: new Date().toISOString(), tagged: r.tagged, conflictCount: r.conflictCount, error: null };
    } catch (error) {
      resumo = { at: new Date().toISOString(), tagged: 0, conflictCount: 0, error: error.message };
    }
    await AppState.upsert(LAST_AUTO_KEY, JSON.stringify(resumo));
    return resumo;
  }

  /** A passada automática tem o que fazer? Sem tag ou sem prefixo, está desligada. */
  static async autoEnabled() {
    if ((await this.autoPrefixes()).length === 0) return false;
    return Boolean(String((await Setting.getByKey(DEVICE_SCOPE_KEY)) ?? '').trim());
  }

  /**
   * `runAuto` no fundo, uma por provedor: a segunda chamada enquanto a
   * primeira roda recebe a MESMA promessa, em vez de ler o ACS de novo. É a
   * forma da sincronização de contatos — o agendador anda o relógio antes e
   * não espera. O escopo do provedor viaja com a promessa.
   */
  static startAuto() {
    const tenant = currentTenantId();
    const emCurso = this.running.get(tenant);
    if (emCurso) return emCurso;
    const work = this.runAuto().finally(() => {
      if (this.running.get(tenant) === work) this.running.delete(tenant);
    });
    this.running.set(tenant, work);
    return work;
  }

  /** Espera as passadas automáticas em andamento — para os testes. */
  static async idle() {
    await Promise.allSettled([...this.running.values()]);
  }

  /** `{ at, tagged, conflictCount, error }` da última passada, ou `null`. */
  static async lastAuto() {
    const raw = await AppState.get(LAST_AUTO_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

export default DeviceScopeTagger;
