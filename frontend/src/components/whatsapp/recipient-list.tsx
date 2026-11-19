'use client'

import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { MAX_RECIPIENTS, addRecipient, formatPhone, removeRecipient, type RecipientError } from '@/lib/alert-recipients'

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
export function RecipientList({ kind, items, onChange, label, hintId, placeholder, children }: {
  kind: 'phone' | 'email'
  items: string[]
  onChange: (next: string[]) => void
  label: string
  hintId: string
  placeholder: string
  /** A dica (ou o aviso) que fica abaixo da lista. */
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const inputId = useId()
  const errorId = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<RecipientError | null>(null)

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
            return (
              <li key={item} className="flex items-center gap-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{shown}</span>
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
