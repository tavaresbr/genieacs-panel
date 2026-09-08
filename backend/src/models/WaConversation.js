import { tdb, tinsertReturningId } from '../config/database.js';

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
   * Finds or creates the thread an inbound event belongs to.
   *
   * `external_thread_id` is the key because it is what both server flavors send
   * back on every event; phone and LID are attributes of the contact that may
   * arrive later, or only one of the two ever.
   */
  static async ensure({ accountId, externalThreadId, waPhone, waLid, pushName }) {
    const existing = await this.getByThread(accountId, externalThreadId);
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
    const id = await tinsertReturningId('wa_conversations', {
      account_id: accountId,
      external_thread_id: externalThreadId,
      wa_phone_e164: waPhone || null,
      wa_lid: waLid || null,
      push_name: pushName || null,
      created_at: now,
      updated_at: now
    });
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('wa_conversations')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /**
   * `%` and `_` are LIKE's own wildcards, and the three engines the panel
   * supports spell the escape clause differently enough that getting it right
   * everywhere costs more than it buys: a phone, a name and a contract never
   * contain either, so a term carrying them is stripped rather than escaped.
   */
  static likeTerm(term) {
    return String(term ?? '').trim().toLowerCase().replace(/[%_]/g, '');
  }

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
  static async listRecent({ limit = 50, offset = 0, status = 'open', search = '', searchContracts = [] } = {}) {
    const query = tdb('wa_conversations');

    if (status === 'closed') query.whereNotNull('closed_at');
    else if (status !== 'all') query.whereNull('closed_at');

    const raw = String(search ?? '').trim();
    const term = this.likeTerm(raw);
    if (raw) {
      const like = `%${term}%`;
      const digits = term.replace(/\D/g, '');
      query.where((match) => {
        // The operator typed something, but stripping LIKE's wildcards left no
        // searchable text behind. Falling through to "no filter" would hand
        // back the whole inbox under a search term, and every row of it would
        // read as a match.
        if (!term) {
          match.whereRaw('1 = 0');
          return;
        }
        match
          .whereRaw('lower(push_name) like ?', [like])
          .orWhereRaw('lower(contract) like ?', [like]);
        // Stored as digits only, so what the operator typed has to be reduced
        // the same way: "(93) 98111-0001" and 5593981110001 are one number
        // written twice, and only one of the two spellings is in the column.
        if (digits) match.orWhere('wa_phone_e164', 'like', `%${digits}%`);
        if (searchContracts.length > 0) match.orWhereIn('contract', searchContracts);
      });
    }

    return query
      .orderBy('last_message_at', 'desc')
      .limit(limit)
      .offset(offset);
  }
}

export default WaConversation;
