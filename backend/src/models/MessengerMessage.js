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

  /**
   * A última mensagem gravada de cada conversa, para a prévia da lista — em duas
   * leituras para a página inteira (e não uma por linha). "Última" é a de maior
   * `id`, a última que entrou, e não a de maior hora: a Meta pode entregar fora
   * de ordem, e a prévia mostra o que o painel recebeu por último.
   *
   * @returns {Promise<Map<number, object>>} conversa → mensagem
   */
  static async lastOfConversations(conversationIds) {
    const ids = [...new Set((conversationIds ?? []).map(Number).filter(Number.isInteger))];
    if (ids.length === 0) return new Map();
    const latest = await tdb('messenger_messages')
      .whereIn('conversation_id', ids)
      .groupBy('conversation_id')
      .select('conversation_id')
      .max({ last_id: 'id' });
    const lastIds = latest.map((row) => row.last_id);
    if (lastIds.length === 0) return new Map();
    const rows = await tdb('messenger_messages')
      .whereIn('id', lastIds)
      .select('id', 'conversation_id', 'direction', 'body', 'attachment_type', 'delivery_status', 'created_at');
    return new Map(rows.map((row) => [Number(row.conversation_id), row]));
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
