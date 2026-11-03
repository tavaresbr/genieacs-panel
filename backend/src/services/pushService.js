import crypto from 'node:crypto';
import webpush from 'web-push';
import { getDb, isUniqueViolation, tdb, tinsert } from '../config/database.js';
import { currentTenantId, runUnscoped } from '../config/tenantContext.js';
import { roleHas } from '../config/permissions.js';
import { DEFAULT_LOCALE, resolveLocale, translate } from '../i18n/index.js';
import { createSecretBox } from '../utils/secretBox.js';
import { isValidEmail } from '../utils/helpers.js';
import AppState from '../models/AppState.js';
import TenantUser from '../models/TenantUser.js';
import { readProfile } from './platformProfileService.js';

/**
 * As notificações push do app do provedor (0130).
 *
 * O painel instalado no celular (PWA) recebe aviso com o app fechado: fatura,
 * ONT offline, queda em massa, WhatsApp desconectado e mensagem nova de
 * cliente. É um canal A MAIS — WhatsApp, e-mail e Telegram continuam saindo
 * exatamente como saíam; o push nunca entra na conta do "foi avisado" dos
 * alertas nem na marca da régua de cobrança.
 *
 * ## O que pode dar errado, e o que segura cada coisa
 *
 * - **Um provedor avisar o aparelho de outro.** As duas tabelas são escopadas
 *   (`tdb`), as chaves VAPID são de cada provedor, e os destinatários saem de
 *   `tenant_users` DO provedor em escopo, filtrados pela capacidade do papel
 *   (`EVENT_PERMISSION`): quem não lê a frota não fica sabendo de ONT.
 * - **O servidor virar cliente HTTP de quem quiser.** O `endpoint` vem do
 *   navegador — isto é, de quem chama a API. Sem filtro, uma inscrição
 *   apontando para `http://169.254.169.254/` faria o painel postar na rede
 *   interna a cada alerta. Só `https:` e só os serviços de push conhecidos
 *   (`PUSH_HOST_SUFFIXES`, mais os de `PUSH_ENDPOINT_HOSTS`).
 * - **Dado pessoal na tela de bloqueio.** O aviso sai com título, uma frase
 *   genérica e o link — nada de nome, telefone, CPF, contrato ou texto da
 *   mensagem. Quem quiser o detalhe abre o painel, que pede sessão.
 * - **Personificação.** Quem está no console olhando o provedor não inscreve
 *   o próprio navegador nos avisos dele (`ensureOwnSession` no controlador).
 * - **Aparelho morto.** 404/410 do serviço de push apaga a linha; outro erro
 *   soma `failures` e adia a próxima tentativa (recuo exponencial, teto de
 *   um dia); passou de `MAX_FAILURES`, a linha sai.
 */

/** Os eventos que a pessoa liga ou desliga, e o padrão de quem nunca escolheu. */
export const PUSH_EVENTS = Object.freeze(['invoice', 'ont_offline', 'mass_outage', 'wa_disconnected', 'new_message']);

export const PUSH_DEFAULTS = Object.freeze({
  invoice: true,
  // Desligado por padrão: numa frota grande é o aviso mais frequente, e quem
  // quer cada ONT liga de propósito.
  ont_offline: false,
  mass_outage: true,
  wa_disconnected: true,
  new_message: true
});

/** Quem PODE receber cada evento: a capacidade que a tela correspondente pede. */
export const EVENT_PERMISSION = Object.freeze({
  invoice: 'settings.read',
  ont_offline: 'devices.list',
  mass_outage: 'devices.list',
  wa_disconnected: 'whatsapp.read',
  new_message: 'whatsapp.read'
});

/** Os serviços de push dos navegadores. Sufixo de host, sempre em `https:`. */
export const PUSH_HOST_SUFFIXES = Object.freeze([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com'
]);

export const VAPID_KEY = 'push_vapid_keys';
export const SUBSCRIPTION_CONTEXT = 'skygenpanel-push-subscription-v1';
export const VAPID_CONTEXT = 'skygenpanel-push-vapid-v1';

/** Quanto tempo o serviço de push guarda o aviso de um aparelho desligado. */
const TTL_SECONDS = 6 * 3600;
const MAX_FAILURES = 10;
const SEND_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 24 * 3600 * 1000;
const MAX_ENDPOINT = 1024;
const MAX_KEY = 256;
/** Uma pessoa com mais aparelhos do que isto está inscrevendo em laço. */
const MAX_DEVICES_PER_USER = 10;
const MAX_TITLE = 80;
const MAX_BODY = 160;

const boxSubscription = createSecretBox(SUBSCRIPTION_CONTEXT);
const boxVapid = createSecretBox(VAPID_CONTEXT);

export class PushError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'PushError';
    this.code = code;
    this.status = status;
  }
}

export function endpointHash(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex');
}

function extraHosts() {
  return String(process.env.PUSH_ENDPOINT_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Se o endereço é de um serviço de push que o painel aceita chamar. */
export function isAllowedEndpoint(endpoint) {
  const texto = String(endpoint ?? '');
  if (!texto || texto.length > MAX_ENDPOINT) return false;
  let url;
  try {
    url = new URL(texto);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return [...PUSH_HOST_SUFFIXES, ...extraHosts()].some((sufixo) => host === sufixo || host.endsWith(`.${sufixo}`));
}

const base64url = /^[A-Za-z0-9_-]+={0,2}$/;

/** A inscrição do navegador (`PushSubscription.toJSON()`), conferida. */
export function normalizeSubscription(raw) {
  const endpoint = String(raw?.endpoint ?? '').trim();
  const p256dh = String(raw?.keys?.p256dh ?? '').trim();
  const auth = String(raw?.keys?.auth ?? '').trim();
  if (!isAllowedEndpoint(endpoint)) throw new PushError('push_endpoint_invalid');
  if (!p256dh || !auth || p256dh.length > MAX_KEY || auth.length > MAX_KEY
    || !base64url.test(p256dh) || !base64url.test(auth)) {
    throw new PushError('push_keys_invalid');
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** As escolhas gravadas, completadas pelo padrão. Lixo vira padrão. */
export function preferencesOf(stored) {
  let lido = stored;
  if (typeof lido === 'string') {
    try { lido = JSON.parse(lido); } catch { lido = {}; }
  }
  const out = {};
  for (const evento of PUSH_EVENTS) {
    const v = lido && typeof lido === 'object' ? lido[evento] : undefined;
    out[evento] = typeof v === 'boolean' ? v : PUSH_DEFAULTS[evento];
  }
  return out;
}

function cortar(texto, max) {
  const limpo = String(texto ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}

/** Só caminho do próprio painel: o clique nunca leva para fora. */
function caminhoSeguro(url) {
  const texto = String(url ?? '/');
  return texto.startsWith('/') && !texto.startsWith('//') ? texto.slice(0, 200) : '/';
}

/**
 * O que vai para o aparelho, e só isto. Título e corpo saem do i18n com
 * variáveis NUMÉRICAS ou de data — nenhum campo livre de assinante passa
 * por aqui.
 */
export function buildPayload({ event, titleKey, bodyKey, vars = {}, url = '/', tag = null, locale = DEFAULT_LOCALE }) {
  const seguras = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) seguras[k] = v;
    else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) seguras[k] = v;
  }
  const idioma = resolveLocale(locale) || DEFAULT_LOCALE;
  return {
    title: cortar(translate(idioma, titleKey, seguras), MAX_TITLE),
    body: cortar(translate(idioma, bodyKey, seguras), MAX_BODY),
    url: caminhoSeguro(url),
    tag: tag ? String(tag).slice(0, 64) : event,
    event
  };
}

/** O que cada evento diz. `cleared` é a recuperação, quando o evento tem uma. */
const MESSAGES = Object.freeze({
  ont_offline: {
    firing: { titleKey: 'push.ontOffline.title', bodyKey: 'push.ontOffline.body', url: '/devices' },
    cleared: { titleKey: 'push.ontOffline.clearedTitle', bodyKey: 'push.ontOffline.clearedBody', url: '/devices' }
  },
  mass_outage: {
    firing: { titleKey: 'push.massOutage.title', bodyKey: 'push.massOutage.body', url: '/network-map' },
    cleared: { titleKey: 'push.massOutage.clearedTitle', bodyKey: 'push.massOutage.clearedBody', url: '/network-map' }
  },
  wa_disconnected: {
    firing: { titleKey: 'push.waDisconnected.title', bodyKey: 'push.waDisconnected.body', url: '/settings?tab=whatsapp' },
    cleared: { titleKey: 'push.waDisconnected.clearedTitle', bodyKey: 'push.waDisconnected.clearedBody', url: '/whatsapp' }
  }
});

/** A regra do alerta → o evento de push. As outras regras não viram push. */
export const ALERT_RULE_EVENTS = Object.freeze({
  ont_offline: 'ont_offline',
  mass_outage: 'mass_outage',
  wa_disconnected: 'wa_disconnected'
});

/** A etapa da régua de cobrança → as chaves do aviso. */
function invoiceKeys(step, expired) {
  if (step === 'suspended') return { titleKey: 'push.invoice.suspendedTitle', bodyKey: 'push.invoice.suspendedBody' };
  if (step === 'suspension_warning') return { titleKey: 'push.invoice.warningTitle', bodyKey: 'push.invoice.warningBody' };
  if (expired) return { titleKey: 'push.invoice.overdueTitle', bodyKey: 'push.invoice.overdueBody' };
  return { titleKey: 'push.invoice.dueTitle', bodyKey: 'push.invoice.dueBody' };
}

class PushService {
  /** O envio de verdade. Trocado nos testes: nenhum teste fala com o Google. */
  static transport = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);

  /** Envios recentes por chave de limite (ver `throttled`). Só em memória. */
  static recent = new Map();

  static vapidLocks = new Map();

  // ── As chaves VAPID ─────────────────────────────────────────────────

  /**
   * O par de chaves do provedor em escopo, gerado na primeira vez.
   *
   * Por provedor, e não um para o deploy: a inscrição de um aparelho fica
   * presa à chave pública com que foi feita, e com uma chave por provedor
   * nem a privada de um consegue falar com aparelho inscrito no outro.
   *
   * A gravação é "insere se não existe" e a leitura vem DEPOIS dela: dois
   * primeiros pedidos ao mesmo tempo ficam com o mesmo par — o do primeiro
   * que gravou —, e não cada um com o seu.
   */
  static async vapidKeys() {
    const tenantId = currentTenantId();
    const andando = this.vapidLocks.get(tenantId);
    if (andando) return andando;
    const trabalho = this.readOrCreateVapid().finally(() => this.vapidLocks.delete(tenantId));
    this.vapidLocks.set(tenantId, trabalho);
    return trabalho;
  }

  static async readOrCreateVapid() {
    const lido = await this.readVapid();
    if (lido) return lido;
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    const valor = JSON.stringify({
      v: 1,
      publicKey,
      privateKey: { v: 1, ...boxVapid.encrypt(privateKey) },
      createdAt: new Date().toISOString()
    });
    try {
      await tinsert('app_state', { key: VAPID_KEY, value: valor, updated_at: new Date() })
        .onConflict(['tenant_id', 'key'])
        .ignore();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const gravado = await this.readVapid();
    if (!gravado) throw new PushError('push_vapid_unreadable', 500);
    return gravado;
  }

  static async readVapid() {
    const cru = await AppState.get(VAPID_KEY);
    if (!cru) return null;
    let blob;
    try { blob = JSON.parse(cru); } catch { return null; }
    const privateKey = boxVapid.decrypt(blob?.privateKey);
    if (!blob?.publicKey || !privateKey) {
      // Cheio e ilegível é chave que sumiu do `.env`, não "não há chave":
      // gerar outra em silêncio invalidaria toda inscrição deste provedor.
      throw new PushError('push_vapid_unreadable', 500);
    }
    return { publicKey: blob.publicKey, privateKey };
  }

  static async vapidSubject() {
    const daEnv = String(process.env.PUSH_VAPID_SUBJECT || '').trim();
    if (/^(mailto:|https:\/\/)/.test(daEnv)) return daEnv;
    const perfil = await readProfile().catch(() => null);
    const email = String(perfil?.values?.contactEmail ?? '').trim();
    if (email && isValidEmail(email)) return `mailto:${email}`;
    return 'mailto:noreply@localhost';
  }

  // ── Inscrições ──────────────────────────────────────────────────────

  /**
   * Inscreve este aparelho para a pessoa, no provedor em escopo.
   *
   * O endpoint é UM aparelho: se ele já estava inscrito — por esta pessoa,
   * por outra, ou noutro provedor (a mesma origem com outra sessão) —, a
   * linha antiga sai e a nova fica com quem se inscreveu agora. Um celular
   * passado de mão em mão não continua recebendo os avisos do dono anterior.
   */
  static async subscribe({ userId, subscription, userAgent = null, locale = null }) {
    const sub = normalizeSubscription(subscription);
    const hash = endpointHash(sub.endpoint);
    // tenant-scope-exempt: o endpoint é a credencial do aparelho, e o
    // aparelho passa a ser de quem se inscreveu agora — a linha de outro
    // provedor com o MESMO endpoint é exatamente a que tem de sair.
    await runUnscoped('push: o aparelho troca de dono', () => getDb()('push_subscriptions')
      .where({ endpoint_hash: hash })
      .del());

    const doUsuario = await tdb('push_subscriptions').where({ user_id: userId }).orderBy('id', 'asc').select('id');
    if (doUsuario.length >= MAX_DEVICES_PER_USER) {
      const sobra = doUsuario.slice(0, doUsuario.length - MAX_DEVICES_PER_USER + 1).map((r) => r.id);
      await tdb('push_subscriptions').whereIn('id', sobra).del();
    }

    const cifrado = boxSubscription.encrypt(JSON.stringify(sub));
    const agora = new Date(Math.floor(Date.now() / 1000) * 1000);
    try {
      await tinsert('push_subscriptions', {
        user_id: userId,
        endpoint_hash: hash,
        secret_ciphertext: cifrado.password_ciphertext,
        secret_iv: cifrado.password_iv,
        secret_tag: cifrado.password_tag,
        secret_key_version: cifrado.password_key_version,
        user_agent: userAgent ? String(userAgent).slice(0, 255) : null,
        locale: resolveLocale(locale) || null,
        failures: 0,
        created_at: agora,
        updated_at: agora
      });
    } catch (error) {
      // Dois cliques: a outra requisição já gravou o mesmo aparelho.
      if (!isUniqueViolation(error)) throw error;
    }
    return { endpointHash: hash };
  }

  /** Tira o aparelho da pessoa. Só a linha DELA, no provedor em escopo. */
  static async unsubscribe({ userId, endpoint }) {
    const hash = endpointHash(String(endpoint ?? '').trim());
    const removidas = await tdb('push_subscriptions').where({ user_id: userId, endpoint_hash: hash }).del();
    return { removed: Number(removidas) || 0 };
  }

  static async countDevices(userId) {
    const row = await tdb('push_subscriptions').where({ user_id: userId }).count({ n: '*' }).first();
    return Number(row?.n || 0);
  }

  // ── Preferências ────────────────────────────────────────────────────

  static async getPreferences(userId) {
    const row = await tdb('push_preferences').where({ user_id: userId }).first();
    return preferencesOf(row?.events);
  }

  static async savePreferences(userId, patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new PushError('push_preferences_invalid');
    const atual = await this.getPreferences(userId);
    for (const [k, v] of Object.entries(patch)) {
      if (!PUSH_EVENTS.includes(k) || typeof v !== 'boolean') throw new PushError('push_preferences_invalid');
      atual[k] = v;
    }
    const events = JSON.stringify(atual);
    const agora = new Date();
    await tinsert('push_preferences', { user_id: userId, events, updated_at: agora })
      .onConflict(['tenant_id', 'user_id'])
      .merge({ events, updated_at: agora });
    return atual;
  }

  // ── Quem recebe ─────────────────────────────────────────────────────

  /**
   * As pessoas do provedor em escopo que recebem `event`: têm a capacidade
   * (`EVENT_PERMISSION`), não o desligaram e têm aparelho. `onlyUserIds`
   * restringe (a conversa que já tem atendente avisa só ele).
   */
  static async recipients(event, { onlyUserIds = null } = {}) {
    const permissao = EVENT_PERMISSION[event];
    if (!permissao) return [];
    const comAparelho = new Set((await tdb('push_subscriptions').distinct('user_id')).map((r) => Number(r.user_id)));
    if (comAparelho.size === 0) return [];
    const equipe = await TenantUser.listForTenant(currentTenantId());
    const prefs = new Map((await tdb('push_preferences').select('user_id', 'events'))
      .map((r) => [Number(r.user_id), preferencesOf(r.events)]));
    const filtro = onlyUserIds ? new Set(onlyUserIds.map(Number)) : null;
    return equipe
      .filter((p) => comAparelho.has(Number(p.id)))
      .filter((p) => !filtro || filtro.has(Number(p.id)))
      .filter((p) => roleHas(p.role, permissao))
      .filter((p) => (prefs.get(Number(p.id)) ?? PUSH_DEFAULTS)[event] === true)
      .map((p) => Number(p.id));
  }

  // ── Envio ───────────────────────────────────────────────────────────

  /**
   * Um aviso por chave a cada `intervalMs`. Em memória: um reinício do
   * processo no máximo deixa sair um aviso a mais, e a alternativa (gravar)
   * seria uma escrita por mensagem de cliente.
   */
  static throttled(key, intervalMs, now = Date.now()) {
    const ultimo = this.recent.get(key);
    if (ultimo !== undefined && now - ultimo < intervalMs) return true;
    this.recent.set(key, now);
    if (this.recent.size > 5000) {
      for (const [k, t] of this.recent) if (now - t > 3600_000) this.recent.delete(k);
    }
    return false;
  }

  /** Manda `message` (sem idioma) a cada aparelho de cada pessoa. Nunca lança. */
  static async notifyUsers(userIds, message, { now = new Date() } = {}) {
    try {
      if (!userIds.length) return { sent: 0, removed: 0, failed: 0 };
      const linhas = await tdb('push_subscriptions')
        .whereIn('user_id', userIds)
        .where((q) => q.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
        .select('*');
      if (!linhas.length) return { sent: 0, removed: 0, failed: 0 };
      const vapid = await this.vapidKeys();
      const subject = await this.vapidSubject();
      const resumo = { sent: 0, removed: 0, failed: 0 };
      for (const linha of linhas) {
        // eslint-disable-next-line no-await-in-loop -- poucos aparelhos; em série, o recuo de cada um é gravado na ordem
        await this.deliverOne(linha, message, { vapid, subject, now, resumo });
      }
      return resumo;
    } catch (error) {
      console.warn(`push not sent: ${String(error?.message || error).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 200)}`);
      return { sent: 0, removed: 0, failed: 0, error: true };
    }
  }

  static async deliverOne(linha, message, { vapid, subject, now, resumo }) {
    const aberto = boxSubscription.decrypt({
      password_ciphertext: linha.secret_ciphertext,
      password_iv: linha.secret_iv,
      password_tag: linha.secret_tag,
      password_key_version: linha.secret_key_version
    });
    let sub = null;
    try { sub = aberto ? JSON.parse(aberto) : null; } catch { sub = null; }
    if (!sub?.endpoint || !isAllowedEndpoint(sub.endpoint)) {
      // Ilegível ou fora da lista: não há para onde mandar, e insistir é ruído.
      await tdb('push_subscriptions').where({ id: linha.id }).del();
      resumo.removed += 1;
      return;
    }
    const payload = JSON.stringify(buildPayload({ ...message, locale: linha.locale || DEFAULT_LOCALE }));
    try {
      await this.transport(sub, payload, {
        vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: message.ttl ?? TTL_SECONDS,
        urgency: message.urgency ?? 'normal',
        // Um serviço de push que pendura não pode segurar a varredura dos alertas.
        timeout: SEND_TIMEOUT_MS,
        ...(message.topic ? { topic: String(message.topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {})
      });
      await tdb('push_subscriptions').where({ id: linha.id }).update({
        failures: 0, next_attempt_at: null, last_ok_at: now, updated_at: now
      });
      resumo.sent += 1;
    } catch (error) {
      const status = Number(error?.statusCode);
      const falhas = Number(linha.failures || 0) + 1;
      if (status === 404 || status === 410 || falhas >= MAX_FAILURES) {
        await tdb('push_subscriptions').where({ id: linha.id }).del();
        resumo.removed += 1;
        return;
      }
      const recuo = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (falhas - 1));
      await tdb('push_subscriptions').where({ id: linha.id }).update({
        failures: falhas,
        next_attempt_at: new Date(Math.floor((now.getTime() + recuo) / 1000) * 1000),
        last_error_at: now,
        updated_at: now
      });
      resumo.failed += 1;
    }
  }

  /** Um evento para quem o recebe no provedor em escopo. Nunca lança. */
  static async notifyTenantUsers(event, message, { onlyUserIds = null, throttleKey = null, throttleMs = 0 } = {}) {
    try {
      if (throttleKey && this.throttled(`${currentTenantId()}:${event}:${throttleKey}`, throttleMs)) {
        return { sent: 0, throttled: true };
      }
      const ids = await this.recipients(event, { onlyUserIds });
      return await this.notifyUsers(ids, { ...message, event });
    } catch (error) {
      console.warn(`push ${event} not sent: ${String(error?.message || error).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 200)}`);
      return { sent: 0, error: true };
    }
  }

  /** O aviso de teste: só os aparelhos de quem pediu. */
  static async sendTest(userId) {
    return this.notifyUsers([userId], {
      event: 'test', titleKey: 'push.test.title', bodyKey: 'push.test.body', url: '/settings?tab=security', tag: 'push-test', urgency: 'high'
    });
  }

  // ── Os ganchos ──────────────────────────────────────────────────────

  /** Um alerta da varredura (`waAlertService.notify`). */
  static async notifyAlert({ rule, cleared = false, vars = {} }) {
    const event = ALERT_RULE_EVENTS[rule];
    if (!event) return { sent: 0 };
    const textos = MESSAGES[event][cleared ? 'cleared' : 'firing'];
    // Só números: o id do aparelho e o nome da caixa ficam fora do aviso.
    const numeros = {};
    for (const k of ['minutes', 'count']) {
      if (Number.isFinite(Number(vars?.[k])) && vars?.[k] !== '' && vars?.[k] !== null) numeros[k] = Number(vars[k]);
    }
    return this.notifyTenantUsers(event, {
      ...textos,
      vars: numeros,
      tag: `${event}${cleared ? '-ok' : ''}`,
      urgency: cleared ? 'normal' : 'high'
    }, {
      // Cinquenta ONTs caindo numa varredura viram um aviso por minuto, não cinquenta.
      throttleKey: `${rule}:${cleared ? 'ok' : 'on'}`,
      throttleMs: event === 'ont_offline' ? 60_000 : 0
    });
  }

  /** Uma etapa da régua de cobrança que SAIU (`subscriptionNoticeService.sendStep`). */
  static async notifyInvoice({ step, expired = false, dueAt = null }) {
    return this.notifyTenantUsers('invoice', {
      ...invoiceKeys(step, expired),
      vars: { date: typeof dueAt === 'string' ? dueAt.slice(0, 10) : '' },
      url: '/plan',
      tag: 'invoice',
      urgency: step === 'suspended' ? 'high' : 'normal'
    });
  }

  /**
   * Uma mensagem de cliente que chegou (`waInboundService`). A mesma regra do
   * sino do painel (`waNotificationService`): a conversa do atendente avisa só
   * ele; a sem atendente, que espera gente, avisa quem atende. Conversa com o
   * bot não avisa ninguém. No máximo um aviso por conversa a cada dois minutos.
   */
  static async notifyInboundMessage({ conversation, needsHuman }) {
    if (!conversation?.id) return { sent: 0 };
    const atendente = conversation.assigned_user_id ? Number(conversation.assigned_user_id) : null;
    if (!atendente && !needsHuman) return { sent: 0 };
    return this.notifyTenantUsers('new_message', {
      titleKey: 'push.newMessage.title',
      bodyKey: 'push.newMessage.body',
      url: `/whatsapp?conversation=${Number(conversation.id)}`,
      // A mesma etiqueta do sino da aba: os dois avisos da mesma conversa se substituem.
      tag: `wa-conv-${Number(conversation.id)}`,
      topic: `wa${Number(conversation.id)}`,
      urgency: 'high'
    }, {
      onlyUserIds: atendente ? [atendente] : null,
      throttleKey: `conv:${Number(conversation.id)}`,
      throttleMs: 120_000
    });
  }
}

export default PushService;
