'use client'

import { useState } from 'react'
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

const GROUPS = [
  { label: 'platform.nav.company', items: [['profile', 'platform.settings.profile']] },
  { label: 'platform.nav.communication', items: [['alerts', 'platform.settings.alerts'], ['mail', 'platform.settings.mail']] },
  { label: 'platform.nav.billing', items: [['reminders', 'platform.settings.reminders'], ['integrations', 'platform.tabs.integrations'], ['accounting', 'platform.settings.accounting']] }
] as const satisfies ReadonlyArray<{ label: string, items: ReadonlyArray<readonly [Sub, string]> }>

/**
 * Configurações do console, com submenu: os dados da empresa que vende o SaaS
 * e as integrações com sistemas de fora (a conta Asaas). E os alertas para
 * quem opera a plataforma (0112), e o e-mail de teste do SMTP do deploy. E a
 * régua de cobrança (0121).
 */
export function PlatformSettings({ initialSub = 'profile', initialAlertsTab = 'settings' }: {
  /** O submenu aberto ao montar (o painel Início abre direto nos alertas). */
  initialSub?: 'profile' | 'alerts' | 'mail' | 'integrations' | 'reminders' | 'accounting'
  initialAlertsTab?: 'settings' | 'history'
} = {}) {
  const { t } = useTranslation()
  const [sub, setSub] = useState<'profile' | 'alerts' | 'mail' | 'integrations' | 'reminders' | 'accounting'>(initialSub)

  return (
    <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
      <PlatformSidebar ariaLabel={t('platform.tabs.settings')} active={sub} onSelect={setSub} groups={GROUPS} />
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
