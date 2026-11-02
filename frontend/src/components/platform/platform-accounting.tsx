'use client'

import { useEffect, useId, useState } from 'react'
import { accountingAPI, platformAPI, type PlatformAccountingConfig } from '@/lib/api'
import {
  ACCOUNTING_FORMATS,
  ACCOUNTING_SHEETS,
  ACCOUNTING_SHEET_LABELS,
  accountingErrorKey,
  accountingExportPath,
  accountingFallbackFilename,
  isValidMonth,
  previousMonthSp,
  validateAccountingDraft,
  type AccountingFormat,
  type AccountingSheet
} from '@/lib/accounting-export'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * A exportação para a contabilidade (ver `accountingExportService` no
 * servidor): o botão da aba Receita, que baixa o mês escolhido, e a seção de
 * Configurações → Contabilidade, com o envio mensal ao contador e o "Enviar
 * agora".
 */

const FORMAT_LABELS = {
  xlsx: 'platform.accounting.formatXlsx',
  csv: 'platform.accounting.formatCsv'
} as const

/** O botão "Exportar para contabilidade" da aba Receita, com o mês e o formato. */
export function AccountingExportCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const [month, setMonth] = useState(() => previousMonthSp())
  const [format, setFormat] = useState<AccountingFormat>('xlsx')
  const [sheet, setSheet] = useState<AccountingSheet>('cobrancas')
  const [baixando, setBaixando] = useState(false)
  const monthId = useId()
  const formatId = useId()
  const sheetId = useId()
  const mesValido = isValidMonth(month)

  const baixar = async () => {
    if (!mesValido) return
    setBaixando(true)
    try {
      const res = await accountingAPI.download(accountingExportPath({ month, format, sheet }))
      if (!res.success || !res.blob) {
        toast.error(t(accountingErrorKey(res.code)))
        return
      }
      const url = URL.createObjectURL(res.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename || accountingFallbackFilename(month, format, sheet)
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } finally {
      setBaixando(false)
    }
  }

  return (
    <section className="modern-card p-4" aria-labelledby="accounting-export-title">
      <h2 id="accounting-export-title" className="section-heading mb-1">{t('platform.accounting.exportTitle')}</h2>
      <p className="field-hint mb-3">{t('platform.accounting.exportHint')}</p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void baixar()
        }}
      >
        <div>
          <label htmlFor={monthId} className="mb-1 block text-sm font-medium">{t('platform.accounting.month')}</label>
          <input
            id={monthId}
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="modern-input"
            aria-invalid={!mesValido}
          />
        </div>
        <div>
          <label htmlFor={formatId} className="mb-1 block text-sm font-medium">{t('platform.accounting.format')}</label>
          <select id={formatId} className="modern-input" value={format} onChange={(e) => setFormat(e.target.value as AccountingFormat)}>
            {ACCOUNTING_FORMATS.map((f) => <option key={f} value={f}>{t(FORMAT_LABELS[f])}</option>)}
          </select>
        </div>
        {format === 'csv' && (
          <div>
            <label htmlFor={sheetId} className="mb-1 block text-sm font-medium">{t('platform.accounting.sheet')}</label>
            <select id={sheetId} className="modern-input" value={sheet} onChange={(e) => setSheet(e.target.value as AccountingSheet)}>
              {ACCOUNTING_SHEETS.map((s) => <option key={s} value={s}>{t(ACCOUNTING_SHEET_LABELS[s])}</option>)}
            </select>
          </div>
        )}
        <button type="submit" className="modern-button-secondary" disabled={baixando || !mesValido}>
          <Icon name="document" size={17} />
          {baixando ? t('platform.accounting.downloading') : t('platform.accounting.download')}
        </button>
      </form>
      {!mesValido && <p className="mt-2 text-sm text-destructive" role="alert">{t('platform.accounting.invalidMonth')}</p>}
    </section>
  )
}

/** Configurações → Contabilidade: o envio mensal ao contador e o "Enviar agora". */
export function PlatformAccountingSettings() {
  const { t } = useTranslation()
  const toast = useToast()
  const [salvo, setSalvo] = useState<PlatformAccountingConfig | null>(null)
  const [canSave, setCanSave] = useState(false)
  const [rascunho, setRascunho] = useState<{ enabled: boolean; email: string; format: AccountingFormat }>({
    enabled: false, email: '', format: 'xlsx'
  })
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)
  const [enviando, setEnviando] = useState(false)

  useEffect(() => {
    let vivo = true
    platformAPI.getPlatformProfile().then((res) => {
      if (!vivo || !res.success || !res.data) return
      const conta = res.data.accounting ?? { enabled: false, email: null, format: 'xlsx' as const }
      setSalvo(conta)
      setCanSave(res.data.canSave)
      setRascunho({ enabled: conta.enabled, email: conta.email ?? '', format: conta.format })
    }).catch(() => {})
    return () => { vivo = false }
  }, [])

  const recusa = validateAccountingDraft(rascunho)

  const salvar = async (event: React.FormEvent) => {
    event.preventDefault()
    if (recusa) {
      setErro(t(recusa))
      return
    }
    setSalvando(true)
    setErro(null)
    try {
      const res = await platformAPI.updatePlatformProfile({
        accounting: { enabled: rascunho.enabled, email: rascunho.email.trim() || null, format: rascunho.format }
      })
      if (res.success && res.data?.accounting) {
        setSalvo(res.data.accounting)
        toast.success(t('platform.accounting.saved'))
      } else {
        setErro(t(accountingErrorKey(res.code)))
      }
    } finally {
      setSalvando(false)
    }
  }

  const enviar = async () => {
    setEnviando(true)
    try {
      const res = await accountingAPI.sendNow()
      if (res.success && res.data) toast.success(t('platform.accounting.sent', { month: res.data.month }))
      else toast.error(t(accountingErrorKey(res.code)))
    } finally {
      setEnviando(false)
    }
  }

  return (
    <form onSubmit={salvar} className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('platform.settings.accounting')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.accounting.description')}</p>
      </div>

      <section className="rounded-md border border-border p-4 sm:p-5">
        <label className="flex items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            checked={rascunho.enabled}
            disabled={!canSave}
            onChange={(e) => setRascunho((r) => ({ ...r, enabled: e.target.checked }))}
          />
          {t('platform.accounting.enabled')}
        </label>
        <p className="field-hint">{t('platform.accounting.scheduleHint')}</p>

        <label className="mt-4 block text-sm font-medium text-foreground" htmlFor="accounting-email">
          {t('platform.accounting.email')}
        </label>
        <input
          id="accounting-email"
          type="email"
          value={rascunho.email}
          disabled={!canSave}
          onChange={(e) => setRascunho((r) => ({ ...r, email: e.target.value }))}
          placeholder="contador@escritorio.com.br"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm sm:max-w-md"
          aria-invalid={recusa === 'platform.accounting.invalidEmail'}
        />

        <label className="mt-4 block text-sm font-medium text-foreground" htmlFor="accounting-format">
          {t('platform.accounting.format')}
        </label>
        <select
          id="accounting-format"
          className="modern-input mt-1 sm:max-w-md"
          value={rascunho.format}
          disabled={!canSave}
          onChange={(e) => setRascunho((r) => ({ ...r, format: e.target.value as AccountingFormat }))}
        >
          {ACCOUNTING_FORMATS.map((f) => <option key={f} value={f}>{t(FORMAT_LABELS[f])}</option>)}
        </select>

        {erro && <p className="mt-4 text-sm alert-error" role="alert">{erro}</p>}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="modern-button" disabled={salvando || !canSave}>
          {salvando ? t('common.saving') : t('common.save')}
        </button>
        <button
          type="button"
          className="modern-button-secondary"
          disabled={enviando || !salvo?.email}
          onClick={() => void enviar()}
        >
          {enviando ? t('platform.accounting.sending') : t('platform.accounting.sendNow')}
        </button>
      </div>
      <p className="field-hint">{t('platform.accounting.sendNowHint')}</p>
    </form>
  )
}

export default PlatformAccountingSettings
