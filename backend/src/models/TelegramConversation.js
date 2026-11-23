import { tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';

/** Uma conversa com uma pessoa (`chat_id`) no bot de clientes. */
class TelegramConversation {
  static async getById(id) {
    return (await tdb('telegram_conversations').where({ id }).first()) || null;
  }

  static async getByChat(botRowId, chatId) {
    return (await tdb('telegram_conversations').where({ bot_row_id: botRowId, chat_id: String(chatId) }).first()) || null;
  }

  /** Acha ou cria a conversa a que um evento pertence. Só preenche lacunas. */
  static async ensure({ botRowId, chatId, name, username }) {
    const existing = await this.getByChat(botRowId, chatId);
    const now = new Date();
    if (existing) {
      const patch = {};
      if (name && !existing.name) patch.name = name;
      if (username && !existing.username) patch.username = username;
      if (Object.keys(patch).length === 0) return existing;
      await tdb('telegram_conversations').where({ id: existing.id }).update({ ...patch, updated_at: now });
      return this.getById(existing.id);
    }
    try {
      const id = await tinsertReturningId('telegram_conversations', {
        bot_row_id: botRowId,
        chat_id: String(chatId),
        name: name || null,
        username: username || null,
        created_at: now,
        updated_at: now
      });
      return this.getById(id);
    } catch (error) {
      // Duas entregas ao mesmo tempo: a outra criou primeiro, e vale a dela.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.getByChat(botRowId, chatId);
      if (!winner) throw error;
      return winner;
    }
  }

  static async update(id, patch) {
    await tdb('telegram_conversations').where({ id }).update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /** A caixa de entrada: as mais recentes primeiro; `status` escolhe a pilha. */
  static async listRecent({ limit = 50, offset = 0, status = 'open' } = {}) {
    const query = tdb('telegram_conversations');
    if (status === 'open') query.whereNull('closed_at');
    else if (status === 'closed') query.whereNotNull('closed_at');
    return query
      .orderByRaw('last_message_at is null, last_message_at desc')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
      .offset(Math.max(Number(offset) || 0, 0));
  }
}

export default TelegramConversation;
