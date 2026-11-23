import { getDb, tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * Quanto tempo uma mensagem "enviando" pode ficar parada antes de a fila a
 * considerar abandonada (o processo caiu no meio) e retomá-la. Bem acima do
 * tempo de uma chamada à Graph (10 s), para não pegar uma que ainda está no ar.
 */
export const RECLAIM_MS = 5 * 60_000;

/**
 * Quanto uma mensagem espera pela irmã mais antiga da mesma conversa que está
 * aguardando nova tentativa. Respostas de uma conversa saem na ordem em que
 * foram escritas; passada a janela, uma falha não segura a conversa.
 */
export const SIBLING_WINDOW_MS = 10 * 60_000;

/** O que a fila pode levar agora: na fila e vencida, ou "enviando" há tempo demais. Só saída, ainda sem `mid`. */
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

  // ── A fila de saída ────────────────────────────────────────────────

  /**
   * Os provedores que têm alguma mensagem para a fila levar agora — uma pergunta
   * para todos, para a passada ociosa custar UMA consulta (e não uma por
   * provedor a cada cinco segundos). Só ids de provedor atravessam o escopo; a
   * fila de cada um é lida depois, dentro do escopo dele.
   */
  static async providersWithSendable() {
    const now = new Date();
    const rows = await runUnscoped(
      'the Messenger outbox asks which providers have anything due before opening a scope for each',
      // tenant-scope-exempt: só `tenant_id` sai daqui; a fila é lida no escopo de cada um.
      () => getDb()('messenger_messages').distinct('tenant_id').where((q) => sendable(q, now))
    );
    return rows.map((row) => Number(row.tenant_id)).filter(Number.isInteger);
  }

  /**
   * Tira da vez a que passaria na frente de uma irmã mais antiga, da mesma
   * conversa, que está esperando nova tentativa (dentro de `SIBLING_WINDOW_MS`).
   */
  static async withoutOvertakers(rows, now) {
    if (rows.length === 0) return [];
    const conversations = [...new Set(rows.map((row) => row.conversation_id))];
    const waiting = await tdb('messenger_messages')
      .whereIn('conversation_id', conversations)
      .where({ direction: 'out', delivery_status: 'queued' })
      .whereNull('external_id')
      .where('next_attempt_at', '>', now)
      .select('id', 'conversation_id', 'created_at');
    if (waiting.length === 0) return rows.map((row) => row.id);
    return rows
      .filter((row) => !waiting.some((early) => early.conversation_id === row.conversation_id
        && early.id < row.id
        && new Date(row.created_at).getTime() - new Date(early.created_at).getTime() <= SIBLING_WINDOW_MS))
      .map((row) => row.id);
  }

  /** Os ids que a fila deve tentar agora, do mais antigo ao mais novo. */
  static async listSendable(limit) {
    const now = new Date();
    const rows = await tdb('messenger_messages')
      .where((q) => sendable(q, now))
      .orderBy('created_at')
      .orderBy('id')
      .limit(limit)
      .select('id', 'conversation_id', 'created_at');
    return this.withoutOvertakers(rows, now);
  }

  /**
   * Pega uma mensagem, ou diz que outra passada já a tem. UPDATE condicional
   * conferido pelo número de linhas (o SQLite não tem `SKIP LOCKED`): o WHERE
   * repete o critério da listagem, então duas passadas simultâneas não ganham as
   * duas — a que chega depois casa zero linhas e não faz nada.
   *
   * @returns {Promise<object|null>} a linha pega, ou `null`
   */
  static async claim(id) {
    const now = new Date();
    const changed = await tdb('messenger_messages')
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
