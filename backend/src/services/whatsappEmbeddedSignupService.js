import crypto from 'node:crypto';
import { getDb, tdb } from '../config/database.js';
import { currentTenantId, hasTenantContext, runUnscoped } from '../config/tenantContext.js';
import AppState from '../models/AppState.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import EvolutionInstanceService from './evolutionInstanceService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { META_ID, graphRequest } from './metaGraphClient.js';

/**
 * O cadastro guiado do número oficial (Embedded Signup da Meta).
 *
 * Em vez de o provedor criar app, gerar token e colar três campos, o painel
 * abre o popup do Embedded Signup e termina o serviço sozinho no servidor:
 *
 *   1. `start` — entrega ao popup o `appId`, o `configId` e um `state` de uso
 *      único, curto, preso ao provedor e ao usuário que o pediu;
 *   2. `complete` — recebe o que o popup devolveu (`code`, WABA, número),
 *      consome o `state`, troca o `code` pelo token da Meta (o segredo do app
 *      nunca vai ao navegador), RECONFERE na Graph que o número pertence à
 *      WABA (os ids vêm do navegador e não valem por si), e então usa o mesmo
 *      caminho do cadastro manual (`createAccount` / `updateCloudToken`), que
 *      já registra o webhook, lê a saúde e sincroniza os modelos;
 *   3. coexistência — o número que continua no app WhatsApp Business do
 *      celular precisa, em até 24 h, da sincronização de contatos e de
 *      histórico. Cada tipo só pode ser pedido UMA vez; o `request_id` de cada
 *      um fica gravado e nada é repetido por conta própria. `/register` nunca
 *      é chamado: registrar de novo um número em coexistência derruba o vínculo.
 *
 * Nada aqui devolve o token da Meta nem o `code`: o que sai é `publicAccount`.
 */

/** O `state` vale por pouco tempo: o popup abre, a pessoa conclui, o painel envia. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** A Meta dá 24 h, a partir da conexão, para pedir a sincronização. */
export const COEXISTENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COEXISTENCE_EVENT = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
/** O evento de um número novo; qualquer outro `FINISH*` não traz número. */
const NEW_NUMBER_EVENTS = new Set(['FINISH', 'FINISH_WHATSAPP_BUSINESS_ONBOARDING']);
export const SYNC_TYPES = ['smb_app_state_sync', 'history'];

const STATE_KEY_PREFIX = 'wa_signup:';
const STATE_PATTERN = /^[a-f0-9]{64}$/;
const CODE_PATTERN = /^\S{1,512}$/;
const META_TOKEN = /^\S{20,1024}$/;
const PHONE_PAGE_LIMIT = 100;
const PHONE_MAX_PAGES = 5;
const SYNC_ERROR_LIMIT = 255;

function fail(key, code, status = 400, extra = {}) {
  return new WaError(`whatsapp.error.${key}`, { code, status, ...extra });
}

function appId() {
  const id = String(process.env.META_APP_ID ?? '').trim();
  return /^\d{5,32}$/.test(id) ? id : '';
}

function configId() {
  const id = String(process.env.META_WA_CONFIG_ID ?? '').trim();
  return /^\d{5,32}$/.test(id) ? id : '';
}

/**
 * A página do popup. O SDK da Meta só roda no domínio cadastrado no app, que não
 * é o do painel do provedor — por isso o painel recebe a URL daqui. Só `https:`
 * e sem credencial: o painel abre esta URL e confia no que ela devolve.
 */
export function signupPageUrl() {
  const fallback = 'https://tr69.com.br/whatsapp-signup.html';
  try {
    const url = new URL(String(process.env.META_WA_SIGNUP_URL ?? '').trim() || fallback);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

function appSecret() {
  return String(process.env.META_APP_SECRET ?? '').trim();
}

/** O cadastro guiado só existe quando a plataforma configurou o app da Meta. */
export function embeddedSignupAvailable() {
  return Boolean(appId() && configId() && appSecret());
}

function stateKey(state) {
  return `${STATE_KEY_PREFIX}${crypto.createHash('sha256').update(state).digest('hex')}`;
}

/**
 * A origem do painel para onde o popup devolve o resultado. Só `https:` (ou
 * `http:` em localhost, para desenvolver), sem caminho nem credencial: o
 * `postMessage` do popup usa isto como `targetOrigin`, e `*` vazaria o `code`.
 */
export function cleanReturnOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  return url.origin;
}

function tenantNow() {
  return hasTenantContext() ? currentTenantId() : null;
}

/** Os ids de sincronização já pedidos: `{ smb_app_state_sync: '…', history: '…' }`. */
export function readSyncRequestIds(row) {
  try {
    const parsed = JSON.parse(row?.meta_sync_request_ids || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function describeGraph(result) {
  return String(result?.error || 'meta_refused').slice(0, SYNC_ERROR_LIMIT);
}

class WhatsAppEmbeddedSignupService {
  /**
   * @param {{ userId: number|string|null, returnOrigin: string }} p
   */
  static async start({ userId = null, returnOrigin } = {}) {
    if (!embeddedSignupAvailable()) throw fail('embeddedSignupUnconfigured', 'embedded_signup_unconfigured', 503);
    const origin = cleanReturnOrigin(returnOrigin);
    if (!origin) throw fail('signupReturnOriginInvalid', 'signup_return_origin_invalid');

    // Estados vencidos nunca consumidos (a pessoa fechou o popup) não ficam.
    await tdb('app_state')
      .where('key', 'like', `${STATE_KEY_PREFIX}%`)
      .where('updated_at', '<', new Date(Date.now() - STATE_TTL_MS))
      .del();

    const state = crypto.randomBytes(32).toString('hex');
    await AppState.upsert(stateKey(state), JSON.stringify({
      userId: userId == null ? null : String(userId),
      origin,
      expiresAt: Date.now() + STATE_TTL_MS
    }));
    return {
      appId: appId(),
      configId: configId(),
      state,
      returnOrigin: origin,
      signupUrl: signupPageUrl(),
      expiresInSec: STATE_TTL_MS / 1000
    };
  }

  /**
   * Consome o `state`: uso único (o `DELETE` é quem decide numa corrida),
   * dentro do prazo e do mesmo usuário que o pediu.
   */
  static async consumeState(state, userId) {
    if (!STATE_PATTERN.test(String(state ?? ''))) throw fail('signupStateInvalid', 'signup_state_invalid');
    const key = stateKey(state);
    const row = await tdb('app_state').where({ key }).first();
    const apagou = row ? await tdb('app_state').where({ key }).del() : 0;
    if (!row || !apagou) throw fail('signupStateInvalid', 'signup_state_invalid');
    let saved;
    try {
      saved = JSON.parse(row.value);
    } catch {
      saved = null;
    }
    const sameUser = saved && (saved.userId ?? null) === (userId == null ? null : String(userId));
    if (!saved || !sameUser || Number(saved.expiresAt) < Date.now()) {
      throw fail('signupStateInvalid', 'signup_state_invalid');
    }
    return saved;
  }

  /** Troca o `code` do popup (vale 30 s) pelo token da Meta. */
  static async exchangeCode(code) {
    const id = appId();
    const result = await graphRequest({
      path: '/oauth/access_token',
      // Token de app (`id|segredo`) só para o cabeçalho; o par vai na consulta.
      metaToken: `${id}|${appSecret()}`,
      query: { client_id: id, client_secret: appSecret(), code }
    });
    const token = result.data?.access_token;
    if (!result.ok || typeof token !== 'string' || !META_TOKEN.test(token)) {
      // `code` vencido ou já usado é o caso comum e é culpa de quem demorou, não da Meta.
      if (result.status === 400) throw fail('signupCodeExpired', 'signup_code_expired');
      throw fail('metaRefused', 'meta_refused', 502, { vars: { reason: describeGraph(result) } });
    }
    return token;
  }

  /** O número pertence mesmo à WABA? Os ids vieram do navegador. */
  static async assertPhoneBelongsToWaba({ wabaId, phoneNumberId, token }) {
    let after = null;
    for (let page = 0; page < PHONE_MAX_PAGES; page += 1) {
      const result = await graphRequest({
        path: `/${wabaId}/phone_numbers`,
        metaToken: token,
        query: { fields: 'id', limit: String(PHONE_PAGE_LIMIT), ...(after ? { after } : {}) }
      });
      if (!result.ok) {
        throw fail('metaRefused', 'meta_refused', 502, { vars: { reason: describeGraph(result) } });
      }
      const ids = Array.isArray(result.data?.data) ? result.data.data.map((n) => String(n?.id)) : [];
      if (ids.includes(phoneNumberId)) return;
      after = result.data?.paging?.next ? result.data?.paging?.cursors?.after : null;
      if (!after) break;
    }
    throw fail('metaPhoneWabaMismatch', 'meta_phone_waba_mismatch', 409);
  }

  /**
   * Quem já tem este número: nesta conta (reaproveita) ou em outra (recusa).
   * O índice não é único no banco — os ids da Meta não são segredo, mas um
   * número só atende por um provedor, então a conferência é daqui.
   */
  static async findExisting(phoneNumberId) {
    const mine = await tdb('whatsapp_accounts').where({ meta_phone_number_id: phoneNumberId }).first();
    if (mine) return mine;
    const anyone = await runUnscoped(
      'a Meta number can only serve one provider; the lookup must see every provider',
      async () => getDb()('whatsapp_accounts').where({ meta_phone_number_id: phoneNumberId }).first()
    );
    if (anyone && (anyone.tenant_id ?? null) !== tenantNow()) {
      throw fail('metaNumberInUse', 'meta_number_in_use', 409);
    }
    return null;
  }

  /**
   * @param {{ state: string, code: string, wabaId: string, phoneNumberId: string, event: string,
   *           userId?: number|string|null, label?: string, purpose?: string,
   *           baseUrl?: string, adminKey?: string }} p
   */
  static async complete({
    state, code, wabaId, phoneNumberId, event, userId = null, label, purpose, baseUrl, adminKey
  } = {}) {
    if (!embeddedSignupAvailable()) throw fail('embeddedSignupUnconfigured', 'embedded_signup_unconfigured', 503);
    const waba = String(wabaId ?? '').trim();
    const phone = String(phoneNumberId ?? '').trim();
    const eventName = String(event ?? '').trim();
    const coexistence = eventName === COEXISTENCE_EVENT;
    if (!META_ID.test(waba) || !META_ID.test(phone) || !CODE_PATTERN.test(String(code ?? ''))
      || !(coexistence || NEW_NUMBER_EVENTS.has(eventName))) {
      throw fail('invalidMetaCredentials', 'invalid_meta_credentials');
    }

    // Antes de qualquer chamada à Meta: o `code` morre em 30 s.
    await this.consumeState(state, userId);
    const token = await this.exchangeCode(String(code));
    await this.assertPhoneBelongsToWaba({ wabaId: waba, phoneNumberId: phone, token });

    const existing = await this.findExisting(phone);
    let account;
    if (existing) {
      // O mesmo número outra vez (reconexão): só o token novo e a mesma instância.
      ({ account } = await EvolutionInstanceService.updateCloudToken(existing.id, { metaToken: token, adminKey }));
    } else {
      ({ account } = await EvolutionInstanceService.createAccount({
        baseUrl, adminKey, label, purpose, kind: 'cloud', metaToken: token, phoneNumberId: phone, wabaId: waba
      }));
    }

    account = await WhatsAppAccount.update(account.id, {
      meta_onboarding: 'embedded',
      meta_coexistence: coexistence,
      meta_coexistence_deadline_at: coexistence ? new Date(Date.now() + COEXISTENCE_WINDOW_MS) : null,
      meta_sync_state: coexistence ? 'pending' : null,
      meta_sync_error: null,
      ...(coexistence && !existing ? { meta_sync_request_ids: null } : {})
    });
    if (coexistence) account = await this.runCoexistenceSync(account, token);
    return { account, coexistence, reused: Boolean(existing) };
  }

  /**
   * Pede à Meta a sincronização de contatos e de histórico, UMA vez cada, na
   * ordem. Retomável: o que já tem `request_id` não é pedido de novo, e uma
   * recusa para no passo e grava o motivo sem tentar o seguinte. Nunca lança.
   */
  static async runCoexistenceSync(account, token = null) {
    const row = await WhatsAppAccount.getById(account.id);
    if (!row || !row.meta_coexistence) return row;
    const deadline = row.meta_coexistence_deadline_at ? new Date(row.meta_coexistence_deadline_at).getTime() : 0;
    const requestIds = readSyncRequestIds(row);
    if (SYNC_TYPES.every((type) => requestIds[type])) {
      return WhatsAppAccount.update(row.id, { meta_sync_state: 'ok', meta_sync_error: null });
    }
    if (deadline && deadline < Date.now()) {
      return WhatsAppAccount.update(row.id, {
        meta_sync_state: 'error', meta_sync_error: 'coexistence_deadline_passed'
      });
    }
    const metaToken = token || WhatsAppConfigService.decryptInstanceToken(row);
    for (const type of SYNC_TYPES) {
      if (requestIds[type]) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await graphRequest({
        method: 'POST',
        path: `/${row.meta_phone_number_id}/smb_app_data`,
        metaToken,
        body: { messaging_product: 'whatsapp', sync_type: type }
      });
      const id = result.data?.request_id;
      if (!result.ok || !id) {
        // eslint-disable-next-line no-await-in-loop
        return WhatsAppAccount.update(row.id, {
          meta_sync_state: 'error',
          meta_sync_error: `${type}: ${describeGraph(result)}`.slice(0, SYNC_ERROR_LIMIT)
        });
      }
      requestIds[type] = String(id).slice(0, 64);
      // Gravado a cada passo: uma queda no meio não pode apagar o que a Meta já aceitou.
      // eslint-disable-next-line no-await-in-loop
      await WhatsAppAccount.update(row.id, { meta_sync_request_ids: JSON.stringify(requestIds) });
    }
    return WhatsAppAccount.update(row.id, { meta_sync_state: 'ok', meta_sync_error: null });
  }

  /** "Tentar de novo" da tela: só número em coexistência e ainda dentro do prazo. */
  static async retryCoexistenceSync(id) {
    const row = await WhatsAppAccount.getById(id);
    if (!row) throw new WaError('whatsapp.error.accountNotFound', { code: 'account_not_found', status: 404 });
    if (!WhatsAppAccount.isCloud(row) || !row.meta_coexistence) {
      throw fail('notCoexistence', 'not_coexistence', 409);
    }
    return this.runCoexistenceSync(row);
  }
}

export default WhatsAppEmbeddedSignupService;
