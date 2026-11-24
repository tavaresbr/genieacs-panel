import express from 'express';
import MessengerInboundService from '../services/messengerInboundService.js';
import MessengerFacebookNoticeService from '../services/messengerFacebookNoticeService.js';
import { parseSignedRequest, readConfirmationCode } from '../utils/messenger/messengerSignedRequest.js';
import { verifyMetaSignature, safeEqual } from '../utils/messenger/messengerSignature.js';
import { waWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * Verificação do webhook: a Meta faz um GET com `hub.verify_token` ao
 * cadastrar a URL e espera o `hub.challenge` de volta, em texto puro.
 *
 * O token é UM só, da plataforma (`MESSENGER_VERIFY_TOKEN`), porque o app Meta
 * é um só. Ele não autentica entrega nenhuma — só prova que quem cadastrou a
 * URL na Meta conhece o segredo; quem autentica a entrega é a assinatura.
 */
router.get('/', waWebhookLimiter, (req, res) => {
  const expected = process.env.MESSENGER_VERIFY_TOKEN;
  const ok = expected
    && req.query['hub.mode'] === 'subscribe'
    && safeEqual(req.query['hub.verify_token'], expected);
  if (!ok) return res.sendStatus(403);
  // O desafio da Meta é um número. Só dígitos voltam: devolver o valor cru da
  // query seria refletir texto do chamador na resposta (XSS refletido).
  const challenge = String(req.query['hub.challenge'] ?? '');
  if (!/^\d{1,32}$/.test(challenge)) return res.sendStatus(400);
  return res.type('text/plain').send(challenge);
});

/**
 * Entrega de eventos. Pública (quem chama é a Meta, não uma sessão) e montada
 * com o corpo BRUTO, porque a assinatura é do corpo como chegou.
 *
 * Falha fechada: sem `META_APP_SECRET` ou com assinatura que não bate, 401 e
 * nada é lido do corpo. Com assinatura boa, o evento é gravado ANTES de
 * responder: é idempotente pelo `mid`, então um 500 (a Meta reentrega) não
 * duplica nada — e uma resposta 200 já significa "gravado".
 */
router.post('/', waWebhookLimiter, async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyMetaSignature(rawBody, req.get('x-hub-signature-256'), process.env.META_APP_SECRET)) {
    return res.sendStatus(401);
  }
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Assinado e ilegível: reentregar não conserta, então 200 e segue.
    return res.sendStatus(200);
  }
  try {
    const { unknownPages } = await MessengerInboundService.process(body);
    if (unknownPages) console.warn(`[messenger] ${unknownPages} delivery entr${unknownPages === 1 ? 'y' : 'ies'} for unknown pages ignored`);
    return res.sendStatus(200);
  } catch (error) {
    console.error('[messenger] webhook processing failed:', error.message);
    return res.sendStatus(500);
  }
});

/**
 * O `signed_request` dos avisos da Meta: o corpo é um formulário
 * (`application/x-www-form-urlencoded`), lido do corpo bruto que este caminho
 * reserva. Falha fechada: sem segredo ou com assinatura ruim, `null`.
 */
function signedRequestFrom(req) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  return parseSignedRequest(new URLSearchParams(raw).get('signed_request') ?? '', process.env.META_APP_SECRET);
}

/**
 * Aviso de desautorização: a pessoa removeu o app da conta dela. A credencial
 * é a assinatura do `signed_request`; a resposta é só 200.
 */
router.post('/deauthorize', waWebhookLimiter, async (req, res) => {
  const request = signedRequestFrom(req);
  if (!request) return res.sendStatus(401);
  try {
    await MessengerFacebookNoticeService.deauthorize(request.userId);
    return res.sendStatus(200);
  } catch (error) {
    console.error('[messenger] deauthorize failed:', error.message);
    return res.sendStatus(500);
  }
});

/**
 * Pedido de exclusão de dados. A Meta espera `{ url, confirmation_code }`: a
 * `url` é a página onde a pessoa acompanha o pedido (a de abaixo) e o código
 * é o que ela leva até lá.
 */
router.post('/data-deletion', waWebhookLimiter, async (req, res) => {
  const request = signedRequestFrom(req);
  if (!request) return res.sendStatus(401);
  try {
    const { confirmationCode } = await MessengerFacebookNoticeService.eraseUser(request.userId, process.env.META_APP_SECRET);
    const base = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
    return res.json({ url: `${base}/deletion-status?code=${confirmationCode}`, confirmation_code: confirmationCode });
  } catch (error) {
    console.error('[messenger] data deletion failed:', error.message);
    return res.sendStatus(500);
  }
});

/** O corpo das duas páginas é fixo: nada do que vem na URL é impresso. */
const page = (body) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Exclusão de dados</title></head><body>${body}</body></html>`;

const INSTRUCTIONS = `<h1>Como pedir a exclusão dos seus dados</h1>
<p>Este painel é usado por provedores de internet para atender clientes pelo Messenger. Há dois tipos de dado, e cada um se pede de um jeito.</p>
<h2>Se você conectou uma Página do Facebook ao painel</h2>
<p>Guardamos apenas o acesso à Página (um token cifrado) e o seu identificador no aplicativo. Para apagar: no Facebook, abra Configurações &gt; Aplicativos e sites, escolha este aplicativo e use a opção de remover e excluir os dados. O Facebook avisa o painel, que apaga o token das Páginas que você conectou e gera um código de confirmação. Você também pode desconectar a Página no próprio painel, em Configuração &gt; Integrações &gt; Messenger.</p>
<h2>Se você conversou com um provedor pelo Messenger</h2>
<p>As mensagens pertencem ao provedor de internet com quem você falou, que é quem decide o que fazer com elas. Peça a exclusão diretamente a esse provedor; ele pode apagar a conversa pelo painel. A política de privacidade do painel explica quem é responsável por cada dado.</p>
<p><a href="/privacidade">Política de privacidade</a></p>`;

/**
 * A página de instruções de exclusão de dados — o endereço que a Meta pede no
 * app — e, com `?code=`, a de status de um pedido. Sem código ela SEMPRE
 * abre (200): a Meta valida o endereço antes de aceitá-lo. Com código, o
 * código é verificável (sem guardar nada): só o que o painel emitiu aparece
 * como concluído.
 */
router.get('/deletion-status', waWebhookLimiter, (req, res) => {
  if (req.query.code === undefined) return res.type('html').send(page(INSTRUCTIONS));
  const issuedAt = readConfirmationCode(req.query.code, process.env.META_APP_SECRET);
  const body = issuedAt
    ? `<h1>Pedido de exclusão de dados</h1><p>Concluído em ${issuedAt.toISOString().slice(0, 10)}.</p><p>Removemos o acesso às Páginas que você conectou ao painel pelo login do Facebook (o token de cada Página e o seu identificador no aplicativo). O histórico de conversas pertence ao provedor de internet que usa o painel; para pedir a exclusão dele, fale com o provedor.</p>`
    : '<h1>Pedido de exclusão de dados</h1><p>Código não reconhecido.</p>';
  res.status(issuedAt ? 200 : 404).type('html').send(page(body));
});

export default router;
