import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';

let panelUrl;
const admin = { username: 'operator', password: 'initial-password-1' };
let session;

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

describe('operator setup', () => {
  it('reports that the panel needs its first administrator', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/setup-status`);
    assert.equal(status, 200);
    assert.equal(body.data.needsSetup, true);
  });

  it('rejects a password shorter than eight characters', async () => {
    const { status } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'operator', password: 'short' }
    });
    assert.equal(status, 400);
  });

  it('creates the first administrator and returns a session', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: admin
    });
    assert.equal(status, 201);
    assert.equal(body.data.user.role, 'admin');
    assert.ok(body.data.token);
    assert.ok(body.data.refreshToken);
    session = body.data;
  });

  it('refuses a second setup once an administrator exists', async () => {
    const { status } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'intruder', password: 'another-password-1' }
    });
    assert.equal(status, 409);
  });

  it('no longer reports that setup is needed', async () => {
    const { body } = await call(`${panelUrl}/api/auth/setup-status`);
    assert.equal(body.data.needsSetup, false);
  });
});

describe('operator login', () => {
  it('rejects a wrong password without revealing which field failed', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: admin.username, password: 'wrong-password' }
    });
    assert.equal(status, 401);
    assert.equal(body.message, 'Invalid username or password');
  });

  it('rejects an unknown user with the same message', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'nobody', password: 'wrong-password' }
    });
    assert.equal(status, 401);
    assert.equal(body.message, 'Invalid username or password');
  });

  it('never returns the stored password hash', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: admin
    });
    assert.equal(status, 200);
    assert.equal(body.data.user.password, undefined);
    session = body.data;
  });
});

describe('protected routes', () => {
  it('requires a token', async () => {
    const { status } = await call(`${panelUrl}/api/auth/user`);
    assert.equal(status, 401);
  });

  it('rejects a forged token', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders('not.a.jwt')
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'invalid_token');
  });

  it('rejects a refresh token used as an access token', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(session.refreshToken)
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'invalid_token');
  });

  it('accepts a valid access token', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(session.token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.username, admin.username);
  });

  it('blocks a cross-origin browser request', async () => {
    const { status } = await call(`${panelUrl}/api/auth/user`, {
      headers: { ...authHeaders(session.token), Origin: 'https://evil.example' }
    });
    assert.equal(status, 403);
  });
});

describe('token refresh', () => {
  it('rejects an access token presented as a refresh token', async () => {
    const { status } = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: session.token }
    });
    assert.equal(status, 403);
  });

  it('exchanges a refresh token for a new pair', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: session.refreshToken }
    });
    assert.equal(status, 200);
    assert.ok(body.data.token);
    assert.ok(body.data.refreshToken);
    session = body.data;
  });
});

describe('session revocation', () => {
  it('invalidates existing tokens after a password change', async () => {
    const previousToken = session.token;
    const previousRefreshToken = session.refreshToken;

    const changed = await call(`${panelUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: authHeaders(previousToken),
      body: { currentPassword: admin.password, newPassword: 'rotated-password-2' }
    });
    assert.equal(changed.status, 200);
    admin.password = 'rotated-password-2';

    const reused = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(previousToken)
    });
    assert.equal(reused.status, 403);

    const refreshed = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: previousRefreshToken }
    });
    assert.equal(refreshed.status, 403);
  });

  it('invalidates the token used to log out', async () => {
    const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: admin });
    assert.equal(login.status, 200);

    const loggedOut = await call(`${panelUrl}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(login.body.data.token)
    });
    assert.equal(loggedOut.status, 200);

    const reused = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(login.body.data.token)
    });
    assert.equal(reused.status, 403);
  });
});
