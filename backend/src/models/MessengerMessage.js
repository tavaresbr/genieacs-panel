import { tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';

class MessengerMessage {
  static async getById(id) {
    return (await tdb('messenger_messages').where({ id }).first()) || null;
  }

  static async getByExternalId(externalId) {
    if (!externalId) return null;
    return (await tdb('messenger_messages').where({ external_id: externalId }).first()) || null;
  }

  /**
   * Grava uma mensagem. Devolve `{ message, created }`; `created: false` quando
   * o `mid` já estava aqui — a Meta reentrega, e a segunda vez não pode duplicar
   * nem contar de novo como não lida.
   */
  static async insert(row) {
    const now = new Date();
    try {
      const id = await tinsertReturningId('messenger_messages', {
        created_at: now, updated_at: now, ...row
      });
      return { message: await this.getById(id), created: true };
    } catch (error) {
      if (!isUniqueViolation(error) || !row.external_id) throw error;
      return { message: await this.getByExternalId(row.external_id), created: false };
    }
  }

  static async update(id, patch) {
    await tdb('messenger_messages').where({ id }).update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async listByConversation(conversationId, { limit = 100, beforeId = null } = {}) {
    const query = tdb('messenger_messages').where({ conversation_id: conversationId });
    if (beforeId) query.where('id', '<', beforeId);
    const rows = await query.orderBy('id', 'desc').limit(Math.min(Math.max(Number(limit) || 100, 1), 300));
    return rows.reverse();
  }

  /** Recibo de entrega/leitura: marca as saídas da conversa até `watermark`. */
  static async markOutboundUntil(conversationId, status, watermarkMs) {
    const until = new Date(Number(watermarkMs));
    if (Number.isNaN(until.getTime())) return 0;
    const patch = status === 'read'
      ? { delivery_status: 'read', read_at: new Date(), updated_at: new Date() }
      : { delivery_status: 'delivered', updated_at: new Date() };
    const query = tdb('messenger_messages')
      .where({ conversation_id: conversationId, direction: 'out' })
      .where('created_at', '<=', until);
    // Nunca volta atrás: "lida" não regride para "entregue".
    if (status === 'read') query.whereIn('delivery_status', ['sent', 'delivered']);
    else query.where({ delivery_status: 'sent' });
    return query.update(patch);
  }
}

export default MessengerMessage;
