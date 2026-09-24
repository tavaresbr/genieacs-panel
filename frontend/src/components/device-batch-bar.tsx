import { useState } from 'react'
import { devicesAPI, type DeviceBatchResponse, type DeviceBatchResult } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { BATCH_LIMIT, type Selection } from '@/lib/device-batch'

const REASON_KEY: Record<NonNullable<DeviceBatchResult['reason']>, TranslationKey> = {
  not_found: 'devices.batch.reason.notFound',
  acs_error: 'devices.batch.reason.acsError',
  refused: 'devices.batch.reason.refused'
}

interface DeviceBatchBarProps {
  selection: Selection
  /** O recorte da lista, para a trilha dizer qual foi. */
  filter: Record<string, string>
  /** Quantos aparelhos o filtro tem, e se a tela pode oferecer marcar todos. */
  filterTotal: number
  canSelectAll: boolean
  selectingAll: boolean
  onSelectAll: () => void
  onClear: () => void
}

/**
 * A barra que aparece quando há aparelhos marcados: a contagem, as ações, a
 * confirmação com o total antes de mandar, e o resultado de cada aparelho.
 */
export function DeviceBatchBar({
  selection, filter, filterTotal, canSelectAll, selectingAll, onSelectAll, onClear
}: DeviceBatchBarProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [confirmando, setConfirmando] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState<DeviceBatchResponse | null>(null)
  // Os rótulos de quando o lote saiu: a seleção é limpa ao mandar, e o
  // resultado ainda precisa dizer a série de cada aparelho.
  const [rotulos, setRotulos] = useState<Map<string, string>>(new Map())

  if (selection.size === 0 && !resultado) return null

  const enviar = async () => {
    setEnviando(true)
    try {
      const res = await devicesAPI.runBatch('reboot', [...selection.keys()], filter)
      if (res.success && res.data) {
        setConfirmando(false)
        setRotulos(new Map(selection))
        setResultado(res.data)
        onClear()
      } else {
        toast.error(res.message || t('devices.batch.failed'))
      }
    } catch {
      toast.error(t('devices.batch.failed'))
    } finally {
      setEnviando(false)
    }
  }

  const rotulo = (deviceId: string) => rotulos.get(deviceId) || deviceId

  return (
    <>
      {selection.size > 0 && (
        <div className="sticky top-[4.5rem] z-20 mb-3 flex lg:top-2 flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-card px-4 py-3 shadow-sm" role="region" aria-label={t('devices.batch.aria')}>
          <span className="text-sm font-semibold text-foreground">
            {t('devices.batch.selected', { count: String(selection.size) })}
          </span>
          {selection.size >= BATCH_LIMIT && (
            <span className="text-xs text-[hsl(var(--status-warning))]">{t('devices.batch.limitReached', { limit: String(BATCH_LIMIT) })}</span>
          )}
          {canSelectAll && (
            <button type="button" className="text-sm font-semibold text-primary hover:underline disabled:opacity-60" disabled={selectingAll} onClick={onSelectAll}>
              {selectingAll ? t('devices.batch.selectingAll') : t('devices.batch.selectAll', { count: String(filterTotal) })}
            </button>
          )}
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <button type="button" className="modern-button-secondary" onClick={onClear}>
              {t('devices.batch.clear')}
            </button>
            <button type="button" className="modern-button" onClick={() => setConfirmando(true)}>
              <Icon name="power" size={16} />
              {t('devices.batch.reboot')}
            </button>
          </div>
        </div>
      )}

      {confirmando && (
        <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="batch-confirm-title">
          <div className="modern-card w-full max-w-md">
            <div className="flex items-center gap-2 border-b border-border p-5">
              <Icon name="warning" size={20} className="shrink-0 text-[hsl(var(--status-warning))]" />
              <h3 id="batch-confirm-title" className="text-lg font-semibold text-foreground">
                {t('devices.batch.confirmTitle', { count: String(selection.size) })}
              </h3>
            </div>
            <div className="space-y-3 p-5 text-sm leading-6">
              <p className="text-foreground">{t('devices.batch.consequence')}</p>
              <p className="max-h-32 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
                {[...selection.values()].join(' · ')}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-border p-5">
              <button type="button" className="modern-button-secondary" onClick={() => setConfirmando(false)} disabled={enviando}>
                {t('common.cancel')}
              </button>
              <button type="button" className="modern-button" disabled={enviando} onClick={() => void enviar()}>
                <Icon name="power" size={16} />
                {enviando ? t('devices.batch.sending') : t('devices.batch.confirm', { count: String(selection.size) })}
              </button>
            </div>
          </div>
        </div>
      )}

      {resultado && (
        <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="batch-result-title">
          <div className="modern-card flex max-h-[85vh] w-full max-w-lg flex-col">
            <div className="border-b border-border p-5">
              <h3 id="batch-result-title" className="text-lg font-semibold text-foreground">{t('devices.batch.resultTitle')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('devices.batch.summary', {
                  sent: String(resultado.summary.sent),
                  queued: String(resultado.summary.queued),
                  failed: String(resultado.summary.failed)
                })}
              </p>
            </div>
            <ul className="flex-1 divide-y divide-border overflow-auto px-5 text-sm">
              {resultado.results.map((item) => (
                <li key={item.deviceId} className="flex items-center justify-between gap-3 py-2">
                  <span className="truncate font-mono text-xs">{rotulo(item.deviceId)}</span>
                  {item.outcome === 'sent' && <span className="modern-badge-success shrink-0">{t('devices.batch.outcome.sent')}</span>}
                  {item.outcome === 'queued' && <span className="modern-badge-warning shrink-0">{t('devices.batch.outcome.queued')}</span>}
                  {item.outcome === 'failed' && (
                    <span className="modern-badge-error shrink-0">{item.reason ? t(REASON_KEY[item.reason]) : t('devices.batch.outcome.failed')}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex justify-end border-t border-border p-5">
              <button type="button" className="modern-button" onClick={() => setResultado(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
