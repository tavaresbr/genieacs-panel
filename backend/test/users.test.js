import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders,
  call,
  defaultTenantId,
  getDb,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

let panelUrl;
let adminToken;
let viewerId;
const VIEWER = { username: 'atendimento', password: 'viewer-password-1' };

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'owner', password: 'owner-password-1' }
  });
  adminToken = setup.body.data.token;

  // `/api/auth/setup` creates the person but not the membership that says she
  // works for the provider she just set up — the login path owns that row and
  // is being written alongside this. `/api/users` reads memberships, so without
  // it the owner would be absent from her own team.
  await getDb()('tenant_users').insert({
    tenant_id: await defaultTenantId(),
    user_id: setup.body.data.user.id,
    role: 'admin'
  });
});

after(async () => {
  await stopTestServers();
});

describe('operator management', () => {
  it('requires an administrator session', async () => {
    const anonymous = await call(`${panelUrl}/api/users`);
    assert.equal(anonymous.status, 401);
  });

  it('rejects an unknown role', async () => {
    const { status } = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: { ...VIEWER, role: 'superuser' }
    });
    assert.equal(status, 400);
  });

  it('rejects a short password', async () => {
    const { status } = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: { username: 'curto', password: 'short', role: 'viewer' }
    });
    assert.equal(status, 400);
  });

  it('creates a read-only operator', async () => {
    const { status, body } = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: { ...VIEWER, role: 'viewer' }
    });
    assert.equal(status, 201);
    assert.equal(body.data.user.role, 'viewer');
    assert.equal(body.data.user.password, undefined);
    viewerId = body.data.user.id;
  });

  it('refuses a duplicate username', async () => {
    const { status } = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: { ...VIEWER, role: 'viewer' }
    });
    assert.equal(status, 409);
  });

  it('lists operators without exposing password hashes', async () => {
    const { status, body } = await call(`${panelUrl}/api/users`, {
      headers: authHeaders(adminToken)
    });
    assert.equal(status, 200);
    assert.equal(body.data.users.length, 2);
    assert.ok(!JSON.stringify(body.data.users).includes('$2'));
  });
});

describe('what a read-only operator may do', () => {
  let viewerToken;

  before(async () => {
    const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: VIEWER });
    assert.equal(login.status, 200);
    viewerToken = login.body.data.token;
  });

  it('can read its own profile', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(viewerToken)
    });
    assert.equal(status, 200);
    assert.equal(body.data.role, 'viewer');
  });

  it('cannot reach administrator-only routes', async () => {
    for (const path of ['/api/settings', '/api/users', '/api/database/config']) {
      const { status } = await call(`${panelUrl}${path}`, { headers: authHeaders(viewerToken) });
      assert.equal(status, 403, `${path} should be forbidden for a viewer`);
    }
  });

  it('cannot create another operator', async () => {
    const { status } = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(viewerToken),
      body: { username: 'escalation', password: 'escalation-1', role: 'admin' }
    });
    assert.equal(status, 403);
  });
});

describe('guard rails', () => {
  it('refuses to demote the signed-in administrator', async () => {
    const me = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(adminToken) });
    const { status } = await call(`${panelUrl}/api/users/${me.body.data.id}`, {
      method: 'PATCH',
      headers: authHeaders(adminToken),
      body: { role: 'viewer' }
    });
    assert.equal(status, 409);
  });

  it('refuses to delete the account in use', async () => {
    const me = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(adminToken) });
    const { status } = await call(`${panelUrl}/api/users/${me.body.data.id}`, {
      method: 'DELETE',
      headers: authHeaders(adminToken)
    });
    assert.equal(status, 409);
  });

  it('keeps at least one administrator', async () => {
    const promoted = await call(`${panelUrl}/api/users/${viewerId}`, {
      method: 'PATCH',
      headers: authHeaders(adminToken),
      body: { role: 'admin' }
    });
    assert.equal(promoted.status, 200);

    const demoted = await call(`${panelUrl}/api/users/${viewerId}`, {
      method: 'PATCH',
      headers: authHeaders(adminToken),
      body: { role: 'viewer' }
    });
    assert.equal(demoted.status, 200, 'a second administrator may be demoted again');
  });

  it('revokes the sessions of an operator whose role changes', async () => {
    const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: VIEWER });
    const staleToken = login.body.data.token;
    assert.equal(
      (await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(staleToken) })).status,
      200
    );

    await call(`${panelUrl}/api/users/${viewerId}`, {
      method: 'PATCH',
      headers: authHeaders(adminToken),
      body: { role: 'admin' }
    });

    const reused = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(staleToken) });
    assert.equal(reused.status, 403);
  });

  it('removes an operator that is not the last administrator', async () => {
    const { status } = await call(`${panelUrl}/api/users/${viewerId}`, {
      method: 'DELETE',
      headers: authHeaders(adminToken)
    });
    assert.equal(status, 200);

    const remaining = await call(`${panelUrl}/api/users`, { headers: authHeaders(adminToken) });
    assert.ok(
      !remaining.body.data.users.some((user) => user.id === viewerId),
      'the operator is off this provider\'s team'
    );
    // The person is NOT deleted — she may work for another provider, and her
    // name is on history that points at her id. What used to be asserted here,
    // that she can no longer sign in, is now the login path's job: it has to
    // refuse a person with no membership, and that is the other half of this
    // wave. Until it lands she still gets a token on this deployment, which is
    // the one thing this change leaves open on purpose rather than by mistake.
    assert.ok(await getDb()('users').where({ id: viewerId }).first(), 'the person survives');
  });
});
