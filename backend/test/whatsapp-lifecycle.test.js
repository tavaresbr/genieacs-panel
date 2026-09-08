import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');

const WEBHOOK_BASE = 'https://painel.provedor.com.br/api/whatsapp-webhook';

let panelUrl;
let token;

/**
 * The fake servers listen on loopback, which the SSRF guard blocks — correctly,
 * and that block is itself covered elsewhere. So the panel is pointed at a
 * TEST-NET-3 address (203.0.113.0/24, public as far as the guard is concerned)
 * and only the socket is redirected, one layer below. The client's own code
 * path — allowlist, guard, headers, status handling — runs unchanged.
 */
const LOOPBACK_FOR = new Map();
const realFetch = globalThis.fetch;

function installFakeDns() {
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : String(input?.url ?? input);
    let target = raw;
    try {
      const url = new URL(raw);
      const port = LOOPBACK_FOR.get(url.hostname);
      if (port) {
        url.hostname = '127.0.0.1';
        url.port = String(port);
        target = url.toString();
      }
    } catch {
      /* not an absolute URL: nothing to redirect */
    }
    return realFetch(target, init);
  };
}

/**
 * A stand-in for one Evolution server, in one of its two flavours.
 *
 * It answers the routes `utils/wa/evolutionApi.js` builds and records every
 * request, so a test can assert that the v2 and the GO payloads really differ
 * on the wire rather than only in the builder's unit tests.
 */
function startEvolution(flavor, ip) {
  const state = {
    requests: [],
    createStatus: 200,
    qrPending: false,
    restartStatus: 200,
    deleteStatus: 200,
    connected: false,
    loggedIn: false,
    createdName: null,
    // v2 hands back a key of its own choosing; whatever it says wins over the
    // token the panel minted.
    apiKey: `server-key-${flavor}`
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const path = req.url.split('?')[0];
      state.requests.push({ method: req.method, path, apikey: req.headers.apikey || null, body });

      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const handler = flavor === 'go' ? goRoutes : v2Routes;
      const answer = handler(state, req.method, path, body);
      return send(answer.status, answer.data);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      LOOPBACK_FOR.set(ip, server.address().port);
      resolve({ state, server, baseUrl: `http://${ip}:${server.address().port}` });
    });
  });
}

const CONFLICT = { status: 409, data: { error: 'This instance name is already in use' } };
const NO_QR = { status: 400, data: { error: 'no QR code available' } };
const NOT_FOUND = { status: 404, data: { error: 'not found' } };

function v2Routes(state, method, path, body) {
  // v2 has no /server/ok; its root carries the version, which is what the probe
  // reads.
  if (method === 'GET' && path === '/') {
    return { status: 200, data: { version: '2.2.3', clientName: 'evolution_exchange' } };
  }
  if (method === 'POST' && path === '/instance/create') {
    state.createdName = body?.name || body?.instanceName || null;
    if (state.createStatus !== 200) return CONFLICT;
    return {
      status: 200,
      data: {
        instance: { instanceName: state.createdName, instanceId: 'v2-instance-id', status: 'created' },
        hash: { apikey: state.apiKey },
        qrcode: { base64: 'data:image/png;base64,V2QR', code: '2@v2' }
      }
    };
  }
  if (method === 'GET' && path === '/instance/fetchInstances') {
    return { status: 200, data: [{ id: 'v2-recovered-id', name: state.createdName, connectionStatus: 'close' }] };
  }
  if (method === 'GET' && path.startsWith('/instance/connect/')) {
    return state.qrPending
      ? NO_QR
      : { status: 200, data: { base64: 'data:image/png;base64,V2QRNOVO', code: '2@novo' } };
  }
  if (method === 'GET' && path.startsWith('/instance/connectionState/')) {
    return { status: 200, data: { instance: { state: state.connected ? 'open' : 'close' } } };
  }
  if (method === 'POST' && path.startsWith('/instance/restart/')) {
    return state.restartStatus === 200
      ? { status: 200, data: { status: 'SUCCESS' } }
      : { status: 400, data: { error: 'no active session' } };
  }
  if (method === 'DELETE' && path.startsWith('/instance/logout/')) {
    return { status: 200, data: { status: 'SUCCESS' } };
  }
  if (method === 'DELETE' && path.startsWith('/instance/delete/')) {
    return state.deleteStatus === 200
      ? { status: 200, data: { status: 'SUCCESS' } }
      : { status: 500, data: { error: 'internal error deleting instance' } };
  }
  if (method === 'POST' && path.startsWith('/chat/whatsappNumbers/')) {
    return {
      status: 200,
      data: [
        { number: '559381110449', exists: true },
        { number: '5511999999999', exists: false }
      ]
    };
  }
  return NOT_FOUND;
}

function goRoutes(state, method, path, body) {
  if (method === 'GET' && path === '/server/ok') return { status: 200, data: { status: 'ok' } };
  if (method === 'POST' && path === '/instance/create') {
    state.createdName = body?.name || null;
    if (state.createStatus !== 200) return CONFLICT;
    // GO echoes the id and the token it was handed; the QR only exists after
    // /instance/connect starts the whatsmeow client.
    return {
      status: 200,
      data: { message: 'success', data: { id: body?.instanceId, name: body?.name, token: body?.token } }
    };
  }
  if (method === 'GET' && path === '/instance/all') {
    return {
      status: 200,
      data: { message: 'success', data: [{ id: 'go-recovered-id', name: state.createdName, connected: false }] }
    };
  }
  if (method === 'POST' && path === '/instance/connect') {
    return { status: 200, data: { message: 'success', data: {} } };
  }
  if (method === 'GET' && path === '/instance/qr') {
    return state.qrPending
      ? NO_QR
      : { status: 200, data: { message: 'success', data: { qrcode: 'data:image/png;base64,GOQR', code: '2@go' } } };
  }
  if (method === 'GET' && path === '/instance/status') {
    return {
      status: 200,
      data: { message: 'success', data: { Connected: state.connected, LoggedIn: state.loggedIn } }
    };
  }
  if (method === 'POST' && path === '/instance/reconnect') {
    return state.restartStatus === 200
      ? { status: 200, data: { message: 'success' } }
      : { status: 400, data: { error: 'no active session' } };
  }
  if (method === 'DELETE' && path === '/instance/logout') {
    return { status: 200, data: { message: 'success' } };
  }
  if (method === 'DELETE' && path.startsWith('/instance/delete/')) {
    return state.deleteStatus === 200
      ? { status: 200, data: { message: 'success' } }
      : { status: 500, data: { error: 'could not delete instance' } };
  }
  return NOT_FOUND;
}

let v2;
let go;
let conflicting;

function created(state) {
  return state.requests.find((r) => r.method === 'POST' && r.path === '/instance/create');
}

async function createAccount(baseUrl, extra = {}) {
  return call(`${panelUrl}/api/whatsapp/accounts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { baseUrl, adminKey: 'chave-global', ...extra }
  });
}

before(async () => {
  installFakeDns();
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1' }
  });
  token = setup.body.data.token;

  [v2, go, conflicting] = await Promise.all([
    startEvolution('v2', '203.0.113.11'),
    startEvolution('go', '203.0.113.12'),
    startEvolution('go', '203.0.113.13')
  ]);

  await call(`${panelUrl}/api/whatsapp/config`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { enabled: true, webhookBaseUrl: WEBHOOK_BASE }
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  await Promise.all([v2, go, conflicting].map(
    (fake) => new Promise((resolve) => fake.server.close(resolve))
  ));
  await stopTestServers();
});

describe('creating an instance on an Evolution v2 server', () => {
  let account;

  it('detects the flavour by probe before building any payload', async () => {
    const { status, body } = await createAccount(v2.baseUrl, { label: 'Suporte', purpose: 'support' });
    assert.equal(status, 201);
    account = body.data.account;
    assert.equal(account.flavor, 'v2');
    assert.equal(account.purpose, 'support');
    assert.equal(account.status, 'connecting');

    const probes = v2.state.requests.filter((r) => r.method === 'GET' && ['/server/ok', '/'].includes(r.path));
    assert.deepEqual(probes.map((r) => r.path).sort(), ['/', '/server/ok']);
    // Both probes come before the create, or the payload would have been built
    // for a server we had not identified yet.
    assert.ok(v2.state.requests.indexOf(probes[0]) < v2.state.requests.indexOf(created(v2.state)));
  });

  it('sends the v2 payload, with the webhook inside the create', () => {
    const request = created(v2.state);
    assert.equal(request.apikey, 'chave-global');
    assert.equal(request.body.qrcode, true);
    assert.equal(request.body.integration, 'WHATSAPP-BAILEYS');
    // Both spellings: newer builds want `name`, older ones `instanceName`.
    assert.equal(request.body.instanceName, request.body.name);
    assert.equal(request.body.webhook.enabled, true);
    assert.ok(request.body.webhook.url.startsWith(`${WEBHOOK_BASE}?t=`));
    // byEvents would append the event name after the query and stop `?t=`
    // parsing as one — the webhook would then reject every event.
    assert.equal(request.body.webhook.byEvents, false);
    assert.ok(request.body.webhook.events.includes('QRCODE_UPDATED'));
    // GO-only fields must not appear, and vice versa.
    assert.equal(request.body.advancedSettings, undefined);
  });

  it('returns the QR the create already carried, without a second round trip', () => {
    assert.equal(v2.state.requests.filter((r) => r.path.startsWith('/instance/connect/')).length, 0);
    assert.equal(account.qrCode, 'data:image/png;base64,V2QR');
    assert.ok(account.qrUpdatedAt);
  });

  it('stores the key the server chose over the token it minted', async () => {
    const row = await WhatsAppAccount.getById(account.id);
    assert.equal(WhatsAppConfigService.decryptInstanceToken(row), 'server-key-v2');
    assert.equal(row.instance_id, 'v2-instance-id');
  });
});

describe('creating an instance on an Evolution GO server', () => {
  let account;

  it('creates, then connects — which is what actually starts the client', async () => {
    const { status, body } = await createAccount(go.baseUrl, { label: 'Cobrança', purpose: 'billing' });
    assert.equal(status, 201);
    account = body.data.account;
    assert.equal(account.flavor, 'go');

    const request = created(go.state);
    assert.ok(request.body.instanceId, 'our own id is sent: GO deletes by id, not by name');
    assert.ok(request.body.token);
    assert.equal(request.body.advancedSettings.rejectCall, true);
    // alwaysOnline stays false here and is true on v2: marking the device
    // always available suppresses the notification on the operator's phone.
    assert.equal(request.body.advancedSettings.alwaysOnline, false);
    assert.equal(request.body.advancedSettings.readMessages, false);
    assert.equal(request.body.qrcode, undefined);
    assert.equal(request.body.webhook, undefined);

    const connect = go.state.requests.find((r) => r.path === '/instance/connect');
    assert.ok(connect, 'without /instance/connect the instance exists and never connects');
    assert.ok(connect.body.webhookUrl.startsWith(`${WEBHOOK_BASE}?t=`));
    assert.ok(connect.body.subscribe.includes('QRCODE'));
    // The instance token, not the global key: GO picks the instance by header.
    assert.equal(connect.apikey, request.body.token);
  });

  it('asks for the QR separately, because the create had none', () => {
    assert.ok(go.state.requests.some((r) => r.path === '/instance/qr'));
    assert.equal(account.qrCode, 'data:image/png;base64,GOQR');
  });

  it('gives each number its own webhook secret', async () => {
    const rows = await WhatsAppAccount.getAll();
    const secrets = rows.map((row) => WhatsAppConfigService.decryptWebhookToken(row));
    assert.equal(new Set(secrets).size, rows.length);
    assert.ok(secrets.every((secret) => secret.length === 64));
  });
});

describe('an instance the server already has', () => {
  it('recovers its id from the listing instead of failing', async () => {
    conflicting.state.createStatus = 409;
    const { status, body } = await createAccount(conflicting.baseUrl);
    // "already in use" is the reconnect path: the row can be gone from the
    // panel while the instance is alive on the server.
    assert.equal(status, 201);
    const row = await WhatsAppAccount.getById(body.data.account.id);
    assert.equal(row.instance_id, 'go-recovered-id');
    assert.ok(conflicting.state.requests.some((r) => r.path === '/instance/all'));
  });
});

describe('a QR that is not ready yet', () => {
  let pendingAccount;

  it('reports GO\'s 400 as pending rather than as a failure', async () => {
    go.state.qrPending = true;
    const { status, body } = await createAccount(go.baseUrl);
    assert.equal(status, 201);
    assert.equal(body.data.pending, true);
    assert.equal(body.data.qr, null);
    // Still 'connecting': the whatsmeow client is booting, not broken.
    assert.equal(body.data.account.status, 'connecting');
    assert.equal(body.data.account.lastError, null);
    pendingAccount = body.data.account;
  });

  it('hands over the QR on the next ask', async () => {
    go.state.qrPending = false;
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${pendingAccount.id}/qr`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    assert.equal(body.data.pending, false);
    assert.equal(body.data.qr, 'data:image/png;base64,GOQR');
  });

  it('answers 404 for a number the panel does not have', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/999999/qr`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 404);
    assert.equal(body.code, 'account_not_found');
  });
});

describe('reading the connection state', () => {
  let account;

  before(async () => {
    const { body } = await createAccount(go.baseUrl, { label: 'Estado' });
    account = body.data.account;
  });

  it('does not demote a number that is still pairing', async () => {
    go.state.connected = false;
    go.state.loggedIn = false;
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/status`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    // The server is right and is reported, but a number that never connected
    // reads as disconnected for as long as its QR is on screen.
    assert.equal(body.data.state, 'disconnected');
    assert.equal(body.data.account.status, 'connecting');
  });

  it('promotes to connected, which is the escape hatch for a lost event', async () => {
    go.state.connected = true;
    go.state.loggedIn = true;
    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/status`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.state, 'connected');
    assert.equal(body.data.account.status, 'connected');
    // The QR is spent once the pairing lands.
    assert.equal(body.data.account.qrCode, null);
    assert.ok(body.data.account.lastSeenAt);
  });

  it('demotes only a number that was connected', async () => {
    go.state.connected = false;
    go.state.loggedIn = false;
    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/status`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.account.status, 'disconnected');
  });
});

describe('restart and disconnect', () => {
  let account;

  before(async () => {
    const { body } = await createAccount(v2.baseUrl, { label: 'Reinício' });
    account = body.data.account;
  });

  it('names "no active session" instead of dumping the server error', async () => {
    v2.state.restartStatus = 400;
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/restart`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 409);
    assert.equal(body.code, 'no_session');
  });

  it('restarts with the instance key, not the global one', async () => {
    v2.state.restartStatus = 200;
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/restart`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    assert.equal(body.data.account.status, 'connecting');
    const restart = v2.state.requests.filter((r) => r.path.startsWith('/instance/restart/')).pop();
    assert.equal(restart.apikey, 'server-key-v2');
  });

  it('logs out, which is the only way to force a new QR', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/disconnect`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    assert.equal(body.data.account.status, 'disconnected');
    assert.equal(body.data.account.qrCode, null);
  });
});

describe('editing what the panel knows about a number', () => {
  let account;

  before(async () => {
    const { body } = await createAccount(v2.baseUrl, { label: 'Antigo' });
    account = body.data.account;
  });

  it('renames, repurposes and moves the default flag', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/${account.id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: { label: 'Vendas', purpose: 'sales', isDefault: true }
    });
    assert.equal(status, 200);
    assert.equal(body.data.account.label, 'Vendas');
    assert.equal(body.data.account.purpose, 'sales');
    assert.equal(body.data.account.isDefault, true);

    // Exactly one row may carry the flag.
    const rows = await WhatsAppAccount.getAll();
    assert.equal(rows.filter((row) => row.is_default).length, 1);
  });

  it('refuses a purpose the router would not understand', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/accounts/${account.id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: { purpose: 'qualquer-coisa' }
    });
    assert.equal(status, 400);
  });
});

describe('checking numbers on WhatsApp', () => {
  before(async () => {
    // The check goes out through a connected number, so one has to exist.
    const { body } = await createAccount(v2.baseUrl, { label: 'Consulta' });
    v2.state.connected = true;
    await call(`${panelUrl}/api/whatsapp/accounts/${body.data.account.id}/status`, {
      headers: authHeaders(token)
    });
  });

  it('answers in the order asked, matching through the ninth-digit rewrite', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/check-number`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { numbers: ['+55 (93) 98111-0449', '5511999999999', '5500000000000'] }
    });
    assert.equal(status, 200);
    // The server answered '559381110449' — the same number without the ninth
    // digit. Matching it exactly would have reported a real number as absent.
    assert.deepEqual(body.data, [
      { number: '5593981110449', exists: true },
      { number: '5511999999999', exists: false },
      { number: '5500000000000', exists: false }
    ]);
  });
});

describe('removing a number', () => {
  it('drops the row even when the server refuses, and says so', async () => {
    const { body: createdBody } = await createAccount(v2.baseUrl, { label: 'Descartar' });
    const id = createdBody.data.account.id;
    v2.state.deleteStatus = 500;

    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/${id}`, {
      method: 'DELETE',
      headers: authHeaders(token),
      // Self-host: the server's global key lives in the request, not in the row.
      body: { adminKey: 'chave-global' }
    });
    assert.equal(status, 200);
    assert.equal(body.data.removedOnServer, false);
    assert.ok(body.data.serverError, 'an instance left running has to be reported');
    // Refusing to delete locally would leave the operator with a row they can
    // never get rid of.
    assert.equal(await WhatsAppAccount.getById(id), null);
  });

  it('reports a clean removal when the server agrees', async () => {
    const { body: createdBody } = await createAccount(v2.baseUrl, { label: 'Remover' });
    const id = createdBody.data.account.id;
    v2.state.deleteStatus = 200;

    const { body } = await call(`${panelUrl}/api/whatsapp/accounts/${id}`, {
      method: 'DELETE',
      headers: authHeaders(token),
      body: { adminKey: 'chave-global' }
    });
    assert.equal(body.data.removedOnServer, true);
    assert.equal(body.data.serverError, null);
    assert.ok(v2.state.requests.some((r) => r.method === 'DELETE' && r.path.startsWith('/instance/logout/')));
  });
});

describe('what reaches the browser', () => {
  it('never carries a stored secret, in any response', async () => {
    const rows = await WhatsAppAccount.getAll();
    const secrets = rows.flatMap((row) => [
      WhatsAppConfigService.decryptInstanceToken(row),
      WhatsAppConfigService.decryptWebhookToken(row)
    ]).filter(Boolean);
    assert.ok(secrets.length, 'the fixture would be vacuous without stored secrets');

    const listed = await call(`${panelUrl}/api/whatsapp/accounts`, { headers: authHeaders(token) });
    const fresh = await createAccount(v2.baseUrl, { label: 'Vazamento' });
    const status = await call(
      `${panelUrl}/api/whatsapp/accounts/${fresh.body.data.account.id}/status`,
      { headers: authHeaders(token) }
    );

    for (const payload of [listed.body, fresh.body, status.body]) {
      const serialized = JSON.stringify(payload);
      for (const secret of [...secrets, 'server-key-v2', 'chave-global']) {
        assert.equal(serialized.includes(secret), false, `${secret} leaked`);
      }
      assert.equal(serialized.includes('ciphertext'), false);
    }
  });

  it('requires an authenticated admin everywhere', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/accounts`, {
      method: 'POST',
      body: { baseUrl: v2.baseUrl }
    });
    assert.equal(status, 401);
  });
});

describe('with the integration switched off', () => {
  it('refuses to create anything', async () => {
    await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: false }
    });
    const { status, body } = await createAccount(v2.baseUrl);
    assert.equal(status, 400);
    assert.equal(body.code, 'not_configured');
  });

  it('refuses to create when the webhook URL is missing, since nothing would come back', async () => {
    await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { webhookBaseUrl: '' }
    });
    // Enabling without a webhook is refused by the config route itself, so the
    // state under test is reached by writing it directly.
    const { default: AppState } = await import('../src/models/AppState.js');
    const stored = JSON.parse(await AppState.get('whatsapp_evolution_config'));
    await AppState.upsert('whatsapp_evolution_config', JSON.stringify({
      ...stored, enabled: true, webhookBaseUrl: ''
    }));
    WhatsAppConfigService.invalidateConfigCache();

    const { status, body } = await createAccount(v2.baseUrl);
    assert.equal(status, 400);
    assert.equal(body.code, 'incomplete_config');
  });
});
