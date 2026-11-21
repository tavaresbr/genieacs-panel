import { describe, expect, it } from 'vitest'
import { failureDetail } from '../src/lib/failure-text'

describe('failureDetail', () => {
  it('status e motivo do servidor', () => {
    expect(failureDetail({ status: 500, error: 'ENOSPC: no space left on device' })).toBe(' (HTTP 500 · ENOSPC: no space left on device)')
  })
  it('só o status quando não há motivo, ou o motivo é o genérico', () => {
    expect(failureDetail({ status: 502 })).toBe(' (HTTP 502)')
    expect(failureDetail({ status: 500, error: 'Erro desconhecido' }, ['Erro desconhecido'])).toBe(' (HTTP 500)')
  })
  it('nada quando não há o que dizer; corta motivo longo e junta espaços', () => {
    expect(failureDetail({})).toBe('')
    expect(failureDetail({ status: 500, error: `a\n  b ${'x'.repeat(300)}` }).length).toBeLessThan(200)
  })
})
