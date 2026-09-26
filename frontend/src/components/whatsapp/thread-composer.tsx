'use client'

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { useTranslation } from '@/contexts/language-context'
import { whatsappAPI } from '@/lib/api'
import { formatFileSize } from '@/lib/firmware'
import {
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENTS_PER_SEND,
  acceptAttribute,
  attachmentRefusal,
  canAddFiles,
  isClipboardPlaceholderName,
  isPreviewable,
  pastedFileName,
  planSend,
  resolveAttachmentType
} from '@/lib/wa-attachments'

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
  /**
   * Text handed in from outside — the SGP module's second copy. It REPLACES
   * what is in the box and goes nowhere by itself: the operator reads it and
   * presses Send. `id` changes on every hand-over, so the same text twice is
   * two hand-overs.
   */
  draft?: { id: number; text: string } | null
}

/**
 * Um arquivo escolhido e ainda não enviado. `type` é o já resolvido — o que
 * vai no upload —, e `preview` é a URL de objeto da miniatura, que precisa ser
 * revogada quando o arquivo sai da caixa, ou fica presa na memória da aba.
 */
interface PickedFile {
  id: number
  file: File
  type: string
  preview: string | null
}

/** Arrastar texto ou um link da própria página não é anexar. */
const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files')

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
 *
 * Vários arquivos de uma vez (pelo seletor, colando um print com Ctrl+V ou
 * soltando sobre a caixa), e cada um vira uma mensagem, na ordem da tela. O
 * texto digitado vai como legenda do PRIMEIRO; os outros vão sem texto
 * (`planSend`). Um envio que falha no meio para ali: o que já saiu sai da
 * caixa, o que não saiu fica — inclusive o texto, se ele ainda não foi — e o
 * modo nota continua ligado, porque o resto do lote ainda é nota e virar
 * resposta no meio do caminho é justamente a direção perigosa.
 */
export function ThreadComposer({ optedOut, sending, onSend, draft = null }: ThreadComposerProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [body, setBody] = useState('')
  const [isNote, setIsNote] = useState(false)
  const [items, setItems] = useState<PickedFile[]>([])
  const [working, setWorking] = useState(false)
  const [progress, setProgress] = useState<{ n: number; total: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(1)
  // `dragenter`/`dragleave` disparam a cada filho atravessado; só a contagem
  // diz quando o arquivo saiu da caixa de verdade.
  const dragDepth = useRef(0)
  // As URLs vivas ficam aqui, fora do estado, para a limpeza da desmontagem
  // alcançá-las sem depender da última renderização.
  const previews = useRef(new Set<string>())

  useEffect(() => {
    const live = previews.current
    return () => {
      live.forEach((url) => URL.revokeObjectURL(url))
      live.clear()
    }
  }, [])

  // Taken in during render rather than in an effect, so the box never paints
  // one frame with the old text. A draft is a reply, never a note: a billing
  // text filed as an internal note would be a customer waiting for nothing.
  const [takenDraft, setTakenDraft] = useState<number | null>(draft?.id ?? null)
  if (draft && draft.id !== takenDraft) {
    setTakenDraft(draft.id)
    setBody(draft.text)
    setIsNote(false)
  }
  useEffect(() => {
    if (draft) boxRef.current?.focus()
  }, [draft])

  // `sending` volta a false entre um arquivo e outro do lote; `working` cobre
  // o lote inteiro, para ninguém mexer na fila enquanto ela anda.
  const busy = sending || working
  const empty = body.trim().length === 0 && items.length === 0

  const release = (item: PickedFile) => {
    if (!item.preview) return
    URL.revokeObjectURL(item.preview)
    previews.current.delete(item.preview)
  }

  const removeItem = (item: PickedFile) => {
    release(item)
    setItems((current) => current.filter((row) => row.id !== item.id))
  }

  /**
   * Recusado antes de sair um byte: o arquivo nem entra na caixa, então o
   * operador não aperta Enviar em algo que já ia falhar. Os bons entram mesmo
   * que um vizinho seja recusado — um PDF errado não derruba nove fotos certas.
   */
  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0 || busy) return
    const fine: File[] = []
    for (const candidate of incoming) {
      const problem = attachmentRefusal(candidate)
      if (problem) {
        toast.error(t(problem.key, problem.vars), { title: candidate.name || t('whatsapp.inbox.attach') })
        continue
      }
      fine.push(candidate)
    }
    const { accepted, refused } = canAddFiles(items.length, fine.length)
    if (refused > 0) {
      toast.error(t('whatsapp.inbox.attachMax', { max: MAX_ATTACHMENTS_PER_SEND }), { title: t('whatsapp.inbox.attach') })
    }
    if (accepted === 0) return
    const picked = fine.slice(0, accepted).map((file): PickedFile => {
      // Já passou por `attachmentRefusal`, então o tipo resolve.
      const type = resolveAttachmentType(file) ?? file.type
      let preview: string | null = null
      if (isPreviewable(type)) {
        preview = URL.createObjectURL(file)
        previews.current.add(preview)
      }
      return { id: nextId.current++, file, type, preview }
    })
    setItems((current) => [...current, ...picked])
  }

  /**
   * Ctrl+V com imagem na área de transferência vira anexo. Só quando há
   * ARQUIVO lá: colar texto continua sendo colar texto, sem nada interceptado.
   */
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    const now = new Date()
    let shot = 0
    addFiles(files.map((file) => (
      file.type.startsWith('image/') && isClipboardPlaceholderName(file.name)
        ? new File([file], pastedFileName(now, shot++, file.type), { type: file.type, lastModified: now.getTime() })
        : file
    )))
  }

  const dragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const dragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return
    // Sem o `preventDefault` aqui o navegador não aceita o drop e abre o
    // arquivo no lugar do painel.
    event.preventDefault()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
  }
  const dragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const drop = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const submit = async () => {
    // Guarded here rather than left to the server: `message_empty` is a refusal
    // the box can simply never provoke, and a disabled button says so before
    // the operator presses it.
    if (empty || busy) return

    const steps = planSend({ body, files: items })
    const total = steps.length
    setWorking(true)
    try {
      for (const [index, step] of steps.entries()) {
        if (total > 1) setProgress({ n: index + 1, total })

        let attachment: ComposerAttachment | undefined
        if (step.file) {
          const picked = step.file
          let stored
          try {
            stored = await whatsappAPI.uploadAttachment(picked.file, picked.type)
          } catch {
            stored = { success: false as const, code: undefined, data: undefined }
          }
          if (!stored.success || !stored.data) {
            // Para aqui: este arquivo e os seguintes ficam na caixa, na mesma
            // ordem, e o próximo Enviar recomeça exatamente deste.
            toast.error(
              whatsappErrorMessage(t, stored.code, { max: MAX_ATTACHMENT_MB }),
              { title: `${t('whatsapp.inbox.sendFailed')} — ${picked.file.name}` }
            )
            return
          }
          // `path` is the stored reference, relative to the panel's data directory.
          // The send route takes it as `attachment.url` and writes it to the row.
          attachment = { url: stored.data.path, type: stored.data.type, name: stored.data.name }
        }

        // A recusa do envio já vira toast no pai (`whatsappErrorMessage` sobre o
        // código); repetir aqui seria o mesmo aviso duas vezes.
        const ok = await onSend(step.body, isNote, attachment)
        if (!ok) return

        // O texto saiu com este passo: sai da caixa. Só se ainda for o mesmo —
        // um rascunho do SGP que chegou no meio do lote não é apagado.
        if (step.body) setBody((current) => (current.trim() === step.body ? '' : current))
        if (step.file) removeItem(step.file)
      }
      setIsNote(false)
      if (fileRef.current) fileRef.current.value = ''
      boxRef.current?.focus()
    } finally {
      setWorking(false)
      setProgress(null)
    }
  }

  const sendLabel = progress
    ? t('whatsapp.inbox.sendingProgress', { n: progress.n, total: progress.total })
    : isNote ? t('whatsapp.inbox.note') : t('whatsapp.inbox.send')

  return (
    <div
      className="relative border-t border-border bg-card p-3"
      data-testid="composer"
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-1.5 z-10 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-card text-sm font-semibold text-primary shadow-lg">
          <Icon name="paperclip" size={18} />
          {t('whatsapp.inbox.attachDrop')}
        </div>
      )}

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
        onPaste={paste}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          void submit()
        }}
      />

      {items.length === 0 ? (
        <p className="field-hint">{t('whatsapp.inbox.attachHint')}</p>
      ) : (
        <div className="mt-2" data-testid="composer-attachments">
          <p className="field-hint mb-1.5 mt-0 flex flex-wrap gap-x-1.5">
            <span className="font-semibold">{t('whatsapp.inbox.attachCount', { count: items.length })}</span>
            {body.trim() && <span>· {t('whatsapp.inbox.captionHint')}</span>}
          </p>
          <ul className="flex flex-wrap gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                data-testid="composer-attachment"
                className="flex w-60 max-w-full items-center gap-2 rounded-md border border-border bg-background/50 p-1.5 text-xs text-foreground"
              >
                {item.preview ? (
                  <img src={item.preview} alt="" className="size-10 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                    <Icon name="document" size={18} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={item.file.name}>{item.file.name}</span>
                  <span className="block text-muted-foreground">{formatFileSize(item.file.size)}</span>
                </span>
                <button
                  type="button"
                  className="icon-button size-6 shrink-0"
                  aria-label={t('whatsapp.inbox.attachRemove', { name: item.file.name })}
                  title={t('whatsapp.inbox.attachRemove', { name: item.file.name })}
                  disabled={busy}
                  onClick={() => removeItem(item)}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
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
            multiple
            className="hidden"
            data-testid="composer-file"
            accept={acceptAttribute()}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []))
              // The input keeps its own value, and an unreset one refuses to fire
              // `change` when the operator picks the very same file again.
              event.target.value = ''
            }}
          />
          <button
            type="button"
            className="modern-button-secondary shrink-0"
            aria-label={t('whatsapp.inbox.attach')}
            title={t('whatsapp.inbox.attachHint')}
            disabled={busy || items.length >= MAX_ATTACHMENTS_PER_SEND}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="paperclip" size={16} />
            {t('whatsapp.inbox.attach')}
          </button>

          <button
            type="button"
            className={isNote ? 'modern-button-secondary shrink-0 border-[hsl(var(--status-warning))]/70' : 'modern-button shrink-0'}
            disabled={empty || busy}
            aria-live="polite"
            onClick={() => void submit()}
          >
            <Icon name={busy ? 'refresh' : isNote ? 'lock' : 'chat'} size={16} className={busy ? 'animate-spin' : ''} />
            {sendLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
