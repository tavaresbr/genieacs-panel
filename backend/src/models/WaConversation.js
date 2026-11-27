import { tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';
import { variantesTelefoneBr } from '../utils/wa/waDestino.js';

const PHONE_DOMAIN = '@s.whatsapp.net';

/** One thread with one contact on one connected number. */
class WaConversation {
  static async getById(id) {
    return (await tdb('wa_conversations').where({ id }).first()) || null;
  }

  static async getByThread(accountId, externalThreadId) {
    return (
      (await tdb('wa_conversations')
        .where({ account_id: accountId, external_thread_id: externalThreadId })
        .first()) || null
    );
  }

  /**
   * The thread already open under the OTHER spelling of the same mobile.
   *
   * A conversation started from the panel is keyed by the number the ERP holds
   * — with the ninth digit — while WhatsApp still addresses many older accounts
   * by the twelve-digit form. Without this the subscriber's answer would open a
   * second thread beside the one the operator is waiting in.
   */
  static async getByPhoneSpelling(accountId, externalThreadId) {
    const thread = String(externalThreadId ?? '');
    if (!thread.endsWith(PHONE_DOMAIN)) return null;
    const digits = thread.slice(0, -PHONE_DOMAIN.length);
    for (const spelling of variantesTelefoneBr(digits)) {
      if (spelling === digits) continue;
      const found = await this.getByThread(accountId, `${spelling}${PHONE_DOMAIN}`);
      if (found) return found;
    }
    return null;
  }

  /**
   * Finds or creates the thread an inbound event belongs to.
   *
   * `external_thread_id` is the key because it is what both server flavors send
   * back on every event; phone and LID are attributes of the contact that may
   * arrive later, or only one of the two ever.
   */
  static async ensure({ accountId, externalThreadId, waPhone, waLid, pushName }) {
    const existing = (await this.getByThread(accountId, externalThreadId))
      || (await this.getByPhoneSpelling(accountId, externalThreadId));
    const now = new Date();
    if (existing) {
      // Only fill gaps. A pushName the operator already corrected, or a phone
      // learned from a richer event, must not be overwritten by a later event
      // that happens to carry less.
      const patch = {};
      if (waPhone && !existing.wa_phone_e164) patch.wa_phone_e164 = waPhone;
      if (waLid && !existing.wa_lid) patch.wa_lid = waLid;
      if (pushName && !existing.push_name) patch.push_name = pushName;
      if (Object.keys(patch).length === 0) return existing;
      await tdb('wa_conversations').where({ id: existing.id }).update({ ...patch, updated_at: now });
      return this.getById(existing.id);
    }
    let id;
    try {
      id = await tinsertReturningId('wa_conversations', {
        account_id: accountId,
        external_thread_id: externalThreadId,
        wa_phone_e164: waPhone || null,
        wa_lid: waLid || null,
        push_name: pushName || null,
        created_at: now,
        updated_at: now
      });
    } catch (error) {
      // Dois cliques, ou um clique e uma mensagem de entrada ao mesmo tempo: a
      // outra chamada criou a conversa primeiro. Vale a que ficou.
      if (!isUniqueViolation(error)) throw error;
      const winner = (await this.getByThread(accountId, externalThreadId))
        || (await this.getByPhoneSpelling(accountId, externalThreadId));
      if (!winner) throw error;
      return winner;
    }
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('wa_conversations')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /**
   * `%` e `_` são os curingas do LIKE. Antes eram tirados do termo, e quem
   * buscava `joao_silva` (um login PPPoE comum) procurava `joaosilva` e não
   * achava. Agora são escapados com `!` — o mesmo escape de
   * `BillingCharge.bySupersededGatewayId`, que os três bancos aceitam igual;
   * a barra invertida não serve porque o MySQL a interpreta dentro do
   * literal `'\'`. Todo `like ?` que recebe este termo leva `LIKE_ESCAPE`.
   */
  static likeTerm(term) {
    return String(term ?? '').trim().toLowerCase().replace(/[!%_]/g, (c) => `!${c}`);
  }

  static LIKE_ESCAPE = "escape '!'";

  /**
   * The inbox page.
   *
   * `status` picks which pile: the open threads, the filed ones, or both.
   * `search` matches the two columns the thread carries itself — the pushed
   * WhatsApp name and the contract — plus the phone, which is compared as
   * digits because that is how it is stored. The subscriber's name lives in
   * `sgp_links`, so the caller resolves it to `searchContracts` in one batched
   * query and hands the result down; matching it here would mean a join per row.
   */
  /** Quantas conversas abertas têm mensagem não lida (conversas, não mensagens). */
  static async countUnread() {
    const [row] = await tdb('wa_conversations').whereNull('closed_at').where('unread_count', '>', 0).count({ total: '*' });
    return Number(row?.total || 0);
  }

  static async listRecent({
    limit = 50, offset = 0, status = 'open', search = '', searchContracts = [], searchContactIds = [], assignee = null, tagId = null, unread = false
  } = {}) {
    const query = tdb('wa_conversations');

    // "Não lidas": só conversas abertas com mensagem do cliente ainda não vista.
    if (unread) query.whereNull('closed_at').where('unread_count', '>', 0);

    // Uma etiqueta: subconsulta no vínculo, também escopada, e não junção.
    if (tagId) {
      query.whereIn('id', tdb('wa_conversation_tags').where({ tag_id: tagId }).select('conversation_id'));
    }

    // "Minhas" e "Sem atendente": um recorte por cima de qualquer pilha.
    if (assignee === 'unassigned') query.whereNull('assigned_user_id');
    else if (assignee?.userId) query.where('assigned_user_id', assignee.userId);

    const raw = String(search ?? '').trim();

    if (status === 'closed') query.whereNotNull('closed_at');
    else if (status === 'noreply') query.whereNull('closed_at').whereNull('engaged_at');
    else if (status !== 'all') {
      query.whereNull('closed_at');
      // "Abertas" é onde há gente dos dois lados. A conversa que só recebeu
      // envio automático mora em "Sem resposta" — mas uma busca pelo nome ou
      // pelo telefone a encontra daqui também, porque quem procura um cliente
      // não sabe, nem precisa saber, em qual das duas pilhas ele está.
      if (!raw) query.whereNotNull('engaged_at');
    }

    const term = this.likeTerm(raw);
    if (raw) {
      const like = `%${term}%`;
      const digits = term.replace(/\D/g, '');
      query.where((match) => {
        // The operator typed something, but only blanks: no searchable text
        // left behind. Falling through to "no filter" would hand back the
        // whole inbox under a search term, and every row of it would read as
        // a match.
        if (!term) {
          match.whereRaw('1 = 0');
          return;
        }
        match
          .whereRaw(`lower(push_name) like ? ${this.LIKE_ESCAPE}`, [like])
          .orWhereRaw(`lower(contract) like ? ${this.LIKE_ESCAPE}`, [like]);
        // Stored as digits only, so what the operator typed has to be reduced
        // the same way: "(93) 98111-0001" and 5593981110001 are one number
        // written twice, and only one of the two spellings is in the column.
        if (digits) match.orWhere('wa_phone_e164', 'like', `%${digits}%`);
        if (searchContracts.length > 0) match.orWhereIn('contract', searchContracts);
        // A client with no contract is bound by row, so a name search reaches
        // their thread through `sgp_contact_id`.
        if (searchContactIds.length > 0) match.orWhereIn('sgp_contact_id', searchContactIds);
      });
    }

    return query
      .orderBy('last_message_at', 'desc')
      .limit(limit)
      .offset(offset);
  }
}

export default WaConversation;
