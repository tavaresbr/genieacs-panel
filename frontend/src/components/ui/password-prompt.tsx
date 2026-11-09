import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/contexts/language-context'

type Pending = { message: string; resolve: (password: string | null) => void }

/**
 * Asks for the person's own password before an admin action runs: the server
 * checks it again (`confirmOwnPassword`), this only collects it. Rendering
 * `element` somewhere in the component is what shows the dialog; `ask`
 * resolves with the typed password, or `null` when the person cancelled.
 */
export function usePasswordPrompt(): { ask: (message: string) => Promise<string | null>; element: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null)

  const ask = useCallback((message: string) => new Promise<string | null>((resolve) => {
    setPending({ message, resolve })
  }), [])

  const finish = useCallback((password: string | null) => {
    setPending((current) => {
      current?.resolve(password)
      return null
    })
  }, [])

  const element = pending ? <PasswordPrompt message={pending.message} onDone={finish} /> : null
  return { ask, element }
}

function PasswordPrompt({ message, onDone }: { message: string; onDone: (password: string | null) => void }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDone(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="password-prompt-title">
      <form
        className="modal-panel modern-card w-full max-w-sm space-y-3 p-5"
        data-testid="password-prompt"
        onSubmit={(event) => {
          event.preventDefault()
          if (password) onDone(password)
        }}
      >
        <h2 id="password-prompt-title" className="text-base font-semibold">{t('passwordPrompt.title')}</h2>
        <p className="text-sm text-muted-foreground whitespace-pre-line">{message}</p>
        <input
          ref={input}
          type="password"
          autoComplete="current-password"
          className="modern-input w-full"
          aria-label={t('passwordPrompt.label')}
          placeholder={t('passwordPrompt.label')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          data-testid="password-prompt-input"
        />
        <div className="flex justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={() => onDone(null)}>
            {t('passwordPrompt.cancel')}
          </button>
          <button type="submit" className="modern-button" disabled={!password} data-testid="password-prompt-confirm">
            {t('passwordPrompt.confirm')}
          </button>
        </div>
      </form>
    </div>
  )
}
