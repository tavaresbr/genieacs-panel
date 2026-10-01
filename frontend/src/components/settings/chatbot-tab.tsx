'use client'

import { useEffect, useMemo, useState } from 'react'
import { whatsappAPI, type BotConfig, type BotHoursDay, type BotMessageKey } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

/** A ordem em que os textos aparecem na tela: do primeiro contato à despedida. */
const MESSAGE_KEYS: BotMessageKey[] = [
  'greeting', 'askDocument', 'notRecognised', 'noOpenInvoice', 'handoffQueued', 'handoff', 'outsideHours'
]

/** Os textos da pesquisa de satisfação, na ordem em que o cliente os recebe. */
const SURVEY_KEYS: BotMessageKey[] = ['surveyQuestion', 'surveyAskComment', 'surveyThanks']

/** Os fusos do Brasil, onde está a base; o gravado entra na lista se for outro. */
const TIMEZONES = [
  'America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Fortaleza', 'America/Recife',
  'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Boa_Vista',
  'America/Rio_Branco', 'America/Noronha'
]

/** Segunda primeiro, domingo por último: como se lê uma semana de trabalho. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

function Caixa({ checked, onChange, title, hint, disabled = false }: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block font-semibold">{title}</span>
        {hint && <span className="mt-1 block text-sm leading-6 text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

/**
 * A aba Chatbot: o que o atendimento automático do WhatsApp diz, o que ele
 * oferece e em que horário a passagem para um humano promete resposta.
 *
 * Os dois interruptores (bot ligado, liberação em confiança) moravam na aba do
 * WhatsApp; continuam guardados lá no servidor, e é daqui que se mexe neles.
 */
export function ChatbotTab() {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const [config, setConfig] = useState<BotConfig | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void whatsappAPI.getBotConfig().then((res) => {
      if (cancelled) return
      if (res.success && res.data) setConfig(res.data)
      else toast.error(res.message || t('settings.chatbot.loadFailed'))
    })
    return () => { cancelled = true }
    // `toast` e `t` mudam de identidade a cada render; recarregar por isso
    // apagaria o que a pessoa está editando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dayName = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'long' })
    // 2023-01-01 foi um domingo: `day` soma dias a partir dele.
    return (day: number) => fmt.format(new Date(Date.UTC(2023, 0, 1 + day, 12)))
  }, [locale])

  if (!config) return <p className="py-3 text-sm text-muted-foreground">{t('common.loading')}</p>

  const patch = (next: Partial<BotConfig>) => setConfig((current) => (current ? { ...current, ...next } : current))
  const setOption = (key: keyof BotConfig['options'], value: boolean) =>
    patch({ options: { ...config.options, [key]: value } })
  const setMessage = (key: BotMessageKey, value: string) =>
    patch({ messages: { ...config.messages, [key]: value } })
  const setDay = (day: number, next: Partial<BotHoursDay>) => patch({
    hours: { ...config.hours, week: config.hours.week.map((d) => (d.day === day ? { ...d, ...next } : d)) }
  })

  const preview = [
    config.messages.greeting || config.defaults.greeting,
    '',
    ...(config.options.invoice ? [`1 — ${t('settings.chatbot.option.invoice')}`] : []),
    ...(config.options.signal ? [`2 — ${t('settings.chatbot.option.signal')}`] : []),
    ...(config.options.human ? [`3 — ${t('settings.chatbot.option.human')}`] : []),
    ...(config.unlockEnabled ? [`4 — ${t('settings.chatbot.option.unlock')}`] : [])
  ].join('\n')

  const campoDeTexto = (key: BotMessageKey, disabled = false) => (
    <div key={key}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={`bot-msg-${key}`} className="text-sm font-medium">
          {t(`settings.chatbot.message.${key}` as TranslationKey)}
        </label>
        {config.messages[key] && !disabled && (
          <button type="button" className="text-sm underline" onClick={() => setMessage(key, '')}>
            {t('settings.chatbot.restoreDefault')}
          </button>
        )}
      </div>
      <textarea
        id={`bot-msg-${key}`}
        className="modern-input w-full text-sm"
        rows={2}
        maxLength={1000}
        disabled={disabled}
        value={config.messages[key]}
        placeholder={config.defaults[key]}
        onChange={(event) => setMessage(key, event.target.value)}
      />
    </div>
  )

  const timezones = TIMEZONES.includes(config.hours.timezone) ? TIMEZONES : [config.hours.timezone, ...TIMEZONES]

  const salvar = async () => {
    setSaving(true)
    try {
      const res = await whatsappAPI.updateBotConfig({
        enabled: config.enabled,
        unlockEnabled: config.unlockEnabled,
        options: config.options,
        messages: config.messages,
        hours: config.hours,
        satisfaction: config.satisfaction
      })
      if (res.success && res.data) {
        setConfig(res.data)
        toast.success(t('settings.chatbot.saved'))
      } else {
        toast.error(res.message || t('settings.chatbot.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid max-w-4xl gap-6">
      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.title')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.description')}</p>
        <div className="mt-4 grid gap-4">
          <Caixa
            checked={config.enabled}
            onChange={(value) => patch({ enabled: value })}
            title={t('settings.whatsapp.botEnabled')}
            hint={t('settings.whatsapp.botEnabledHint')}
          />
          <Caixa
            checked={config.unlockEnabled}
            disabled={!config.enabled}
            onChange={(value) => patch({ unlockEnabled: value })}
            title={t('settings.whatsapp.botUnlockEnabled')}
            hint={t('settings.whatsapp.botUnlockEnabledHint')}
          />
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.optionsTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.optionsHint')}</p>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div className="grid content-start gap-4">
            <Caixa checked={config.options.invoice} onChange={(v) => setOption('invoice', v)} title={t('settings.chatbot.option.invoice')} />
            <Caixa checked={config.options.signal} onChange={(v) => setOption('signal', v)} title={t('settings.chatbot.option.signal')} />
            <Caixa
              checked={config.options.human}
              onChange={(v) => setOption('human', v)}
              title={t('settings.chatbot.option.human')}
              hint={t('settings.chatbot.option.humanHint')}
            />
            <Caixa
              checked={config.options.document}
              onChange={(v) => setOption('document', v)}
              title={t('settings.chatbot.option.document')}
              hint={t('settings.chatbot.option.documentHint')}
            />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">{t('settings.chatbot.preview')}</p>
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3 text-sm leading-6">
              {preview}
            </pre>
          </div>
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.messagesTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.messagesHint')}</p>
        <div className="mt-4 grid gap-5">
          {MESSAGE_KEYS.map((key) => campoDeTexto(key))}
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.surveyTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.surveyHint')}</p>
        <div className="mt-4 grid gap-5">
          <Caixa
            checked={config.satisfaction.enabled}
            onChange={(value) => patch({ satisfaction: { ...config.satisfaction, enabled: value } })}
            title={t('settings.chatbot.surveyEnabled')}
            hint={t('settings.chatbot.surveyEnabledHint')}
          />
          {SURVEY_KEYS.map((key) => campoDeTexto(key, !config.satisfaction.enabled))}
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.hoursTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.hoursHint')}</p>
        <div className="mt-4 grid gap-4">
          <Caixa
            checked={config.hours.enabled}
            onChange={(value) => patch({ hours: { ...config.hours, enabled: value } })}
            title={t('settings.chatbot.hoursEnabled')}
          />
          <div className="max-w-xs">
            <label htmlFor="bot-timezone" className="mb-1 block text-sm font-medium">{t('settings.chatbot.timezone')}</label>
            <select
              id="bot-timezone"
              className="modern-input w-full"
              value={config.hours.timezone}
              disabled={!config.hours.enabled}
              onChange={(event) => patch({ hours: { ...config.hours, timezone: event.target.value } })}
            >
              {timezones.map((tz) => <option key={tz} value={tz}>{tz.replace('America/', '').replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="grid gap-2">
            {DAY_ORDER.map((day) => {
              const regra = config.hours.week.find((d) => d.day === day)
              if (!regra) return null
              const inativo = !config.hours.enabled || regra.closed
              return (
                <div key={day} className="flex flex-wrap items-center gap-3">
                  <span className="w-32 text-sm capitalize">{dayName(day)}</span>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={regra.closed}
                      disabled={!config.hours.enabled}
                      onChange={(event) => setDay(day, { closed: event.target.checked })}
                    />
                    {t('settings.chatbot.closed')}
                  </label>
                  <input
                    type="time"
                    aria-label={`${dayName(day)} — ${t('settings.chatbot.opens')}`}
                    className="modern-input w-32"
                    value={regra.open}
                    disabled={inativo}
                    onChange={(event) => setDay(day, { open: event.target.value })}
                  />
                  <span className="text-sm text-muted-foreground">—</span>
                  <input
                    type="time"
                    aria-label={`${dayName(day)} — ${t('settings.chatbot.closes')}`}
                    className="modern-input w-32"
                    value={regra.close}
                    disabled={inativo}
                    onChange={(event) => setDay(day, { close: event.target.value })}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <div>
        <button type="button" className="modern-button" disabled={saving} onClick={() => void salvar()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

export default ChatbotTab
