'use client'

import { useEffect, useId, useState } from 'react'
import {
  platformAPI,
  type BillingCycle,
  type ConsolePlanPreview,
  type Plan,
  type PlanChangeMode
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { displayDate } from '@/lib/date-format'
import { resourceLabelKey } from '@/lib/plan-options'
import {
  canApply,
  isNoop,
  outcomeKey,
  outcomeProrationKey,
  previewForMode,
  reasonRequired,
  replacesPending,
  timingKey
} from '@/lib/plan-change-console'
import type { TranslationKey } from '@/lib/i18n'

interface Props {
  tenantId: number
  plans: Plan[]
  /** O plano de agora, para o seletor começar nele. */
  currentPlanId: number | null
  /** Depois de uma troca: quem mostra a assinatura recarrega. */
  onChanged: () => void | Promise<void>
}

const MODES: PlanChangeMode[] = ['auto', 'now', 'renewal']
const MODE_KEYS: Record<PlanChangeMode, TranslationKey> = {
  auto: 'platform.planChange.modeAuto',
  now: 'platform.planChange.modeNow',
  renewal: 'platform.planChange.modeRenewal'
}
const BLOCKER_KEYS: Record<ConsolePlanPreview['blockers'][number], TranslationKey> = {
  cancel_scheduled: 'platform.planChange.blockerCancel',
  subscription_paused: 'platform.planChange.blockerPaused',
  pending_locked: 'platform.planChange.pendingLocked',
  cycle_unavailable: 'platform.planChange.blockerCycle'
}

function formatDate(value: string | null | undefined) {
  return (value ? displayDate(value) : null) ?? ''
}

/**
 * A troca de plano pelo console, com a MESMA prévia do provedor: escolher o
 * plano e o ciclo mostra, antes do clique, quando a troca vale, o preço a
 * partir dali, a pró-rata, o que passa dos tetos e a troca agendada que ela
 * substituiria. O modo (`auto` é a regra do provedor; `now` e `renewal`
 * forçam) e as exceções (dispensar a pró-rata, pular o limite) ficam à mão,
 * com o motivo quando a exceção o exige. Quem decide é o servidor: a tela
 * só não deixa apertar o que ele recusaria.
 */
export function ConsolePlanChange({ tenantId, plans, currentPlanId, onChanged }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const ids = useId()

  const [chosenPlan, setChosenPlan] = useState<number | ''>(currentPlanId ?? '')
  const [cycle, setCycle] = useState<BillingCycle | ''>('')
  const [mode, setMode] = useState<PlanChangeMode>('auto')
  const [prorate, setProrate] = useState(true)
  const [skipLimitCheck, setSkipLimitCheck] = useState(false)
  const [replacePending, setReplacePending] = useState(false)
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<ConsolePlanPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  // Muda a cada troca: a prévia é pedida de novo com o estado novo.
  const [version, setVersion] = useState(0)

  useEffect(() => {
    setChosenPlan(currentPlanId ?? '')
  }, [currentPlanId])

  useEffect(() => {
    if (chosenPlan === '') {
      setPreview(null)
      return undefined
    }
    let vivo = true
    setLoadingPreview(true)
    void platformAPI.previewPlanChange(tenantId, Number(chosenPlan), cycle || null).then((res) => {
      if (!vivo) return
      setLoadingPreview(false)
      if (res.success && res.data) {
        setPreview(res.data.preview)
        setPreviewError(null)
      } else {
        setPreview(null)
        setPreviewError(res.message || t('platform.planChange.previewFailed'))
      }
    })
    return () => {
      vivo = false
    }
  }, [tenantId, chosenPlan, cycle, version, t])

  // O modo `renewal` sem renovação não existe: volta à regra.
  useEffect(() => {
    if (preview && !previewForMode(preview, mode)) setMode('auto')
  }, [preview, mode])

  const escolhido = plans.find((plan) => plan.id === chosenPlan) ?? null
  const temAnual = escolhido ? escolhido.priceYearlyCents !== null && escolhido.priceYearlyCents !== undefined : false
  const doModo = previewForMode(preview, mode)
  const precisaMotivo = reasonRequired(preview, mode, skipLimitCheck)
  const substitui = replacesPending(preview, mode)
  const acimaAgora = Boolean(doModo && doModo.timing === 'now' && preview && preview.overLimit.length > 0)
  const pode = canApply(preview, { mode, reason, skipLimitCheck, replacePending }) && !loadingPreview
  const planoAgendado = preview?.pending ? plans.find((plan) => plan.id === preview.pending?.planId) : null

  const aplicar = async () => {
    if (!preview || !pode || chosenPlan === '') return
    setSaving(true)
    try {
      const res = await platformAPI.updateSubscription(tenantId, {
        planId: Number(chosenPlan),
        ...(cycle ? { cycle } : {}),
        mode,
        prorate,
        ...(acimaAgora && skipLimitCheck ? { skipLimitCheck: true } : {}),
        ...(substitui ? { replacePending: true } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {})
      })
      if (res.success) {
        const outcome = res.data?.outcome ?? null
        const partes = [t(outcomeKey(outcome), { date: formatDate(outcome?.effectiveAt) })]
        const prorata = outcomeProrationKey(outcome)
        if (prorata && outcome?.proration) {
          partes.push(t(prorata, {
            amount: formatMoney(outcome.proration.amountCents ?? 0, outcome.proration.currency || preview.modes.auto.currency)
          }))
        }
        toast.success(partes.join(' '))
        setReason('')
        setSkipLimitCheck(false)
        setReplacePending(false)
        setMode('auto')
        setProrate(true)
        setVersion((v) => v + 1)
        await onChanged()
      } else {
        // A troca agendada pode ter nascido depois da prévia: pede de novo,
        // e o aviso de substituir aparece.
        if (res.code === 'pending_change') setVersion((v) => v + 1)
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <select
        value={chosenPlan}
        onChange={(e) => {
          setChosenPlan(e.target.value === '' ? '' : Number(e.target.value))
          setCycle('')
          setReplacePending(false)
        }}
        className="modern-input w-full"
        aria-label={t('platform.subscription.plan')}
      >
        {chosenPlan === '' && <option value="">—</option>}
        {plans.map((plan) => (
          <option key={plan.id} value={plan.id} disabled={!plan.active && plan.id !== currentPlanId}>
            {plan.name} ({plan.code}) · {formatMoney(plan.priceCents, plan.currency)}
            {plan.active ? '' : ` — ${t('platform.plans.inactive')}`}
          </option>
        ))}
      </select>

      <label className="block text-sm" htmlFor={`${ids}-ciclo`}>
        <span className="text-muted-foreground">{t('platform.planChange.cycle')}</span>
        <select
          id={`${ids}-ciclo`}
          // Vazio é "o de agora", que a prévia diz qual é.
          value={cycle || preview?.current.cycle || 'monthly'}
          onChange={(e) => setCycle(e.target.value as BillingCycle)}
          className="modern-input mt-1 w-full"
        >
          <option value="monthly">{t('plan.cycle.monthly')}</option>
          <option value="annual" disabled={!temAnual}>{t('plan.cycle.annual')}</option>
        </select>
      </label>

      {loadingPreview && <p className="text-sm text-muted-foreground">{t('platform.planChange.loadingPreview')}</p>}
      {previewError && <p className="text-sm text-destructive">{previewError}</p>}

      {preview && !loadingPreview && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2 text-sm" aria-live="polite">
          {isNoop(preview) && <p className="text-muted-foreground">{t('platform.planChange.noop')}</p>}
          {preview.blockers.map((b) => (
            <p key={b} role="alert" className="text-destructive">
              {t(BLOCKER_KEYS[b], { date: formatDate(preview.pending?.effectiveAt) })}
            </p>
          ))}

          {!isNoop(preview) && (
            <fieldset>
              <legend className="text-muted-foreground">{t('platform.planChange.mode')}</legend>
              <div className="mt-1 flex flex-wrap gap-3">
                {MODES.map((m) => (
                  <label key={m} className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      name={`${ids}-modo`}
                      value={m}
                      checked={mode === m}
                      disabled={!previewForMode(preview, m)}
                      onChange={() => setMode(m)}
                    />
                    {t(MODE_KEYS[m])}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {doModo && !isNoop(preview) && (
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                {t(timingKey(doModo), { date: formatDate(doModo.effectiveAt) })}
              </p>
              <p>
                {doModo.nextChargeAt
                  ? t('platform.planChange.priceFrom', {
                    date: formatDate(doModo.nextChargeAt),
                    price: formatMoney(doModo.priceCents, doModo.currency)
                  })
                  : t('platform.planChange.priceNext', { price: formatMoney(doModo.priceCents, doModo.currency) })}
              </p>
              {doModo.proration && doModo.proration.skipped && <p>{t('plan.proration.belowMinimum')}</p>}
              {doModo.proration && !doModo.proration.skipped && doModo.proration.amountCents > 0 && (
                <>
                  <p>
                    {t('platform.planChange.prorationNow', {
                      amount: formatMoney(doModo.proration.amountCents, doModo.proration.currency || doModo.currency),
                      days: doModo.proration.remainingDays
                    })}
                  </p>
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={prorate} onChange={(e) => setProrate(e.target.checked)} />
                    {t('platform.planChange.prorate')}
                  </label>
                </>
              )}
              {doModo.prorationSkipped === 'cycle_change' && <p>{t('platform.planChange.prorationCycle')}</p>}
            </div>
          )}

          {preview.overLimit.length > 0 && !isNoop(preview) && (
            <div className={acimaAgora ? 'text-destructive' : 'text-muted-foreground'}>
              {preview.overLimit.map((o) => (
                <p key={o.resource}>
                  {t('platform.planChange.overLimit', { resource: t(resourceLabelKey(o.resource)), used: o.used, limit: o.limit })}
                </p>
              ))}
              {acimaAgora && (
                <label className="inline-flex items-center gap-2 text-foreground">
                  <input type="checkbox" checked={skipLimitCheck} onChange={(e) => setSkipLimitCheck(e.target.checked)} />
                  {t('platform.planChange.skipLimitCheck')}
                </label>
              )}
            </div>
          )}

          {substitui && preview.pending && !preview.pending.locked && (
            <div role="alert" className="text-[hsl(var(--status-warning))]">
              <p>
                {t('platform.planChange.pendingWarning', {
                  plan: planoAgendado?.name ?? `#${preview.pending.planId}`,
                  date: formatDate(preview.pending.effectiveAt)
                })}
              </p>
              <label className="inline-flex items-center gap-2 text-foreground">
                <input type="checkbox" checked={replacePending} onChange={(e) => setReplacePending(e.target.checked)} />
                {t('platform.planChange.replacePending')}
              </label>
            </div>
          )}

          {!isNoop(preview) && (
            <div>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="modern-input w-full"
                placeholder={t(precisaMotivo ? 'platform.planChange.reasonRequired' : 'platform.planChange.reason')}
                aria-label={t(precisaMotivo ? 'platform.planChange.reasonRequired' : 'platform.planChange.reason')}
                maxLength={255}
                required={precisaMotivo}
              />
              {precisaMotivo && <p className="field-hint">{t('platform.planChange.reasonHint')}</p>}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => void aplicar()}
        disabled={saving || !pode}
        className="modern-button"
      >
        {saving ? t('common.saving') : t('platform.planChange.apply')}
      </button>
    </div>
  )
}
