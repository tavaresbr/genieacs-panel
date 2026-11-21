'use client'

import { useCallback, useEffect, useState } from 'react'
import { whatsappAPI, type TelegramBotStatus } from '@/lib/api'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * Os comandos do bot do Telegram: ligar, gerar o código de vínculo e ver quem
 * está vinculado. O token e o segredo do webhook nunca passam por aqui — o
 * servidor só diz se há bot guardado.
 *
 * Fica separado do formulário dos alertas de propósito: ligar e vincular agem
 * na hora, e não esperam o "Salvar" dos ajustes.
 */
export function TelegramBotPanel({ botSaved }: { botSaved: boolean }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState<TelegramBotStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null)

  const load = useCallback(async () => {
    const res = await whatsappAPI.getTelegramBot()
    if (res.success && res.data) setStatus(res.data)
    else toast.error(t('whatsapp.alerts.telegramCmdLoadFailed'))
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (action: () => Promise<{ success: boolean; data?: TelegramBotStatus; code?: string; message?: string }>) => {
    setBusy(true)
    try {
      const res = await action()
      if (res.success && res.data) setStatus(res.data)
      else toast.error(res.message || whatsappErrorMessage(t, res.code))
    } finally {
      setBusy(false)
    }
  }

  const handleLinkCode = async () => {
    setBusy(true)
    try {
      const res = await whatsappAPI.createTelegramLinkCode()
      if (res.success && res.data) setCode(res.data)
      else toast.error(res.message || whatsappErrorMessage(t, res.code))
    } finally {
      setBusy(false)
    }
  }

  const enabled = Boolean(status?.enabled)
  const expires = code ? new Date(code.expiresAt).toLocaleTimeString() : ''

  return (
    <fieldset className="space-y-3 rounded-md border border-border p-4">
      <legend className="mb-3 px-1 text-sm font-semibold text-foreground">{t('whatsapp.alerts.telegramCmdTitle')}</legend>
      <p className="text-sm text-muted-foreground">{t('whatsapp.alerts.telegramCmdHint')}</p>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold" role="status">
          {enabled ? t('whatsapp.alerts.telegramCmdOn') : t('whatsapp.alerts.telegramCmdOff')}
        </span>
        <button
          type="button"
          className="modern-button-secondary"
          disabled={busy || (!enabled && !botSaved)}
          onClick={() => void run(enabled ? whatsappAPI.disableTelegramBot : whatsappAPI.enableTelegramBot)}
        >
          {enabled ? t('whatsapp.alerts.telegramCmdDisable') : t('whatsapp.alerts.telegramCmdEnable')}
        </button>
        {!enabled && !botSaved && <span className="field-hint">{t('whatsapp.alerts.telegramCmdNeedsBot')}</span>}
      </div>

      {enabled && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void handleLinkCode()}>
              {t('whatsapp.alerts.telegramCmdLinkButton')}
            </button>
            {code && (
              <span className="text-sm">
                {t('whatsapp.alerts.telegramCmdLinkInstructions', { code: code.code, time: expires })}
              </span>
            )}
          </div>

          <div>
            <h4 className="text-sm font-semibold">{t('whatsapp.alerts.telegramCmdLinksTitle')}</h4>
            {status && status.links.length === 0 ? (
              <p className="field-hint">{t('whatsapp.alerts.telegramCmdNoLinks')}</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {status?.links.map((link) => (
                  <li key={link.telegramUserId} className="flex items-center justify-between gap-3">
                    <span>
                      {link.telegramUsername ? `@${link.telegramUsername}` : link.telegramUserId} → {link.username ?? link.userId}
                    </span>
                    <button
                      type="button"
                      className="text-xs font-semibold text-primary hover:underline max-sm:min-h-10"
                      disabled={busy}
                      onClick={() => void run(() => whatsappAPI.unlinkTelegram(link.telegramUserId))}
                    >
                      {t('whatsapp.alerts.telegramCmdUnlink')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </fieldset>
  )
}
