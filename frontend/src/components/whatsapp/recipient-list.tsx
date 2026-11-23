'use client'

import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { MAX_RECIPIENTS, addRecipient, formatPhone, removeRecipient, type RecipientError } from '@/lib/alert-recipients'
import { canTestItem, type TestRowState } from '@/lib/alert-channels'

const ERROR_KEY: Record<RecipientError, TranslationKey> = {
  empty: 'whatsapp.alerts.rcptErrEmpty',
  short: 'whatsapp.alerts.rcptErrShort',
  long: 'whatsapp.alerts.rcptErrLong',
  invalid: 'whatsapp.alerts.rcptErrEmail',
  duplicate: 'whatsapp.alerts.rcptErrDuplicate',
  max: 'whatsapp.alerts.rcptErrMax'
}

/**
 * Quem recebe os alertas, um de cada vez: campo + "Adicionar" (ou Enter) e a
 * lista com "Remover". Vale para os números de plantão e para os e-mails. Colar
 * vários de uma vez (separados por vírgula, ponto e vírgula ou linha) também
 * funciona, para quem já tinha a lista antiga. A lista continua sendo um
 * `string[]`, salvo pelo botão "Salvar" da página como sempre foi.
 */
export function RecipientList({ kind, items, onChange, label, hintId, placeholder, saved, onTest, children }: {
  kind: 'phone' | 'email'
  items: string[]
  onChange: (next: string[]) => void
  label: string
  hintId: string
  placeholder: string
  /** Os itens já SALVOS no servidor: só eles podem ser testados. */
  saved?: string[]
  /** "Testar" de uma linha: manda a mensagem de teste e diz o resultado. */
  onTest?: (item: string) => Promise<{ ok: boolean; queued?: boolean; reason?: string }>
  /** A dica (ou o aviso) que fica abaixo da lista. */
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const inputId = useId()
  const errorId = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<RecipientError | null>(null)
  const [tests, setTests] = useState<Record<string, TestRowState>>({})

  const runTest = async (item: string) => {
    if (!onTest) return
    setTests((current) => ({ ...current, [item]: { phase: 'sending' } }))
    let state: TestRowState
    try {
      const result = await onTest(item)
      state = result.ok
        ? { phase: result.queued ? 'queued' : 'sent' }
        : { phase: 'failed', reason: result.reason ?? '' }
    } catch {
      state = { phase: 'failed', reason: t('api.requestFailed') }
    }
    setTests((current) => ({ ...current, [item]: state }))
  }

  const add = () => {
    const parts = draft.split(kind === 'email' ? /[\n,;\s]+/ : /[\n,;]+/).map((p) => p.trim()).filter(Boolean)
    if (parts.length === 0) { setError('empty'); return }
    let list = items
    const failed: string[] = []
    let firstError: RecipientError | null = null
    for (const part of parts) {
      const result = addRecipient(kind, list, part)
      if (result.ok) list = result.list
      else { failed.push(part); firstError = firstError ?? result.error }
    }
    if (list !== items) onChange(list)
    setDraft(failed.join(', '))
    setError(firstError)
  }

  const full = items.length >= MAX_RECIPIENTS
  return (
    <div>
      <label htmlFor={inputId} className="field-label flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className="text-xs font-normal text-muted-foreground">{t('whatsapp.alerts.rcptCount', { count: items.length, max: MAX_RECIPIENTS })}</span>
      </label>
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 items-stretch">
          {kind === 'phone' && (
            <span className="flex items-center rounded-s-md border border-e-0 border-border bg-[hsl(var(--surface-subtle))] px-2.5 text-sm text-muted-foreground" aria-hidden="true">+55</span>
          )}
          <input
            id={inputId}
            type={kind === 'email' ? 'email' : 'tel'}
            inputMode={kind === 'email' ? 'email' : 'tel'}
            autoComplete="off"
            className={`modern-input w-full min-w-0 text-sm ${kind === 'phone' ? 'rounded-s-none' : ''}`}
            value={draft}
            placeholder={placeholder}
            disabled={full}
            aria-invalid={error ? true : undefined}
            aria-describedby={[hintId, error ? errorId : ''].filter(Boolean).join(' ')}
            onChange={(event) => { setDraft(event.target.value); if (error) setError(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }}
          />
        </div>
        <button type="button" className="modern-button-secondary shrink-0" onClick={add} disabled={full}>
          {t('whatsapp.alerts.rcptAdd')}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-sm text-[hsl(var(--status-danger))]">
          {t(ERROR_KEY[error], { max: MAX_RECIPIENTS })}
        </p>
      )}
      {items.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => {
            const shown = kind === 'phone' ? formatPhone(item) : item
            const testable = Boolean(onTest) && canTestItem(saved ?? [], item)
            const state = tests[item]
            return (
              <li key={item} className="flex items-center gap-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{shown}</span>
                {onTest && (
                  <span className="flex shrink-0 items-center gap-2">
                    <span
                      className={`text-xs ${state?.phase === 'failed' ? 'text-[hsl(var(--status-danger))]' : state?.phase === 'sending' || !state ? 'text-muted-foreground' : 'text-[hsl(var(--status-success))]'}`}
                      role="status"
                      aria-live="polite"
                    >
                      {state?.phase === 'sending' && t('whatsapp.alerts.testSending')}
                      {state?.phase === 'queued' && t('whatsapp.alerts.testQueued')}
                      {state?.phase === 'sent' && t('whatsapp.alerts.testSent')}
                      {state?.phase === 'failed' && t('whatsapp.alerts.testFailed', { reason: state.reason })}
                      {!state && !testable && t('whatsapp.alerts.testSaveFirst')}
                    </span>
                    <button
                      type="button"
                      className="modern-button-secondary min-h-10 px-2.5 py-1 text-xs lg:min-h-0"
                      disabled={!testable || state?.phase === 'sending'}
                      aria-label={t('whatsapp.alerts.testBtnAria', { item: shown })}
                      onClick={() => void runTest(item)}
                    >
                      {t('whatsapp.alerts.testBtn')}
                    </button>
                  </span>
                )}
                <button
                  type="button"
                  className="min-h-10 shrink-0 rounded-md px-2 text-sm text-[hsl(var(--status-danger))] underline underline-offset-2 lg:min-h-0"
                  aria-label={t('whatsapp.alerts.rcptRemoveAria', { item: shown })}
                  onClick={() => onChange(removeRecipient(items, item))}
                >
                  {t('whatsapp.alerts.rcptRemove')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {children}
    </div>
  )
}
