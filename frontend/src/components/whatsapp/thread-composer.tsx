'use client'

import { useRef, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'

interface ThreadComposerProps {
  /** Purely informational here. Opt-out never closes this box — see below. */
  optedOut: boolean
  sending: boolean
  onSend: (body: string, isNote: boolean) => Promise<boolean>
}

/**
 * The reply box.
 *
 * Two rules it exists to hold:
 *
 *  · **Opt-out does not disable it.** "Não perturbe" means the provider does
 *    not *start* a conversation with that number; the person on the other end
 *    wrote in, and refusing to answer them would be a worse product, not a more
 *    respectful one. The server agrees — the send route never consults the
 *    opt-out list. So the state is shown as a badge and an explanation and
 *    nothing else: an operator who cannot answer a customer is the one failure
 *    on this screen nobody would report as a bug, they would just stop using it.
 *
 *  · **Note mode is loud and does not stick.** An internal note is stored with
 *    `deliveryStatus: null` and the outbox worker never sees it, so a note
 *    mistaken for a reply is a customer waiting for words that were never sent.
 *    While the toggle is on the whole box turns amber, and it resets after
 *    every send: a sticky note mode would silently swallow the *next* reply,
 *    which is the dangerous direction.
 */
export function ThreadComposer({ optedOut, sending, onSend }: ThreadComposerProps) {
  const { t } = useTranslation()
  const [body, setBody] = useState('')
  const [isNote, setIsNote] = useState(false)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  const empty = body.trim().length === 0

  const submit = async () => {
    // Guarded here rather than left to the server: `message_empty` is a refusal
    // the box can simply never provoke, and a disabled button says so before
    // the operator presses it.
    if (empty || sending) return
    const ok = await onSend(body.trim(), isNote)
    // A refusal keeps the words in the box — a message that never left is worth
    // less as a lost paragraph than as an error with the text still there.
    if (!ok) return
    setBody('')
    setIsNote(false)
    boxRef.current?.focus()
  }

  return (
    <div className="border-t border-border bg-card p-3">
      {optedOut && (
        <p className="mb-2.5 flex items-start gap-2 rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/[0.08] px-3 py-2 text-xs leading-5 text-foreground">
          <Icon name="bell" size={14} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
          <span>
            <strong className="font-semibold">{t('whatsapp.inbox.optedOut')}.</strong>{' '}
            {t('whatsapp.inbox.optedOutHint')}
          </span>
        </p>
      )}

      <textarea
        ref={boxRef}
        rows={3}
        className={`modern-input min-h-20 resize-y ${
          isNote
            ? 'border-[hsl(var(--status-warning))]/70 bg-[hsl(var(--status-warning))]/[0.06] focus:border-[hsl(var(--status-warning))] focus:ring-[hsl(var(--status-warning))]/20'
            : ''
        }`}
        placeholder={t('whatsapp.inbox.placeholder')}
        aria-label={t('whatsapp.inbox.placeholder')}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          void submit()
        }}
      />

      <div className="mt-2.5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-foreground">
            <input
              type="checkbox"
              className="size-4 accent-[hsl(var(--status-warning))]"
              checked={isNote}
              onChange={(event) => setIsNote(event.target.checked)}
            />
            <Icon name="lock" size={14} className={isNote ? 'text-[hsl(var(--status-warning))]' : 'text-muted-foreground'} />
            {t('whatsapp.inbox.note')}
          </label>
          <p className="field-hint max-w-md">{t('whatsapp.inbox.noteHint')}</p>
        </div>

        <button
          type="button"
          className={isNote ? 'modern-button-secondary shrink-0 border-[hsl(var(--status-warning))]/70' : 'modern-button shrink-0'}
          disabled={empty || sending}
          onClick={() => void submit()}
        >
          <Icon name={sending ? 'refresh' : isNote ? 'lock' : 'chat'} size={16} className={sending ? 'animate-spin' : ''} />
          {isNote ? t('whatsapp.inbox.note') : t('whatsapp.inbox.send')}
        </button>
      </div>
    </div>
  )
}
