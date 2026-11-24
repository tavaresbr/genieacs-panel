import { describe, expect, it } from 'vitest'
import {
  SIGNUP_POPUP_FEATURES, SIGNUP_STATE_REFRESH_MS, WA_COEXISTENCE_EVENT, WA_EMBEDDED_SIGNUP_MESSAGE,
  canRetryCoexistenceSync, coexistenceStatus, isSignupSuccess, parseSignupMessage, signupFailureKey, signupPopupUrl
} from '@/lib/wa-embedded-signup'

const SIGNUP = 'https://tr69.com.br/whatsapp-signup.html'
const STATE = 'a'.repeat(64)
const popup = {}
const ok = {
  type: WA_EMBEDDED_SIGNUP_MESSAGE, state: STATE, event: WA_COEXISTENCE_EVENT, code: 'cod',
  wabaId: '123456789012345', phoneNumberId: '109876543210987', businessId: '5550001'
}
const msg = (over: Record<string, unknown> = {}, meta: { origin?: string; source?: unknown } = {}) => ({
  origin: meta.origin ?? 'https://tr69.com.br', source: 'source' in meta ? meta.source : popup, data: { ...ok, ...over }
})

describe('signupPopupUrl', () => {
  const start = { appId: '2151827142378177', configId: '1477066904263675', state: STATE, returnOrigin: 'https://painel.x.com', signupUrl: SIGNUP }

  it('monta a URL com o que o servidor deu e marca a coexistência', () => {
    const url = new URL(signupPopupUrl(start, { coexistence: true })!)
    expect(url.origin + url.pathname).toBe(SIGNUP)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app: start.appId, config: start.configId, state: STATE, return: 'https://painel.x.com', mode: 'coexistence'
    })
    expect(new URL(signupPopupUrl(start)!).searchParams.has('mode')).toBe(false)
  })

  it('não abre página que não é https nem ids que não são numéricos', () => {
    expect(signupPopupUrl({ ...start, signupUrl: 'http://tr69.com.br/x' })).toBeNull()
    expect(signupPopupUrl({ ...start, signupUrl: 'javascript:alert(1)' })).toBeNull()
    expect(signupPopupUrl({ ...start, appId: '1; drop' })).toBeNull()
  })
})

describe('parseSignupMessage', () => {
  it('aceita o sucesso da página de cadastro, da janela aberta, com o state certo', () => {
    const result = parseSignupMessage(msg(), popup, SIGNUP, STATE)!
    expect(isSignupSuccess(result)).toBe(true)
    expect(result).toMatchObject({ code: 'cod', wabaId: '123456789012345', phoneNumberId: '109876543210987', event: WA_COEXISTENCE_EVENT })
  })

  it('ignora outra origem, outra janela e outro state', () => {
    expect(parseSignupMessage(msg({}, { origin: 'https://evil.com' }), popup, SIGNUP, STATE)).toBeNull()
    expect(parseSignupMessage(msg({}, { origin: 'https://tr69.com.br.evil.com' }), popup, SIGNUP, STATE)).toBeNull()
    expect(parseSignupMessage(msg({}, { source: {} }), popup, SIGNUP, STATE)).toBeNull()
    expect(parseSignupMessage(msg({}), null, SIGNUP, STATE)).toBeNull()
    expect(parseSignupMessage(msg({ state: 'b'.repeat(64) }), popup, SIGNUP, STATE)).toBeNull()
    expect(parseSignupMessage(msg({ type: 'outra' }), popup, SIGNUP, STATE)).toBeNull()
    expect(parseSignupMessage({ origin: 'https://tr69.com.br', source: popup, data: 'texto' }, popup, SIGNUP, STATE)).toBeNull()
  })

  it('sucesso sem ids válidos ou sem FINISH vira erro, nunca um code solto', () => {
    expect(parseSignupMessage(msg({ wabaId: 'abc' }), popup, SIGNUP, STATE)).toMatchObject({ error: 'error' })
    expect(parseSignupMessage(msg({ phoneNumberId: null }), popup, SIGNUP, STATE)).toMatchObject({ error: 'error' })
    expect(parseSignupMessage(msg({ event: 'CANCEL' }), popup, SIGNUP, STATE)).toMatchObject({ error: 'error' })
  })

  it('cancelamento e erro da Meta chegam com a etapa', () => {
    const data = { code: undefined, event: 'CANCEL', error: 'cancelled', step: 'PHONE_NUMBER_SETUP' }
    expect(parseSignupMessage(msg(data), popup, SIGNUP, STATE)).toEqual({ error: 'cancelled', event: 'CANCEL', step: 'PHONE_NUMBER_SETUP' })
    expect(parseSignupMessage(msg({ code: undefined, error: undefined, event: undefined }), popup, SIGNUP, STATE))
      .toEqual({ error: 'cancelled', event: null, step: null })
  })
})

describe('coexistenceStatus', () => {
  const NOW = Date.parse('2026-11-24T12:00:00Z')
  const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString()

  it('número que não é de coexistência não tem o que mostrar', () => {
    expect(coexistenceStatus({ metaCoexistence: false }, NOW)).toBeNull()
    expect(coexistenceStatus({}, NOW)).toBeNull()
  })

  it('sincronizado é pronto, mesmo depois do prazo', () => {
    expect(coexistenceStatus({ metaCoexistence: true, metaSyncState: 'ok', metaCoexistenceDeadlineAt: inHours(-5) }, NOW))
      .toEqual({ state: 'ok' })
  })

  it('conta as horas que faltam, arredondando para cima e nunca mostrando zero', () => {
    const at = (h: number) => coexistenceStatus({ metaCoexistence: true, metaSyncState: 'pending', metaCoexistenceDeadlineAt: inHours(h) }, NOW)
    expect(at(23.2)).toMatchObject({ state: 'pending', hoursLeft: 24 })
    expect(at(2)).toMatchObject({ hoursLeft: 2 })
    expect(at(0.1)).toMatchObject({ hoursLeft: 1 })
  })

  it('passado o prazo sem sincronizar, expirou: a Meta já desconectou', () => {
    expect(coexistenceStatus({ metaCoexistence: true, metaSyncState: 'error', metaCoexistenceDeadlineAt: inHours(-1) }, NOW))
      .toEqual({ state: 'expired' })
    expect(coexistenceStatus({ metaCoexistence: true, metaSyncState: 'pending', metaCoexistenceDeadlineAt: inHours(0) }, NOW))
      .toEqual({ state: 'expired' })
  })

  it('erro traz o motivo e as horas, e sem prazo gravado assume as 24 h inteiras', () => {
    expect(coexistenceStatus({ metaCoexistence: true, metaSyncState: 'error', metaSyncError: 'history: (80008) Throttled', metaCoexistenceDeadlineAt: inHours(5) }, NOW))
      .toEqual({ state: 'error', hoursLeft: 5, reason: 'history: (80008) Throttled' })
    expect(coexistenceStatus({ metaCoexistence: true, metaSyncState: null }, NOW))
      .toEqual({ state: 'pending', hoursLeft: 24, reason: null })
  })

  it('só tenta de novo enquanto há o que pedir e prazo para pedir', () => {
    expect(canRetryCoexistenceSync({ state: 'error', hoursLeft: 3, reason: null })).toBe(true)
    expect(canRetryCoexistenceSync({ state: 'pending', hoursLeft: 3, reason: null })).toBe(true)
    expect(canRetryCoexistenceSync({ state: 'ok' })).toBe(false)
    expect(canRetryCoexistenceSync({ state: 'expired' })).toBe(false)
    expect(canRetryCoexistenceSync(null)).toBe(false)
  })
})

describe('signupFailureKey', () => {
  it('cancelar é uma frase, qualquer outro desfecho é "não concluiu"', () => {
    expect(signupFailureKey({ error: 'cancelled', event: 'CANCEL', step: null })).toBe('whatsapp.cloud.signup.cancelled')
    expect(signupFailureKey({ error: 'error', event: 'ERROR', step: null })).toBe('whatsapp.cloud.signup.failed')
    expect(signupFailureKey({ error: 'qualquer', event: null, step: null })).toBe('whatsapp.cloud.signup.failed')
  })
})

describe('o ciclo do state', () => {
  it('renova antes de os 10 minutos do servidor vencerem', () => {
    expect(SIGNUP_STATE_REFRESH_MS).toBeLessThan(10 * 60 * 1000)
  })

  it('o popup não pode abrir com noopener, ou o resultado não volta', () => {
    expect(SIGNUP_POPUP_FEATURES).not.toMatch(/noopener|noreferrer/)
  })
})
