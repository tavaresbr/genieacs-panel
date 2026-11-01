'use client'

import { useState } from 'react'
import { PlatformIntegrations } from '@/components/platform/platform-integrations'
import { PlatformProfileForm } from '@/components/platform/platform-profile'
import { PlatformAlertsSettings } from '@/components/platform/platform-alerts'
import { PlatformAlertsPanel } from '@/components/platform/platform-alert-history'
import { PlatformMailSettings } from '@/components/platform/platform-mail'
import { PlatformReminderPolicy } from '@/components/platform/platform-reminders'
import { useTranslation } from '@/contexts/language-context'

/**
 * Configurações do console, com submenu: os dados da empresa que vende o SaaS
 * e as integrações com sistemas de fora (a conta Asaas). E os alertas para
 * quem opera a plataforma (0112), e o e-mail de teste do SMTP do deploy. E a
 * régua de cobrança (0121).
 */
export function PlatformSettings({ initialSub = 'profile', initialAlertsTab = 'settings' }: {
  /** O submenu aberto ao montar (o painel Início abre direto nos alertas). */
  initialSub?: 'profile' | 'alerts' | 'mail' | 'integrations' | 'reminders'
  initialAlertsTab?: 'settings' | 'history'
} = {}) {
  const { t } = useTranslation()
  const [sub, setSub] = useState<'profile' | 'alerts' | 'mail' | 'integrations' | 'reminders'>(initialSub)

  return (
    <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
      <nav aria-label={t('platform.tabs.settings')} className="flex gap-2 overflow-x-auto lg:flex-col">
        {([
          ['profile', 'platform.settings.profile'],
          ['alerts', 'platform.settings.alerts'],
          ['mail', 'platform.settings.mail'],
          ['integrations', 'platform.tabs.integrations'],
          ['reminders', 'platform.settings.reminders']
        ] as const).map(([chave, rotulo]) => (
          <button
            key={chave}
            type="button"
            onClick={() => setSub(chave)}
            aria-current={sub === chave ? 'page' : undefined}
            className={`shrink-0 rounded-md px-3 py-2 text-left text-sm font-semibold transition ${sub === chave
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            {t(rotulo)}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        {sub === 'profile' && <PlatformProfileForm />}
        {sub === 'alerts' && <PlatformAlertsPanel settings={<PlatformAlertsSettings />} initialTab={initialAlertsTab} />}
        {sub === 'mail' && <PlatformMailSettings />}
        {sub === 'integrations' && <PlatformIntegrations />}
        {sub === 'reminders' && <PlatformReminderPolicy />}
      </div>
    </div>
  )
}

export default PlatformSettings
