import { after, before, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: SgpContact } = await import('../src/models/SgpContact.js');

/**
 * Vincular a ONT a um contrato que o SGP não devolve na consulta mas que o
 * cadastro sincronizado já tem, e achar o contrato por mais do que o número.
 *
 * O caso real: o cliente tem os contratos 350 e 351, a consulta do SGP por
 * `contrato=351` volta sem o 351, e a página da ONT recusava o vínculo — o
 * operador via o contrato em Contatos e não conseguia usá-lo.
 */

const DEVICE = 'ont-busca';
const OUTRA = 'ont-outra';

const CONFIG = {
  enabled: true,
  baseUrl: 'https://sgp.provedor.test',
  app: 'painel',
  token: 'token',
  endpoints: { customer: '/api/ura/consultacliente/' },
  linkMode: 'auto'
};

const getConfigReal = SgpService.getConfig;
const requestReal = SgpService.request;
const reportedReal = SgpService.reportedPppoeLogin;

const CONTATOS = [
  { contract: '350', client_name: 'ELIAS FERNANDES GONCLAVES', document: '11122233344', login: 'TA100.310', state: 'active', plan: 'Fibra', status_label: 'Ativo' },
  { contract: '351', client_name: 'ELIAS FERNANDES GONCLAVES', document: '11122233344', login: 'TA100.310.1', state: 'active', plan: 'Fibra', status_label: 'Ativo' },
  { contract: '471', client_name: 'MARIA SOUZA', document: '99988877766', login: 'maria@vila', state: 'blocked', plan: 'Fibra', status_label: 'Bloqueado' }
];

// O SGP responde, mas só com o 350: o 351 não vem.
function stubSgp() {
  SgpService.getConfig = async () => ({ ...CONFIG });
  SgpService.request = async () => ({
    status: 1,
    contratos: [{ contrato: 350, contratoStatus: 1, contratoStatusDisplay: 'Ativo', login: 'TA100.310', bloqueado: false }]
  });
}

let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
  assert.ok(panelUrl);
  await asTenant(async () => {
    for (const row of CONTATOS) await SgpContact.upsertFromSgp(row);
  });
});

afterEach(async () => {
  SgpService.getConfig = getConfigReal;
  SgpService.request = requestReal;
  SgpService.reportedPppoeLogin = reportedReal;
  await asTenant(async () => {
    await SgpLink.deleteByDeviceId(DEVICE);
    await SgpLink.deleteByDeviceId(OUTRA);
  });
});

after(async () => {
  await asTenant(() => getDb()('sgp_contacts').whereIn('contract', CONTATOS.map((c) => c.contract)).del());
  await stopTestServers();
});

describe('vincular um contrato que só o cadastro sincronizado tem', () => {
  it('vincula como manual, com o estado e o login do cadastro', async () => {
    stubSgp();
    const link = await asTenant(() => SgpService.linkDevice(DEVICE, { contract: '351' }));
    assert.equal(link.contract, '351');
    assert.equal(link.link_mode, 'manual');
    assert.equal(link.state, 'active');
    assert.equal(link.login, 'TA100.310.1');
    assert.equal(link.client_name, 'ELIAS FERNANDES GONCLAVES');
  });

  it('continua recusando o que nem o SGP nem o cadastro têm', async () => {
    stubSgp();
    await assert.rejects(
      () => asTenant(() => SgpService.linkDevice(DEVICE, { contract: '9999' })),
      (error) => error.translationKey === 'sgp.error.contractNotFound' && error.status === 404
    );
    assert.ok(!(await asTenant(() => SgpLink.getByDeviceId(DEVICE))));
  });

  it('prefere o que o SGP devolve quando ele devolve o contrato', async () => {
    stubSgp();
    const link = await asTenant(() => SgpService.linkDevice(DEVICE, { contract: '350' }));
    assert.equal(link.contract, '350');
    assert.equal(link.status_label, 'Ativo');
  });
});

describe('buscar o contrato', () => {
  it('acha pelo número, pelo nome, pelo CPF e pelo login', async () => {
    const find = async (q) => (await asTenant(() => SgpContact.search(q))).map((row) => row.contract);
    assert.deepEqual(await find('471'), ['471']);
    assert.deepEqual((await find('elias')).sort(), ['350', '351']);
    assert.deepEqual(await find('999.888.777-66'.replace(/\D/g, '')), ['471']);
    assert.deepEqual(await find('maria@'), ['471']);
    assert.deepEqual(await find('TA100.310.1'), ['351']);
  });

  it('não devolve a tabela inteira para um termo que só tem curinga', async () => {
    assert.deepEqual(await asTenant(() => SgpContact.search('%_')), []);
    assert.deepEqual(await asTenant(() => SgpContact.search('   ')), []);
  });

  it('sugere o contrato cujo login é o da ONT, e avisa de quem já tem ONT', async () => {
    SgpService.reportedPppoeLogin = async () => ({ login: 'ta100.310.1', state: 'found' });
    await asTenant(() => SgpLink.upsert({
      device_id: OUTRA, contract: '350', link_mode: 'auto', state: 'active', last_synced_at: new Date()
    }));
    const found = await asTenant(() => SgpService.searchContracts('elias', { deviceId: DEVICE }));
    assert.deepEqual(found.suggestions.map((row) => row.contract), ['351']);
    assert.equal(found.reportedLogin, 'ta100.310.1');
    const c350 = found.results.find((row) => row.contract === '350');
    assert.deepEqual(c350.linkedDevices, [OUTRA]);
    assert.deepEqual(found.results.find((row) => row.contract === '351').linkedDevices, []);
  });
});
