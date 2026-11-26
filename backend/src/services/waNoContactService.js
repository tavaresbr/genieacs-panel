import WaConversation from '../models/WaConversation.js';
import WaMessage from '../models/WaMessage.js';
import WaOptOut from '../models/WaOptOut.js';
import { tdb } from '../config/database.js';
import { tiposGravados } from '../utils/wa/waOptOutTipos.js';

/**
 * "Encerrar sem enviar nada".
 *
 * O atendente encerra e diz que o cliente não deve mais receber mensagem do
 * painel. A partir daí só passam: a cobrança (`billing`), a resposta a quem
 * escreve (a entrada do cliente libera a marca) e o que um atendente digitar
 * depois. O resto — bot proativo, campanha, aviso, pesquisa e qualquer saída
 * velha ainda na fila — é retirado e, na hora de enviar, conferido de novo.
 */
export const NO_CONTACT_REASON = 'Encerrada sem novas mensagens';
export const NO_CONTACT_ORIGIN = 'operator';
/** Tipos que a marca bloqueia: tudo, menos a cobrança. */
export const NO_CONTACT_TYPES = Object.freeze(['service', 'marketing', 'survey']);
/** A despedida que o atendente digitou pouco antes de encerrar ainda sai. */
export const FAREWELL_MS = 10 * 60 * 1000;
export const CANCELLED_TEXT = 'Cancelada: cliente encerrado sem novas mensagens';

class WaNoContactService {
  /** Se esta saída pode sair, dada a conversa. Notas e cobrança passam sempre. */
  static allows(conversation, message) {
    if (!conversation?.no_contact_at) return true;
    if (message.is_note || message.billing) return true;
    if (message.source !== 'operator') return false;
    const markedAt = new Date(conversation.no_contact_at).getTime();
    const createdAt = new Date(message.created_at).getTime();
    return createdAt >= markedAt - FAREWELL_MS;
  }

  /** Consulta a conversa da mensagem; usada pelo worker antes de enviar. */
  static async mayDeliver(message) {
    const conversation = await WaConversation.getById(message.conversation_id);
    return this.allows(conversation, message);
  }

  /** Marca a falha terminal de uma saída que a regra impediu. */
  static async block(message) {
    await WaMessage.update(message.id, {
      delivery_status: 'failed',
      delivery_error: CANCELLED_TEXT,
      next_attempt_at: null,
      claimed_at: null
    });
  }

  /**
   * Retira da fila o que ainda não saiu da conversa: `queued` e `failed` sem
   * envio, que não são nota nem cobrança nem despedida do atendente.
   */
  static async cancelPending(conversationId, markedAt) {
    const cutoff = new Date(new Date(markedAt).getTime() - FAREWELL_MS);
    return tdb('wa_messages')
      .where({ conversation_id: conversationId, direction: 'out' })
      .whereIn('delivery_status', ['queued', 'failed'])
      .whereNull('external_id')
      .where((q) => q.where({ is_note: false }).orWhereNull('is_note'))
      .where((q) => q.where({ billing: false }).orWhereNull('billing'))
      .where((q) => q
        .whereNot({ source: 'operator' })
        .orWhere('created_at', '<', cutoff))
      .update({
        delivery_status: 'failed',
        delivery_error: CANCELLED_TEXT,
        next_attempt_at: null,
        claimed_at: null,
        updated_at: new Date()
      });
  }

  /** O "não perturbe" parcial deste encerramento (soma aos tipos se já houver). */
  static async markOptOut(conversation) {
    const waPhone = conversation.wa_phone_e164;
    const waLid = conversation.wa_lid;
    const existente = await WaOptOut.findActive({ waPhone, waLid });
    if (!existente) {
      await WaOptOut.record({
        waPhone,
        waLid,
        conversationId: conversation.id,
        origin: NO_CONTACT_ORIGIN,
        reasonText: NO_CONTACT_REASON,
        categories: [...NO_CONTACT_TYPES]
      });
      return;
    }
    const atuais = tiposGravados(existente.categories);
    if (atuais === null) return; // já bloqueia tudo
    const soma = [...new Set([...atuais, ...NO_CONTACT_TYPES])];
    await WaOptOut.setCategories(existente.id, soma);
  }

  /** Aplica a marca: conversa, "não perturbe" e fila. */
  static async apply(conversation, userId) {
    const now = new Date();
    const updated = await WaConversation.update(conversation.id, {
      no_contact_at: now,
      no_contact_by: userId || null
    });
    await this.markOptOut(updated);
    await this.cancelPending(updated.id, now);
    return updated;
  }

  /** Zera a marca (cliente escreveu ou atendente reabriu). */
  static async clear(conversationId) {
    await tdb('wa_conversations')
      .where({ id: conversationId })
      .whereNotNull('no_contact_at')
      .update({ no_contact_at: null, no_contact_by: null, updated_at: new Date() });
  }

  /**
   * "Liberar mensagens": zera a marca e revoga só o "não perturbe" que este
   * encerramento criou — o pedido do próprio cliente (SAIR) não é tocado.
   */
  static async allowContact(conversation, userId) {
    await this.clear(conversation.id);
    const waPhone = conversation.wa_phone_e164;
    const waLid = conversation.wa_lid;
    const row = await WaOptOut.findActive({ waPhone, waLid });
    if (row && row.origin === NO_CONTACT_ORIGIN && row.reason_text === NO_CONTACT_REASON) {
      await WaOptOut.revoke(row.id, userId);
    }
    return WaConversation.getById(conversation.id);
  }
}

export default WaNoContactService;
