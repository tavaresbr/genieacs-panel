import { useEffect, useState, type ReactNode } from 'react'
import { contactsAPI, type TeiahAddressCheck as TeiahAddressResult } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { TeiahReportModal } from '@/components/contacts/teiah-report-modal'
import { riskBadge } from '@/lib/teiah'
import { formatMoney } from '@/lib/money'
import { useTeiahLimitOverride } from '@/components/contacts/use-teiah-limit'

export interface TeiahAddressInput {
  zip: string
  street: string
  number: string
  district?: string
  complement?: string
}

export interface TeiahAddressOutcome {
  result: TeiahAddressResult
  consultedAt: string
  cached: boolean
}

/** The same address however it was typed: CEP digits, number and street, lower-cased. */
export function teiahAddressKey(address: TeiahAddressInput): string {
  return `${address.zip.replace(/\D/g, '')}|${address.number.trim().toLowerCase()}|${address.street.trim().toLowerCase()}`
}

/**
 * "Endereço na TeiaH Valid": whether an address has a debt history, from the
 * TeiaH address check (a paid call, behind the panel's 30-day memory of the
 * same CEP and number), with its report. The result belongs to the address it
 * was made for: change the CEP, street or number and it is gone.
 *
 * Used by Novo cliente, the client record's TeiaH card and the WhatsApp panel.
 */
export function TeiahAddressCheck({ address, onResult, compact = false, title, testId = 'teiah-address-check', footer }: {
  address: TeiahAddressInput
  /** The result for the current address, or null — for the risk warning. */
  onResult?: (outcome: TeiahAddressOutcome | null) => void
  compact?: boolean
  /** Replaces the box's title (the address itself, in a list of addresses). */
  title?: ReactNode
  testId?: string
  /** Something to offer next to the result (the WhatsApp panel's "send summary"). */
  footer?: (outcome: TeiahAddressOutcome) => ReactNode
}) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [check, setCheck] = useState<(TeiahAddressOutcome & { key: string }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const limit = useTeiahLimitOverride()

  const zipDigits = address.zip.replace(/\D/g, '')
  const key = teiahAddressKey(address)
  const complete = zipDigits.length === 8 && Boolean(address.street.trim()) && Boolean(address.number.trim())
  const current = check?.key === key ? check : null

  useEffect(() => {
    onResult?.(current ? { result: current.result, consultedAt: current.consultedAt, cached: current.cached } : null)
    // Only when the result for this address changes, not on every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key, current?.consultedAt])

  const run = async (fresh = false) => {
    // A paid call: asked first, unless the panel already has this address (then
    // the server answers from its 30-day memory and nothing is paid).
    if (!window.confirm(t(fresh ? 'contacts.new.teiahAddress.refreshConfirm' : 'contacts.new.teiahAddress.confirm'))) return
    setBusy(true)
    try {
      const body = {
        zip: zipDigits,
        street: address.street.trim(),
        number: address.number.trim(),
        district: address.district?.trim() ?? '',
        complement: address.complement?.trim() ?? ''
      }
      const res = await limit.retry(
        await contactsAPI.teiahAddress(body, fresh),
        (password) => contactsAPI.teiahAddress(body, fresh, password)
      )
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.new.teiahAddress.failed'))
        return
      }
      setCheck({ key, ...res.data })
      if (res.data.cached) toast.info(t('contacts.new.teiahAddress.fromCache', { date: formatDateTime(res.data.consultedAt) }))
    } catch {
      toast.error(t('contacts.new.teiahAddress.failed'))
    } finally {
      setBusy(false)
    }
  }

  const result = current?.result
  return (
    <div className={`rounded-md border border-border ${compact ? 'p-2' : 'mt-4 p-3'}`} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`${compact ? 'text-xs' : 'text-sm'} font-semibold wrap-anywhere`}>{title ?? t('contacts.new.teiahAddress.title')}</span>
        {!current && (
          <button
            type="button"
            className="modern-button-secondary"
            disabled={!complete || busy}
            onClick={() => void run()}
            data-testid={`${testId}-run`}
          >
            <Icon name="search" size={16} className={busy ? 'animate-pulse' : ''} />
            {' '}{t('contacts.new.teiahAddress.check')}
          </button>
        )}
      </div>
      {!current && !compact && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(complete ? 'contacts.new.teiahAddress.hint' : 'contacts.new.teiahAddress.needsAddress')}
        </p>
      )}
      {!current && compact && !complete && (
        <p className="mt-1 text-xs text-muted-foreground">{t('contacts.new.teiahAddress.needsAddress')}</p>
      )}
      {current && result && (
        <div className="mt-2 space-y-2 text-sm">
          {result.found ? (
            <dl className="grid gap-1 sm:grid-cols-2">
              {result.score !== null && result.score !== undefined && (
                <div className="flex flex-wrap items-center gap-x-2">
                  <dt className="text-muted-foreground">{t('contacts.new.teiahAddress.score')}:</dt>
                  <dd className="flex items-center gap-2 font-medium">
                    {result.score}
                    {result.risk && <span className={riskBadge(result.risk)}>{result.risk}</span>}
                  </dd>
                </div>
              )}
              {(result.score === null || result.score === undefined) && result.risk && (
                <div className="flex flex-wrap items-center gap-x-2">
                  <dt className="text-muted-foreground">{t('contacts.new.teiahAddress.risk')}:</dt>
                  <dd><span className={riskBadge(result.risk)}>{result.risk}</span></dd>
                </div>
              )}
              {(result.debtCount || result.debtAmount) ? (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">{t('contacts.new.teiahAddress.debts')}:</dt>
                  <dd className="font-medium">
                    {result.debtCount ?? '—'}
                    {result.debtAmount ? ` · ${formatMoney(Math.round(result.debtAmount * 100), 'BRL')}` : ''}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="text-muted-foreground">{result.message || t('contacts.new.teiahAddress.none')}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{t('contacts.new.teiahAddress.consultedAt', { date: formatDateTime(current.consultedAt) })}</span>
            <button type="button" className="font-semibold text-primary hover:underline" onClick={() => setReportOpen(true)}>
              {t('contacts.new.teiahAddress.report')}
            </button>
            <button type="button" className="font-semibold text-primary hover:underline" disabled={busy} onClick={() => void run(true)}>
              {t('contacts.new.teiahAddress.refresh')}
            </button>
            {footer?.(current)}
          </div>
        </div>
      )}
      {limit.element}
      {reportOpen && (
        <TeiahReportModal
          reportKey={key}
          load={(mode) => contactsAPI.teiahAddressReport(zipDigits, address.number.trim(), mode)}
          onClose={() => setReportOpen(false)}
          noneText={t('contacts.new.teiahAddress.reportNone')}
        />
      )}
    </div>
  )
}
