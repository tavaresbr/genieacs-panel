'use client'

import { useState } from 'react'
import {
  planPriceChangeAPI,
  type BillingCycle,
  type Plan,
  type PlanPriceChange,
  type PlanPriceChangePreview
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { parseAmountToCents } from '@/lib/utils'
import { formatMoney } from '@/lib/money'
import { displayDate } from '@/lib/date-format'
import { DEFAULT_NOTICE_DAYS, currentCyclePrice, isoDaysFromToday } from '@/lib/price-change'

/** O sinal da diferença, com a moeda: "+R$ 38,00". */
function comSinal(cents: number, currency: string) {
  return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatMoney(Math.abs(cents), currency)}`
}

interface Props {
  plan: Plan
  /** Recarrega a lista dos planos (é ela que traz os reajustes). */
  onChange: () => void
}

/**
 * O reajuste de preço com data de vigência (0122), dentro do cartão do plano:
 * os reajustes agendados (com o cancelar), o histórico recente, e o painel
 * "Agendar reajuste" — preço novo, data, antecedência do aviso, motivo, e a
 * prévia de quantos provedores o preço novo pega e da receita antes e depois.
 *
 * A regra é do servidor: a cobrança que vence ANTES da data paga o preço de
 * hoje; a que vence na data ou depois, o novo. A tela só repete a data mínima
 * (hoje + antecedência) para não mandar um pedido que ela já sabe recusado.
 */
export function PlanPriceChanges({ plan, onChange }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const anualDisponivel = currentCyclePrice(plan, 'annual') !== null
  const [aberto, setAberto] = useState(false)
  const [ciclo, setCiclo] = useState<BillingCycle>('monthly')
  const [preco, setPreco] = useState('')
  const [antecedencia, setAntecedencia] = useState(String(DEFAULT_NOTICE_DAYS))
  const [data, setData] = useState(isoDaysFromToday(DEFAULT_NOTICE_DAYS))
  const [avisar, setAvisar] = useState(true)
  const [motivo, setMotivo] = useState('')
  const [previa, setPrevia] = useState<PlanPriceChangePreview | null>(null)
  const [calculando, setCalculando] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [cancelando, setCancelando] = useState<number | null>(null)

  const mudancas = plan.priceChanges ?? []
  const agendados = mudancas.filter((m) => m.status === 'scheduled')
  const historico = mudancas.filter((m) => m.status !== 'scheduled')
  const dias = Math.max(1, Math.floor(Number(antecedencia) || DEFAULT_NOTICE_DAYS))
  const dataMinima = isoDaysFromToday(dias)
  const precoDeHoje = currentCyclePrice(plan, ciclo)
  const rotuloCiclo = (c: BillingCycle) => t(c === 'annual'
    ? 'platform.plans.priceChange.cycleAnnual'
    : 'platform.plans.priceChange.cycleMonthly')
  const dinheiro = (cents: number) => formatMoney(cents, plan.currency)

  const abrir = () => {
    setCiclo('monthly')
    setPreco('')
    setAntecedencia(String(DEFAULT_NOTICE_DAYS))
    setData(isoDaysFromToday(DEFAULT_NOTICE_DAYS))
    setAvisar(true)
    setMotivo('')
    setPrevia(null)
    setAberto(true)
  }

  const verPrevia = async () => {
    const centavos = parseAmountToCents(preco)
    if (centavos === null || centavos <= 0) {
      toast.error(t('platform.plans.priceChange.invalidPrice'))
      return
    }
    setCalculando(true)
    try {
      const res = await planPriceChangeAPI.preview(plan.id, ciclo, centavos)
      if (res.success && res.data) setPrevia(res.data.preview)
      else toast.error(res.message || t('platform.plans.priceChange.failed'))
    } finally {
      setCalculando(false)
    }
  }

  const agendar = async () => {
    const centavos = parseAmountToCents(preco)
    if (centavos === null || centavos <= 0) {
      toast.error(t('platform.plans.priceChange.invalidPrice'))
      return
    }
    if (!data) {
      toast.error(t('platform.plans.priceChange.invalidDate'))
      return
    }
    setSalvando(true)
    try {
      const res = await planPriceChangeAPI.schedule(plan.id, {
        cycle: ciclo,
        newCents: centavos,
        effectiveAt: data,
        noticeDays: dias,
        notify: avisar,
        reason: motivo.trim() || null
      })
      if (!res.success) {
        // A frase é do servidor, traduzida: data cedo demais, preço igual, já agendado.
        toast.error(res.message || t('platform.plans.priceChange.failed'))
        return
      }
      toast.success(t('platform.plans.priceChange.scheduled'))
      setAberto(false)
      onChange()
    } finally {
      setSalvando(false)
    }
  }

  const cancelar = async (mudanca: PlanPriceChange) => {
    const ok = window.confirm(t('platform.plans.priceChange.cancelConfirm', {
      price: dinheiro(mudanca.newCents), date: displayDate(mudanca.effectiveAt) ?? mudanca.effectiveAt
    }))
    if (!ok) return
    setCancelando(mudanca.id)
    try {
      const res = await planPriceChangeAPI.cancel(mudanca.id)
      if (!res.success) {
        toast.error(res.message || t('platform.plans.priceChange.cancelFailed'))
        return
      }
      toast.success(t('platform.plans.priceChange.canceled'))
      onChange()
    } finally {
      setCancelando(null)
    }
  }

  return (
    <div className="mt-3 space-y-2">
      {agendados.map((m) => (
        <div key={m.id} className="flex flex-col gap-2 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-2 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2 text-foreground">
            <Icon name="info" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-info))]" />
            <span>
              {t('platform.plans.priceChange.scheduledBadge', {
                cycle: rotuloCiclo(m.cycle),
                from: dinheiro(m.oldCents),
                to: dinheiro(m.newCents),
                date: displayDate(m.effectiveAt) ?? m.effectiveAt
              })}
              {m.reason && <span className="text-muted-foreground"> · {m.reason}</span>}
            </span>
          </span>
          <button
            type="button" className="modern-button-secondary shrink-0" disabled={cancelando === m.id}
            onClick={() => void cancelar(m)}
          >
            {t('platform.plans.priceChange.cancel')}
          </button>
        </div>
      ))}

      {historico.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('platform.plans.priceChange.history')}</summary>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {historico.map((m) => (
              <li key={m.id}>
                {t('platform.plans.priceChange.historyItem', {
                  cycle: rotuloCiclo(m.cycle),
                  from: dinheiro(m.oldCents),
                  to: dinheiro(m.newCents),
                  date: displayDate(m.effectiveAt) ?? m.effectiveAt,
                  status: t(m.status === 'applied'
                    ? 'platform.plans.priceChange.statusApplied'
                    : 'platform.plans.priceChange.statusCanceled')
                })}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!aberto && (
        <button type="button" className="modern-button-secondary" onClick={abrir}>
          <Icon name="invoice" size={16} />
          {t('platform.plans.priceChange.schedule')}
        </button>
      )}

      {aberto && (
        <section
          aria-label={t('platform.plans.priceChange.title')}
          className="space-y-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4"
        >
          <div>
            <h3 className="font-semibold text-foreground">{t('platform.plans.priceChange.title')}</h3>
            <p className="field-hint">{t('platform.plans.priceChange.hint')}</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label" htmlFor={`pc-cycle-${plan.id}`}>{t('platform.plans.priceChange.cycle')}</label>
              <select
                id={`pc-cycle-${plan.id}`} className="modern-input w-full" value={ciclo}
                onChange={(e) => {
                  setCiclo(e.target.value as BillingCycle)
                  setPrevia(null)
                }}
              >
                <option value="monthly">{rotuloCiclo('monthly')}</option>
                {anualDisponivel && <option value="annual">{rotuloCiclo('annual')}</option>}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor={`pc-price-${plan.id}`}>{t('platform.plans.priceChange.newPrice')}</label>
              <input
                id={`pc-price-${plan.id}`} className="modern-input w-full" inputMode="decimal" placeholder="0,00"
                value={preco}
                onChange={(e) => {
                  setPreco(e.target.value)
                  setPrevia(null)
                }}
              />
              {precoDeHoje !== null && (
                <p className="field-hint">{t('platform.plans.priceChange.currentPrice', { price: dinheiro(precoDeHoje) })}</p>
              )}
            </div>
            <div>
              <label className="field-label" htmlFor={`pc-notice-${plan.id}`}>{t('platform.plans.priceChange.noticeDays')}</label>
              <input
                id={`pc-notice-${plan.id}`} type="number" min={1} max={365} className="modern-input w-full"
                value={antecedencia}
                onChange={(e) => setAntecedencia(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor={`pc-date-${plan.id}`}>{t('platform.plans.priceChange.effectiveAt')}</label>
              <input
                id={`pc-date-${plan.id}`} type="date" className="modern-input w-full" min={dataMinima}
                value={data}
                onChange={(e) => setData(e.target.value)}
              />
              <p className="field-hint">
                {t('platform.plans.priceChange.noticeHint', { date: displayDate(dataMinima) ?? dataMinima })}
              </p>
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor={`pc-reason-${plan.id}`}>{t('platform.plans.priceChange.reason')}</label>
            <input
              id={`pc-reason-${plan.id}`} className="modern-input w-full" maxLength={255}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={avisar} onChange={(e) => setAvisar(e.target.checked)} />
            {t('platform.plans.priceChange.notify')}
          </label>

          {previa && (
            <div role="status" className="space-y-1 rounded-md border border-border p-3 text-sm">
              <p className="font-medium text-foreground">
                {t('platform.plans.priceChange.previewAffected', { count: previa.affected })}
              </p>
              {previa.exempt > 0 && (
                <p className="text-muted-foreground">{t('platform.plans.priceChange.previewExempt', { count: previa.exempt })}</p>
              )}
              <p className="text-muted-foreground">
                {t('platform.plans.priceChange.previewRevenue', {
                  before: formatMoney(previa.revenueBeforeCents, previa.currency),
                  after: formatMoney(previa.revenueAfterCents, previa.currency),
                  delta: comSinal(previa.deltaCents, previa.currency)
                })}
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="button" className="modern-button-secondary" disabled={calculando} onClick={() => void verPrevia()}>
              {calculando ? t('platform.plans.priceChange.previewLoading') : t('platform.plans.priceChange.preview')}
            </button>
            <button type="button" className="modern-button" disabled={salvando} onClick={() => void agendar()}>
              {salvando ? t('common.saving') : t('platform.plans.priceChange.confirm')}
            </button>
            <button type="button" className="modern-button-secondary" onClick={() => setAberto(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

export default PlanPriceChanges
