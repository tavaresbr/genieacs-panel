'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type AiKnowledgeItem, type AiKnowledgeKind } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

const KINDS: AiKnowledgeKind[] = ['vantagem', 'objecao', 'faq']
const KIND_KEY: Record<AiKnowledgeKind, TranslationKey> = {
  vantagem: 'settings.chatbot.kbKindVantagem',
  objecao: 'settings.chatbot.kbKindObjecao',
  faq: 'settings.chatbot.kbKindFaq'
}
const KIND_CLASS: Record<AiKnowledgeKind, string> = {
  vantagem: 'modern-badge-success',
  objecao: 'modern-badge-warning',
  faq: 'modern-badge-info'
}

interface Rascunho {
  id: number | null
  kind: AiKnowledgeKind
  title: string
  triggers: string
  answer: string
}

const vazio = (): Rascunho => ({ id: null, kind: 'objecao', title: '', triggers: '', answer: '' })

/** A base de conhecimento da IA de vendas e a lista de onde a empresa atende. */
export function AiKnowledgePanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [itens, setItens] = useState<AiKnowledgeItem[] | null>(null)
  const [rascunho, setRascunho] = useState<Rascunho | null>(null)
  const [lugares, setLugares] = useState<string[]>([])
  const [novoLugar, setNovoLugar] = useState('')
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // Abrir o formulário leva a tela até ele e põe o cursor no título: sem isso, quem edita um
  // item do meio de uma lista longa não vê nada acontecer.
  const abertoId = rascunho === null ? undefined : (rascunho.id ?? 'novo')
  useEffect(() => {
    if (abertoId === undefined) return
    formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    titleRef.current?.focus({ preventScroll: true })
  }, [abertoId])

  const carregar = useCallback(async () => {
    const [lista, config] = await Promise.all([whatsappAPI.listAiKnowledge(), whatsappAPI.getBotConfig()])
    if (lista.success && lista.data) setItens(lista.data)
    else toast.error(lista.message || t('settings.chatbot.kbLoadFailed'))
    if (config.success && config.data) setLugares(config.data.ai.coverage ?? [])
  }, [t, toast])

  useEffect(() => { void carregar() }, [carregar])

  const salvar = async () => {
    if (!rascunho) return
    const input = { kind: rascunho.kind, title: rascunho.title, triggers: rascunho.triggers, answer: rascunho.answer }
    setBusy(true)
    const res = rascunho.id === null
      ? await whatsappAPI.createAiKnowledge(input)
      : await whatsappAPI.updateAiKnowledge(rascunho.id, input)
    setBusy(false)
    if (res.success) { toast.success(t('settings.chatbot.kbSaved')); setRascunho(null); await carregar() }
    else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const alternar = async (item: AiKnowledgeItem) => {
    const res = await whatsappAPI.updateAiKnowledge(item.id, { active: !item.active })
    if (res.success) await carregar()
    else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const apagar = async (item: AiKnowledgeItem) => {
    if (!window.confirm(t('settings.chatbot.kbDeleteConfirm', { name: item.title }))) return
    const res = await whatsappAPI.deleteAiKnowledge(item.id)
    if (res.success) { toast.success(t('settings.chatbot.kbDeleted')); await carregar() }
    else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const gravarLugares = async (proximos: string[]) => {
    const res = await whatsappAPI.updateBotConfig({ ai: { coverage: proximos } })
    if (res.success && res.data) { setLugares(res.data.ai.coverage ?? []); toast.success(t('settings.chatbot.coverageSaved')) }
    else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const adicionarLugar = async () => {
    const nome = novoLugar.trim()
    if (!nome) return
    setNovoLugar('')
    await gravarLugares([...lugares, nome])
  }

  const pendentes = (itens ?? []).filter((i) => i.origin === 'sugerida' && !i.active)
  const demais = (itens ?? []).filter((i) => !(i.origin === 'sugerida' && !i.active))

  const aprovar = async (item: AiKnowledgeItem) => {
    const res = await whatsappAPI.updateAiKnowledge(item.id, { active: true })
    if (res.success) { toast.success(t('settings.chatbot.sugApproved')); await carregar() }
    else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const rejeitar = async (item: AiKnowledgeItem) => {
    if (!window.confirm(t('settings.chatbot.sugRejectConfirm', { name: item.title }))) return
    const res = await whatsappAPI.deleteAiKnowledge(item.id)
    if (res.success) { toast.success(t('settings.chatbot.sugRejected')); await carregar() }
    else toast.error(res.message || whatsappErrorMessage(t, res.code))
  }

  const patch = (parte: Partial<Rascunho>) => setRascunho((atual) => (atual ? { ...atual, ...parte } : atual))

  const formulario = rascunho ? (
    <form ref={formRef} className="grid gap-4 rounded-md border border-border p-4" onSubmit={(event) => { event.preventDefault(); void salvar() }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="kb-kind" className="field-label">{t('settings.chatbot.kbKind')}</label>
          <select id="kb-kind" className="modern-input w-full" value={rascunho.kind} onChange={(e) => patch({ kind: e.target.value as AiKnowledgeKind })}>
            {KINDS.map((k) => <option key={k} value={k}>{t(KIND_KEY[k])}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="kb-title" className="field-label">{t('settings.chatbot.kbItemTitle')}</label>
          <input id="kb-title" ref={titleRef} className="modern-input w-full" maxLength={120} required value={rascunho.title} onChange={(e) => patch({ title: e.target.value })} />
        </div>
      </div>
      {rascunho.kind !== 'vantagem' && (
        <div>
          <label htmlFor="kb-triggers" className="field-label">{t('settings.chatbot.kbTriggers')}</label>
          <input id="kb-triggers" className="modern-input w-full" maxLength={300} value={rascunho.triggers} onChange={(e) => patch({ triggers: e.target.value })} />
          <p className="field-hint">{t('settings.chatbot.kbTriggersHint')}</p>
        </div>
      )}
      <div>
        <label htmlFor="kb-answer" className="field-label">{t('settings.chatbot.kbAnswer')}</label>
        <textarea id="kb-answer" className="modern-input w-full text-sm" rows={3} maxLength={600} required value={rascunho.answer} onChange={(e) => patch({ answer: e.target.value })} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="modern-button" disabled={busy}>{t('settings.chatbot.kbSave')}</button>
        <button type="button" className="modern-button-secondary" onClick={() => setRascunho(null)}>{t('common.cancel')}</button>
      </div>
    </form>
  ) : null

  return (
    <>
      {pendentes.length > 0 && (
        <section className="modern-card p-5 sm:p-6" aria-labelledby="ai-sug-title">
          <h2 id="ai-sug-title" className="section-heading">{t('settings.chatbot.sugTitle')}</h2>
          <p className="field-hint mt-1">{t('settings.chatbot.sugIntro')}</p>
          <ul className="mt-4 grid gap-3">
            {pendentes.map((item) => (rascunho?.id === item.id ? <li key={item.id}>{formulario}</li> : (
              <li key={item.id} className="rounded-md border border-dashed border-border p-3">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span className={`${KIND_CLASS[item.kind]} whitespace-nowrap text-xs`}>{t(KIND_KEY[item.kind])}</span>
                  <span className="wrap-anywhere">{item.title}</span>
                </p>
                {item.triggers && <p className="field-hint wrap-anywhere">{t('settings.chatbot.kbTriggerLabel', { list: item.triggers })}</p>}
                <p className="mt-1 text-sm wrap-anywhere">{item.answer}</p>
                <p className="field-hint mt-1">{t('settings.chatbot.sugReview')}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className="modern-button" onClick={() => void aprovar(item)}>{t('settings.chatbot.sugApprove')}</button>
                  <button type="button" className="modern-button-secondary" onClick={() => setRascunho({ id: item.id, kind: item.kind, title: item.title, triggers: item.triggers, answer: item.answer })}>
                    {t('settings.chatbot.kbEdit')}
                  </button>
                  <button type="button" className="modern-button-secondary" onClick={() => void rejeitar(item)}>{t('settings.chatbot.sugReject')}</button>
                </div>
              </li>
            )))}
          </ul>
        </section>
      )}

      <section className="modern-card p-5 sm:p-6" aria-labelledby="ai-kb-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="ai-kb-title" className="section-heading">{t('settings.chatbot.kbTitle')}</h2>
            <p className="field-hint mt-1">{t('settings.chatbot.kbIntro')}</p>
          </div>
          <button type="button" className="modern-button" disabled={busy} onClick={() => setRascunho(vazio())}>
            {t('settings.chatbot.kbAdd')}
          </button>
        </div>

        {rascunho?.id === null && <div className="mt-4">{formulario}</div>}

        {itens !== null && demais.length === 0 && <p className="mt-4 text-sm text-muted-foreground">{t('settings.chatbot.kbEmpty')}</p>}

        {itens !== null && demais.length > 0 && (
          <ul className="mt-4 divide-y divide-border">
            {demais.map((item) => (rascunho?.id === item.id ? <li key={item.id} className="py-3">{formulario}</li> : (
              <li key={item.id} className={`flex flex-wrap items-start justify-between gap-3 py-3 ${item.active ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className={`${KIND_CLASS[item.kind]} whitespace-nowrap text-xs`}>{t(KIND_KEY[item.kind])}</span>
                    <span className="wrap-anywhere">{item.title}</span>
                    {item.origin === 'exemplo' && <span className="modern-badge-warning whitespace-nowrap text-xs">{t('settings.chatbot.kbExample')}</span>}
                  </p>
                  {item.triggers && <p className="field-hint wrap-anywhere">{t('settings.chatbot.kbTriggerLabel', { list: item.triggers })}</p>}
                  <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">{item.answer}</p>
                  {item.uses > 0 && <p className="field-hint">{t('settings.chatbot.kbUses', { n: String(item.uses) })}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="modern-button-secondary" disabled={item.origin === 'exemplo' && !item.active} onClick={() => void alternar(item)}>
                    {item.active ? t('settings.chatbot.kbDeactivate') : t('settings.chatbot.kbActivate')}
                  </button>
                  <button type="button" className="modern-button-secondary" onClick={() => setRascunho({ id: item.id, kind: item.kind, title: item.title, triggers: item.triggers, answer: item.answer })}>
                    {t('settings.chatbot.kbEdit')}
                  </button>
                  <button type="button" className="modern-button-secondary" onClick={() => void apagar(item)}>{t('settings.chatbot.kbDelete')}</button>
                </div>
              </li>
            )))}
          </ul>
        )}

      </section>

      <section className="modern-card p-5 sm:p-6" aria-labelledby="ai-coverage-title">
        <h2 id="ai-coverage-title" className="section-heading">{t('settings.chatbot.coverageTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.coverageIntro')}</p>
        {lugares.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {lugares.map((lugar) => (
              <li key={lugar} className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-sm">
                <span className="wrap-anywhere">{lugar}</span>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                  aria-label={t('settings.chatbot.coverageRemove', { name: lugar })}
                  onClick={() => void gravarLugares(lugares.filter((l) => l !== lugar))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void adicionarLugar() }}>
          <div className="min-w-0 flex-1">
            <label htmlFor="coverage-new" className="field-label">{t('settings.chatbot.coverageAdd')}</label>
            <input id="coverage-new" className="modern-input w-full" maxLength={80} placeholder={t('settings.chatbot.coveragePlaceholder')} value={novoLugar} onChange={(e) => setNovoLugar(e.target.value)} />
          </div>
          <button type="submit" className="modern-button-secondary">{t('settings.chatbot.coverageAddButton')}</button>
        </form>
      </section>
    </>
  )
}

export default AiKnowledgePanel
