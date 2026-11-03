import { CONSOLE_AUDIENCE, PANEL_AUDIENCE, generateConsoleTokens, generateTokens } from '../middleware/auth.js';
import RefreshToken from '../models/RefreshToken.js';
import { clearRefreshCookie, setRefreshCookie } from '../middleware/sessionCookie.js';

/**
 * Onde uma sessão do painel ou do console NASCE (0129): login, setup, convite
 * aceito e o 2FA ligado numa sessão antiga. Abre a família em
 * `refresh_tokens`, põe o refresh no cookie e devolve só o token de acesso —
 * o único que a tela vê, e que ela guarda só na memória.
 *
 * O cookie do OUTRO tipo é apagado no mesmo passo. Num deploy de host único o
 * console e o painel dividem a origem, e o navegador seguia com uma sessão só
 * (antes, o par no `localStorage`); deixar os dois cookies vivos faria um F5
 * escolher qual dos dois voltar.
 */
export async function openPanelSession(req, res, user, membership) {
  const tenantId = Number(membership.tenant_id ?? membership.tenantId);
  const { familyId, raw } = await RefreshToken.startFamily({
    user, audience: PANEL_AUDIENCE, tenantId, context: RefreshToken.context(req)
  });
  setRefreshCookie(req, res, 'panel', raw);
  clearRefreshCookie(req, res, 'console');
  return generateTokens(user, membership, { sessionId: familyId }).accessToken;
}

export async function openConsoleSession(req, res, user) {
  const { familyId, raw } = await RefreshToken.startFamily({
    user, audience: CONSOLE_AUDIENCE, tenantId: null, context: RefreshToken.context(req)
  });
  setRefreshCookie(req, res, 'console', raw);
  clearRefreshCookie(req, res, 'panel');
  return generateConsoleTokens(user, { sessionId: familyId }).accessToken;
}

/** O tipo de cookie de uma audiência. */
export function cookieKindFor(audience) {
  return audience === CONSOLE_AUDIENCE ? 'console' : 'panel';
}
