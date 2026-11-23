import MessengerPage from '../models/MessengerPage.js';
import { createSecretBox } from '../utils/secretBox.js';
import { MESSENGER_WEBHOOK_PATH } from '../config/messengerWebhookPath.js';
import { graphRequest, isMetaId } from './metaGraphClient.js';
import MessengerMediaService from './messengerMediaService.js';
import { tdb } from '../config/database.js';

const pageTokenBox = createSecretBox('skygenpanel-messenger-page-token-v1');

/** Os campos que a Página precisa assinar para o painel receber conversa e recibo. */
export const SUBSCRIBED_FIELDS = 'messages,message_deliveries,message_reads,messaging_postbacks,messaging_referrals';

export class MessengerError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MessengerError';
    this.code = code;
    this.status = status;
  }
}

export function encryptPageToken(token) {
  return JSON.stringify({ v: 1, ...pageTokenBox.encrypt(token) });
}

export function decryptPageToken(stored) {
  if (!stored) return '';
  try {
    return pageTokenBox.decrypt(JSON.parse(stored)) ?? '';
  } catch {
    return '';
  }
}

/** A Página como o navegador pode vê-la: campo a campo, sem o token. */
export function publicPage(row) {
  return {
    id: row.id,
    pageId: row.page_id,
    pageName: row.page_name,
    status: row.status,
    subscribedAt: row.subscribed_at,
    webhookError: row.webhook_error,
    webhookRefusedAt: row.webhook_refused_at,
    webhookRefusedReason: row.webhook_refused_reason,
    createdAt: row.created_at
  };
}

/** Se o painel tem o que precisa para falar com a Meta (segredos da plataforma). */
export function messengerConfigured() {
  return Boolean(process.env.META_APP_SECRET && process.env.MESSENGER_VERIFY_TOKEN);
}

class MessengerPageService {
  static webhookPath() {
    return MESSENGER_WEBHOOK_PATH;
  }

  /**
   * Conecta uma Página: confere o token na Graph, assina os campos do webhook e
   * guarda o token cifrado. O token vem da tela (login do Facebook), e aqui só
   * entra confirmado — a Meta diz de que Página ele é, e o id que o operador
   * digitou tem de bater.
   */
  static async connect({ pageId, pageToken, facebookUserId = null }) {
    const id = String(pageId ?? '').trim();
    const token = String(pageToken ?? '').trim();
    if (!isMetaId(id)) throw new MessengerError('invalid_page_id', 'invalid page id');
    if (!token) throw new MessengerError('missing_token', 'page access token is required');
    if (!messengerConfigured()) {
      throw new MessengerError('messenger_unconfigured', 'the platform has not configured the Messenger app', 503);
    }
    if (await MessengerPage.existsAnywhere(id)) {
      throw new MessengerError('page_already_connected', 'this page is already connected', 409);
    }

    const identity = await graphRequest({ path: `/${id}`, metaToken: token, query: { fields: 'id,name' } });
    if (!identity.ok) throw new MessengerError('meta_refused', identity.error, 502);
    if (String(identity.data?.id) !== id) {
      throw new MessengerError('page_mismatch', 'the token does not belong to this page', 400);
    }

    const row = await MessengerPage.create({
      page_id: id,
      page_name: String(identity.data?.name ?? '').slice(0, 128) || null,
      page_token: encryptPageToken(token),
      status: 'connected',
      facebook_user_id: facebookUserId ? String(facebookUserId) : null
    });
    return this.subscribe(row);
  }

  /** (Re)assina os campos do webhook. Grava o motivo se a Meta recusar. */
  static async subscribe(row) {
    const token = decryptPageToken(row.page_token);
    const result = await graphRequest({
      method: 'POST',
      path: `/${row.page_id}/subscribed_apps`,
      metaToken: token,
      body: { subscribed_fields: SUBSCRIBED_FIELDS.split(',') }
    });
    if (result.ok) {
      return MessengerPage.update(row.id, { subscribed_at: new Date(), webhook_error: null, status: 'connected' });
    }
    return MessengerPage.update(row.id, { webhook_error: String(result.error).slice(0, 255), status: 'error' });
  }

  /**
   * Assina de novo os campos do webhook de uma Página já conectada — para
   * quem conectou antes de um campo novo existir (os links de vínculo precisam
   * de `messaging_referrals`). Recusa sem tocar na Meta se não há token guardado.
   */
  static async resubscribe(id) {
    const row = await MessengerPage.getById(id);
    if (!row) throw new MessengerError('page_not_found', 'page not found', 404);
    if (!decryptPageToken(row.page_token)) throw new MessengerError('missing_token', 'no page token is stored', 400);
    return this.subscribe(row);
  }

  /** Desconecta: cancela a assinatura (se der) e apaga a Página e, em cascata, o que veio dela. */
  static async disconnect(id) {
    const row = await MessengerPage.getById(id);
    if (!row) throw new MessengerError('page_not_found', 'page not found', 404);
    const token = decryptPageToken(row.page_token);
    if (token) {
      // Melhor esforço: a Página some do painel mesmo que a Meta esteja fora.
      await graphRequest({ method: 'DELETE', path: `/${row.page_id}/subscribed_apps`, metaToken: token });
    }
    // Os arquivos dos anexos saem junto com as mensagens (que somem em cascata com a Página).
    const files = await tdb('messenger_messages')
      .whereIn('conversation_id', tdb('messenger_conversations').where({ page_row_id: row.id }).select('id'))
      .whereNotNull('attachment_path')
      .select('attachment_path');
    await MessengerPage.remove(id);
    await MessengerMediaService.removeFiles(files);
  }
}

export default MessengerPageService;
