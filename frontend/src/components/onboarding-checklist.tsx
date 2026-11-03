'use client'

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { settingsAPI, type OnboardingItemKey, type OnboardingStatus } from '@/lib/api'

/** O ícone de cada item. Para onde ele leva vem do servidor (`href`). */
const ICONES: Record<OnboardingItemKey, string> = {
  genieacs: 'server',
  genieacsOnline: 'server',
  firstDevice: 'devices',
  provisioning: 'power',
  sgp: 'invoice',
  asaas: 'invoice',
  whatsapp: 'chat',
  whatsappConnected: 'chat',
  alerts: 'bell',
  billingContact: 'contacts',
  team: 'contacts'
}

/**
 * "Primeiros passos" no topo do Dashboard de um provedor novo.
 *
 * O assistente de boas-vindas cobre só o que o painel não funciona sem — o
 * GenieACS. O resto (SGP, WhatsApp, ativação automática, a equipe, ver o
 * primeiro equipamento chegar) ficava sem guia. Cada item aqui é conferido no
 * servidor pelo que o provedor TEM, então se marca sozinho quando é feito em
 * qualquer tela, e o card some quando tudo está pronto ou alguém o oculta.
 * O percentual vem do servidor, só dos itens que se aplicam, e o "próximo
 * passo" (o primeiro pendente) fica destacado.
 *
 * Mesmas condições do assistente: edição hospedada, um provedor de verdade e
 * quem pode mexer nas configurações.
 */
export function OnboardingChecklist() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const { tenant, isSaas } = useTenant()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [hidden, setHidden] = useState(false)

  const eligible = isSaas && tenant?.kind !== 'platform' && can('settings.write')

  useEffect(() => {
    if (!eligible) return
    let cancelled = false
    settingsAPI.onboardingStatus()
      .then((res) => { if (!cancelled && res.success && res.data) setStatus(res.data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [eligible])

  if (!eligible || !status || hidden || status.checklistDismissed) return null
  // Só o que se aplica a este provedor: o agente do GenieACS, numa conexão
  // direta, não é passo nenhum — e fica fora do percentual, que vem pronto.
  const itens = status.items.filter((item) => item.applicable !== false)
  const feitos = itens.filter((item) => item.done).length
  const total = itens.length
  const percent = typeof status.percent === 'number' ? status.percent : (total ? Math.round((feitos / total) * 100) : 100)
  if (total === 0 || percent >= 100) return null
  const proximo = status.nextStep ?? itens.find((item) => !item.done)?.key ?? null

  const ocultar = () => {
    setHidden(true)
    void settingsAPI.dismissOnboarding('checklist').catch(() => {})
  }

  return (
    <section className="modern-card mb-5 p-5 sm:p-6" aria-labelledby="onboarding-checklist-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="onboarding-checklist-title" className="section-heading">{t('onboarding.checklist.title')}</h2>
          <p className="field-hint mt-1">{t('onboarding.checklist.description')}</p>
        </div>
        <button type="button" className="modern-button-secondary" onClick={ocultar}>
          <Icon name="x" size={16} />
          {t('onboarding.checklist.hide')}
        </button>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('onboarding.checklist.progress', { done: feitos, total })}</span>
          <span className="font-semibold text-foreground" data-testid="onboarding-percent">{t('onboarding.checklist.percent', { percent })}</span>
        </div>
        <div
          className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('onboarding.checklist.progress', { done: feitos, total })}
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <ul className="mt-4 divide-y divide-border">
        {itens.map(({ key, done, href }) => {
          const next = key === proximo
          return (
            <li
              key={key}
              data-next={next || undefined}
              className={`flex flex-wrap items-center justify-between gap-3 py-3 ${next ? '-mx-3 rounded-md border border-primary/40 bg-primary/5 px-3' : ''}`}
            >
              <div className="flex min-w-0 items-start gap-3">
                <Icon
                  name={done ? 'check' : (ICONES[key] ?? 'info')}
                  size={18}
                  className={`mt-0.5 shrink-0 ${done ? 'text-[hsl(var(--status-success))]' : next ? 'text-primary' : 'text-muted-foreground'}`}
                />
                <div className="min-w-0">
                  {next && <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">{t('onboarding.checklist.nextStep')}</p>}
                  <p className={`text-sm font-medium ${done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                    {t(`onboarding.checklist.${key}.title` as TranslationKey)}
                  </p>
                  {!done && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t(`onboarding.checklist.${key}.hint` as TranslationKey)}
                    </p>
                  )}
                </div>
              </div>
              {done ? (
                <span className="modern-badge-success">{t('onboarding.checklist.done')}</span>
              ) : href ? (
                <Link to={href} className={`${next ? 'modern-button' : 'modern-button-secondary'} min-h-10 px-3 py-1 text-xs lg:min-h-9`}>
                  {t(key === 'firstDevice' ? 'onboarding.checklist.view' : 'onboarding.checklist.configure')}
                </Link>
              ) : (
                <span className="modern-badge-warning">{t('onboarding.checklist.pending')}</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default OnboardingChecklist
