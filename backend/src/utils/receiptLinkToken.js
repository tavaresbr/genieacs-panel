import 'dotenv/config';
import crypto from 'node:crypto';
import { DEVELOPMENT_FALLBACK, isProduction } from '../config/runtimeEnv.js';

/**
 * A credencial do link público do recibo (`GET /api/public/receipt/:token`).
 *
 * Quem abre o link é o dono do provedor, no celular, a partir do WhatsApp da
 * plataforma — sem sessão. Então o próprio link é a credencial, e tudo o que o
 * torna seguro mora aqui, num lugar só: o bot cunha e a rota confere, e um
 * assinante e um conferente que divergem falham ABERTOS.
 *
 * O token carrega o provedor, a cobrança e a validade, assinados por HMAC com
 * uma chave derivada do `JWT_SECRET` num contexto próprio — a mesma construção
 * de `waMediaToken.js`. Chave própria não é cerimônia: o mesmo segredo usado
 * cru assinaria sessão e recibo, e uma fraqueza num uso viraria a do outro.
 *
 * Sete dias de vida: o dono pede o recibo para mandar à contabilidade, e a
 * contabilidade não abre no mesmo minuto. Mais do que isso e um link esquecido
 * num grupo de WhatsApp vira acesso permanente ao documento.
 *
 * Sem versão de chave, como no anexo: girar o `JWT_SECRET` invalida os links
 * em circulação, e o dono pede outro ao bot. Não há nada guardado para perder.
 */
export const RECEIPT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CONTEXT = 'platform-receipt-link';
/** Teto do token aceito: o que este assinante gera tem bem menos de 120. */
const TAMANHO_MAXIMO = 200;

let cachedKey = null;
let cachedFrom = null;

function signingKey() {
  if (!process.env.JWT_SECRET && isProduction()) {
    throw new Error('JWT_SECRET must be set to sign receipt links');
  }
  const base = process.env.JWT_SECRET || DEVELOPMENT_FALLBACK;
  // Lembrada contra o segredo que a produziu: um processo cujo segredo mudou
  // não pode continuar assinando com o antigo.
  if (cachedKey && cachedFrom === base) return cachedKey;
  cachedKey = crypto.createHmac('sha256', base).update(CONTEXT).digest();
  cachedFrom = base;
  return cachedKey;
}

/** A assinatura sobre os BYTES apresentados — nunca sobre um valor re-serializado. */
function digest(corpo) {
  return crypto.createHmac('sha256', signingKey()).update(corpo).digest('base64url');
}

/**
 * Cunha o token de UMA cobrança de UM provedor.
 *
 * @param {{ tenantId: number, chargeId: number }} alvo
 * @returns {string} `<corpo base64url>.<hmac base64url>`
 */
export function signReceiptToken({ tenantId, chargeId }, now = Date.now()) {
  const tid = Number(tenantId);
  const cid = Number(chargeId);
  if (!Number.isInteger(tid) || tid <= 0 || !Number.isInteger(cid) || cid <= 0) {
    throw new Error('receipt link needs a provider id and a charge id');
  }
  const exp = Math.floor((now + RECEIPT_LINK_TTL_MS) / 1000);
  const corpo = Buffer.from(`r1.${tid}.${cid}.${exp}`, 'utf8').toString('base64url');
  return `${corpo}.${digest(corpo)}`;
}

/**
 * O que o token diz, se foi cunhado aqui e ainda vale — ou `null`.
 *
 * `null` para toda recusa, sem dizer qual: adulterado, vencido ou malformado
 * são a mesma resposta para quem pergunta, e a rota não pode distinguir os
 * três para um estranho.
 *
 * @returns {{ tenantId: number, chargeId: number, expiresAt: Date } | null}
 */
export function verifyReceiptToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token || token.length > TAMANHO_MAXIMO) return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [corpo, assinatura] = partes;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(corpo) || !/^[A-Za-z0-9_-]{1,64}$/.test(assinatura)) return null;

  // A assinatura primeiro, e em tempo constante: nada do corpo é lido antes
  // de se saber que foi este servidor que o escreveu.
  const esperada = Buffer.from(digest(corpo), 'utf8');
  const apresentada = Buffer.from(assinatura, 'utf8');
  if (esperada.length !== apresentada.length || !crypto.timingSafeEqual(esperada, apresentada)) return null;

  const texto = Buffer.from(corpo, 'base64url').toString('utf8');
  const achado = /^r1\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,12})\.([0-9]{1,12})$/.exec(texto);
  if (!achado) return null;
  const exp = Number(achado[3]) * 1000;
  if (exp <= now) return null;
  return { tenantId: Number(achado[1]), chargeId: Number(achado[2]), expiresAt: new Date(exp) };
}

export default { signReceiptToken, verifyReceiptToken, RECEIPT_LINK_TTL_MS };
