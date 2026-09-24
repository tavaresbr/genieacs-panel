import { useState } from 'react'
import {
  devicesAPI,
  type DeviceBatchAction,
  type DeviceBatchResponse,
  type DeviceBatchResult,
  type DeviceFirmwareCatalog
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { BATCH_LIMIT, type Selection } from '@/lib/device-batch'

const REASON_KEY: Record<NonNullable<DeviceBatchResult['reason']>, TranslationKey> = {
  not_found: 'devices.batch.reason.notFound',
  acs_error: 'devices.batch.reason.acsError',
  refused: 'devices.batch.reason.refused',
  firmware_not_compatible: 'devices.batch.reason.firmwareNotCompatible',
  firmware_already_installed: 'devices.batch.reason.firmwareAlreadyInstalled'
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
  // Qual ação está sendo confirmada, ou nenhuma.
  const [confirmando, setConfirmando] = useState<DeviceBatchAction | null>(null)
  // Firmware: a lista do GenieACS, carregada ao abrir, e o arquivo escolhido.
  const [catalogo, setCatalogo] = useState<DeviceFirmwareCatalog | null>(null)
  const [catalogoErro, setCatalogoErro] = useState(false)
  const [fileId, setFileId] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState<DeviceBatchResponse | null>(null)
  // Os rótulos de quando o lote saiu: a seleção é limpa ao mandar, e o
  // resultado ainda precisa dizer a série de cada aparelho.
  const [rotulos, setRotulos] = useState<Map<string, string>>(new Map())

  if (selection.size === 0 && !resultado) return null

  const abrirFirmware = async () => {
    setConfirmando('firmware')
    setCatalogo(null)
    setCatalogoErro(false)
    setFileId(null)
    try {
      const res = await devicesAPI.listFirmwareCatalog()
      if (res.success && res.data) {
        setCatalogo(res.data)
        setFileId(res.data.files[0]?.id ?? null)
      } else {
        setCatalogoErro(true)
      }
    } catch {
      setCatalogoErro(true)
    }
  }

  const enviar = async () => {
    if (!confirmando || (confirmando === 'firmware' && !fileId)) return
    setEnviando(true)
    try {
      const res = await devicesAPI.runBatch(confirmando, [...selection.keys()], filter, confirmando === 'firmware' ? fileId ?? undefined : undefined)
      if (res.success && res.data) {
        setConfirmando(null)
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
            <button type="button" className="modern-button-secondary" onClick={() => void abrirFirmware()}>
              <Icon name="box" size={16} />
              {t('devices.batch.firmware')}
            </button>
            <button type="button" className="modern-button" onClick={() => setConfirmando('reboot')}>
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
                {confirmando === 'firmware'
                  ? t('devices.batch.firmwareTitle', { count: String(selection.size) })
                  : t('devices.batch.confirmTitle', { count: String(selection.size) })}
              </h3>
            </div>
            <div className="max-h-[60vh] space-y-3 overflow-auto p-5 text-sm leading-6">
              {confirmando === 'firmware' && (
                <>
                  {!catalogo && !catalogoErro && <p className="text-muted-foreground">{t('devices.batch.firmwareLoading')}</p>}
                  {catalogoErro && <p className="text-[hsl(var(--status-danger))]">{t('devices.batch.firmwareLoadFailed')}</p>}
                  {catalogo && catalogo.files.length === 0 && <p className="text-muted-foreground">{t('devices.batch.firmwareNone')}</p>}
                  {catalogo && catalogo.files.length > 0 && (
                    <div role="radiogroup" aria-label={t('devices.batch.firmware')} className="space-y-2">
                      {catalogo.files.map((file) => (
                        <label
                          key={file.id}
                          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${fileId === file.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}
                        >
                          <input type="radio" name="batch-firmware" className="mt-1" checked={fileId === file.id} onChange={() => setFileId(file.id)} />
                          <span className="min-w-0">
                            <span className="block font-medium text-foreground">{file.version || file.id}</span>
                            <span className="block text-xs text-muted-foreground">{t('devices.batch.firmwareModel', { model: file.productClass || '—' })}</span>
                            <span className="block truncate font-mono text-xs text-muted-foreground">{file.id}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  {catalogo && catalogo.unclassified > 0 && (
                    <p className="field-hint">{t('devices.batch.firmwareUnclassified', { count: String(catalogo.unclassified) })}</p>
                  )}
                  <p className="text-foreground">{t('devices.batch.firmwareConsequence')}</p>
                </>
              )}
              {confirmando === 'reboot' && <p className="text-foreground">{t('devices.batch.consequence')}</p>}
              <p className="max-h-32 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
                {[...selection.values()].join(' · ')}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-border p-5">
              <button type="button" className="modern-button-secondary" onClick={() => setConfirmando(null)} disabled={enviando}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="modern-button"
                disabled={enviando || (confirmando === 'firmware' && !fileId)}
                onClick={() => void enviar()}
              >
                <Icon name={confirmando === 'firmware' ? 'box' : 'power'} size={16} />
                {enviando
                  ? t('devices.batch.sending')
                  : confirmando === 'firmware'
                    ? t('devices.batch.firmwareConfirm', { count: String(selection.size) })
                    : t('devices.batch.confirm', { count: String(selection.size) })}
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
