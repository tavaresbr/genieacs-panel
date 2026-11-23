'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatRelativeTime } from '@/lib/utils'
import {
  whatsappAPI,
  type WhatsAppAlertRule,
  type WhatsAppAlertSettings
} from '@/lib/api'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { Icon } from '@/components/ui/icon'
import { AlertChannels } from '@/components/whatsapp/alert-channels'
import { RecipientList } from '@/components/whatsapp/recipient-list'
import { TelegramBotPanel } from '@/components/whatsapp/telegram-bot-panel'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { telegramCanTest, telegramPatch, telegramWillNotify, type TelegramForm } from '@/lib/alert-telegram'
import {
  INTERVAL_MAX_MINUTES,
  INTERVAL_MIN_MINUTES,
  isFormDirty,
  minutesToSeconds,
  secondsToMinutes
} from '@/lib/alert-form'

/**
 * The four rules, in the order the service evaluates them, each with the ONE
 * thing this screen exists to keep straight: what its threshold is counting.
 *
 * A form with four boxes all labelled "Threshold" is a form that gets a dBm
 * typed into a minutes field, and the operator never finds out — a threshold
 * of -27 minutes simply means every ONT is offline, forever, at 3 a.m. So the
 * unit sentence is not a tooltip and not a footnote: it sits under its own box,
 * and `step`/`min`/`max` are per rule too so the widget itself refuses most of
 * the confusions the label is warning about.
 *
 * `min`/`max` mirror what `waAlertService` would accept, they do not invent a
 * second opinion:
 *   · rx_power_low is the only NEGATIVE threshold, so it is the only one
 *     without a `min` of 0 — a spinner that cannot reach -27 would be a form
 *     fighting its own default;
 *   · mass_outage floors at 2 because the service floors it at 2
 *     (`Math.max(2, …)`); offering 1 would be offering a number that silently
 *     becomes another one.
 */
const RULES: ReadonlyArray<{
  rule: WhatsAppAlertRule
  icon: string
  label: TranslationKey
  /** Says what the number MEANS — minutes, dBm, °C, or a count of ONTs. */
  hint: TranslationKey
  min?: number
  max?: number
  step: number
}> = [
  {
    rule: 'ont_offline',
    icon: 'power',
    label: 'whatsapp.alerts.ontOffline',
    hint: 'whatsapp.alerts.ontOfflineHint',
    min: 1,
    max: 1440,
    step: 1
  },
  {
    rule: 'rx_power_low',
    icon: 'signal',
    label: 'whatsapp.alerts.rxPowerLow',
    hint: 'whatsapp.alerts.rxPowerLowHint',
    max: 0,
    step: 0.5
  },
  {
    rule: 'temperature_high',
    icon: 'thermometer',
    label: 'whatsapp.alerts.temperatureHigh',
    hint: 'whatsapp.alerts.temperatureHighHint',
    min: 0,
    max: 120,
    step: 1
  },
  {
    rule: 'mass_outage',
    icon: 'warning',
    label: 'whatsapp.alerts.massOutage',
    hint: 'whatsapp.alerts.massOutageHint',
    min: 2,
    max: 500,
    step: 1
  },
  {
    // O limite é a carência em minutos: uma queda que se resolve sozinha
    // antes dela não avisa ninguém.
    rule: 'wa_disconnected',
    icon: 'chat',
    label: 'whatsapp.alerts.waDisconnected',
    hint: 'whatsapp.alerts.waDisconnectedHint',
    min: 0,
    max: 120,
    step: 1
  },
  {
    // Minutos de espera por gente, no horário de atendimento.
    rule: 'wa_waiting',
    icon: 'contacts',
    label: 'whatsapp.alerts.waWaitingRule',
    hint: 'whatsapp.alerts.waWaitingHint',
    min: 1,
    max: 240,
    step: 1
  }
]

/** The service clamps to these; the inputs say so rather than letting the
 *  operator type a number that is quietly replaced on the way in. */
const INTERVAL_MIN_S = 60
const COOLDOWN_MIN_MIN = 1
const COOLDOWN_MAX_MIN = 7 * 24 * 60

/**
 * The form holds STRINGS, not numbers.
 *
 * An emptied box has to survive as "empty" while it is being retyped — a
 * `number` state turns the first keystroke of "-27" into a value, and coercing
 * on every change makes the field impossible to clear.
 *
 * What must NOT survive is an empty box at save time. `WhatsAppAlertSettings`
 * types `threshold` as `number | null` and `waAlertService.normalizeRules`
 * documents `null` as "use the default", but it does not do that: the check is
 * `Number.isFinite(Number(value.threshold))`, and `Number(null)` is `0`, which
 * is finite. So a `null` threshold is stored as ZERO — "alert above 0 °C" is
 * every ONT on the network, forever, at 3 a.m. (`undefined` is what actually
 * reaches the default, because `Number(undefined)` is `NaN`; JSON cannot carry
 * it without dropping the key entirely.)
 *
 * Rather than send a value the service mis-reads, an emptied box is refilled
 * on blur with what the server last said was stored — so the number the
 * operator can see is always the number that is really in force, and clearing
 * a field can never quietly arm every rule at zero.
 */
interface RuleForm {
  enabled: boolean
  threshold: string
  cooldownMinutes: string
}

interface AlertsForm {
  enabled: boolean
  /** Em MINUTOS na tela; a API fala em segundos (`lib/alert-form.ts`). */
  intervalMinutes: string
  digestMinutes: string
  /** Os números de plantão, já normalizados, um por item (`RecipientList`). */
  recipients: string[]
  /** O mesmo, os e-mails. */
  emailRecipients: string[]
  /** O bloco do Telegram — ver `lib/alert-telegram.ts`. */
  telegram: TelegramForm
  rules: Record<WhatsAppAlertRule, RuleForm>
}

function toForm(settings: WhatsAppAlertSettings): AlertsForm {
  const rules = {} as Record<WhatsAppAlertRule, RuleForm>
  for (const { rule } of RULES) {
    const stored = settings.rules?.[rule]
    rules[rule] = {
      enabled: stored?.enabled ?? false,
      threshold: stored?.threshold === null || stored?.threshold === undefined
        ? ''
        : String(stored.threshold),
      cooldownMinutes: stored?.cooldownMinutes === undefined
        ? ''
        : String(stored.cooldownMinutes)
    }
  }
  return {
    enabled: settings.enabled,
    intervalMinutes: secondsToMinutes(settings.intervalSeconds),
    digestMinutes: String(settings.digestMinutes ?? 0),
    recipients: [...(settings.recipients ?? [])],
    emailRecipients: [...(settings.emailRecipients ?? [])],
    // O token nunca vem: o campo começa vazio, que quer dizer "manter".
    telegram: { token: '', chatId: settings.telegram?.chatId ?? '', remove: false },
    rules
  }
}

/**
 * A number, or the fallback when the box holds nothing usable.
 *
 * Never `null` — see the note on `RuleForm` for what the service does with one.
 */
function parseNumber(value: string, fallback: number): number {
  const number = Number(value.trim())
  return value.trim() && Number.isFinite(number) ? number : fallback
}

function parseInteger(value: string, fallback: number): number {
  return Math.round(parseNumber(value, fallback))
}

/**
 * Technical alerts: what the panel watches, and who it wakes.
 *
 * Self-contained — it owns its heading, its own load and its own save — because
 * it is mounted as one tab among several and must not need the page to hold any
 * of its state.
 *
 * Two things on this screen are louder than the rest, and both are about an
 * operator believing the fleet is watched when it is not:
 *
 *  · an EMPTY on-duty list means nothing is sent, however loud the fleet gets.
 *    The dictionary says so in `recipientsHint`, and when the list is actually
 *    empty that sentence is promoted out of the small grey hint into a warning
 *    the eye cannot skip. Enabling with an empty list is refused by the API
 *    (`no_alert_recipients`), so the warning is not a guess about what will
 *    happen.
 *  · "Scan now" is REAL. It runs the sweep against the stored settings and can
 *    put messages on the on-duty phones, so it is never run on mount and never
 *    polled — `waAlertService` already runs itself on its own interval from
 *    `server.js`, and a screen that scanned when it loaded would send alerts
 *    because somebody opened a tab.
 */
export function AlertsPanel() {
  const { t } = useTranslation()
  const toast = useToast()

  const [form, setForm] = useState<AlertsForm | null>(null)
  /**
   * The last settings the SERVER acknowledged, kept beside the form.
   *
   * It is what an emptied box is refilled from, so "empty" is never a value
   * this screen sends — see the note on `RuleForm`.
   */
  const [stored, setStored] = useState<WhatsAppAlertSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  /**
   * The scan's own sentence, as the SERVER rendered it.
   *
   * `whatsapp.alerts.scanDone` — the one line that names {fired} and {cleared}
   * — lives only in the backend dictionary; the browser's `TranslationKey` has
   * no such key, and inventing one here is not this file's call. The API client
   * sends `Accept-Language`, so `res.message` already arrives in the operator's
   * own language; it is kept on screen because a toast that has faded cannot
   * answer "did that do anything?".
   */
  const [scanResult, setScanResult] = useState<string | null>(null)
  /** Quantos avisos a última varredura manual mandou (`data.notified`). */
  const [scanNotified, setScanNotified] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await whatsappAPI.getAlertSettings()
      if (res.success && res.data) {
        setStored(res.data)
        setForm(toForm(res.data))
        return
      }
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(
    () => Boolean(form && stored && isFormDirty(form, toForm(stored))),
    [form, stored]
  )
  // Sair com mudança pendente perde o que foi digitado: o navegador pergunta.
  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const recipients = useMemo(() => form?.recipients ?? [], [form])
  const emailRecipients = useMemo(() => form?.emailRecipients ?? [], [form])
  // Ninguém em canal nenhum: é esse o estado que o aviso grita, e agora são
  // dois canais — um número OU um e-mail já é alguém para acordar.
  const telegramOn = form ? telegramWillNotify(form.telegram, Boolean(stored?.telegram?.configured)) : false
  const noRecipients = recipients.length === 0 && emailRecipients.length === 0 && !telegramOn
  const [testingTelegram, setTestingTelegram] = useState(false)
  const patchTelegram = (patch: Partial<TelegramForm>) => {
    setForm((current) => (current ? { ...current, telegram: { ...current.telegram, ...patch } } : current))
  }
  const mailOff = stored?.mailConfigured === false

  const patchRule = (rule: WhatsAppAlertRule, patch: Partial<RuleForm>) => {
    setForm((current) => (current
      ? { ...current, rules: { ...current.rules, [rule]: { ...current.rules[rule], ...patch } } }
      : current))
  }

  /** What the server last said this rule's threshold and cooldown are. */
  const storedThreshold = (rule: WhatsAppAlertRule): number =>
    stored?.rules?.[rule]?.threshold ?? 0
  const storedCooldown = (rule: WhatsAppAlertRule): number =>
    stored?.rules?.[rule]?.cooldownMinutes ?? COOLDOWN_MIN_MIN

  /**
   * Refills an emptied box on blur with the stored value.
   *
   * Not cosmetic: a box left empty would be sent as a number the service reads
   * as zero, and zero is a threshold that fires on everything. The operator
   * sees the real value come back the moment they leave the field rather than
   * discovering it after a save.
   */
  const restoreThreshold = (rule: WhatsAppAlertRule) => {
    const raw = form?.rules[rule].threshold ?? ''
    if (raw.trim() && Number.isFinite(Number(raw))) return
    patchRule(rule, { threshold: String(storedThreshold(rule)) })
  }

  const restoreCooldown = (rule: WhatsAppAlertRule) => {
    const raw = form?.rules[rule].cooldownMinutes ?? ''
    if (raw.trim() && Number.isFinite(Number(raw))) return
    patchRule(rule, { cooldownMinutes: String(storedCooldown(rule)) })
  }

  const handleSave = async () => {
    if (!form) return
    setSaving(true)
    try {
      const rules = {} as WhatsAppAlertSettings['rules']
      for (const { rule } of RULES) {
        const value = form.rules[rule]
        rules[rule] = {
          enabled: value.enabled,
          // Never `null` and never an empty box — both are stored as 0. The
          // last acknowledged value is the fallback, so a save can only ever
          // keep a threshold or move it somewhere the operator typed.
          threshold: parseNumber(value.threshold, storedThreshold(rule)),
          cooldownMinutes: parseInteger(value.cooldownMinutes, storedCooldown(rule))
        }
      }
      const res = await whatsappAPI.updateAlertSettings({
        enabled: form.enabled,
        intervalSeconds: minutesToSeconds(form.intervalMinutes, stored?.intervalSeconds ?? INTERVAL_MIN_S),
        digestMinutes: Number(form.digestMinutes) || 0,
        recipients,
        emailRecipients,
        telegram: telegramPatch(form.telegram),
        rules
      })
      if (res.success && res.data) {
        setStored(res.data)
        // Re-seeded from the response, never from the form: the service
        // normalises phone numbers, clamps the interval and the cooldowns and
        // substitutes defaults for the boxes left empty, and the operator has
        // to see what was actually stored rather than what they typed.
        setForm(toForm(res.data))
        toast.success(res.message || t('common.success'))
        return
      }
      // The machine `code`, never the `message`: an unknown code degrades to
      // the generic failure. The three refusals that NAME the offending entry
      // are the exception — the server already put the number/address/limit in
      // the sentence, in the operator's language, and a generic "invalid
      // phone" would leave them hunting through a list of twenty.
      const named = res.code === 'invalid_phone' || res.code === 'invalid_email'
        || res.code === 'too_many_recipients'
      toast.error(named && res.message ? res.message : whatsappErrorMessage(t, res.code))
    } finally {
      setSaving(false)
    }
  }

  /** "Testar" de uma linha: o servidor só aceita item já salvo e diz o motivo se não sai. */
  const testRecipient = (channel: 'whatsapp' | 'email') => async (item: string) => {
    const res = await whatsappAPI.testAlertRecipient(channel, item)
    if (res.success) return { ok: true, queued: res.data?.queued === true }
    return { ok: false, reason: whatsappErrorMessage(t, res.code) }
  }

  const handleTelegramTest = async () => {
    setTestingTelegram(true)
    try {
      const res = await whatsappAPI.testAlertTelegram()
      if (res.success) {
        toast.success(res.message || t('whatsapp.alerts.telegramTestSent'))
        return
      }
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setTestingTelegram(false)
    }
  }

  const handleScan = async () => {
    setScanning(true)
    try {
      const res = await whatsappAPI.runAlertScan()
      if (res.success) {
        setScanResult(res.message || t('common.success'))
        setScanNotified(typeof res.data?.notified === 'number' ? res.data.notified : null)
        toast.success(res.message || t('common.success'))
        // Só a hora da última varredura e os canais: o resto do que foi lido
        // não pode desfazer o que a pessoa está digitando no formulário.
        const fresh = await whatsappAPI.getAlertSettings()
        if (fresh.success && fresh.data) {
          const { lastScanAt, channels } = fresh.data
          setStored((current) => (current ? { ...current, lastScanAt, channels } : current))
        }
        return
      }
      setScanResult(null)
      setScanNotified(null)
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setScanning(false)
    }
  }

  return (
    <section className="modern-card max-w-3xl p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-heading">{t('whatsapp.alerts.title')}</h2>
          <p className="section-description">{t('whatsapp.alerts.description')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {dirty && (
            <span className="rounded-full bg-[hsl(var(--status-warning)/0.15)] px-2.5 py-1 text-xs font-medium text-foreground" role="status">
              {t('whatsapp.alerts.unsaved')}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleScan()}
            disabled={loading || scanning || !form}
            className="modern-button-secondary"
          >
            <Icon name="refresh" size={16} className={scanning ? 'animate-spin' : undefined} />
            {t('whatsapp.alerts.runScan')}
          </button>
        </div>
      </div>
      {dirty && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-[hsl(var(--status-warning)/0.45)] bg-[hsl(var(--status-warning)/0.11)] px-3 py-2 text-sm leading-5 text-foreground">
          <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
          <span>{t('whatsapp.alerts.unsavedScanWarning')}</span>
        </p>
      )}

      {loading ? (
        <p className="mt-6 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : !form ? (
        /* The load failed and the toast has faded. Leaving "Loading…" on screen
           forever would say the panel is still trying when it stopped — the
           screen has to admit it has nothing and offer the way out. */
        <div className="mt-6">
          <button type="button" onClick={() => void load()} className="modern-button-secondary">
            <Icon name="refresh" size={16} />
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <>
          {scanResult && (
            <p
              className="mt-5 flex items-start gap-2 rounded-md border border-border bg-[hsl(var(--surface-subtle))] px-3 py-2.5 text-sm text-foreground"
              role="status"
            >
              <Icon name="check" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-success))]" />
              <span>
                {scanResult}
                {scanNotified !== null && <span className="block">{t('whatsapp.alerts.scanNotified', { count: scanNotified })}</span>}
              </span>
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {stored?.lastScanAt
              ? t('whatsapp.alerts.lastScan', { when: formatRelativeTime(new Date(stored.lastScanAt).toISOString()) })
              : t('whatsapp.alerts.neverScanned')}
          </p>

          {stored?.channels && (
            <div className="mt-6">
              <AlertChannels channels={stored.channels} />
            </div>
          )}

          <div className="mt-6 space-y-6">
            <div className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                  checked={form.enabled}
                  onChange={(event) => setForm((current) => (current
                    ? { ...current, enabled: event.target.checked }
                    : current))}
                />
                <span className="block font-semibold">{t('whatsapp.alerts.enable')}</span>
              </label>
            </div>

            <div>
              <label htmlFor="wa-alerts-interval" className="field-label">
                {t('whatsapp.alerts.intervalMinutes')}
              </label>
              <input
                id="wa-alerts-interval"
                type="number"
                inputMode="numeric"
                min={INTERVAL_MIN_MINUTES}
                max={INTERVAL_MAX_MINUTES}
                step={1}
                className="modern-input sm:max-w-48"
                value={form.intervalMinutes}
                onChange={(event) => setForm((current) => (current
                  ? { ...current, intervalMinutes: event.target.value }
                  : current))}
                onBlur={() => setForm((current) => {
                  if (!current) return current
                  const raw = current.intervalMinutes.trim()
                  if (raw && Number.isFinite(Number(raw))) {
                    // O número que vale é o que fica na caixa: 999 vira 60, 0 vira 1.
                    return { ...current, intervalMinutes: String(minutesToSeconds(raw, 60) / 60) }
                  }
                  return { ...current, intervalMinutes: secondsToMinutes(stored?.intervalSeconds ?? INTERVAL_MIN_S) }
                })}
              />
            </div>

            <div>
              <label htmlFor="wa-alerts-digest" className="field-label">
                {t('whatsapp.alerts.digest')}
              </label>
              <select
                id="wa-alerts-digest"
                className="modern-input sm:max-w-64"
                value={form.digestMinutes}
                aria-describedby="wa-alerts-digest-hint"
                onChange={(event) => setForm((current) => (current
                  ? { ...current, digestMinutes: event.target.value }
                  : current))}
              >
                <option value="0">{t('whatsapp.alerts.digestOff')}</option>
                {[5, 10, 15, 30].map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    {t('whatsapp.alerts.digestEvery', { minutes })}
                  </option>
                ))}
              </select>
              <p id="wa-alerts-digest-hint" className="field-hint">
                {t('whatsapp.alerts.digestHint')}
              </p>
            </div>

            {/* ── Who is woken ────────────────────────────────────────────
                The hint is the same sentence either way; where it is drawn is
                not. With nobody on the list it is the loudest thing in this
                block, because "alerts are on" and "somebody will hear about
                it" are two different states and only one of them is visible. */}
            <div>
              <RecipientList
                kind="phone"
                items={form.recipients}
                saved={stored?.recipients ?? []}
                onTest={testRecipient('whatsapp')}
                onChange={(next) => setForm((current) => (current ? { ...current, recipients: next } : current))}
                label={t('whatsapp.alerts.recipients')}
                hintId="wa-alerts-recipients-hint"
                placeholder={t('whatsapp.alerts.rcptPhonePlaceholder')}
              >
              {noRecipients ? (
                <p
                  id="wa-alerts-recipients-hint"
                  role="alert"
                  className="mt-2 flex items-start gap-2 rounded-md border border-[hsl(var(--status-warning)/0.45)] bg-[hsl(var(--status-warning)/0.11)] px-3 py-2.5 text-sm leading-5 text-foreground"
                >
                  <Icon
                    name="warning"
                    size={16}
                    className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]"
                  />
                  <span>{t('whatsapp.alerts.recipientsHint')}</span>
                </p>
              ) : (
                <p id="wa-alerts-recipients-hint" className="field-hint">
                  {t('whatsapp.alerts.recipientsHint')}
                </p>
              )}
              </RecipientList>
            </div>

            {/* ── Os e-mails da equipe ─────────────────────────────────────
                O segundo canal. Sem SMTP no servidor, o campo continua (a lista
                fica guardada para o dia em que houver), mas diz que nada sai. */}
            <div>
              <RecipientList
                kind="email"
                items={form.emailRecipients}
                saved={stored?.emailRecipients ?? []}
                onTest={testRecipient('email')}
                onChange={(next) => setForm((current) => (current ? { ...current, emailRecipients: next } : current))}
                label={t('whatsapp.alerts.emailRecipients')}
                hintId="wa-alerts-emails-hint"
                placeholder="plantao@provedor.com.br"
              >
              {mailOff ? (
                <p
                  id="wa-alerts-emails-hint"
                  className="mt-2 flex items-start gap-2 rounded-md border border-[hsl(var(--status-warning)/0.45)] bg-[hsl(var(--status-warning)/0.11)] px-3 py-2.5 text-sm leading-5 text-foreground"
                >
                  <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
                  <span>{t('whatsapp.alerts.mailNotConfigured')}</span>
                </p>
              ) : (
                <p id="wa-alerts-emails-hint" className="field-hint">
                  {t('whatsapp.alerts.emailRecipientsHint')}
                </p>
              )}
              </RecipientList>
            </div>

            {/* ── O Telegram ─────────────────────────────────────────────
                Um bot do provedor mandando para um grupo da equipe. O token
                nunca volta do servidor: o campo vazio mantém o guardado, e
                remover é um botão próprio. */}
            <fieldset className="space-y-3 rounded-md border border-border p-4">
              <legend className="mb-3 px-1 text-sm font-semibold text-foreground">{t('whatsapp.alerts.telegramTitle')}</legend>
              <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
                <li>{t('whatsapp.alerts.telegramStep1')}</li>
                <li>{t('whatsapp.alerts.telegramStep2')}</li>
                <li>{t('whatsapp.alerts.telegramStep3')}</li>
              </ol>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="wa-alerts-telegram-token" className="field-label">{t('whatsapp.alerts.telegramToken')}</label>
                  <input
                    id="wa-alerts-telegram-token"
                    type="password"
                    autoComplete="off"
                    className="modern-input w-full font-mono text-sm"
                    value={form.telegram.token}
                    disabled={form.telegram.remove}
                    placeholder={stored?.telegram?.configured && !form.telegram.remove ? t('whatsapp.alerts.telegramTokenStored') : '123456789:AA…'}
                    onChange={(event) => patchTelegram({ token: event.target.value })}
                  />
                  {stored?.telegram?.configured && (
                    <button
                      type="button"
                      className="mt-1 text-xs font-semibold text-primary hover:underline max-sm:min-h-10"
                      onClick={() => patchTelegram({ remove: !form.telegram.remove, token: '' })}
                    >
                      {form.telegram.remove ? t('whatsapp.alerts.telegramKeep') : t('whatsapp.alerts.telegramRemove')}
                    </button>
                  )}
                </div>
                <div>
                  <label htmlFor="wa-alerts-telegram-chat" className="field-label">{t('whatsapp.alerts.telegramChat')}</label>
                  <input
                    id="wa-alerts-telegram-chat"
                    type="text"
                    className="modern-input w-full font-mono text-sm"
                    value={form.telegram.chatId}
                    placeholder="-1001234567890"
                    onChange={(event) => patchTelegram({ chatId: event.target.value })}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="modern-button-secondary"
                  disabled={testingTelegram || !telegramCanTest(form.telegram, stored?.telegram)}
                  onClick={() => void handleTelegramTest()}
                >
                  {t('whatsapp.alerts.telegramTest')}
                </button>
                {!telegramCanTest(form.telegram, stored?.telegram) && (
                  <span className="field-hint">{t('whatsapp.alerts.telegramSaveFirst')}</span>
                )}
              </div>
            </fieldset>

            {/* Os comandos do bot agem na hora (não esperam o Salvar), por isso ficam num bloco à parte. */}
            <TelegramBotPanel botSaved={Boolean(stored?.telegram?.configured)} />

            {/* ── The four rules ──────────────────────────────────────────
                One row each, and each row carries its own unit sentence under
                its own threshold box. */}
            <div className="space-y-3">
              {RULES.map(({ rule, icon, label, hint, min, max, step }) => {
                const value = form.rules[rule]
                const thresholdId = `wa-alert-${rule}-threshold`
                const cooldownId = `wa-alert-${rule}-cooldown`
                return (
                  <div key={rule} className="rounded-md border border-border p-4">
                    <label className="flex cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                        checked={value.enabled}
                        onChange={(event) => patchRule(rule, { enabled: event.target.checked })}
                      />
                      <Icon name={icon} size={18} className="shrink-0 text-muted-foreground" />
                      <span className="font-semibold">{t(label)}</span>
                    </label>

                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor={thresholdId} className="field-label">
                          {t('whatsapp.alerts.threshold')}
                        </label>
                        <input
                          id={thresholdId}
                          type="number"
                          min={min}
                          max={max}
                          step={step}
                          className="modern-input w-full"
                          value={value.threshold}
                          aria-describedby={`${thresholdId}-hint`}
                          onChange={(event) => patchRule(rule, { threshold: event.target.value })}
                          onBlur={() => restoreThreshold(rule)}
                        />
                        {/* The whole point of the row: WHAT this number counts. */}
                        <p id={`${thresholdId}-hint`} className="field-hint">{t(hint)}</p>
                      </div>
                      <div>
                        <label htmlFor={cooldownId} className="field-label">
                          {t('whatsapp.alerts.cooldown')}
                        </label>
                        <input
                          id={cooldownId}
                          type="number"
                          inputMode="numeric"
                          min={COOLDOWN_MIN_MIN}
                          max={COOLDOWN_MAX_MIN}
                          step={5}
                          className="modern-input w-full"
                          value={value.cooldownMinutes}
                          aria-describedby={`${cooldownId}-hint`}
                          onChange={(event) => patchRule(rule, { cooldownMinutes: event.target.value })}
                          onBlur={() => restoreCooldown(rule)}
                        />
                        <p id={`${cooldownId}-hint`} className="field-hint">
                          {t('whatsapp.alerts.cooldownHint')}
                        </p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
              className="modern-button"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
            {dirty && <span className="self-center text-sm text-muted-foreground">{t('whatsapp.alerts.unsaved')}</span>}
          </div>
        </>
      )}
    </section>
  )
}

export default AlertsPanel
