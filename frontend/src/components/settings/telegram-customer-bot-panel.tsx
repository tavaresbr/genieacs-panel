'use client'

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { telegramChatAPI, type TelegramChatBot, type TelegramNoticeKind, type TelegramNoticeSettings } from '@/lib/api'
import { telegramChatErrorKey } from '@/lib/telegram-chat'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * O bot do Telegram dos CLIENTES: outro bot que o da equipe (um token tem um
 * webhook só). O token nunca volta do servidor: o campo vazio não troca nada, e
 * remover é um botão próprio. Ligar e desligar agem na hora.
 */
export function TelegramCustomerBotPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [bot, setBot] = useState<TelegramChatBot | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [notices, setNotices] = useState<TelegramNoticeSettings | null>(null)

  const load = useCallback(async () => {
    const res = await telegramChatAPI.getBot()
    if (res.success && res.data) setBot(res.data)
    else toast.error(t(telegramChatErrorKey(res.code)))
  }, [t, toast])

  const loadNotices = useCallback(async () => {
    const res = await telegramChatAPI.getNotices()
    if (res.success && res.data) setNotices(res.data)
  }, [])

  useEffect(() => {
    void load()
    void loadNotices()
  }, [load, loadNotices])

  const toggleNotice = async (kind: TelegramNoticeKind, value: boolean) => {
    setBusy(true)
    try {
      const res = await telegramChatAPI.saveNotices({ [kind]: value })
      if (res.success && res.data) {
        setNotices(res.data)
        toast.success(t('common.success'))
      } else {
        toast.error(t(telegramChatErrorKey(res.code)))
      }
    } finally {
      setBusy(false)
    }
  }

  const run = async (action: () => Promise<{ success: boolean; data?: TelegramChatBot; code?: string }>, after?: () => void) => {
    setBusy(true)
    try {
      const res = await action()
      if (res.success && res.data) {
        setBot(res.data)
        after?.()
        toast.success(t('common.success'))
      } else {
        toast.error(t(telegramChatErrorKey(res.code)))
      }
    } finally {
      setBusy(false)
    }
  }

  if (!bot) return null

  return (
    <fieldset className="space-y-3 rounded-md border border-border p-4">
      <legend className="mb-3 px-1 text-sm font-semibold text-foreground">{t('telegramChat.bot.title')}</legend>
      <p className="text-sm text-muted-foreground">{t('telegramChat.bot.hint')}</p>
      <div>
        <label htmlFor="tg-customer-token" className="field-label">{t('whatsapp.alerts.telegramToken')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="tg-customer-token"
            type="password"
            autoComplete="off"
            className="modern-input min-w-0 flex-1 font-mono text-sm"
            value={token}
            placeholder={bot.configured ? t('whatsapp.alerts.telegramTokenStored') : '123456789:AA…'}
            onChange={(event) => setToken(event.target.value)}
          />
          <button
            type="button"
            className="modern-button"
            disabled={busy || !token.trim()}
            onClick={() => void run(() => telegramChatAPI.saveBot(token.trim()), () => setToken(''))}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
      {bot.configured && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold" role="status">
            {bot.enabled
              ? t('telegramChat.bot.statusOn', { username: bot.botUsername ?? '' })
              : `@${bot.botUsername ?? ''}`}
          </span>
          <button
            type="button"
            className="modern-button-secondary"
            disabled={busy}
            onClick={() => void run(bot.enabled ? telegramChatAPI.disable : telegramChatAPI.enable)}
          >
            {bot.enabled ? t('telegramChat.bot.disable') : t('telegramChat.bot.enable')}
          </button>
          <button
            type="button"
            className="text-xs font-semibold text-primary hover:underline max-sm:min-h-10"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('telegramChat.bot.removeConfirm'))) void run(telegramChatAPI.disconnect)
            }}
          >
            {t('telegramChat.bot.remove')}
          </button>
          {bot.enabled && (
            <Link to="/telegram-chat" className="text-sm font-semibold text-primary hover:underline">
              {t('sidebar.nav.telegramChat')}
            </Link>
          )}
        </div>
      )}
      {bot.webhookError && <p className="field-hint" role="alert">{bot.webhookError}</p>}

      {/* Quais avisos saem TAMBÉM pelo Telegram (o WhatsApp não muda). Só chegam a quem vinculou o Telegram e não mandou /parar. */}
      {notices && (
        <div className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm font-semibold">{t('telegramChat.notices.title')}</h4>
          <p className="field-hint">{t('telegramChat.notices.hint')}</p>
          {(['outage', 'maintenance', 'billing', 'campaign'] as const).map((kind) => (
            <label key={kind} className="flex cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                checked={notices[kind]}
                disabled={busy}
                onChange={(event) => void toggleNotice(kind, event.target.checked)}
              />
              <span>{t(`telegramChat.notices.${kind}`)}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}

export default TelegramCustomerBotPanel
