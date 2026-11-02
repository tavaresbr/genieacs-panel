import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { call, authHeaders, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: AsaasProviderService, AsaasProviderError } = await import('../src/services/asaasProviderService.js');
const { testConnection, AsaasError } = await import('../src/services/billing/asaasClient.js');
const { default: AppState } = await import('../src/models/AppState.js');
const { runInTenant } = await import('../src/config/tenantContext.js');

/**
 * A conta Asaas do PROVEDOR: a chave dele, guardada cifrada, nunca devolvida, e
 * enviada ao gateway no cabeçalho certo — sem trocar pela da plataforma.
 */
const CHAVE_PLATAFORMA = 'chave-da-plataforma';
const CHAVE_SANDBOX = '$aact_hmlg_000000000000000000000000000000000000000';
const CHAVE_PROD = '$aact_prod_000000000000000000000000000000000000000';

let gateway;
let recebidas = [];
let panelUrl;
let tenantId;
let token;

function subirGateway() {
  gateway = http.createServer((req, res) => {
    recebidas.push({ path: req.url, accessToken: req.headers.access_token });
    const ok = req.headers.access_token === CHAVE_SANDBOX;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { companyName: 'Provedor Alfa' } : { errors: [{ code: 'invalid_access_token' }] }));
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

const dentro = (fn) => runInTenant(tenantId, fn);

before(async () => {
  process.env.ASAAS_API_KEY = CHAVE_PLATAFORMA;
  ({ panelUrl } = await startTestServers());
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dona-alfa', password: 'senha-da-dona-1', email: 'dona-alfa@exemplo.test' }
  });
  const login = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST',
    body: { username: 'dona-alfa', password: 'senha-da-dona-1' }
  });
  token = login.body?.data?.token ?? login.body?.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  if (gateway) await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

describe('o cliente HTTP com a credencial de um provedor', () => {
  it('envia a chave do provedor, e não a da plataforma', async () => {
    const base = await subirGateway();
    recebidas = [];
    const res = await testConnection({ apiKey: CHAVE_SANDBOX, baseUrl: base });
    assert.deepEqual(res, { accountName: 'Provedor Alfa' });
    assert.equal(recebidas[0].path, '/myAccount/commercialInfo');
    assert.equal(recebidas[0].accessToken, CHAVE_SANDBOX);
  });

  it('a chave recusada sobe como unauthorized e vira uma frase para a tela', async () => {
    await assert.rejects(
      testConnection({ apiKey: 'errada', baseUrl: `http://127.0.0.1:${gateway.address().port}` }),
      (error) => {
        assert.ok(error instanceof AsaasError);
        assert.equal(error.code, 'unauthorized');
        const traduzido = AsaasProviderService.translateGatewayError(error);
        assert.equal(traduzido.translationKey, 'asaas.error.unauthorized');
        assert.equal(traduzido.status, 400, '401 do gateway não pode parecer sessão expirada');
        return true;
      }
    );
  });
});

describe('a configuração do provedor', () => {
  it('começa desligada, no sandbox, sem chave', async () => {
    const config = await dentro(() => AsaasProviderService.getPublicConfig());
    assert.equal(config.enabled, false);
    assert.equal(config.environment, 'sandbox');
    assert.equal(config.apiKeyConfigured, false);
    assert.equal(config.ready, false);
  });

  it('guarda a chave cifrada e nunca a devolve', async () => {
    const publica = await dentro(() => AsaasProviderService.saveConfig({
      enabled: true, environment: 'sandbox', apiKey: CHAVE_SANDBOX
    }));
    assert.equal(publica.apiKeyConfigured, true);
    assert.equal(publica.ready, true);
    assert.ok(!JSON.stringify(publica).includes('aact'), 'a chave vazou na resposta pública');

    const bruto = await dentro(() => AppState.get('asaas_provider_config'));
    assert.ok(!bruto.includes(CHAVE_SANDBOX), 'a chave está em claro no banco');
    const lida = await dentro(() => AsaasProviderService.getConfig());
    assert.equal(lida.apiKey, CHAVE_SANDBOX);
  });

  it('omitir a chave mantém a guardada', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ enabled: true }));
    const lida = await dentro(() => AsaasProviderService.getConfig());
    assert.equal(lida.apiKey, CHAVE_SANDBOX);
  });

  it('trocar de ambiente sem digitar a chave nova é recusado', async () => {
    await assert.rejects(
      dentro(() => AsaasProviderService.saveConfig({ environment: 'production' })),
      (error) => error instanceof AsaasProviderError && error.code === 'key_required'
    );
  });

  it('uma chave de produção no sandbox é recusada', async () => {
    await assert.rejects(
      dentro(() => AsaasProviderService.saveConfig({ environment: 'sandbox', apiKey: CHAVE_PROD })),
      (error) => error.code === 'key_environment_mismatch'
    );
  });

  it('um ambiente que não existe é recusado — o endereço nunca é digitado', async () => {
    await assert.rejects(
      dentro(() => AsaasProviderService.saveConfig({ environment: 'https://outro.exemplo' })),
      (error) => error.code === 'invalid_environment'
    );
  });

  it('chave com espaço é recusada', async () => {
    await assert.rejects(
      dentro(() => AsaasProviderService.saveConfig({ apiKey: 'tem espaco' })),
      (error) => error.code === 'invalid_key'
    );
  });

  it('apagar a chave desliga a integração', async () => {
    const publica = await dentro(() => AsaasProviderService.saveConfig({ apiKey: '' }));
    assert.equal(publica.apiKeyConfigured, false);
    assert.equal(publica.enabled, false);
  });

  it('ligar sem chave é recusado', async () => {
    await assert.rejects(
      dentro(() => AsaasProviderService.saveConfig({ enabled: true })),
      (error) => error.code === 'incomplete_config'
    );
  });

  it('testar sem chave nenhuma diz que falta a chave', async () => {
    await assert.rejects(
      dentro(() => AsaasProviderService.testConnection()),
      (error) => error.code === 'not_configured'
    );
  });
});

describe('as rotas /api/asaas', () => {
  it('recusam quem não está logado', async () => {
    const res = await call(`${panelUrl}/api/asaas/config`);
    assert.ok([401, 403].includes(res.status), String(res.status));
  });

  it('o dono lê e grava, e a chave não volta', async () => {
    const put = await call(`${panelUrl}/api/asaas/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: true, environment: 'sandbox', apiKey: CHAVE_SANDBOX }
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const get = await call(`${panelUrl}/api/asaas/config`, { headers: authHeaders(token) });
    assert.equal(get.status, 200);
    assert.equal(get.body.data.apiKeyConfigured, true);
    assert.ok(!JSON.stringify(get.body).includes('aact'));
  });

  it('um erro de validação sai como 400 com código, na língua do painel', async () => {
    const res = await call(`${panelUrl}/api/asaas/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { environment: 'production' }
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'key_required');
  });
});
