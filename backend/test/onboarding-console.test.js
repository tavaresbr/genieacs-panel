import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: OnboardingService } = await import('../src/services/onboardingService.js');

/**
 * O progresso dos primeiros passos visto do console.
 *
 * Sai do mesmo `status()` do checklist do provedor, lido no escopo de CADA
 * um — o Asaas de um não pode aparecer como pronto no vizinho —, no modo leve
 * (o console não pergunta ao GenieACS de ninguém) e com cache curto.
 */
let panelUrl;
let token;
let genie;
const ids = {};

/** Data de criação a segundos inteiros: o MySQL arredonda os milissegundos. */
function diasAtras(dias) {
  const data = new Date(Date.now() - dias * 86400000);
  data.setMilliseconds(0);
  return data;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [buildDevice({ id: 'ONT-CONSOLE-1' })] });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'plataforma', password: 'plataforma-senha-1', email: 'plataforma@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  token = setup.body.data.token;

  ids.pronto = await insertReturningId('tenants', {
    slug: 'console-pronto', name: 'Pronto', status: 'active', kind: 'provider', created_at: diasAtras(30),
    billing_email: 'cobranca@pronto.test'
  });
  ids.travado = await insertReturningId('tenants', {
    slug: 'console-travado', name: 'Travado', status: 'active', kind: 'provider', created_at: diasAtras(10)
  });
  ids.novo = await insertReturningId('tenants', {
    slug: 'console-novo', name: 'Novo', status: 'active', kind: 'provider', created_at: diasAtras(1)
  });

  await runInTenant(ids.pronto, async () => {
    await Setting.upsert('genieAcsUrl', genie.url);
    await AsaasProviderService.saveConfig({ enabled: true, environment: 'sandbox', apiKey: '$aact_hmlg_console_teste' });
  });
  // O travado tem ACS apontado para o stub: se o console perguntasse ao
  // GenieACS, o stub contaria o pedido.
  await runInTenant(ids.travado, () => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

const resumos = async () => {
  const res = await call(`${panelUrl}/api/platform/tenants/onboarding`, { headers: authHeaders(token) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return new Map(res.body.data.summaries.map((summary) => [summary.tenantId, summary]));
};

describe('onboarding no console', () => {
  it('cada provedor com o próprio percentual, sem vazar o Asaas do vizinho', async () => {
    OnboardingService.clearSummaryCache();
    const mapa = await resumos();
    const pronto = mapa.get(ids.pronto);
    const travado = mapa.get(ids.travado);
    const novo = mapa.get(ids.novo);
    assert.ok(pronto && travado && novo, JSON.stringify([...mapa.values()]));

    // Pronto: ACS + Asaas + contato de cobrança; o travado só o ACS.
    assert.equal(pronto.done, 3);
    assert.equal(travado.done, 1);
    assert.equal(novo.done, 0);
    assert.ok(pronto.percent > travado.percent);
    // O agente não se aplica a nenhum (conexão direta): fica fora do total.
    assert.equal(pronto.total, 10);
    assert.equal(pronto.percent, Math.round((3 / 10) * 100));
    assert.equal(travado.nextStep, 'firstDevice');
  });

  it('"travado" é abaixo de 50% depois de 7 dias', async () => {
    const mapa = await resumos();
    assert.equal(mapa.get(ids.travado).stuck, true);
    assert.equal(mapa.get(ids.pronto).stuck, true, '30% depois de 30 dias também é travado');
    assert.equal(mapa.get(ids.novo).stuck, false, 'um dia de vida ainda não travou');
  });

  it('o console não pergunta ao GenieACS de ninguém', async () => {
    OnboardingService.clearSummaryCache();
    const antes = genie.state.requests.length;
    await resumos();
    assert.equal(genie.state.requests.length, antes);
  });

  it('o resumo fica em cache: mudar o provedor só aparece depois que ele vence', async () => {
    OnboardingService.clearSummaryCache();
    const antes = (await resumos()).get(ids.novo);
    await getDb()('tenants').where({ id: ids.novo }).update({ billing_phone: '11999990000' });
    assert.equal((await resumos()).get(ids.novo).done, antes.done, 'ainda o do cache');
    OnboardingService.clearSummaryCache();
    assert.equal((await resumos()).get(ids.novo).done, antes.done + 1);
  });

  it('muitos provedores respondem rápido, com a concorrência limitada', async () => {
    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixture
      await insertReturningId('tenants', { slug: `console-massa-${i}`, name: `Massa ${i}`, status: 'active', kind: 'provider' });
    }
    OnboardingService.clearSummaryCache();
    const inicio = Date.now();
    const mapa = await resumos();
    const ms = Date.now() - inicio;
    assert.ok(mapa.size >= 43, `${mapa.size} resumos`);
    assert.ok(ms < 10_000, `${ms} ms para ${mapa.size} provedores`);
  });

  it('só a plataforma lê o resumo', async () => {
    const dono = await call(`${panelUrl}/api/platform/tenants/onboarding`, { headers: {} });
    assert.equal(dono.status, 401);
  });
});
