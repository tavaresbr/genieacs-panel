/**
 * O estado comercial de um provedor, e o que cada estado deixa acontecer.
 *
 * É um eixo SEPARADO de `tenants.status`, e a separação é o ponto de partida
 * desta fase. `tenants.status` é administrativo: `suspended` ali significa
 * congelado, e é pré-requisito da exclusão em duas etapas — "ninguém está
 * trabalhando lá dentro". Se a inadimplência escrevesse na mesma coluna, todo
 * boleto atrasado tornaria o provedor elegível a ser apagado. Ninguém pediu
 * essa consequência para um pagamento em atraso.
 *
 * ## A regra que mais importa aqui não é técnica
 *
 * **O portal do assinante continua de pé em `past_due`.** Quem está devendo é o
 * provedor; quem usa o portal é o cliente FINAL dele, que não deve nada a
 * ninguém e não tem como resolver. Derrubar o autoatendimento de milhares de
 * assinantes para cobrar um ISP é transformar um atraso de fatura num problema
 * de suporte do cliente — e é a decisão que faz o ISP nos trocar em vez de nos
 * pagar.
 *
 * Em `suspended` e `canceled` o portal cai junto, e a diferença é que aí o
 * serviço acabou de fato: continuar servindo os assinantes de um contrato
 * encerrado é hospedar de graça por tempo indeterminado.
 */

/** Os estados que existem. Qualquer outro valor é dado corrompido. */
export const SUBSCRIPTION_STATUSES = Object.freeze([
  'trial', 'active', 'past_due', 'suspended', 'canceled'
]);

/** Passa por tudo: em dia, ou dentro do prazo de teste. */
const FULL_ACCESS = Object.freeze(['trial', 'active']);

/** Lê, mas não escreve. O painel abre; salvar, não. */
const READ_ONLY = Object.freeze(['past_due']);

/**
 * O código que o frontend lê para saber QUAL tela de bloqueio mostrar.
 *
 * Código e não texto: a mensagem é traduzida em treze idiomas e vai mudar de
 * redação; o que o frontend liga a uma tela precisa ser estável.
 */
export const SUBSCRIPTION_CODES = Object.freeze({
  READ_ONLY: 'subscription_read_only',
  BLOCKED: 'subscription_blocked'
});

/** Métodos que não alteram nada. `past_due` deixa passar só estes. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method) {
  return SAFE_METHODS.has(String(method ?? '').toUpperCase());
}

/**
 * O estado, normalizado.
 *
 * Um valor desconhecido vira `active`, e a escolha é deliberada — ver
 * `middleware/requireActiveSubscription.js`, onde a mesma pergunta aparece para
 * a assinatura AUSENTE e tem a mesma resposta pelo mesmo motivo.
 */
export function normalizeStatus(status) {
  const texto = String(status ?? '').trim().toLowerCase();
  return SUBSCRIPTION_STATUSES.includes(texto) ? texto : 'active';
}

/** O painel abre neste estado? */
export function allowsPanel(status) {
  const s = normalizeStatus(status);
  return FULL_ACCESS.includes(s) || READ_ONLY.includes(s);
}

/** O painel deixa SALVAR neste estado? */
export function allowsPanelWrites(status) {
  return FULL_ACCESS.includes(normalizeStatus(status));
}

/**
 * O portal do assinante abre neste estado?
 *
 * `past_due` está aqui e não é engano — é a regra do topo deste arquivo.
 */
export function allowsPortal(status) {
  const s = normalizeStatus(status);
  return FULL_ACCESS.includes(s) || READ_ONLY.includes(s);
}
