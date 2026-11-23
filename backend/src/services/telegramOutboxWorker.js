import TelegramConversation from '../models/TelegramConversation.js';
import TelegramMessage from '../models/TelegramMessage.js';
import TelegramCustomerBotService from './telegramCustomerBotService.js';
import { sendTelegramMessageWithId } from './telegramClient.js';
import { forEachTenant } from '../config/tenantJobs.js';
import { MAX_ATTEMPTS, retryDelayMs } from '../utils/telegram/telegramBackoff.js';

/** Com que frequência uma passada roda. */
const TICK_INTERVAL_MS = 5_000;

/**
 * O máximo de mensagens que uma passada manda, por provedor. O Telegram aceita
 * cerca de 30 mensagens por segundo no total (e uma por segundo por chat, o que
 * não pesa aqui: cada aviso vai a um chat diferente); com uma passada a cada 5 s,
 * 20 por provedor deixa folga para vários provedores no mesmo processo.
 */
const BATCH_LIMIT = 20;

/** `telegram_messages.delivery_error` tem 255 caracteres. */
const ERROR_LIMIT = 255;
const clip = (text) => String(text ?? '').slice(0, ERROR_LIMIT);

/**
 * A fila de avisos do Telegram dos clientes.
 *
 * `telegram_messages` É a fila (como `messenger_messages`): uma passada pede os
 * ids enviáveis, pega um com o UPDATE condicional de `TelegramMessage.claim()`,
 * envia e grava o resultado. O claim é o que torna seguro rodar duas passadas ao
 * mesmo tempo. Só entra aqui a mensagem `queued` — a resposta da equipe sai na
 * hora, por `TelegramSendService`, e nunca passa pela fila.
 *
 * É iniciada só por `server.js`, nunca como efeito colateral de um import.
 */
class TelegramOutboxWorker {
  static timer = null;

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        console.warn('Telegram outbox tick failed');
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
   * Uma passada por provedor que tem algo vencido. A passada ociosa — o estado
   * normal — é UMA consulta, com um provedor ou com cem.
   */
  static async tick() {
    const pendentes = await TelegramMessage.providersWithSendable();
    const summaries = await forEachTenant(() => this.tickForTenant(), { only: pendentes });
    return summaries.reduce(
      (total, one) => ({
        sent: total.sent + one.sent, failed: total.failed + one.failed, retry: total.retry + one.retry
      }),
      { sent: 0, failed: 0, retry: 0 }
    );
  }

  /** Uma passada do provedor em escopo. NUNCA lança: uma mensagem ruim não para as outras. */
  static async tickForTenant() {
    const summary = { sent: 0, failed: 0, retry: 0 };
    try {
      const ids = await TelegramMessage.listSendable(BATCH_LIMIT);
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- uma por vez: a ordem dos avisos importa
        const { outcome } = await this.deliver(id);
        if (outcome === 'sent') summary.sent += 1;
        else if (outcome === 'failed') summary.failed += 1;
        else if (outcome === 'retry') summary.retry += 1;
      }
    } catch {
      console.warn('Telegram outbox tick failed');
    }
    return summary;
  }

  /** Pega uma mensagem e a envia. NUNCA lança. */
  static async deliver(id) {
    const message = await TelegramMessage.claim(id);
    // Claim nulo: outra passada já tem a linha. É o UPDATE condicional
    // funcionando, não uma falha.
    if (!message) return { outcome: 'claimed_elsewhere', id };
    try {
      return await this.attempt(message);
    } catch {
      // Erro nosso (banco, bug) no meio do envio: não se sabe se saiu. Passageiro.
      return this.recordFailure(message, { text: 'internal error', permanent: false });
    }
  }

  static async attempt(message) {
    const conversation = await TelegramConversation.getById(message.conversation_id);
    if (!conversation) return this.recordFailure(message, { text: 'conversation not found', permanent: true });
    // O cliente bloqueou o bot, ou pediu para não receber avisos, enquanto a
    // mensagem esperava: a recusa já é conhecida, sem gastar chamada.
    if (conversation.blocked_at) return this.recordFailure(message, { text: 'the customer blocked the bot', permanent: true });
    if (message.source === 'notice' && conversation.notices_off_at) {
      return this.recordFailure(message, { text: 'the customer opted out of notices', permanent: true });
    }
    const active = await TelegramCustomerBotService.active();
    if (!active) return this.recordFailure(message, { text: 'the customer bot is not on', permanent: true });

    const result = await sendTelegramMessageWithId({
      token: active.token, chatId: conversation.chat_id, text: message.body
    });
    if (result.ok) {
      await TelegramMessage.update(message.id, {
        external_id: result.messageId ? `${conversation.chat_id}:${result.messageId}` : null,
        delivery_status: 'sent',
        delivery_error: null,
        next_attempt_at: null
      });
      await TelegramConversation.update(conversation.id, { last_message_at: new Date() });
      return { outcome: 'sent', id: message.id };
    }
    // 403: o cliente bloqueou o bot. Nada mais sai até ele escrever de novo.
    if (result.code === 'telegram_bot_not_in_chat') {
      await TelegramConversation.update(conversation.id, { blocked_at: new Date() });
      return this.recordFailure(message, { text: result.code, permanent: true });
    }
    // 429: o Telegram diz quanto esperar; a fila respeita.
    return this.recordFailure(message, {
      text: result.code,
      permanent: result.code === 'telegram_failed' && /chat not found|user is deactivated/i.test(result.description || ''),
      waitMs: Number.isFinite(result.retryAfter) ? Math.min(Math.max(result.retryAfter, 1), 3600) * 1000 : null
    });
  }

  /**
   * Grava uma tentativa que falhou e decide se haverá outra. Abaixo do teto a
   * linha volta para 'queued' com `next_attempt_at` no futuro; uma falha
   * permanente, ou a sétima tentativa, vira 'failed' com o motivo na mensagem.
   */
  static async recordFailure(message, { text, permanent, waitMs = null }) {
    const attempts = Number(message.attempts || 0);
    const terminal = permanent || attempts >= MAX_ATTEMPTS;
    await TelegramMessage.update(message.id, {
      delivery_status: terminal ? 'failed' : 'queued',
      delivery_error: clip(text),
      next_attempt_at: terminal ? null : new Date(Date.now() + (waitMs ?? retryDelayMs(attempts)))
    });
    return { outcome: terminal ? 'failed' : 'retry', id: message.id };
  }
}

export default TelegramOutboxWorker;
