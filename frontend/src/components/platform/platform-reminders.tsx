'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  platformAPI,
  type PlatformProfile,
  type ReminderChannel,
  type ReminderPolicy,
  type ReminderStep,
  type ReminderStepKind
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import {
  REMINDER_BODY_MAX,
  REMINDER_CHANNELS,
  REMINDER_KINDS,
  REMINDER_MAX_STEPS,
  REMINDER_OFFSETS,
  REMINDER_SUBJECT_MAX,
  REMINDER_VARIABLES,
  insertVariable,
  newStep,
  offsetForKind,
  renderReminderTemplate,
  sampleValues,
  samePolicy,
  sortSteps,
  validateReminderPolicy,
  type ReminderStepError,
  type ReminderVariable
} from '@/lib/reminder-policy'

const ROTULO_CANAL = { whatsapp: 'platform.alerts.channel.whatsapp', email: 'platform.alerts.channel.email' } as const
const ROTULO_TIPO = {
  before: 'platform.reminders.kind.before',
  due: 'platform.reminders.kind.due',
  after: 'platform.reminders.kind.after'
} as const
const ROTULO_VARIAVEL = {
  empresa: 'platform.reminders.var.empresa',
  valor: 'platform.reminders.var.valor',
  vencimento: 'platform.reminders.var.vencimento',
  link: 'platform.reminders.var.link',
  plano: 'platform.reminders.var.plano'
} as const
const ROTULO_ERRO = {
  invalid_policy: 'platform.reminders.error.invalidPolicy',
  too_many_steps: 'platform.reminders.error.tooManySteps',
  invalid_step_id: 'platform.reminders.error.invalidStepId',
  duplicate_step_id: 'platform.reminders.error.duplicateStepId',
  invalid_offset: 'platform.reminders.error.invalidOffset',
  invalid_channels: 'platform.reminders.error.invalidChannels',
  subject_too_long: 'platform.reminders.error.subjectTooLong',
  body_too_long: 'platform.reminders.error.bodyTooLong'
} as const
type CodigoErro = keyof typeof ROTULO_ERRO

/** O passo na tela: com uma chave estável, porque o id é editável. */
type Rascunho = ReminderStep & { chave: number }

let proximaChave = 1
const comChave = (steps: ReminderStep[]): Rascunho[] => steps.map((s) => ({ ...s, chave: proximaChave++ }))
const semChave = (passos: Rascunho[]): ReminderPolicy => ({
  steps: passos.map(({ chave: _chave, ...passo }) => passo)
})

/**
 * Configurações → Régua de cobrança (0121): os passos que avisam o provedor
 * antes, no dia e depois do vencimento — dias, canais e textos —, com a
 * pré-visualização em dados de exemplo e o "Enviar teste para mim" (para os
 * destinos de avisos de Dados do SaaS). Vai no perfil da plataforma
 * (`reminderPolicy`); quem valida de verdade é o servidor.
 */
export function PlatformReminderPolicy() {
  const { t } = useTranslation()
  const toast = useToast()
  const [perfil, setPerfil] = useState<PlatformProfile | null>(null)
  const [passos, setPassos] = useState<Rascunho[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)
  const [testando, setTestando] = useState<string | null>(null)
  // O último campo de texto focado em cada passo: é nele que a variável entra.
  const foco = useRef<Map<number, { campo: 'subject' | 'body'; el: HTMLInputElement | HTMLTextAreaElement }>>(new Map())

  const aplicar = useCallback((dados: PlatformProfile) => {
    setPerfil(dados)
    setPassos(comChave(dados.reminderPolicy?.steps ?? []))
  }, [])

  useEffect(() => {
    let vivo = true
    platformAPI.getPlatformProfile().then((res) => {
      if (!vivo) return
      if (res.success && res.data?.reminderPolicy) aplicar(res.data)
      else setErro(res.message || t('platform.reminders.loadFailed'))
    }).catch(() => { if (vivo) setErro(t('platform.reminders.loadFailed')) })
    return () => { vivo = false }
  }, [aplicar, t])

  const mudar = (chave: number, patch: Partial<ReminderStep>) => {
    setPassos((atual) => atual.map((p) => (p.chave === chave ? { ...p, ...patch } : p)))
  }

  const mudarTipo = (passo: Rascunho, kind: ReminderStepKind) => {
    mudar(passo.chave, { kind, offsetDays: offsetForKind(kind, passo.offsetDays) })
  }

  const mudarDias = (passo: Rascunho, texto: string) => {
    const n = Number.parseInt(texto, 10)
    if (!Number.isFinite(n)) return
    mudar(passo.chave, { offsetDays: passo.kind === 'before' ? -Math.abs(n) : Math.abs(n) })
  }

  const alternarCanal = (passo: Rascunho, canal: ReminderChannel) => {
    const tem = passo.channels.includes(canal)
    const channels = REMINDER_CHANNELS.filter((c) => (c === canal ? !tem : passo.channels.includes(c)))
    mudar(passo.chave, { channels })
  }

  const inserir = (passo: Rascunho, variavel: ReminderVariable) => {
    const alvo = foco.current.get(passo.chave)
    const campo = alvo?.campo ?? 'body'
    const posicao = alvo?.el ? alvo.el.selectionStart : null
    const { text, caret } = insertVariable(passo[campo], variavel, posicao)
    mudar(passo.chave, { [campo]: text })
    if (alvo?.el) {
      requestAnimationFrame(() => {
        alvo.el.focus()
        alvo.el.setSelectionRange(caret, caret)
      })
    }
  }

  const mensagemDeErro = (codigo: string | undefined, indice: number | null | undefined, reserva: string) => {
    const chave = codigo && codigo in ROTULO_ERRO ? ROTULO_ERRO[codigo as CodigoErro] : null
    if (!chave) return reserva
    return typeof indice === 'number'
      ? t('platform.reminders.errorAt', { n: indice + 1, error: t(chave) })
      : t(chave)
  }

  const salvo = perfil?.reminderPolicy ?? null
  const rascunho = semChave(passos)
  const sujo = !samePolicy(rascunho, salvo)

  const salvar = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!perfil) return
    const ordenada: ReminderPolicy = { steps: sortSteps(rascunho.steps) }
    const local: { code: ReminderStepError; index: number | null } | null = validateReminderPolicy(ordenada)
    if (local) {
      toast.error(mensagemDeErro(local.code, local.index, t('platform.reminders.saveFailed')))
      return
    }
    if (!sujo) {
      toast.success(t('platform.profile.nothingChanged'))
      return
    }
    setSalvando(true)
    try {
      const res = await platformAPI.updatePlatformProfile({ reminderPolicy: ordenada })
      if (res.success && res.data) {
        aplicar(res.data)
        toast.success(t('platform.reminders.saved'))
      } else {
        toast.error(mensagemDeErro(res.code, res.index, res.message || t('platform.reminders.saveFailed')))
      }
    } catch {
      toast.error(t('platform.reminders.saveFailed'))
    } finally {
      setSalvando(false)
    }
  }

  const testar = async (stepId: string) => {
    setTestando(stepId)
    try {
      const res = await platformAPI.testReminderPolicy(stepId)
      if (res.success) toast.success(t('platform.reminders.testSent'))
      else if (res.code === 'no_destination') toast.error(t('platform.reminders.noDestination'))
      else toast.error(t('platform.reminders.testFailed'))
    } catch {
      toast.error(t('platform.reminders.testFailed'))
    } finally {
      setTestando(null)
    }
  }

  const restaurar = () => {
    if (perfil?.reminderPolicyDefault) setPassos(comChave(perfil.reminderPolicyDefault.steps))
  }

  if (erro) return <p className="alert-error text-sm">{erro}</p>
  if (!perfil) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>

  const podeSalvar = perfil.canSave
  const semDestino = !perfil.values.notifyWhatsapp && !perfil.values.notifyEmail
  const idsSalvos = new Set((salvo?.steps ?? []).map((s) => s.id))

  return (
    <form onSubmit={salvar} className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('platform.settings.reminders')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.reminders.description')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.reminders.windowHint')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.reminders.issuingHint')}</p>
      </div>

      {!podeSalvar && <p className="alert-warning text-sm">{t('platform.profile.noPlatformBox')}</p>}
      {sujo && <p className="alert-warning text-sm" role="status">{t('platform.reminders.unsaved')}</p>}
      {!passos.length && <p className="alert-warning text-sm">{t('platform.reminders.empty')}</p>}

      <ol className="space-y-4">
        {passos.map((passo, indice) => {
          const faixa = REMINDER_OFFSETS[passo.kind]
          const exemplo = sampleValues(passo.offsetDays)
          const prefixo = `reminder-step-${passo.chave}`
          const assuntoPrevia = passo.subject.trim() ? renderReminderTemplate(passo.subject, exemplo) : null
          const corpoPrevia = passo.body.trim() ? renderReminderTemplate(passo.body, exemplo) : null
          const testavel = !sujo && idsSalvos.has(passo.id)
          return (
            <li key={passo.chave} className="rounded-md border border-border p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-semibold text-foreground">{t('platform.reminders.step', { n: indice + 1 })}</h3>
                <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={passo.enabled}
                    disabled={!podeSalvar}
                    onChange={(e) => mudar(passo.chave, { enabled: e.target.checked })}
                  />
                  {t('platform.reminders.enabled')}
                </label>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor={`${prefixo}-kind`} className="field-label">{t('platform.reminders.kind')}</label>
                  <select
                    id={`${prefixo}-kind`}
                    className="modern-input w-full min-w-0"
                    value={passo.kind}
                    disabled={!podeSalvar}
                    onChange={(e) => mudarTipo(passo, e.target.value as ReminderStepKind)}
                  >
                    {REMINDER_KINDS.map((k) => <option key={k} value={k}>{t(ROTULO_TIPO[k])}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor={`${prefixo}-days`} className="field-label">{t('platform.reminders.days')}</label>
                  <input
                    id={`${prefixo}-days`}
                    type="number"
                    inputMode="numeric"
                    className="modern-input w-full min-w-0"
                    min={passo.kind === 'before' ? 1 : faixa.min}
                    max={passo.kind === 'before' ? -faixa.min : faixa.max}
                    value={Math.abs(passo.offsetDays)}
                    disabled={!podeSalvar || passo.kind === 'due'}
                    aria-describedby={`${prefixo}-days-hint`}
                    onChange={(e) => mudarDias(passo, e.target.value)}
                  />
                  <p id={`${prefixo}-days-hint`} className="field-hint">
                    {passo.kind === 'before' && t('platform.reminders.daysBefore')}
                    {passo.kind === 'due' && t('platform.reminders.onDueDate')}
                    {passo.kind === 'after' && t('platform.reminders.daysAfter')}
                  </p>
                </div>
                <div>
                  <label htmlFor={`${prefixo}-id`} className="field-label">{t('platform.reminders.id')}</label>
                  <input
                    id={`${prefixo}-id`}
                    className="modern-input w-full min-w-0 font-mono"
                    maxLength={16}
                    value={passo.id}
                    disabled={!podeSalvar}
                    aria-describedby={`${prefixo}-id-hint`}
                    onChange={(e) => mudar(passo.chave, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
                  />
                  <p id={`${prefixo}-id-hint`} className="field-hint">{t('platform.reminders.idHint')}</p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-4" role="group" aria-label={t('platform.reminders.channels')}>
                <span className="text-sm font-medium text-foreground">{t('platform.reminders.channels')}</span>
                {REMINDER_CHANNELS.map((canal) => (
                  <label key={canal} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={passo.channels.includes(canal)}
                      disabled={!podeSalvar}
                      onChange={() => alternarCanal(passo, canal)}
                    />
                    {t(ROTULO_CANAL[canal])}
                  </label>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="space-y-3">
                  <div>
                    <label htmlFor={`${prefixo}-subject`} className="field-label">{t('platform.reminders.subject')}</label>
                    <input
                      id={`${prefixo}-subject`}
                      className="modern-input w-full min-w-0"
                      maxLength={REMINDER_SUBJECT_MAX}
                      value={passo.subject}
                      disabled={!podeSalvar}
                      onFocus={(e) => foco.current.set(passo.chave, { campo: 'subject', el: e.currentTarget })}
                      onChange={(e) => mudar(passo.chave, { subject: e.target.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${prefixo}-body`} className="field-label">{t('platform.reminders.body')}</label>
                    <textarea
                      id={`${prefixo}-body`}
                      className="modern-input min-h-32 w-full min-w-0"
                      maxLength={REMINDER_BODY_MAX}
                      value={passo.body}
                      disabled={!podeSalvar}
                      aria-describedby={`${prefixo}-text-hint`}
                      onFocus={(e) => foco.current.set(passo.chave, { campo: 'body', el: e.currentTarget })}
                      onChange={(e) => mudar(passo.chave, { body: e.target.value })}
                    />
                    <p id={`${prefixo}-text-hint`} className="field-hint">{t('platform.reminders.textHint')}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('platform.reminders.variables')}>
                    <span className="text-xs text-muted-foreground">{t('platform.reminders.variables')}</span>
                    {REMINDER_VARIABLES.map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-foreground hover:bg-muted"
                        title={t(ROTULO_VARIAVEL[v])}
                        disabled={!podeSalvar}
                        onClick={() => inserir(passo, v)}
                      >
                        {`{${v}}`}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="min-w-0 rounded-md bg-muted/40 p-3" aria-live="polite">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('platform.reminders.preview')}</p>
                  <p className="mt-2 break-words text-sm font-semibold text-foreground">
                    {assuntoPrevia ?? <span className="font-normal italic text-muted-foreground">{t('platform.reminders.defaultText')}</span>}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
                    {corpoPrevia ?? <span className="italic text-muted-foreground">{t('platform.reminders.defaultText')}</span>}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="modern-button-secondary"
                  disabled={!testavel || semDestino || testando !== null}
                  onClick={() => void testar(passo.id)}
                >
                  {testando === passo.id ? t('platform.reminders.testing') : t('platform.reminders.test')}
                </button>
                <button
                  type="button"
                  className="modern-button-secondary"
                  disabled={!podeSalvar}
                  onClick={() => setPassos((atual) => atual.filter((p) => p.chave !== passo.chave))}
                >
                  {t('platform.reminders.remove')}
                </button>
                {!testavel && <span className="field-hint">{t('platform.reminders.saveBeforeTest')}</span>}
                {testavel && semDestino && <span className="field-hint">{t('platform.reminders.noDestination')}</span>}
              </div>
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="modern-button-secondary"
          disabled={!podeSalvar || passos.length >= REMINDER_MAX_STEPS}
          onClick={() => setPassos((atual) => [...atual, ...comChave([newStep(atual)])])}
        >
          {t('platform.reminders.add')}
        </button>
        <button type="button" className="modern-button-secondary" disabled={!podeSalvar} onClick={restaurar}>
          {t('platform.reminders.restoreDefault')}
        </button>
        <span className="field-hint">{t('platform.reminders.max', { n: REMINDER_MAX_STEPS })}</span>
      </div>
      <p className="field-hint">{t('platform.reminders.restoreHint')}</p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="modern-button" disabled={salvando || !podeSalvar}>
          {salvando ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  )
}

export default PlatformReminderPolicy
