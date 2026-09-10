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

const { SCHEMA_TABLES } = await import('../src/config/migrations.js');
const { SCOPED_TABLES, SHARED_TABLES } = await import('../src/config/tenantScope.js');
const { cursorColumnOf, exportTables, exportTenant } = await import(
  '../src/services/tenantExportService.js'
);
const { default: CustomerWifiCredentialService } = await import(
  '../src/services/customerWifiCredentialService.js'
);
const { default: GenieAcsConnection } = await import('../src/models/GenieAcsConnection.js');
const { default: AuditLog, AUDIT_ACTIONS } = await import('../src/models/AuditLog.js');

/**
 * The export of one provider, proved to be of ONE provider.
 *
 * Two ISPs on one deployment, with the natural keys deliberately identical —
 * same `customer_id`, same `device_id`, same `identity_hash`, same
 * `dedupe_key`, same profile name, same `map_settings` row 1 — because those
 * are the values that collide in the field and the ones a filter written on the
 * wrong column would hand over. Every row of every provider-owned table is
 * planted on both sides, so a table whose export forgot its provider has a row
 * waiting to prove it.
 *
 * The assertions come in four kinds, and each is here because the others cannot
 * see what it sees:
 *
 *  - Nothing of beta's comes out, checked both as a property of every row (the
 *    provider column) and as a substring of the file (beta's markers).
 *  - Every scoped table is walked, checked against `SCOPED_TABLES` rather than
 *    a list written here — a list written here would go stale the same way the
 *    hand-written copy list did, and the table added next quarter would fall
 *    out of every provider's export in silence.
 *  - Secrets leave as they were stored and never as plaintext.
 *  - Only an administrator of this provider can ask.
 */
let panelUrl;
let alfa;
let beta;
let ownerToken;
let carolToken;
let carolId;
let brunoId;
let planted;

const CAROL = { username: 'carol', password: 'carol-password-1' };

// Identical on both sides, on purpose. See the block above.
const CUSTOMER_ID = 'CSG-2026-000042';
const DEVICE_ID = 'ONT-COLLIDE-0001';
const IDENTITY_HASH = 'c0ffee'.repeat(10).slice(0, 64);
const CONTRACT = '55501';
const DEDUPE_KEY = 'sgp:evento:12345';
const PROFILE_NAME = 'Plano 500 Mega';
const PROBE_SETTING_KEY = 'exportProbe';

/** The marker a provider's rows carry, in a column no unique constraint touches. */
const markOf = (name) => `EXPORT-MARK-${name.toUpperCase()}`;

/** The WiFi password each provider stores for its own subscriber. */
const wifiPasswordOf = (name) => `wifi-secret-${name}-9911`;

/** The NBI credential each provider reaches its own GenieACS with. */
const nbiSecretOf = (name) => `nbi-secret-${name}-4417`;

/** MySQL's TIMESTAMP keeps whole seconds, so seeded times carry none. */
function wholeSecond(date = new Date()) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * One row in every provider-owned table, for one provider.
 *
 * Written out rather than generated from the schema: a generated row would have
 * to guess at the foreign keys and the NOT NULLs, and the guess failing would
 * look exactly like the export failing. Insertion order is `SCHEMA_TABLES`
 * order for the same reason the export uses it — the foreign keys require it.
 */
async function plant(tenantId, name) {
  const db = getDb();
  const mark = markOf(name);
  const at = wholeSecond();

  const vendorId = await insertReturningId('vendors', {
    tenant_id: tenantId, name: 'ZTE', description: mark, priority: 10, enabled: true
  });
  await db('wifi_security_mappings').insert({
    tenant_id: tenantId,
    vendor_id: vendorId,
    raw_security_value: 'WPA2',
    normalized_security: '11i',
    description: mark
  });
  await db('wifi_security_config').insert({
    tenant_id: tenantId,
    product_class: 'F670L',
    security_types: 'WPA2',
    password_param_path: mark
  });

  for (const suffix of ['OLT-01', 'ODP-07']) {
    await db('mapping_nodes').insert({
      tenant_id: tenantId,
      node_id: suffix,
      type: suffix.slice(0, 3),
      name: `Ponto ${suffix}`,
      latitude: -23.5,
      longitude: -46.6,
      notes: mark
    });
  }
  await db('mapping_edges').insert({
    tenant_id: tenantId,
    edge_id: 'E-01',
    source: 'OLT-01',
    target: 'ODP-07',
    fiber_type: 'drop',
    notes: mark
  });

  // Row 1 exists for every provider since 0025, and the installation's own
  // provider already has it from the seed. Both providers keeping an `id: 1` is
  // the collision worth planting, so this writes rather than inserts.
  const mapRow = {
    center_lat: '-23.5',
    center_lng: '-46.6',
    max_zoom_in: '18',
    max_zoom_out: '5',
    default_zoom: '13'
  };
  const existingMap = await db('map_settings').where({ tenant_id: tenantId, id: 1 }).first();
  if (existingMap) {
    await db('map_settings').where({ tenant_id: tenantId, id: 1 }).update(mapRow);
  } else {
    await db('map_settings').insert({ tenant_id: tenantId, id: 1, ...mapRow });
  }

  const accountId = await insertReturningId('customer_accounts', {
    tenant_id: tenantId,
    customer_id: CUSTOMER_ID,
    device_id: DEVICE_ID,
    identity_hash: IDENTITY_HASH,
    software_id: 'V3.2.1-BUILD9',
    pppoe_username: `joao.silva.${name}`,
    active: true,
    // Not a ciphertext and not reversible, but still a credential, and still
    // one provider's and not the other's.
    password_hash: bcrypt.hashSync(`portal-${name}`, 4)
  });
  await db('device_profiles').insert({
    tenant_id: tenantId,
    device_id: DEVICE_ID,
    installation_date: '2026-01-15',
    // Ends in `_tag` and is nobody's authentication tag. The export must not
    // call this a secret.
    installation_tag: mark
  });
  await db('sgp_links').insert({
    tenant_id: tenantId,
    device_id: DEVICE_ID,
    account_id: accountId,
    contract: CONTRACT,
    document: '12345678901',
    client_name: `Joao Silva ${mark}`,
    state: 'active',
    link_mode: 'auto'
  });

  const profileId = await insertReturningId('provisioning_profiles', {
    tenant_id: tenantId, name: PROFILE_NAME, priority: 10, enabled: true, wan_name: mark
  });
  await db('provisioning_runs').insert({
    tenant_id: tenantId,
    device_id: DEVICE_ID,
    contract: CONTRACT,
    profile_id: profileId,
    profile_name: PROFILE_NAME,
    trigger: 'poller',
    status: 'done',
    error: mark
  });
  await db('sgp_events').insert({
    tenant_id: tenantId,
    dedupe_key: DEDUPE_KEY,
    source: 'webhook',
    type: 'unblock',
    contract: CONTRACT,
    document: '12345678901',
    device_id: DEVICE_ID,
    status: 'done',
    payload: mark
  });

  const waAccountId = await insertReturningId('whatsapp_accounts', {
    tenant_id: tenantId,
    // The one natural key that stays globally unique on purpose: the Evolution
    // webhook arrives with no session and finds the provider by this name.
    name: `skygp_suporte_${name}`,
    base_url: 'https://evo.example',
    purpose: 'support',
    flavor: 'v2',
    status: 'connected',
    last_error: mark
  });
  const conversationId = await insertReturningId('wa_conversations', {
    tenant_id: tenantId,
    account_id: waAccountId,
    wa_phone_e164: '+5511999990000',
    external_thread_id: '5511999990000@s.whatsapp.net',
    push_name: mark,
    device_id: DEVICE_ID,
    contract: CONTRACT
  });
  const messageId = await insertReturningId('wa_messages', {
    tenant_id: tenantId,
    conversation_id: conversationId,
    direction: 'in',
    external_id: 'WAMID.COLLIDE.0001',
    body: mark,
    source: 'operator'
  });
  await db('wa_opt_outs').insert({
    tenant_id: tenantId,
    wa_phone_e164: '+5511999990000',
    conversation_id: conversationId,
    origin: 'customer',
    reason_text: mark
  });

  const templateId = await insertReturningId('wa_templates', {
    tenant_id: tenantId, name: 'cobranca-d0', body: mark, category: 'cobranca', active: true
  });
  const broadcastId = await insertReturningId('wa_broadcasts', {
    tenant_id: tenantId,
    title: 'Campanha',
    template_id: templateId,
    body: mark,
    account_id: waAccountId,
    status: 'draft'
  });
  await db('wa_broadcast_recipients').insert({
    tenant_id: tenantId,
    broadcast_id: broadcastId,
    phone_e164: '+5511999990000',
    contract: CONTRACT,
    client_name: mark,
    rendered_body: mark,
    message_id: messageId,
    status: 'pending'
  });
  await db('wa_alert_state').insert({
    tenant_id: tenantId, rule: 'ont_offline', subject: DEVICE_ID, state: mark.slice(0, 16)
  });

  await db('settings').insert({ tenant_id: tenantId, key: PROBE_SETTING_KEY, value: mark });
  await db('app_state').insert({
    tenant_id: tenantId,
    key: 'sgp_integration_config',
    // The shape the SGP token is really stored in: a secret box nested inside
    // the JSON value, which no column-name rule can see.
    value: JSON.stringify({ enabled: true, note: mark, token: { v: 1, password_ciphertext: `CT-${mark}`, password_iv: 'aXY=', password_tag: 'dGFn', password_key_version: 2 } })
  });

  await db('device_samples').insert({
    tenant_id: tenantId, device_id: DEVICE_ID, inform_at: at, rx_power: -21.5, temperature: 45
  });
  await db('device_sample_hours').insert({
    tenant_id: tenantId, device_id: DEVICE_ID, bucket_at: at, sample_count: 1, rx_avg: -21.5
  });
  await db('device_swaps').insert({
    tenant_id: tenantId,
    account_id: accountId,
    customer_id: CUSTOMER_ID,
    pppoe_username: `joao.silva.${name}`,
    previous_device_id: 'ONT-OLD-0001',
    device_id: DEVICE_ID,
    contract: CONTRACT,
    matched_by: 'pppoe',
    link_action: mark.slice(0, 16)
  });

  // Through the service, so the ciphertext is real and the plaintext is one
  // this file knows and can go looking for.
  await runInTenant(tenantId, () => CustomerWifiCredentialService.save(
    accountId, 1, 'CasaDoJoao', wifiPasswordOf(name)
  ));

  // Where this provider's fleet is managed from, with a real NBI credential.
  // The installation's own provider already has a row from the 0029 backfill,
  // so this writes rather than inserts — and both sides need one, or the leak
  // assertions would be checking that beta's row is absent from a table beta
  // never had a row in.
  await runInTenant(tenantId, () => GenieAcsConnection.save({
    base_url: `http://acs.${name}.test:7557`,
    auth_type: 'basic',
    username: `nbi-${name}`,
    secret: nbiSecretOf(name)
  }));

  // One audit line. `record` never throws by contract, so it is asked directly
  // rather than through a route: what matters here is that the table has a row
  // of this provider's to export, not which action produced it.
  await runInTenant(tenantId, () => AuditLog.record({
    action: AUDIT_ACTIONS.PORTAL_PASSWORD_REVEALED,
    actorType: 'operator',
    actorLabel: `operador-${name}`,
    targetType: 'customer_account',
    targetId: String(accountId),
    ip: '203.0.113.9',
    metadata: { reason: mark }
  }));

  return { accountId, waAccountId, conversationId };
}

/** The export as the route serves it: the raw text and the parsed records. */
async function fetchExport(token) {
  const response = await fetch(`${panelUrl}/api/export`, {
    headers: token ? authHeaders(token) : {}
  });
  const text = await response.text();
  const records = text.trim()
    ? text.trim().split('\n').map((line) => JSON.parse(line))
    : [];
  return { status: response.status, headers: response.headers, text, records };
}

const rowsOf = (records, table) => records
  .filter((record) => record.type === 'row' && record.table === table)
  .map((record) => record.row);

const headerOf = (records, table) => records
  .find((record) => record.type === 'table' && record.table === table);

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'owner', password: 'owner-password-1' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // Carol is the arrangement the shared tables exist for: she runs beta and
  // merely operates alfa. Her `users.role` says admin and her membership at
  // alfa says viewer, so she is both the non-administrator this route must
  // refuse and the person whose other membership must not appear in alfa's
  // export.
  carolId = await insertReturningId('users', {
    username: CAROL.username, password: bcrypt.hashSync(CAROL.password, 4), role: 'admin'
  });
  await db('tenant_users').insert({ tenant_id: alfa, user_id: carolId, role: 'viewer' });
  await db('tenant_users').insert({ tenant_id: beta, user_id: carolId, role: 'admin' });

  // Beta's own operator, who has nothing to do with alfa.
  brunoId = await insertReturningId('users', {
    username: 'bruno', password: bcrypt.hashSync('bruno-password-1', 4), role: 'user'
  });
  await db('tenant_users').insert({ tenant_id: beta, user_id: brunoId, role: 'admin' });

  planted = { alfa: await plant(alfa, 'alfa'), beta: await plant(beta, 'beta') };

  const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: CAROL });
  assert.equal(login.status, 200);
  carolToken = login.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('who may ask for a provider in one file', () => {
  it('refuses a caller with no session', async () => {
    const { status } = await fetchExport(undefined);
    assert.equal(status, 401);
  });

  it('refuses a caller holding something that is not a session', async () => {
    const { status } = await fetchExport('not-a-token');
    assert.equal(status, 403);
  });

  it('refuses an operator who is not an administrator HERE', async () => {
    // Carol is an administrator at beta. The role that decides is the one on
    // the membership her token names, and at alfa she is a viewer.
    const { status } = await fetchExport(carolToken);
    assert.equal(status, 403);
  });

  it('serves an administrator of this provider', async () => {
    const { status, headers } = await fetchExport(ownerToken);
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /application\/x-ndjson/);
    assert.match(headers.get('content-disposition'), /attachment; filename="skygenpanel-export-/);
  });
});

describe('the shape of the file', () => {
  it('opens with a manifest and closes with an end record', async () => {
    const { records } = await fetchExport(ownerToken);
    assert.equal(records[0].type, 'manifest');
    assert.equal(records[0].format, 'skygenpanel-tenant-export');
    assert.equal(records.at(-1).type, 'end');
    assert.equal(
      records.at(-1).rows,
      records.filter((record) => record.type === 'row').length,
      'the footer must count what actually came out, or it cannot detect a truncation'
    );
  });

  it('says in the file what it holds and what it leaves behind', async () => {
    const { records } = await fetchExport(ownerToken);
    const manifest = records[0];
    assert.ok(manifest.contains.length > 0);
    assert.ok(manifest.excludes.length > 0);
    assert.ok(manifest.excludes.some((line) => line.includes('users.password')));
    assert.equal(manifest.tenant.id, alfa);
    assert.ok(manifest.schemaVersion, 'a restore has to know which schema these rows came out of');
  });

  it('counts every table it walked', async () => {
    const { records } = await fetchExport(ownerToken);
    for (const table of records[0].tables) {
      const end = records.find((record) => record.type === 'table_end' && record.table === table);
      assert.ok(end, `"${table}" was announced and never closed`);
      assert.equal(end.rows, rowsOf(records, table).length);
    }
  });
});

describe('coverage of the schema', () => {
  // Asserted against SCOPED_TABLES rather than a list written here. The
  // hand-written copy list in dbManagementService fell eight tables behind when
  // WhatsApp landed; a list here would fall behind the same way, and the tables
  // it lost would be the ones nobody exported and nobody missed until a restore.
  it('walks every provider-owned table', async () => {
    const { records } = await fetchExport(ownerToken);
    const walked = new Set(
      records.filter((record) => record.type === 'table').map((record) => record.table)
    );
    for (const table of SCOPED_TABLES) {
      assert.ok(walked.has(table), `"${table}" is provider-owned and is not in the export`);
    }
  });

  it('walks them parents first, in the schema\'s own order', async () => {
    const { records } = await fetchExport(ownerToken);
    const walked = records
      .filter((record) => record.type === 'table')
      .map((record) => record.table);
    const expected = SCHEMA_TABLES.filter((table) => walked.includes(table));
    assert.deepEqual(walked, expected, 'a consumer replaying this file inserts in this order');
  });

  it('accounts for every shared table too, one way or the other', async () => {
    const { records } = await fetchExport(ownerToken);
    const walked = new Set(
      records.filter((record) => record.type === 'table').map((record) => record.table)
    );
    for (const table of SHARED_TABLES) {
      assert.ok(
        walked.has(table),
        `"${table}" is shared, and the decision about what part of it belongs to a `
        + 'provider has to be made rather than skipped'
      );
      assert.equal(headerOf(records, table).ownership, 'shared');
    }
  });

  it('knows how to page every table it walks', async () => {
    // The walk is only safe while every table has a column with a total order
    // to page by. A table added without one would export a single page of
    // itself and stop, which reads as an empty table rather than as a failure —
    // so it is asserted here, where it is a named CI failure, and thrown at
    // export time rather than shrugged off.
    for (const table of exportTables()) {
      const columns = Object.keys(await getDb()(table).columnInfo());
      assert.ok(cursorColumnOf(table, columns), `"${table}" has no column to page by`);
    }
    assert.throws(() => cursorColumnOf('future_table', ['tenant_id', 'value']), /page by/);
  });

  it('has something of alfa\'s in every provider-owned table', async () => {
    // Without this the leak assertions below could all pass on an export that
    // returned nothing at all.
    const { records } = await fetchExport(ownerToken);
    for (const table of SCOPED_TABLES) {
      assert.ok(rowsOf(records, table).length > 0, `nothing was planted in "${table}"`);
    }
  });
});

describe('one provider and no other', () => {
  it('carries alfa\'s provider id on every provider-owned row', async () => {
    const { records } = await fetchExport(ownerToken);
    for (const record of records) {
      if (record.type !== 'row' || !SCOPED_TABLES.has(record.table)) continue;
      assert.equal(
        Number(record.row.tenant_id),
        Number(alfa),
        `a row of "${record.table}" belongs to provider ${record.row.tenant_id}`
      );
    }
  });

  it('contains none of beta\'s rows, checked as text', async () => {
    const { text } = await fetchExport(ownerToken);
    assert.ok(text.includes(markOf('alfa')), 'alfa\'s own rows should be here');
    assert.ok(!text.includes(markOf('beta')), 'beta appears in alfa\'s export');
  });

  it('keeps the colliding rows apart rather than merely absent', async () => {
    const { records } = await fetchExport(ownerToken);
    // Both providers hold this exact subscriber identity, and both hold a
    // `map_settings` row 1. Exactly one of each may come out.
    assert.equal(rowsOf(records, 'customer_accounts')
      .filter((row) => row.customer_id === CUSTOMER_ID).length, 1);
    assert.equal(rowsOf(records, 'sgp_events')
      .filter((row) => row.dedupe_key === DEDUPE_KEY).length, 1);
    assert.equal(rowsOf(records, 'map_settings').filter((row) => row.id === 1).length, 1);
    assert.equal(
      rowsOf(records, 'customer_accounts')[0].id,
      planted.alfa.accountId,
      'the subscriber that came out is alfa\'s, not the one with the same identity at beta'
    );
  });
});

describe('the shared tables, which are nobody\'s to export wholesale', () => {
  it('exports this provider\'s own row of the registry and no other', async () => {
    const { records } = await fetchExport(ownerToken);
    const tenants = rowsOf(records, 'tenants');
    assert.equal(tenants.length, 1);
    assert.equal(tenants[0].id, alfa);
  });

  it('exports the memberships here, not the ones the same person holds elsewhere', async () => {
    const { records } = await fetchExport(ownerToken);
    const memberships = rowsOf(records, 'tenant_users');
    for (const row of memberships) assert.equal(Number(row.tenant_id), Number(alfa));

    const carols = memberships.filter((row) => row.user_id === carolId);
    assert.equal(carols.length, 1, 'carol works for two ISPs and must appear here once');
    assert.equal(carols[0].role, 'viewer', 'the role at THIS provider, not the one she holds at beta');
    assert.equal(
      memberships.filter((row) => row.user_id === brunoId).length,
      0,
      "beta's operator has no membership here and must not appear"
    );
  });

  it('exports the people those memberships name, and nothing that could become them', async () => {
    const { records } = await fetchExport(ownerToken);
    const people = rowsOf(records, 'users');

    assert.ok(people.some((row) => row.username === 'carol'));
    assert.ok(people.some((row) => row.username === 'owner'));
    assert.ok(!people.some((row) => row.username === 'bruno'), 'bruno works for beta only');

    for (const row of people) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ['created_at', 'id', 'updated_at', 'username'],
        'a person\'s login opens the panel at every ISP they work for; this file is one ISP\'s'
      );
    }
  });

  it('leaves no password hash of a person anywhere in the file', async () => {
    const { text } = await fetchExport(ownerToken);
    const carol = await getDb()('users').where({ id: carolId }).first();
    assert.ok(!text.includes(carol.password), 'carol\'s login also opens beta');
  });
});

describe('what happens to the encrypted columns', () => {
  it('says outright that it decrypted nothing', async () => {
    const { records } = await fetchExport(ownerToken);
    const { secrets } = records[0];
    assert.equal(secrets.decrypted, false);
    // A NULL version means version 1, and a restore that does not know that
    // points decryption at the wrong key — which `decrypt` reports by returning
    // null, indistinguishable from "no password was ever stored".
    assert.equal(secrets.nullKeyVersionMeans, 1);
    assert.match(secrets.readableWith, /SECRET_BOX_KEY/);
    assert.match(secrets.alsoInsideJsonValues, /app_state/);
  });

  it('ships the ciphertext with the key version that produced it', async () => {
    const { records } = await fetchExport(ownerToken);
    const [credential] = rowsOf(records, 'customer_wifi_credentials');
    assert.ok(credential.password_ciphertext);
    assert.ok(credential.password_iv);
    assert.ok(credential.password_tag);
    assert.ok(
      Object.hasOwn(credential, 'password_key_version'),
      'ciphertext without its key version restores as a silent loss, not as an error'
    );
    assert.deepEqual(
      await getDb()('customer_wifi_credentials').where({ id: credential.id }).first()
        .then((row) => row.password_ciphertext),
      credential.password_ciphertext,
      'the ciphertext must leave exactly as the database holds it'
    );
  });

  it('never writes a subscriber\'s password in clear', async () => {
    const { text } = await fetchExport(ownerToken);
    assert.ok(!text.includes(wifiPasswordOf('alfa')), 'the export decrypted a WiFi password');
    assert.ok(!text.includes(wifiPasswordOf('beta')));
  });

  it('never writes the NBI credential in clear either', async () => {
    const { text, records } = await fetchExport(ownerToken);

    // The same rule on the table added in 0029, and the stakes are higher than
    // for a subscriber's WiFi key: this credential is the provider's whole
    // fleet, and an export is a file that leaves the building by design.
    assert.ok(!text.includes(nbiSecretOf('alfa')), 'the export carries the NBI credential');
    assert.ok(!text.includes(nbiSecretOf('beta')));

    const [connection] = rowsOf(records, 'tenant_genieacs_connections');
    assert.ok(connection.secret_ciphertext);
    assert.ok(
      Object.hasOwn(connection, 'secret_key_version'),
      'ciphertext without its key version restores as a silent loss, not as an error'
    );
    // The username is not the secret and has to survive: without it a restored
    // Basic credential is half a credential and nothing says which half.
    assert.equal(connection.username, 'nbi-alfa');
  });

  it('names the secret columns of each table, and only those', async () => {
    const { records } = await fetchExport(ownerToken);
    assert.deepEqual(
      headerOf(records, 'customer_wifi_credentials').secretColumns.sort(),
      ['password_ciphertext', 'password_iv', 'password_key_version', 'password_tag']
    );
    assert.ok(headerOf(records, 'customer_accounts').secretColumns.includes('password_hash'));
    assert.ok(
      headerOf(records, 'whatsapp_accounts').secretColumns.includes('webhook_token_ciphertext')
    );
    // `installation_tag` ends in `_tag` and is an installer's label. A reader
    // told that a plain column is a secret learns to disbelieve the statement.
    assert.deepEqual(headerOf(records, 'device_profiles').secretColumns, []);
  });

  it('carries a secret box nested inside a JSON value through untouched', async () => {
    const { records } = await fetchExport(ownerToken);
    const stored = await getDb()('app_state')
      .where({ tenant_id: alfa, key: 'sgp_integration_config' })
      .first();
    const exported = rowsOf(records, 'app_state')
      .find((row) => row.key === 'sgp_integration_config');
    assert.equal(exported.value, stored.value);
    assert.match(exported.value, /password_ciphertext/);
  });
});

describe('the size of a real provider', () => {
  /**
   * Counts the paged reads of one table while `fn` runs. The page queries are
   * the only ones carrying a LIMIT, which is what keeps the catalogue lookup
   * that precedes them out of the count.
   */
  async function countingPages(table, fn) {
    const db = getDb();
    const counter = { pages: 0 };
    const listener = ({ sql }) => {
      if (/^select/i.test(sql) && sql.includes(table) && /limit/i.test(sql)) counter.pages += 1;
    };
    db.on('query', listener);
    try {
      await fn(counter);
    } finally {
      db.off('query', listener);
    }
    return counter.pages;
  }

  it('reads a table a page at a time, and yields rows before it has them all', async () => {
    const db = getDb();
    const existing = await db('device_profiles').where({ tenant_id: alfa }).count({ n: '*' });
    const have = Number(existing[0].n);
    for (let index = have; index < 12; index += 1) {
      await db('device_profiles').insert({ tenant_id: alfa, device_id: `ONT-BULK-${index}` });
    }

    let seen = 0;
    const pages = await countingPages('device_profiles', async (counter) => {
      await runInTenant(alfa, async () => {
        for await (const record of exportTenant({ pageSize: 5 })) {
          if (record.type !== 'row' || record.table !== 'device_profiles') continue;
          seen += 1;
          if (seen === 1) {
            // The whole point: the first row is in the caller's hands after one
            // page, not after the table has been assembled in memory.
            assert.equal(counter.pages, 1);
          }
          if (seen === 6) {
            assert.equal(counter.pages, 2, 'the sixth row must have cost a second page');
            break;
          }
        }
      });
    });

    assert.equal(seen, 6);
    assert.equal(pages, 2, 'abandoning the walk must stop it, not drain the table');
  });

  it('brings back every row of a table that spans several pages', async () => {
    const rows = [];
    await runInTenant(alfa, async () => {
      for await (const record of exportTenant({ pageSize: 5 })) {
        if (record.type === 'row' && record.table === 'device_profiles') rows.push(record.row);
      }
    });
    const expected = await getDb()('device_profiles').where({ tenant_id: alfa }).count({ n: '*' });
    assert.equal(rows.length, Number(expected[0].n));
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'a page boundary duplicated a row');
  });
});
