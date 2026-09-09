import { getDb, tdb, tinsertReturningId } from '../config/database.js';

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Number(row.enabled) ? 1 : 0,
    manufacturer_patterns: JSON.parse(row.manufacturer_patterns || '[]'),
    product_patterns: JSON.parse(row.product_patterns || '[]')
  };
}

function serialize(vendorData) {
  const {
    name,
    manufacturer_patterns,
    product_patterns,
    parameter_prefix,
    service_list_path,
    lan_binding_path,
    vlan_id_path,
    wifi_password_path,
    http_wan_enable_path,
    firewall_level_path,
    priority = 10,
    enabled = 1,
    description
  } = vendorData;

  return {
    name,
    manufacturer_patterns: JSON.stringify(manufacturer_patterns || []),
    product_patterns: JSON.stringify(product_patterns || []),
    parameter_prefix,
    service_list_path,
    lan_binding_path,
    vlan_id_path,
    wifi_password_path,
    http_wan_enable_path,
    firewall_level_path,
    priority,
    enabled: enabled ? 1 : 0,
    description
  };
}

/**
 * The equipment catalogue, per provider.
 *
 * Every row here is operator-editable through `/api/vendor-management`, so the
 * detection patterns and parameter paths one ISP corrects are that ISP's
 * decision and nobody else's. `update` and `delete` are the reason this model
 * could not stay deployment-wide any longer: both take an id off the URL and
 * nothing else, and `vendors` is the parent of `wifi_security_mappings` with
 * ON DELETE CASCADE — so one operator removing a vendor took another
 * provider's mappings with it. `tdb` supplies the provider half of that WHERE,
 * which turns both into no-ops on a row that belongs to someone else.
 */
class Vendor {
  static async getAll() {
    const rows = await tdb('vendors')
      .orderBy([{ column: 'priority', order: 'desc' }, { column: 'name', order: 'asc' }]);
    return rows.map(parseRow);
  }

  static async getEnabled() {
    const rows = await tdb('vendors')
      .where({ enabled: true })
      .orderBy([{ column: 'priority', order: 'desc' }, { column: 'name', order: 'asc' }]);
    return rows.map(parseRow);
  }

  static async findById(id) {
    const row = await tdb('vendors').where({ id }).first();
    return parseRow(row);
  }

  static async create(vendorData) {
    const id = await tinsertReturningId('vendors', serialize(vendorData));
    return id;
  }

  static async update(id, vendorData) {
    const payload = serialize(vendorData);
    payload.updated_at = getDb().fn.now();
    const affected = await tdb('vendors').where({ id }).update(payload);
    return affected > 0;
  }

  static async delete(id) {
    const affected = await tdb('vendors').where({ id }).del();
    return affected > 0;
  }
}

export default Vendor;
