import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { asTenant, authHeaders, call, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: MapStatusService, classifyNode } = await import('../src/services/mapStatusService.js');

/**
 * Estado ao vivo na Topologia (`GET /api/mapping-data/status`).
 *
 * O ponto do mapa encontra o equipamento pelo PPPoE. O que se defende: online,
 * sinal fraco, offline e desconhecido saem certos; login com maiúscula ou
 * espaço ainda casa; ponto sem PPPoE fica de fora; sem ponto com PPPoE o ACS
 * nem é consultado; ACS fora do ar vira 502 com o motivo.
 */
let panelUrl;
let token;
let genie;
const velho = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({
    devices: [
      buildDevice({ id: 'ONT-BOA', pppoeUsername: 'ana@vila', rxPower: -20 }),
      buildDevice({ id: 'ONT-FRACA', pppoeUsername: 'bia@vila', rxPower: -29.5 }),
      buildDevice({ id: 'ONT-OFF', pppoeUsername: 'caio@vila', rxPower: -21, lastInform: velho })
    ]
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

afterEach(() => {
  genie.state.respond = null;
  MapStatusService.clearCache();
});

const status = () => call(`${panelUrl}/api/mapping-data/status`, { headers: authHeaders(token) });
const ponto = (node_id, pppoe) => call(`${panelUrl}/api/mapping-data/nodes`, {
  method: 'POST',
  headers: authHeaders(token),
  body: { node_id, type: 'ont', name: node_id, latitude: -4.27, longitude: -55.98, ...(pppoe ? { pppoe } : {}) }
});

describe('GET /api/mapping-data/status', () => {
  it('sem ponto com PPPoE, lista vazia e nenhuma consulta ao ACS', async () => {
    await ponto('caixa-sem-login');
    const antes = genie.state.requests.length;
    const res = await status();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.items, []);
    assert.equal(genie.state.requests.length, antes);
  });

  it('online, fraco, offline e desconhecido; login casa sem diferenciar maiúscula', async () => {
    await ponto('cli-ana', ' ANA@vila ');
    await ponto('cli-bia', 'bia@vila');
    await ponto('cli-caio', 'caio@vila');
    await ponto('cli-ze', 'ze@vila');
    const res = await status();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const porId = Object.fromEntries(res.body.data.items.map((item) => [item.node_id, item]));
    assert.equal(porId['cli-ana'].state, 'online');
    assert.equal(porId['cli-ana'].deviceId, 'ONT-BOA');
    assert.equal(porId['cli-bia'].state, 'weak');
    assert.equal(porId['cli-bia'].rxPower, -29.5);
    assert.equal(porId['cli-caio'].state, 'offline');
    assert.equal(porId['cli-ze'].state, 'unknown');
    assert.equal(porId['caixa-sem-login'], undefined);
    assert.deepEqual(res.body.data.summary, { online: 1, weak: 1, offline: 1, unknown: 1 });
  });

  it('ACS fora do ar vira 502 com o motivo', async () => {
    genie.state.respond = ({ send }) => send(401, {});
    const res = await status();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'genieacs_http');
    assert.match(res.body.message, /401/);
  });

  it('sem sessão, 401', async () => {
    assert.equal((await call(`${panelUrl}/api/mapping-data/status`)).status, 401);
  });
});

describe('classifyNode', () => {
  it('RX ausente não é sinal fraco', () => {
    assert.equal(classifyNode({ online: true, rxPower: null }), 'online');
    assert.equal(classifyNode({ online: true, rxPower: -27 }), 'online');
    assert.equal(classifyNode({ online: true, rxPower: -27.1 }), 'weak');
    assert.equal(classifyNode(null), 'unknown');
  });
});
