import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The provider registry: the first thing in twelve waves that can mint a second
 * provider.
 *
 * What has to be proved here is not that three routes answer. It is that a
 * provider created through the API is INDISTINGUISHABLE from one created at
 * boot — same settings, same equipment catalogue — because the way this fails
 * is silent. An unseeded provider comes up with no GenieACS address and with
 * equipment detection that matches nothing at all; nothing throws, nothing logs,
 * the panel merely looks wrong to the ISP that was just handed it. So the
 * assertions below are on rows in the scoped tables, not on the response body.
 *
 * The SaaS edition has to be chosen before app.js is imported, because the
 * route table is built at module load and these routes are mounted under
 * `IS_SAAS`. Static imports are hoisted above every statement in the file, so
 * the harness is pulled in dynamically for the assignment below to be visible
 * to it. `node --test` gives each file its own process, so the choice does not
 * leak into the other suites — which is also why the self-hosted half of the
 * contract is proved in a child process at the bottom of this file.
 */
process.env.EDITION = 'saas';

const {
  authHeaders,
  call,
  defaultTenantId,
  getDb,
  insertReturningId,
  startTestServers,
  stopTestServers
} = await import('./helpers/harness.js');

const { DEFAULT_SETTINGS } = await import('../src/config/seed.js');
const { forEachTenant } = await import('../src/config/tenantJobs.js');

const run = promisify(execFile);

const OWNER = { username: 'owner', password: 'owner-senha-1' };
// An administrator at the installation's own provider and nothing more. The
// point of the control plane is that this is not enough.
const COMUM = { username: 'comum', password: 'comum-senha-1' };

// One vendor, one security mapping, one product-class config: the smallest
// catalogue that still proves the copy remaps the foreign key.
const VENDOR = {
  name: 'Fabricante Teste',
  manufacturer_patterns: JSON.stringify(['teste']),
  product_patterns: JSON.stringify(['ONU-T1']),
  parameter_prefix: 'InternetGatewayDevice',
  wifi_password_path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
  priority: 5,
  enabled: true
};

let panelUrl;
let alfa;
let ownerToken;
let ownerId;
let comumToken;

const platform = (path, options = {}) => call(`${panelUrl}/api/platform${path}`, {
  ...options,
  headers: { ...authHeaders(ownerToken), ...(options.headers || {}) }
});

const createTenant = (body) => platform('/tenants', { method: 'POST', body });

/** Which providers a background job walks — the real reader of `status`. */
const visitedByJobs = () => forEachTenant((tenant) => tenant.slug);

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: OWNER
  });
  assert.equal(setup.status, 201, 'could not create the first administrator');
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;

  // `platform_admins` is written straight to the table: it is created empty by
  // 0029 and the route that grants the role belongs to another lane. What is
  // under test here is what the registry does for somebody on the roster, not
  // how they got onto it. Guarded so this still works once the SaaS setup path
  // puts the first administrator there itself.
  if (!(await getDb()('platform_admins').where({ user_id: ownerId }).first())) {
    await getDb()('platform_admins').insert({ user_id: ownerId });
  }

  const hire = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(ownerToken),
    body: { ...COMUM, role: 'admin' }
  });
  assert.equal(hire.status, 201, 'could not create the ordinary administrator');
  const signIn = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: COMUM });
  assert.equal(signIn.status, 200, 'the ordinary administrator could not sign in');
  comumToken = signIn.body.data.token;

  // The installation's own provider is given a catalogue, because on a fresh
  // install nobody has one: `vendors` is built by the operator through
  // `/api/vendor-management`, so with the table empty everywhere the copy would
  // have nothing to copy and would pass this suite by doing nothing at all.
  const vendorId = await insertReturningId('vendors', { ...VENDOR, tenant_id: alfa });
  await getDb()('wifi_security_mappings').insert({
    tenant_id: alfa,
    vendor_id: vendorId,
    raw_security_value: '11i',
    normalized_security: 'WPA2-PSK'
  });
  await getDb()('wifi_security_config').insert({
    tenant_id: alfa,
    product_class: 'ONU-T1',
    security_types: 'WPA2',
    password_param_path: VENDOR.wifi_password_path
  });
});

after(async () => {
  await stopTestServers();
});

describe('creating a provider', () => {
  let novaId;

  it('creates it and lists it with nobody working there yet', async () => {
    const { status, body } = await createTenant({ slug: 'novaisp', name: 'Nova ISP' });
    assert.equal(status, 201);
    assert.equal(body.data.tenant.slug, 'novaisp');
    assert.equal(body.data.tenant.name, 'Nova ISP');
    assert.equal(body.data.tenant.status, 'active');
    assert.equal(body.data.tenant.operators, 0);
    novaId = body.data.tenant.id;

    const list = await platform('/tenants');
    assert.equal(list.status, 200);
    const bySlug = new Map(list.body.data.tenants.map((t) => [t.slug, t]));
    assert.equal(bySlug.get('novaisp').operators, 0,
      'a brand new provider cannot already have staff');
    // The installation's own provider has exactly the two people created above,
    // which is what proves `operators` counts memberships per provider rather
    // than everybody on the deployment.
    assert.equal(bySlug.get((await getDb()('tenants').where({ id: alfa }).first()).slug).operators, 2);
  });

  // The requirement most likely to be missed, and the one that fails silently
  // in production: a provider with no settings row has no GenieACS address and
  // no VirtualParameter mapping.
  it('gives it every default setting, and its own map centre', async () => {
    const settings = await getDb()('settings').where({ tenant_id: novaId });
    const values = new Map(settings.map((row) => [row.key, row.value]));
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      assert.equal(values.get(key), value, `the new provider is missing "${key}"`);
    }

    const map = await getDb()('map_settings').where({ tenant_id: novaId, id: 1 }).first();
    assert.ok(map, 'the new provider has no map centre of its own');
    assert.equal(String(map.default_zoom), '13');
  });

  // Wave 11's rule, applied to a provider that did not exist at boot: an empty
  // catalogue means detection matches no vendor and the WiFi write falls back
  // to guessing a parameter path. Nothing fails; the panel just never works.
  it('gives it a copy of the equipment catalogue', async () => {
    const vendors = await getDb()('vendors').where({ tenant_id: novaId });
    assert.equal(vendors.length, 1, 'the new provider has no equipment catalogue');
    assert.equal(vendors[0].name, VENDOR.name);
    assert.equal(vendors[0].wifi_password_path, VENDOR.wifi_password_path);

    const mappings = await getDb()('wifi_security_mappings').where({ tenant_id: novaId });
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].normalized_security, 'WPA2-PSK');
    // The copy has to point at the NEW provider's vendor. Carrying the source's
    // `vendor_id` across would attach this provider's mappings to another
    // provider's vendors, which is the cross-provider foreign key wave 11 exists
    // to prevent.
    assert.equal(Number(mappings[0].vendor_id), Number(vendors[0].id));
    const source = await getDb()('vendors').where({ tenant_id: alfa }).first();
    assert.notEqual(Number(mappings[0].vendor_id), Number(source.id));

    const configs = await getDb()('wifi_security_config').where({ tenant_id: novaId });
    assert.equal(configs.length, 1);
    assert.equal(configs[0].product_class, 'ONU-T1');
  });

  it('refuses a slug that is already taken', async () => {
    const { status } = await createTenant({ slug: 'novaisp', name: 'Outra ISP' });
    assert.equal(status, 409);
    assert.equal((await getDb()('tenants').where({ slug: 'novaisp' })).length, 1);
  });

  // The slug is the subdomain the panel will be reached at, so each of these is
  // a hostname that does not resolve, or resolves somewhere else entirely.
  it('refuses a slug that is not a hostname, rather than fixing it quietly', async () => {
    const refused = [
      ['', 'empty'],
      ['ab', 'shorter than three characters'],
      ['a'.repeat(64), 'longer than a DNS label'],
      ['Nova', 'uppercase'],
      ['nova isp', 'a space'],
      ['nova_isp', 'an underscore'],
      ['-novaisp', 'a leading hyphen'],
      ['novaisp-', 'a trailing hyphen'],
      ['no--vaisp', 'the reserved punycode position'],
      ['www', 'a label the deployment already answers to'],
      ['nova.isp', 'a dot, which is a second label']
    ];
    const before = (await getDb()('tenants')).length;
    for (const [slug, why] of refused) {
      const { status } = await createTenant({ slug, name: 'Nova ISP' });
      assert.equal(status, 400, `${JSON.stringify(slug)} (${why}) should be refused`);
    }
    assert.equal((await getDb()('tenants')).length, before,
      'a refused slug still created a provider');
  });

  it('refuses a provider with no name', async () => {
    const { status } = await createTenant({ slug: 'semnome', name: '   ' });
    assert.equal(status, 400);
  });
});

describe('suspending and reactivating', () => {
  let outraId;

  before(async () => {
    const { status, body } = await createTenant({ slug: 'outraisp', name: 'Outra ISP' });
    assert.equal(status, 201);
    outraId = body.data.tenant.id;
  });

  it('stops the background jobs visiting a suspended provider', async () => {
    assert.ok((await visitedByJobs()).includes('outraisp'),
      'an active provider is not being visited in the first place');

    const { status, body } = await platform(`/tenants/${outraId}`, {
      method: 'PATCH',
      body: { status: 'suspended' }
    });
    assert.equal(status, 200);
    assert.equal(body.data.tenant.status, 'suspended');

    const visited = await visitedByJobs();
    assert.ok(!visited.includes('outraisp'), 'a suspended provider is still being visited');
    assert.ok(visited.includes('novaisp'), 'suspending one provider stopped another');
  });

  it('brings it back', async () => {
    const { status, body } = await platform(`/tenants/${outraId}`, {
      method: 'PATCH',
      body: { status: 'active' }
    });
    assert.equal(status, 200);
    assert.equal(body.data.tenant.status, 'active');
    assert.ok((await visitedByJobs()).includes('outraisp'),
      'a reactivated provider is not being visited again');
  });

  it('refuses a status that is not one of the two', async () => {
    for (const status of ['deleted', 'ACTIVE', '', null, 42]) {
      const response = await platform(`/tenants/${outraId}`, { method: 'PATCH', body: { status } });
      assert.equal(response.status, 400, `${JSON.stringify(status)} should be refused`);
    }
    const row = await getDb()('tenants').where({ id: outraId }).first();
    assert.equal(row.status, 'active');
  });

  it('answers 404 for a provider that does not exist', async () => {
    const { status } = await platform('/tenants/999999', {
      method: 'PATCH',
      body: { status: 'suspended' }
    });
    assert.equal(status, 404);
  });

  /**
   * Apagar existe desde a onda 22, e o que este caso fixa é que ele não
   * acontece por acidente: um provedor ATIVO não sai, por mais autorizado que
   * seja quem pede. Suspender primeiro é o que faz da exclusão dois passos com
   * um estado reversível no meio — que era a objeção inteira à versão anterior
   * deste teste, quando o DELETE não existia.
   *
   * As outras três condições — slug digitado de volta, não ser o último
   * provedor, e a trilha gravada antes — estão em `platform-tenant-delete`.
   */
  it('não apaga um provedor que está ativo', async () => {
    const { status } = await platform(`/tenants/${outraId}`, {
      method: 'DELETE',
      body: { confirmSlug: 'outra' }
    });
    assert.equal(status, 409);
    assert.ok(await getDb()('tenants').where({ id: outraId }).first());
  });
});

describe('who may reach the registry', () => {
  it('refuses somebody who is merely an administrator at their own provider', async () => {
    const before = (await getDb()('tenants')).length;
    for (const [method, path, body] of [
      ['GET', '/api/platform/tenants', undefined],
      ['POST', '/api/platform/tenants', { slug: 'invasora', name: 'Invasora' }],
      ['PATCH', `/api/platform/tenants/${alfa}`, { status: 'suspended' }]
    ]) {
      const { status } = await call(`${panelUrl}${path}`, {
        method,
        headers: authHeaders(comumToken),
        body
      });
      // Which refusal is lane A's to decide; that it IS one is lane B's.
      assert.ok(status >= 400 && status < 500,
        `${method} ${path} answered ${status} to a provider's own administrator`);
    }
    assert.equal((await getDb()('tenants')).length, before);
    const alfaRow = await getDb()('tenants').where({ id: alfa }).first();
    assert.equal(alfaRow.status, 'active', 'an ordinary administrator suspended a provider');
  });

  it('refuses a caller with no session at all', async () => {
    const { status } = await call(`${panelUrl}/api/platform/tenants`);
    assert.equal(status, 401);
  });
});

/**
 * The other half of the contract, and it cannot be asserted in this process:
 * the edition is read when `app.js` is imported, and this file has already
 * imported it as `saas`. So a child process boots the whole application as a
 * self-hosted install and reports what the routes answer.
 *
 * The claim is precise. On a self-hosted install these routes do not merely
 * refuse — they are NOT MOUNTED, so they answer 404 like any other unknown
 * path. A 403 would tell whoever asked that a control plane is there to find,
 * which on an install that has exactly one provider is information about the
 * product rather than about them.
 */
const SELF_HOSTED_PROBE = `
const harness = await import(process.env.LANE_B_HARNESS);
const { panelUrl } = await harness.startTestServers();
const answers = [];
for (const [method, path, body] of [
  ['GET', '/api/platform/tenants', undefined],
  ['POST', '/api/platform/tenants', { slug: 'novaisp', name: 'Nova ISP' }],
  ['PATCH', '/api/platform/tenants/1', { status: 'suspended' }],
  ['GET', '/api/settings', undefined]
]) {
  const { status } = await harness.call(panelUrl + path, { method, body });
  answers.push([method + ' ' + path, status]);
}
console.log('LANE_B_RESULT ' + JSON.stringify(answers));
await harness.stopTestServers();
`;

describe('a self-hosted install', () => {
  it('does not mount the platform routes at all', async () => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', SELF_HOSTED_PROBE], {
      env: {
        ...process.env,
        EDITION: 'selfhosted',
        LANE_B_HARNESS: new URL('./helpers/harness.js', import.meta.url).href
      },
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024
    });
    const line = stdout.split('\n').find((l) => l.startsWith('LANE_B_RESULT '));
    assert.ok(line, `the self-hosted probe printed no result:\n${stdout}`);
    const answers = new Map(JSON.parse(line.slice('LANE_B_RESULT '.length)));

    for (const route of [
      'GET /api/platform/tenants',
      'POST /api/platform/tenants',
      'PATCH /api/platform/tenants/1'
    ]) {
      assert.equal(answers.get(route), 404, `${route} should not be routed at all`);
    }
    // A 401 here rather than a 404 is what proves the 404s above come from the
    // edition gate and not from the whole API being unreachable in the child.
    assert.equal(answers.get('GET /api/settings'), 401);
  });
});
