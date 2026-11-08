import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpClient } = await import('../src/models/SgpClient.js');

/** O selo e o filtro "Risco alto (TeiaH)" da lista de contatos: pelo CPF/CNPJ da última consulta guardada. */
const DOC_ALTO = '52998224725';
const DOC_BAIXO = '11144477735';
const DOC_NUNCA = '39053344705';

let panelUrl;
let token;
const listar = (query = '') => call(`${panelUrl}/api/whatsapp/contacts${query}`, { headers: authHeaders(token) });
const criar = (name, document, phone) => call(`${panelUrl}/api/contacts`, {
  method: 'POST', headers: authHeaders(token), body: { name, document, personType: 'PF', whatsappPhone: phone }
});
const consultado = (document, risk, score) => asTenant(async () => {
  const rows = await getDb()('sgp_clients').select('id', 'document', 'overrides');
  const client = rows.find((row) => row.document === document || String(row.overrides ?? '').includes(document));
  await SgpClient.setTeiah(client.id, { consultedAt: new Date().toISOString(), found: true, score: { score, risk }, phones: [], emails: [], addresses: [] });
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-selo', password: 'senha-da-dona-selo-1', email: 'dona-selo@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => { await stopTestServers(); });

beforeEach(async () => {
  const db = getDb();
  for (const t of ['sgp_contacts', 'sgp_clients']) await db(t).del();
  await criar('Ana Risco', DOC_ALTO, '(93) 98111-0001');
  await criar('Bia Tranquila', DOC_BAIXO, '(93) 98111-0002');
  await criar('Caio Nunca', DOC_NUNCA, '(93) 98111-0003');
});

describe('selo de risco da TeiaH na lista', () => {
  it('ninguém consultado: sem selo e sem filtro (contagem nula)', async () => {
    const res = await listar();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.counts.teiahHigh, null);
    assert.ok(res.body.data.contacts.every((c) => c.teiahRisk === null));
  });

  it('mostra o risco de quem foi consultado e filtra o risco alto', async () => {
    await consultado(DOC_ALTO, 'ALTO', 310);
    await consultado(DOC_BAIXO, 'BAIXO', 820);
    const todos = await listar();
    const por = Object.fromEntries(todos.body.data.contacts.map((c) => [c.clientName, c]));
    assert.equal(por['Ana Risco'].teiahRisk, 'ALTO');
    assert.equal(por['Ana Risco'].teiahScore, 310);
    assert.equal(por['Bia Tranquila'].teiahRisk, 'BAIXO');
    assert.equal(por['Caio Nunca'].teiahRisk, null);
    assert.equal(todos.body.data.counts.teiahHigh, 1);
    const altos = await listar('?teiahHigh=true');
    assert.deepEqual(altos.body.data.contacts.map((c) => c.clientName), ['Ana Risco']);
    assert.equal(altos.body.data.total, 1);
  });
});
