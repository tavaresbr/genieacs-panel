import SubscriptionService, { GATE_CODES } from '../services/subscriptionService.js';
import { IS_SAAS } from '../config/edition.js';

/**
 * A porta da assinatura, chamada DEPOIS da autenticação.
 *
 * Ela já ficou logo depois do resolvedor, como `app.use('/api', …)`, e a razão
 * era boa: a tela de bloqueio deveria aparecer também para quem ainda nem
 * entrou. O preço, que só aparece quando se olha para a resposta de um
 * ESTRANHO, é alto demais. Ali a porta responde antes do 401, então um
 * `GET /api/devices` sem token nenhum devolve 402 num provedor inadimplente e
 * 401 num em dia — e o corpo do 402 ainda trazia o plano. Qualquer um que
 * alcance o host, e o host é público, varre e descobre quais ISPs estão
 * atrasados na fatura.
 *
 * Isso é exatamente o que `tenantController.getPublicProfile` proíbe, com
 * estas palavras: não distinguir "não existe" de "existe e está suspenso",
 * «um fato sobre o negócio de outra pessoa que estaríamos publicando». A porta
 * no lugar antigo violava a regra de outro arquivo, que é como uma regra assim
 * costuma cair.
 *
 * Chamada de dentro de `authenticateToken` e de `authenticatePortalCustomer`,
 * a ordem 401-antes-de-402 passa a ser garantida por construção, e o operador
 * do provedor bloqueado continua vendo a placa do muro: `/api/auth/*` está
 * fora da porta, ele entra normalmente, e a primeira chamada autenticada
 * devolve o 402 com o código que a tela lê. O que se perde é mostrar o muro a
 * um visitante deslogado — que é precisamente a parte que vazava.
 *
 * Roda dentro do escopo que a sessão abriu, e é isso que a deixa ler a
 * assinatura por `tdb` sem saber o id.
 *
 * O que NÃO passa por ela, e por quê, um a um:
 *
 *   /api/auth/*          Entrar tem que funcionar num provedor bloqueado: é
 *                        entrando que o operador vê o aviso, e é entrando que
 *                        um administrador da plataforma chega ao console. Na
 *                        posição nova a maioria destas rotas já não passaria
 *                        pela porta de todo jeito — a lista fica porque uma
 *                        isenção que depende de a rota continuar sem sessão é
 *                        uma isenção que some no dia em que alguém a autentica.
 *   /api/tenant/public   O nome do provedor na tela de login e de bloqueio.
 *   /api/tenant/subscription  O que a tela de bloqueio mostra: estado, plano,
 *                        até quando. Sem isto o 402 seria um muro sem placa.
 *   /api/platform/*      O plano de controle vive ACIMA das assinaturas; um
 *                        provedor cancelado é justamente um que o console
 *                        precisa alcançar.
 *
 * Os webhooks (ERP, Evolution) não têm sessão, então na posição nova não
 * chegam aqui e passam SEMPRE — antes passavam só em `past_due`. A diferença é
 * deliberada e vai na mesma direção do resto: recusar um evento do ERP perde
 * dado de quem não deve nada (o assinante), e um 402 numa entrega anônima
 * seria o mesmo oráculo de enumeração por outra porta. A regra de leitura em
 * `past_due` continua em `SubscriptionService.decide` para quem tem sessão.
 *
 * Só existe na edição SaaS — quem monta é `app.js`, e monta atrás de
 * `IS_SAAS`. Na self-hosted não há assinatura para cobrar, e a migração deu a
 * todo provedor existente um plano sem limites em `active`, então mesmo que
 * fosse montada ela deixaria tudo passar.
 */
const EXEMPT_PREFIXES = ['/api/auth/', '/api/platform/', '/api/health'];
const EXEMPT_PATHS = new Set(['/api/tenant/public', '/api/tenant/subscription', '/api/auth']);
// Os caminhos EXATOS das entregas de fora. `/api/sgp/events` sem o
// `/webhook` é a listagem autenticada e o retry — escrita de operador, que em
// `past_due` tem que ser recusada como qualquer outra. O do Evolution está
// montado ANTES do resolvedor em `app.js`, então nunca chega aqui; fica na
// lista pelo dia em que alguém o mover para baixo.
const WEBHOOK_PREFIXES = ['/api/sgp/events/webhook', '/api/whatsapp-webhook'];

function isExempt(path) {
  if (EXEMPT_PATHS.has(path)) return true;
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isWebhook(path) {
  return WEBHOOK_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const MESSAGE_KEYS = Object.freeze({
  [GATE_CODES.PAST_DUE]: 'subscription.pastDue',
  [GATE_CODES.TRIAL_EXPIRED]: 'subscription.trialExpired',
  [GATE_CODES.SUSPENDED]: 'subscription.suspended',
  [GATE_CODES.CANCELED]: 'subscription.canceled',
  [GATE_CODES.MISSING]: 'subscription.missing'
});

/**
 * @param {{ portal?: boolean }} options `portal` é o app do assinante, onde
 *   `past_due` passa inteiro — ler E escrever — porque o assinante não é quem
 *   deve, e o autoatendimento dele é o que o plano manda manter de pé.
 */
export async function subscriptionRefusal(req, { portal = false } = {}) {
  // A edição, conferida AQUI e não em `app.js`.
  //
  // Enquanto a porta era um `app.use`, quem a mantinha fora da self-hosted era
  // o `if (IS_SAAS)` que a montava. Chamada de dentro da autenticação, que roda
  // nas duas edições, essa guarda tinha de vir junto — sem ela, um painel
  // self-hosted passa a exigir assinatura de si mesmo.
  if (!IS_SAAS) return null;
  // `req.originalUrl` e não `req.path`: dentro de um router montado, o `path`
  // que o Express entrega já perdeu o prefixo, e a isenção fala do caminho
  // inteiro.
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!portal && isExempt(path)) return null;

  const state = await SubscriptionService.current();
  const decision = SubscriptionService.decide(state.subscription, {
    method: req.method,
    // No portal, tudo é leitura para efeito da porta: ver o comentário acima.
    webhook: portal || isWebhook(path)
  });
  if (decision.allowed) return null;

  const key = MESSAGE_KEYS[decision.code] || 'subscription.suspended';
  return {
    success: false,
    code: decision.code,
    message: req.t ? req.t(key) : decision.code,
    subscription: SubscriptionService.present(state)
  };
}

export default subscriptionRefusal;
