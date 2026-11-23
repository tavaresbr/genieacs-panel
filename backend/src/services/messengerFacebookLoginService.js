import MessengerPage from '../models/MessengerPage.js';
import MessengerPageService, { MessengerError, messengerConfigured } from './messengerPageService.js';
import { graphRequest, isMetaId } from './metaGraphClient.js';

/**
 * O login do Facebook para conectar Páginas, em vez de colar o id e o token.
 *
 * O navegador entra com o SDK da Meta (`/messenger-connect.html`) e entrega só
 * o token de curta duração do USUÁRIO. Daqui para frente é tudo no servidor:
 * troca por um de longa duração, lista as Páginas que a pessoa administra e,
 * na escolha, pega o token da Página (que vem sem prazo de validade quando o
 * do usuário é de longa duração) e passa pelo mesmo caminho da conexão manual.
 * Nada é guardado entre os dois passos: o navegador reenvia o token do usuário
 * a cada um, e o token da Página nunca volta para ele.
 */

const MAX_USER_TOKEN = 1024;
const MAX_PAGE_REQUESTS = 5;

/** O app da Meta que faz o login: público (vai na página de login), ao contrário do segredo. */
export function facebookAppId() {
  const id = String(process.env.META_APP_ID ?? '').trim();
  return /^\d{5,32}$/.test(id) ? id : '';
}

/** O login precisa do app id além do que a conexão manual já exige. */
export function facebookLoginAvailable() {
  return Boolean(facebookAppId()) && messengerConfigured();
}

function cleanUserToken(value) {
  const token = String(value ?? '').trim();
  if (!token) throw new MessengerError('missing_token', 'user access token is required');
  if (token.length > MAX_USER_TOKEN || /\s/.test(token)) {
    throw new MessengerError('invalid_token', 'invalid user access token');
  }
  return token;
}

function requireAvailable() {
  if (!facebookLoginAvailable()) {
    throw new MessengerError('facebook_login_unconfigured', 'the platform has not configured the Facebook login', 503);
  }
}

/** Troca o token de curta duração do usuário pelo de longa duração. */
async function exchange(userToken) {
  const result = await graphRequest({
    path: '/oauth/access_token',
    metaToken: userToken,
    query: {
      grant_type: 'fb_exchange_token',
      client_id: facebookAppId(),
      client_secret: String(process.env.META_APP_SECRET),
      fb_exchange_token: userToken
    }
  });
  const longLived = result.data?.access_token;
  if (!result.ok || typeof longLived !== 'string' || !longLived) {
    throw new MessengerError('meta_refused', result.error || 'meta_refused', 502);
  }
  return longLived;
}

/** O id do usuário NO APP (só o número): é o `user_id` dos avisos de desautorização e exclusão. */
async function appUserId(longToken) {
  const result = await graphRequest({ path: '/me', metaToken: longToken, query: { fields: 'id' } });
  const id = String(result.data?.id ?? '');
  return result.ok && /^\d{1,32}$/.test(id) ? id : null;
}

/** Todas as Páginas que o usuário administra, com o token de cada uma (só aqui dentro). */
async function accounts(longToken) {
  const pages = [];
  let after = null;
  for (let i = 0; i < MAX_PAGE_REQUESTS; i += 1) {
    const result = await graphRequest({
      path: '/me/accounts',
      metaToken: longToken,
      query: { fields: 'id,name,access_token', limit: '100', ...(after ? { after } : {}) }
    });
    if (!result.ok) throw new MessengerError('meta_refused', result.error || 'meta_refused', 502);
    for (const p of Array.isArray(result.data?.data) ? result.data.data : []) {
      if (isMetaId(p?.id)) pages.push({ id: String(p.id), name: String(p.name ?? ''), token: String(p.access_token ?? '') });
    }
    after = result.data?.paging?.next ? result.data?.paging?.cursors?.after : null;
    if (!after) break;
  }
  return pages;
}

class MessengerFacebookLoginService {
  /** As Páginas do usuário, só com o que a tela mostra: id, nome e se já está conectada. */
  static async listPages(userToken) {
    requireAvailable();
    const token = cleanUserToken(userToken);
    const found = await accounts(await exchange(token));
    const out = [];
    for (const p of found) {
      out.push({ id: p.id, name: p.name, connected: await MessengerPage.existsAnywhere(p.id) });
    }
    return out;
  }

  /** Conecta a Página escolhida com o token que a própria Meta entregou para ela. */
  static async connect(userToken, pageId) {
    requireAvailable();
    const token = cleanUserToken(userToken);
    const id = String(pageId ?? '').trim();
    if (!isMetaId(id)) throw new MessengerError('invalid_page_id', 'invalid page id');
    const longToken = await exchange(token);
    const page = (await accounts(longToken)).find((p) => p.id === id);
    if (!page) throw new MessengerError('page_not_administered', 'the user does not administer this page', 403);
    if (!page.token) throw new MessengerError('missing_token', 'meta did not return a token for this page', 502);
    return MessengerPageService.connect({ pageId: id, pageToken: page.token, facebookUserId: await appUserId(longToken) });
  }
}

export default MessengerFacebookLoginService;
