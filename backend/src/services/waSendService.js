import WaConversation from '../models/WaConversation.js';
import WaMessage from '../models/WaMessage.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { clientForAccount } from './evolutionClient.js';
import {
  readSentId,
  sendAudioRequest,
  sendMediaRequest,
  sendTextRequest
} from '../utils/wa/evolutionApi.js';
import { destinoWa, normalizarTelefoneBr } from '../utils/wa/waDestino.js';

/** Column widths from `wa_messages`; truncating here beats a driver error. */
const BODY_ATTACHMENT_PATH_LIMIT = 255;
const ATTACHMENT_TYPE_LIMIT = 128;

/**
 * Who composed an outbound message — `wa_messages.source`.
 *
 * All three automatic senders write `sent_by: NULL`, so that column answers
 * "was a human behind this" and nothing else. It cannot tell the bot's own
 * reply from a dunning message or a technical alert, and the bot's ceiling was
 * reading it as if it could: three campaign messages in an hour and the bot
 * went silent on a subscriber it had never answered.
 *
 * 'operator' is also what an INBOUND row carries, and that is not a fudge.
 * `source` names which of the panel's senders composed the text; the panel
 * composed none of an inbound message, and neither did any of its automatic
 * senders — so the honest value is the one that means "not one of them". It is
 * the column default, which is how `waInboundService` gets it without saying
 * so: an outbound echo of the provider typing on their own phone is literally
 * an operator's message, and every reader here looks at outbound rows anyway.
 */
export const WA_MESSAGE_SOURCES = Object.freeze(['operator', 'bot', 'campaign', 'alert']);

/**
 * Composing and delivering one outbound message.
 *
 * The two halves are deliberately apart. `enqueue()` is what a request touches:
 * it validates, writes a `queued` row and returns — the operator's reply box
 * must not wait on an Evolution server that may be slow, restarting, or gone.
 * `dispatch()` is what the outbox worker calls later, out of any request.
 *
 * Nothing here loops or retries: how often to try, and how many times, is the
 * worker's business (`waOutboxWorker.js`).
 */
class WaSendService {
  /**
   * Writes an outbound message into the outbox.
   *
   * The refusals below all happen BEFORE the row exists, because a message that
   * can never be sent is worse as a permanently failed row than as an error the
   * operator sees while the text is still in the box.
   *
   * What is deliberately NOT checked here is the opt-out list. An opt-out means
   * the provider does not *initiate* contact; it must never stop an operator
   * answering someone who wrote in. Campaigns and alerts enforce it — the reply
   * box does not.
   */
  static async enqueue({
    conversationId,
    body,
    attachment,
    isNote = false,
    userId = null,
    source = 'operator'
  } = {}) {
    // Defaulting to 'operator' rather than to the caller's intent: a sender
    // that forgets to say must never end up claiming to be the bot, because
    // the bot's ceiling counts exactly this column. An unrecognised value
    // throws instead of being coerced — coercing it to 'operator' would take
    // the bot's own replies out of its own count, which is the loop the
    // ceiling exists to stop, and it would do it silently.
    if (!WA_MESSAGE_SOURCES.includes(source)) {
      throw new Error(`waSend: unknown message source '${source}'`);
    }

    const conversation = await this.requireConversation(conversationId);
    const text = String(body ?? '').trim();
    const anexo = normalizeAttachment(attachment);

    if (!text && !anexo) {
      throw new WaError('whatsapp.error.messageEmpty', { code: 'message_empty', status: 400 });
    }

    const note = isNote === true;
    if (!note) {
      // An internal note skips both checks on purpose: it is an annotation on
      // the thread, and refusing to record one because the number happens to be
      // disconnected would lose the operator's own words.
      if (!destinationFor(conversation)) {
        throw new WaError('whatsapp.error.noDestination', { code: 'no_destination', status: 409 });
      }
      if (!await this.resolveAccount(conversation)) {
        throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
      }
    }

    const now = new Date();
    const message = await WaMessage.create({
      conversation_id: conversation.id,
      direction: 'out',
      body: text || null,
      attachment_path: anexo?.path ?? null,
      attachment_type: anexo?.type ?? null,
      attachment_name: anexo?.name ?? null,
      is_note: note,
      // A note has no delivery state at all. 'queued' would hand it to the
      // worker, and the one thing a note must never do is reach the customer.
      delivery_status: note ? null : 'queued',
      sent_by: userId || null,
      source,
      created_at: now,
      updated_at: now
    });

    // The conversation list is ordered by this column, so a thread the operator
    // just answered has to rise even before the worker despatches the message.
    await WaConversation.update(conversation.id, { last_message_at: now });
    return message;
  }

  /**
   * Sends one already-claimed message and reports the id the server gave it.
   *
   * Throws — every failure is a `WaError` the worker records verbatim. It does
   * not touch the row: the worker owns the outbox state machine, and splitting
   * that ownership is how a message ends up both 'sent' and retried.
   *
   * @returns {Promise<{ accountId: number, externalId: string|null }>}
   */
  static async dispatch(message) {
    const conversation = await this.requireConversation(message.conversation_id);
    const number = destinationFor(conversation);
    if (!number) {
      throw new WaError('whatsapp.error.noDestination', { code: 'no_destination', status: 409 });
    }
    const account = await this.resolveAccount(conversation);
    if (!account) {
      throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
    }

    const config = await WhatsAppConfigService.getConfig();
    const client = clientForAccount(
      account,
      config,
      WhatsAppConfigService.decryptInstanceToken(account)
    );
    const externalId = await sendThrough(client, account, message, number);
    return { accountId: account.id, externalId };
  }

  /**
   * Which connected number carries this thread.
   *
   * The conversation's own account comes first: a customer who wrote to the
   * support number must be answered from the support number, or the reply
   * arrives from a stranger. Only when that number is not connected does the
   * purpose routing take over — and it routes on the SAME purpose, so a billing
   * thread falls back to another billing number before it falls back to any.
   */
  static async resolveAccount(conversation) {
    const own = conversation.account_id
      ? await WhatsAppAccount.getById(conversation.account_id)
      : null;
    if (own && own.status === 'connected') return own;
    return WhatsAppAccount.getForPurpose(own?.purpose || 'general');
  }

  static async requireConversation(conversationId) {
    const id = Number(conversationId);
    const conversation = Number.isInteger(id) ? await WaConversation.getById(id) : null;
    if (!conversation) {
      // No dedicated key: "route not found" is what a missing thread is, and
      // inventing a string here would put it out of step with the locale files.
      throw new WaError('common.routeNotFound', { code: 'conversation_not_found', status: 404 });
    }
    return conversation;
  }

  /**
   * The message shape the browser may see.
   *
   * Built field by field like `publicAccount`, and for the same reason: a
   * column added later must not reach the browser by default.
   */
  static publicMessage(row) {
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      direction: row.direction,
      body: row.body ?? null,
      attachment: row.attachment_path
        ? {
          url: row.attachment_path,
          type: row.attachment_type || null,
          name: row.attachment_name || null
        }
        : null,
      isNote: Boolean(row.is_note),
      externalId: row.external_id || null,
      deliveryStatus: row.delivery_status || null,
      deliveryError: row.delivery_error || null,
      attempts: Number(row.attempts || 0),
      sentBy: row.sent_by ?? null,
      // The column is NOT NULL, so the fallback is only for a row a test or a
      // fixture built by hand; the browser's type has no null in it.
      source: row.source || 'operator',
      readAt: row.read_at || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }
}

/**
 * Where this thread's messages go, in the form Evolution accepts as `number`.
 *
 * `destinoWa` decides between the phone and the LID; the normalisation below
 * only strips punctuation and adds the Brazilian country code to a number that
 * clearly lacks one. It never invents the ninth digit — see `waDestino.js`:
 * guessing it hits an old mobile and misses a landline, and the miss is silent
 * because the wrong number exists and belongs to someone else.
 */
export function destinationFor(conversation) {
  const destino = destinoWa(conversation, conversation);
  if (!destino) return null;
  // A LID is not a phone number and must keep its domain, or the server reads
  // fifteen digits as an international number and delivers nowhere.
  if (destino.tipo === 'lid') return `${destino.valor}@lid`;
  return normalizarTelefoneBr(destino.valor) || null;
}

/**
 * Evolution's media vocabulary has exactly four words. The column holds a MIME
 * type, so the mapping is by family — and anything unrecognised is a
 * 'document', which is the one kind that carries any bytes at all.
 */
export function mediaKind(attachmentType) {
  const raw = String(attachmentType || '').trim().toLowerCase();
  if (['image', 'video', 'audio', 'document'].includes(raw)) return raw;
  if (raw.startsWith('image/')) return 'image';
  if (raw.startsWith('video/')) return 'video';
  if (raw.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Accepts the request body's `attachment`, in either naming convention. */
function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const path = String(attachment.url ?? attachment.path ?? '').trim();
  if (!path) return null;
  const type = String(attachment.type ?? attachment.mimetype ?? '').trim();
  const name = String(attachment.name ?? attachment.fileName ?? '').trim();
  return {
    path: path.slice(0, BODY_ATTACHMENT_PATH_LIMIT),
    type: type.slice(0, ATTACHMENT_TYPE_LIMIT) || null,
    name: name.slice(0, BODY_ATTACHMENT_PATH_LIMIT) || null
  };
}

/**
 * Picks the route, sends once, and returns the server's message id.
 *
 * The audio branch is the delicate one. `sendMedia` with `mediatype: 'audio'`
 * delivers a FILE the recipient has to download; `sendWhatsAppAudio` delivers
 * the voice bubble that plays in place. Measured on the source system's real
 * account: three recordings made in the panel came out as attachments.
 */
async function sendThrough(client, account, message, number) {
  const { flavor, name } = account;
  const caption = String(message.body || '');

  if (!message.attachment_path) {
    const { data } = await client.sendOrThrow(sendTextRequest(flavor, name, number, caption));
    return readSentId(data);
  }

  const kind = mediaKind(message.attachment_type);
  if (kind === 'audio') {
    // Null on Evolution GO, whose PTT route has never been measured — and a
    // guessed path is exactly the mistake this integration already paid for.
    const request = sendAudioRequest(flavor, name, { number, url: message.attachment_path });
    if (request) {
      const result = await client.send(request);
      // ONLY a non-2xx falls through to sendMedia. Retrying after a 2xx sends
      // the audio twice, and nobody can unsend the second copy. A transport
      // failure or a 401 does not reach here at all: `send` throws on those,
      // and they would fail the same way on the media route.
      if (result.ok) return readSentId(result.data);
    }
  }

  const { data } = await client.sendOrThrow(sendMediaRequest(flavor, name, {
    number,
    type: kind,
    url: message.attachment_path,
    caption,
    fileName: message.attachment_name || ''
  }));
  return readSentId(data);
}

export default WaSendService;
