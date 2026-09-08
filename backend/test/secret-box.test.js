import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_KEY_VERSION, LEGACY_KEY_VERSION, createSecretBox } from '../src/utils/secretBox.js';

const CONTEXT = 'skygenpanel-test-secret-v1';
const ORIGINAL_JWT = 'jwt-secret-original-long-enough-for-production-rules';
const ROTATED_JWT = 'jwt-secret-rotated-long-enough-for-production-rules';
const BOX_KEY = 'dedicated-secret-box-key-long-enough-for-production';

let saved;

beforeEach(() => {
  saved = { jwt: process.env.JWT_SECRET, box: process.env.SECRET_BOX_KEY };
  process.env.JWT_SECRET = ORIGINAL_JWT;
  delete process.env.SECRET_BOX_KEY;
});

afterEach(() => {
  if (saved.jwt === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = saved.jwt;
  if (saved.box === undefined) delete process.env.SECRET_BOX_KEY;
  else process.env.SECRET_BOX_KEY = saved.box;
});

describe('secret box key versions', () => {
  it('writes version 1 when only JWT_SECRET is configured', () => {
    const box = createSecretBox(CONTEXT);
    const stored = box.encrypt('portal-password');

    assert.equal(stored.password_key_version, LEGACY_KEY_VERSION);
    assert.equal(box.decrypt(stored), 'portal-password');
  });

  it('writes version 2 once SECRET_BOX_KEY is configured', () => {
    process.env.SECRET_BOX_KEY = BOX_KEY;
    const box = createSecretBox(CONTEXT);
    const stored = box.encrypt('portal-password');

    assert.equal(stored.password_key_version, CURRENT_KEY_VERSION);
    assert.equal(box.decrypt(stored), 'portal-password');
  });

  it('still reads rows written before SECRET_BOX_KEY existed', () => {
    const legacy = createSecretBox(CONTEXT).encrypt('written-under-jwt-secret');

    process.env.SECRET_BOX_KEY = BOX_KEY;
    assert.equal(createSecretBox(CONTEXT).decrypt(legacy), 'written-under-jwt-secret');
  });

  it('treats a row with no recorded version as version 1', () => {
    const stored = createSecretBox(CONTEXT).encrypt('legacy-row');
    delete stored.password_key_version;

    assert.equal(createSecretBox(CONTEXT).decrypt(stored), 'legacy-row');
  });

  // The point of the whole change: rotating JWT_SECRET is an ordinary security
  // operation and it used to destroy every stored secret without a word.
  it('survives a JWT_SECRET rotation for anything written under the dedicated key', () => {
    process.env.SECRET_BOX_KEY = BOX_KEY;
    const stored = createSecretBox(CONTEXT).encrypt('survives-rotation');

    process.env.JWT_SECRET = ROTATED_JWT;
    assert.equal(createSecretBox(CONTEXT).decrypt(stored), 'survives-rotation');
  });

  it('loses version 1 rows on a JWT_SECRET rotation, which is why version 2 exists', () => {
    const legacy = createSecretBox(CONTEXT).encrypt('keyed-to-jwt-secret');

    process.env.JWT_SECRET = ROTATED_JWT;
    process.env.SECRET_BOX_KEY = BOX_KEY;
    assert.equal(createSecretBox(CONTEXT).decrypt(legacy), null);
  });

  it('returns null rather than throwing when the recorded version has no key', () => {
    const stored = createSecretBox(CONTEXT).encrypt('unreadable');
    stored.password_key_version = 99;

    assert.equal(createSecretBox(CONTEXT).decrypt(stored), null);
  });

  it('keeps contexts isolated from one another', () => {
    const stored = createSecretBox('context-a').encrypt('secret');
    assert.equal(createSecretBox('context-b').decrypt(stored), null);
  });

  it('returns null for an incomplete row', () => {
    const box = createSecretBox(CONTEXT);
    assert.equal(box.decrypt(null), null);
    assert.equal(box.decrypt({ password_ciphertext: 'x' }), null);
  });
});
