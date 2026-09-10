import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {
  authHeaders,
  call,
  getDb,
  insertReturningId,
  runInTenant,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

const { tdb, tinsertReturningId } = await import('../src/config/database.js');
const { migrations } = await import('../src/config/migrations.js');
const { default: AuditLog, AUDIT_ACTIONS, sanitizeMetadata } = await import(
  '../src/models/AuditLog.js'
);
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { default: CustomerWifiCredentialService } = await import(
  '../src/services/customerWifiCredentialService.js'
);

/**
 * The sensitive-action log, and the two things it has to get right.
 *
 * The first is the one every `*-tenancy` suite asserts: a line belongs to one
 * provider and no other provider can see it. The second is particular to this
 * table — a line has to say that a secret was handed out WITHOUT being a second
 * copy of the secret, and writing it must never be able to turn the action it
 * describes into a failure.
 *
 * Both providers hold an account under the SAME Customer ID, as the rest of the
 * tenancy suites do, so nothing here can pass by having found the only row.
 */
let panelUrl;
let portalUrl;
let alfa;
let beta;
let ownerToken;
let ownerId;

const CUSTOMER_ID = 'CSG-AUDIT01-234567';
const ALFA_DEVICE = 'ont-audit-alfa';
const BETA_DEVICE = 'ont-audit-beta';
const WIFI_PASSWORD = 'senha-wifi-alfa-1';

const account = { alfa: null, beta: null };

/** Every line the table holds, provider column and all. */
const allLines = () => getDb()('audit_log').orderBy('id', 'asc');

const linesFor = (action) => getDb()('audit_log').where({ action }).orderBy('id', 'asc');

async function createAccount(tenantId, deviceId, suffix) {
  const { password, record } = await CustomerPortalPasswordService.createRecord();
  const id = await runInTenant(tenantId, () => tinsertReturningId('customer_accounts', {
    customer_id: CUSTOMER_ID,
    device_id: deviceId,
    identity_hash: `audit-${suffix}`.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: `cliente-${suffix}@provedor`,
    active: true,
    ...record
  }));
  return { id, portalPassword: password };
}

function sessionCookie(response) {
  const cookie = response.headers.getSetCookie()
    .find((entry) => entry.startsWith('skygp_portal_session='));
  return cookie ? cookie.split(';')[0] : null;
}

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'owner', password: 'owner-password-1' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  account.alfa = await createAccount(alfa, ALFA_DEVICE, 'alfa');
  account.beta = await createAccount(beta, BETA_DEVICE, 'beta');

  await runInTenant(alfa, () => CustomerWifiCredentialService.save(
    account.alfa.id, 1, 'Rede-Alfa', WIFI_PASSWORD
  ));
});

after(async () => {
  await stopTestServers();
});

describe('what a reveal leaves behind', () => {
  let revealed;

  it('records the reveal against the provider whose subscriber it was', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/devices/${ALFA_DEVICE}/portal-password`,
      { headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 200);
    revealed = body.data.password;
    assert.ok(revealed, 'the operator did get the password');

    const lines = await linesFor(AUDIT_ACTIONS.PORTAL_PASSWORD_REVEALED);
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.equal(Number(line.tenant_id), Number(alfa));
    assert.equal(line.actor_type, 'operator');
    assert.equal(Number(line.actor_user_id), Number(ownerId));
    assert.equal(line.actor_label, 'owner', 'the name, so the line still reads without a join');
    assert.equal(line.target_type, 'customer_account');
    assert.equal(line.target_id, CUSTOMER_ID);
    assert.ok(line.ip, 'where it was read from is most of the value of a reveal line');
    assert.deepEqual(JSON.parse(line.metadata), { deviceId: ALFA_DEVICE });
    assert.ok(line.created_at, 'and when');
  });

  // The rule the table exists to respect: recording that a password was handed
  // out must not hand it out a second time, into a table nobody encrypted.
  it('does not contain the password it says was revealed', async () => {
    const [line] = await linesFor(AUDIT_ACTIONS.PORTAL_PASSWORD_REVEALED);
    assert.ok(revealed);
    assert.ok(!JSON.stringify(line).includes(revealed), 'the secret is in the row');
  });

  it('records the reset the same way, and without the new password either', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/devices/${ALFA_DEVICE}/portal-password/reset`,
      { method: 'POST', headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 200);
    const issued = body.data.password;
    // The reset really did replace it, so the portal login below has to use
    // what this handed out.
    account.alfa.portalPassword = issued;

    const lines = await linesFor(AUDIT_ACTIONS.PORTAL_PASSWORD_RESET);
    assert.equal(lines.length, 1);
    assert.equal(Number(lines[0].tenant_id), Number(alfa));
    assert.equal(lines[0].target_id, CUSTOMER_ID);
    assert.ok(!JSON.stringify(lines[0]).includes(issued));
  });

  // The portal's own reveal: the actor is a subscriber, not a member of staff,
  // and `actor_user_id` is a foreign key into `users` that must stay empty
  // rather than borrow an operator's id to look complete.
  it('records the subscriber reading their own WiFi key, as a subscriber', async () => {
    const login = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, password: account.alfa.portalPassword }
    });
    assert.equal(login.status, 200);
    const cookie = sessionCookie(login.response);

    const { status, body } = await call(`${portalUrl}/api/customer/wifi/1/password`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.password, WIFI_PASSWORD);

    const lines = await linesFor(AUDIT_ACTIONS.WIFI_PASSWORD_REVEALED);
    assert.equal(lines.length, 1);
    assert.equal(Number(lines[0].tenant_id), Number(alfa));
    assert.equal(lines[0].actor_type, 'subscriber');
    assert.equal(lines[0].actor_user_id, null);
    assert.equal(lines[0].actor_label, CUSTOMER_ID);
    assert.ok(!JSON.stringify(lines[0]).includes(WIFI_PASSWORD));
  });
});

describe('the team, and the lines that outlive it', () => {
  let helenaId;

  it('records who was hired here', async () => {
    const created = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(ownerToken),
      body: { username: 'helena', password: 'helena-password-1', role: 'viewer' }
    });
    assert.equal(created.status, 201);
    helenaId = created.body.data.user.id;

    const [line] = await linesFor(AUDIT_ACTIONS.OPERATOR_ADDED);
    assert.equal(Number(line.tenant_id), Number(alfa));
    assert.equal(line.target_id, 'helena');
    assert.deepEqual(JSON.parse(line.metadata), { role: 'viewer' });
  });

  // The role column is overwritten by the change, so the line is the only place
  // the previous role survives at all.
  it('records both ends of a role change', async () => {
    const { status } = await call(`${panelUrl}/api/users/${helenaId}`, {
      method: 'PATCH',
      headers: authHeaders(ownerToken),
      body: { role: 'admin' }
    });
    assert.equal(status, 200);

    const [line] = await linesFor(AUDIT_ACTIONS.OPERATOR_ROLE_CHANGED);
    assert.equal(Number(line.tenant_id), Number(alfa));
    assert.equal(line.target_id, 'helena');
    assert.deepEqual(JSON.parse(line.metadata), { from: 'viewer', to: 'admin' });
  });

  it('records a password set on somebody else, without the password', async () => {
    const { status } = await call(`${panelUrl}/api/users/${helenaId}`, {
      method: 'PATCH',
      headers: authHeaders(ownerToken),
      body: { password: 'chosen-by-the-admin-9' }
    });
    assert.equal(status, 200);

    const [line] = await linesFor(AUDIT_ACTIONS.OPERATOR_PASSWORD_SET);
    assert.equal(line.target_id, 'helena');
    assert.ok(!JSON.stringify(line).includes('chosen-by-the-admin-9'));
  });

  it('records the end of a membership after the membership is gone', async () => {
    const { status } = await call(`${panelUrl}/api/users/${helenaId}`, {
      method: 'DELETE',
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 200);
    assert.equal(
      await getDb()('tenant_users').where({ tenant_id: alfa, user_id: helenaId }).first(),
      undefined
    );

    const [line] = await linesFor(AUDIT_ACTIONS.OPERATOR_REMOVED);
    assert.equal(Number(line.tenant_id), Number(alfa));
    assert.equal(line.target_id, 'helena', 'the name, since the membership no longer holds it');
    assert.deepEqual(JSON.parse(line.metadata), { role: 'admin' });
  });

  /**
   * The question the foreign keys answer, and the reason `actor_user_id` is ON
   * DELETE SET NULL rather than the CASCADE every other reference to `users`
   * would suggest: deleting a person must not delete the record of what that
   * person did, or the one action most worth auditing is the one that erases
   * its own evidence.
   */
  it('keeps the line, and the name on it, after the actor is deleted', async () => {
    // A line helena wrote herself, before she is deleted as a person. Ending
    // her membership above left the person standing, which is why the panel's
    // own removal is not the case this has to survive.
    await runInTenant(alfa, () => AuditLog.record({
      action: AUDIT_ACTIONS.PORTAL_PASSWORD_REVEALED,
      actorType: 'operator',
      actorUserId: helenaId,
      actorLabel: 'helena',
      targetType: 'customer_account',
      targetId: CUSTOMER_ID
    }));
    const planted = await getDb()('audit_log').where({ actor_label: 'helena' }).first();
    assert.equal(Number(planted.actor_user_id), Number(helenaId));

    await getDb()('users').where({ id: helenaId }).del();

    const survivor = await getDb()('audit_log').where({ id: planted.id }).first();
    assert.ok(survivor, 'the line was deleted along with the person who wrote it');
    assert.equal(survivor.actor_user_id, null, 'the key was set null, as designed');
    assert.equal(survivor.actor_label, 'helena', 'and the line still says who did it');
    assert.equal(Number(survivor.tenant_id), Number(alfa));
  });
});

describe('two providers writing to one log', () => {
  before(async () => {
    // Beta's own line, written the way the panel writes them. Beta has no
    // session in this suite — every request here resolves to alfa — so its line
    // is planted through the model, in beta's scope.
    await runInTenant(beta, () => AuditLog.record({
      action: AUDIT_ACTIONS.PORTAL_PASSWORD_REVEALED,
      actorType: 'operator',
      actorLabel: 'bruno',
      targetType: 'customer_account',
      targetId: CUSTOMER_ID,
      ip: '203.0.113.9'
    }));
  });

  it('files every line under the provider that wrote it', async () => {
    const lines = await allLines();
    const byTenant = new Map();
    for (const line of lines) {
      const key = Number(line.tenant_id);
      byTenant.set(key, (byTenant.get(key) || 0) + 1);
    }
    assert.equal(byTenant.get(Number(beta)), 1);
    assert.ok(byTenant.get(Number(alfa)) > 1);
  });

  // The assertion every `*-tenancy` suite makes, and the one that matters most
  // here: a log is read by whoever is allowed to read logs, and one provider's
  // lines name the other's staff, subscribers and support rhythm.
  it('shows one provider nothing of the other', async () => {
    const mine = await runInTenant(alfa, () => tdb('audit_log').select('actor_label'));
    assert.ok(mine.length > 1);
    assert.ok(!mine.some((line) => line.actor_label === 'bruno'), "alfa can read beta's log");

    const theirs = await runInTenant(beta, () => tdb('audit_log').select('actor_label', 'ip'));
    assert.deepEqual(theirs.map((line) => line.actor_label), ['bruno']);
    assert.equal(theirs[0].ip, '203.0.113.9');
  });

  it('will not let one provider erase the other\'s lines', async () => {
    const removed = await runInTenant(alfa, () => tdb('audit_log')
      .where({ actor_label: 'bruno' })
      .del());
    assert.equal(removed, 0);
    assert.equal(
      (await getDb()('audit_log').where({ tenant_id: beta }).select('id')).length,
      1
    );
  });
});

describe('the integrations whose credentials reach outside the panel', () => {
  it('records an SGP credential change as a fact, never as the credential', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(ownerToken),
      body: {
        enabled: true,
        baseUrl: 'https://erp.example.com',
        app: 'skygenpanel',
        token: 'token-do-erp-secretissimo'
      }
    });
    assert.equal(status, 200);

    const [line] = await linesFor(AUDIT_ACTIONS.SGP_CONFIG_CHANGED);
    assert.equal(Number(line.tenant_id), Number(alfa));
    assert.equal(line.target_id, 'sgp');
    assert.deepEqual(JSON.parse(line.metadata), {
      enabled: true,
      tokenChanged: true,
      baseUrlChanged: true
    });
    assert.ok(!JSON.stringify(line).includes('token-do-erp-secretissimo'));
  });

  it('records the webhook secret rotation without the new secret', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/events/secret/rotate`, {
      method: 'POST',
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 200);

    const [line] = await linesFor(AUDIT_ACTIONS.SGP_WEBHOOK_SECRET_ROTATED);
    assert.equal(Number(line.tenant_id), Number(alfa));
    assert.ok(!JSON.stringify(line).includes(body.data.secret));
  });

  it('records where the fleet is managed from being repointed', async () => {
    const { status } = await call(`${panelUrl}/api/settings/genieAcsUrl`, {
      method: 'PUT',
      headers: authHeaders(ownerToken),
      body: { value: 'http://acs.novo.example:7557' }
    });
    assert.equal(status, 200);

    // The address IS the line here, unlike the SGP base URL, which is withheld
    // because it is where a token gets sent. The GenieACS credential is a
    // column of its own, so what a reader needs is which server the provider's
    // ONTs are now being managed from.
    const [line] = await linesFor(AUDIT_ACTIONS.GENIEACS_CONFIG_CHANGED);
    assert.equal(Number(line.tenant_id), Number(alfa));
    assert.equal(line.target_id, 'genieacs');
    assert.equal(JSON.parse(line.metadata).baseUrl, 'http://acs.novo.example:7557');
  });

  it('records a WhatsApp credential change the same way', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(ownerToken),
      body: { enabled: false, managedAdminKey: 'chave-admin-da-evolution' }
    });
    assert.equal(status, 200);

    const [line] = await linesFor(AUDIT_ACTIONS.WHATSAPP_CONFIG_CHANGED);
    assert.equal(Number(line.tenant_id), Number(alfa));
    assert.equal(JSON.parse(line.metadata).adminKeyChanged, true);
    assert.ok(!JSON.stringify(line).includes('chave-admin-da-evolution'));
  });
});

/**
 * The filter on the field that would otherwise become the panel's second copy
 * of everything: one well-meant spread of a request body and the log holds
 * documents, phone numbers and secrets, unencrypted and unretained.
 */
describe('what may go in the payload', () => {
  it('drops anything whose name sounds like a secret', () => {
    const stored = JSON.parse(sanitizeMetadata({
      deviceId: 'ont-1',
      password: 'senha-do-assinante',
      token: 'abc',
      webhookSecret: 'shhh',
      password_hash: '$2b$12$x'
    }));
    assert.deepEqual(stored, { deviceId: 'ont-1' });
  });

  // The exception that is not a loophole: a boolean has two values and the
  // reader knows both, so `tokenChanged` records the fact without the value.
  it('keeps a boolean under such a name, because a boolean cannot be a secret', () => {
    assert.deepEqual(
      JSON.parse(sanitizeMetadata({ tokenChanged: true, token: 'abc' })),
      { tokenChanged: true }
    );
  });

  it('drops nesting, which is the shape a whole request body arrives in', () => {
    assert.equal(sanitizeMetadata({ body: { cpf: '000.000.000-00' } }), null);
    assert.equal(sanitizeMetadata({ list: ['a', 'b'] }), null);
  });

  it('caps a long string and answers null for nothing at all', () => {
    const long = JSON.parse(sanitizeMetadata({ note: 'x'.repeat(500) }));
    assert.equal(long.note.length, 120);
    assert.equal(sanitizeMetadata(null), null);
    assert.equal(sanitizeMetadata({}), null, 'null rather than an empty object');
  });
});

/**
 * The last rule, and the one with a cost worth stating out loud: a log write
 * that fails must not turn a successful action into a failure. The operator's
 * reveal already happened — the password is on its way to them — and answering
 * 500 would invite them to do it again, which is a second reveal caused by the
 * logging of the first.
 */
describe('a log the database refuses', () => {
  const step = migrations.find((migration) => migration.id === '0030_audit_log');

  before(async () => {
    await getDb().schema.dropTable('audit_log');
  });

  after(async () => {
    await step.up(getDb());
    assert.ok(await getDb().schema.hasTable('audit_log'));
  });

  it('still hands the operator the password they asked for', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/devices/${ALFA_DEVICE}/portal-password`,
      { headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 200, 'a failed audit write became the caller\'s problem');
    assert.ok(body.data.password);
  });

  it('still ends a membership', async () => {
    const personId = await insertReturningId('users', {
      username: 'ines',
      password: bcrypt.hashSync('ines-password-1', 4),
      role: 'user'
    });
    await getDb()('tenant_users').insert({ tenant_id: alfa, user_id: personId, role: 'viewer' });

    const { status } = await call(`${panelUrl}/api/users/${personId}`, {
      method: 'DELETE',
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 200);
    assert.equal(
      await getDb()('tenant_users').where({ tenant_id: alfa, user_id: personId }).first(),
      undefined,
      'the membership is over even though nothing could be written about it'
    );
  });
});
