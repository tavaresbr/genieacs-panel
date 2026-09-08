import 'dotenv/config';
import crypto from 'node:crypto';

/**
 * Authenticated encryption for secrets that an operator must be able to read
 * back (customer WiFi passwords, customer portal passwords, the SGP token).
 * Each context string derives an independent key, so a ciphertext from one
 * feature can never be decrypted as another.
 *
 * Every ciphertext records the key version that produced it. Without that,
 * rotating the base secret turns every stored secret into an unreadable blob
 * and `decrypt` reports it by returning null — a silent, irreversible data
 * loss triggered by an otherwise routine security operation.
 *
 * Version 1 derives from JWT_SECRET and is what every row written before this
 * release used. Version 2 derives from the dedicated SECRET_BOX_KEY. An install
 * that sets SECRET_BOX_KEY writes version 2 and can still read version 1, which
 * is what makes JWT_SECRET rotatable.
 */
export const LEGACY_KEY_VERSION = 1;
export const CURRENT_KEY_VERSION = 2;

const DEVELOPMENT_FALLBACK = 'insecure-development-secret';

function readBaseSecrets() {
  const jwtSecret = process.env.JWT_SECRET;
  const dedicatedKey = process.env.SECRET_BOX_KEY;

  if (!jwtSecret && !dedicatedKey && process.env.APP_ENV === 'production') {
    throw new Error(
      'SECRET_BOX_KEY (or JWT_SECRET) must be set to protect stored customer secrets'
    );
  }

  return { jwtSecret, dedicatedKey };
}

function deriveKey(baseSecret, context) {
  return crypto.createHmac('sha256', baseSecret).update(context).digest();
}

export function createSecretBox(context) {
  const { jwtSecret, dedicatedKey } = readBaseSecrets();

  const keys = new Map();
  keys.set(LEGACY_KEY_VERSION, deriveKey(jwtSecret || DEVELOPMENT_FALLBACK, context));
  if (dedicatedKey) {
    keys.set(CURRENT_KEY_VERSION, deriveKey(dedicatedKey, context));
  }

  const writeVersion = dedicatedKey ? CURRENT_KEY_VERSION : LEGACY_KEY_VERSION;
  const warned = new Set();

  return {
    keyVersion: writeVersion,

    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(writeVersion), iv);
      const ciphertext = Buffer.concat([
        cipher.update(String(plaintext), 'utf8'),
        cipher.final()
      ]);
      return {
        password_ciphertext: ciphertext.toString('base64'),
        password_iv: iv.toString('base64'),
        password_tag: cipher.getAuthTag().toString('base64'),
        password_key_version: writeVersion
      };
    },

    decrypt(row) {
      if (!row?.password_ciphertext || !row?.password_iv || !row?.password_tag) return null;

      // Rows written before key versioning carry no version, and those were all
      // produced by version 1.
      const version = Number(row.password_key_version) || LEGACY_KEY_VERSION;
      const key = keys.get(version);

      if (!key) {
        // Returning null keeps the caller contract, but staying quiet about it
        // is how a misconfigured key looks identical to "no password stored".
        if (!warned.has(version)) {
          warned.add(version);
          console.warn(
            `Cannot decrypt ${context}: stored data uses key version ${version}, `
            + 'which this process has no key for. Check SECRET_BOX_KEY and JWT_SECRET.'
          );
        }
        return null;
      }

      try {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(row.password_iv, 'base64')
        );
        decipher.setAuthTag(Buffer.from(row.password_tag, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(row.password_ciphertext, 'base64')),
          decipher.final()
        ]).toString('utf8');
      } catch {
        return null;
      }
    }
  };
}
