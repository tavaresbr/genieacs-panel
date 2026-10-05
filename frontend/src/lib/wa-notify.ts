/** Um item de `GET /whatsapp/notifications`. */
export interface NotificationItem {
  messageId: number
  conversationId: number
  contact: string | null
  preview: string | null
  hasAttachment: boolean
  createdAt: string
  mine: boolean
}

/**
 * Qual conversa está aberta na caixa de entrada agora. Escrito pela página do
 * WhatsApp, lido pelo sino: quem está olhando a conversa não precisa de aviso.
 */
export const focusedConversation: { id: number | null } = { id: null }

/** Avisa? Não da conversa que está aberta com a aba à vista. */
export function shouldNotify(item: Pick<NotificationItem, 'conversationId'>, ctx: { focusedConversationId: number | null; visible: boolean }): boolean {
  return !(ctx.visible && ctx.focusedConversationId === item.conversationId)
}

/** Uma notificação por conversa no lote: a última mensagem de cada uma. */
export function latestPerConversation(items: readonly NotificationItem[]): NotificationItem[] {
  const porConversa = new Map<number, NotificationItem>()
  for (const item of items) {
    const atual = porConversa.get(item.conversationId)
    if (!atual || item.messageId > atual.messageId) porConversa.set(item.conversationId, item)
  }
  return [...porConversa.values()]
}

export const NOTIFY_PREF_KEY = 'wa-notify-enabled'

export function readNotifyPref(): boolean {
  try {
    return window.localStorage.getItem(NOTIFY_PREF_KEY) === '1'
  } catch {
    return false
  }
}

export function writeNotifyPref(on: boolean): void {
  try {
    window.localStorage.setItem(NOTIFY_PREF_KEY, on ? '1' : '0')
  } catch {
    // Sem armazenamento, a preferência dura só esta aba.
  }
}

/** Dois bipes curtos, sem arquivo de som. Silencioso se o navegador não deixar. */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const bipe = (inicio: number, freq: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + inicio)
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + inicio + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + inicio)
      osc.stop(ctx.currentTime + inicio + 0.2)
    }
    bipe(0, 880)
    bipe(0.22, 1175)
    window.setTimeout(() => { void ctx.close() }, 800)
  } catch {
    // O som é extra; a notificação continua.
  }
}
