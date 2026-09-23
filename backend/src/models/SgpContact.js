import { tdb, tinsert } from '../config/database.js';

/**
 * An SGP subscriber the panel knows without an ONT — see `sgpContactsTable` in
 * `config/migrations.js`. One row per contract, per provider.
 */
class SgpContact {
  static async getByContract(contract) {
    if (!contract) return null;
    return (await tdb('sgp_contacts').where({ contract: String(contract) }).first()) || null;
  }

  static async getByContracts(contracts) {
    if (!Array.isArray(contracts) || contracts.length === 0) return [];
    return tdb('sgp_contacts').whereIn('contract', contracts.map(String));
  }

  /**
   * Writes what the SGP just answered for one contract.
   *
   * `phone_manual` is deliberately absent, as it is from the `sgp_links` sync:
   * a lookup must never take back the correction an operator typed.
   */
  static async upsertFromSgp(row) {
    const now = new Date();
    const values = {
      contract: String(row.contract),
      document: row.document ?? null,
      client_name: row.client_name ?? null,
      status: row.status ?? null,
      status_label: row.status_label ?? null,
      state: row.state ?? 'unknown',
      phone_e164: row.phone_e164 ?? null,
      last_synced_at: now,
      updated_at: now
    };
    await tinsert('sgp_contacts', values)
      .onConflict(['tenant_id', 'contract'])
      .merge(values);
    return this.getByContract(values.contract);
  }

  /** `null` clears the override, like `SgpLink.setManualPhone`. */
  static async setManualPhone(contract, phone) {
    return tdb('sgp_contacts')
      .where({ contract: String(contract) })
      .update({ phone_manual: phone, updated_at: new Date() });
  }
}

export default SgpContact;
