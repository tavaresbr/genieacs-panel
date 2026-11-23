'use client'

import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { PlatformIntegrations } from '@/components/platform/platform-integrations'
import { PlatformProfileForm } from '@/components/platform/platform-profile'
import { PlatformAlertsSettings } from '@/components/platform/platform-alerts'
import { PlatformAlertsPanel } from '@/components/platform/platform-alert-history'
import { PlatformMailSettings } from '@/components/platform/platform-mail'
import { PlatformReminderPolicy } from '@/components/platform/platform-reminders'
import { PlatformAccountingSettings } from '@/components/platform/platform-accounting'
import { PlatformSidebar } from '@/components/platform/platform-nav'
import { useTranslation } from '@/contexts/language-context'

type Sub = 'profile' | 'alerts' | 'mail' | 'integrations' | 'reminders' | 'accounting'

const SUBS: readonly Sub[] = ['profile', 'alerts', 'mail', 'integrations', 'reminders', 'accounting']

const GROUPS = [
  { label: 'platform.nav.company', items: [['profile', 'platform.settings.profile', 'building']] },
  { label: 'platform.nav.communication', items: [['alerts', 'platform.settings.alerts', 'bell'], ['mail', 'platform.settings.mail', 'chat']] },
  { label: 'platform.nav.billing', items: [['reminders', 'platform.settings.reminders', 'invoice'], ['integrations', 'platform.tabs.integrations', 'globe'], ['accounting', 'platform.settings.accounting', 'document']] }
] as const satisfies ReadonlyArray<{ label: string, items: ReadonlyArray<readonly [Sub, string, string?]> }>

/**
 * Configurações do console, com submenu: os dados da empresa que vende o SaaS
 * e as integrações com sistemas de fora (a conta Asaas). E os alertas para
 * quem opera a plataforma (0112), e o e-mail de teste do SMTP do deploy. E a
 * régua de cobrança (0121).
 */
export function PlatformSettings({ initialSub, initialAlertsTab = 'settings' }: {
  /** O submenu aberto ao montar (o painel Início abre direto nos alertas). */
  initialSub?: Sub
  initialAlertsTab?: 'settings' | 'history'
} = {}) {
  const { t } = useTranslation()
  // A seção mora na URL (`?sub=`), como a aba: recarregar mantém onde se estava.
  const [searchParams, setSearchParams] = useSearchParams()
  const doUrl = searchParams.get('sub') as Sub | null
  const [sub, setSub] = useState<Sub>(initialSub ?? (doUrl && SUBS.includes(doUrl) ? doUrl : 'profile'))
  const escolher = (proxima: Sub) => {
    setSub(proxima)
    setSearchParams((atual) => {
      const params = new URLSearchParams(atual)
      if (proxima === 'profile') params.delete('sub')
      else params.set('sub', proxima)
      return params
    }, { replace: true })
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
      <PlatformSidebar ariaLabel={t('platform.tabs.settings')} active={sub} onSelect={escolher} groups={GROUPS} />
      <div className="min-w-0">
        {sub === 'profile' && <PlatformProfileForm />}
        {sub === 'alerts' && <PlatformAlertsPanel settings={<PlatformAlertsSettings />} initialTab={initialAlertsTab} />}
        {sub === 'mail' && <PlatformMailSettings />}
        {sub === 'integrations' && <PlatformIntegrations />}
        {sub === 'reminders' && <PlatformReminderPolicy />}
        {sub === 'accounting' && <PlatformAccountingSettings />}
      </div>
    </div>
  )
}

export default PlatformSettings
