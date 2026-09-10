import { tdb, tinsert } from '../config/database.js';
import { createSecretBox } from '../utils/secretBox.js';

/**
 * The NBI credential gets its own key context, so a ciphertext written here can
 * never be decrypted as an Evolution token or a subscriber's WiFi password even
 * if a row is copied between columns by hand.
 */
const nbiSecretBox = createSecretBox('genieacs-nbi');

export const MODES = new Set(['direct', 'agent', 'tunnel', 'hosted']);

/** The modes that have a transport behind them today. */
export const IMPLEMENTED_MODES = new Set(['direct', 'tunnel', 'hosted']);

export const AUTH_TYPES = new Set(['none', 'basic', 'bearer']);

/**
 * What every read gets when the provider has no row yet.
 *
 * A provider created before 0029 has one from the backfill, and one created
 * after gets one on its first save — but "no row" still has to be an answer the
 * panel can render rather than a crash, because it is also what a provider
 * looks like between being created and being configured.
 */
export const UNCONFIGURED = Object.freeze({
  id: null,
  mode: 'direct',
  base_url: null,
  auth_type: 'none',
  username: null,
  verify_tls: true,
  allow_private_ranges: false,
  status: 'unknown',
  last_check_at: null,
  last_error: null
});

function toBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  // MySQL hands booleans back as 0/1 and SQLite as 0/1 too; Postgres as real
  // booleans. Reading `verify_tls` as truthy would make the string '0' — which
  // nothing writes today, but a hand-edited row could — read as "verify".
  if (typeof value === 'boolean') return value;
  return Number(value) === 1;
}

class GenieAcsConnection {
  /** The provider's row as stored, or null. */
  static async row() {
    return (await tdb('tenant_genieacs_connections').first()) ?? null;
  }

  /**
   * The provider's connection, normalized, never null.
   *
   * The secret is NOT included: a caller that needs it asks for it by name, so
   * that the object handed to a controller or a log cannot be carrying one.
   */
  static async current() {
    const row = await this.row();
    if (!row) return { ...UNCONFIGURED };
    return {
      id: row.id,
      mode: MODES.has(row.mode) ? row.mode : 'direct',
      base_url: row.base_url || null,
      auth_type: AUTH_TYPES.has(row.auth_type) ? row.auth_type : 'none',
      username: row.username || null,
      verify_tls: toBoolean(row.verify_tls, true),
      allow_private_ranges: toBoolean(row.allow_private_ranges, false),
      status: row.status || 'unknown',
      last_check_at: row.last_check_at ?? null,
      last_error: row.last_error ?? null
    };
  }

  /** The decrypted NBI secret, or '' when there is none. */
  static async secret() {
    const row = await this.row();
    return nbiSecretBox.decrypt({
      password_ciphertext: row?.secret_ciphertext,
      password_iv: row?.secret_iv,
      password_tag: row?.secret_tag,
      password_key_version: row?.secret_key_version
    }) ?? '';
  }

  static encryptSecret(secret) {
    if (!secret) {
      return {
        secret_ciphertext: null,
        secret_iv: null,
        secret_tag: null,
        secret_key_version: null
      };
    }
    const box = nbiSecretBox.encrypt(secret);
    return {
      secret_ciphertext: box.password_ciphertext,
      secret_iv: box.password_iv,
      secret_tag: box.password_tag,
      secret_key_version: box.password_key_version
    };
  }

  /**
   * Writes the fields given and leaves the rest alone.
   *
   * `secret` is its own key rather than a column name because it arrives in
   * plaintext and must never be spread into a row: passing `undefined` keeps
   * the stored one, passing '' or null clears it. That distinction is the whole
   * reason this is not a plain update — a settings screen that posts the form
   * without the password field would otherwise wipe the credential.
   */
  static async save(patch = {}) {
    const { secret, ...fields } = patch;
    const row = { ...fields };
    if (secret !== undefined) Object.assign(row, this.encryptSecret(secret));
    if (Object.keys(row).length === 0) return false;
    row.updated_at = new Date();

    const affected = await tdb('tenant_genieacs_connections').update(row);
    if (affected > 0) return true;

    // No row yet: this is a provider created before the panel had a connection
    // to store, or one whose row the backfill could not reach.
    await tinsert('tenant_genieacs_connections', {
      mode: 'direct',
      auth_type: 'none',
      ...row
    });
    return true;
  }

  /** Records what the last reachability check concluded. */
  static async recordCheck(status, error = null) {
    return this.save({
      status,
      last_check_at: new Date(),
      // Truncated because the column is 255 and because the only thing worth
      // keeping is which failure it was, not a transcript of it.
      last_error: error ? String(error).slice(0, 255) : null
    });
  }
}

export default GenieAcsConnection;
