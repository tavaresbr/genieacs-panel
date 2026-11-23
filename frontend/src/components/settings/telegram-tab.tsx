'use client'

import { useCallback, useEffect, useState } from 'react'
import { whatsappAPI, type WhatsAppAlertSettings } from '@/lib/api'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { TelegramBotPanel } from '@/components/whatsapp/telegram-bot-panel'
import { TelegramCustomerBotPanel } from '@/components/settings/telegram-customer-bot-panel'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { telegramCanTest, telegramPatch, type TelegramForm } from '@/lib/alert-telegram'

/**
 * Configuração → Integrações → Telegram: o bot do provedor, o grupo da equipe,
 * o teste de envio e os comandos.
 *
 * O token nunca volta do servidor: o campo vazio mantém o guardado, e remover
 * é um botão próprio (ver `lib/alert-telegram.ts`). Salvar manda só o bloco
 * `telegram`; o servidor mescla sem tocar nas regras e nos destinatários dos
 * alertas.
 */
export function TelegramTab() {
  const { t } = useTranslation()
  const toast = useToast()
  const [stored, setStored] = useState<WhatsAppAlertSettings | null>(null)
  const [form, setForm] = useState<TelegramForm>({ token: '', chatId: '', remove: false })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const seed = (settings: WhatsAppAlertSettings) => {
    setStored(settings)
    setForm({ token: '', chatId: settings.telegram?.chatId ?? '', remove: false })
  }

  const load = useCallback(async () => {
    const res = await whatsappAPI.getAlertSettings()
    if (res.success && res.data) {
      setStored(res.data)
      setForm({ token: '', chatId: res.data.telegram?.chatId ?? '', remove: false })
    } else {
      toast.error(whatsappErrorMessage(t, res.code))
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const patch = (change: Partial<TelegramForm>) => setForm((current) => ({ ...current, ...change }))

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await whatsappAPI.updateAlertSettings({ telegram: telegramPatch(form) })
      if (res.success && res.data) {
        seed(res.data)
        toast.success(res.message || t('common.success'))
        return
      }
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const res = await whatsappAPI.testAlertTelegram()
      if (res.success) {
        toast.success(res.message || t('whatsapp.alerts.telegramTestSent'))
        return
      }
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setTesting(false)
    }
  }

  if (!stored) return null
  const canTest = telegramCanTest(form, stored.telegram)

  return (
    <section className="space-y-6">
      <div>
        <h2 className="section-heading">{t('whatsapp.alerts.telegramTitle')}</h2>
        <p className="section-description">{t('settings.integrations.telegramDesc')}</p>
      </div>

      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="mb-3 px-1 text-sm font-semibold text-foreground">{t('whatsapp.alerts.telegramTitle')}</legend>
        <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
          <li>{t('whatsapp.alerts.telegramStep1')}</li>
          <li>{t('whatsapp.alerts.telegramStep2')}</li>
          <li>{t('whatsapp.alerts.telegramStep3')}</li>
        </ol>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="tg-tab-token" className="field-label">{t('whatsapp.alerts.telegramToken')}</label>
            <input
              id="tg-tab-token"
              type="password"
              autoComplete="off"
              className="modern-input w-full font-mono text-sm"
              value={form.token}
              disabled={form.remove}
              placeholder={stored.telegram?.configured && !form.remove ? t('whatsapp.alerts.telegramTokenStored') : '123456789:AA…'}
              onChange={(event) => patch({ token: event.target.value })}
            />
            {stored.telegram?.configured && (
              <button
                type="button"
                className="mt-1 text-xs font-semibold text-primary hover:underline max-sm:min-h-10"
                onClick={() => patch({ remove: !form.remove, token: '' })}
              >
                {form.remove ? t('whatsapp.alerts.telegramKeep') : t('whatsapp.alerts.telegramRemove')}
              </button>
            )}
          </div>
          <div>
            <label htmlFor="tg-tab-chat" className="field-label">{t('whatsapp.alerts.telegramChat')}</label>
            <input
              id="tg-tab-chat"
              type="text"
              className="modern-input w-full font-mono text-sm"
              value={form.chatId}
              placeholder="-1001234567890"
              onChange={(event) => patch({ chatId: event.target.value })}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="modern-button" disabled={saving} onClick={() => void handleSave()}>
            {t('common.save')}
          </button>
          <button type="button" className="modern-button-secondary" disabled={testing || !canTest} onClick={() => void handleTest()}>
            {t('whatsapp.alerts.telegramTest')}
          </button>
          {!canTest && <span className="field-hint">{t('whatsapp.alerts.telegramSaveFirst')}</span>}
        </div>
      </fieldset>

      {/* Os comandos agem na hora (não esperam o Salvar), por isso ficam num bloco à parte. */}
      <TelegramBotPanel botSaved={Boolean(stored.telegram?.configured)} />

      {/* O bot dos CLIENTES é outro bot, com token e webhook próprios. */}
      <TelegramCustomerBotPanel />
    </section>
  )
}

export default TelegramTab
