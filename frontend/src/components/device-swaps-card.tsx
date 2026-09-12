import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { devicesAPI, type DeviceSwap } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

const LINK_ACTION_KEY: Record<DeviceSwap['linkAction'], TranslationKey> = {
  moved: 'swaps.link.moved',
  cleared: 'swaps.link.cleared',
  none: 'swaps.link.none',
  held: 'swaps.link.held'
}

interface DeviceSwapsCardProps {
  /**
   * Scopes the card to one ONT's own record. Left out, it lists what the
   * operator has not acknowledged across the whole fleet — which is the form
   * the dashboard uses, and the only form with an acknowledge button: an
   * already-acknowledged swap still belongs on its device's page.
   */
  deviceId?: string
}

export function DeviceSwapsCard({ deviceId }: DeviceSwapsCardProps) {
  const { t, formatDateTime } = useTranslation()
  const [swaps, setSwaps] = useState<DeviceSwap[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = deviceId
        ? await devicesAPI.getDeviceSwaps(deviceId)
        : await devicesAPI.getSwaps()
      setSwaps(res.success && res.data ? res.data.swaps : [])
    } catch {
      // A swap list that cannot be read is not worth an error banner of its own:
      // nothing else on the page depends on it, and the record is not lost.
      setSwaps([])
    } finally {
      setLoading(false)
    }
  }, [deviceId])

  useEffect(() => {
    void load()
  }, [load])

  const acknowledge = async (id: number) => {
    setBusyId(id)
    try {
      const res = await devicesAPI.acknowledgeSwap(id)
      if (res.success) setSwaps((current) => current.filter((swap) => swap.id !== id))
    } finally {
      setBusyId(null)
    }
  }

  // Nothing to say is said by saying nothing: an empty card on every dashboard
  // trains the operator to skip the place the real warning will appear.
  if (loading || swaps.length === 0) return null

  return (
    <section className="modern-card mb-5 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <Icon name="refresh" className="mt-0.5 text-primary" />
          <div>
            <h2 className="section-heading">{t('swaps.title')}</h2>
            <p className="section-description">
              {t(deviceId ? 'swaps.deviceDescription' : 'swaps.description')}
            </p>
          </div>
        </div>
      </div>

      <ul className="divide-y divide-border">
        {swaps.map((swap) => (
          <li key={swap.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                <Link
                  to={`/devices/${encodeURIComponent(swap.previousDeviceId)}`}
                  className="max-w-full truncate font-mono text-xs hover:text-primary"
                >
                  {swap.previousDeviceId}
                </Link>
                <Icon name="chevron-right" size={14} className="text-muted-foreground" />
                <Link
                  to={`/devices/${encodeURIComponent(swap.deviceId)}`}
                  className="max-w-full truncate font-mono text-xs hover:text-primary"
                >
                  {swap.deviceId}
                </Link>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {[
                  swap.customerId,
                  swap.pppoeUsername,
                  swap.contract ? t('swaps.contract', { contract: swap.contract }) : null,
                  swap.occurredAt ? formatDateTime(swap.occurredAt) : null
                ].filter(Boolean).join(' · ')}
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                  {t(LINK_ACTION_KEY[swap.linkAction])}
                </span>
                {swap.flapping && (
                  <span className="rounded-full border border-[hsl(var(--status-warning))]/50 bg-[hsl(var(--status-warning))]/10 px-2 py-0.5 text-[hsl(var(--status-warning))]">
                    {t('swaps.flapping', { count: swap.repeatCount })}
                  </span>
                )}
                {/* Na página do aparelho o botão de dispensar não aparece, e
                    sem isto uma troca já dispensada era idêntica a uma aberta:
                    nada na tela dizia que alguém já tinha olhado aquilo. O nome
                    pode faltar — operador que saiu da equipe —, e aí a etiqueta
                    diz só que foi dispensada, que continua sendo a informação. */}
                {swap.acknowledgedAt && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                    {swap.acknowledgedBy
                      ? t('swaps.acknowledgedBy', {
                        user: swap.acknowledgedBy,
                        when: formatDateTime(swap.acknowledgedAt)
                      })
                      : t('swaps.acknowledgedAt', { when: formatDateTime(swap.acknowledgedAt) })}
                  </span>
                )}
              </p>
            </div>

            {!deviceId && (
              <button
                type="button"
                className="modern-button-secondary"
                disabled={busyId === swap.id}
                onClick={() => void acknowledge(swap.id)}
              >
                <Icon name="check" size={16} />
                {t('swaps.acknowledge')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export default DeviceSwapsCard
