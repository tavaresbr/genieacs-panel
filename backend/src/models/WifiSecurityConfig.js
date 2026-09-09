import { getDb, tdb, tinsertReturningId } from '../config/database.js';

function withArray(row) {
  if (!row) return null;
  return {
    ...row,
    security_types_array: row.security_types ? row.security_types.split(',') : []
  };
}

/**
 * The per-product-class WiFi parameter path, per provider.
 *
 * `getByProductClass` is what the WiFi write path consults before it falls back
 * to the vendor's own `wifi_password_path`, so a row read from the wrong
 * provider writes a subscriber's password to a path that ISP never approved.
 * The comparison stays `LOWER(...) = LOWER(?)` because a product class is
 * whatever the CPE reported and case is not part of its identity; it is written
 * raw because the three engines disagree about collations, and `tdb` adds the
 * provider as a normal WHERE alongside it.
 */
class WifiSecurityConfig {
  static async getAll() {
    const rows = await tdb('wifi_security_config').orderBy('product_class', 'asc');
    return rows.map(withArray);
  }

  static async getById(id) {
    const row = await tdb('wifi_security_config').where({ id }).first();
    return withArray(row);
  }

  static async getByProductClass(productClass) {
    const row = await tdb('wifi_security_config')
      .whereRaw('LOWER(product_class) = LOWER(?)', [productClass])
      .first();
    return withArray(row);
  }

  static async create(configData) {
    const { product_class, security_types, password_param_path } = configData;
    const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

    const id = await tinsertReturningId('wifi_security_config', {
      product_class,
      security_types: securityTypesString,
      password_param_path
    });
    return id;
  }

  static async update(id, configData) {
    const { product_class, security_types, password_param_path } = configData;
    const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

    const count = await tdb('wifi_security_config').where({ id }).update({
      product_class,
      security_types: securityTypesString,
      password_param_path,
      updated_at: getDb().fn.now()
    });
    return count > 0;
  }

  static async delete(id) {
    const count = await tdb('wifi_security_config').where({ id }).del();
    return count > 0;
  }
}

export default WifiSecurityConfig;
