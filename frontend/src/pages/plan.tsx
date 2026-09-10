'use client'

import { useCallback, useEffect, useState } from 'react'
import { subscriptionAPI, type SubscriptionUsage } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

/**
 * The provider's own "plan and usage": which plan, in what state, how much of
 * it is used. Read-only on purpose — changing any of it is the platform's job,
 * and the screen says whom to talk to instead of offering a button that would
 * answer 404.
 */
const STATUS_KEYS: Record<string, TranslationKey> = {
  trial: 'platform.subscription.trial',
  active: 'platform.subscription.active',
  past_due: 'platform.subscription.pastDue',
  suspended: 'platform.subscription.suspended',
  canceled: 'platform.subscription.canceled'
}

function badgeClass(status: string | undefined) {
  if (status === 'active' || status === 'trial') return 'modern-badge-success'
  if (status === 'past_due') return 'modern-badge-warning'
  return 'modern-badge-danger'
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString()
}

export default function PlanPage() {
  const { t } = useTranslation()
  const [data, setData] = useState<SubscriptionUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await subscriptionAPI.current()
    if (res.success && res.data) {
      setData(res.data)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const subscription = data?.subscription ?? null

  const meter = (used: number | null, limit: number | null) => {
    if (used === null) return { text: t('platform.subscription.uncounted'), pct: 0 }
    if (limit === null) return { text: `${used} / ∞`, pct: 0 }
    return { text: `${used} / ${limit}`, pct: limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100)) }
  }

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <h1 className="page-title">{t('plan.title')}</h1>
            <p className="page-description">{t('plan.subtitle')}</p>
          </div>
          <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </header>

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : error !== null ? (
          <p className="text-sm text-destructive">{error || t('plan.loadFailed')}</p>
        ) : !subscription ? (
          <p className="text-sm text-muted-foreground">{t('subscription.missing')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <section className="modern-card p-5 sm:p-6">
              <h2 className="section-heading">{t('platform.subscription.plan')}</h2>
              <p className="mt-1 text-2xl font-semibold text-foreground">{subscription.plan?.name ?? '—'}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className={badgeClass(subscription.status)}>
                  {t(STATUS_KEYS[subscription.status] ?? 'platform.subscription.suspended')}
                </span>
                {subscription.reason === 'trial_expired' && (
                  <span className="text-muted-foreground">{t('platform.subscription.trialExpiredNote')}</span>
                )}
              </div>
              <dl className="mt-4 space-y-2 text-sm">
                {subscription.storedStatus === 'trial' && formatDate(subscription.trialEndsAt) && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('plan.trialEnds')}</dt>
                    <dd className="font-medium">{formatDate(subscription.trialEndsAt)}</dd>
                  </div>
                )}
                {formatDate(subscription.renewsAt) && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('plan.paidThrough')}</dt>
                    <dd className="font-medium">{formatDate(subscription.renewsAt)}</dd>
                  </div>
                )}
              </dl>
              <p className="field-hint mt-4">{t('plan.contactHint')}</p>
            </section>

            <section className="modern-card p-5 sm:p-6">
              <h2 className="section-heading">{t('platform.subscription.usage')}</h2>
              <ul className="mt-3 space-y-4">
                {([
                  ['operators', t('platform.subscription.operators')],
                  ['subscribers', t('platform.subscription.subscribers')],
                  ['devices', t('platform.subscription.devices')]
                ] as const).map(([key, label]) => {
                  const { text, pct } = meter(data!.usage[key], data!.limits[key])
                  const over = data!.over[key]
                  return (
                    <li key={key}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{label}</span>
                        <span className={over ? 'font-semibold text-destructive' : 'font-medium'}>{text}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <div
                          className={`h-full rounded-full ${over ? 'bg-destructive' : 'bg-primary'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
              {(data!.over.operators || data!.over.subscribers || data!.over.devices) && (
                <p className="mt-4 text-sm text-destructive">{t('plan.overHint')}</p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
