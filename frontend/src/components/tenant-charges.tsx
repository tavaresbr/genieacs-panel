'use client'

import { useCallback, useEffect, useState } from 'react'
import { subscriptionAPI, type TenantChargeView } from '@/lib/api'
import { formatMoney } from '@/lib/money'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

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
  failed: 'charges.status.failed'
}

function badgeClass(status: TenantChargeView['status']) {
  if (status === 'paid') return 'modern-badge-success'
  if (status === 'pending') return 'modern-badge-warning'
  return 'modern-badge-danger'
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString()
}

/**
 * A cobrança que ainda se paga, se houver — a mais recente delas.
 *
 * Exportada porque o muro do 402 faz a mesma pergunta: lá a resposta vira um
 * botão, aqui vira uma linha da tabela, e as duas telas não podem discordar
 * sobre qual boleto está em aberto.
 */
export function cobrancaEmAberto(charges: TenantChargeView[]) {
  return charges.find((c) => c.invoiceUrl && (c.status === 'pending' || c.status === 'failed')) ?? null
}

export function TenantCharges() {
  const { t } = useTranslation()
  const [charges, setCharges] = useState<TenantChargeView[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await subscriptionAPI.charges()
    if (res.success && res.data) {
      setCharges(res.data.charges)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-heading">{t('charges.title')}</h2>
        <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
          <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
          {t('common.refresh')}
        </button>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : error !== null ? (
        <p className="mt-3 text-sm text-destructive">{error || t('charges.loadFailed')}</p>
      ) : !charges?.length ? (
        /* Sem cobrança não é erro: é o provedor em teste, o de plano grátis e o
           que ainda não chegou na primeira emissão. */
        <p className="mt-3 text-sm text-muted-foreground">{t('charges.empty')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {charges.map((charge) => (
            <li key={charge.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {formatMoney(charge.amountCents, charge.currency)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('charges.period')}: {formatDate(charge.periodEnd) ?? charge.periodEnd}
                  {formatDate(charge.dueDate) && ` · ${t('charges.dueDate')}: ${formatDate(charge.dueDate)}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={badgeClass(charge.status)}>{t(STATUS_KEYS[charge.status])}</span>
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
    </section>
  )
}

export default TenantCharges
