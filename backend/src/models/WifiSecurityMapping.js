import { getDb, tdb, tinsertReturningId } from '../config/database.js';

/**
 * How one provider reads the raw security value its equipment reports.
 *
 * The rows hang off `vendors` with ON DELETE CASCADE, which is why they had to
 * become per-provider in the same step as their parent: a foreign key that can
 * reach across providers turns one operator's vendor delete into another's
 * missing mappings. `update` and `delete` take a bare id off the URL, so the
 * provider filter is the only thing standing between them and someone else's
 * row.
 *
 * `getByVendor` filters on `vendor_id` AND on the provider rather than trusting
 * the parent: the id arrives from the request, and a vendor id that belongs to
 * another provider has to come back empty instead of returning its mappings.
 */
class WifiSecurityMapping {
  static async getByVendor(vendorId) {
    return tdb('wifi_security_mappings')
      .where({ vendor_id: vendorId })
      .orderBy('raw_security_value', 'asc');
  }

  static async create({ vendor_id, raw_security_value, normalized_security, description }) {
    const id = await tinsertReturningId('wifi_security_mappings', {
      vendor_id,
      raw_security_value,
      normalized_security,
      description
    });
    return id;
  }

  static async update(id, { raw_security_value, normalized_security, description }) {
    const count = await tdb('wifi_security_mappings')
      .where({ id })
      .update({
        raw_security_value,
        normalized_security,
        description,
        updated_at: getDb().fn.now()
      });
    return count > 0;
  }

  static async delete(id) {
    const count = await tdb('wifi_security_mappings').where({ id }).del();
    return count > 0;
  }
}

export default WifiSecurityMapping;
