'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/contexts/language-context'

/**
 * "Mandar a pesquisa de satisfação ao cliente?", na hora de encerrar.
 *
 * A pesquisa ("De 1 a 5...") sai sozinha ao encerrar, e o cliente que responde
 * "obrigado" reabre a conversa — que então nunca acaba. Quem encerra decide, a
 * cada vez. Só aparece quando a pesquisa de fato sairia (`surveyOnClose`).
 */
export function CloseSurveyDialog({ busy, onChoose, onCancel }: {
  busy: boolean
  onChoose: (survey: boolean) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    first.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="close-survey-title">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onCancel} aria-label={t('common.close')} tabIndex={-1} />
      <section className="modern-card relative w-full max-w-md space-y-4 p-5">
        <div>
          <h2 id="close-survey-title" className="text-lg font-semibold text-foreground">{t('whatsapp.closeSurvey.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('whatsapp.closeSurvey.hint')}</p>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="modern-button-secondary" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="modern-button-secondary" onClick={() => onChoose(false)} disabled={busy}>
            {t('whatsapp.closeSurvey.skip')}
          </button>
          <button ref={first} type="button" className="modern-button" onClick={() => onChoose(true)} disabled={busy}>
            {t('whatsapp.closeSurvey.send')}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
