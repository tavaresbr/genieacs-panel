'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { subscriptionAPI, type SubscriptionUsage, type TenantPlanOption } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { BillingProfile } from '@/components/billing-profile'
import { TenantCharges } from '@/components/tenant-charges'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { formatMoney } from '@/lib/money'
import {
  PLAN_RESOURCES,
  canCancelPending,
  canPayNow,
  canSwitchTo,
  confirmKey,
  isBillingExempt,
  isBillingExemptRefusal,
  isBusy,
  isPendingLocked,
  isPendingLockedRefusal,
  needsBillingProfile,
  overLimitDetail,
  payInNewTab,
  pendingBlockedDetail,
  periodLabel,
  planChangeKind,
  resourceLabelKey
} from '@/lib/plan-options'
import { displayDate, displayDayMonth } from '@/lib/date-format'

/**
 * O "plano e uso" do próprio provedor: qual plano, em que estado, quanto dele
 * está em uso — e, para quem tem `settings.write`, a troca de plano e o
 * "pagar agora".
 *
 * Sem proporcional: a próxima cobrança já sai com o preço novo. Subir vale na
 * hora; descer com a assinatura em dia fica agendado para a renovação
 * (`pendingPlan`), e o agendamento se cancela pedindo o plano atual. A tela
 * adianta na confirmação qual dos casos é, mas quem decide é o servidor — a
 * frase dele é o que aparece depois. É o backend quem recusa a troca para um plano que não comporta o
 * uso atual (`over_limit`); a tela só traduz a recusa em números. Quem não
 * escreve vê o catálogo, mas sem botões — mostrar um botão que sempre daria 403
 * é apontar para o que a pessoa não alcança.
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
  return 'modern-badge-error'
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  return displayDate(value)
}

/** A data de renovação já passou? Nulo e data inválida não venceram. */
function expirou(value: string | null | undefined) {
  if (!value) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.getTime() <= Date.now()
}

export default function PlanPage() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [data, setData] = useState<SubscriptionUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plans, setPlans] = useState<TenantPlanOption[] | null>(null)
  const [plansError, setPlansError] = useState<string | null>(null)
  const [mudando, setMudando] = useState<number | null>(null)
  const [pagando, setPagando] = useState(false)
  const [cancelando, setCancelando] = useState(false)
  // `info` é o `busy`: outra operação deste provedor em andamento no servidor.
  // Não é erro — é "tente de novo em instantes" — e não leva o tom vermelho.
  const [aviso, setAviso] = useState<{ tipo: 'erro' | 'ok' | 'info'; texto: string } | null>(null)
  // Muda a cada troca de plano ou cobrança gerada: é o que faz a lista de
  // cobranças, que carrega sozinha, buscar de novo.
  const [chargesKey, setChargesKey] = useState(0)
  const cadastroRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    // O catálogo carrega junto, mas com o próprio erro: uma falha nele não
    // pode esconder o plano atual, e vice-versa.
    const [res, catalogo] = await Promise.all([subscriptionAPI.current(), subscriptionAPI.plans()])
    if (res.success && res.data) {
      setData(res.data)
      setError(null)
    } else {
      setError(res.message || '')
    }
    if (catalogo.success && catalogo.data) {
      setPlans(catalogo.data)
      setPlansError(null)
    } else {
      setPlansError(catalogo.message || '')
    }
    setLoading(false)
  }, [])

  const podeEscrever = can('settings.write')

  /**
   * Pede a troca ao servidor e, no sucesso, mostra a frase dele — é ela que diz
   * se valeu na hora, se ficou agendada ou se o agendamento caiu — e recarrega
   * assinatura, catálogo e cobranças: o preço novo muda o que "pagar agora"
   * oferece, e a troca pode ter mexido na cobrança em aberto.
   */
  const trocar = async (planId: number, fallback: string) => {
    setAviso(null)
    const res = await subscriptionAPI.changePlan(planId)
    if (res.success && res.data) {
      setData(res.data)
      setError(null)
      toast.success(res.message || fallback)
      const [atual, catalogo] = await Promise.all([subscriptionAPI.current(), subscriptionAPI.plans()])
      if (atual.success && atual.data) setData(atual.data)
      if (catalogo.success && catalogo.data) setPlans(catalogo.data)
      setChargesKey((k) => k + 1)
      return
    }
    if (isBusy(res.code) || isPendingLockedRefusal(res.code)) {
      // A trava pode ter nascido depois da última carga: recarrega para os
      // botões sumirem.
      if (isPendingLockedRefusal(res.code)) {
        const atual = await subscriptionAPI.current()
        if (atual.success && atual.data) setData(atual.data)
      }
      setAviso({ tipo: 'info', texto: res.message || t('plan.options.changeFailed') })
      return
    }
    const acima = overLimitDetail(res)
    setAviso({
      tipo: 'erro',
      texto: acima
        ? t(acima.key, { resource: t(acima.resourceKey), used: acima.used, limit: acima.limit })
        : res.message || t('plan.options.changeFailed')
    })
  }

  const mudarPara = async (plan: TenantPlanOption) => {
    const periodo = periodLabel(plan.periodDays, formatMoney(plan.priceCents, plan.currency))
    const preco = t(periodo.key, periodo.vars)
    const atual = plans?.find((p) => p.current) ?? null
    const tipo = planChangeKind(atual, plan, data?.subscription)
    if (tipo === 'same') return
    const vars = { name: plan.name, price: preco, date: formatDate(data?.subscription?.renewsAt) ?? '' }
    if (!window.confirm(t(confirmKey(tipo), vars))) return
    setMudando(plan.id)
    await trocar(plan.id, t('plan.options.changed', { name: plan.name }))
    setMudando(null)
  }

  const cancelarAgendamento = async (planoAtualId: number, agendado: string) => {
    if (!window.confirm(t('plan.pending.cancelConfirm', { plan: agendado }))) return
    setCancelando(true)
    await trocar(planoAtualId, t('plan.pending.canceled'))
    setCancelando(false)
  }

  // Síncrono até o `payInNewTab`: a aba nova tem que abrir dentro do clique,
  // ou o navegador a bloqueia como pop-up.
  const pagarAgora = () => {
    setPagando(true)
    setAviso(null)
    void payInNewTab(subscriptionAPI.payNow).then((res) => {
      setPagando(false)
      setChargesKey((k) => k + 1)
      if (res.success && res.data?.charge?.invoiceUrl) return
      if (res.success) {
        setAviso({ tipo: 'erro', texto: t('plan.payNoLink') })
        return
      }
      if (isBillingExemptRefusal(res.code)) {
        // A isenção nasceu depois da última carga: recarrega para o botão
        // sumir e a nota aparecer.
        setAviso({ tipo: 'info', texto: t('plan.billingExemptNote') })
        void load()
        return
      }
      const texto = res.message || t('plan.payFailed')
      if (isBusy(res.code)) {
        // A aba em branco já foi fechada por `payInNewTab`.
        setAviso({ tipo: 'info', texto })
        return
      }
      if (needsBillingProfile(res.code)) {
        // O que falta está nesta mesma tela, logo abaixo: leva a pessoa até lá.
        setAviso({ tipo: 'erro', texto: `${texto} ${t('plan.payBillingHint')}` })
        cadastroRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        cadastroRef.current?.focus({ preventScroll: true })
      } else {
        setAviso({ tipo: 'erro', texto })
      }
    })
  }

  useEffect(() => {
    void load()
  }, [load])

  const subscription = data?.subscription ?? null
  // Isento: não vence nem recebe fatura. Some o prazo, o aviso de vencido e o
  // "pagar agora"; fica a nota.
  const isento = isBillingExempt(subscription)
  // Até quando (dd/mm), quando a isenção tem data de fim.
  const isentoAte = isento ? displayDayMonth(subscription?.billingExemptUntil) : null
  const venceu = !isento && expirou(subscription?.renewsAt)
  const pendente = subscription?.pendingPlan ?? null
  const pendenteBloqueio = pendingBlockedDetail(pendente)
  const planoAtualId = plans?.find((p) => p.current)?.id ?? null

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
          <button type="button" className="modern-button-secondary self-start sm:self-auto" disabled={loading} onClick={() => void load()}>
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
              <p className="mt-1 break-words text-2xl font-semibold text-foreground">{subscription.plan?.name ?? '—'}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className={badgeClass(subscription.status)}>
                  {t(STATUS_KEYS[subscription.status] ?? 'platform.subscription.suspended')}
                </span>
                {!isento && subscription.reason === 'trial_expired' && (
                  <span className="text-muted-foreground">{t('platform.subscription.trialExpiredNote')}</span>
                )}
                {!isento && subscription.reason === 'renewal_expired' && (
                  <span className="text-muted-foreground">{t('platform.subscription.renewalExpiredNote')}</span>
                )}
              </div>
              {isento && (
                <p role="status" className="mt-3 flex items-start gap-2 text-sm text-foreground">
                  <Icon name="info" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-info))]" />
                  {isentoAte ? t('plan.billingExemptUntilNote', { date: isentoAte }) : t('plan.billingExemptNote')}
                </p>
              )}
              <dl className="mt-4 space-y-2 text-sm">
                {!isento && subscription.storedStatus === 'trial' && formatDate(subscription.trialEndsAt) && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('plan.trialEnds')}</dt>
                    <dd className="font-medium">{formatDate(subscription.trialEndsAt)}</dd>
                  </div>
                )}
                {!isento && formatDate(subscription.renewsAt) && (
                  <div className="flex justify-between gap-3">
                    {/* "Pago até 12/03" com hoje em 12/09 era o painel publicando
                        ao cliente uma data que ele mesmo não respeitava. Agora
                        que o período vencido bloqueia a escrita, a etiqueta tem
                        que dizer qual dos dois lados da data se está. */}
                    <dt className="text-muted-foreground">
                      {venceu ? t('plan.paidThroughExpired') : t('plan.paidThrough')}
                    </dt>
                    <dd className="font-medium">{formatDate(subscription.renewsAt)}</dd>
                  </div>
                )}
              </dl>
              <p className="field-hint mt-4">{t('plan.changeHint')}</p>
              {canPayNow(plans, podeEscrever, subscription) && (
                <button type="button" className="modern-button mt-4" disabled={pagando} onClick={pagarAgora}>
                  <Icon name="invoice" size={17} />
                  {pagando ? t('plan.paying') : t('plan.payNow')}
                </button>
              )}
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
                      <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 text-muted-foreground">{label}</span>
                        <span className={`shrink-0 ${over ? 'font-semibold text-destructive' : 'font-medium'}`}>{text}</span>
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

        {!loading && pendente && (
          <section
            role="status"
            className="mt-6 flex flex-col gap-3 rounded-lg border border-[hsl(var(--status-info)/.3)] bg-[hsl(var(--status-info)/.06)] p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 gap-3">
              <Icon name="info" size={18} className="mt-0.5 shrink-0 text-[hsl(var(--status-info))]" />
              <div className="min-w-0 text-sm">
                <p className="break-words font-medium text-foreground">
                  {t('plan.pending.title', { plan: pendente.name, date: formatDate(pendente.effectiveAt) ?? '—' })}
                </p>
                <p className="mt-1 text-muted-foreground">{t('plan.pending.hint')}</p>
                {isPendingLocked(pendente) && (
                  <p className="mt-1 text-muted-foreground">
                    {t('plan.pending.locked', { date: formatDate(pendente.effectiveAt) ?? '—' })}
                  </p>
                )}
                {pendenteBloqueio && (
                  <p className="mt-2 text-[hsl(var(--status-warning))]">
                    {t(pendenteBloqueio.key, {
                      resource: t(pendenteBloqueio.resourceKey),
                      used: pendenteBloqueio.used,
                      limit: pendenteBloqueio.limit
                    })}
                  </p>
                )}
              </div>
            </div>
            {canCancelPending(pendente, podeEscrever) && planoAtualId !== null && (
              <button
                type="button"
                className="modern-button-secondary w-full shrink-0 justify-center sm:w-auto"
                disabled={cancelando || mudando !== null}
                onClick={() => void cancelarAgendamento(planoAtualId, pendente.name)}
              >
                {cancelando ? t('plan.pending.canceling') : t('plan.pending.cancel')}
              </button>
            )}
          </section>
        )}

        {aviso && (
          <p
            role={aviso.tipo === 'erro' ? 'alert' : 'status'}
            className={`mt-6 text-sm ${
              aviso.tipo === 'erro'
                ? 'text-destructive'
                : aviso.tipo === 'info'
                  ? 'text-muted-foreground'
                  : 'text-emerald-700 dark:text-emerald-400'
            }`}
          >
            {aviso.texto}
          </p>
        )}

        {/* O catálogo fica entre o plano atual e as cobranças: é a pergunta
            seguinte a "em que plano estou". Fora do estado de carga da
            assinatura, como as cobranças, porque tem a própria carga. */}
        {!loading && (
          <section className="modern-card mt-6 p-5 sm:p-6">
            <h2 className="section-heading">{t('plan.options.title')}</h2>
            <p className="section-description">{t('plan.options.description')}</p>
            {plansError !== null ? (
              <p className="mt-3 text-sm text-destructive">{plansError || t('plan.options.loadFailed')}</p>
            ) : !plans?.length ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('plan.options.empty')}</p>
            ) : (
              <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {plans.map((plan) => {
                  const periodo = periodLabel(plan.periodDays, formatMoney(plan.priceCents, plan.currency))
                  return (
                    <li
                      key={plan.id}
                      className={`flex min-w-0 flex-col rounded-lg border p-4 ${
                        plan.current ? 'border-primary' : plan.id === pendente?.id ? 'border-dashed border-primary/60' : 'border-border'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="min-w-0 break-words font-semibold text-foreground">{plan.name}</h3>
                        {plan.current && <span className="modern-badge-success">{t('plan.options.current')}</span>}
                        {!plan.current && plan.id === pendente?.id && (
                          <span className="modern-badge-info">{t('plan.options.scheduled')}</span>
                        )}
                      </div>
                      <p className="mt-1 text-lg font-semibold text-foreground">{t(periodo.key, periodo.vars)}</p>
                      <dl className="mt-3 flex-1 space-y-1 text-sm">
                        {PLAN_RESOURCES.map((recurso) => (
                          <div key={recurso} className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">{t(resourceLabelKey(recurso))}</dt>
                            <dd className="font-medium">{plan.limits[recurso] ?? t('plan.options.unlimited')}</dd>
                          </div>
                        ))}
                      </dl>
                      {canSwitchTo(plan, podeEscrever, subscription) && (
                        <button
                          type="button"
                          className="modern-button-secondary mt-4 w-full justify-center"
                          disabled={mudando !== null || cancelando}
                          onClick={() => void mudarPara(plan)}
                        >
                          {mudando === plan.id ? t('plan.options.switching') : t('plan.options.switch')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}

        {/* As cobranças vêm ANTES do cadastro fiscal e depois do plano, que é a
            ordem da pergunta: em que plano estou, o que me foi cobrado, e para
            quem vai a nota. Fora do `else` do estado de carga acima de
            propósito: o bloco tem a própria carga, então um provedor sem
            assinatura — que é um dos que mais precisa pagar — continua vendo o
            que deve. */}
        <div className="mt-6">
          <TenantCharges refreshKey={chargesKey} />
        </div>

        {/* Abaixo do plano, e não numa aba das configurações: é a mesma
            conversa — em que plano estou, até quando paguei, e para quem vai a
            nota. */}
        {/* `tabIndex` para o "pagar agora" poder levar o foco até aqui quando a
            cobrança é recusada por falta de CNPJ ou razão social. */}
        {data && (
          <div ref={cadastroRef} tabIndex={-1} className="mt-6 scroll-mt-4 outline-none">
            <BillingProfile
              billing={data.billing}
              onSaved={(billing) => setData((atual) => (atual ? { ...atual, billing } : atual))}
            />
          </div>
        )}
      </div>
    </div>
  )
}
