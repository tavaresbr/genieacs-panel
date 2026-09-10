'use client'

import { useEffect, useState } from 'react'
import {
  SUBSCRIPTION_BLOCKED_EVENT,
  subscriptionAPI,
  type SubscriptionBlockedDetail,
  type SubscriptionGateCode
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { BrandMark } from '@/components/brand-mark'

/**
 * O que o operador vê quando a assinatura do provedor não deixa passar.
 *
 * Dois pesos, porque o backend tem dois: `past_due` e o teste vencido deixam
 * LER — então é uma faixa no alto, e a tela continua útil; `suspended`,
 * `canceled` e "sem assinatura" não deixam nada — então é um muro, com o nome
 * do plano e até quando, e uma saída.
 *
 * Ouve o evento que o cliente da API dispara em todo 402 da assinatura, em vez
 * de perguntar por conta própria a cada tela: a primeira requisição recusada
 * é a notícia. E pergunta a `/tenant/subscription` ao ser avisado, porque essa
 * rota fica fora da porta justamente para este componente ter o que mostrar.
 */
const WALL_CODES = new Set<SubscriptionGateCode>([
  'subscription_suspended', 'subscription_canceled', 'subscription_missing'
])

const MESSAGE_KEYS: Record<SubscriptionGateCode, TranslationKey> = {
  subscription_past_due: 'subscription.pastDue',
  subscription_trial_expired: 'subscription.trialExpired',
  subscription_suspended: 'subscription.suspended',
  subscription_canceled: 'subscription.canceled',
  subscription_missing: 'subscription.missing'
}

export function SubscriptionNotice() {
  const { t } = useTranslation()
  const { logout, user } = useAuth()
  const [blocked, setBlocked] = useState<SubscriptionBlockedDetail | null>(null)
  const [planName, setPlanName] = useState<string | null>(null)

  useEffect(() => {
    const onBlocked = (event: Event) => {
      const detail = (event as CustomEvent<SubscriptionBlockedDetail>).detail
      setBlocked(detail)
      if (detail.subscription?.plan?.name) {
        setPlanName(detail.subscription.plan.name)
      } else {
        void subscriptionAPI.current().then((res) => {
          if (res.success && res.data?.subscription?.plan) setPlanName(res.data.subscription.plan.name)
        })
      }
    }
    window.addEventListener(SUBSCRIPTION_BLOCKED_EVENT, onBlocked)
    return () => window.removeEventListener(SUBSCRIPTION_BLOCKED_EVENT, onBlocked)
  }, [])

  if (!blocked) return null

  const message = t(MESSAGE_KEYS[blocked.code]) || blocked.message
  const wall = WALL_CODES.has(blocked.code)

  if (!wall) {
    return (
      <div role="status" className="sticky top-0 z-40 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        <strong className="mr-2">{t('subscription.readOnlyTitle')}</strong>
        {message}
        {planName && <span className="ml-2 opacity-80">({planName})</span>}
        <button type="button" className="ml-3 underline" onClick={() => setBlocked(null)}>
          {t('common.close')}
        </button>
      </div>
    )
  }

  return (
    <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6">
      <div className="modern-card max-w-md p-6 text-center">
        <BrandMark className="mx-auto mb-4 size-10" />
        <h2 className="mb-2 text-lg font-semibold text-foreground">{t('subscription.blockedTitle')}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{message}</p>
        {planName && (
          <p className="mb-4 text-sm">
            <span className="text-muted-foreground">{t('platform.subscription.plan')}: </span>
            <span className="font-medium">{planName}</span>
          </p>
        )}
        {/* O administrador da plataforma chega ao console por aqui mesmo:
            `/api/platform/*` fica fora da porta. Para todo mundo mais, sair é
            a única ação que faz sentido num painel que não responde. */}
        <div className="flex justify-center gap-2">
          {user?.isPlatformAdmin && (
            <a href="/platform" className="modern-button-secondary">{t('platform.title')}</a>
          )}
          <button type="button" className="modern-button" onClick={logout}>{t('sidebar.signOut')}</button>
        </div>
      </div>
    </div>
  )
}
