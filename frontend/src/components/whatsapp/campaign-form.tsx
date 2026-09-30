'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  whatsappAPI,
  type WhatsAppCampaignAudienceOptions,
  type WhatsAppCampaignFilters,
  type WhatsAppCampaignOption,
  type WhatsAppCampaignPreview,
  type WhatsAppTemplate
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { errorText } from './dunning-rule-panel'
import type { TranslationKey } from '@/lib/i18n'
import { bulkPerHour } from '@/lib/wa-pace'
import { ContactLink } from './contact-link'
import { estimatedHours, localInputToIso, parseContracts, toggleValue } from './campaign-audience'

/**
 * "Nova campanha": um aviso para um grupo de clientes.
 *
 * O público sai do cadastro (situação, plano, bairro, cidade ou uma lista de
 * contratos), a mensagem de um modelo ou de um texto livre com as variáveis
 * do cadastro, e o envio é o mesmo das outras campanhas — no ritmo das
 * mensagens automáticas. Nada sai daqui: o formulário cria um rascunho (que
 * alguém ainda precisa iniciar) ou uma campanha agendada.
 *
 * A prévia é obrigatória. Criar só fica disponível depois de ver quantos e
 * quem vão receber, e qualquer mudança no público ou no texto a descarta.
 */

const VARIABLES = ['nome', 'primeiro_nome', 'contrato', 'plano'] as const

export const STATE_LABEL: Record<string, TranslationKey> = {
  active: 'whatsapp.campaign.stateActive',
  blocked: 'whatsapp.campaign.stateBlocked',
  cancelled: 'whatsapp.campaign.stateCancelled',
  unknown: 'whatsapp.campaign.stateUnknown',
  none: 'whatsapp.campaign.stateNone'
}

type Group = 'states' | 'plans' | 'districts' | 'cities'

const GROUPS: [Group, TranslationKey][] = [
  ['states', 'whatsapp.campaign.filterStates'],
  ['plans', 'whatsapp.campaign.filterPlans'],
  ['districts', 'whatsapp.campaign.filterDistricts'],
  ['cities', 'whatsapp.campaign.filterCities']
]

const EMPTY_SELECTION: Record<Group, string[]> = { states: [], plans: [], districts: [], cities: [] }

export function CampaignForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()

  const [options, setOptions] = useState<WhatsAppCampaignAudienceOptions | null>(null)
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [perHour, setPerHour] = useState(0)

  const [title, setTitle] = useState('')
  const [selection, setSelection] = useState<Record<Group, string[]>>(EMPTY_SELECTION)
  const [contractsText, setContractsText] = useState('')
  const [mode, setMode] = useState<'template' | 'text'>('text')
  const [templateId, setTemplateId] = useState('')
  const [body, setBody] = useState('')
  const [attachment, setAttachment] = useState<{ path: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [when, setWhen] = useState<'draft' | 'schedule'>('draft')
  const [scheduleLocal, setScheduleLocal] = useState('')

  const [preview, setPreview] = useState<WhatsAppCampaignPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [opts, tpls, config] = await Promise.all([
        whatsappAPI.getCampaignAudienceOptions(),
        whatsappAPI.listTemplates(),
        whatsappAPI.getConfig()
      ])
      if (!alive) return
      if (opts.success && opts.data) setOptions(opts.data)
      else toast.error(whatsappErrorMessage(t, opts.code))
      if (tpls.success && tpls.data) {
        setTemplates(tpls.data.filter((tpl) => tpl.active && tpl.category !== 'cobranca' && tpl.category !== 'atendimento'))
      }
      if (config.success && config.data) {
        setPerHour(bulkPerHour({
          bulkIntervalMinSec: config.data.bulkIntervalMinSec ?? 20,
          bulkIntervalMaxSec: config.data.bulkIntervalMaxSec ?? 45,
          bulkBurstSize: config.data.bulkBurstSize ?? 30,
          bulkBurstPauseMin: config.data.bulkBurstPauseMin ?? 5
        }))
      }
    })()
    return () => { alive = false }
  }, [t, toast])

  const filters: WhatsAppCampaignFilters = useMemo(() => ({
    ...selection,
    contracts: parseContracts(contractsText)
  }), [selection, contractsText])

  const message = mode === 'template'
    ? (templateId ? { templateId: Number(templateId) } : null)
    : (body.trim() ? { body } : null)

  // Qualquer mudança no público ou no texto torna a prévia velha.
  useEffect(() => { setPreview(null) }, [filters, mode, templateId, body])

  const optionLabel = (group: Group, option: WhatsAppCampaignOption) => (
    group === 'states' && STATE_LABEL[option.value] ? t(STATE_LABEL[option.value]) : option.value
  )

  const insertVariable = (name: string) => {
    const tag = `{{${name}}}`
    const el = bodyRef.current
    if (!el) {
      setBody((current) => current + tag)
      return
    }
    const start = el.selectionStart ?? body.length
    const end = el.selectionEnd ?? body.length
    const next = body.slice(0, start) + tag + body.slice(end)
    setBody(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + tag.length, start + tag.length)
    })
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    try {
      const res = await whatsappAPI.uploadAttachment(file)
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      setAttachment({ path: res.data.path, name: res.data.name || file.name })
    } finally {
      setUploading(false)
    }
  }

  const runPreview = async () => {
    if (!message) {
      toast.error(t('whatsapp.campaign.messageRequired'))
      return
    }
    setPreviewing(true)
    try {
      const res = await whatsappAPI.previewCampaign({ filters, ...message })
      if (!res.success || !res.data) {
        toast.error(errorText(res, t, 'whatsapp.campaign.createFailed'))
        return
      }
      setPreview(res.data)
    } finally {
      setPreviewing(false)
    }
  }

  const scheduledIso = when === 'schedule' ? localInputToIso(scheduleLocal) : null
  const canCreate = Boolean(preview && preview.counts.reachable > 0 && message && title.trim()
    && (when === 'draft' || scheduledIso))

  const create = async () => {
    if (!canCreate || !message) return
    setSaving(true)
    try {
      const res = await whatsappAPI.createCampaign({
        title: title.trim(),
        filters,
        ...message,
        attachment,
        scheduledAt: scheduledIso
      })
      if (!res.success || !res.data) {
        toast.error(errorText(res, t, 'whatsapp.campaign.createFailed'))
        return
      }
      toast.success(t(when === 'schedule' ? 'whatsapp.campaign.scheduled' : 'whatsapp.campaign.createdDraft', {
        count: res.data.recipients
      }))
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  const templateBody = templates.find((tpl) => String(tpl.id) === templateId)?.body ?? ''

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="campaign-form-title">
      <div className="modal-panel modern-card max-h-[92vh] w-full max-w-3xl overflow-y-auto p-5 sm:p-6" data-testid="campaign-form">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 id="campaign-form-title" className="section-heading mb-1">{t('whatsapp.campaign.new')}</h2>
            <p className="section-description">{t('whatsapp.campaign.newHint')}</p>
          </div>
          <button type="button" className="modern-button-secondary" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <label htmlFor="campaign-title" className="field-label">{t('whatsapp.campaign.titleLabel')}</label>
            <input
              id="campaign-title"
              className="modern-input w-full"
              maxLength={200}
              value={title}
              placeholder={t('whatsapp.campaign.titlePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <fieldset className="space-y-4">
            <legend className="field-label">{t('whatsapp.campaign.audience')}</legend>
            <p className="field-hint -mt-2">{t('whatsapp.campaign.audienceHint')}</p>
            {GROUPS.map(([group, labelKey]) => {
              const list = options?.[group] ?? []
              if (list.length === 0) return null
              return (
                <div key={group}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(labelKey)}</p>
                  <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto">
                    {list.map((option) => {
                      const on = selection[group].includes(option.value)
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={on}
                          className={on ? 'modern-badge-info' : 'modern-badge'}
                          onClick={() => setSelection((current) => ({
                            ...current,
                            [group]: toggleValue(current[group], option.value)
                          }))}
                        >
                          {optionLabel(group, option)} · {option.count}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            <div>
              <label htmlFor="campaign-contracts" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('whatsapp.campaign.filterContracts')}
              </label>
              <textarea
                id="campaign-contracts"
                className="modern-input min-h-20 w-full font-mono text-xs"
                value={contractsText}
                placeholder={t('whatsapp.campaign.contractsPlaceholder')}
                onChange={(event) => setContractsText(event.target.value)}
              />
              {filters.contracts.length > 0 && (
                <p className="field-hint">{t('whatsapp.campaign.contractsCount', { count: filters.contracts.length })}</p>
              )}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="field-label">{t('whatsapp.campaign.message')}</legend>
            <div className="tab-rail" role="tablist">
              {(['text', 'template'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  className="tab-button"
                  data-active={mode === id}
                  aria-selected={mode === id}
                  onClick={() => setMode(id)}
                >
                  {t(id === 'text' ? 'whatsapp.campaign.freeText' : 'whatsapp.campaign.useTemplate')}
                </button>
              ))}
            </div>
            {mode === 'template' ? (
              <div className="space-y-2">
                <select
                  className="modern-input w-full"
                  aria-label={t('whatsapp.campaign.useTemplate')}
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                >
                  <option value="">{t('whatsapp.campaign.pickTemplate')}</option>
                  {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
                </select>
                {templateBody && (
                  <pre className="whitespace-pre-wrap rounded-md border border-border surface-subtle p-3 text-xs text-muted-foreground">{templateBody}</pre>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  ref={bodyRef}
                  className="modern-input min-h-28 w-full"
                  aria-label={t('whatsapp.campaign.message')}
                  value={body}
                  placeholder={t('whatsapp.campaign.bodyPlaceholder')}
                  onChange={(event) => setBody(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  {VARIABLES.map((name) => (
                    <button key={name} type="button" className="modern-button-secondary text-xs" onClick={() => insertVariable(name)}>
                      {`{{${name}}}`}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="field-hint">{t('whatsapp.campaign.variablesHint')}</p>
          </fieldset>

          <div>
            <p className="field-label">{t('whatsapp.campaign.attachment')}</p>
            {attachment ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Icon name="document" size={16} />
                <span className="break-all">{attachment.name}</span>
                <button type="button" className="modern-button-secondary text-xs" onClick={() => setAttachment(null)}>
                  {t('whatsapp.campaign.removeAttachment')}
                </button>
              </div>
            ) : (
              <label className="modern-button-secondary cursor-pointer">
                <Icon name="paperclip" size={16} />
                {uploading ? t('common.loading') : t('whatsapp.campaign.addAttachment')}
                <input
                  type="file"
                  className="sr-only"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  disabled={uploading}
                  onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = '' }}
                />
              </label>
            )}
            <p className="field-hint">{t('whatsapp.campaign.attachmentHint')}</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="field-label">{t('whatsapp.campaign.when')}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="campaign-when" checked={when === 'draft'} onChange={() => setWhen('draft')} />
              {t('whatsapp.campaign.whenDraft')}
            </label>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <input type="radio" name="campaign-when" checked={when === 'schedule'} onChange={() => setWhen('schedule')} />
              {t('whatsapp.campaign.whenSchedule')}
              <input
                type="datetime-local"
                className="modern-input"
                aria-label={t('whatsapp.campaign.whenSchedule')}
                value={scheduleLocal}
                disabled={when !== 'schedule'}
                onChange={(event) => setScheduleLocal(event.target.value)}
              />
            </label>
          </fieldset>

          <div className="space-y-3 rounded-md border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold">{t('whatsapp.campaign.previewTitle')}</p>
              <button type="button" className="modern-button-secondary" disabled={previewing} onClick={() => void runPreview()}>
                <Icon name="eye" size={16} />
                {previewing ? t('common.loading') : t('whatsapp.campaign.preview')}
              </button>
            </div>
            {preview ? (
              <>
                <p className="text-sm" data-testid="campaign-preview-summary">
                  {t('whatsapp.campaign.previewSummary', {
                    reachable: preview.counts.reachable,
                    noPhone: preview.counts.noPhone,
                    optOut: preview.counts.optOut,
                    duplicate: preview.counts.duplicate,
                    incomplete: preview.counts.templateIncomplete
                  })}
                </p>
                {preview.counts.reachable > 0 && perHour > 0 && (
                  <p className="field-hint">
                    {t('whatsapp.campaign.previewDuration', {
                      hours: estimatedHours(preview.counts.reachable, perHour),
                      perHour
                    })}
                  </p>
                )}
                {preview.counts.reachable > preview.max && (
                  <p className="text-sm text-destructive">{t('whatsapp.campaign.overMax', { max: preview.max })}</p>
                )}
                {preview.sample.length > 0 && (
                  <div className="max-h-64 overflow-auto">
                    <table className="modern-table w-full text-sm">
                      <thead>
                        <tr>
                          <th scope="col">{t('whatsapp.inbox.contract')}</th>
                          <th scope="col">{t('whatsapp.campaign.recipient')}</th>
                          <th scope="col">{t('whatsapp.campaign.message')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sample.map((row) => (
                          <tr key={row.contract}>
                            <td className="font-mono text-xs">{row.contract}</td>
                            <td><ContactLink contract={row.contract} name={row.clientName} /></td>
                            <td className="whitespace-pre-wrap text-xs text-muted-foreground">{row.body}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <p className="field-hint">{t('whatsapp.campaign.previewRequired')}</p>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" disabled={!canCreate || saving} onClick={() => void create()}>
            <Icon name={when === 'schedule' ? 'bell' : 'check'} size={16} />
            {t(when === 'schedule' ? 'whatsapp.campaign.createScheduled' : 'whatsapp.campaign.createDraft')}
          </button>
        </div>
      </div>
    </div>
  )
}
