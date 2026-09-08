import { getDb } from '../config/database.js';

/**
 * "Não perturbe".
 *
 * An opt-out means **the provider does not initiate contact**. It blocks mass
 * dispatch, the billing cadence and any proactive alert to that number. It does
 * NOT block an operator answering someone, or the bot replying to a person who
 * just wrote in — refusing to answer a customer who asked a question would be a
 * worse product, not a more respectful one.
 *
 * Keyed by phone and LID, never by customer id: an opt-out has to survive a
 * record being merged, deleted, or created again. Whoever asked to be left
 * alone asked as a phone number.
 */
class WaOptOut {
  /**
   * Whether this address is currently opted out.
   *
   * Both identities are checked because a contact may be known by only one of
   * them, and the request to stop was made by the person, not by the column.
   */
  static async isActive({ waPhone, waLid } = {}) {
    const phone = String(waPhone || '').trim();
    const lid = String(waLid || '').trim();
    if (!phone && !lid) return false;
    const row = await getDb()('wa_opt_outs')
      .whereNull('revoked_at')
      .where((q) => {
        if (phone) q.orWhere({ wa_phone_e164: phone });
        if (lid) q.orWhere({ wa_lid: lid });
      })
      .first();
    return !!row;
  }

  /** Active opt-outs among a batch of numbers — one query for a whole campaign. */
  static async activePhones(phones) {
    const list = [...new Set((phones || []).map((p) => String(p || '').trim()).filter(Boolean))];
    if (list.length === 0) return new Set();
    const rows = await getDb()('wa_opt_outs')
      .whereNull('revoked_at')
      .whereIn('wa_phone_e164', list)
      .pluck('wa_phone_e164');
    return new Set(rows);
  }

  /**
   * Records an opt-out, unless an active one already exists.
   *
   * The duplicate check lives here rather than in a partial unique index
   * because MySQL has none. A duplicate row would be noise rather than a safety
   * failure — the dangerous direction is a MISSING opt-out — but writing one
   * row per repeated "SAIR" would make the operator's list unreadable.
   */
  static async record({ waPhone, waLid, conversationId, origin = 'customer', reasonText }) {
    if (await this.isActive({ waPhone, waLid })) return null;
    const now = new Date();
    const [id] = await getDb()('wa_opt_outs').insert({
      wa_phone_e164: waPhone || null,
      wa_lid: waLid || null,
      conversation_id: conversationId || null,
      origin,
      reason_text: reasonText ? String(reasonText).slice(0, 500) : null,
      created_at: now
    });
    return (await getDb()('wa_opt_outs').where({ id }).first()) || null;
  }

  static async revoke(id, userId) {
    await getDb()('wa_opt_outs')
      .where({ id })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(), revoked_by: userId || null });
    return (await getDb()('wa_opt_outs').where({ id }).first()) || null;
  }

  static async listActive({ limit = 200 } = {}) {
    return getDb()('wa_opt_outs').whereNull('revoked_at').orderBy('created_at', 'desc').limit(limit);
  }
}

export default WaOptOut;
