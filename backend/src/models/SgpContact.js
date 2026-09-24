import { tdb, tinsert } from '../config/database.js';

/**
 * An SGP client the panel knows — see `sgpContactsTable` in
 * `config/migrations.js`. One row per contract; a client with no contract has
 * one row of its own, keyed by its SGP client id (or, lacking one, its
 * document).
 */
class SgpContact {
  static async getById(id) {
    const numeric = Number.parseInt(String(id ?? ''), 10);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    return (await tdb('sgp_contacts').where({ id: numeric }).first()) || null;
  }

  static async getByContract(contract) {
    if (!contract) return null;
    return (await tdb('sgp_contacts').where({ contract: String(contract) }).first()) || null;
  }

  static async getByContracts(contracts) {
    if (!Array.isArray(contracts) || contracts.length === 0) return [];
    return tdb('sgp_contacts').whereIn('contract', contracts.map(String));
  }

  /** The contract-less row of one SGP client, if there is one. */
  static async getClientRow(clientId) {
    if (!clientId) return null;
    return (await tdb('sgp_contacts')
      .whereNull('contract')
      .where({ sgp_client_id: String(clientId) })
      .first()) || null;
  }

  /**
   * Writes what the SGP just answered for one contract, or for one client with
   * no contract.
   *
   * `phone_manual` is deliberately absent, as it is from the `sgp_links` sync:
   * neither a lookup nor a sync may take back the correction an operator typed.
   *
   * @param {object} row a `SgpService.contractToContactRow` result
   * @param {{ seenAt?: Date }} [options] set by the full sync, which is what
   *   `last_seen_at` records; a one-off lookup leaves it alone.
   */
  static async upsertFromSgp(row, { seenAt = null } = {}) {
    const now = new Date();
    const values = {
      contract: row.contract ? String(row.contract) : null,
      sgp_client_id: row.contract ? null : (row.sgp_client_id ? String(row.sgp_client_id) : null),
      document: row.document ?? null,
      client_name: row.client_name ?? null,
      status: row.status ?? null,
      status_label: row.status_label ?? null,
      state: row.state ?? 'unknown',
      phone_e164: row.phone_e164 ?? null,
      client_ref: row.client_ref ?? null,
      plan: row.plan ?? null,
      due_day: row.due_day ?? null,
      status_reason: row.status_reason ?? null,
      login: row.login ?? null,
      address: row.address ?? null,
      contract_created_at: row.contract_created_at ?? null,
      last_synced_at: now,
      updated_at: now,
      ...(seenAt ? { last_seen_at: seenAt } : {})
    };

    if (values.contract) {
      await tinsert('sgp_contacts', values).onConflict(['tenant_id', 'contract']).merge(values);
      return this.getByContract(values.contract);
    }
    if (values.sgp_client_id) {
      await tinsert('sgp_contacts', values).onConflict(['tenant_id', 'sgp_client_id']).merge(values);
      return this.getClientRow(values.sgp_client_id);
    }
    // No contract and no client id: the document is the only handle left, and
    // there is no unique on it, so this one is a read-then-write.
    if (!values.document) return null;
    const existing = await tdb('sgp_contacts')
      .whereNull('contract')
      .whereNull('sgp_client_id')
      .where({ document: values.document })
      .first();
    if (existing) {
      await tdb('sgp_contacts').where({ id: existing.id }).update(values);
      return this.getById(existing.id);
    }
    await tinsert('sgp_contacts', values);
    return tdb('sgp_contacts')
      .whereNull('contract')
      .whereNull('sgp_client_id')
      .where({ document: values.document })
      .first();
  }

  /**
   * Every row of one client: its contracts (by `client_ref`) and its row
   * without a contract (by `sgp_client_id`).
   */
  static async getByClient(clientId) {
    if (!clientId) return [];
    const id = String(clientId);
    return tdb('sgp_contacts')
      .where((query) => query.where({ client_ref: id }).orWhere((inner) => inner.whereNull('contract').where({ sgp_client_id: id })))
      .orderBy('id');
  }

  /** `null` clears the override, like `SgpLink.setManualPhone`. */
  static async setManualPhone(contract, phone) {
    return tdb('sgp_contacts')
      .where({ contract: String(contract) })
      .update({ phone_manual: phone, updated_at: new Date() });
  }

  static async setManualPhoneById(id, phone) {
    return tdb('sgp_contacts')
      .where({ id })
      .update({ phone_manual: phone, updated_at: new Date() });
  }
}

export default SgpContact;
