'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { whatsappAPI } from '@/lib/api'
import {
  focusedConversation,
  latestPerConversation,
  playChime,
  readNotifyPref,
  shouldNotify,
  writeNotifyPref
} from '@/lib/wa-notify'

/** Meio minuto. Em segundo plano o navegador pode espaçar para um. */
const POLL_MS = 30_000

/** Avisado pelo sino quando a pessoa liga ou desliga, para o vigia não esperar o próximo ciclo. */
const PREF_EVENT = 'wa-notify-change'

const suportado = () => typeof window !== 'undefined' && 'Notification' in window

const ligado = () => suportado() && readNotifyPref() && Notification.permission === 'granted'

/**
 * O vigia das mensagens novas: toca e mostra a notificação do sistema quando
 * um cliente escreve numa conversa sua — ou numa sem atendente que espera
 * gente —, mesmo com o painel em outra aba. Fica na casca para valer em
 * qualquer tela; não desenha nada.
 *
 * A primeira leitura só pega o cursor do servidor: abrir o painel não
 * despeja o atrasado em notificações.
 */
export function WhatsAppMessageNotifier() {
  const { can } = useAuth()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const allowed = can('whatsapp.read')
  const cursor = useRef<string | null>(null)
  const inFlight = useRef(false)
  const tRef = useRef(t)
  const navigateRef = useRef(navigate)
  useEffect(() => { tRef.current = t }, [t])
  useEffect(() => { navigateRef.current = navigate }, [navigate])

  const tick = useCallback(async () => {
    if (!ligado()) {
      // Desligado, esquece o cursor: religar começa do agora, não do passado.
      cursor.current = null
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await whatsappAPI.getNotifications(cursor.current)
      if (!res.success || !res.data) return
      const primeira = cursor.current === null
      cursor.current = res.data.cursor
      if (primeira || !ligado()) return
      const visible = document.visibilityState === 'visible'
      const avisar = latestPerConversation(res.data.items)
        .filter((item) => shouldNotify(item, { focusedConversationId: focusedConversation.id, visible }))
      if (!avisar.length) return
      playChime()
      for (const item of avisar) {
        const tr = tRef.current
        const n = new Notification(item.contact || tr('whatsapp.notify.unknownContact'), {
          body: item.preview || (item.hasAttachment ? tr('whatsapp.notify.attachment') : ''),
          tag: `wa-conv-${item.conversationId}`
        })
        n.onclick = () => {
          window.focus()
          navigateRef.current(`/whatsapp?conversation=${item.conversationId}`)
          n.close()
        }
      }
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    if (!allowed || !suportado()) return
    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)
    const mudou = () => void tick()
    window.addEventListener(PREF_EVENT, mudou)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(PREF_EVENT, mudou)
    }
  }, [allowed, tick])

  return null
}

type Estado = 'on' | 'off' | 'blocked'

function estadoAtual(): Estado {
  if (Notification.permission === 'denied') return 'blocked'
  return ligado() ? 'on' : 'off'
}

/**
 * O sino ao lado de "Disponível": liga e desliga as notificações neste
 * navegador. Ligar pede a permissão do sistema na primeira vez; bloqueada,
 * o botão diz como liberar. Sem suporte no navegador, não aparece.
 */
export function NotifyToggle() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const [estado, setEstado] = useState<Estado>(() => (suportado() ? estadoAtual() : 'off'))

  if (!suportado() || !can('whatsapp.read')) return null

  const alternar = async () => {
    if (estado === 'on') {
      writeNotifyPref(false)
    } else {
      let permissao = Notification.permission
      if (permissao === 'default') permissao = await Notification.requestPermission()
      writeNotifyPref(permissao === 'granted')
      // Um toque agora: confirma o som e destrava o áudio do navegador.
      if (permissao === 'granted') playChime()
    }
    setEstado(estadoAtual())
    window.dispatchEvent(new Event(PREF_EVENT))
  }

  const dica = estado === 'on'
    ? t('whatsapp.notify.onHint')
    : estado === 'blocked' ? t('whatsapp.notify.blockedHint') : t('whatsapp.notify.offHint')

  return (
    <button
      type="button"
      role="switch"
      aria-checked={estado === 'on'}
      aria-label={t('whatsapp.notify.button')}
      title={dica}
      onClick={() => void alternar()}
      className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors ${
        estado === 'on'
          ? 'border-[hsl(var(--status-success)/0.4)] bg-[hsl(var(--status-success)/0.12)] text-[hsl(var(--status-success))]'
          : estado === 'blocked'
            ? 'border-[hsl(var(--status-warning)/0.4)] text-[hsl(var(--status-warning))]'
            : 'border-border text-muted-foreground hover:bg-[hsl(var(--surface-subtle))]'
      }`}
    >
      <Icon name="bell" size={14} />
      <span className="hidden sm:inline">
        {estado === 'on' ? t('whatsapp.notify.on') : estado === 'blocked' ? t('whatsapp.notify.blocked') : t('whatsapp.notify.off')}
      </span>
    </button>
  )
}
