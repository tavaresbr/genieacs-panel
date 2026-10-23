import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { subscriptionAPI, type TenantChargePaymentInfo } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { displayDate, displayDateTime } from '@/lib/date-format'
import { safeInvoiceUrl } from '@/lib/invoice'
import { copyToClipboard } from '@/lib/utils'

/**
 * A "segunda via" de uma cobrança em aberto: a página do gateway, a linha
 * digitável do boleto e o QR do Pix, lidos do gateway quando a janela abre.
 *
 * Lidos na hora, e não da lista, porque o boleto vencido e o Pix expirado são
 * exatamente o caso: o que estava gravado pode não valer mais, e o que vale é
 * o que o gateway diz agora. O QR vem como PNG em base64 (o servidor confere
 * que é só isso), então vira um `data:` e nada mais.
 */
export function ChargePaymentModal({ chargeId, onClose }: { chargeId: number | null; onClose: () => void }) {
  const { t } = useTranslation()
  const titleId = useId()
  const fechar = useRef<HTMLButtonElement | null>(null)
  const [info, setInfo] = useState<TenantChargePaymentInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const open = chargeId !== null

  const load = useCallback(async (id: number) => {
    setLoading(true)
    setError(null)
    setInfo(null)
    const res = await subscriptionAPI.chargePaymentInfo(id)
    if (res.success && res.data) setInfo(res.data.paymentInfo)
    else setError(res.message || t('charges.secondCopy.failed'))
    setLoading(false)
  }, [t])

  useEffect(() => {
    if (chargeId !== null) void load(chargeId)
  }, [chargeId, load])

  useEffect(() => {
    if (!open) return
    const overflowAntes = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    fechar.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflowAntes
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const copiar = async (qual: string, texto: string) => {
    if (await copyToClipboard(texto)) {
      setCopied(qual)
      window.setTimeout(() => setCopied((atual) => (atual === qual ? null : atual)), 2000)
    }
  }

  if (!open) return null
  const pagina = safeInvoiceUrl(info?.invoiceUrl)
  const pdfDoBoleto = safeInvoiceUrl(info?.boleto?.bankSlipUrl)

  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label={t('common.close')} tabIndex={-1} />
      <section className="modern-card relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden sm:max-h-[calc(100dvh-2rem)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-foreground">{t('charges.secondCopy.title')}</h2>
            {info && (
              <p className="text-sm text-muted-foreground">
                {formatMoney(info.amountCents, info.currency)}
                {info.dueDate && ` · ${t('charges.dueDate')}: ${displayDate(info.dueDate) ?? info.dueDate}`}
              </p>
            )}
          </div>
          <button
            ref={fechar}
            type="button"
            onClick={onClose}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('common.close')}
          >
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="space-y-5 overflow-y-auto p-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : error !== null ? (
            <div className="space-y-3">
              <p className="text-sm text-destructive">{error}</p>
              <button type="button" className="modern-button-secondary" onClick={() => chargeId !== null && void load(chargeId)}>
                <Icon name="refresh" size={17} />
                {t('common.refresh')}
              </button>
            </div>
          ) : info ? (
            <>
              {info.pix && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">{t('charges.method.pix')}</h3>
                  {info.pix.encodedImage && (
                    <img
                      src={`data:image/png;base64,${info.pix.encodedImage}`}
                      alt={t('charges.secondCopy.pixQrAlt')}
                      className="mx-auto size-48 rounded-md border border-border bg-white p-2"
                    />
                  )}
                  <div className="flex items-stretch gap-2">
                    <input
                      readOnly
                      value={info.pix.payload}
                      aria-label={t('charges.secondCopy.pixCode')}
                      className="modern-input min-w-0 flex-1 font-mono text-xs"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button type="button" className="modern-button-secondary shrink-0" onClick={() => void copiar('pix', info.pix!.payload)}>
                      <Icon name={copied === 'pix' ? 'check' : 'copy'} size={16} />
                      {copied === 'pix' ? t('common.copied') : t('charges.secondCopy.copyPix')}
                    </button>
                  </div>
                  {info.pix.expirationDate && (
                    <p className="text-xs text-muted-foreground">
                      {t('charges.secondCopy.pixExpires', { date: displayDateTime(info.pix.expirationDate) ?? info.pix.expirationDate })}
                    </p>
                  )}
                </div>
              )}
              {info.boleto && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">{t('charges.method.boleto')}</h3>
                  <div className="flex items-stretch gap-2">
                    <input
                      readOnly
                      value={info.boleto.identificationField}
                      aria-label={t('charges.secondCopy.boletoLine')}
                      className="modern-input min-w-0 flex-1 font-mono text-xs"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      className="modern-button-secondary shrink-0"
                      onClick={() => void copiar('boleto', info.boleto!.identificationField)}
                    >
                      <Icon name={copied === 'boleto' ? 'check' : 'copy'} size={16} />
                      {copied === 'boleto' ? t('common.copied') : t('charges.secondCopy.copyBoleto')}
                    </button>
                  </div>
                  {pdfDoBoleto && (
                    <a href={pdfDoBoleto} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary hover:underline">
                      {t('charges.secondCopy.boletoPdf')}
                    </a>
                  )}
                </div>
              )}
              {!info.pix && !info.boleto && (
                <p className="text-sm text-muted-foreground">{t('charges.secondCopy.onlyPage')}</p>
              )}
              {pagina && (
                <a href={pagina} target="_blank" rel="noopener noreferrer" className="modern-button w-full justify-center">
                  <Icon name="external" size={16} />
                  {t('charges.secondCopy.openPage')}
                </a>
              )}
            </>
          ) : null}
        </div>
      </section>
    </div>,
    document.body
  )
}

export default ChargePaymentModal
