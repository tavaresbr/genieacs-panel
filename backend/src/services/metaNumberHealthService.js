import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import WaAlertService from './waAlertService.js';
import { GRAPH_ERROR_LIMIT, META_ID, graphRequest } from './metaGraphClient.js';
import { forEachTenant } from '../config/tenantJobs.js';
import { DEFAULT_LOCALE, translatorFor } from '../i18n/index.js';

/**
 * A saúde do número oficial na Meta: a nota de qualidade, o limite de
 * conversas iniciadas por dia, o nome verificado e o status do número.
 *
 * A Meta rebaixa um número sem avisar ninguém: a qualidade cai de verde para
 * amarelo quando os clientes bloqueiam ou denunciam, o limite diário desce de
 * degrau, e um número `FLAGGED` ou `RESTRICTED` para de entregar campanha. O
 * provedor descobria pela campanha que não saiu. Aqui o painel pergunta à
 * Graph (`GET /{phone_number_id}`) de hora em hora e quando alguém aperta
 * "Atualizar", guarda a resposta na linha e, se piorou, avisa a equipe pelos
 * canais dos alertas técnicos (`WaAlertService.notifyEvent`).
 *
 * A chamada é do `metaGraphClient.js` (host fixo, token só no cabeçalho, nada
 * de URL nem exceção do `fetch` no erro gravado).
 */

/** Uma hora: a Meta recalcula a nota em horas, não em minutos. */
const TICK_INTERVAL_MS = 60 * 60 * 1000;

const FIELDS = 'quality_rating,messaging_limit_tier,throughput,verified_name,display_phone_number,name_status,status';

/** Da pior para a melhor. Fora daqui é `UNKNOWN`, que não conta como queda. */
export const QUALITY_ORDER = Object.freeze(['RED', 'YELLOW', 'GREEN']);

/** Os degraus do limite diário, do menor para o maior. */
export const LIMIT_ORDER = Object.freeze([
  'TIER_50', 'TIER_250', 'TIER_1K', 'TIER_2K', 'TIER_10K', 'TIER_100K', 'TIER_UNLIMITED'
]);

/** Os status em que o número está sob sanção da Meta. */
export const DEGRADED_STATUSES = Object.freeze(['FLAGGED', 'RESTRICTED']);

/** Um rótulo da Meta: maiúsculas, dígitos e `_`, curto. O resto é descartado. */
function label(value, max = 32) {
  const text = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(text) ? text.slice(0, max) : null;
}

function text(value, max) {
  const out = typeof value === 'string' ? value.trim() : '';
  return out ? out.slice(0, max) : null;
}

/** A resposta da Graph nas colunas da linha. */
export function parseNumberHealth(data) {
  const quality = label(data?.quality_rating, 16);
  return {
    meta_quality_rating: quality && QUALITY_ORDER.includes(quality) ? quality : 'UNKNOWN',
    meta_messaging_limit: label(data?.messaging_limit_tier),
    meta_verified_name: text(data?.verified_name, 255),
    meta_display_phone: text(data?.display_phone_number, 32),
    meta_name_status: label(data?.name_status),
    meta_number_status: label(data?.status),
    meta_throughput: label(data?.throughput?.level ?? data?.throughput)
  };
}

/**
 * Consulta a saúde do número na Graph. Nunca lança.
 *
 * @returns {Promise<{ ok: true, health: object, error: null } | { ok: false, health: null, error: string }>}
 */
export async function fetchNumberHealth({ phoneNumberId, metaToken }) {
  const id = String(phoneNumberId ?? '').trim();
  if (!META_ID.test(id) || !metaToken) return { ok: false, health: null, error: 'meta_health_invalid_account' };
  const resposta = await graphRequest({ path: `/${id}`, metaToken, query: { fields: FIELDS } });
  if (!resposta.ok) return { ok: false, health: null, error: resposta.error };
  return { ok: true, health: parseNumberHealth(resposta.data), error: null };
}

const rank = (order, value) => order.indexOf(value);

/**
 * O que piorou entre duas leituras: qualidade, limite e status.
 *
 * Só compara o que as duas leituras sabem: a primeira consulta de um número,
 * ou uma nota `UNKNOWN`, não é queda de nada.
 *
 * @returns {Array<{ kind: 'quality'|'limit'|'status', from: string|null, to: string }>}
 */
export function degradation(prev, next) {
  const changes = [];
  if (!prev || !next) return changes;
  const qa = rank(QUALITY_ORDER, prev.meta_quality_rating);
  const qb = rank(QUALITY_ORDER, next.meta_quality_rating);
  if (qa >= 0 && qb >= 0 && qb < qa) {
    changes.push({ kind: 'quality', from: prev.meta_quality_rating, to: next.meta_quality_rating });
  }
  const la = rank(LIMIT_ORDER, prev.meta_messaging_limit);
  const lb = rank(LIMIT_ORDER, next.meta_messaging_limit);
  if (la >= 0 && lb >= 0 && lb < la) {
    changes.push({ kind: 'limit', from: prev.meta_messaging_limit, to: next.meta_messaging_limit });
  }
  // O status compara com a última leitura conhecida: um número que já estava
  // `FLAGGED` não é avisado de novo a cada hora.
  if (prev.meta_number_status
    && DEGRADED_STATUSES.includes(next.meta_number_status)
    && prev.meta_number_status !== next.meta_number_status) {
    changes.push({ kind: 'status', from: prev.meta_number_status, to: next.meta_number_status });
  }
  return changes;
}

/** As mudanças numa frase só, no idioma padrão — o mesmo dos alertas. */
function describeChanges(changes) {
  const t = translatorFor(DEFAULT_LOCALE);
  const key = {
    quality: 'whatsapp.alerts.metaQualityChange',
    limit: 'whatsapp.alerts.metaLimitChange',
    status: 'whatsapp.alerts.metaStatusChange'
  };
  return changes.map((change) => t(key[change.kind], { from: change.from || '?', to: change.to })).join('; ');
}

class MetaNumberHealthService {
  static timer = null;

  /** Uma passada de cada vez: a do relógio não corre atrás de outra lenta. */
  static running = false;

  /**
   * Consulta a Meta, grava na linha e avisa se piorou. Nunca lança.
   *
   * Uma consulta que falha grava só o erro e a hora: os valores ficam os da
   * última leitura boa, porque "a Meta não respondeu" não é "a qualidade caiu".
   *
   * @param {object} account a linha de `whatsapp_accounts`
   */
  static async refresh(account) {
    let result;
    try {
      result = await fetchNumberHealth({
        phoneNumberId: account.meta_phone_number_id,
        metaToken: WhatsAppConfigService.decryptInstanceToken(account)
      });
    } catch {
      result = { ok: false, health: null, error: 'meta_health_failed' };
    }
    const now = new Date();
    const patch = result.ok
      ? { ...result.health, meta_health_at: now, meta_health_error: null }
      : { meta_health_at: now, meta_health_error: String(result.error).slice(0, GRAPH_ERROR_LIMIT) };
    let updated = account;
    try {
      updated = await WhatsAppAccount.update(account.id, patch);
    } catch {
      // A linha fica como estava; o resultado ainda volta para quem chamou.
    }
    let alerted = 0;
    if (result.ok) {
      // Só há queda se havia uma leitura boa antes desta.
      const changes = account.meta_quality_rating ? degradation(account, result.health) : [];
      if (changes.length) {
        alerted = await WaAlertService.notifyEvent({
          rule: 'wa_meta_quality',
          subject: account.id,
          vars: {
            ...WaAlertService.accountVars(updated || account),
            changes: describeChanges(changes),
            link: await WaAlertService.reconnectLink().catch(() => '')
          }
        });
      }
      return { ok: true, error: null, account: updated, changes, alerted };
    }
    return { ok: false, error: result.error, account: updated, changes: [], alerted };
  }

  /** O botão "Atualizar". 404 de outro provedor, 409 de número por QR. */
  static async retry(id) {
    const { default: EvolutionInstanceService } = await import('./evolutionInstanceService.js');
    const account = await EvolutionInstanceService.loadAccount(id);
    if (!WhatsAppAccount.isCloud(account)) {
      throw new WaError('whatsapp.error.notCloud', { code: 'not_cloud', status: 409 });
    }
    const result = await this.refresh(account);
    if (!result.ok) {
      throw new WaError('whatsapp.metaHealth.failed', {
        code: 'meta_health_failed',
        status: 502,
        vars: { reason: result.error }
      });
    }
    return { account: result.account };
  }

  /** Todos os números oficiais do provedor em escopo, um por vez. */
  static async refreshAll() {
    const summary = { checked: 0, failed: 0, alerted: 0 };
    const accounts = (await WhatsAppAccount.getAll()).filter((row) => WhatsAppAccount.isCloud(row));
    for (const account of accounts) {
      // eslint-disable-next-line no-await-in-loop -- em fila, para não disparar a Graph em rajada
      const result = await this.refresh(account);
      summary.checked += 1;
      if (!result.ok) summary.failed += 1;
      summary.alerted += result.alerted || 0;
    }
    return summary;
  }

  /**
   * Ligado em `server.js`, nunca no import: os testes não têm relógio
   * correndo atrás deles. Sem passada no boot — um reinício em série não pode
   * virar uma rajada de consultas à Meta.
   */
  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` engole as próprias falhas; este catch só impede uma rejeição solta.
      void this.tick().catch((error) => {
        console.warn(`Meta number health tick failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Uma passada por provedor ativo, como a dos alertas: um provedor suspenso
   * não recebe aviso, e um provedor com a Meta fora do ar não para os outros.
   */
  static async tick() {
    if (this.running) return [];
    this.running = true;
    try {
      return await forEachTenant(() => this.refreshAll(), {
        onError: (error, tenant) => {
          console.warn(`Meta number health failed for provider ${tenant.slug}: ${error.message}`);
        }
      });
    } catch (error) {
      console.warn(`Meta number health failed: ${error.message}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

export default MetaNumberHealthService;
