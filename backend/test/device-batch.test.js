import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const {
  BATCH_LIMIT, batchFilterLabel, batchSummary, mapWithLimit, normalizeBatchIds
} = await import('../src/services/deviceBatch.js');

/**
 * Reiniciar vários equipamentos de uma vez.
 *
 * O que estes casos defendem: o teto segura o clique que mandaria a frota
 * inteira; uma ONT que falha não derruba as outras e aparece como falha
 * daquela ONT; o ACS fora do ar para o lote ANTES de mandar qualquer coisa; e
 * a trilha tem UMA linha por lote, dizendo quantas e qual recorte.
 */
const IDS = ['ONT-LOTE-1', 'ONT-LOTE-2', 'ONT-LOTE-3'];

let panelUrl;
let token;
let genie;

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: IDS.map((id) => buildDevice({ id })) });
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

beforeEach(() => {
  genie.state.respond = null;
  genie.state.taskStatus = 200;
  genie.state.taskStatusFor = null;
  genie.state.tasks.length = 0;
});

const post = (body) => call(`${panelUrl}/api/devices/batch`, { method: 'POST', headers: authHeaders(token), body });
const linhas = () => getDb()('audit_log').where({ action: AuditLog.ACTIONS.DEVICE_BATCH_ACTION }).orderBy('id', 'asc');
const reboots = () => genie.state.tasks.filter((entry) => entry.task?.name === 'reboot').map((entry) => entry.deviceId);

describe('o lote, sem rede', () => {
  it('ids limpos: sem vazio, sem repetição, na ordem em que vieram', () => {
    assert.deepEqual(normalizeBatchIds([' a ', 'b', 'a', 'c']), ['a', 'b', 'c']);
    for (const ruim of [null, 'a', {}, [1], ['a', ''], ['a', '   '], ['x'.repeat(257)]]) {
      assert.equal(normalizeBatchIds(ruim), null, JSON.stringify(ruim));
    }
    assert.deepEqual(normalizeBatchIds([]), []);
  });

  it('o recorte guarda só os campos do filtro, curtos, e nada quando não há filtro', () => {
    assert.deepEqual(batchFilterLabel({ status: 'offline', focus: 'all', search: ' vila ', outro: 'x' }), { status: 'offline', search: 'vila' });
    assert.equal(batchFilterLabel({ status: 'all' }), null);
    assert.equal(batchFilterLabel('offline'), null);
    assert.equal(batchFilterLabel({ search: 'x'.repeat(100) }).search.length, 64);
  });

  it('as contagens', () => {
    assert.deepEqual(
      batchSummary([{ outcome: 'sent' }, { outcome: 'queued' }, { outcome: 'failed' }, { outcome: 'sent' }]),
      { total: 4, sent: 2, queued: 1, failed: 1 }
    );
  });

  it('roda no máximo N de uma vez, devolve na ordem, e um erro fica no seu item', async () => {
    let rodando = 0;
    let pico = 0;
    const saida = await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      rodando += 1;
      pico = Math.max(pico, rodando);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      rodando -= 1;
      if (n === 4) throw new Error('quatro');
      return n * 10;
    });
    assert.equal(pico, 3);
    assert.deepEqual(saida.filter((item) => typeof item === 'number'), [10, 20, 30, 50, 60, 70]);
    assert.equal(saida[3].error.message, 'quatro');
  });
});

describe('reiniciar em lote', () => {
  it('cada ONT recebe o reinício e tem o seu resultado; o id que o ACS não conhece falha sozinho', async () => {
    const antes = (await linhas()).length;
    const { status, body } = await post({
      action: 'reboot',
      deviceIds: [...IDS, 'NAO-EXISTE', IDS[0]],
      filter: { status: 'offline', search: 'vila' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(reboots().sort(), [...IDS].sort());
    assert.deepEqual(body.data.summary, { total: 4, sent: 3, queued: 0, failed: 1 });
    assert.deepEqual(
      body.data.results.map((result) => [result.deviceId, result.outcome, result.reason]),
      [[IDS[0], 'sent', null], [IDS[1], 'sent', null], [IDS[2], 'sent', null], ['NAO-EXISTE', 'failed', 'not_found']]
    );

    const depois = await linhas();
    assert.equal(depois.length, antes + 1, 'um lote é UMA linha');
    assert.deepEqual(JSON.parse(depois.at(-1).detail), {
      action: 'reboot', total: 4, sent: 3, queued: 0, failed: 1, filter: { status: 'offline', search: 'vila' }
    });
  });

  it('uma ONT que o ACS recusa não derruba as outras', async () => {
    genie.state.taskStatusFor = (deviceId) => (deviceId === IDS[1] ? 500 : undefined);
    const { status, body } = await post({ action: 'reboot', deviceIds: IDS });
    assert.equal(status, 200);
    assert.deepEqual(
      body.data.results.map((result) => [result.deviceId, result.outcome, result.reason]),
      [[IDS[0], 'sent', null], [IDS[1], 'failed', 'acs_error'], [IDS[2], 'sent', null]]
    );
  });

  it('ONT fora do ar fica na fila, e o resultado diz isso', async () => {
    genie.state.taskStatusFor = (deviceId) => (deviceId === IDS[2] ? 202 : undefined);
    const { body } = await post({ action: 'reboot', deviceIds: IDS });
    assert.deepEqual(body.data.summary, { total: 3, sent: 2, queued: 1, failed: 0 });
    assert.equal(body.data.results[2].outcome, 'queued');
  });

  it(`acima de ${BATCH_LIMIT} aparelhos: 400, nada sai`, async () => {
    const muitos = Array.from({ length: BATCH_LIMIT + 1 }, (_, i) => `ONT-${i}`);
    const { status, body } = await post({ action: 'reboot', deviceIds: muitos });
    assert.equal(status, 400);
    assert.equal(body.code, 'batch_too_large');
    assert.equal(genie.state.tasks.length, 0);
  });

  it('ação desconhecida, lista vazia ou que não é de ids: 400, nada sai e nada entra na trilha', async () => {
    const antes = (await linhas()).length;
    const casos = [
      [{ action: 'factory-reset', deviceIds: IDS }, 'invalid_action'],
      [{ action: 'reboot', deviceIds: [] }, 'invalid_devices'],
      [{ action: 'reboot', deviceIds: 'ONT-LOTE-1' }, 'invalid_devices'],
      [{ action: 'reboot', deviceIds: [42] }, 'invalid_devices']
    ];
    for (const [corpo, code] of casos) {
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez
      const { status, body } = await post(corpo);
      assert.equal(status, 400, JSON.stringify(corpo));
      assert.equal(body.code, code);
    }
    assert.equal(genie.state.tasks.length, 0);
    assert.equal((await linhas()).length, antes);
  });

  it('com o ACS fora do ar o lote para antes de mandar qualquer coisa', async () => {
    genie.state.respond = ({ send }) => send(500, { message: 'down' });
    const antes = (await linhas()).length;
    const { status } = await post({ action: 'reboot', deviceIds: IDS });
    assert.equal(status, 502);
    assert.equal(genie.state.tasks.length, 0);
    assert.equal((await linhas()).length, antes);
  });
});
