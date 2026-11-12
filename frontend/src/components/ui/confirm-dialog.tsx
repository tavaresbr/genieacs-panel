import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/contexts/language-context'

type Pending = { message: string; danger: boolean; resolve: (ok: boolean) => void }

/**
 * Um "tem certeza?" no estilo do painel, no lugar do `window.confirm`.
 *
 * Mesmo desenho do `usePasswordPrompt`: renderizar `element` em algum ponto do
 * componente é o que mostra o diálogo, e `confirm` resolve com `true` se a
 * pessoa confirmou e `false` se cancelou (botão, Esc ou clique fora). O foco
 * começa no botão de cancelar: Enter sem querer não encerra nada.
 */
export function useConfirm(): {
  confirm: (message: string, options?: { danger?: boolean }) => Promise<boolean>
  element: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback((message: string, options?: { danger?: boolean }) => new Promise<boolean>((resolve) => {
    setPending({ message, danger: options?.danger ?? false, resolve })
  }), [])

  const finish = useCallback((ok: boolean) => {
    setPending((current) => {
      current?.resolve(ok)
      return null
    })
  }, [])

  const element = pending ? <ConfirmDialog message={pending.message} danger={pending.danger} onDone={finish} /> : null
  return { confirm, element }
}

function ConfirmDialog({ message, danger, onDone }: { message: string; danger: boolean; onDone: (ok: boolean) => void }) {
  const { t } = useTranslation()
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancel.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDone(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])

  return (
    <div
      className="modal-backdrop" role="alertdialog" aria-modal="true" aria-describedby="confirm-dialog-message"
      onClick={(event) => { if (event.target === event.currentTarget) onDone(false) }}
    >
      <div className="modal-panel modern-card w-full max-w-sm space-y-4 p-5" data-testid="confirm-dialog">
        <p id="confirm-dialog-message" className="text-sm text-foreground whitespace-pre-line">{message}</p>
        <div className="flex justify-end gap-2">
          <button ref={cancel} type="button" className="modern-button-secondary" onClick={() => onDone(false)}>
            {t('common.cancel')}
          </button>
          <button
            type="button" className={danger ? 'modern-button-danger' : 'modern-button'}
            onClick={() => onDone(true)} data-testid="confirm-dialog-confirm"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
