/**
 * Os planos e o que cada um comporta.
 *
 * Catálogo em código e não em tabela, e a escolha tem motivo. Um limite é uma
 * decisão comercial que muda raramente e que precisa passar por revisão: numa
 * tabela, um dígito errado numa linha alarga o limite de todo mundo daquele
 * plano em silêncio, sem diff, sem revisor e sem teste. Em código, a mesma
 * mudança é um commit que alguém leu.
 *
 * O que VARIA por cliente — «este ISP negociou 40 operadores» — não é o plano,
 * é uma exceção, e exceção mora na linha da assinatura
 * (`max_operators`, `max_subscriber_accounts`). É o que evita o catálogo virar
 * uma lista de planos de um cliente cada.
 *
 * ## `null` é ilimitado, e é o padrão de quem já existia
 *
 * Toda instalação que já estava no ar quando os limites nasceram ficou em
 * `unlimited`. Aplicar um teto retroativamente a quem já tem doze operadores
 * não cobra nada de ninguém — só impede o ISP de contratar o décimo terceiro,
 * num dia em que ele não mudou nada e não foi avisado. O plano de quem já é
 * cliente é uma conversa comercial, não uma migration.
 */

/**
 * O teto de ONTs NÃO está aqui, e a ausência é deliberada.
 *
 * O plano previa «contagem de ONTs vinda do GenieACS» junto dos outros
 * limites. Mas não existe ponto de escrita para uma ONT: ela aparece porque
 * informou ao ACS do provedor, que é dele e não nosso. Não há requisição a
 * recusar — quando a contagem passa do teto, o equipamento já está lá.
 *
 * Fingir que é um limite levaria a uma de duas coisas ruins: esconder ONTs do
 * painel (o ISP perde a visão da própria rede por causa da nossa fatura) ou
 * bloquear a tela inteira (o mesmo, pior). A contagem é MEDIÇÃO — entra em
 * `planLimitService.usage()`, aparece na tela de plano e uso, e é a base da
 * conversa de upgrade. Cobrar é o caminho; travar não é.
 */
export const UNLIMITED = null;

const definir = (code, { operators, subscriberAccounts }) => Object.freeze({
  code,
  maxOperators: operators,
  maxSubscriberAccounts: subscriberAccounts
});

export const PLANS = Object.freeze({
  // Sem teto. É o que a migration deu a quem já estava no ar, e o que uma
  // instalação self-hosted é por natureza — lá não há assinatura conosco.
  unlimited: definir('unlimited', { operators: UNLIMITED, subscriberAccounts: UNLIMITED }),
  starter: definir('starter', { operators: 3, subscriberAccounts: 1_000 }),
  pro: definir('pro', { operators: 10, subscriberAccounts: 10_000 }),
  enterprise: definir('enterprise', { operators: 50, subscriberAccounts: UNLIMITED })
});

export const PLAN_CODES = Object.freeze(Object.keys(PLANS));

/** O plano de um código, ou o ilimitado quando o código não existe. */
export function planFor(code) {
  const texto = String(code ?? '').trim().toLowerCase();
  // Um código que ninguém reconhece devolve ILIMITADO, e não o menor plano,
  // pelo mesmo motivo pelo qual a ausência de assinatura libera: um dado
  // estranho no banco não pode virar um bloqueio comercial que ninguém
  // contratou. Ver o topo de `middleware/requireActiveSubscription.js`.
  return PLANS[texto] ?? PLANS.unlimited;
}

/**
 * Os limites que valem para uma assinatura, com as exceções aplicadas.
 *
 * A exceção sobrescreve o plano quando existe — inclusive para BAIXO, que é o
 * caso raro mas legítimo de um cliente cujo contrato prevê menos do que o
 * plano de prateleira.
 */
export function limitsFrom(subscription) {
  const plano = planFor(subscription?.plan_code);
  const excecao = (valor) => {
    if (valor === null || valor === undefined) return undefined;
    const n = Number(valor);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  return Object.freeze({
    planCode: plano.code,
    maxOperators: excecao(subscription?.max_operators) ?? plano.maxOperators,
    maxSubscriberAccounts:
      excecao(subscription?.max_subscriber_accounts) ?? plano.maxSubscriberAccounts
  });
}

/** Se `usados` já alcançou o teto. `null` nunca alcança. */
export function atLimit(usados, teto) {
  if (teto === UNLIMITED || teto === undefined) return false;
  return Number(usados) >= Number(teto);
}
