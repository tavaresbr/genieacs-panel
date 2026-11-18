'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { devicesAPI, type AcsHealth } from '@/lib/api'
import { ACS_HEALTH_POLL_MS, acsDownSignature, acsReasonKey, shouldShowAcsBanner } from '@/lib/acs-health'
import { useVisibleInterval } from '@/lib/visible-interval'
import { ACS_DOWN_DISMISSED_KEY } from '@/lib/session-owner'

/** Onde o administrador vê o endereço do GenieACS e testa a conexão. */
export const ACS_SETTINGS_HREF = '/settings?tab=general'

function readDismissed(): string {
  try {
    return window.sessionStorage.getItem(ACS_DOWN_DISMISSED_KEY) || ''
  } catch {
    return ''
  }
}

interface ViewProps {
  reason: string
  consequence: string
  dismissLabel: string
  settingsLabel: string
  /** Só para quem pode mexer nas configurações; sem ele, só o texto. */
  settingsHref?: string | null
  onDismiss?: () => void
}

/**
 * A faixa em si, sem estado: o teste a desenha sem DOM, e quem decide se ela
 * aparece é `shouldShowAcsBanner`.
 */
export function AcsHealthBannerView({ reason, consequence, dismissLabel, settingsLabel, settingsHref, onDismiss }: ViewProps) {
  return (
    <div
      role="alert"
      data-testid="acs-health-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/40 bg-background bg-linear-to-r from-destructive/15 to-destructive/10 px-4 py-2 text-xs text-destructive wrap-anywhere sm:text-sm"
    >
      <Icon name="warning" size={17} className="shrink-0" />
      <span className="font-semibold">{reason}</span>
      <span className="text-destructive/90">{consequence}</span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {settingsHref && (
          <Link to={settingsHref} className="inline-flex min-h-8 items-center font-semibold underline lg:min-h-0">
            {settingsLabel}
          </Link>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-destructive/10 lg:h-6 lg:w-6"
          aria-label={dismissLabel}
          title={dismissLabel}
        >
          <Icon name="x" size={14} />
        </button>
      </span>
    </div>
  )
}

/**
 * "O GenieACS não está acessível", em todas as telas do painel.
 *
 * Sem isto o operador do provedor via só "falha ao carregar" na lista de
 * equipamentos, e a causa — o DNS do ACS que não resolve, a porta fechada, a
 * credencial recusada — estava no journal do servidor, onde só a plataforma
 * olha. A saúde vem de `GET /devices/acs-health`, lida da memória do servidor
 * (não pergunta nada ao ACS), a cada minuto e só com a aba à vista.
 *
 * Só aparece depois de um minuto fora: um pedido que falhou numa oscilação não
 * vale uma faixa vermelha. Fechar esconde ESTA queda nesta aba; outra queda
 * (outro motivo, ou o ACS que voltou e caiu de novo) volta a aparecer. E some
 * sozinha quando o ACS volta a responder.
 */
export function AcsHealthBanner() {
  const { can } = useAuth()
  const { t } = useTranslation()
  const [health, setHealth] = useState<AcsHealth | null>(null)
  const [dismissed, setDismissed] = useState(readDismissed)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await devicesAPI.getAcsHealth()
      // Uma leitura que falhou não diz que caiu nem que voltou: fica o que se sabia.
      if (res.success && res.data) setHealth(res.data)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useVisibleInterval(() => { void load() }, ACS_HEALTH_POLL_MS)

  if (!shouldShowAcsBanner(health, dismissed)) return null

  const signature = acsDownSignature(health)
  const dismiss = () => {
    setDismissed(signature)
    try {
      window.sessionStorage.setItem(ACS_DOWN_DISMISSED_KEY, signature)
    } catch {
      // Sem armazenamento, a faixa só volta na próxima tela; nada a fazer.
    }
  }

  return (
    <AcsHealthBannerView
      reason={t(acsReasonKey(health?.code))}
      consequence={t('acsHealth.consequence')}
      dismissLabel={t('acsHealth.dismiss')}
      settingsLabel={t('acsHealth.openSettings')}
      settingsHref={can('settings.write') ? ACS_SETTINGS_HREF : null}
      onDismiss={dismiss}
    />
  )
}

export default AcsHealthBanner
