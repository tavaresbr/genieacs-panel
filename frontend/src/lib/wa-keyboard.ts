/**
 * A altura que sobra à vista quando o teclado do celular está aberto.
 *
 * No Safari do iOS o teclado não encolhe a página (o `interactive-widget` da
 * meta viewport só vale no Chrome do Android): só a `visualViewport` encolhe.
 * A caixa de entrada tem altura em `dvh`, então o compositor ficava atrás do
 * teclado. Com esta conta o cartão passa a caber na parte visível.
 *
 * `null` quando não há teclado. A margem de 120 px deixa de fora a barra de
 * endereço que recolhe ao rolar; e no Android, onde a página já encolhe junto,
 * as duas alturas andam iguais e nada muda.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em `node`, sem jsdom, e
 * função pura aqui é a forma de a decisão ter teste.
 */
const KEYBOARD_MIN_PX = 120

export function visibleHeightWithKeyboard({ innerHeight, vvHeight }: { innerHeight: number; vvHeight: number }): number | null {
  if (!(innerHeight > 0) || !(vvHeight > 0)) return null
  return innerHeight - vvHeight > KEYBOARD_MIN_PX ? Math.round(vvHeight) : null
}

/**
 * A altura do cartão para que o fim dele fique logo acima do teclado.
 *
 * A conta antiga era `vvHeight - 9rem`, que supõe o cartão a 9rem do topo da
 * área visível. No iPhone, ao focar a caixa de escrever, o Safari rola a
 * página para mostrá-la e o topo do cartão sobe para fora da tela: o fim do
 * cartão ficava mais de um palmo acima do teclado, com um vazio no meio. Aqui
 * a conta parte de onde o cartão está de verdade (`cardTop`, em coordenadas da
 * página visível) e do fim da área visível (`vvTop + vvHeight`).
 *
 * `margin` é o respiro entre o cartão e o teclado; `min` impede um cartão
 * minúsculo se a posição vier estranha.
 */
export function cardHeightAboveKeyboard(
  { vvTop, vvHeight, cardTop }: { vvTop: number; vvHeight: number; cardTop: number },
  { margin = 8, min = 160 }: { margin?: number; min?: number } = {}
): number | null {
  if (![vvTop, vvHeight, cardTop].every(Number.isFinite) || !(vvHeight > 0)) return null
  return Math.max(Math.round(vvTop + vvHeight - cardTop - margin), min)
}

/**
 * O cartão saiu da área visível com o teclado aberto?
 *
 * É o estado da tela escura do iPhone: o Safari deslocou a área visível para
 * mostrar a caixa de escrever e, com o cartão fora dela, só sobra o fundo. Deve
 * ter ao menos `min` px do cartão à vista; senão a página traz o cartão de volta
 * (`scrollIntoView`). Só vale com o teclado aberto: sem ele ninguém desloca nada.
 */
export function cardOutOfView(
  { vvTop, vvHeight, cardTop, cardBottom }: { vvTop: number; vvHeight: number; cardTop: number; cardBottom: number },
  { min = 40 }: { min?: number } = {}
): boolean {
  if (![vvTop, vvHeight, cardTop, cardBottom].every(Number.isFinite) || !(vvHeight > 0)) return false
  const visible = Math.min(cardBottom, vvTop + vvHeight) - Math.max(cardTop, vvTop)
  return visible < min
}
