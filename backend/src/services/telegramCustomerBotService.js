import crypto from 'node:crypto';
import TelegramCustomerBot from '../models/TelegramCustomerBot.js';
import { createSecretBox } from '../utils/secretBox.js';
import { segredosIguais } from '../utils/wa/waWebhookAuth.js';
import {
  TELEGRAM_TOKEN_PATTERN,
  deleteTelegramWebhook,
  getTelegramMe,
  setTelegramWebhook
} from './telegramClient.js';

/**
 * O bot do Telegram dos CLIENTES do provedor.
 *
 * É outro bot que o da equipe (`telegramBotService.js`): um token tem um único
 * webhook, e o da equipe responde comando de operador. Este tem token, segredo
 * de webhook e rota (`/api/telegram-customer-webhook/:tenantId`) próprios.
 *
 * O token fica cifrado na coluna e nunca volta ao navegador. O segredo do
 * webhook é gerado a cada `enable()` e só o HASH é guardado: ele precisa ser
 * conferido, nunca relido.
 */
const tokenBox = createSecretBox('skygenpanel-telegram-customer-bot-v1');

export class TelegramChatError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TelegramChatError';
    this.code = code;
    this.status = status;
  }
}

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function encryptBotToken(token) {
  return JSON.stringify({ v: 1, ...tokenBox.encrypt(token) });
}

export function decryptBotToken(stored) {
  if (!stored) return '';
  try {
    return tokenBox.decrypt(JSON.parse(stored)) ?? '';
  } catch {
    return '';
  }
}

/** O bot como o navegador pode vê-lo: sem o token e sem o hash do segredo. */
export function publicBot(row) {
  if (!row) return { configured: false, enabled: false, botUsername: null, botName: null, webhookError: null };
  return {
    configured: Boolean(row.token),
    enabled: row.enabled === true || row.enabled === 1,
    botUsername: row.bot_username || null,
    botName: row.bot_name || null,
    webhookError: row.webhook_error || null
  };
}

const REFUSALS = Object.freeze({
  telegram_invalid_token: ['invalid_token', 'telegram rejected the bot token', 400],
  telegram_unreachable: ['telegram_unreachable', 'could not reach telegram', 502],
  telegram_failed: ['telegram_failed', 'telegram did not accept the request', 502]
});

function refusal(result) {
  const [code, message, status] = REFUSALS[result.code] || REFUSALS.telegram_failed;
  return new TelegramChatError(code, message, status);
}

class TelegramCustomerBotService {
  /**
   * Guarda o token: o Telegram confere (`getMe`) e diz de que bot é. Trocar o
   * token de um bot ligado o DESLIGA — o webhook antigo era do bot antigo.
   */
  static async connect(rawToken) {
    const token = String(rawToken ?? '').trim();
    if (!TELEGRAM_TOKEN_PATTERN.test(token)) {
      throw new TelegramChatError('invalid_token', 'the token does not look like a @BotFather token');
    }
    const me = await getTelegramMe({ token });
    if (!me.ok) throw refusal(me);
    const fields = {
      bot_id: String(me.result?.id ?? '').slice(0, 32) || null,
      bot_username: String(me.result?.username ?? '').slice(0, 64) || null,
      bot_name: String(me.result?.first_name ?? '').slice(0, 128) || null,
      token: encryptBotToken(token),
      webhook_error: null
    };
    const current = await TelegramCustomerBot.get();
    if (!current) return TelegramCustomerBot.create(fields);
    const previous = decryptBotToken(current.token);
    if (current.enabled && previous && previous !== token) {
      await deleteTelegramWebhook({ token: previous });
    }
    return TelegramCustomerBot.update(current.id, { ...fields, enabled: false, webhook_secret_hash: null });
  }

  /** Liga: registra o webhook com um segredo novo (o antigo deixa de valer). */
  static async enable({ webhookUrl }) {
    const bot = await TelegramCustomerBot.get();
    const token = bot ? decryptBotToken(bot.token) : '';
    if (!token) throw new TelegramChatError('bot_not_configured', 'save the bot token first', 409);
    const secret = crypto.randomBytes(32).toString('hex');
    const result = await setTelegramWebhook({ token, url: webhookUrl, secretToken: secret });
    if (!result.ok) {
      await TelegramCustomerBot.update(bot.id, { webhook_error: String(result.description || result.code).slice(0, 255) });
      throw refusal(result);
    }
    return TelegramCustomerBot.update(bot.id, { enabled: true, webhook_secret_hash: hash(secret), webhook_error: null });
  }

  /** Desliga: tira o webhook do Telegram e invalida o segredo. As conversas ficam. */
  static async disable() {
    const bot = await TelegramCustomerBot.get();
    if (!bot) return null;
    const token = decryptBotToken(bot.token);
    if (token) await deleteTelegramWebhook({ token });
    return TelegramCustomerBot.update(bot.id, { enabled: false, webhook_secret_hash: null });
  }

  /** Esquece o token (e desliga). As conversas e as mensagens ficam. */
  static async disconnect() {
    const bot = await TelegramCustomerBot.get();
    if (!bot) return null;
    await this.disable();
    return TelegramCustomerBot.update(bot.id, { token: null, bot_id: null, bot_username: null, bot_name: null });
  }

  /** O header do Telegram contra o hash guardado. Fail-closed. */
  static async secretMatches(header) {
    const bot = await TelegramCustomerBot.get();
    if (!bot?.enabled || !bot.webhook_secret_hash || !header) return false;
    return segredosIguais(hash(header), bot.webhook_secret_hash);
  }

  /** O bot pronto para falar: ligado e com token. */
  static async active() {
    const bot = await TelegramCustomerBot.get();
    if (!bot || !(bot.enabled === true || bot.enabled === 1)) return null;
    const token = decryptBotToken(bot.token);
    return token ? { bot, token } : null;
  }
}

export default TelegramCustomerBotService;
