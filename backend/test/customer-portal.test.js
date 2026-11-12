import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, call, defaultTenantId, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

let portalUrl;
const alice = { customerId: 'CSG-ABCDEFG-234567', password: null, id: null };
const bob = { customerId: 'CSG-HJKLMNP-234568', password: null, id: null };

async function createAccount(account, index) {
  const { password, record } = await CustomerPortalPasswordService.createRecord();
  const id = await insertReturningId('customer_accounts', {
    customer_id: account.customerId,
    device_id: `test-device-${index}`,
    identity_hash: `hash-${index}`.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: `customer-${index}`,
    active: true,
    ...record
  });
  account.id = id;
  account.password = password;
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((cookie) => cookie.startsWith('skygp_portal_session='));
  return session || null;
}

function cookieHeader(setCookie) {
  return setCookie.split(';')[0];
}

before(async () => {
  ({ portalUrl } = await startTestServers());
  await createAccount(alice, 1);
  await createAccount(bob, 2);
});

after(async () => {
  await stopTestServers();
});

describe('portal credentials', () => {
  it('generates a password that is not derived from the Customer ID', () => {
    assert.notEqual(alice.password, alice.customerId.slice(-6));
    assert.equal(alice.password.length, CustomerPortalPasswordService.passwordLength);
    assert.match(alice.password, /^[A-Z0-9]+$/);
    assert.notEqual(alice.password, bob.password);
  });

  it('stores a hash rather than the password itself', async () => {
    const row = await getDb()('customer_accounts').where({ id: alice.id }).first();
    assert.ok(row.password_hash.startsWith('$2'));
    assert.ok(!JSON.stringify(row).includes(alice.password));
  });
});

describe('portal login', () => {
  it('rejects the legacy password derived from the Customer ID', async () => {
    const { status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: alice.customerId.slice(-6) }
    });
    assert.equal(status, 401);
  });

  it('rejects an unknown Customer ID', async () => {
    const { status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'CSG-ZZZZZZZ-999999', password: alice.password }
    });
    assert.equal(status, 401);
  });

  it("rejects another customer's password", async () => {
    const { status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: bob.password }
    });
    assert.equal(status, 401);
  });

  it('accepts the generated password and sets a hardened session cookie', async () => {
    const { status, response, body } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: alice.password }
    });
    assert.equal(status, 200);
    assert.equal(body.data.customerId, alice.customerId);

    const cookie = sessionCookie(response);
    assert.ok(cookie, 'expected a portal session cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });
});

describe('portal session', () => {
  let cookie;

  before(async () => {
    const { response } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: alice.password }
    });
    cookie = cookieHeader(sessionCookie(response));
  });

  it('refuses an unauthenticated request', async () => {
    const { status } = await call(`${portalUrl}/api/customer/session`);
    assert.equal(status, 401);
  });

  it('refuses a forged session cookie', async () => {
    const { status } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: 'skygp_portal_session=not.a.jwt' }
    });
    assert.equal(status, 401);
  });

  it('accepts the issued cookie', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 200);
    assert.equal(body.data.customerId, alice.customerId);
  });

  it('blocks a cross-site mutation even with a valid cookie', async () => {
    const { status } = await call(`${portalUrl}/api/customer/wifi`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' },
      body: { index: 1, ssid: 'attacker' }
    });
    assert.equal(status, 403);
  });

  it('ends the session on logout', async () => {
    const loggedOut = await call(`${portalUrl}/api/customer/logout`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(loggedOut.status, 200);
    assert.match(sessionCookie(loggedOut.response) || '', /skygp_portal_session=;/);
  });
});

describe('operator password reset', () => {
  it('replaces the password so the previous one stops working', async () => {
    const previous = bob.password;
    const next = await asTenant(() => CustomerPortalPasswordService.reset(bob.id));
    assert.notEqual(next, previous);

    const stale = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: bob.customerId, password: previous }
    });
    assert.equal(stale.status, 401);

    const fresh = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: bob.customerId, password: next }
    });
    assert.equal(fresh.status, 200);
    bob.password = next;
  });

  // O operador redefine a senha do portal justamente quando alguém que não
  // devia a tem. Sem isto, quem já estava dentro seguia dentro pelos 30 minutos
  // do cookie: a guarda só relia `active` e `customer_id`.
  it('ends a portal session that was opened with the previous password', async () => {
    const login = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: bob.customerId, password: bob.password }
    });
    assert.equal(login.status, 200);
    const stale = cookieHeader(sessionCookie(login.response));
    const before = await call(`${portalUrl}/api/customer/session`, { headers: { Cookie: stale } });
    assert.equal(before.status, 200);

    // No mesmo segundo do login, de propósito: é o caso que uma comparação de
    // relógio com a resolução do `iat` deixaria passar.
    bob.password = await asTenant(() => CustomerPortalPasswordService.reset(bob.id));

    const after = await call(`${portalUrl}/api/customer/session`, { headers: { Cookie: stale } });
    assert.equal(after.status, 401, 'the session survived the password reset');
    assert.equal(after.body.code, 'customer_session_invalid');

    const relogin = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: bob.customerId, password: bob.password }
    });
    assert.equal(relogin.status, 200);
    const fresh = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: cookieHeader(sessionCookie(relogin.response)) }
    });
    assert.equal(fresh.status, 200);
  });

  it('reveals the stored password to an operator', async () => {
    const row = await getDb()('customer_accounts').where({ id: bob.id }).first();
    assert.equal(CustomerPortalPasswordService.reveal(row), bob.password);
  });
});

describe('portal account lockout and re-authentication', () => {
  const carol = { customerId: 'CSG-QRSTUVW-234569', password: null, id: null };

  before(async () => {
    await createAccount(carol, 3);
  });

  it('locks the account after repeated wrong passwords, even for the right one', async () => {
    // O limitador por endereço fecharia antes da trava numa rajada de um IP só;
    // a trava existe para quem distribui os palpites, então a rajada vem direto
    // do contador por conta.
    const AccountLockout = (await import('../src/models/AccountLockout.js')).default;
    const subject = AccountLockout.forIdentifier(`portal:${await defaultTenantId()}:${carol.customerId}`);
    for (let i = 0; i < 10; i += 1) {
      const tentativa = await AccountLockout.attempt(subject);
      await AccountLockout.failure(tentativa);
    }
    const right = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: carol.customerId, password: carol.password }
    });
    assert.equal(right.status, 429);
    assert.equal(right.body.code, 'account_locked');
  });

  it('is unlocked when the operator resets the portal password', async () => {
    const AccountLockout = (await import('../src/models/AccountLockout.js')).default;
    await AccountLockout.clear(
      AccountLockout.forIdentifier(`portal:${await defaultTenantId()}:${carol.customerId}`)
    );
    const { status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: carol.customerId, password: carol.password }
    });
    assert.equal(status, 200);
  });

  it('refuses to reveal a Wi-Fi password without the portal password', async () => {
    const login = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: alice.password }
    });
    const cookie = cookieHeader(sessionCookie(login.response));
    const wrong = await call(`${portalUrl}/api/customer/wifi/1/password`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { password: 'WRONGPASS1' }
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'reauth_required');
    const old = await call(`${portalUrl}/api/customer/wifi/1/password`, { headers: { Cookie: cookie } });
    assert.ok([404, 405].includes(old.status));
  });

  it('sends no-store on authenticated portal responses', async () => {
    const login = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: alice.password }
    });
    const { response } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: cookieHeader(sessionCookie(login.response)) }
    });
    assert.match(response.headers.get('cache-control') || '', /no-store/);
  });
});

describe('portal logout and password change', () => {
  const dave = { customerId: 'CSG-DAVEDAV-234570', password: null, id: null };
  const login = (account, password = account.password) => call(`${portalUrl}/api/customer/login`, {
    method: 'POST',
    body: { customerId: account.customerId, password }
  });

  before(async () => {
    await createAccount(dave, 4);
  });

  it('a copied cookie stops working after logout', async () => {
    const opened = await login(dave);
    const cookie = cookieHeader(sessionCookie(opened.response));
    assert.equal((await call(`${portalUrl}/api/customer/session`, { headers: { Cookie: cookie } })).status, 200);
    const out = await call(`${portalUrl}/api/customer/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(out.status, 200);
    const replay = await call(`${portalUrl}/api/customer/session`, { headers: { Cookie: cookie } });
    assert.equal(replay.status, 401);
  });

  it('refuses a weak, malformed or unchanged new password and a wrong current one', async () => {
    const cookie = cookieHeader(sessionCookie((await login(dave)).response));
    const send = (body) => call(`${portalUrl}/api/customer/password`, {
      method: 'POST', headers: { Cookie: cookie }, body
    });
    assert.equal((await send({ currentPassword: 'WRONGPASS1', newPassword: 'NOVASENHA2026X' })).status, 401);
    assert.equal((await send({ currentPassword: dave.password, newPassword: 'CURTA1' })).body.code, 'invalid_new_password');
    assert.equal((await send({ currentPassword: dave.password, newPassword: 'ABC-123-456-7' })).body.code, 'invalid_new_password');
    assert.equal((await send({ currentPassword: dave.password, newPassword: 'SENHA12345' })).body.code, 'weak_new_password');
    assert.equal((await send({ currentPassword: dave.password, newPassword: dave.password })).body.code, 'same_password');
  });

  it('changes the password, keeps this session, drops the old one, stores only the hash', async () => {
    const opened = await login(dave);
    const cookie = cookieHeader(sessionCookie(opened.response));
    const other = cookieHeader(sessionCookie((await login(dave)).response));
    const changed = await call(`${portalUrl}/api/customer/password`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { currentPassword: dave.password, newPassword: 'minha7senha8nova' }
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const fresh = cookieHeader(sessionCookie(changed.response));
    assert.equal((await call(`${portalUrl}/api/customer/session`, { headers: { Cookie: fresh } })).status, 200);
    assert.equal((await call(`${portalUrl}/api/customer/session`, { headers: { Cookie: other } })).status, 401);
    assert.equal((await login(dave)).status, 401);
    assert.equal((await login(dave, 'minha7senha8nova')).status, 200);
    const row = await getDb()('customer_accounts').where({ id: dave.id }).first();
    assert.equal(row.password_ciphertext, null);
  });
});
