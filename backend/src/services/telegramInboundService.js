import TelegramConversation from '../models/TelegramConversation.js';
import TelegramMessage from '../models/TelegramMessage.js';
import TelegramCustomerBotService from './telegramCustomerBotService.js';
import TelegramLinkTokenService, { TOKEN_FORMAT } from './telegramLinkTokenService.js';
import TelegramSendService from './telegramSendService.js';
import { tdb } from '../config/database.js';

const BODY_LIMIT = 4000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

/** Frases fixas do bot de clientes (pt-BR, como as do bot da equipe). */
const TEXT = Object.freeze({
  greeting: 'Olá! Recebemos a sua mensagem e a nossa equipe responde por aqui.',
  linked: 'Pronto, o seu Telegram foi vinculado ao seu cadastro. Pode escrever por aqui.',
  alreadyLinked: 'Este Telegram já está vinculado a um cadastro.',
  invalidLink: 'Este link não vale mais. Peça um novo à nossa equipe.',
  unsupported: '[anexo ainda não suportado]'
});

/** Limite por chat, em memória: basta para segurar um laço de quem só tem o @ do bot. */
const hits = new Map();
export function resetTelegramChatRateLimit() {
  hits.clear();
}
function limited(chatId, now = Date.now()) {
  const recent = (hits.get(chatId) || []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(chatId, recent);
    return true;
  }
  recent.push(now);
  hits.set(chatId, recent);
  if (hits.size > 5000) {
    for (const [id, list] of hits) {
      if (!list.some((at) => now - at < RATE_WINDOW_MS)) hits.delete(id);
    }
  }
  return false;
}

const displayName = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(' ').slice(0, 128) || null;

/** O texto da mensagem; o que não é texto vira um marcador (anexos entram numa etapa própria). */
function bodyOf(message) {
  if (typeof message.text === 'string') return message.text.slice(0, BODY_LIMIT);
  if (typeof message.caption === 'string') return message.caption.slice(0, BODY_LIMIT);
  return TEXT.unsupported;
}

/** `/start` e `/start <token>`; o `@NomeDoBot` do grupo/atalho é ignorado. */
function parseStart(text) {
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  return { token: match[1] && TOKEN_FORMAT.test(match[1]) ? match[1] : null };
}

async function handleMessage(message) {
  const chat = message.chat;
  const from = message.from;
  // Só conversa privada: um grupo não é um cliente, e o bot não atende grupos.
  if (!chat || chat.type !== 'private' || !from || from.is_bot || !message.message_id) return;
  if (limited(String(chat.id))) return;

  const active = await TelegramCustomerBotService.active();
  if (!active) return;
  const { bot } = active;

  const conversation = await TelegramConversation.ensure({
    botRowId: bot.id, chatId: chat.id, name: displayName(from), username: from.username ? String(from.username).slice(0, 64) : null
  });
  const at = message.date ? new Date(Number(message.date) * 1000) : new Date();
  const start = parseStart(message.text);

  // O token do link NUNCA entra na conversa: é uma credencial de uso único.
  const { created } = await TelegramMessage.insert({
    conversation_id: conversation.id,
    direction: 'in',
    external_id: `${chat.id}:${message.message_id}`,
    body: start ? '/start' : bodyOf(message),
    source: 'customer',
    created_at: at
  });
  // Reentrega: a mensagem já estava aqui e a conversa já foi atualizada.
  if (!created) return;

  await tdb('telegram_conversations').where({ id: conversation.id }).update({
    last_message_at: at,
    last_inbound_at: at,
    unread_count: Number(conversation.unread_count || 0) + 1,
    // Quem escreve de novo reabre a conversa arquivada, e quem escreve não bloqueou o bot.
    closed_at: null,
    blocked_at: null,
    updated_at: new Date()
  });

  if (!start) return;
  const fresh = await TelegramConversation.getById(conversation.id);
  if (start.token) {
    const redeemed = await TelegramLinkTokenService.redeem({ conversation: fresh, token: start.token });
    const reply = redeemed.linked ? TEXT.linked : (redeemed.reason === 'already_linked' ? TEXT.alreadyLinked : TEXT.invalidLink);
    await TelegramSendService.sendText(conversation.id, reply, null, { source: 'system' });
    return;
  }
  await TelegramSendService.sendText(conversation.id, TEXT.greeting, null, { source: 'system' });
}

class TelegramInboundService {
  /**
   * Processa um update já autenticado, dentro do escopo do provedor. Nunca
   * lança: o Telegram reentrega o que não recebe 2xx, e um evento ruim não pode
   * virar um laço de reentrega.
   */
  static async process(update) {
    try {
      if (update?.message) await handleMessage(update.message);
    } catch (error) {
      console.error('[telegram-chat] could not handle update:', error.name || 'Error');
    }
  }
}

export default TelegramInboundService;
