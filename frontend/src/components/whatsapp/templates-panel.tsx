'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppTemplate } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import type { TranslationKey } from '@/lib/i18n'

// ─────────────────────────────────────────────────────────────────────────────
// The variables the dispatcher knows how to fill.
//
// SOURCE OF TRUTH: `backend/src/utils/wa/waCobranca.js`, `VARIAVEIS_DE_COBRANCA`
// (also re-exported from `backend/src/services/waTemplateService.js`). No route
// publishes the list, so it is copied here rather than fetched; if the backend
// grows a variable, this array is the second place to change.
//
// The copy earns its keep: the server refuses a body citing anything outside
// this list with `unknown_variable`, and an operator typing `{{nome_cliente}}`
// from memory only finds out at save time. The chips below turn that recall
// into recognition.
// ─────────────────────────────────────────────────────────────────────────────
const VARIABLES = [
  'nome',
  'valor',
  'vencimento',
  'dias_atraso',
  'dias_para_vencer',
  'pix',
  'linha_digitavel',
  'link_boleto'
] as const

/** The backend's own placeholder pattern, character for character. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g

/** Every distinct variable a body cites, known or not. */
function citedVariables(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(PLACEHOLDER)) found.add(match[1])
  return [...found]
}

/** What the server will refuse the body for, computed before asking it. */
function unknownVariables(body: string): string[] {
  return citedVariables(body).filter((name) => !VARIABLES.includes(name as (typeof VARIABLES)[number]))
}

type Classification = 'reminder' | 'dunning' | 'both' | 'none'

/**
 * What a template IS, read off what it cites — never off a field an operator
 * could set to disagree with the text.
 *
 * `dias_atraso` and `dias_para_vencer` are mirrors: an overdue invoice fills
 * the first and empties the second, and vice versa. Since an empty variable
 * refuses the whole message, a body citing `dias_atraso` can only ever render
 * for someone already overdue — which is the rule that keeps a dunning text
 * away from a subscriber who has not been billed yet. A body citing BOTH is
 * therefore not "more general": it can never render for anybody, and this
 * editor is the only place an operator can be told so before a campaign
 * silently skips every recipient.
 */
function classify(body: string): Classification {
  const cited = citedVariables(body)
  const reminder = cited.includes('dias_para_vencer')
  const dunning = cited.includes('dias_atraso')
  if (reminder && dunning) return 'both'
  if (reminder) return 'reminder'
  if (dunning) return 'dunning'
  return 'none'
}

const CLASSIFICATION_LABEL: Record<'reminder' | 'dunning', TranslationKey> = {
  reminder: 'whatsapp.templates.isReminder',
  dunning: 'whatsapp.templates.isDunning'
}

/**
 * The classification as a badge. `none` draws nothing: a template citing
 * neither mirror is simply not a billing text, and an extra "neither" chip on
 * every support template would be noise.
 */
function ClassificationBadge({ body }: { body: string }) {
  const { t } = useTranslation()
  const kind = classify(body)
  if (kind === 'none') return null
  if (kind === 'both') {
    return (
      <span className="modern-badge-error" title={t('whatsapp.billing.templateMismatch')}>
        <Icon name="warning" size={12} />
        {t('common.warning')}
      </span>
    )
  }
  return (
    <span className={kind === 'reminder' ? 'modern-badge-info' : 'modern-badge-warning'}>
      <Icon name="invoice" size={12} />
      {t(CLASSIFICATION_LABEL[kind])}
    </span>
  )
}

interface Draft {
  id: number | null
  name: string
  body: string
}

const EMPTY_DRAFT: Draft = { id: null, name: '', body: '' }

/**
 * The message-template editor.
 *
 * Self-contained: it owns its own fetch, its own draft and its own refusals,
 * and the page only has to mount it.
 */
export function TemplatesPanel() {
  const { t, intlLocale } = useTranslation()
  const toast = useToast()

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  // The refusal that has a name, kept on the form instead of only in a toast:
  // it names variables the operator has to go and fix in the text in front of
  // them, and a toast is gone by the time they look.
  const [refusal, setRefusal] = useState('')

  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const res = await whatsappAPI.listTemplates()
    if (!alive.current) return
    if (res.success && Array.isArray(res.data)) {
      setTemplates(res.data)
      setLoadError('')
    } else {
      setLoadError(whatsappErrorMessage(t, res.code))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const stamp = useCallback(
    (iso: string | null) => {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'short', timeStyle: 'short' }).format(date)
    },
    [intlLocale]
  )

  /**
   * Insert `{{name}}` where the caret is.
   *
   * Splicing at the selection rather than appending is the whole point: the
   * operator is mid-sentence ("Hi ", caret, ", your invoice…"), and a variable
   * that lands at the end of the box would have to be cut and pasted back.
   * The caret is put back after the inserted text so typing continues.
   */
  const insertVariable = useCallback((name: string) => {
    const token = `{{${name}}}`
    setDraft((current) => {
      if (!current) return current
      const field = bodyRef.current
      const start = field?.selectionStart ?? current.body.length
      const end = field?.selectionEnd ?? current.body.length
      const next = `${current.body.slice(0, start)}${token}${current.body.slice(end)}`
      // The state update has not painted yet, so the caret is moved on the next
      // frame — before it, the textarea still holds the old value and any
      // selection we set would be clobbered by React's own write.
      requestAnimationFrame(() => {
        const el = bodyRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(start + token.length, start + token.length)
      })
      return { ...current, body: next }
    })
    setRefusal('')
  }, [])

  const save = useCallback(async () => {
    if (!draft) return
    const name = draft.name.trim()
    const body = draft.body.trim()
    // `template_empty` is a refusal this panel can avoid provoking, so the
    // button simply does not arm until there is something to save.
    if (!name || !body) return

    setSaving(true)
    setRefusal('')
    const res = draft.id === null
      ? await whatsappAPI.createTemplate({ name, body })
      : await whatsappAPI.updateTemplate(draft.id, { name, body })
    if (!alive.current) return
    setSaving(false)

    if (res.success) {
      setDraft(null)
      toast.success(t('common.success'))
      await load()
      return
    }

    // Only the machine `code` is ever translated. `unknown_variable` is the one
    // refusal that can name what is wrong, and it names it from the body in the
    // box — not by parsing the server's prose back apart.
    if (res.code === 'unknown_variable') {
      const offenders = unknownVariables(body).map((v) => `{{${v}}}`)
      const message = t('whatsapp.templates.unknownVariable', {
        name: offenders.length > 0 ? offenders.join(', ') : '{{…}}'
      })
      setRefusal(message)
      toast.error(message)
      return
    }
    const message = whatsappErrorMessage(t, res.code)
    setRefusal(message)
    toast.error(message)
  }, [draft, load, t, toast])

  const remove = useCallback(
    async (template: WhatsAppTemplate) => {
      if (!window.confirm(t('whatsapp.templates.confirmDelete', { name: template.name }))) return
      setDeletingId(template.id)
      const res = await whatsappAPI.deleteTemplate(template.id)
      if (!alive.current) return
      setDeletingId(null)
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      if (draft?.id === template.id) setDraft(null)
      toast.success(t('common.success'))
      await load()
    },
    [draft, load, t, toast]
  )

  const draftBody = draft?.body ?? ''
  const draftKind = useMemo(() => classify(draftBody), [draftBody])
  const canSave = Boolean(draft && draft.name.trim() && draft.body.trim())

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('whatsapp.templates.title')}</h2>
          <p className="section-description">{t('whatsapp.templates.description')}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="modern-button-secondary" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={16} />
            {t('common.refresh')}
          </button>
          <button
            type="button"
            className="modern-button"
            onClick={() => {
              setRefusal('')
              setDraft({ ...EMPTY_DRAFT })
            }}
          >
            <Icon name="edit" size={16} />
            {t('whatsapp.templates.new')}
          </button>
        </div>
      </header>

      {draft && (
        <form
          className="modern-card flex flex-col gap-4 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div>
            <label className="field-label" htmlFor="wa-template-name">
              {t('whatsapp.templates.name')}
            </label>
            <input
              id="wa-template-name"
              className="modern-input"
              value={draft.name}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="wa-template-body">
              {t('whatsapp.templates.body')}
            </label>
            <textarea
              id="wa-template-body"
              ref={bodyRef}
              className="modern-input min-h-40 font-mono text-[0.82rem] leading-6"
              value={draft.body}
              onChange={(event) => {
                setDraft({ ...draft, body: event.target.value })
                setRefusal('')
              }}
            />
          </div>

          <div>
            <span className="field-label">{t('whatsapp.templates.variables')}</span>
            <div className="flex flex-wrap gap-1.5">
              {VARIABLES.map((name) => (
                <button
                  key={name}
                  type="button"
                  title={t('whatsapp.templates.insertVariable')}
                  aria-label={`${t('whatsapp.templates.insertVariable')} {{${name}}}`}
                  onClick={() => insertVariable(name)}
                  className="inline-flex items-center gap-1 rounded border border-border bg-[hsl(var(--surface-subtle))] px-2 py-1 font-mono text-xs font-semibold text-foreground transition-colors hover:border-primary hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon name="copy" size={12} />
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
          </div>

          {/* The badge is the same one the list rows carry, so the operator
              learns what it means here. It is dropped for `both`, where the
              paragraph below says the whole thing in words. */}
          {draftKind === 'reminder' || draftKind === 'dunning' ? (
            <div className="flex flex-wrap items-center gap-2">
              <ClassificationBadge body={draftBody} />
            </div>
          ) : null}

          {draftKind === 'both' && (
            <p className="flex items-start gap-2 rounded-md border border-[hsl(var(--status-danger)/0.3)] bg-[hsl(var(--status-danger)/0.08)] p-3 text-xs leading-5 text-[hsl(var(--status-danger))]">
              <Icon name="warning" size={16} />
              <span>{t('whatsapp.billing.templateMismatch')}</span>
            </p>
          )}

          {refusal && (
            <p className="flex items-start gap-2 rounded-md border border-[hsl(var(--status-danger)/0.3)] bg-[hsl(var(--status-danger)/0.08)] p-3 text-xs leading-5 text-[hsl(var(--status-danger))]">
              <Icon name="warning" size={16} />
              <span>{refusal}</span>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" className="modern-button" disabled={!canSave || saving}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button
              type="button"
              className="modern-button-secondary"
              onClick={() => {
                setDraft(null)
                setRefusal('')
              }}
              disabled={saving}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {loadError && (
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--status-danger))]">
          <Icon name="warning" size={16} />
          {loadError}
        </p>
      )}

      {loading && templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : templates.length === 0 ? (
        <div className="modern-card">
          <div className="empty-state">
            <div className="empty-state-icon">
              <Icon name="chat" size={22} />
            </div>
            <p className="empty-state-title">{t('whatsapp.templates.empty')}</p>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-3" role="list">
          {templates.map((template) => (
            <li key={template.id} className="modern-card p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{template.name}</span>
                    <ClassificationBadge body={template.body} />
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words font-mono text-[0.78rem] leading-6 text-muted-foreground">
                    {template.body}
                  </p>
                  {template.updatedAt && (
                    <p className="mt-2 font-mono text-[0.68rem] tabular-nums text-muted-foreground">
                      {stamp(template.updatedAt)}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="modern-button-secondary"
                    onClick={() => {
                      setRefusal('')
                      setDraft({ id: template.id, name: template.name, body: template.body })
                    }}
                  >
                    <Icon name="edit" size={16} />
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    className="modern-button-danger"
                    onClick={() => void remove(template)}
                    disabled={deletingId === template.id}
                  >
                    <Icon name="trash" size={16} />
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
