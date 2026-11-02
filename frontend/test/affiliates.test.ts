import { describe, expect, it } from 'vitest'
import {
  affiliateCodeFromQuery, bpToPercent, parseMonths, passwordTokenFromHash, payoutActions, percentToBp
} from '@/lib/affiliates'
import en from '@/lib/i18n/locales/en'

describe('o programa de afiliados na tela (0124)', () => {
  it('lê o código do link como o servidor, sempre com o prefixo', () => {
    expect(affiliateCodeFromQuery(' a-ab12cd ')).toBe('A-AB12CD')
    expect(affiliateCodeFromQuery('ab12cd')).toBe('A-AB12CD')
    expect(affiliateCodeFromQuery('x')).toBeNull()
    expect(affiliateCodeFromQuery(null)).toBeNull()
  })

  it('converte porcentagem e pontos-base nos dois sentidos', () => {
    expect(bpToPercent(1000)).toBe('10')
    expect(bpToPercent(1250)).toBe('12.5')
    expect(bpToPercent(null)).toBe('')
    expect(percentToBp('10')).toBe(1000)
    expect(percentToBp('12,5')).toBe(1250)
    expect(percentToBp('')).toBeNull()
    expect(percentToBp('101')).toBeUndefined()
    expect(percentToBp('abc')).toBeUndefined()
  })

  it('aceita meses de 1 a 120', () => {
    expect(parseMonths('12')).toBe(12)
    expect(parseMonths('')).toBeNull()
    expect(parseMonths('0')).toBeUndefined()
    expect(parseMonths('121')).toBeUndefined()
  })

  it('lê o token do link de senha só do fragmento certo', () => {
    const token = 'a'.repeat(64)
    expect(passwordTokenFromHash(`#senha=${token}`)).toBe(token)
    expect(passwordTokenFromHash('#senha=curto')).toBeNull()
    expect(passwordTokenFromHash('')).toBeNull()
  })

  it('só oferece o envio do lote aprovado, e pede confirmação no falho incerto', () => {
    expect(payoutActions({ status: 'draft', amountCents: 100 })).toMatchObject({ approve: true, send: false, markPaid: false, cancel: true })
    expect(payoutActions({ status: 'draft', amountCents: 0 }).approve).toBe(false)
    expect(payoutActions({ status: 'approved', amountCents: 100 })).toMatchObject({ approve: false, send: true, markPaid: true })
    expect(payoutActions({ status: 'sent', amountCents: 100 })).toMatchObject({ send: false, refresh: true, cancel: false })
    expect(payoutActions({ status: 'failed', errorCode: 'uncertain', amountCents: 100 })).toMatchObject({ retry: true, needsConfirm: true })
    expect(payoutActions({ status: 'failed', errorCode: 'refused', amountCents: 100 }).needsConfirm).toBe(false)
    expect(payoutActions({ status: 'paid', amountCents: 100 })).toMatchObject({ send: false, retry: false, markPaid: false, cancel: false })
  })

  it('tem a aba no dicionário', () => {
    expect(en).toHaveProperty('platform.tabs.affiliates')
    expect(en).toHaveProperty('signup.affiliate')
  })
})
