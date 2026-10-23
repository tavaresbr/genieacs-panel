'use client'

import { useCallback, useEffect, useState } from 'react'
import { subscriptionAPI, type TenantChargeStatusFilter, type TenantChargeView } from '@/lib/api'
import { formatMoney } from '@/lib/money'
import { ChargePricingBreakdown } from '@/components/charge-pricing'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { displayDate } from '@/lib/date-format'
import { safeInvoiceUrl } from '@/lib/invoice'
import { ChargePaymentModal } from '@/components/charge-payment-modal'
import {
  CHARGE_STATUS_FILTERS, CHARGE_STATUS_FILTER_KEYS, chargeKindKey, chargeYearOptions, paymentMethodKey, tenantChargesCsv
} from '@/lib/tenant-charges'

/**
 * O que foi cobrado deste provedor, e onde ele paga.
 *
 * A tabela `billing_charges` guarda o endereço da página do gateway desde que a
 * emissão automática existe, e até aqui ele só saía pelo e-mail de aviso: quem
 * perdeu o e-mail via o muro do 402 sem ter, em tela nenhuma, onde pagar.
 *
 * A rota fica FORA da porta da assinatura, o que é o ponto todo — este bloco
 * carrega para um provedor bloqueado, que é exatamente quem precisa dele.
 */
const STATUS_KEYS: Record<TenantChargeView['status'], TranslationKey> = {
  pending: 'charges.status.pending',
  paid: 'charges.status.paid',
  canceled: 'charges.status.canceled',
  // `failed` é a emissão que o gateway recusou — a cobrança não chegou ao
  // cliente. Dizer "falhou" a ele sem mais nada seria assustar por um problema
  // nosso, então o rótulo fala do que ele vê: ainda não há o que pagar aqui.
  failed: 'charges.status.failed',
  // `overdue` é a cobrança em aberto que passou do vencimento na Asaas. Ainda
  // se paga — e o link continua na linha, igual ao de `pending`.
  overdue: 'charges.status.overdue',
  // `refunded` é o pagamento que voltou ao cliente: não há mais o que pagar.
  refunded: 'charges.status.refunded'
}

function badgeClass(status: TenantChargeView['status']) {
  if (status === 'paid') return 'modern-badge-success'
  if (status === 'pending') return 'modern-badge-warning'
  // Estornada não é erro de ninguém: é um fato, e o selo neutro diz só isso.
  if (status === 'refunded' || status === 'canceled') return 'modern-badge'
  // `-error` e não `-danger`: é a classe que existe em `globals.css`.
  return 'modern-badge-error'
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  return displayDate(value)
}

/**
 * A cobrança que ainda se paga, se houver — a mais recente delas.
 *
 * Exportada porque o muro do 402 faz a mesma pergunta: lá a resposta vira um
 * botão, aqui vira uma linha da tabela, e as duas telas não podem discordar
 * sobre qual boleto está em aberto.
 */
export function cobrancaEmAberto(charges: TenantChargeView[]) {
  return charges.find((c) => c.invoiceUrl && (c.status === 'pending' || c.status === 'overdue' || c.status === 'failed')) ?? null
}

/** A fatura de pró-rata ainda pagável, se houver — a do aviso `proration_overdue`. */
export function cobrancaDeProrata(charges: TenantChargeView[]) {
  // A de só excedente (0105) é avulsa como a pró-rata, e vencida bloqueia igual.
  return cobrancaEmAberto(charges.filter((c) => c.kind === 'proration' || c.kind === 'overage'))
}

/**
 * `refreshKey` é o jeito de a página pedir uma recarga de fora: ela muda o
 * número depois de trocar o plano ou gerar uma cobrança, e a lista busca de
 * novo sem que a página precise saber como ela carrega.
 */
export function TenantCharges({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const { t } = useTranslation()
  const [charges, setCharges] = useState<TenantChargeView[] | null>(null)
  const [years, setYears] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Sem ano, as mais recentes — a lista de sempre. Com ano, todas daquele ano.
  const [year, setYear] = useState<number | null>(null)
  const [status, setStatus] = useState<TenantChargeStatusFilter | null>(null)
  const [paying, setPaying] = useState<number | null>(null)
  const [receiptBusy, setReceiptBusy] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await subscriptionAPI.charges({ year, status })
    if (res.success && res.data) {
      setCharges(res.data.charges)
      setYears(res.data.years ?? [])
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [year, status])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const statusLabel = (value: string) => {
    const key = STATUS_KEYS[value as TenantChargeView['status']]
    return key ? t(key) : value
  }

  const exportar = () => {
    if (!charges?.length) return
    const csv = tenantChargesCsv(charges, [
      'id', t('charges.col.kind'), t('charges.period'), t('charges.dueDate'), t('charges.col.status'), 'currency',
      t('charges.col.amount'), t('charges.col.discount'), t('charges.col.credit'), t('charges.col.coupon'),
      t('charges.paidAt'), t('charges.col.method'), t('nfse.column')
    ], {
      status: statusLabel,
      kind: (kind) => t(chargeKindKey(kind)),
      method: (method) => t(paymentMethodKey(method))
    })
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `faturas-${year ?? 'recentes'}-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  /**
   * O recibo abre numa aba nova, pronto para imprimir. A aba é aberta ANTES de
   * esperar a resposta: aberta depois de um `await`, o bloqueador de pop-up a
   * recusaria. Sem aba (bloqueada mesmo assim), o arquivo é baixado.
   */
  const abrirRecibo = async (chargeId: number) => {
    setActionError(null)
    setReceiptBusy(chargeId)
    const janela = window.open('', '_blank')
    const res = await subscriptionAPI.chargeReceipt(chargeId)
    setReceiptBusy(null)
    if (!res.success || !res.blob) {
      janela?.close()
      setActionError(res.message || t('charges.receiptFailed'))
      return
    }
    const url = URL.createObjectURL(new Blob([res.blob], { type: 'text/html;charset=utf-8' }))
    if (janela) {
      janela.opener = null
      janela.location.href = url
    } else {
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename || `recibo-${chargeId}.html`
      link.click()
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const fecharSegundaVia = useCallback(() => setPaying(null), [])

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-heading">{t('charges.title')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="modern-input w-auto"
            aria-label={t('charges.filter.year')}
            value={year ?? ''}
            onChange={(event) => setYear(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">{t('charges.filter.recent')}</option>
            {chargeYearOptions(years).map((ano) => (
              <option key={ano} value={ano}>{ano}</option>
            ))}
          </select>
          <select
            className="modern-input w-auto"
            aria-label={t('charges.filter.status')}
            value={status ?? ''}
            onChange={(event) => setStatus((event.target.value || null) as TenantChargeStatusFilter | null)}
          >
            <option value="">{t('charges.filter.allStatuses')}</option>
            {CHARGE_STATUS_FILTERS.map((valor) => (
              <option key={valor} value={valor}>{t(CHARGE_STATUS_FILTER_KEYS[valor])}</option>
            ))}
          </select>
          <button type="button" className="modern-button-secondary" disabled={loading || !charges?.length} onClick={exportar}>
            <Icon name="document" size={17} />
            {t('charges.exportCsv')}
          </button>
          <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {actionError && <p className="mt-3 text-sm text-destructive" role="alert">{actionError}</p>}

      {loading ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : error !== null ? (
        <p className="mt-3 text-sm text-destructive">{error || t('charges.loadFailed')}</p>
      ) : !charges?.length ? (
        /* Sem cobrança não é erro: é o provedor em teste, o de plano grátis e o
           que ainda não chegou na primeira emissão. Com filtro, é o filtro. */
        <p className="mt-3 text-sm text-muted-foreground">{year || status ? t('charges.noMatch') : t('charges.empty')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {charges.map((charge) => (
            <li key={charge.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {formatMoney(charge.amountCents, charge.currency)}
                  {/* O tipo: a mensalidade, a avulsa da subida no meio do
                      período ou a de só excedente. */}
                  <span className={charge.kind === 'proration' || charge.kind === 'overage' ? 'modern-badge-info' : 'modern-badge'}>
                    {t(chargeKindKey(charge.kind))}
                  </span>
                  {/* O crédito de indicação (ou do console) abatido nela (0106). */}
                  {(charge.creditCents ?? 0) > 0 && (
                    <span className="modern-badge-success">
                      {t('referrals.creditApplied', { amount: formatMoney(charge.creditCents ?? 0, charge.currency) })}
                    </span>
                  )}
                  {(charge.earlyDiscountCents ?? 0) > 0 && (
                    <span className="modern-badge-success">
                      {t('charges.earlyDiscount', { amount: formatMoney(charge.earlyDiscountCents ?? 0, charge.currency) })}
                    </span>
                  )}
                  {charge.couponCode && (
                    <span className="modern-badge-success">{t('charges.coupon', { code: charge.couponCode })}</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('charges.period')}: {formatDate(charge.periodEnd) ?? charge.periodEnd}
                  {formatDate(charge.dueDate) && ` · ${t('charges.dueDate')}: ${formatDate(charge.dueDate)}`}
                </p>
                {/* Quando e como foi paga — o meio "não informado" é o de
                    pagamentos anteriores a esta versão. */}
                {charge.paidAt && (
                  <p className="text-xs text-muted-foreground">
                    {t('charges.paidOn', {
                      date: formatDate(charge.paidAt) ?? charge.paidAt,
                      method: t(paymentMethodKey(charge.paymentMethod))
                    })}
                  </p>
                )}
                {/* O plano e o excedente do período (0105), quando há excedente. */}
                <ChargePricingBreakdown pricing={charge.pricing} currency={charge.currency} />
                {/* A nota fiscal emitida: o número e o PDF, para o financeiro do
                    provedor. Só endereço `https:` vira link. */}
                {safeInvoiceUrl(charge.invoice?.pdfUrl) && (
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    {charge.invoice?.number && (
                      <span className="text-muted-foreground">{t('nfse.number', { number: charge.invoice.number })}</span>
                    )}
                    <a
                      href={safeInvoiceUrl(charge.invoice?.pdfUrl) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary hover:underline"
                    >
                      {t('nfse.pdf')}
                    </a>
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Um status que este frontend ainda não conhece (backend mais novo)
                    aparece cru, que é pouco, mas é mais do que uma célula vazia. */}
                <span className={badgeClass(charge.status)}>{statusLabel(charge.status)}</span>
                {charge.receiptAvailable && (
                  <button
                    type="button"
                    className="modern-button-secondary"
                    disabled={receiptBusy === charge.id}
                    onClick={() => void abrirRecibo(charge.id)}
                  >
                    <Icon name="invoice" size={16} />
                    {t('charges.receipt')}
                  </button>
                )}
                {charge.paymentInfoAvailable && (
                  <button type="button" className="modern-button-secondary" onClick={() => setPaying(charge.id)}>
                    <Icon name="copy" size={16} />
                    {t('charges.secondCopy.button')}
                  </button>
                )}
                {charge.invoiceUrl && (
                  /* `noopener` porque é endereço de terceiro, e o alvo ganharia
                     acesso a esta janela por `window.opener` sem ele. */
                  <a
                    href={charge.invoiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="modern-button"
                  >
                    {t('charges.pay')}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ChargePaymentModal chargeId={paying} onClose={fecharSegundaVia} />
    </section>
  )
}

export default TenantCharges
