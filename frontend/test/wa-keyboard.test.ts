import { describe, expect, it } from 'vitest'
import { cardHeightAboveKeyboard, cardOutOfView, keyboardFrame, visibleHeightWithKeyboard } from '../src/lib/wa-keyboard'

describe('visibleHeightWithKeyboard', () => {
  it('com o teclado aberto no iPhone, devolve a altura visível', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: 460 })).toBe(460)
  })

  it('sem teclado, não muda nada', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: 812 })).toBeNull()
  })

  it('a barra de endereço recolhendo não conta como teclado', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: 760 })).toBeNull()
  })

  it('no Android a página já encolhe junto: nada a corrigir', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 460, vvHeight: 460 })).toBeNull()
  })

  it('valores inválidos não quebram a conta', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 0, vvHeight: 0 })).toBeNull()
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: Number.NaN })).toBeNull()
  })

  it('arredonda o zoom fracionário do iOS', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: 459.6 })).toBe(460)
  })
})

describe('cardHeightAboveKeyboard', () => {
  it('com o cartão no lugar de sempre, o fim fica logo acima do teclado', () => {
    // área visível de 460 px, cartão começando a 144 px do topo
    expect(cardHeightAboveKeyboard({ vvTop: 0, vvHeight: 460, cardTop: 144 })).toBe(308)
  })

  it('com a página rolada (topo do cartão fora da tela), o cartão cobre até o teclado', () => {
    // o Safari rolou: o topo do cartão está 120 px acima da área visível
    expect(cardHeightAboveKeyboard({ vvTop: 0, vvHeight: 460, cardTop: -120 })).toBe(572)
  })

  it('a área visível deslocada (vvTop) entra na conta', () => {
    expect(cardHeightAboveKeyboard({ vvTop: 60, vvHeight: 460, cardTop: 100 })).toBe(412)
  })

  it('nunca devolve um cartão menor que o mínimo', () => {
    expect(cardHeightAboveKeyboard({ vvTop: 0, vvHeight: 200, cardTop: 190 })).toBe(160)
  })

  it('valores inválidos não quebram a conta', () => {
    expect(cardHeightAboveKeyboard({ vvTop: 0, vvHeight: Number.NaN, cardTop: 0 })).toBeNull()
    expect(cardHeightAboveKeyboard({ vvTop: 0, vvHeight: 0, cardTop: 0 })).toBeNull()
  })
})

describe('cardOutOfView', () => {
  const vv = { vvTop: 0, vvHeight: 500 }
  it('cartão dentro da área visível não precisa de ajuste', () => {
    expect(cardOutOfView({ ...vv, cardTop: 100, cardBottom: 490 })).toBe(false)
  })
  it('cartão que subiu para fora da tela (a tela escura do iPhone) precisa', () => {
    expect(cardOutOfView({ ...vv, cardTop: -600, cardBottom: -20 })).toBe(true)
  })
  it('cartão abaixo da área visível também', () => {
    expect(cardOutOfView({ ...vv, cardTop: 520, cardBottom: 900 })).toBe(true)
  })
  it('só uma tira do cartão à vista (menos de 40 px) conta como fora', () => {
    expect(cardOutOfView({ ...vv, cardTop: -300, cardBottom: 20 })).toBe(true)
    expect(cardOutOfView({ ...vv, cardTop: -300, cardBottom: 80 })).toBe(false)
  })
  it('com a área visível deslocada, mede contra ela', () => {
    expect(cardOutOfView({ vvTop: 300, vvHeight: 500, cardTop: 0, cardBottom: 200 })).toBe(true)
    expect(cardOutOfView({ vvTop: 300, vvHeight: 500, cardTop: 250, cardBottom: 700 })).toBe(false)
  })
  it('medida estranha não mexe na página', () => {
    expect(cardOutOfView({ vvTop: Number.NaN, vvHeight: 500, cardTop: 0, cardBottom: 10 })).toBe(false)
    expect(cardOutOfView({ vvTop: 0, vvHeight: 0, cardTop: 0, cardBottom: 10 })).toBe(false)
  })
})

describe('keyboardFrame', () => {
  it('com o teclado aberto, o quadro é exatamente a área visível', () => {
    expect(keyboardFrame({ innerHeight: 812, vvTop: 0, vvHeight: 460 })).toEqual({ top: 0, height: 460 })
  })

  it('quando o Safari desloca a área visível, o quadro vai junto (e termina no teclado)', () => {
    const frame = keyboardFrame({ innerHeight: 812, vvTop: 120, vvHeight: 460 })
    expect(frame).toEqual({ top: 120, height: 460 })
    // fim do quadro = fim da área visível, logo acima do teclado
    expect(frame!.top + frame!.height).toBe(120 + 460)
  })

  it('sem teclado, não há quadro (nada muda)', () => {
    expect(keyboardFrame({ innerHeight: 812, vvTop: 0, vvHeight: 812 })).toBeNull()
    expect(keyboardFrame({ innerHeight: 812, vvTop: 0, vvHeight: 760 })).toBeNull()
  })

  it('no Android a página já encolhe junto: sem quadro', () => {
    expect(keyboardFrame({ innerHeight: 460, vvTop: 0, vvHeight: 460 })).toBeNull()
  })

  it('arredonda e nunca devolve topo negativo', () => {
    expect(keyboardFrame({ innerHeight: 812, vvTop: 59.6, vvHeight: 459.6 })).toEqual({ top: 60, height: 460 })
    expect(keyboardFrame({ innerHeight: 812, vvTop: -3, vvHeight: 460 })).toEqual({ top: 0, height: 460 })
  })

  it('valores inválidos não quebram a conta', () => {
    expect(keyboardFrame({ innerHeight: 812, vvTop: Number.NaN, vvHeight: 460 })).toBeNull()
    expect(keyboardFrame({ innerHeight: 0, vvTop: 0, vvHeight: 0 })).toBeNull()
  })
})

import { nextBaseInner } from '../src/lib/wa-keyboard'
describe('nextBaseInner', () => {
  it('segue a janela sem campo em foco', () => {
    expect(nextBaseInner({ base: 800, baseWidth: 400, innerHeight: 700, innerWidth: 400, fieldFocused: false })).toEqual({ base: 700, baseWidth: 400 })
  })
  it('com campo em foco guarda a maior altura (janela encolhida pelo teclado)', () => {
    expect(nextBaseInner({ base: 800, baseWidth: 400, innerHeight: 430, innerWidth: 400, fieldFocused: true })).toEqual({ base: 800, baseWidth: 400 })
  })
  it('recomeça ao girar o aparelho', () => {
    expect(nextBaseInner({ base: 800, baseWidth: 400, innerHeight: 390, innerWidth: 850, fieldFocused: true })).toEqual({ base: 390, baseWidth: 850 })
  })
})

describe('keyboardFrame com zoom', () => {
  it('zoom de pinça não é teclado', () => {
    expect(keyboardFrame({ innerHeight: 800, vvTop: 0, vvHeight: 400, scale: 2 })).toBeNull()
  })
  it('sem zoom continua detectando', () => {
    expect(keyboardFrame({ innerHeight: 800, vvTop: 0, vvHeight: 400, scale: 1 })).toEqual({ top: 0, height: 400 })
  })
})
