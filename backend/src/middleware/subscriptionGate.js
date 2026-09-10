import SubscriptionService, { GATE_CODES } from '../services/subscriptionService.js';

/**
 * A porta da assinatura, logo depois do resolvedor.
 *
 * Roda dentro do escopo que `resolveTenant` abriu, e é isso que a deixa ler a
 * assinatura por `tdb` sem saber o id: o provedor é o do host. Numa
 * implantação com subdomínio o token tem que bater com o host
 * (`tokenMatchesHost`), então a assinatura do host É a do operador; numa sem
 * subdomínio há um provedor só. Nos dois casos a porta responde pelo provedor
 * certo sem esperar a autenticação — o que importa, porque a tela de bloqueio
 * precisa aparecer também para quem ainda nem entrou.
 *
 * O que NÃO passa por ela, e por quê, um a um:
 *
 *   /api/auth/*          Entrar tem que funcionar num provedor bloqueado: é
 *                        entrando que o operador vê o aviso, e é entrando que
 *                        um administrador da plataforma chega ao console.
 *   /api/tenant/public   O nome do provedor na tela de login e de bloqueio.
 *   /api/tenant/subscription  O que a tela de bloqueio mostra: estado, plano,
 *                        até quando. Sem isto o 402 seria um muro sem placa.
 *   /api/platform/*      O plano de controle vive ACIMA das assinaturas; um
 *                        provedor cancelado é justamente um que o console
 *                        precisa alcançar.
 *
 * Os webhooks (ERP, Evolution) passam pela porta mas não contam como "o
 * operador escrevendo": em `past_due` eles continuam entrando. A regra está
 * em `SubscriptionService.decide`, e o motivo também.
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
export function requireActiveSubscription({ portal = false } = {}) {
  return async function subscriptionGate(req, res, next) {
    // `req.originalUrl` e não `req.path`: montado com `app.use('/api', …)`,
    // o `path` que o Express entrega aqui já perdeu o prefixo.
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    if (!portal && isExempt(path)) return next();

    let state;
    try {
      state = await SubscriptionService.current();
    } catch (error) {
      return next(error);
    }

    const decision = SubscriptionService.decide(state.subscription, {
      method: req.method,
      // No portal, tudo é leitura para efeito da porta: ver o comentário acima.
      webhook: portal || isWebhook(path)
    });
    if (decision.allowed) return next();

    const key = MESSAGE_KEYS[decision.code] || 'subscription.suspended';
    return res.status(402).json({
      success: false,
      code: decision.code,
      message: req.t ? req.t(key) : decision.code,
      subscription: SubscriptionService.present(state)
    });
  };
}

export default requireActiveSubscription;
