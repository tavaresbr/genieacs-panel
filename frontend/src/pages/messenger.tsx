'use client'

import { useCallback, useEffect, useState } from 'react'
import { messengerAPI, type MessengerStatus } from '@/lib/api'
import { MessengerInbox } from '@/components/messenger/inbox'
import { MessengerNoticeSettings } from '@/components/messenger/notice-settings'
import { MessengerPagesPanel } from '@/components/messenger/pages-panel'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/**
 * O Messenger do provedor: a caixa de entrada e, para quem pode configurar, as
 * Páginas do Facebook conectadas. Usa as mesmas capacidades do WhatsApp — ler a
 * caixa (`whatsapp.read`), responder (`whatsapp.send`) e conectar Páginas
 * (`whatsapp.config`) —, porque o atendimento é um só.
 */
export default function MessengerPage() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const canConfig = can('whatsapp.config')
  const [status, setStatus] = useState<MessengerStatus | null>(null)
  const [hasPages, setHasPages] = useState(true)

  const loadStatus = useCallback(async () => {
    const res = await messengerAPI.status()
    if (res.success && res.data) setStatus(res.data)
  }, [])

  const loadHasPages = useCallback(async () => {
    // Só quem configura pode listar as Páginas; para os demais a caixa vazia
    // mostra a mensagem neutra.
    if (!canConfig) return
    const res = await messengerAPI.listPages()
    if (res.success && res.data) setHasPages(res.data.length > 0)
  }, [canConfig])

  useEffect(() => {
    void loadStatus()
    void loadHasPages()
  }, [loadStatus, loadHasPages])

  return (
    <div className="space-y-4">
      <h1 className="sr-only">{t('sidebar.nav.messenger')}</h1>
      {status && !status.configured && (
        <div className="modern-card flex items-start gap-2 p-3 text-sm" role="alert">
          <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
          <span>{t('messenger.notConfigured')}</span>
        </div>
      )}
      <MessengerInbox canSend={can('whatsapp.send')} hasPages={hasPages} />
      {canConfig && (
        <MessengerPagesPanel
          webhookPath={status?.webhookPath ?? null}
          facebookAppId={status?.facebookLogin?.available ? status.facebookLogin.appId : null}
          onChanged={() => {
            void loadStatus()
            void loadHasPages()
          }}
        />
      )}
      {canConfig && <MessengerNoticeSettings />}
    </div>
  )
}
