import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: AsaasCustomer } = await import('../src/models/AsaasCustomer.js');

/** O filtro "Cliente Asaas" da lista de contatos: casa pelo CPF/CNPJ e some sem a integração. */
const DOC_ASAAS = '52998224725';
const DOC_OUTRO = '11144477735';

let panelUrl;
let token;
const dentro = (fn) => asTenant(fn);
const listar = (query = '') => call(`${panelUrl}/api/whatsapp/contacts${query}`, { headers: authHeaders(token) });
const criar = (name, document, phone) => call(`${panelUrl}/api/contacts`, {
  method: 'POST', headers: authHeaders(token), body: { name, document, personType: 'PF', whatsappPhone: phone }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-filtro', password: 'senha-da-dona-1', email: 'dona-filtro@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => { await stopTestServers(); });

beforeEach(async () => {
  const db = getDb();
  for (const t of ['asaas_charges', 'asaas_customers', 'sgp_contacts', 'sgp_clients']) await db(t).del();
  await dentro(() => AsaasProviderService.saveConfig({ enabled: false }));
  await criar('Maria Asaas', DOC_ASAAS, '(93) 98111-0000');
  await criar('Joao Outro', DOC_OUTRO, '(93) 98222-0000');
});

const ligar = async () => {
  await dentro(() => AsaasProviderService.saveConfig({ enabled: true, environment: 'sandbox', apiKey: '$aact_hmlg_filtro' }));
  await dentro(() => AsaasCustomer.upsertFromAsaas({ id: 'cus_f1', name: 'Maria', document: DOC_ASAAS }, { seenAt: new Date() }));
};

describe('filtro Cliente Asaas', () => {
  it('sem a integração nada é marcado e a contagem vem nula (o botão some)', async () => {
    const res = await listar('?asaas=true');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.counts.asaas, null);
    assert.ok(res.body.data.contacts.every((c) => c.inAsaas === false));
  });

  it('com a integração, filtra pelo CPF e conta quem é cliente', async () => {
    await ligar();
    const todos = await listar();
    assert.equal(todos.body.data.counts.asaas, 1);
    const res = await listar('?asaas=true');
    assert.deepEqual(res.body.data.contacts.map((c) => c.clientName), ['Maria Asaas']);
    assert.equal(res.body.data.contacts[0].inAsaas, true);
    const outro = todos.body.data.contacts.find((c) => c.clientName === 'Joao Outro');
    assert.equal(outro.inAsaas, false);
  });
});
