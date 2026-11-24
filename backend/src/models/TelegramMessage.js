import { getDb, tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * Quanto tempo uma mensagem "enviando" pode ficar parada antes de a fila a
 * considerar abandonada (o processo caiu no meio) e retomá-la. Bem acima do
 * tempo de uma chamada ao Telegram (10 s).
 */
export const RECLAIM_MS = 5 * 60_000;

/** O que a fila pode levar agora: na fila e vencida, ou "enviando" há tempo demais. Só saída, ainda sem `message_id`. */
function sendable(query, now) {
  const cutoff = new Date(now.getTime() - RECLAIM_MS);
  return query
    .where({ direction: 'out' })
    .whereNull('external_id')
    .where((q) => q
      .where((ready) => ready
        .where({ delivery_status: 'queued' })
        .where((due) => due.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now)))
      .orWhere((stale) => stale.where({ delivery_status: 'sending' }).where('claimed_at', '<', cutoff)));
}

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

  // ── A fila de saída (os avisos) ────────────────────────────────────

  /**
   * Os provedores que têm algo para a fila levar agora — uma pergunta para
   * todos, para a passada ociosa custar UMA consulta. Só ids de provedor
   * atravessam o escopo; a fila de cada um é lida depois, no escopo dele.
   */
  static async providersWithSendable() {
    const now = new Date();
    const rows = await runUnscoped(
      'the Telegram outbox asks which providers have anything due before opening a scope for each',
      // tenant-scope-exempt: só `tenant_id` sai daqui; a fila é lida no escopo de cada um.
      () => getDb()('telegram_messages').distinct('tenant_id').where((q) => sendable(q, now))
    );
    return rows.map((row) => Number(row.tenant_id)).filter(Number.isInteger);
  }

  /** Os ids que a fila deve tentar agora, do mais antigo ao mais novo. */
  static async listSendable(limit) {
    const now = new Date();
    const rows = await tdb('telegram_messages')
      .where((q) => sendable(q, now))
      .orderBy('id')
      .limit(limit)
      .select('id');
    return rows.map((row) => row.id);
  }

  /**
   * Pega uma mensagem, ou diz que outra passada já a tem. UPDATE condicional
   * conferido pelo número de linhas (o SQLite não tem `SKIP LOCKED`): o WHERE
   * repete o critério da listagem, então duas passadas simultâneas não ganham as
   * duas.
   *
   * @returns {Promise<object|null>} a linha pega, ou `null`
   */
  static async claim(id) {
    const now = new Date();
    const changed = await tdb('telegram_messages')
      .where({ id })
      .where((q) => sendable(q, now))
      .update({
        delivery_status: 'sending',
        claimed_at: now,
        attempts: getDb().raw('attempts + 1'),
        updated_at: now
      });
    return changed > 0 ? this.getById(id) : null;
  }

  static async listByConversation(conversationId, { limit = 100, beforeId = null } = {}) {
    const query = tdb('telegram_messages').where({ conversation_id: conversationId });
    if (beforeId) query.where('id', '<', beforeId);
    const rows = await query.orderBy('id', 'desc').limit(Math.min(Math.max(Number(limit) || 100, 1), 300));
    return rows.reverse();
  }
}

export default TelegramMessage;
