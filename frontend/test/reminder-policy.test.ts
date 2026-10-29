import { describe, expect, it } from 'vitest'

import type { ReminderStep } from '@/lib/api'
import {
  insertVariable,
  newStep,
  offsetForKind,
  renderReminderTemplate,
  sampleValues,
  sortSteps,
  validateReminderPolicy
} from '@/lib/reminder-policy'

/**
 * A régua de cobrança (0121) na tela: as mesmas regras do servidor
 * (`backend/src/services/reminderPolicy.js`) e a pré-visualização.
 */
const passo = (patch: Partial<ReminderStep> = {}): ReminderStep => ({
  id: 'before', kind: 'before', offsetDays: -5, channels: ['whatsapp', 'email'], enabled: true, subject: '', body: '', ...patch
})

describe('a validação', () => {
  it('aceita a régua padrão', () => {
    expect(validateReminderPolicy({
      steps: [passo(), passo({ id: 'due', kind: 'due', offsetDays: 0 }), passo({ id: 'after', kind: 'after', offsetDays: 3 })]
    })).toBeNull()
  })

  it('recusa com o código e o passo, como o servidor', () => {
    expect(validateReminderPolicy({ steps: [passo({ id: 'Maiusculo' })] })).toEqual({ code: 'invalid_step_id', index: 0 })
    expect(validateReminderPolicy({ steps: [passo({ id: 'manual' })] })?.code).toBe('invalid_step_id')
    expect(validateReminderPolicy({ steps: [passo(), passo()] })).toEqual({ code: 'duplicate_step_id', index: 1 })
    expect(validateReminderPolicy({ steps: [passo({ offsetDays: 0 })] })?.code).toBe('invalid_offset')
    expect(validateReminderPolicy({ steps: [passo({ offsetDays: -31 })] })?.code).toBe('invalid_offset')
    expect(validateReminderPolicy({ steps: [passo({ kind: 'after', offsetDays: 61 })] })?.code).toBe('invalid_offset')
    expect(validateReminderPolicy({ steps: [passo({ channels: [] })] })?.code).toBe('invalid_channels')
    expect(validateReminderPolicy({ steps: [passo({ channels: [], enabled: false })] })).toBeNull()
    expect(validateReminderPolicy({ steps: [passo({ subject: 'x'.repeat(151) })] })?.code).toBe('subject_too_long')
    expect(validateReminderPolicy({ steps: [passo({ body: 'x'.repeat(2001) })] })?.code).toBe('body_too_long')
    const nove = Array.from({ length: 9 }, (_, i) => passo({ id: `p${i}`, kind: 'after', offsetDays: i + 1 }))
    expect(validateReminderPolicy({ steps: nove })).toEqual({ code: 'too_many_steps', index: null })
  })
})

describe('a pré-visualização', () => {
  it('troca as variáveis com os valores limpos, numa passada só', () => {
    expect(renderReminderTemplate('{empresa}: {valor} em {vencimento} ({plano}) {link} {x}', {
      empresa: 'A <b>B</b>\nC', valor: 'R$ 1,00', vencimento: '2026-01-02', plano: '{link}', link: 'https://x.test'
    })).toBe('A bB/b C: R$ 1,00 em 2026-01-02 ({link}) https://x.test {x}')
  })

  it('o vencimento de exemplo fica a tantos dias quanto o passo diz', () => {
    const agora = new Date('2026-10-10T12:00:00Z')
    expect(sampleValues(-5, agora).vencimento).toBe('2026-10-15')
    expect(sampleValues(3, agora).vencimento).toBe('2026-10-07')
  })

  it('a variável entra na posição do cursor', () => {
    expect(insertVariable('Olá !', 'empresa', 4)).toEqual({ text: 'Olá {empresa}!', caret: 13 })
    expect(insertVariable('Fim', 'link', null)).toEqual({ text: 'Fim{link}', caret: 9 })
  })
})

describe('a edição', () => {
  it('trocar o tipo ajusta os dias para a faixa dele', () => {
    expect(offsetForKind('after', -5)).toBe(5)
    expect(offsetForKind('before', 3)).toBe(-3)
    expect(offsetForKind('due', 7)).toBe(0)
    expect(offsetForKind('before', 0)).toBe(-5)
    expect(offsetForKind('before', 45)).toBe(-30)
  })

  it('o passo novo tem id livre e cai depois do último', () => {
    const agora = Date.UTC(2026, 9, 29, 12)
    const novo = newStep([passo({ id: 'passo1', kind: 'after', offsetDays: 3 })], agora)
    expect(novo.id).toBe(`p${agora.toString(36)}`)
    expect(novo.id.length).toBeLessThanOrEqual(16)
    // O mesmo instante com o id já na tela: desempata, sem repetir.
    expect(newStep([novo], agora).id).toBe(`p${agora.toString(36)}-1`)
    expect(novo.offsetDays).toBe(4)
    expect(validateReminderPolicy({ steps: [novo] })).toBeNull()
  })

  it('ordena pelo dia, estável', () => {
    const a = passo({ id: 'a', kind: 'after', offsetDays: 3 })
    const b = passo({ id: 'b', offsetDays: -5 })
    const c = passo({ id: 'c', offsetDays: -5 })
    expect(sortSteps([a, b, c]).map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })
})
