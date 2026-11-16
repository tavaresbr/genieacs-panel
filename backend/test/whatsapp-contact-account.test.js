import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpContact } = await import('../src/models/SgpContact.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');

/** "Conversar" com o número escolhido: cada número do provedor tem a sua conversa com o assinante. */

// Um telefone por contrato: a conversa é de (número do provedor, telefone), não de contrato.
const fone = (contrato) => `55939914${String(contrato.replace(/\D/g, '')).padStart(5, '0')}`;
let panelUrl;
let token;
let contaA;
let contaB;
let contaCaida;

const conta = (nome, extra = {}) => asTenant(() => WhatsAppAccount.create({
  name: nome, purpose: 'general', flavor: 'v2', base_url: 'https://evo.provedor.test', status: 'connected',
  ...WhatsAppConfigService.encryptInstanceToken(`t-${nome}`), ...WhatsAppConfigService.encryptWebhookToken(`w-${nome}`),
  ...extra
}));
const abrir = (contrato, body = {}) => call(`${panelUrl}/api/whatsapp/contacts/${contrato}/conversation`, {
  method: 'POST', headers: authHeaders(token), body
});
const contato = (contrato) => asTenant(() => SgpContact.upsertFromSgp({ contract: contrato, client_name: 'Cliente', phone_e164: fone(contrato) }));

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'numero', password: 'numero-senha-1', email: 'numero@exemplo.test' }
  });
  token = setup.body.data.token;
  contaA = await conta('numero-a', { is_default: true });
  contaB = await conta('numero-b');
  contaCaida = await conta('numero-caido', { status: 'disconnected' });
});
after(stopTestServers);

describe('POST /contacts/:contract/conversation com accountId', () => {
  it('sem accountId: igual a hoje (número de propósito general, o primeiro)', async () => {
    await contato('A-1');
    const res = await abrir('A-1');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.accountId, contaA.id);
  });

  it('com o número escolhido: abre a conversa do B, mesmo havendo uma no A', async () => {
    await contato('A-2');
    const noA = await abrir('A-2');
    assert.equal(noA.body.data.accountId, contaA.id);
    const noB = await abrir('A-2', { accountId: contaB.id });
    assert.equal(noB.status, 201, JSON.stringify(noB.body));
    assert.equal(noB.body.data.accountId, contaB.id);
    assert.notEqual(noB.body.data.id, noA.body.data.id, 'cada número tem a sua conversa');
    const linhas = await getDb()('wa_conversations').where({ contract: 'A-2' }).orderBy('id');
    assert.equal(linhas.length, 2);
  });

  it('escolher de novo o mesmo número abre a que já existe (200, sem criar outra)', async () => {
    await contato('A-3');
    const primeira = await abrir('A-3', { accountId: contaB.id });
    assert.equal(primeira.status, 201);
    const segunda = await abrir('A-3', { accountId: contaB.id });
    assert.equal(segunda.status, 200, JSON.stringify(segunda.body));
    assert.equal(segunda.body.data.id, primeira.body.data.id);
    assert.equal((await getDb()('wa_conversations').where({ contract: 'A-3' })).length, 1);
  });

  it('número desconectado, inexistente ou inválido é recusado e nada é criado', async () => {
    await contato('A-4');
    for (const accountId of [contaCaida.id, 99999999, 'abc', -1, 1.5]) {
      const res = await abrir('A-4', { accountId });
      assert.equal(res.status, 400, `accountId ${accountId}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'no_account');
    }
    assert.equal((await getDb()('wa_conversations').where({ contract: 'A-4' })).length, 0);
  });

  it('o número escolhido convive com o telefone informado no pedido', async () => {
    await contato('A-5');
    const res = await abrir('A-5', { accountId: contaB.id, phone: fone('A-5') });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.accountId, contaB.id);
  });

  it('exige login', async () => {
    const res = await call(`${panelUrl}/api/whatsapp/contacts/A-1/conversation`, { method: 'POST', body: { accountId: contaA.id } });
    assert.equal(res.status, 401);
  });
});
