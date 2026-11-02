'use client'

import { useCallback, useEffect, useState } from 'react'
import { addonsAPI, type TenantAddonOption, type TenantAddons } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { displayDate } from '@/lib/date-format'
import {
  ADDON_REFUSAL_KEYS, ADDON_STATE_KEYS, addonAction, addonState, addonStateBadge
} from '@/lib/addons'

/**
 * Os add-ons pagos na tela de Plano (0126): um cartão por add-on, com o
 * preço do ciclo de agora, o estado e o botão — ativar (com a prévia do que
 * sai na hora), cancelar na renovação, ou reativar antes dela. A regra é do
 * servidor; a confirmação só diz, antes do clique, o que ele vai cobrar.
 *
 * Sem nada no catálogo, o bloco não aparece.
 */
export function AddonsCard({ canWrite, onChanged }: { canWrite: boolean; onChanged?: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [dados, setDados] = useState<TenantAddons | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [mexendo, setMexendo] = useState<string | null>(null)

  const carregar = useCallback(async () => {
    const res = await addonsAPI.list()
    if (res.success && res.data) {
      setDados(res.data)
      setErro(null)
    } else {
      setErro(res.message || t('addons.loadFailed'))
    }
  }, [t])

  useEffect(() => {
    void carregar()
  }, [carregar])

  if (erro) {
    return (
      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('addons.title')}</h2>
        <p className="mt-3 text-sm text-destructive">{erro}</p>
      </section>
    )
  }
  if (!dados || !dados.addons.length) return null

  const anual = dados.billingCycle === 'annual'

  const confirmacao = (addon: TenantAddonOption, acao: 'activate' | 'reactivate' | 'cancel') => {
    const preco = formatMoney(addon.cycleCents, addon.currency)
    if (acao === 'cancel') {
      const fim = addon.subscription?.cancelAt ?? null
      return fim
        ? t('addons.confirm.cancel', { name: addon.name, date: displayDate(fim) ?? '' })
        : t('addons.confirm.cancelAtRenewal', { name: addon.name })
    }
    if (acao === 'reactivate') return t('addons.confirm.reactivate', { name: addon.name })
    const recorrente = t(anual ? 'addons.confirm.recurringYear' : 'addons.confirm.recurringMonth', { amount: preco })
    if (addon.proration && addon.proration.amountCents > 0) {
      return `${t('addons.confirm.activateNow', {
        name: addon.name,
        amount: formatMoney(addon.proration.amountCents, addon.currency),
        days: addon.proration.remainingDays
      })} ${recorrente}`
    }
    return `${t('addons.confirm.activate', { name: addon.name })} ${recorrente}`
  }

  const agir = async (addon: TenantAddonOption, acao: 'activate' | 'reactivate' | 'cancel') => {
    if (!window.confirm(confirmacao(addon, acao))) return
    setMexendo(addon.code)
    try {
      const res = acao === 'cancel' ? await addonsAPI.cancel(addon.code) : await addonsAPI.activate(addon.code)
      if (res.success && res.data) {
        setDados(res.data)
        toast.success(res.message || t('addons.saved'))
        const fatura = res.data.result.proration?.charge
        if (fatura?.invoiceUrl) window.open(fatura.invoiceUrl, '_blank', 'noopener,noreferrer')
        onChanged?.()
      } else {
        const chave = res.code ? ADDON_REFUSAL_KEYS[res.code] : undefined
        toast.error(chave ? t(chave) : (res.message || t('addons.saveFailed')))
      }
    } finally {
      setMexendo(null)
    }
  }

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-heading">{t('addons.title')}</h2>
        <button type="button" className="modern-button-secondary" onClick={() => void carregar()}>
          <Icon name="refresh" size={17} />
          {t('common.refresh')}
        </button>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('addons.subtitle')}</p>
      <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {dados.addons.map((addon) => {
          const estado = addonState(addon)
          const acao = addonAction(estado)
          return (
            <li key={addon.code} className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{addon.name}</p>
                  {addon.description && <p className="mt-1 text-sm text-muted-foreground">{addon.description}</p>}
                </div>
                <span className={addonStateBadge(estado)}>{t(ADDON_STATE_KEYS[estado])}</span>
              </div>
              <p className="text-sm text-foreground">
                <span className="font-mono tabular-nums">{formatMoney(addon.cycleCents, addon.currency)}</span>
                <span className="text-muted-foreground"> {t(anual ? 'addons.perYear' : 'addons.perMonth')}</span>
              </p>
              {estado === 'cancelScheduled' && addon.subscription?.cancelAt && (
                <p className="text-xs text-muted-foreground">
                  {t('addons.cancelsOn', { date: displayDate(addon.subscription.cancelAt) ?? '' })}
                </p>
              )}
              {estado === 'available' && addon.proration && addon.proration.amountCents > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('addons.prorationPreview', {
                    amount: formatMoney(addon.proration.amountCents, addon.currency),
                    days: addon.proration.remainingDays
                  })}
                </p>
              )}
              {canWrite && acao && (
                <div className="mt-auto pt-1">
                  <button
                    type="button"
                    className={acao === 'cancel' ? 'modern-button-secondary' : 'modern-button'}
                    disabled={mexendo !== null}
                    onClick={() => void agir(addon, acao)}
                  >
                    {mexendo === addon.code ? t('common.saving') : t(`addons.action.${acao}`)}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">{t('addons.footnote')}</p>
    </section>
  )
}
