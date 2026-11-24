/**
 * O lado do painel do Embedded Signup (WhatsApp oficial).
 *
 * O SDK da Meta só roda no domínio cadastrado no app, que não é o do painel do
 * provedor: o painel abre `/whatsapp-signup.html` NESSE domínio num popup e
 * recebe o resultado por `postMessage`. Quem confia em quê:
 *
 *  - o popup só devolve ao `returnOrigin` que o servidor aceitou (`start`);
 *  - o painel só aceita a mensagem que vem da ORIGEM da página de cadastro, da
 *    janela que ele próprio abriu, e com o `state` que o servidor deu — três
 *    conferências, porque uma sozinha deixaria outra aba ou outra janela
 *    injetar um `code` (que o servidor ainda recusaria, mas não é para chegar lá).
 *
 * O `code` é entregue ao servidor e nunca guardado nem mostrado aqui.
 */

/** O que `/whatsapp-signup.js` manda ao painel. */
export const WA_EMBEDDED_SIGNUP_MESSAGE = 'wa-embedded-signup'
/** O evento da Meta para o número que continua no app do celular. */
export const WA_COEXISTENCE_EVENT = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'

export type SignupStart = {
  appId: string
  configId: string
  state: string
  returnOrigin: string
  signupUrl: string
}

export type SignupSuccess = {
  event: string
  code: string
  wabaId: string
  phoneNumberId: string
  businessId: string | null
}
export type SignupFailure = { error: 'cancelled' | 'error' | string; event: string | null; step: string | null }
export type SignupResult = SignupSuccess | SignupFailure

export function isSignupSuccess(result: SignupResult): result is SignupSuccess {
  return 'code' in result
}

const DIGITS = /^\d{5,32}$/

/** A origem (`https://host`) de uma URL https; qualquer outra coisa é `null`. */
export function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null
  } catch {
    return null
  }
}

/**
 * A URL do popup: só `https:`, e o que vai na consulta é o que o servidor deu.
 * `null` se a URL da página não é https (o painel não abre o que não confia).
 */
export function signupPopupUrl(start: SignupStart, options: { coexistence?: boolean } = {}): string | null {
  if (!httpsOrigin(start.signupUrl) || !DIGITS.test(start.appId) || !DIGITS.test(start.configId)) return null
  const url = new URL(start.signupUrl)
  url.searchParams.set('app', start.appId)
  url.searchParams.set('config', start.configId)
  url.searchParams.set('state', start.state)
  url.searchParams.set('return', start.returnOrigin)
  if (options.coexistence) url.searchParams.set('mode', 'coexistence')
  return url.toString()
}

/**
 * Lê a mensagem do popup. Só vale a que vem da origem da página de cadastro, da
 * janela que o painel abriu e com o `state` esperado; qualquer outra é ignorada
 * (`null`), inclusive uma de sucesso sem os ids.
 */
export function parseSignupMessage(
  event: { origin: string; source: unknown; data: unknown },
  popup: unknown,
  signupUrl: string,
  state: string
): SignupResult | null {
  const origin = httpsOrigin(signupUrl)
  if (!origin || event.origin !== origin || !popup || event.source !== popup) return null
  const data = event.data as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || data.type !== WA_EMBEDDED_SIGNUP_MESSAGE || data.state !== state) return null
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  if (text(data.code)) {
    const wabaId = text(data.wabaId)
    const phoneNumberId = text(data.phoneNumberId)
    if (!DIGITS.test(wabaId) || !DIGITS.test(phoneNumberId) || !text(data.event).startsWith('FINISH')) {
      return { error: 'error', event: text(data.event) || null, step: null }
    }
    return { event: text(data.event), code: text(data.code), wabaId, phoneNumberId, businessId: text(data.businessId) || null }
  }
  return { error: text(data.error) || 'cancelled', event: text(data.event) || null, step: text(data.step) || null }
}
