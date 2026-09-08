import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { setMediaFetcher } = await import('../src/services/waMediaService.js');
const { DATA_DIR } = await import('../src/config/paths.js');

const INSTANCE = 'painel-entrada';
const INSTANCE_TOKEN = 'token-instancia-entrada';
const WEBHOOK_TOKEN = 'segredo-webhook-entrada';

/** 1x1 PNG. Small enough to inline, real enough to prove the bytes landed. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let panelUrl;
let accountId;

/** Every event goes in the way the Evolution server sends it: over HTTP, with the token. */
async function hook(body) {
  return call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });
}

const mensagens = () => getDb()('wa_messages');
const conversas = () => getDb()('wa_conversations');

async function mensagemPorId(externalId) {
  return WaMessage.getByExternalId(externalId);
}

async function conversaDaMensagem(externalId) {
  const msg = await mensagemPorId(externalId);
  return msg ? conversas().where({ id: msg.conversation_id }).first() : null;
}

/** A v2 `messages.upsert`, as Evolution API v2 actually posts it. */
function eventoV2({ id, remoteJid, fromMe = false, texto = '', pushName = 'Cliente', chave = {}, message = null }) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid, fromMe, id, ...chave },
      pushName,
      message: message ?? { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

/** A GO `Message`, whose fields are capitalized because whatsmeow has no json tags. */
function eventoGo({ id, chat, fromMe = false, texto = '', pushName = 'Cliente', info = {} }) {
  return {
    event: 'Message',
    instance: INSTANCE,
    data: {
      Info: {
        ID: id,
        Chat: chat,
        Sender: chat,
        IsFromMe: fromMe,
        IsGroup: false,
        PushName: pushName,
        ...info
      },
      Message: { conversation: texto }
    }
  };
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const account = await WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'pending',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(INSTANCE_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  });
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

describe('inbound messages', () => {
  it('lands a v2 messages.upsert as one message on one conversation', async () => {
    const { status, body } = await hook(eventoV2({
      id: 'V2-TEXTO-1',
      remoteJid: '5593981110449@s.whatsapp.net',
      texto: 'boa tarde, minha internet caiu',
      pushName: 'Maria'
    }));
    assert.equal(status, 200);
    assert.equal(body.handled, true);
    assert.equal(body.event, 'messages_upsert');

    const msg = await mensagemPorId('V2-TEXTO-1');
    assert.ok(msg, 'the message should exist');
    assert.equal(msg.direction, 'in');
    assert.equal(msg.body, 'boa tarde, minha internet caiu');
    assert.equal(msg.delivery_status, null);

    const conversa = await conversaDaMensagem('V2-TEXTO-1');
    assert.equal(conversa.account_id, accountId);
    assert.equal(conversa.wa_phone_e164, '5593981110449');
    assert.equal(conversa.wa_lid, null);
    assert.equal(conversa.push_name, 'Maria');
    assert.equal(conversa.unread_count, 1);
    assert.ok(conversa.last_inbound_at);
  });

  it('lands a GO MESSAGE the same way, device suffix and all', async () => {
    const { status, body } = await hook(eventoGo({
      id: 'GO-TEXTO-1',
      chat: '5591988887777@s.whatsapp.net',
      texto: 'bom dia',
      pushName: 'Carlos',
      // A WhatsApp Web session is always a companion device, so the sender JID
      // carries `:device`. Gluing it onto the number invents a phone.
      info: { Sender: '5591988887777:22@s.whatsapp.net' }
    }));
    assert.equal(status, 200);
    assert.equal(body.handled, true);

    const conversa = await conversaDaMensagem('GO-TEXTO-1');
    assert.equal(conversa.wa_phone_e164, '5591988887777');
    assert.equal(conversa.external_thread_id, '5591988887777@s.whatsapp.net');
  });

  it('stores ONE row when the same event is delivered twice', async () => {
    const evento = eventoV2({
      id: 'V2-REPETIDA',
      remoteJid: '5593955554444@s.whatsapp.net',
      texto: 'chegou duas vezes'
    });
    const primeira = await hook(evento);
    const segunda = await hook(evento);

    // Both servers redeliver. A duplicate is success, not an error: answering
    // non-2xx would make the server send the same event forever.
    assert.equal(primeira.status, 200);
    assert.equal(segunda.status, 200);
    assert.equal(segunda.body.handled, true);
    assert.equal(segunda.body.duplicate, true);

    const [{ total }] = await mensagens().where({ external_id: 'V2-REPETIDA' }).count({ total: '*' });
    assert.equal(Number(total), 1);

    const conversa = await conversaDaMensagem('V2-REPETIDA');
    assert.equal(conversa.unread_count, 1, 'a redelivery must not bump unread twice');
  });

  it('stores a @lid contact as a LID and NEVER as a phone', async () => {
    await hook(eventoV2({
      id: 'V2-LID-1',
      remoteJid: '140076734488739@lid',
      texto: 'oi',
      pushName: 'Contato Privado'
    }));

    const conversa = await conversaDaMensagem('V2-LID-1');
    // A LID is not a phone number. Writing those 15 digits into the phone
    // column is what put identifiers where customer names belong.
    assert.equal(conversa.wa_lid, '140076734488739');
    assert.equal(conversa.wa_phone_e164, null);
    assert.equal(conversa.external_thread_id, '140076734488739@lid');
  });

  it('keeps both identities when the event carries the phone alongside the LID', async () => {
    await hook(eventoV2({
      id: 'V2-DUPLA-1',
      remoteJid: '140076734488750@lid',
      texto: 'sou eu de novo',
      chave: { senderPn: '5593922221111@s.whatsapp.net' }
    }));

    const conversa = await conversaDaMensagem('V2-DUPLA-1');
    assert.equal(conversa.wa_lid, '140076734488750');
    assert.equal(conversa.wa_phone_e164, '5593922221111');
  });

  it('does NOT take the customer identity from the Sender fields of a fromMe message', async () => {
    // THE TRAP: on an outbound echo `senderPn` / `SenderAlt` are the PROVIDER's
    // own number. Reading them here would stamp the provider's phone onto the
    // customer's conversation, and every later dunning message for that thread
    // would go to the provider.
    await hook(eventoV2({
      id: 'V2-SAIDA-1',
      remoteJid: '140076734488760@lid',
      fromMe: true,
      texto: 'já vamos verificar',
      chave: { senderPn: '5511777776666@s.whatsapp.net' }
    }));

    const msg = await mensagemPorId('V2-SAIDA-1');
    assert.equal(msg.direction, 'out');
    assert.equal(msg.delivery_status, 'sent');

    const conversa = await conversaDaMensagem('V2-SAIDA-1');
    assert.equal(conversa.wa_lid, '140076734488760');
    assert.equal(conversa.wa_phone_e164, null, "the provider's own number must not become the contact");
    assert.equal(conversa.unread_count, 0, 'our own message is not unread');
  });

  it('does the same for the GO SenderAlt on an outbound echo', async () => {
    await hook(eventoGo({
      id: 'GO-SAIDA-1',
      chat: '140076734488770@lid',
      fromMe: true,
      texto: 'retorno em instantes',
      info: { IsFromMe: true, SenderAlt: '5511777776666@s.whatsapp.net' }
    }));

    const conversa = await conversaDaMensagem('GO-SAIDA-1');
    assert.equal(conversa.wa_lid, '140076734488770');
    assert.equal(conversa.wa_phone_e164, null);
  });

  it('discards a pushName that is only the identifier repeated', async () => {
    // Evolution GO sends the identifier as the name when the contact has none.
    // Storing it puts 15 digits where the customer's name goes.
    await hook(eventoGo({
      id: 'GO-NOME-FONE',
      chat: '5593944443333@s.whatsapp.net',
      texto: 'alô',
      pushName: '5593944443333'
    }));
    assert.equal((await conversaDaMensagem('GO-NOME-FONE')).push_name, null);

    await hook(eventoV2({
      id: 'V2-NOME-LID',
      remoteJid: '140076734488780@lid',
      texto: 'alô',
      pushName: '+140076734488780'
    }));
    assert.equal((await conversaDaMensagem('V2-NOME-LID')).push_name, null);
  });

  it('skips a group with 200, so the server does not retry it forever', async () => {
    const { status, body } = await hook(eventoV2({
      id: 'V2-GRUPO-1',
      remoteJid: '120363041234567890@g.us',
      texto: 'mensagem de grupo'
    }));
    assert.equal(status, 200);
    assert.equal(body.handled, false);
    assert.equal(body.skipped, 'group');
    assert.equal(await mensagemPorId('V2-GRUPO-1'), null);
  });

  it('skips broadcasts and domains it does not know, also with 200', async () => {
    const status = await hook(eventoV2({
      id: 'V2-STATUS-1',
      remoteJid: 'status@broadcast',
      texto: 'status de alguem'
    }));
    assert.equal(status.status, 200);
    assert.equal(status.body.skipped, 'broadcast');

    const novo = await hook(eventoV2({
      id: 'V2-DOMINIO-NOVO',
      remoteJid: '998877@newsletter',
      texto: 'canal'
    }));
    assert.equal(novo.status, 200);
    assert.equal(novo.body.skipped, 'unknown_domain');
    assert.equal(await mensagemPorId('V2-DOMINIO-NOVO'), null);
  });

  it('skips an event with no usable address instead of inventing one', async () => {
    const { status, body } = await hook({
      event: 'messages.upsert',
      instance: INSTANCE,
      data: { key: { id: 'V2-SEM-ENDERECO', fromMe: false }, message: { conversation: 'oi' } }
    });
    assert.equal(status, 200);
    assert.equal(body.handled, false);
    assert.equal(await mensagemPorId('V2-SEM-ENDERECO'), null);
  });

  it('reads the text of an extendedTextMessage and of a caption', async () => {
    await hook(eventoV2({
      id: 'V2-EXTENDED',
      remoteJid: '5593911112222@s.whatsapp.net',
      message: { extendedTextMessage: { text: 'segue o link do boleto' } }
    }));
    assert.equal((await mensagemPorId('V2-EXTENDED')).body, 'segue o link do boleto');
  });
});

describe('inbound media', () => {
  it('stores the base64 the server already decrypted, under the conversation', async () => {
    await hook(eventoV2({
      id: 'V2-MIDIA-1',
      remoteJid: '5593977776666@s.whatsapp.net',
      message: {
        imageMessage: {
          mimetype: 'image/png',
          caption: 'olha o modem',
          // The encrypted object on WhatsApp's CDN. It must never be fetched.
          url: 'https://mmg.whatsapp.net/d/f/Aq1x.enc',
          fileName: '../../etc/passwd'
        },
        base64: PNG_BASE64
      }
    }));

    const msg = await mensagemPorId('V2-MIDIA-1');
    assert.equal(msg.body, 'olha o modem');
    assert.equal(msg.attachment_type, 'image/png');
    assert.ok(msg.attachment_path.startsWith(`wa-media/${msg.conversation_id}/`));
    // A filename from a stranger's phone is not a path.
    assert.equal(msg.attachment_path.includes('..'), false);
    assert.equal(fs.existsSync(path.join(DATA_DIR, msg.attachment_path)), true);
    assert.equal(fs.readFileSync(path.join(DATA_DIR, msg.attachment_path)).length, Buffer.from(PNG_BASE64, 'base64').length);
  });

  it('never downloads the WhatsApp CDN url, and stores the message without an attachment', async () => {
    await hook(eventoV2({
      id: 'V2-MIDIA-CIFRADA',
      remoteJid: '5593966665555@s.whatsapp.net',
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
          // Only the encrypted pointer, no base64 and no mediaUrl. Downloading
          // it writes unreadable bytes and the link expires; the honest result
          // is a message with no attachment.
          url: 'https://mmg.whatsapp.net/v/t62.7117-24/1234.enc?oe=68B00000'
        }
      }
    }));

    const msg = await mensagemPorId('V2-MIDIA-CIFRADA');
    assert.ok(msg, 'the message itself must still land');
    assert.equal(msg.attachment_path, null);
  });

  it('falls back to asking the server for the bytes', async () => {
    setMediaFetcher(async () => ({ base64: PNG_BASE64, mimetype: 'image/png', fileName: 'recibo.png' }));
    try {
      await hook(eventoV2({
        id: 'V2-MIDIA-ULTIMO',
        remoteJid: '5593955551111@s.whatsapp.net',
        message: { imageMessage: { mimetype: 'image/png', url: 'https://mmg.whatsapp.net/d/f/zz.enc' } }
      }));
    } finally {
      setMediaFetcher(null);
    }

    const msg = await mensagemPorId('V2-MIDIA-ULTIMO');
    assert.equal(msg.attachment_name, 'recibo.png');
    assert.equal(fs.existsSync(path.join(DATA_DIR, msg.attachment_path)), true);
  });
});

describe('delivery receipts', () => {
  async function saida(externalId) {
    const conversa = await conversas().where({ external_thread_id: '5593981110449@s.whatsapp.net' }).first();
    return WaMessage.create({
      conversation_id: conversa.id,
      direction: 'out',
      body: 'com recibo',
      external_id: externalId,
      delivery_status: 'sending'
    });
  }

  it('reads the v2 flat shape, where there is no data.key at all', async () => {
    const msg = await saida('RCPT-V2');
    const { status, body } = await hook({
      event: 'messages.update',
      instance: INSTANCE,
      data: { messageId: 'cm9m2q06m2pakoe4rcgdmwe42', keyId: 'RCPT-V2', status: 'DELIVERY_ACK' }
    });
    assert.equal(status, 200);
    assert.equal(body.handled, true);
    assert.equal((await WaMessage.getById(msg.id)).delivery_status, 'delivered');
  });

  it('reads the v1 nested shape', async () => {
    const msg = await saida('RCPT-V1');
    await hook({
      event: 'messages.update',
      instance: INSTANCE,
      data: { key: { id: 'RCPT-V1' }, update: { status: 'READ' } }
    });
    assert.equal((await WaMessage.getById(msg.id)).delivery_status, 'read');
  });

  it('reads the GO shape, which carries the state outside data and covers a batch', async () => {
    const um = await saida('RCPT-GO-1');
    const dois = await saida('RCPT-GO-2');
    const { body } = await hook({
      event: 'Receipt',
      instance: INSTANCE,
      state: 'Delivered',
      data: { MessageIDs: ['RCPT-GO-1', 'RCPT-GO-2'] }
    });
    assert.equal(body.handled, true);
    assert.equal(body.updated, 2);
    assert.equal((await WaMessage.getById(um.id)).delivery_status, 'delivered');
    assert.equal((await WaMessage.getById(dois.id)).delivery_status, 'delivered');
  });

  it('skips with 200 when the update carries no state, and says so', async () => {
    const { status, body } = await hook({
      event: 'messages.update',
      instance: INSTANCE,
      data: { keyId: 'RCPT-V2', message: { conversation: 'texto editado' } }
    });
    // A text edit legitimately has no receipt. It is still a recognised event,
    // so it gets a 200 — but `skipped` keeps it distinguishable from a stored
    // one, which is the difference the source system did not have.
    assert.equal(status, 200);
    assert.equal(body.handled, false);
    assert.equal(body.skipped, 'no_receipt');
  });

  it("ignores the operator's own ReadSelf, which says nothing about the customer", async () => {
    const msg = await saida('RCPT-READSELF');
    await hook({
      event: 'Receipt',
      instance: INSTANCE,
      state: 'ReadSelf',
      data: { MessageIDs: ['RCPT-READSELF'] }
    });
    assert.equal((await WaMessage.getById(msg.id)).delivery_status, 'sending');
  });
});

describe('opt-out from an inbound message', () => {
  it('records the opt-out when the whole inbound message is the request', async () => {
    await hook(eventoV2({
      id: 'V2-SAIR-1',
      remoteJid: '5599111112222@s.whatsapp.net',
      texto: 'SAIR'
    }));
    assert.equal(await WaOptOut.isActive({ waPhone: '5599111112222' }), true);
  });

  it('does NOT record one on an outbound echo', async () => {
    // The provider typing "sair" on their own phone must never unsubscribe
    // their own customer.
    await hook(eventoV2({
      id: 'V2-SAIR-ECO',
      remoteJid: '5599222223333@s.whatsapp.net',
      fromMe: true,
      texto: 'sair'
    }));
    assert.equal(await WaOptOut.isActive({ waPhone: '5599222223333' }), false);
    assert.equal((await mensagemPorId('V2-SAIR-ECO')).direction, 'out');
  });

  it('does not treat "pode separar" as an opt-out', async () => {
    // Measured against 1.887 real customer messages: a substring rule
    // unsubscribes people who were in the middle of buying something.
    await hook(eventoV2({
      id: 'V2-SEPARAR',
      remoteJid: '5599333334444@s.whatsapp.net',
      texto: 'Então pode separar'
    }));
    assert.equal(await WaOptOut.isActive({ waPhone: '5599333334444' }), false);
  });

  it('records one for a contact known only by LID', async () => {
    await hook(eventoV2({
      id: 'V2-SAIR-LID',
      remoteJid: '140076734488799@lid',
      texto: 'parar'
    }));
    assert.equal(await WaOptOut.isActive({ waLid: '140076734488799' }), true);
  });
});

describe('qr and connection', () => {
  it('stores the QR and moves the account to connecting', async () => {
    const { status, body } = await hook({
      event: 'qrcode.updated',
      instance: INSTANCE,
      data: { qrcode: { base64: 'data:image/png;base64,AAAA', code: '2@abc' } }
    });
    assert.equal(status, 200);
    assert.equal(body.handled, true);

    const conta = await WhatsAppAccount.getById(accountId);
    assert.equal(conta.qr_code, 'data:image/png;base64,AAAA');
    assert.equal(conta.status, 'connecting');
    assert.ok(conta.qr_updated_at);
  });

  it('connects, clears the dead QR and captures the paired number', async () => {
    const { body } = await hook({
      event: 'connection.update',
      instance: INSTANCE,
      data: { state: 'open', wuid: '5593981110000:14@s.whatsapp.net' }
    });
    assert.equal(body.handled, true);

    const conta = await WhatsAppAccount.getById(accountId);
    assert.equal(conta.status, 'connected');
    assert.equal(conta.phone_e164, '5593981110000');
    assert.equal(conta.qr_code, null, 'a paired session has no QR left to read');
    assert.ok(conta.last_seen_at);
  });

  it('reads a GO connection event whose payload carries no state at all', async () => {
    // The GO splits "connection" into five events and often sends an empty
    // body: `readStatus('go', {})` would read that as disconnected, so the raw
    // event name has to be the fallback.
    await hook({ event: 'LoggedOut', instance: INSTANCE, data: {} });
    assert.equal((await WhatsAppAccount.getById(accountId)).status, 'disconnected');

    await hook({ event: 'Connected', instance: INSTANCE, data: {} });
    assert.equal((await WhatsAppAccount.getById(accountId)).status, 'connected');
  });

  it('answers 200 with a reason for an event it does not handle', async () => {
    const { status, body } = await hook({ event: 'presence.update', instance: INSTANCE, data: {} });
    assert.equal(status, 200);
    assert.equal(body.handled, false);
    assert.equal(body.skipped, 'unsupported_event');
  });
});
