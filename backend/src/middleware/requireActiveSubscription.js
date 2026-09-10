import TenantSubscription from '../models/TenantSubscription.js';
import { IS_SAAS } from '../config/edition.js';
import {
  allowsPanel, allowsPanelWrites, allowsPortal, isSafeMethod,
  normalizeStatus, SUBSCRIPTION_CODES
} from '../config/subscription.js';

/**
 * O portão comercial: o que a assinatura de cada provedor deixa passar.
 *
 * ## Por que ele roda DEPOIS da autenticação, e não em `app.use`
 *
 * Montá-lo sobre `/api`, logo atrás do `resolveTenant`, é o lugar óbvio e está
 * errado. Ali ele responde ANTES do 401 — e aí um `GET /api/devices` sem token
 * nenhum devolve 402 num provedor inadimplente e 401 num provedor em dia.
 * Qualquer estranho na internet passa a poder perguntar, host por host, quais
 * ISPs estão atrasados na fatura.
 *
 * Essa regra não é nova: está escrita no `tenantController.getPublicProfile`,
 * que proíbe distinguir "não existe" de "existe e está suspenso" — «um fato
 * sobre o negócio de outra pessoa que estaríamos publicando». O portão em
 * `app.use` a violaria de outro arquivo, que é exatamente como uma regra assim
 * costuma cair.
 *
 * Rodando dentro de `authenticateToken` e de `authenticatePortalCustomer`, a
 * ordem passa a ser garantida pela construção: quem não tem sessão recebe 401 e
 * nunca chega aqui, e quem recebe 402 já provou ser de dentro do provedor sobre
 * o qual está aprendendo algo.
 *
 * ## A ausência de linha passa, e não é descuido
 *
 * Um provedor sem linha de assinatura é liberado. A pergunta é qual erro custa
 * mais, e os dois não são simétricos:
 *
 * - Fechar por engano trava um cliente que PAGOU, fora do horário comercial,
 *   sem nada que ele possa fazer — e a primeira coisa que ele faz é ligar
 *   dizendo que o sistema caiu.
 * - Abrir por engano dá acesso de graça a um inadimplente até alguém notar.
 *
 * O segundo é dinheiro, e dinheiro é recuperável. O primeiro é confiança, que é
 * o que um ISP compra ao terceirizar o painel dele para a gente. Por isso a
 * ausência libera, e um estado desconhecido também (`normalizeStatus`).
 *
 * Isto NÃO é uma fronteira de segurança e não deve virar uma: quem decide o que
 * cada pessoa pode fazer é `permissions.js`, e de qual provedor são as linhas é
 * a tenancy. Este arquivo decide só se a fatura está em dia.
 */

/**
 * Caminhos que o portão nunca fecha, mesmo autenticados.
 *
 * `/api/platform` porque é de lá que a suspensão se desfaz, e o console roda no
 * escopo do host dele — que é um provedor como outro qualquer, e cuja fatura
 * não deveria poder trancar o plano de controle inteiro.
 *
 * `/api/tenant/export` porque recusar a um cliente cancelado o próprio cadastro
 * é reter dado de terceiro como alavanca de cobrança. O que se corta é o
 * serviço; o que ele cadastrou continua sendo dele, e sair levando os dados é
 * justamente o que a portabilidade significa.
 *
 * Casam por SEGMENTO, e não por prefixo de texto: `/api/platformx` não é
 * `/api/platform`, e um `startsWith` cru transformaria cada isenção numa
 * família de rotas parecidas que ninguém quis isentar.
 */
const SEMPRE_ABERTOS = ['/api/platform', '/api/tenant/export'];

function isento(req) {
  // `originalUrl` e não `path`: dentro de um router montado, `path` é relativo
  // ao ponto de montagem, e a isenção fala do caminho inteiro.
  const rota = String(req.originalUrl ?? '').split('?')[0];
  return SEMPRE_ABERTOS.some((base) => rota === base || rota.startsWith(`${base}/`));
}

function corpo(req, code, status) {
  return {
    success: false,
    code,
    subscriptionStatus: status,
    message: code === SUBSCRIPTION_CODES.READ_ONLY
      ? req.t('subscription.readOnly')
      : req.t('subscription.blocked')
  };
}

/**
 * A recusa que a assinatura deste provedor impõe a esta requisição, ou `null`.
 *
 * Devolve o corpo em vez de responder porque quem chama é o middleware de
 * autenticação, e é lá que a ordem 401-antes-de-402 fica visível.
 *
 * Precisa de provedor em escopo — o que é sempre verdade no ponto onde é
 * chamada, logo depois de a sessão ter reescopado a requisição.
 */
export async function panelSubscriptionRefusal(req) {
  if (!IS_SAAS) return null;
  if (isento(req)) return null;
  try {
    const assinatura = await TenantSubscription.current();
    if (!assinatura) return null;
    const status = normalizeStatus(assinatura.status);
    if (!allowsPanel(status)) return corpo(req, SUBSCRIPTION_CODES.BLOCKED, status);
    if (!allowsPanelWrites(status) && !isSafeMethod(req.method)) {
      return corpo(req, SUBSCRIPTION_CODES.READ_ONLY, status);
    }
    return null;
  } catch (error) {
    // O portão que não consegue ler a assinatura libera, pelo mesmo motivo pelo
    // qual a ausência libera: um banco intermitente não pode virar um bloqueio
    // comercial de todo mundo ao mesmo tempo.
    console.warn(`Subscription gate skipped: ${error.message}`);
    return null;
  }
}

/**
 * A mesma pergunta, do lado do portal do assinante.
 *
 * `past_due` PASSA inteiro — e é a decisão comercial mais importante desta
 * fase, não um detalhe. Quem está devendo é o provedor; quem usa o portal é o
 * cliente FINAL dele, que não deve nada e não tem como resolver. Derrubar o
 * autoatendimento de milhares de assinantes para cobrar um ISP transforma um
 * boleto atrasado num problema de suporte deles, e é o que faz o ISP nos trocar
 * em vez de nos pagar.
 *
 * Em `suspended` e `canceled` cai junto: aí o contrato acabou, e continuar
 * servindo os assinantes de um contrato encerrado é hospedar de graça sem prazo.
 */
export async function portalSubscriptionRefusal(req) {
  if (!IS_SAAS) return null;
  try {
    const assinatura = await TenantSubscription.current();
    if (!assinatura) return null;
    const status = normalizeStatus(assinatura.status);
    if (allowsPortal(status)) return null;
    return corpo(req, SUBSCRIPTION_CODES.BLOCKED, status);
  } catch (error) {
    console.warn(`Portal subscription gate skipped: ${error.message}`);
    return null;
  }
}
