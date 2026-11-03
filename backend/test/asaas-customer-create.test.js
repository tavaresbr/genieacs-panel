import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: AsaasProviderCustomerService } = await import('../src/services/asaasProviderCustomerService.js');
const { default: AsaasCustomer } = await import('../src/models/AsaasCustomer.js');

/**
 * "Criar no Asaas": a única escrita da integração. Provas que importam:
 * nunca dois clientes com o mesmo CPF/CNPJ, nada acontece com a opção
 * desligada, e a recusa do Asaas chega ao operador com o motivo dele.
 */
const CHAVE = '$aact_hmlg_criar-cliente';
const DOC = '52998224725';

let panelUrl;
let token;
let gateway;
let base;
let pedidos;
let remotos;
let recusa;

function subir() {
  gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
      pedidos.push({ method: req.method, path: url.pathname, query: url.search, payload, key: req.headers.access_token });
      const responder = (s, c) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(c)); };
      if (req.headers.access_token !== CHAVE) return responder(401, {});
      if (req.method === 'GET' && url.pathname === '/customers') {
        const doc = url.searchParams.get('cpfCnpj');
        return responder(200, { object: 'list', hasMore: false, data: remotos.filter((r) => r.cpfCnpj === doc) });
      }
      if (req.method === 'POST' && url.pathname === '/customers') {
        if (recusa) return responder(400, { errors: [{ code: 'invalid_cpfCnpj', description: 'O CPF/CNPJ informado é inválido.' }] });
        return responder(200, { id: 'cus_novo', ...payload, cityName: 'São Paulo', state: 'SP' });
      }
      return responder(404, {});
    });
  });
  return new Promise((r) => gateway.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${gateway.address().port}`)));
}

const dentro = (fn) => asTenant(fn);
const criar = (key = 'c:1') => call(`${panelUrl}/api/contacts/${encodeURIComponent(key)}/asaas`, { method: 'POST', headers: authHeaders(token) });

let contatoKey;
async function semearContato({ document = DOC, name = 'Maria Souza' } = {}) {
  const tenantId = (await getDb()('tenants').first()).id;
  await getDb()('sgp_contacts').del();
  await getDb()('sgp_clients').del();
  const res = await call(`${panelUrl}/api/contacts`, {
    method: 'POST', headers: authHeaders(token),
    body: {
      name, document, personType: 'PF', whatsappPhone: '(11) 98888-7777', emails: ['maria@exemplo.test'],
      address: { street: 'Rua A', number: '10', district: 'Centro', city: 'São Paulo', state: 'SP', zip: '01001-000' }
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  contatoKey = res.body.data.key;
  void tenantId;
}

before(async () => {
  base = await subir();
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-gama', password: 'senha-da-dona-1', email: 'dona-gama@exemplo.test' }
  });
  token = setup.body.data.token;
  AsaasProviderCustomerService.credentialFor = () => ({ apiKey: CHAVE, baseUrl: base });
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  pedidos = [];
  remotos = [];
  recusa = false;
  await getDb()('asaas_customers').del();
  await dentro(() => AsaasProviderService.saveConfig({
    enabled: true, environment: 'sandbox', apiKey: CHAVE, allowWriteCustomers: true
  }));
  await semearContato();
});

describe('criar o cliente do painel no Asaas', () => {
  it('cria com o CPF, o telefone sem DDI e o endereço da ficha, e guarda o que o Asaas devolveu', async () => {
    const res = await criar(contatoKey);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created, true);
    assert.equal(res.body.data.customer.asaasId, 'cus_novo');

    const post = pedidos.find((p) => p.method === 'POST');
    assert.equal(post.key, CHAVE, 'tem de usar a credencial do provedor');
    assert.equal(post.payload.cpfCnpj, DOC);
    assert.equal(post.payload.name, 'Maria Souza');
    assert.equal(post.payload.mobilePhone, '11988887777');
    assert.equal(post.payload.postalCode, '01001000');
    assert.equal(post.payload.address, 'Rua A');
    assert.equal(post.payload.province, 'Centro');
    assert.equal(post.payload.email, 'maria@exemplo.test');
    assert.equal(post.payload.externalReference, `painel:${contatoKey}`);
    assert.equal(post.payload.notificationDisabled, true, 'o cliente nasce sem as notificações do Asaas');

    const guardado = await dentro(() => AsaasCustomer.listByDocument(DOC));
    assert.equal(guardado.length, 1);
    assert.equal(guardado[0].asaas_id, 'cus_novo');
  });

  it('a segunda vez só liga: o cliente já está no banco e nada vai ao Asaas', async () => {
    await criar(contatoKey);
    pedidos = [];
    const res = await criar(contatoKey);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.created, false);
    assert.equal(pedidos.length, 0, 'não podia falar com o Asaas');
  });

  it('um cliente que o Asaas já tem (e a importação não viu) é ligado, não duplicado', async () => {
    remotos = [{ id: 'cus_ja_existia', name: 'Maria S.', cpfCnpj: DOC }];
    const res = await criar(contatoKey);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.created, false);
    assert.equal(res.body.data.customer.asaasId, 'cus_ja_existia');
    assert.ok(!pedidos.some((p) => p.method === 'POST'), 'criou um segundo cliente');
    assert.equal((await dentro(() => AsaasCustomer.listByDocument(DOC)))[0].asaas_id, 'cus_ja_existia');
  });

  it('com a opção desligada, nada acontece e o Asaas nem é chamado', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ allowWriteCustomers: false }));
    const res = await criar(contatoKey);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'write_disabled');
    assert.equal(pedidos.length, 0);
  });

  it('sem a integração ligada, 409 not_configured', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ enabled: false }));
    const res = await criar(contatoKey);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'not_configured');
  });

  it('contato sem CPF/CNPJ válido não vai ao Asaas', async () => {
    const res = await call(`${panelUrl}/api/contacts`, {
      method: 'POST', headers: authHeaders(token), body: { name: 'Sem Documento' }
    });
    const sem = await criar(res.body.data.key);
    assert.equal(sem.status, 400, JSON.stringify(sem.body));
    assert.equal(sem.body.code, 'document_required');
    assert.equal(pedidos.length, 0);
  });

  it('a recusa do Asaas chega com o motivo dele, e nada é guardado', async () => {
    recusa = true;
    const res = await criar(contatoKey);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /CPF\/CNPJ informado é inválido/);
    assert.equal((await dentro(() => AsaasCustomer.listByDocument(DOC))).length, 0);
  });

  it('contato que não existe é 404', async () => {
    const res = await criar('c:99999');
    assert.equal(res.status, 404);
  });
});

describe('a ficha e a busca do documento sabem do Asaas', () => {
  it('a ficha oferece criar quando pode, e mostra o cliente ligado depois', async () => {
    const antes = await call(`${panelUrl}/api/contacts/${encodeURIComponent(contatoKey)}/asaas-invoices`, { headers: authHeaders(token) });
    assert.equal(antes.body.data.canCreate, true);
    assert.equal(antes.body.data.customer, null);
    await criar(contatoKey);
    const depois = await call(`${panelUrl}/api/contacts/${encodeURIComponent(contatoKey)}/asaas-invoices`, { headers: authHeaders(token) });
    assert.equal(depois.body.data.canCreate, false);
    assert.equal(depois.body.data.customer.asaasId, 'cus_novo');
  });

  it('a ficha não oferece criar com a escrita desligada', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ allowWriteCustomers: false }));
    const res = await call(`${panelUrl}/api/contacts/${encodeURIComponent(contatoKey)}/asaas-invoices`, { headers: authHeaders(token) });
    assert.equal(res.body.data.canCreate, false);
  });

  it('o "Novo cliente" diz se o CPF já está no Asaas e se pode criar lá', async () => {
    await getDb()('sgp_contacts').del();
    await getDb()('sgp_clients').del();
    const livre = await call(`${panelUrl}/api/contacts/lookup/document?document=${DOC}`, { headers: authHeaders(token) });
    assert.equal(livre.status, 200, JSON.stringify(livre.body));
    assert.deepEqual(livre.body.data.inAsaas, []);
    assert.equal(livre.body.data.asaasWritable, true);

    await dentro(() => AsaasCustomer.upsertFromAsaas({ id: 'cus_x', name: 'Maria', document: DOC }, { seenAt: new Date() }));
    const achado = await call(`${panelUrl}/api/contacts/lookup/document?document=${DOC}`, { headers: authHeaders(token) });
    assert.deepEqual(achado.body.data.inAsaas.map((c) => c.asaasId), ['cus_x']);
  });
});
