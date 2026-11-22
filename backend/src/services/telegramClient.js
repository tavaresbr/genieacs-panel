/**
 * O Telegram de um provedor: um bot dele (criado no @BotFather) mandando para
 * um grupo da equipe.
 *
 * Um cliente pequeno e de propósito: o painel só MANDA texto (`sendMessage`).
 * Não lê atualizações, não guarda conversa, não sabe de assinante — alerta
 * nomeia equipamento, e quem recebe é a equipe.
 *
 * **O token vai no caminho da URL** (`/bot<token>/sendMessage`), que é como a
 * API do Telegram funciona. Por isso nada aqui registra, devolve ou embute a
 * URL numa mensagem de erro: o que sai é o código traduzido e, no máximo, a
 * `description` que o Telegram mandou — que não contém o token.
 *
 * O host é fixo, e não um endereço que o cliente escolhe: não passa pela
 * guarda de egresso dos endereços de cliente (GenieACS, ERP), que existe para
 * URL digitada por quem administra o provedor.
 */

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_TIMEOUT_MS = 10_000;
/** O limite do Telegram para uma mensagem é 4096 caracteres. */
const TELEGRAM_TEXT_MAX = 4096;

/** O formato que o @BotFather entrega: `<id numérico>:<segredo>`. */
export const TELEGRAM_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

/**
 * O destino: o id numérico de um grupo ou canal (grupos são negativos) ou o
 * `@nome` público de um canal.
 */
export const TELEGRAM_CHAT_PATTERN = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

let fetcher = (...args) => fetch(...args);

/** Para os testes: o Telegram falso entra aqui. */
export function setTelegramFetcher(fn) {
  fetcher = fn || ((...args) => fetch(...args));
}

/**
 * A recusa do Telegram lida como um código que a tela sabe explicar.
 *
 * 401 é token errado (ou revogado no @BotFather); 403 é o bot fora do grupo
 * (ou bloqueado); 400 com "chat not found" é o id do grupo errado. O resto é
 * `telegram_failed`, com a descrição do próprio Telegram.
 */
export function telegramRefusal(status, description = '') {
  const texto = String(description || '').toLowerCase();
  if (status === 401) return 'telegram_invalid_token';
  if (status === 403) return 'telegram_bot_not_in_chat';
  if (status === 400 && texto.includes('chat not found')) return 'telegram_chat_not_found';
  return 'telegram_failed';
}

/**
 * Chama um método da Bot API. Nunca lança.
 *
 * É o único lugar que monta a URL com o token; por isso nenhuma exceção ou erro
 * sai daqui com ela.
 *
 * @returns {Promise<{ ok: true, result: any } | { ok: false, code: string, description: string | null }>}
 */
export async function callTelegram(token, method, payload = {}) {
  let resposta;
  try {
    resposta = await fetcher(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    });
  } catch {
    // A exceção do `fetch` pode trazer a URL — com o token dentro. Não sai.
    return { ok: false, code: 'telegram_unreachable', description: null };
  }
  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }
  if (resposta.ok && dados?.ok) return { ok: true, result: dados.result ?? null };
  const description = typeof dados?.description === 'string' ? dados.description.slice(0, 200) : null;
  return { ok: false, code: telegramRefusal(resposta.status, description), description };
}

/**
 * Manda um texto. Nunca lança.
 *
 * `parseMode` ('HTML') e `replyMarkup` (teclado inline) são opcionais: o alerta
 * continua texto puro, e só o bot de comandos os usa.
 *
 * @returns {Promise<{ ok: true } | { ok: false, code: string, description: string | null }>}
 */
export async function sendTelegramMessage({ token, chatId, text, parseMode, replyMarkup }) {
  const corpo = String(text ?? '').slice(0, TELEGRAM_TEXT_MAX);
  const payload = { chat_id: chatId, text: corpo, disable_web_page_preview: true };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const resultado = await callTelegram(token, 'sendMessage', payload);
  return resultado.ok ? { ok: true } : resultado;
}

/** Escapa o que vem de fora (nome de cliente, login) para `parse_mode: 'HTML'`. */
export function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Registra o webhook. `secretToken` volta em todo pedido no header
 * `X-Telegram-Bot-Api-Secret-Token`; só os updates de mensagem e de botão são
 * pedidos, que é tudo o que o bot lê.
 */
export function setTelegramWebhook({ token, url, secretToken }) {
  return callTelegram(token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  });
}

export function deleteTelegramWebhook({ token }) {
  return callTelegram(token, 'deleteWebhook', { drop_pending_updates: true });
}

/** Responde o toque num botão inline (tira o "carregando" do botão). */
export function answerTelegramCallback({ token, callbackQueryId, text }) {
  return callTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {})
  });
}

/** Tira os botões de uma mensagem já respondida (um toque só vale uma vez). */
export function clearTelegramButtons({ token, chatId, messageId }) {
  return callTelegram(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] }
  });
}
