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

// ── Tela: estados do cadastro, prazo da coexistência ─────────────────────────

/** Onde o cadastro guiado está, na ordem em que acontece. */
export type SignupPhase = 'idle' | 'waiting' | 'connecting' | 'done' | 'error'

/**
 * O `state` vale 10 min no servidor. A tela o pede ANTES do clique (o popup tem
 * de abrir dentro do gesto do usuário, e uma chamada de rede no meio o perderia
 * — o navegador bloquearia a janela), então renova um pouco antes de vencer.
 */
export const SIGNUP_STATE_REFRESH_MS = 8 * 60 * 1000
/** O popup fechado sem mensagem só vale como "cancelou" depois desta folga: a mensagem pode estar a caminho. */
export const SIGNUP_CLOSE_GRACE_MS = 1500
/** As dimensões do popup do cadastro. Sem `noopener`: o resultado volta por `window.opener`. */
export const SIGNUP_POPUP_FEATURES = 'popup=yes,width=720,height=820,menubar=no,toolbar=no,location=yes'

/** A chave de tradução do que o popup disse quando NÃO concluiu. */
export function signupFailureKey(failure: SignupFailure): 'whatsapp.cloud.signup.cancelled' | 'whatsapp.cloud.signup.failed' {
  return failure.error === 'cancelled' ? 'whatsapp.cloud.signup.cancelled' : 'whatsapp.cloud.signup.failed'
}

/** O que a tela precisa saber da conta para falar da sincronização da coexistência. */
export type CoexistenceAccount = {
  metaCoexistence?: boolean
  metaSyncState?: 'pending' | 'ok' | 'error' | null
  metaSyncError?: string | null
  metaCoexistenceDeadlineAt?: string | null
}

export type CoexistenceStatus =
  | { state: 'ok' }
  | { state: 'expired' }
  | { state: 'pending' | 'error'; hoursLeft: number; reason: string | null }

/**
 * Como está a sincronização de um número em coexistência. `null` para o número
 * que não é de coexistência (nada a mostrar). Pronta é pronta, mesmo depois do
 * prazo; sem ela, passado o prazo, a Meta já desconectou o número.
 */
export function coexistenceStatus(account: CoexistenceAccount, now: number): CoexistenceStatus | null {
  if (!account.metaCoexistence) return null
  if (account.metaSyncState === 'ok') return { state: 'ok' }
  const deadline = account.metaCoexistenceDeadlineAt ? new Date(account.metaCoexistenceDeadlineAt).getTime() : NaN
  if (Number.isFinite(deadline) && deadline <= now) return { state: 'expired' }
  const hoursLeft = Number.isFinite(deadline) ? Math.max(1, Math.ceil((deadline - now) / 3_600_000)) : 24
  return {
    state: account.metaSyncState === 'error' ? 'error' : 'pending',
    hoursLeft,
    reason: account.metaSyncError || null
  }
}

/** "Tentar de novo" só existe enquanto há o que pedir e prazo para pedir. */
export function canRetryCoexistenceSync(status: CoexistenceStatus | null): boolean {
  return status?.state === 'pending' || status?.state === 'error'
}
