import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaConversationService } = await import('../src/services/waConversationService.js');
const { mascararSensivel } = await import('../src/utils/wa/sensivel.js');

let conversa;

before(async () => {
  await startTestServers();
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-cpf', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-cpf'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-cpf')
  }));
  conversa = await asTenant(() => WaConversation.ensure({
    accountId: account.id, externalThreadId: '5593981215999@s.whatsapp.net',
    waPhone: '5593981215999', waLid: null, pushName: 'Cliente'
  }));
});

after(async () => { await stopTestServers(); });

describe('vínculo só por CPF', () => {
  it('fica marcado como não verificado, e desvincular limpa a marca', async () => {
    const ligada = await asTenant(() => WaConversationService.bindByDocument(conversa, { contract: '4242' }));
    assert.equal(ligada.contract, '4242');
    assert.equal(ligada.bound_via, 'document');
    const solta = await asTenant(() => WaConversationService.unlinkSubscriber(conversa.id));
    assert.equal(solta.bound_via, null);
    assert.equal(solta.contract, null);
  });
});

describe('o que não vai para a IA', () => {
  it('mascara CPF, CNPJ, PIX e linha digitável, e deixa telefone', () => {
    assert.equal(mascararSensivel('cpf 123.456.789-09'), 'cpf [documento omitido]');
    assert.equal(mascararSensivel('12.345.678/0001-95'), '[documento omitido]');
    assert.equal(mascararSensivel('5593981215425'), '5593981215425');
    assert.match(mascararSensivel('23790.12345 60000.000003 12345.678901 1 23450000010000'), /linha digitável/);
    assert.match(mascararSensivel('00020126580014br.gov.bcb.pix0136abcdef12-3456-7890-abcd-ef1234567890520400005303986540510.005802BR'), /PIX omitido/);
  });
});
