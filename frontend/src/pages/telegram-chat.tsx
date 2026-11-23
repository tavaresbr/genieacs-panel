'use client'

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { telegramChatAPI, type TelegramChatBot } from '@/lib/api'
import { TelegramChatInbox } from '@/components/telegram-chat/inbox'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/**
 * O Telegram dos clientes: a caixa de entrada. O bot (token, ligar) se
 * configura em Configuração → Integrações → Telegram. Usa as mesmas
 * capacidades do WhatsApp e do Messenger — ler a caixa (`whatsapp.read`) e
 * responder (`whatsapp.send`) —, porque o atendimento é um só.
 */
export default function TelegramChatPage() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const [bot, setBot] = useState<TelegramChatBot | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await telegramChatAPI.getBot()
      if (res.success && res.data) setBot(res.data)
    })()
  }, [])

  return (
    <div className="space-y-4">
      <h1 className="sr-only">{t('sidebar.nav.telegramChat')}</h1>
      <TelegramChatInbox canSend={can('whatsapp.send')} botOn={Boolean(bot?.enabled)} />
      {can('whatsapp.config') && (
        <p className="field-hint">
          <Link to="/settings?tab=telegram" className="font-semibold text-primary hover:underline">
            {t('telegramChat.bot.title')}
          </Link>
        </p>
      )}
    </div>
  )
}
