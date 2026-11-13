import { pushAPI, type PushEvent, type PushSubscriptionPayload } from '@/lib/api'
import { isStandalone } from '@/lib/pwa'

/**
 * As notificações push neste aparelho (0130): o que o navegador consegue e a
 * inscrição com a chave VAPID do provedor.
 *
 * O servidor sabe quantos aparelhos a pessoa tem; se ESTE é um deles quem
 * sabe é o navegador (`pushManager.getSubscription`). O endpoint não vai na
 * URL de nenhuma leitura.
 */

/** A ordem em que os eventos aparecem na tela. */
export const PUSH_EVENT_ORDER: readonly PushEvent[] = ['new_message', 'mass_outage', 'ont_offline', 'wa_disconnected', 'invoice']

export type PushSupport = 'supported' | 'unsupported' | 'ios-install'

interface Ambiente {
  userAgent: string
  maxTouchPoints?: number
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  standalone: boolean
}

/** iPhone/iPad, inclusive o iPad que se diz Mac. */
export function isIos(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1
}

/**
 * O que este navegador consegue. No iOS o push só existe no app instalado na
 * tela de início (16.4+): no Safari aberto a API nem aparece, e a tela tem de
 * dizer "instale" em vez de "não suportado".
 */
export function pushSupport(env: Ambiente): PushSupport {
  if (isIos(env.userAgent, env.maxTouchPoints) && !env.standalone) return 'ios-install'
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return 'supported'
  return 'unsupported'
}

export function currentPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  return pushSupport({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    standalone: isStandalone(),
  })
}

/** A chave VAPID (base64url) no formato que `pushManager.subscribe` aceita. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

/** Se a inscrição existente foi feita com esta chave (outro provedor, outra chave). */
export function sameKey(current: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!current) return false
  const a = new Uint8Array(current)
  if (a.length !== expected.length) return false
  return a.every((byte, i) => byte === expected[i])
}

/** O que vai ao servidor, conferido: sem chaves não há como cifrar o aviso. */
export function subscriptionPayload(json: PushSubscriptionJSON): PushSubscriptionPayload | null {
  const endpoint = json.endpoint
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!endpoint || !p256dh || !auth) return null
  return { endpoint, keys: { p256dh, auth } }
}

/** O registro do SW, sem esperar para sempre: no `vite dev` não há SW. */
async function registro(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  const pronto = navigator.serviceWorker.ready
  const prazo = new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), 4000) })
  return Promise.race([pronto, prazo])
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    return (await reg?.pushManager.getSubscription()) ?? null
  } catch {
    return null
  }
}

/**
 * De quem é a inscrição deste navegador (`sessionOwner`). O push mora no
 * service worker da origem, não na sessão: sem essa marca, quem entrasse
 * depois no mesmo navegador seguia recebendo os avisos de quem saiu — e o
 * cartão dizia "Ativo" para uma inscrição que é de outra pessoa.
 */
export const PUSH_OWNER_KEY = 'push.owner'

function lerDono(): string | null {
  try {
    return localStorage.getItem(PUSH_OWNER_KEY)
  } catch {
    return null
  }
}

function gravarDono(owner: string | null) {
  try {
    if (owner) localStorage.setItem(PUSH_OWNER_KEY, owner)
    else localStorage.removeItem(PUSH_OWNER_KEY)
  } catch {
    // Sem storage não há marca; o logout ainda desfaz a inscrição.
  }
}

export type PushOwnerAction = 'keep' | 'adopt' | 'drop'

/**
 * O que fazer com a inscrição deste navegador quando uma sessão começa.
 * Sem marca (inscrição de antes da marca existir) ela é adotada, para não
 * desligar o push de todo mundo na atualização.
 */
export function pushOwnerAction(stored: string | null, owner: string, hasSubscription: boolean): PushOwnerAction {
  if (!hasSubscription) return 'keep'
  if (stored === null) return 'adopt'
  return stored === owner ? 'keep' : 'drop'
}

/**
 * A sessão de `owner` começou neste navegador: uma inscrição de outra pessoa
 * é desfeita no navegador (o aviso dela deixa de ter para onde ir).
 */
export async function reconcilePushOwner(owner: string): Promise<void> {
  const sub = await currentSubscription()
  const acao = pushOwnerAction(lerDono(), owner, Boolean(sub))
  if (acao === 'adopt') gravarDono(owner)
  if (acao === 'drop') {
    await sub?.unsubscribe().catch(() => false)
    gravarDono(null)
  }
}

/**
 * Quem sai leva o push deste aparelho junto: do servidor (com o token da
 * sessão que sai, antes de ela ser revogada) e do navegador. Melhor esforço.
 */
export async function dropPushOnLogout(token: string | null): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  if (token) await pushAPI.unsubscribeAs(token, sub.endpoint).catch(() => null)
  await sub.unsubscribe().catch(() => false)
  gravarDono(null)
}

export type EnableResult = 'enabled' | 'denied' | 'no-worker' | 'failed'

/**
 * Pede a permissão, inscreve com a chave do provedor e manda ao servidor.
 * Uma inscrição antiga com OUTRA chave (o mesmo navegador noutro provedor) é
 * desfeita antes: o navegador recusa assinar duas vezes com chaves diferentes.
 */
export async function enablePush(owner: string | null): Promise<{ result: EnableResult; message?: string }> {
  const permissao = await Notification.requestPermission()
  if (permissao !== 'granted') return { result: 'denied' }
  const reg = await registro()
  if (!reg) return { result: 'no-worker' }
  const chave = await pushAPI.vapidPublicKey()
  if (!chave.success || !chave.data?.publicKey) return { result: 'failed', message: chave.message }
  const applicationServerKey = urlBase64ToUint8Array(chave.data.publicKey)
  try {
    let sub = await reg.pushManager.getSubscription()
    if (sub && !sameKey(sub.options.applicationServerKey, applicationServerKey)) {
      await sub.unsubscribe().catch(() => false)
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
    const payload = subscriptionPayload(sub.toJSON())
    if (!payload) return { result: 'failed' }
    const res = await pushAPI.subscribe(payload)
    if (res.success) gravarDono(owner)
    return res.success ? { result: 'enabled' } : { result: 'failed', message: res.message }
  } catch {
    return { result: 'failed' }
  }
}

/** Tira este aparelho: do servidor e do navegador. */
export async function disablePush(): Promise<boolean> {
  const sub = await currentSubscription()
  if (!sub) return true
  const res = await pushAPI.unsubscribe(sub.endpoint)
  await sub.unsubscribe().catch(() => false)
  gravarDono(null)
  return res.success
}
