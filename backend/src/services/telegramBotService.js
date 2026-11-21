import crypto from 'node:crypto';
import AppState from '../models/AppState.js';
import AuditLog from '../models/AuditLog.js';
import TenantUser from '../models/TenantUser.js';
import User from '../models/User.js';
import DeviceService from './deviceService.js';
import WaAlertService from './waAlertService.js';
import { currentTenantId } from '../config/tenantContext.js';
import { roleHas } from '../config/permissions.js';
import { segredosIguais } from '../utils/wa/waWebhookAuth.js';
import {
  answerTelegramCallback,
  deleteTelegramWebhook,
  escapeTelegramHtml as esc,
  sendTelegramMessage,
  setTelegramWebhook
} from './telegramClient.js';

/**
 * Os comandos do bot do Telegram da equipe.
 *
 * O bot é o do próprio provedor (o mesmo token dos alertas). O Telegram entrega
 * cada mensagem por webhook (`routes/telegramWebhook.js`) e este serviço decide
 * QUEM pode e O QUE responde.
 *
 * QUEM pode: estar no grupo não basta. Um operador do painel gera um código de
 * uso único (`createLinkCode`) e o manda ao bot no privado (`/vincular`); só
 * então o `from.id` daquele Telegram vira aquele operador, com o papel dele —
 * e cada comando consulta a mesma matriz de capacidades das rotas do painel.
 * Quem não está vinculado não recebe resposta no grupo, e no privado só recebe
 * a dica de como vincular: o bot não confirma nada sobre o provedor.
 *
 * O estado (vínculos, códigos, hash do segredo do webhook) fica em `app_state`
 * do provedor. O segredo do webhook em si NÃO é guardado — só o hash: ele é
 * gerado a cada `enable` e só precisa ser conferido, nunca relido.
 */

const STATE_KEY = 'telegram_bot';
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CODES = 5;
const MAX_LINKS = 50;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const PAGE_SIZE = 10;

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const TEXT = Object.freeze({
  help: [
    '<b>Comandos</b>',
    '/status — resumo da frota',
    '/offline — ONTs offline (paginado)',
    '/cliente &lt;termo&gt; — procura por PPPoE, serial ou id',
    '/falhas — últimas falhas do ACS',
    '/vincular &lt;código&gt; — liga este Telegram ao seu usuário do painel',
    '/desvincular — remove o vínculo'
  ].join('\n'),
  notLinked: 'Este Telegram não está vinculado a um usuário do painel. No painel, gere um código em Alertas › Telegram e envie /vincular &lt;código&gt; aqui no privado.',
  linkPrivateOnly: 'Por segurança, /vincular só funciona no chat privado com o bot.',
  linkBad: 'Código inválido ou expirado. Gere outro no painel.',
  linked: (name) => `Vinculado ao usuário <b>${esc(name)}</b>. Envie /ajuda para ver os comandos.`,
  unlinked: 'Vínculo removido.',
  forbidden: 'Seu usuário não tem permissão para este comando.',
  rate: 'Muitos comandos seguidos. Aguarde um minuto.',
  failed: 'Não consegui consultar o painel agora. Tente de novo em instantes.',
  unknown: 'Comando desconhecido. Envie /ajuda.'
});

/** Limite por usuário do Telegram, em memória: basta para segurar um laço. */
const hits = new Map();
function rateLimited(tgUserId, now = Date.now()) {
  const recent = (hits.get(tgUserId) || []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(tgUserId, recent);
    return true;
  }
  recent.push(now);
  hits.set(tgUserId, recent);
  // Poda: um mapa que só cresce vira vazamento num processo que dura meses.
  if (hits.size > 5000) {
    for (const [id, list] of hits) {
      if (!list.some((at) => now - at < RATE_WINDOW_MS)) hits.delete(id);
    }
  }
  return false;
}

const plain = (value) => {
  if (value && typeof value === 'object') return plain(value.value ?? value._value ?? '');
  const text = String(value ?? '').trim();
  return text === 'null' || text === 'undefined' ? '' : text;
};

function agoText(iso, now = Date.now()) {
  const ms = iso ? new Date(iso).getTime() : Number.NaN;
  if (!Number.isFinite(ms)) return 'nunca';
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

function deviceLine(device) {
  const login = plain(device.pppoe);
  const serial = plain(device.SerialNumber) || plain(device._id);
  const rx = plain(device.rxpower);
  return `• <code>${esc(login || serial)}</code>${login && serial ? ` (${esc(serial)})` : ''} — visto há ${esc(agoText(device._lastInform))}${rx ? ` · rx ${esc(rx)}` : ''}`;
}

class TelegramBotService {
  // ── Estado ─────────────────────────────────────────────────────────

  static async readState() {
    const raw = await AppState.get(STATE_KEY);
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) || {} : {};
    } catch {
      parsed = {};
    }
    const now = Date.now();
    return {
      enabled: parsed.enabled === true,
      secretHash: typeof parsed.secretHash === 'string' ? parsed.secretHash : '',
      links: Array.isArray(parsed.links) ? parsed.links : [],
      codes: (Array.isArray(parsed.codes) ? parsed.codes : []).filter((entry) => Number(entry.expiresAt) > now)
    };
  }

  static async writeState(state) {
    await AppState.upsert(STATE_KEY, JSON.stringify(state));
  }

  /** O que a tela vê: nunca o hash do segredo, nem os códigos. */
  static async getPublicStatus() {
    const state = await this.readState();
    const settings = await WaAlertService.getSettings();
    return {
      enabled: state.enabled,
      botConfigured: Boolean(settings.telegram.token),
      links: state.links.map((link) => ({
        telegramUserId: String(link.tgUserId),
        telegramUsername: link.tgUsername || null,
        userId: link.userId,
        username: link.username || null,
        linkedAt: link.linkedAt
      }))
    };
  }

  // ── Webhook ────────────────────────────────────────────────────────

  /**
   * Liga o bot: registra o webhook com um segredo novo. O segredo antigo deixa
   * de valer na hora (o hash é trocado), então ligar de novo é também "girar".
   */
  static async enable({ webhookUrl }) {
    const settings = await WaAlertService.getSettings();
    if (!settings.telegram.token) {
      return { ok: false, code: 'telegram_not_configured' };
    }
    const secret = crypto.randomBytes(32).toString('hex');
    const resultado = await setTelegramWebhook({ token: settings.telegram.token, url: webhookUrl, secretToken: secret });
    if (!resultado.ok) return resultado;
    const state = await this.readState();
    await this.writeState({ ...state, enabled: true, secretHash: hash(secret) });
    return { ok: true };
  }

  /** Desliga: tira o webhook do Telegram e invalida o segredo. Os vínculos ficam. */
  static async disable() {
    const settings = await WaAlertService.getSettings();
    const state = await this.readState();
    await this.writeState({ ...state, enabled: false, secretHash: '' });
    if (settings.telegram.token) await deleteTelegramWebhook({ token: settings.telegram.token });
    return { ok: true };
  }

  /** O header do Telegram contra o hash guardado. Fail-closed. */
  static async secretMatches(header) {
    const state = await this.readState();
    if (!state.enabled || !state.secretHash || !header) return false;
    return segredosIguais(hash(header), state.secretHash);
  }

  // ── Vínculo ────────────────────────────────────────────────────────

  /** Um código de uso único para o operador logado. O texto só existe aqui, na resposta. */
  static async createLinkCode(userId) {
    const state = await this.readState();
    const mine = state.codes.filter((entry) => entry.userId === userId);
    const others = state.codes.filter((entry) => entry.userId !== userId);
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    const expiresAt = Date.now() + CODE_TTL_MS;
    const kept = mine.slice(-(MAX_PENDING_CODES - 1));
    await this.writeState({ ...state, codes: [...others, ...kept, { hash: hash(code), userId, expiresAt }] });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  static async revokeLink(telegramUserId) {
    const state = await this.readState();
    const links = state.links.filter((link) => String(link.tgUserId) !== String(telegramUserId));
    if (links.length === state.links.length) return false;
    await this.writeState({ ...state, links });
    return true;
  }

  static async consumeCode(code, from) {
    const state = await this.readState();
    const wanted = hash(String(code || '').trim().toUpperCase());
    const entry = state.codes.find((item) => item.hash === wanted);
    if (!entry) return null;
    const user = await User.findById(entry.userId);
    const membership = user ? await TenantUser.find(currentTenantId(), user.id) : null;
    if (!user || !membership) return null;
    const links = state.links.filter((link) => String(link.tgUserId) !== String(from.id));
    if (links.length >= MAX_LINKS) return null;
    links.push({
      tgUserId: String(from.id),
      tgUsername: from.username ? String(from.username).slice(0, 64) : null,
      userId: user.id,
      username: user.username,
      linkedAt: new Date().toISOString()
    });
    await this.writeState({ ...state, links, codes: state.codes.filter((item) => item !== entry) });
    return user;
  }

  /** Quem é este Telegram no painel — com o papel de AGORA, não o de quando vinculou. */
  static async resolveOperator(tgUserId) {
    const state = await this.readState();
    const link = state.links.find((item) => String(item.tgUserId) === String(tgUserId));
    if (!link) return null;
    const membership = await TenantUser.find(currentTenantId(), link.userId);
    const user = membership ? await User.findById(link.userId) : null;
    if (!user) return null;
    return { userId: user.id, username: user.username, role: membership.role };
  }

  // ── Entrada ────────────────────────────────────────────────────────

  /** Processa um update. Nunca lança: o Telegram reentrega o que não receber 2xx. */
  static async handleUpdate(update) {
    try {
      const settings = await WaAlertService.getSettings();
      const token = settings.telegram.token;
      if (!token) return;
      const ctx = { token, groupId: settings.telegram.chatId };
      if (update?.callback_query) await this.handleCallback(ctx, update.callback_query);
      else if (update?.message) await this.handleMessage(ctx, update.message);
    } catch (error) {
      console.warn('Telegram bot update failed', error?.name || 'Error');
    }
  }

  static reply(ctx, chatId, text, replyMarkup) {
    return sendTelegramMessage({ token: ctx.token, chatId, text, parseMode: 'HTML', replyMarkup });
  }

  /** Só o chat privado e o grupo dos alertas falam com o bot. */
  static chatAllowed(ctx, chat) {
    if (!chat) return false;
    if (chat.type === 'private') return true;
    return String(chat.id) === String(ctx.groupId);
  }

  static async handleMessage(ctx, message) {
    const from = message.from;
    const text = String(message.text || '').trim();
    if (!from || from.is_bot || !text.startsWith('/') || !this.chatAllowed(ctx, message.chat)) return;
    const [rawCommand, ...rest] = text.split(/\s+/);
    // `/status@MeuBot` no grupo: o sufixo é o nome do bot.
    const command = rawCommand.slice(1).split('@')[0].toLowerCase();
    const arg = rest.join(' ').trim();
    const chatId = message.chat.id;
    const isPrivate = message.chat.type === 'private';

    if (rateLimited(String(from.id))) return void this.reply(ctx, chatId, TEXT.rate);

    if (command === 'start' || command === 'ajuda' || command === 'help') {
      return void this.reply(ctx, chatId, TEXT.help);
    }
    if (command === 'vincular') {
      if (!isPrivate) return void this.reply(ctx, chatId, TEXT.linkPrivateOnly);
      const user = await this.consumeCode(arg, from);
      if (!user) return void this.reply(ctx, chatId, TEXT.linkBad);
      await AuditLog.record({
        action: AuditLog.ACTIONS.TELEGRAM_LINKED,
        actorUserId: user.id,
        actorUsername: user.username,
        subjectType: 'telegram',
        subjectId: from.id,
        detail: { telegramUsername: from.username || null }
      });
      return void this.reply(ctx, chatId, TEXT.linked(user.username));
    }

    const operator = await this.resolveOperator(from.id);
    if (!operator) {
      // No grupo, silêncio; no privado, a dica.
      return isPrivate ? void this.reply(ctx, chatId, TEXT.notLinked) : undefined;
    }
    if (command === 'desvincular') {
      await this.revokeLink(from.id);
      return void this.reply(ctx, chatId, TEXT.unlinked);
    }

    const handler = COMMANDS[command];
    if (!handler) return void this.reply(ctx, chatId, TEXT.unknown);
    if (!roleHas(operator.role, handler.permission)) return void this.reply(ctx, chatId, TEXT.forbidden);
    try {
      const answer = await handler.run({ arg, operator });
      await this.reply(ctx, chatId, answer.text, answer.replyMarkup);
    } catch (error) {
      console.warn('Telegram bot command failed', error?.name || 'Error');
      await this.reply(ctx, chatId, TEXT.failed);
    }
  }

  /** Os botões de página do /offline: `off:<página>`. */
  static async handleCallback(ctx, query) {
    const from = query.from;
    const chat = query.message?.chat;
    const answered = () => answerTelegramCallback({ token: ctx.token, callbackQueryId: query.id });
    if (!from || from.is_bot || !this.chatAllowed(ctx, chat) || rateLimited(String(from.id))) return void answered();
    const operator = await this.resolveOperator(from.id);
    const match = /^off:(\d{1,4})$/.exec(String(query.data || ''));
    if (!operator || !match || !roleHas(operator.role, COMMANDS.offline.permission)) return void answered();
    await answered();
    try {
      const answer = await COMMANDS.offline.run({ arg: match[1], operator });
      await this.reply(ctx, chat.id, answer.text, answer.replyMarkup);
    } catch {
      await this.reply(ctx, chat.id, TEXT.failed);
    }
  }
}

/** Cada comando: a capacidade do painel que ele exige, e o que responde. */
const COMMANDS = {
  status: {
    permission: 'devices.list',
    async run() {
      const data = await DeviceService.getDashboardData();
      const s = data?.stats || {};
      return {
        text: [
          '<b>Frota</b>',
          `Total: ${Number(s.total) || 0}`,
          `Online: ${Number(s.online) || 0}`,
          `Offline: ${Number(s.offline) || 0}`,
          `Novas (24h): ${Number(s.new24h) || 0}`
        ].join('\n')
      };
    }
  },
  offline: {
    permission: 'devices.list',
    async run({ arg }) {
      const page = Math.max(1, Number.parseInt(arg, 10) || 1);
      const result = await DeviceService.getDevicesPage({ status: 'offline', page, pageSize: PAGE_SIZE });
      const devices = result?.devices || [];
      if (devices.length === 0) return { text: 'Nenhuma ONT offline.' };
      const head = `<b>Offline</b> — página ${result.page}/${result.totalPages || 1} (${result.total} no total)`;
      const replyMarkup = result.page < (result.totalPages || 1)
        ? { inline_keyboard: [[{ text: 'Próxima ›', callback_data: `off:${result.page + 1}` }]] }
        : undefined;
      return { text: [head, ...devices.map(deviceLine)].join('\n'), replyMarkup };
    }
  },
  cliente: {
    permission: 'devices.list',
    async run({ arg }) {
      if (!arg) return { text: 'Use: /cliente &lt;PPPoE, serial ou id&gt;' };
      const result = await DeviceService.getDevicesPage({ search: arg.slice(0, 64), pageSize: 5, page: 1 });
      const devices = result?.devices || [];
      if (devices.length === 0) return { text: 'Nada encontrado.' };
      const more = result.total > devices.length ? `\n… e mais ${result.total - devices.length}. Refine a busca.` : '';
      return { text: [`<b>${result.total} resultado(s)</b>`, ...devices.map(deviceLine)].join('\n') + more };
    }
  },
  falhas: {
    permission: 'devices.list',
    async run() {
      const faults = await DeviceService.getFaults(10);
      if (!faults.length) return { text: 'Nenhuma falha no ACS.' };
      return {
        text: ['<b>Últimas falhas</b>', ...faults.map((fault) => (
          `• <code>${esc(fault.deviceId || fault.id)}</code> — ${esc(fault.code)}: ${esc(String(fault.message).slice(0, 120))} (${esc(agoText(fault.timestamp))})`
        ))].join('\n')
      };
    }
  }
};

export { COMMANDS as TELEGRAM_COMMANDS };
export default TelegramBotService;
