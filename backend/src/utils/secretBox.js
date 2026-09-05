import 'dotenv/config';
import crypto from 'node:crypto';

/**
 * Authenticated encryption for secrets that an operator must be able to read
 * back (customer WiFi passwords, customer portal passwords). Each context
 * string derives an independent key from JWT_SECRET, so a ciphertext from one
 * feature can never be decrypted as another.
 */
export function createSecretBox(context) {
  const baseSecret = process.env.JWT_SECRET;
  if (!baseSecret && process.env.APP_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to protect stored customer secrets');
  }
  const key = crypto
    .createHmac('sha256', baseSecret || 'insecure-development-secret')
    .update(context)
    .digest();

  return {
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(String(plaintext), 'utf8'),
        cipher.final()
      ]);
      return {
        password_ciphertext: ciphertext.toString('base64'),
        password_iv: iv.toString('base64'),
        password_tag: cipher.getAuthTag().toString('base64')
      };
    },

    decrypt(row) {
      if (!row?.password_ciphertext || !row?.password_iv || !row?.password_tag) return null;
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
