import { tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';

/** Uma conversa com uma pessoa (PSID) numa Página. */
class MessengerConversation {
  static async getById(id) {
    return (await tdb('messenger_conversations').where({ id }).first()) || null;
  }

  static async getByPsid(pageRowId, psid) {
    return (await tdb('messenger_conversations').where({ page_row_id: pageRowId, psid }).first()) || null;
  }

  /** Acha ou cria a conversa a que um evento pertence. Só preenche lacunas. */
  static async ensure({ pageRowId, psid, name }) {
    const existing = await this.getByPsid(pageRowId, psid);
    const now = new Date();
    if (existing) {
      if (name && !existing.name) {
        await tdb('messenger_conversations').where({ id: existing.id }).update({ name, updated_at: now });
        return this.getById(existing.id);
      }
      return existing;
    }
    try {
      const id = await tinsertReturningId('messenger_conversations', {
        page_row_id: pageRowId, psid, name: name || null, created_at: now, updated_at: now
      });
      return this.getById(id);
    } catch (error) {
      // Duas entregas ao mesmo tempo: a outra criou primeiro, e vale a dela.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.getByPsid(pageRowId, psid);
      if (!winner) throw error;
      return winner;
    }
  }

  static async update(id, patch) {
    await tdb('messenger_conversations').where({ id }).update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /** A caixa de entrada: as mais recentes primeiro; `status` escolhe a pilha. */
  static async listRecent({ limit = 50, offset = 0, status = 'open' } = {}) {
    const query = tdb('messenger_conversations');
    if (status === 'open') query.whereNull('closed_at');
    else if (status === 'closed') query.whereNotNull('closed_at');
    return query
      .orderByRaw('last_message_at is null, last_message_at desc')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
      .offset(Math.max(Number(offset) || 0, 0));
  }
}

export default MessengerConversation;
