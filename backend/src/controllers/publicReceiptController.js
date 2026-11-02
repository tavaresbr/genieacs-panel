import Tenant from '../models/Tenant.js';
import { runInTenant } from '../config/tenantContext.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { esc, receiptData, renderReceipt, RECEIPT_CSP } from '../services/chargeReceiptService.js';
import { verifyReceiptToken } from '../utils/receiptLinkToken.js';

/**
 * O recibo de uma cobrança PAGA, aberto do link que o bot do WhatsApp da
 * plataforma mandou ao dono do provedor:
 *
 *   - `POST /api/public/receipt` com `{ token }` no corpo — o que a página
 *     pública `/receipt#<token>` chama. O token vem no fragmento do link e vai
 *     no corpo, como o da pesquisa e o do convite: fora do caminho, fora de
 *     todo log de acesso;
 *   - `GET /api/public/receipt/:token` — o link antigo, com o token no
 *     caminho, que continua abrindo enquanto os já mandados valem (sete dias).
 *     O log de acesso mascara o segmento (`redactPath`).
 *
 * Sem sessão: o token assinado (`receiptLinkToken.js`) é a credencial e nomeia
 * o provedor e a cobrança. Toda recusa — token adulterado, vencido, cobrança
 * que não existe, que não está paga, provedor que sumiu — dá a MESMA resposta,
 * um 404 sem nome de provedor nem motivo: quem testa tokens não aprende nada.
 *
 * As travas do recibo autenticado valem aqui também: a CSP que não deixa rodar
 * nada e `nosniff` — e mais as de um link público: sem cache, sem referrer e
 * fora dos buscadores.
 */
function cabecalhos(res) {
  res.setHeader('Content-Security-Policy', RECEIPT_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
}

/** A recusa única: o mesmo 404 para todo motivo. */
function recusa(req, res) {
  cabecalhos(res);
  const texto = req.t ? req.t('receipt.linkInvalid') : translate(DEFAULT_LOCALE, 'receipt.linkInvalid');
  return res.status(404).send(
    '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${esc(texto)}</title></head><body style="font-family:sans-serif;padding:24px">`
    + `<p>${esc(texto)}</p></body></html>`
  );
}

class PublicReceiptController {
  /** `GET /receipt/:token` — o link antigo. */
  static async receipt(req, res) {
    return PublicReceiptController.responder(req, res, req.params?.token);
  }

  /** `POST /receipt` — `{ token }` no corpo; a mesma resposta, HTML. */
  static async receiptByBody(req, res) {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    return PublicReceiptController.responder(req, res, token);
  }

  static async responder(req, res, token) {
    const alvo = verifyReceiptToken(token);
    if (!alvo) return recusa(req, res);
    try {
      // A caixa da plataforma não tem recibo de assinatura: só provedor.
      const tenant = await Tenant.findById(alvo.tenantId);
      if (!tenant || tenant.kind !== 'provider') return recusa(req, res);
      // Dentro do escopo do provedor do token: a cobrança de outro não existe
      // ali, e `receiptData` recusa a que não está paga.
      const dados = await runInTenant(alvo.tenantId, () => receiptData(alvo.chargeId));
      const html = renderReceipt(dados, { locale: req.locale || DEFAULT_LOCALE });
      cabecalhos(res);
      res.setHeader('Content-Disposition', `inline; filename="recibo-${Number(dados.charge.id)}.html"`);
      return res.send(html);
    } catch (error) {
      // Recusa do recibo (404/409) ou falha: a mesma resposta para quem pede.
      if (!error?.status) console.error('Public receipt error:', error?.message || error);
      return recusa(req, res);
    }
  }
}

export default PublicReceiptController;
