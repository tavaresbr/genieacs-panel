import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import MessengerMessage from '../models/MessengerMessage.js';
import { runInTenant } from '../config/tenantContext.js';
import { tdb } from '../config/database.js';

const BODY_LIMIT = 4000;
const URL_LIMIT = 2000;

/** O texto e o primeiro anexo de uma mensagem da Meta. */
export function parseMessage(message) {
  const body = typeof message?.text === 'string' ? message.text.slice(0, BODY_LIMIT) : null;
  const attachment = Array.isArray(message?.attachments) ? message.attachments[0] : null;
  const url = typeof attachment?.payload?.url === 'string' ? attachment.payload.url.slice(0, URL_LIMIT) : null;
  return {
    body,
    attachmentType: attachment && typeof attachment.type === 'string' ? attachment.type.slice(0, 32) : null,
    attachmentUrl: url
  };
}

async function handleMessage(page, event) {
  const message = event.message;
  if (!message?.mid) return;
  const isEcho = message.is_echo === true;
  // No eco, quem escreveu foi a Página e o outro lado é o `recipient`.
  const psid = String((isEcho ? event.recipient?.id : event.sender?.id) ?? '');
  if (!psid) return;

  const conversation = await MessengerConversation.ensure({ pageRowId: page.id, psid });
  const { body, attachmentType, attachmentUrl } = parseMessage(message);
  const at = new Date(Number(event.timestamp) || Date.now());

  const { created } = await MessengerMessage.insert({
    conversation_id: conversation.id,
    direction: isEcho ? 'out' : 'in',
    external_id: String(message.mid).slice(0, 128),
    body,
    attachment_type: attachmentType,
    attachment_url: attachmentUrl,
    source: isEcho ? 'page' : 'operator',
    delivery_status: isEcho ? 'sent' : null,
    created_at: at
  });
  // Reentrega: a mensagem já estava aqui e a conversa já foi atualizada.
  if (!created) return;

  if (isEcho) {
    await MessengerConversation.update(conversation.id, { last_message_at: at });
    return;
  }
  await tdb('messenger_conversations').where({ id: conversation.id }).update({
    last_message_at: at,
    last_inbound_at: at,
    unread_count: Number(conversation.unread_count || 0) + 1,
    // Quem escreve de novo reabre a conversa que estava arquivada.
    closed_at: null,
    updated_at: new Date()
  });
}

async function handleReceipt(page, event, status) {
  const psid = String(event.sender?.id ?? '');
  const watermark = status === 'read' ? event.read?.watermark : event.delivery?.watermark;
  if (!psid || !watermark) return;
  const conversation = await MessengerConversation.getByPsid(page.id, psid);
  if (!conversation) return;
  await MessengerMessage.markOutboundUntil(conversation.id, status, watermark);
}

/** Um evento de `messaging[]`. Nunca lança: um evento ruim não derruba a entrega. */
async function handleEvent(page, event) {
  try {
    if (event.message) await handleMessage(page, event);
    else if (event.read) await handleReceipt(page, event, 'read');
    else if (event.delivery) await handleReceipt(page, event, 'delivered');
    // `postback` e `referral` ficam para o vínculo com o assinante (próxima etapa).
  } catch (error) {
    console.error('[messenger] could not handle event:', error.message);
  }
}

class MessengerInboundService {
  /**
   * Processa o corpo de uma entrega já autenticada. Devolve quantas Páginas
   * desconhecidas apareceram (para o log, não para a resposta: a Meta recebe
   * sempre 200 e reentregaria em laço o que recusássemos).
   */
  static async process(body) {
    if (body?.object !== 'page' || !Array.isArray(body.entry)) return { unknownPages: 0 };
    let unknownPages = 0;
    for (const entry of body.entry) {
      // eslint-disable-next-line no-await-in-loop -- ordem das mensagens importa
      const page = await MessengerPage.getByPageId(entry?.id);
      if (!page) {
        unknownPages += 1;
        continue;
      }
      const events = Array.isArray(entry.messaging) ? entry.messaging : [];
      // eslint-disable-next-line no-await-in-loop -- idem
      await runInTenant(page.tenant_id, async () => {
        for (const event of events) {
          // eslint-disable-next-line no-await-in-loop -- idem
          await handleEvent(page, event);
        }
      });
    }
    return { unknownPages };
  }
}

export default MessengerInboundService;
