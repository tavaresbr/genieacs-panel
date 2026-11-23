import { tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';

class TelegramMessage {
  static async getById(id) {
    return (await tdb('telegram_messages').where({ id }).first()) || null;
  }

  static async getByExternalId(externalId) {
    if (!externalId) return null;
    return (await tdb('telegram_messages').where({ external_id: externalId }).first()) || null;
  }

  /**
   * Grava uma mensagem. Devolve `{ message, created }`; `created: false` quando
   * o `external_id` já estava aqui — a Telegram reentrega o que não recebe 2xx,
   * e a segunda vez não pode duplicar nem contar de novo como não lida.
   */
  static async insert(row) {
    const now = new Date();
    try {
      const id = await tinsertReturningId('telegram_messages', { created_at: now, updated_at: now, ...row });
      return { message: await this.getById(id), created: true };
    } catch (error) {
      if (!isUniqueViolation(error) || !row.external_id) throw error;
      return { message: await this.getByExternalId(row.external_id), created: false };
    }
  }

  static async update(id, patch) {
    await tdb('telegram_messages').where({ id }).update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /**
   * A última mensagem de cada conversa, para a prévia da lista — em duas
   * leituras para a página inteira. "Última" é a de maior `id`.
   *
   * @returns {Promise<Map<number, object>>} conversa → mensagem
   */
  static async lastOfConversations(conversationIds) {
    const ids = [...new Set((conversationIds ?? []).map(Number).filter(Number.isInteger))];
    if (ids.length === 0) return new Map();
    const latest = await tdb('telegram_messages')
      .whereIn('conversation_id', ids)
      .groupBy('conversation_id')
      .select('conversation_id')
      .max({ last_id: 'id' });
    const lastIds = latest.map((row) => row.last_id);
    if (lastIds.length === 0) return new Map();
    const rows = await tdb('telegram_messages')
      .whereIn('id', lastIds)
      .select('id', 'conversation_id', 'direction', 'body', 'delivery_status', 'created_at');
    return new Map(rows.map((row) => [Number(row.conversation_id), row]));
  }

  static async listByConversation(conversationId, { limit = 100, beforeId = null } = {}) {
    const query = tdb('telegram_messages').where({ conversation_id: conversationId });
    if (beforeId) query.where('id', '<', beforeId);
    const rows = await query.orderBy('id', 'desc').limit(Math.min(Math.max(Number(limit) || 100, 1), 300));
    return rows.reverse();
  }
}

export default TelegramMessage;
