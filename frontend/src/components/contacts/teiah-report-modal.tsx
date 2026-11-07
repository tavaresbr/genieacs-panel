import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'

type Mode = 'completo' | 'resumo'

type ReportResponse = { success: boolean; blob?: Blob; filename?: string; code?: string; message?: string }

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; filename: string }
  | { kind: 'none' }
  | { kind: 'error'; message: string }

/**
 * The TeiaH's own report of the client — the one its site shows and prints —
 * in a popup on the record. The PDF comes from the TeiaH's history through the
 * panel (the key never reaches the browser) and is never kept: it lives in an
 * object URL freed when the popup closes.
 */
export function TeiahReportModal({ load, reportKey, onClose, onConsult, consulting = false, noneText }: {
  /** Fetches the PDF of one mode: the client record's, or an address check's. */
  load: (mode: Mode) => Promise<ReportResponse>
  /** Changes when `load` points elsewhere (another client, another address). */
  reportKey: string
  onClose: () => void
  /** "Consultar na TeiaH" for a client never consulted: a paid call, the card's own. */
  onConsult?: () => Promise<void>
  consulting?: boolean
  /** What to say when the TeiaH history has no report for this one. */
  noneText?: string
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('completo')
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  const loader = useRef(load)
  useEffect(() => { loader.current = load }, [load])

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    setState({ kind: 'loading' })
    void loader.current(mode).then((res) => {
      if (cancelled) return
      if (!res.success || !res.blob) {
        if (res.code === 'teiah_report_none') setState({ kind: 'none' })
        else setState({ kind: 'error', message: res.message || t('contacts.teiahReport.failed') })
        return
      }
      url = URL.createObjectURL(new Blob([res.blob], { type: 'application/pdf' }))
      setState({ kind: 'ready', url, filename: res.filename || `teiah-${mode}.pdf` })
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [reportKey, mode, attempt, t])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const consultThenLoad = async () => {
    if (!onConsult) return
    await onConsult()
    setAttempt((value) => value + 1)
  }

  const print = () => {
    try {
      frame.current?.contentWindow?.print()
    } catch {
      if (state.kind === 'ready') window.open(state.url, '_blank', 'noopener')
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="teiah-report-title">
      <div className="modal-panel modern-card flex h-[92vh] w-full max-w-5xl flex-col p-4 sm:p-5" data-testid="teiah-report-modal">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="teiah-report-title" className="section-heading">{t('contacts.teiahReport.title')}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-border p-0.5 text-sm" role="tablist">
              {(['completo', 'resumo'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  className={`rounded px-3 py-1 ${mode === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  onClick={() => setMode(value)}
                >
                  {t(value === 'completo' ? 'contacts.teiahReport.full' : 'contacts.teiahReport.summary')}
                </button>
              ))}
            </div>
            {state.kind === 'ready' && (
              <>
                <button type="button" className="modern-button-secondary" onClick={print}>
                  {t('contacts.teiahReport.print')}
                </button>
                <a className="modern-button-secondary" href={state.url} download={state.filename}>
                  {t('contacts.teiahReport.download')}
                </a>
                <a className="modern-button-secondary" href={state.url} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" size={16} /> {t('contacts.teiahReport.openTab')}
                </a>
              </>
            )}
            <button type="button" className="modern-button-secondary" aria-label={t('common.close')} onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/30">
          {state.kind === 'loading' && (
            <p className="p-6 text-sm text-muted-foreground" role="status">{t('contacts.teiahReport.loading')}</p>
          )}
          {state.kind === 'none' && (
            <div className="p-6 text-sm">
              <p>{noneText ?? t('contacts.teiahReport.none')}</p>
              {onConsult && (
                <>
                  <button type="button" className="modern-button mt-3" disabled={consulting} onClick={() => void consultThenLoad()}>
                    <Icon name="refresh" size={16} className={consulting ? 'animate-spin' : ''} /> {t('contacts.profile.teiahConsult')}
                  </button>
                  <p className="mt-2 text-xs text-muted-foreground">{t('contacts.teiahReport.consultHint')}</p>
                </>
              )}
            </div>
          )}
          {state.kind === 'error' && (
            <p className="p-6 text-sm text-[hsl(var(--status-warning))]" role="alert">{state.message}</p>
          )}
          {state.kind === 'ready' && (
            <iframe ref={frame} title={t('contacts.teiahReport.title')} src={state.url} className="h-full w-full bg-white" />
          )}
        </div>
      </div>
    </div>
  )
}
