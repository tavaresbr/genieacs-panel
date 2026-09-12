'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  platformAPI,
  type BillingEventView,
  type Plan,
  type SubscriptionStatus,
  type SubscriptionUsage,
  type SubscriptionView,
  type Tenant
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { parseAmountToCents } from '@/lib/utils'
import { useTranslation } from '@/contexts/language-context'

interface Props {
  tenant: Tenant
  plans: Plan[]
  /** The list row shows the plan and the state; both change here. */
  onSubscriptionChange: () => void
}

export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['trial', 'active', 'past_due', 'suspended', 'canceled']

/** The i18n key for each state — shared with the block screen and the list. */
export const STATUS_LABEL_KEYS = {
  trial: 'platform.subscription.trial',
  active: 'platform.subscription.active',
  past_due: 'platform.subscription.pastDue',
  suspended: 'platform.subscription.suspended',
  canceled: 'platform.subscription.canceled'
} as const

export function statusBadgeClass(status: SubscriptionStatus | null | undefined) {
  if (status === 'active' || status === 'trial') return 'modern-badge-success'
  if (status === 'past_due') return 'modern-badge-warning'
  return 'modern-badge-danger'
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

function formatMoney(cents: number | null | undefined, currency: string | null | undefined) {
  if (cents === null || cents === undefined) return '—'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'BRL' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? ''}`
  }
}

/**
 * The commercial half of one provider's row: which plan, which state, the
 * payment we record by hand, and usage against the limits.
 *
 * Plan and state are two separate saves on purpose. Changing the plan of a
 * provider in `past_due` must not quietly reactivate it, and reactivating must
 * not quietly change what it pays for — each is its own line on the statement
 * and its own line in both audit trails, and the two buttons say so.
 */
export function TenantPlan({ tenant, plans, onSubscriptionChange }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const [subscription, setSubscription] = useState<SubscriptionView | null>(null)
  const [planId, setPlanId] = useState<number | null>(null)
  const [events, setEvents] = useState<BillingEventView[]>([])
  const [usage, setUsage] = useState<SubscriptionUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'plan' | 'status' | 'payment' | null>(null)

  const [chosenPlan, setChosenPlan] = useState<number | ''>('')
  const [chosenStatus, setChosenStatus] = useState<SubscriptionStatus>('active')
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')

  const tenantId = tenant.id

  const load = useCallback(async () => {
    setLoading(true)
    const [sub, use] = await Promise.all([
      platformAPI.getSubscription(tenantId),
      platformAPI.getUsage(tenantId)
    ])
    if (sub.success && sub.data) {
      setSubscription(sub.data.subscription)
      setPlanId(sub.data.planId)
      setEvents(sub.data.events)
      setChosenPlan(sub.data.planId ?? '')
      setChosenStatus(sub.data.subscription?.storedStatus ?? 'active')
      setError(null)
    } else {
      setError(sub.message || '')
    }
    setUsage(use.success && use.data ? use.data : null)
    setLoading(false)
  }, [tenantId])

  useEffect(() => {
    void load()
  }, [load])

  const savePlan = async () => {
    if (chosenPlan === '' || chosenPlan === planId) return
    setSaving('plan')
    try {
      const res = await platformAPI.updateSubscription(tenantId, { planId: Number(chosenPlan) })
      if (res.success) {
        await load()
        onSubscriptionChange()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(null)
    }
  }

  const saveStatus = async () => {
    if (chosenStatus === subscription?.storedStatus) return
    // Suspending and canceling are the two that lock people out; both are asked
    // about, with the same words the provider switch uses for the same reason.
    if ((chosenStatus === 'suspended' || chosenStatus === 'canceled')
      && !window.confirm(t('platform.subscription.lockConfirm'))) return
    setSaving('status')
    try {
      const res = await platformAPI.updateSubscription(tenantId, {
        status: chosenStatus,
        reason: reason.trim() || undefined
      })
      if (res.success) {
        setReason('')
        await load()
        onSubscriptionChange()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(null)
    }
  }

  const savePayment = async () => {
    // Digitado em reais com vírgula ou ponto; guardado em centavos, inteiro.
    // `parseAmountToCents` recusa o ambíguo em vez de adivinhar — ver o porquê
    // lá, que envolve "1.234" ter virado 123 centavos em silêncio.
    const parsed = parseAmountToCents(amount)
    if (parsed === null) {
      toast.error(t('platform.subscription.amountInvalid'))
      return
    }
    setSaving('payment')
    try {
      const res = await platformAPI.recordPayment(tenantId, {
        amountCents: parsed,
        currency: plans.find((p) => p.id === planId)?.currency || 'BRL',
        reference: reference.trim() || undefined
      })
      if (res.success) {
        setAmount('')
        setReference('')
        await load()
        onSubscriptionChange()
        // O backend recusa a referência repetida corretamente — 200, nada
        // creditado, `duplicate: true` — e a tela não dizia nada. Sem aviso
        // nenhum, reenviar uma referência produzia exatamente a mesma cena de
        // um pagamento aceito: campos limpos, extrato recarregado. Quem
        // administra concluía que estendeu o período pago e não estendeu.
        //
        // Os dois casos passam a ter cada um a sua frase. É dinheiro: a
        // diferença entre "creditei" e "isto já estava creditado" não pode
        // depender de o operador reparar que o extrato não cresceu.
        if (res.data?.duplicate) toast.info(t('platform.subscription.paymentDuplicate'))
        else toast.success(t('platform.subscription.paymentRecorded'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(null)
    }
  }

  const limitText = (used: number | null, limit: number | null) => {
    if (used === null) return t('platform.subscription.uncounted')
    return limit === null ? `${used} / ∞` : `${used} / ${limit}`
  }

  if (loading) return <p className="py-3 text-sm text-muted-foreground">{t('common.loading')}</p>
  if (error !== null) return <p className="py-3 text-sm text-destructive">{error || t('platform.loadFailed')}</p>

  return (
    <div className="space-y-4 py-3">
      <h3 className="font-semibold text-foreground">{t('platform.subscription.title')}</h3>

      {subscription && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className={statusBadgeClass(subscription.status)}>
            {t(STATUS_LABEL_KEYS[subscription.status])}
          </span>
          {subscription.reason === 'trial_expired' && (
            <span className="text-muted-foreground">{t('platform.subscription.trialExpiredNote')}</span>
          )}
          {subscription.trialEndsAt && subscription.storedStatus === 'trial' && (
            <span className="text-muted-foreground">
              {t('platform.subscription.trialEnds', { date: formatDate(subscription.trialEndsAt) })}
            </span>
          )}
          {subscription.renewsAt && (
            <span className="text-muted-foreground">
              {t('platform.subscription.renews', { date: formatDate(subscription.renewsAt) })}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Plano */}
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.subscription.plan')}</h4>
          <select
            value={chosenPlan}
            onChange={(e) => setChosenPlan(e.target.value === '' ? '' : Number(e.target.value))}
            className="modern-input w-full"
            aria-label={t('platform.subscription.plan')}
          >
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id} disabled={!plan.active && plan.id !== planId}>
                {plan.name} ({plan.code}){plan.active ? '' : ` — ${t('platform.plans.inactive')}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void savePlan()}
            disabled={saving !== null || chosenPlan === '' || chosenPlan === planId}
            className="modern-button mt-2"
          >
            {saving === 'plan' ? t('common.saving') : t('platform.subscription.changePlan')}
          </button>
        </div>

        {/* Estado */}
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('common.status')}</h4>
          <select
            value={chosenStatus}
            onChange={(e) => setChosenStatus(e.target.value as SubscriptionStatus)}
            className="modern-input w-full"
            aria-label={t('common.status')}
          >
            {SUBSCRIPTION_STATUSES.map((status) => (
              <option key={status} value={status}>{t(STATUS_LABEL_KEYS[status])}</option>
            ))}
          </select>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="modern-input mt-2 w-full"
            placeholder={t('platform.subscription.reason')}
            aria-label={t('platform.subscription.reason')}
            maxLength={255}
          />
          <button
            type="button"
            onClick={() => void saveStatus()}
            disabled={saving !== null || chosenStatus === subscription?.storedStatus}
            className="modern-button mt-2"
          >
            {saving === 'status' ? t('common.saving') : t('platform.subscription.changeStatus')}
          </button>
          <p className="field-hint">{t('platform.subscription.statusHint')}</p>
        </div>

        {/* Pagamento */}
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.subscription.payment')}</h4>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="modern-input w-full"
            placeholder={t('platform.subscription.amount')}
            aria-label={t('platform.subscription.amount')}
            inputMode="decimal"
          />
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="modern-input mt-2 w-full"
            placeholder={t('platform.subscription.reference')}
            aria-label={t('platform.subscription.reference')}
            maxLength={128}
          />
          <button
            type="button"
            onClick={() => void savePayment()}
            disabled={saving !== null || amount.trim() === ''}
            className="modern-button mt-2"
          >
            {saving === 'payment' ? t('common.saving') : t('platform.subscription.recordPayment')}
          </button>
          <p className="field-hint">{t('platform.subscription.paymentHint')}</p>
        </div>
      </div>

      {/* Uso */}
      {usage && (
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.subscription.usage')}</h4>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
            {([
              ['operators', t('platform.subscription.operators')],
              ['subscribers', t('platform.subscription.subscribers')],
              ['devices', t('platform.subscription.devices')]
            ] as const).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className={usage.over[key] ? 'font-semibold text-destructive' : 'font-medium'}>
                  {limitText(usage.usage[key], usage.limits[key])}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Extrato */}
      {events.length > 0 && (
        <div className="rounded-md border border-border bg-card">
          <h4 className="px-3 pt-3 text-sm font-semibold text-foreground">{t('platform.subscription.statement')}</h4>
          <ul className="divide-y divide-border">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <span className="modern-badge mr-2">{event.type}</span>
                  {event.amountCents !== null && <span>{formatMoney(event.amountCents, event.currency)}</span>}
                  {event.externalId && <span className="ml-2 font-mono text-xs text-muted-foreground">{event.externalId}</span>}
                </span>
                <span className="text-muted-foreground">{formatDate(event.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
