'use client'

import { useRef, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { useTranslation } from '@/contexts/language-context'
import { whatsappAPI } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

export interface ComposerAttachment {
  url: string
  type?: string
  name?: string
}

interface ThreadComposerProps {
  /** Purely informational here. Opt-out never closes this box — see below. */
  optedOut: boolean
  sending: boolean
  onSend: (body: string, isNote: boolean, attachment?: ComposerAttachment) => Promise<boolean>
}

/**
 * The ceiling and the allowlist, as the server holds them.
 *
 * Repeated on this side on purpose, and only to refuse EARLY: the operator
 * should not watch 16 MB travel to be told no at the end of it. The server's
 * copy is the one that decides — a file that gets past this list is still
 * refused there, with the same two codes.
 */
const MAX_ATTACHMENT_MB = 16
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024
const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'audio/ogg',
  'audio/mpeg'
]

/**
 * The two refusals this box can provoke, translated from the machine `code`.
 *
 * `whatsappErrorMessage` maps every other code on this surface and is what any
 * unknown one falls back to; these two are handled here because the "too large"
 * key takes `{max}` — the ceiling in MB — and the shared helper passes no
 * variables. Either way the server's own `message` is never shown: it can carry
 * words from another server, and those belong in a log.
 */
const ATTACHMENT_ERROR_KEYS: Record<string, TranslationKey> = {
  attachment_too_large: 'whatsapp.error.attachmentTooLarge',
  attachment_type_not_allowed: 'whatsapp.error.attachmentTypeNotAllowed'
}

/**
 * The reply box.
 *
 * Three rules it exists to hold:
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
 *    which is the dangerous direction. A note that carries a file is still a
 *    note — the file rides along, the `isNote` flag does not change.
 *
 *  · **A caption is optional.** A photo of the fibre path with nothing written
 *    under it is a whole message, so the Send button follows "text OR file",
 *    not "text". The server agrees: it refuses `message_empty` only when both
 *    are missing.
 */
export function ThreadComposer({ optedOut, sending, onSend }: ThreadComposerProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [body, setBody] = useState('')
  const [isNote, setIsNote] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const busy = sending || uploading
  const empty = body.trim().length === 0 && !file

  const clearFile = () => {
    setFile(null)
    // The input keeps its own value, and an unreset one refuses to fire
    // `change` when the operator picks the very same file again.
    if (fileRef.current) fileRef.current.value = ''
  }

  /** The refusal this file would earn, or null. Same keys as the server's. */
  const refusal = (candidate: File): string | null => {
    if (candidate.size > MAX_ATTACHMENT_BYTES) {
      return t('whatsapp.error.attachmentTooLarge', { max: MAX_ATTACHMENT_MB })
    }
    if (!ALLOWED_TYPES.includes(candidate.type)) {
      return t('whatsapp.error.attachmentTypeNotAllowed')
    }
    return null
  }

  const choose = (chosen: File | null) => {
    if (!chosen) return
    const problem = refusal(chosen)
    if (problem) {
      // Refused before a single byte leaves: the file is never attached, so the
      // operator cannot press Send on something that was already going to fail.
      toast.error(problem, { title: t('whatsapp.inbox.attach') })
      clearFile()
      return
    }
    setFile(chosen)
  }

  const submit = async () => {
    // Guarded here rather than left to the server: `message_empty` is a refusal
    // the box can simply never provoke, and a disabled button says so before
    // the operator presses it.
    if (empty || busy) return

    let attachment: ComposerAttachment | undefined
    if (file) {
      const problem = refusal(file)
      if (problem) {
        toast.error(problem, { title: t('whatsapp.inbox.attach') })
        return
      }
      setUploading(true)
      let stored
      try {
        stored = await whatsappAPI.uploadAttachment(file)
      } finally {
        setUploading(false)
      }
      if (!stored.success || !stored.data) {
        const key = ATTACHMENT_ERROR_KEYS[stored.code ?? '']
        toast.error(
          key ? t(key, { max: MAX_ATTACHMENT_MB }) : whatsappErrorMessage(t, stored.code),
          { title: t('whatsapp.inbox.sendFailed') }
        )
        // The file stays chosen, for the same reason the words stay in the box.
        return
      }
      // `path` is the stored reference, relative to the panel's data directory.
      // The send route takes it as `attachment.url` and writes it to the row.
      attachment = { url: stored.data.path, type: stored.data.type, name: stored.data.name }
    }

    const ok = await onSend(body.trim(), isNote, attachment)
    // A refusal keeps the words in the box — a message that never left is worth
    // less as a lost paragraph than as an error with the text still there.
    if (!ok) return
    setBody('')
    setIsNote(false)
    clearFile()
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

      {file && (
        <p
          data-testid="composer-attachment"
          className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background/50 px-2.5 py-1.5 text-xs text-foreground"
        >
          <Icon name="box" size={14} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
          <button
            type="button"
            className="icon-button size-6 shrink-0"
            aria-label={t('whatsapp.inbox.attachRemove')}
            title={t('whatsapp.inbox.attachRemove')}
            disabled={busy}
            onClick={clearFile}
          >
            <Icon name="x" size={14} />
          </button>
        </p>
      )}

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

        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            data-testid="composer-file"
            accept={ALLOWED_TYPES.join(',')}
            onChange={(event) => choose(event.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className="modern-button-secondary shrink-0"
            aria-label={t('whatsapp.inbox.attach')}
            title={t('whatsapp.inbox.attach')}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="box" size={16} />
            {t('whatsapp.inbox.attach')}
          </button>

          <button
            type="button"
            className={isNote ? 'modern-button-secondary shrink-0 border-[hsl(var(--status-warning))]/70' : 'modern-button shrink-0'}
            disabled={empty || busy}
            onClick={() => void submit()}
          >
            <Icon name={busy ? 'refresh' : isNote ? 'lock' : 'chat'} size={16} className={busy ? 'animate-spin' : ''} />
            {isNote ? t('whatsapp.inbox.note') : t('whatsapp.inbox.send')}
          </button>
        </div>
      </div>
    </div>
  )
}
