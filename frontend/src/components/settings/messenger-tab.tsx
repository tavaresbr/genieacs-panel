'use client'

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { messengerAPI, type MessengerStatus } from '@/lib/api'
import { MessengerNoticeSettings } from '@/components/messenger/notice-settings'
import { MessengerPagesPanel } from '@/components/messenger/pages-panel'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'

/**
 * Configuração → Integrações → Messenger: conectar as Páginas do Facebook (pelo
 * login do Facebook ou colando o ID e o token) e o texto da confirmação do
 * vínculo. A caixa de conversas continua em Atendimento → Messenger.
 */
export function MessengerTab() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<MessengerStatus | null>(null)

  const loadStatus = useCallback(async () => {
    const res = await messengerAPI.status()
    if (res.success && res.data) setStatus(res.data)
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  return (
    <div className="space-y-4">
      <div>
        <p className="page-kicker">{t('settings.messenger.kicker')}</p>
        <h2 className="section-heading">{t('settings.messenger.title')}</h2>
        <p className="section-description">{t('settings.messenger.description')}</p>
        <Link to="/messenger" className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
          {t('settings.messenger.openInbox')}
          <Icon name="chevron-right" size={16} />
        </Link>
      </div>
      {status && !status.configured && (
        <div className="modern-card flex items-start gap-2 p-3 text-sm" role="alert">
          <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
          <span>{t('messenger.notConfigured')}</span>
        </div>
      )}
      <MessengerPagesPanel
        webhookPath={status?.webhookPath ?? null}
        facebookAppId={status?.facebookLogin?.available ? status.facebookLogin.appId : null}
        onChanged={() => void loadStatus()}
      />
      <MessengerNoticeSettings />
    </div>
  )
}
