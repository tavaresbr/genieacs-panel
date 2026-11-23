import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import MessengerMessage from '../models/MessengerMessage.js';
import { tdb, isUniqueViolation } from '../config/database.js';
import { forEachTenant } from '../config/tenantJobs.js';
import { graphRequest } from './metaGraphClient.js';
import { decryptPageToken } from './messengerPageService.js';
import { windowOpen } from '../utils/messenger/messengerWindow.js';
import { MAX_ATTEMPTS, retryDelayMs } from '../utils/messenger/messengerBackoff.js';
import { classifyGraphFailure } from '../utils/messenger/messengerSendFailure.js';

/** Com que frequência uma passada roda. Curta: uma resposta digitada por gente está esperando. */
const TICK_INTERVAL_MS = 5_000;

/** O máximo de mensagens que uma passada olha, por provedor. */
const BATCH_LIMIT = 20;

/** `messenger_messages.delivery_error` tem 255 caracteres. */
const ERROR_LIMIT = 255;

const clip = (text) => String(text ?? '').slice(0, ERROR_LIMIT);

/**
 * A fila de saída do Messenger.
 *
 * `messenger_messages` É a fila (não há tabela ao lado): uma passada pede os ids
 * enviáveis, pega um com o UPDATE condicional de `MessengerMessage.claim()`,
 * envia e grava o resultado. O claim é o que torna seguro rodar duas passadas ao
 * mesmo tempo — a que perde não faz nada —, então nada aqui serializa os ticks.
 *
 * Duas portas levam à mesma `deliver()`: o laço de cinco segundos (para o que
 * falhou por motivo passageiro e espera nova tentativa) e o próprio envio, que
 * tenta já (`MessengerSendService.sendText`) — o caso comum sai na hora, e só o
 * que a Meta ou a rede não aguentou vai para o recuo.
 *
 * É iniciada só por `server.js`, nunca como efeito colateral de um import, para
 * a suíte de testes não ter um timer rodando atrás de si.
 */
class MessengerOutboxWorker {
  static timer = null;

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` engole as próprias falhas; este catch é só para que um erro na
      // cadeia de promessas não vire uma rejeição sem tratamento.
      void this.tick().catch((error) => {
        console.warn(`Messenger outbox tick failed: ${error.message}`);
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
   * Uma passada por provedor que tem algo vencido, cada uma esvaziando só a fila
   * dele. A passada ociosa — o estado normal — é UMA consulta, com um provedor
   * ou com cem.
   *
   * @returns {Promise<{ sent: number, failed: number, retry: number }>}
   */
  static async tick() {
    const pendentes = await MessengerMessage.providersWithSendable();
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
      const ids = await MessengerMessage.listSendable(BATCH_LIMIT);
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- uma por vez: a ordem das respostas importa
        const { outcome } = await this.deliver(id);
        if (outcome === 'sent') summary.sent += 1;
        else if (outcome === 'failed') summary.failed += 1;
        else if (outcome === 'retry') summary.retry += 1;
      }
    } catch (error) {
      console.warn(`Messenger outbox tick failed: ${error.message}`);
    }
    return summary;
  }

  /**
   * Pega uma mensagem e a envia. NUNCA lança.
   *
   * @returns {Promise<{ outcome: 'sent'|'failed'|'retry'|'claimed_elsewhere', id: number }>}
   *   `id` é a linha em que a mensagem ficou (pode não ser a que entrou, se o eco
   *   da Meta a adotou — ver `markSent`).
   */
  static async deliver(id) {
    const message = await MessengerMessage.claim(id);
    // Claim nulo: outra passada já tem a linha. É o UPDATE condicional
    // funcionando, não uma falha.
    if (!message) return { outcome: 'claimed_elsewhere', id };
    try {
      return await this.attempt(message);
    } catch (error) {
      // Erro nosso (banco, bug) no meio do envio: não se sabe se saiu. Trata como
      // passageiro — a tentativa seguinte, ou a retomada da linha abandonada, decide.
      return this.recordFailure(message, { text: `internal: ${error.message}`, permanent: false });
    }
  }

  static async attempt(message) {
    const conversation = await MessengerConversation.getById(message.conversation_id);
    if (!conversation) {
      return this.recordFailure(message, { text: 'conversation not found', permanent: true });
    }
    // A janela pode ter fechado enquanto a mensagem esperava o recuo: a Meta
    // recusaria, e a recusa já é conhecida — sem gastar chamada.
    if (!windowOpen(conversation)) {
      return this.recordFailure(message, { text: 'the 24-hour reply window closed before the message could be sent', permanent: true });
    }
    const page = await MessengerPage.getById(conversation.page_row_id);
    if (!page || page.status === 'error') {
      return this.recordFailure(message, { text: 'the page is not connected', permanent: true });
    }

    const result = await graphRequest({
      method: 'POST',
      path: `/${page.page_id}/messages`,
      metaToken: decryptPageToken(page.page_token),
      body: {
        recipient: { id: conversation.psid },
        messaging_type: 'RESPONSE',
        message: { text: message.body }
      }
    });

    if (result.ok) {
      const mid = String(result.data?.message_id ?? '').slice(0, 128) || null;
      return this.markSent(message, conversation, mid);
    }

    const { permanent, tokenInvalid } = classifyGraphFailure(result);
    if (tokenInvalid) {
      // O token não vale mais: a Página aparece como "requer atenção" até ser reconectada.
      await MessengerPage.update(page.id, { status: 'error', webhook_error: clip(result.error) });
    }
    return this.recordFailure(message, { text: result.error, permanent });
  }

  /**
   * A Meta aceitou: grava o `mid` e fecha a mensagem.
   *
   * O eco do que acabou de sair chega pelo webhook como entrada (`is_echo`) e
   * `handleMessage` o grava com este mesmo `mid`. Se ele chegar ANTES desta
   * escrita, o índice único (provedor, `mid`) recusa — e isso quer dizer o
   * contrário de falha: a outra ponta já registrou o que mandamos. A linha do
   * eco é ADOTADA (ganha a origem e o autor desta) e esta, que seria uma
   * segunda bolha, sai. Reenviar aqui seria mandar duas vezes à pessoa.
   */
  static async markSent(message, conversation, mid) {
    const patch = { external_id: mid, delivery_status: 'sent', delivery_error: null, next_attempt_at: null };
    try {
      await MessengerMessage.update(message.id, patch);
    } catch (error) {
      if (!isUniqueViolation(error) || !mid) throw error;
      const echo = await MessengerMessage.getByExternalId(mid);
      if (!echo || echo.id === message.id) throw error;
      await MessengerMessage.update(echo.id, {
        source: message.source, sent_by: message.sent_by, delivery_status: 'sent', delivery_error: null
      });
      await tdb('messenger_messages').where({ id: message.id }).del();
      await MessengerConversation.update(conversation.id, { last_message_at: new Date() });
      return { outcome: 'sent', id: echo.id };
    }
    await MessengerConversation.update(conversation.id, { last_message_at: new Date() });
    return { outcome: 'sent', id: message.id };
  }

  /**
   * Grava uma tentativa que falhou e decide se haverá outra.
   *
   * Abaixo do teto a linha volta para 'queued' com `next_attempt_at` no futuro —
   * sem a hora de vencimento, "na fila" seria "agora" e o recuo não seria recuo.
   * Uma falha permanente, ou a sétima tentativa, vira 'failed' e a razão fica na
   * própria mensagem, onde o atendente a lê.
   */
  static async recordFailure(message, { text, permanent }) {
    const attempts = Number(message.attempts || 0);
    const terminal = permanent || attempts >= MAX_ATTEMPTS;
    await MessengerMessage.update(message.id, {
      delivery_status: terminal ? 'failed' : 'queued',
      delivery_error: clip(text),
      next_attempt_at: terminal ? null : new Date(Date.now() + retryDelayMs(attempts))
    });
    if (terminal || attempts > 1) {
      console.warn(`[messenger] message ${message.id} attempt ${attempts}/${MAX_ATTEMPTS} failed${permanent ? ' permanently' : ''}: ${clip(text)}`);
    }
    return { outcome: terminal ? 'failed' : 'retry', id: message.id };
  }
}

export default MessengerOutboxWorker;
