import AddonService from '../services/addonService.js';
import { authenticateToken } from './auth.js';

/**
 * A porta dos add-ons pagos (0126): `requireAddon('whatsapp')` na frente de
 * um grupo de rotas recusa com 402 `addon_required` o provedor que não tem o
 * add-on daquele recurso.
 *
 * ## Desligada por padrão
 *
 * Só recusa quando o catálogo tem um add-on ATIVO e `gated` com aquela chave
 * (`AddonService.gatesFor`, guardado quinze segundos). Sem isso — o estado de
 * todo deploy até alguém ligar no console — ela é um `next()` sem consulta
 * nenhuma: vender o add-on não tira o recurso de quem já o usa. A caixa da
 * plataforma passa sempre; quem está em teste passa quando o add-on diz
 * `trial_access` (ver `AddonService.refusalFor`).
 *
 * ## O 401 antes do 402
 *
 * Montada num prefixo (`app.use('/api/whatsapp', ...)`), ela roda antes da
 * autenticação de cada rota. Ligada, ela autentica primeiro
 * (`authenticateToken`, que também aplica a porta da assinatura): quem não
 * tem sessão ouve o 401 de sempre, e o fato "este provedor não pagou o
 * add-on" nunca vira resposta a um anônimo — o mesmo cuidado da porta da
 * assinatura. Numa rota já autenticada (`req.user`), confere direto.
 *
 * O 402 não começa com `subscription_`: a casca do app não o confunde com a
 * assinatura bloqueada — é a tela daquele recurso que diz o porquê.
 */
/**
 * O que mora em `/api/whatsapp` e não é do add-on de WhatsApp: os alertas (o
 * Telegram e o e-mail vivem na mesma tela), as quedas, as manutenções e o
 * indique e ganhe. Ficam abertos com a porta ligada.
 */
export const WHATSAPP_ADDON_EXEMPT_PATHS = Object.freeze(['/alerts', '/outages', '/maintenances', '/referrals']);

export function requireAddon(feature, { except = [] } = {}) {
  // Os caminhos (relativos ao ponto de montagem) que a porta deixa passar:
  // num prefixo que mistura recursos (`/api/whatsapp` leva também o alerta
  // do Telegram, as quedas e o indique e ganhe), só o que é do add-on fecha.
  const livres = except.map((caminho) => String(caminho).replace(/\/+$/, ''));
  const livre = (caminho) => livres.some((base) => caminho === base || caminho.startsWith(`${base}/`));
  return async (req, res, next) => {
    try {
      if (livres.length && livre(String(req.path || ''))) return next();
      const portas = await AddonService.gatesFor(feature);
      if (!portas.length) return next();
      const conferir = async () => {
        try {
          // A sessão do console não usa recurso de provedor; quem a recusa é
          // `requirePermission`, logo adiante.
          if (req.user?.platform) return next();
          const recusa = await AddonService.refusalFor(feature);
          if (!recusa) return next();
          return res.status(402).json({
            success: false,
            code: 'addon_required',
            message: req.t ? req.t('addons.required') : 'addon_required',
            feature: recusa.feature,
            addons: recusa.addons
          });
        } catch (error) {
          return next(error);
        }
      };
      if (req.user) return conferir();
      return authenticateToken(req, res, (erro) => (erro ? next(erro) : conferir()));
    } catch (error) {
      return next(error);
    }
  };
}

export default requireAddon;
