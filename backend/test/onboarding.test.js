import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const {
  default: OnboardingService, AGENT_ONLINE_WINDOW_MS, ONBOARDING_ITEMS, percentOf
} = await import('../src/services/onboardingService.js');
const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: GenieAcsConnection } = await import('../src/models/GenieAcsConnection.js');

/**
 * Os primeiros passos de um provedor novo.
 *
 * O checklist confere o que o provedor TEM — endereço do ACS, um equipamento
 * no ACS, um colega na equipe — e não uma marca clicada. E o "já vi" do
 * assistente mora no provedor, não no navegador: outro administrador, noutra
 * máquina, não pode receber o assistente de novo.
 */
let panelUrl;
let token;
let genie;
let tenantId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [buildDevice({ id: 'ONT-ONBOARD-1' })] });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dono', password: 'dono-password-1', email: 'dono@exemplo.test' }
  });
  token = setup.body.data.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

const status = async () => {
  const res = await call(`${panelUrl}/api/settings/onboarding`, { headers: authHeaders(token) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const feito = (data) => Object.fromEntries(data.items.map((item) => [item.key, item.done]));
const item = (data, key) => data.items.find((entry) => entry.key === key);

describe('primeiros passos', () => {
  it('um provedor recém-criado começa com tudo pendente e sem nada visto', async () => {
    const data = await status();
    assert.deepEqual(data.items.map((entry) => entry.key), [
      'genieacs', 'genieacsOnline', 'firstDevice', 'provisioning', 'sgp', 'asaas',
      'whatsapp', 'whatsappConnected', 'alerts', 'billingContact', 'team'
    ]);
    // Os seis itens de antes continuam lá, com a mesma chave e o mesmo `done`:
    // quem só conhecia eles não perde nenhum.
    for (const antigo of ['genieacs', 'firstDevice', 'provisioning', 'sgp', 'whatsapp', 'team']) {
      assert.ok(ONBOARDING_ITEMS.includes(antigo), antigo);
    }
    assert.ok(data.items.every((entry) => entry.done === false), JSON.stringify(data.items));
    assert.ok(data.items.every((entry) => typeof entry.href === 'string' && entry.href.startsWith('/')));
    assert.equal(data.wizardDone, false);
    assert.equal(data.checklistDismissed, false);
    assert.equal(data.wizardStep, null);
    assert.equal(data.percent, 0);
    assert.equal(data.nextStep, 'genieacs');
  });

  it('o agente do GenieACS só conta quando a conexão é pelo agente', async () => {
    const data = await status();
    assert.equal(item(data, 'genieacsOnline').applicable, false, 'conexão direta: não se aplica');
    assert.ok(data.items.filter((entry) => entry.key !== 'genieacsOnline').every((entry) => entry.applicable));
  });

  it('um ACS fora do ar deixa o primeiro equipamento pendente, sem derrubar a resposta', async () => {
    await asTenant(() => Setting.upsert('genieAcsUrl', 'http://127.0.0.1:9'));
    const itens = feito(await status());
    assert.equal(itens.genieacs, true);
    assert.equal(itens.firstDevice, false);
  });

  it('com o ACS respondendo e um colega na equipe, os itens se marcam sozinhos', async () => {
    await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
    const colegaId = await runInTenant(tenantId, () => User.create({
      username: 'colega', password: 'x'.repeat(60), role: 'tech'
    }));
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: colegaId, role: 'tech' }));

    const itens = feito(await status());
    assert.equal(itens.genieacs, true);
    assert.equal(itens.firstDevice, true);
    assert.equal(itens.team, true);
    assert.equal(itens.sgp, false);
  });

  it('recusa marcar como visto o que não é o assistente nem o checklist', async () => {
    const res = await call(`${panelUrl}/api/settings/onboarding/dismiss`, {
      method: 'POST', headers: authHeaders(token), body: { what: 'tudo' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_onboarding_target');
  });

  it('o "já vi" fica no provedor, e não vaza para o vizinho', async () => {
    for (const what of ['wizard', 'checklist']) {
      // eslint-disable-next-line no-await-in-loop -- uma marca por vez
      const res = await call(`${panelUrl}/api/settings/onboarding/dismiss`, {
        method: 'POST', headers: authHeaders(token), body: { what }
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const data = await status();
    assert.equal(data.wizardDone, true);
    assert.equal(data.checklistDismissed, true);

    const vizinho = await insertReturningId('tenants', { slug: 'vizinho', name: 'Provedor Vizinho', status: 'active' });
    const doVizinho = await runInTenant(vizinho, () => OnboardingService.status(vizinho));
    assert.equal(doVizinho.wizardDone, false, 'o assistente do vizinho não foi visto por ninguém');
    assert.equal(doVizinho.checklistDismissed, false);
  });
  it('o agente: aplicável no modo agente, "no ar" só se visto há menos de 10 minutos', async () => {
    await asTenant(() => GenieAcsConnection.setMode('agent'));
    try {
      let data = await status();
      assert.equal(item(data, 'genieacsOnline').applicable, true);
      assert.equal(item(data, 'genieacsOnline').done, false, 'nunca visto');

      const velho = new Date(Date.now() - AGENT_ONLINE_WINDOW_MS - 60_000);
      velho.setMilliseconds(0);
      await asTenant(() => getDb()('tenant_genieacs_connections').where({ tenant_id: tenantId }).update({ agent_last_seen_at: velho }));
      data = await status();
      assert.equal(item(data, 'genieacsOnline').done, false, 'visto há mais de 10 minutos');

      await GenieAcsConnection.touchAgent(tenantId);
      data = await status();
      assert.equal(item(data, 'genieacsOnline').done, true);
    } finally {
      await asTenant(() => GenieAcsConnection.setMode('direct'));
    }
  });

  it('Asaas pronto é a integração ligada e com chave', async () => {
    assert.equal(feito(await status()).asaas, false);
    await asTenant(() => AsaasProviderService.saveConfig({ environment: 'sandbox', apiKey: '$aact_hmlg_onboarding_teste' }));
    assert.equal(feito(await status()).asaas, false, 'chave sem ligar não é pronto');
    await asTenant(() => AsaasProviderService.saveConfig({ enabled: true }));
    assert.equal(feito(await status()).asaas, true);
  });

  it('WhatsApp: número cadastrado é um passo, número conectado é o seguinte', async () => {
    const conta = await asTenant(() => WhatsAppAccount.create({
      name: 'onboarding-num', purpose: 'support', flavor: 'v2', base_url: 'http://127.0.0.1:9', status: 'disconnected', is_default: true
    }));
    let itens = feito(await status());
    assert.equal(itens.whatsapp, true);
    assert.equal(itens.whatsappConnected, false);

    await asTenant(() => WhatsAppAccount.update(conta.id, { status: 'connected' }));
    itens = feito(await status());
    assert.equal(itens.whatsappConnected, true);
  });

  it('alertas prontos é o que a tela de alertas chama de pronto', async () => {
    assert.equal(feito(await status()).alerts, false);
    await asTenant(() => WaAlertService.saveSettings({ enabled: true, recipients: ['11999990000'] }));
    const ready = (await asTenant(() => WaAlertService.getPublicSettings())).ready;
    assert.equal(ready, true);
    assert.equal(feito(await status()).alerts, true);
  });

  it('contato de cobrança: e-mail ou telefone de cobrança do provedor', async () => {
    assert.equal(feito(await status()).billingContact, false);
    const res = await call(`${panelUrl}/api/tenant`, {
      method: 'PATCH', headers: authHeaders(token), body: { billing: { phone: '11 3333-4444' } }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(feito(await status()).billingContact, true);
  });

  it('o percentual conta só o aplicável, e o próximo passo é o primeiro pendente', async () => {
    const data = await status();
    const aplicaveis = data.items.filter((entry) => entry.applicable);
    const feitos = aplicaveis.filter((entry) => entry.done).length;
    assert.equal(data.percent, Math.round((feitos / aplicaveis.length) * 100));
    assert.equal(data.nextStep, aplicaveis.find((entry) => !entry.done)?.key ?? null);
    assert.equal(data.nextStep, 'provisioning');

    assert.equal(percentOf([]), 100);
    assert.equal(percentOf([
      { done: true, applicable: true }, { done: false, applicable: true }, { done: false, applicable: false }
    ]), 50);
    assert.equal(percentOf([{ done: true, applicable: true }, { done: false, applicable: false }]), 100);
  });

  it('o primeiro equipamento visto fica marcado, e o modo leve não pergunta ao ACS', async () => {
    const antes = genie.state.requests.length;
    const leve = await runInTenant(tenantId, () => OnboardingService.status(tenantId, { light: true }));
    assert.equal(genie.state.requests.length, antes, 'o modo leve não chamou o GenieACS');
    assert.equal(item(leve, 'firstDevice').done, true, 'o marco gravado pela leitura completa');

    const vizinho = await insertReturningId('tenants', { slug: 'vizinho-leve', name: 'Vizinho Leve', status: 'active' });
    await runInTenant(vizinho, () => Setting.upsert('genieAcsUrl', genie.url));
    const doVizinho = await runInTenant(vizinho, () => OnboardingService.status(vizinho, { light: true }));
    assert.equal(item(doVizinho, 'firstDevice').done, false, 'sem leitura completa, sem marco');
    assert.equal(genie.state.requests.length, antes);
  });

  it('o assistente retoma da etapa gravada, e recusa etapa que não existe', async () => {
    const ruim = await call(`${panelUrl}/api/settings/onboarding/step`, {
      method: 'PUT', headers: authHeaders(token), body: { step: 'qualquer' }
    });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'invalid_onboarding_step');

    const res = await call(`${panelUrl}/api/settings/onboarding/step`, {
      method: 'PUT', headers: authHeaders(token), body: { step: 'asaas' }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await status()).wizardStep, 'asaas');

    const vizinho = await insertReturningId('tenants', { slug: 'vizinho-etapa', name: 'Vizinho Etapa', status: 'active' });
    const doVizinho = await runInTenant(vizinho, () => OnboardingService.status(vizinho));
    assert.equal(doVizinho.wizardStep, null, 'a etapa é do provedor');
  });
});
