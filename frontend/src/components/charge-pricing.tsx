'use client'

import type { ChargePricing } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { formatDay } from '@/lib/subscription-console'
import { resourceLabelKey } from '@/lib/plan-options'

/**
 * A conta do valor de uma cobrança (0105): o plano (já com o cupom) e cada
 * parcela do excedente — "Excedente (Operadores): 3 × R$ 10,00 = R$ 30,00".
 *
 * Só aparece quando há excedente (ou add-on, 0125): a cobrança que é só o plano não precisa de
 * conta, o valor dela já diz tudo. A mesma linha no extrato do provedor e no
 * histórico do console, para os dois lerem a fatura do mesmo jeito.
 */
export function ChargePricingBreakdown({
  pricing, currency, className = 'text-xs text-muted-foreground'
}: { pricing?: ChargePricing | null; currency: string; className?: string }) {
  const { t } = useTranslation()
  // E os add-ons (0125), que também somam ao plano.
  const adicionais = pricing?.addons ?? []
  if (!pricing || (!pricing.overage?.length && !adicionais.length)) return null
  return (
    <div className={className}>
      {pricing.baseCents !== null && pricing.baseCents > 0 && (
        <p>{t('charges.pricing.base', { amount: formatMoney(pricing.baseCents, currency) })}</p>
      )}
      {pricing.overage.map((item) => {
        const vars = {
          resource: t(resourceLabelKey(item.resource)),
          units: item.units,
          unit: formatMoney(item.unitCents, currency),
          total: formatMoney(item.cents, currency),
          date: item.periodKey ? formatDay(item.periodKey) : ''
        }
        return (
          <p key={`${item.resource}-${item.periodKey ?? ''}-${item.kind ?? ''}`}>
            {t(item.kind === 'true_up' ? 'charges.pricing.trueUp' : 'charges.pricing.overage', vars)}
          </p>
        )
      })}
      {adicionais.map((item) => (
        <p key={`addon-${item.code}`}>
          {t(item.proration ? 'charges.pricing.addonProration' : 'charges.pricing.addon', {
            name: item.name ?? item.code, total: formatMoney(item.cents, currency)
          })}
        </p>
      ))}
    </div>
  )
}

export default ChargePricingBreakdown
