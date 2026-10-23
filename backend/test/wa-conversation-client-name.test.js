import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: SgpContact } = await import('../src/models/SgpContact.js');

/**
 * O nome do cliente numa conversa vinculada a um contrato que só o SGP
 * conhece: a linha do contrato não tem nome, mas o cliente (`client_ref`) tem
 * outra linha — o cadastro sem contrato — com ele. Sem isto o título voltava
 * ao nome do perfil do WhatsApp ("fé") depois de vincular o contrato.
 */
const FONE = '5593920223940';

let panelUrl;
let token;
let conversaId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-nome-cliente',
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia-nome'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-webhook-nome')
  }));
  const conversa = await asTenant(() => WaConversation.ensure({
    accountId: account.id,
    externalThreadId: `${FONE}@s.whatsapp.net`,
    waPhone: FONE,
    waLid: null,
    pushName: 'fé'
  }));
  conversaId = conversa.id;

  // O cadastro sem contrato tem o nome; o contrato 619 chegou sem ele.
  await asTenant(() => SgpContact.upsertFromSgp({
    contract: null, sgp_client_id: 'CL-619', document: '12345678900', client_name: 'HENRIQUE RODRIGUES DE OLIVEIRA',
    state: 'none', client_ref: 'CL-619'
  }));
  await asTenant(() => SgpContact.upsertFromSgp({
    contract: '619', document: '12345678900', client_name: null, state: 'inactive', client_ref: 'CL-619'
  }));
  await asTenant(() => WaConversation.update(conversaId, { contract: '619', sgp_contact_id: null, last_message_at: new Date(), engaged_at: new Date() }));
});

after(async () => {
  await stopTestServers();
});

describe('o nome do cliente depois de vincular um contrato sem nome', () => {
  it('a conversa aberta mostra o nome do cliente, não o do perfil do WhatsApp', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/conversations/${conversaId}`, { headers: authHeaders(token) });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.clientName, 'HENRIQUE RODRIGUES DE OLIVEIRA');
  });

  it('a lista mostra o mesmo nome', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/conversations`, { headers: authHeaders(token) });
    assert.equal(status, 200, JSON.stringify(body));
    const linha = body.data.find((row) => row.id === conversaId);
    assert.equal(linha.clientName, 'HENRIQUE RODRIGUES DE OLIVEIRA');
  });
});
