import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resumoSemTexto } from '../src/utils/wa/waSemTexto.js';

describe('o balão de uma mensagem sem texto e sem anexo', () => {
  it('reação', () => {
    assert.equal(resumoSemTexto({ reactionMessage: { text: '👍', key: {} } }), 'Reagiu com 👍 a uma mensagem');
    assert.equal(resumoSemTexto({ reactionMessage: { text: '' } }), 'Removeu a reação a uma mensagem');
  });

  it('localização com link do mapa', () => {
    const r = resumoSemTexto({ locationMessage: { degreesLatitude: -2.44, degreesLongitude: -54.7, name: 'Casa' } });
    assert.match(r, /📍 Localização/);
    assert.match(r, /Casa/);
    assert.match(r, /https:\/\/www\.google\.com\/maps\?q=-2\.44,-54\.7/);
  });

  it('contato com o telefone do vCard', () => {
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Maria\nitem1.TEL;waid=5593991112233:+55 93 99111-2233\nEND:VCARD';
    assert.equal(resumoSemTexto({ contactMessage: { displayName: 'Maria', vcard } }), '👤 Contato: Maria — +55 93 99111-2233');
  });

  it('enquete', () => {
    const r = resumoSemTexto({ pollCreationMessageV3: { name: 'Horário?', options: [{ optionName: 'Manhã' }, { optionName: 'Tarde' }] } });
    assert.equal(r, '📊 Enquete: Horário?\n• Manhã\n• Tarde');
  });

  it('mídia que não baixou diz o que era', () => {
    assert.match(resumoSemTexto({ imageMessage: { mimetype: 'image/jpeg' } }), /^📷 Foto — não foi possível baixar/);
    assert.match(resumoSemTexto({ documentMessage: { fileName: 'boleto.pdf' } }), /^📄 Documento \(boleto\.pdf\)/);
  });

  it('sem mensagem nenhuma fica vazio', () => {
    assert.equal(resumoSemTexto(null), '');
    assert.equal(resumoSemTexto({}), '');
  });
  it('mensagem com botões (o menu de um robô): o texto e as opções', () => {
    const r = resumoSemTexto({
      buttonsMessage: { contentText: 'Como podemos ajudar?', buttons: [{ buttonText: { displayText: '2ª via' } }, { buttonText: { displayText: 'Suporte' } }] }
    });
    assert.equal(r, 'Como podemos ajudar?\n• 2ª via\n• Suporte');
  });

  it('lista de opções', () => {
    const r = resumoSemTexto({
      listMessage: { title: 'Menu', description: 'Escolha', sections: [{ rows: [{ title: 'Financeiro' }, { title: 'Técnico' }] }] }
    });
    assert.equal(r, 'Menu\nEscolha\n• Financeiro\n• Técnico');
  });

  it('modelo com botão e mensagem interativa de fluxo nativo', () => {
    assert.equal(
      resumoSemTexto({ templateMessage: { hydratedTemplate: { hydratedContentText: 'Sua fatura vence', hydratedButtons: [{ urlButton: { displayText: 'Ver fatura' } }] } } }),
      'Sua fatura vence\n• Ver fatura'
    );
    assert.equal(
      resumoSemTexto({ interactiveMessage: { body: { text: 'Pague agora' }, nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: '{"display_text":"Pagar"}' }] } } }),
      'Pague agora\n• Pagar'
    );
  });

  it('convite de grupo, pedido e mensagem apagada pelo cliente', () => {
    assert.equal(resumoSemTexto({ groupInviteMessage: { groupName: 'Vizinhos' } }), '👥 Convite para o grupo Vizinhos');
    assert.equal(resumoSemTexto({ orderMessage: { orderTitle: 'Plano 200' } }), '🛒 Pedido: Plano 200');
    assert.equal(resumoSemTexto({ protocolMessage: { type: 0 } }), '🚫 Apagou uma mensagem');
  });

  it('um tipo que ninguém conhece diz o nome do tipo; só o contexto não vira balão', () => {
    assert.equal(
      resumoSemTexto({ messageContextInfo: { x: 1 }, pinInChatMessage: { type: 1 } }),
      '❔ Mensagem do tipo pinInChatMessage, que o painel não exibe. Veja no celular.'
    );
    assert.equal(resumoSemTexto({ messageContextInfo: { x: 1 } }), '');
  });
});
