import { describe, expect, it } from 'vitest'
import {
  WA_COEXISTENCE_EVENT, WA_EMBEDDED_SIGNUP_MESSAGE, isSignupSuccess, parseSignupMessage, signupPopupUrl
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
