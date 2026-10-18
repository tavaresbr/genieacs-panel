'use client'

import { useEffect, useState } from 'react'
import { platformAPI } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

const MOTIVOS = ['auth', 'connection', 'timeout', 'tls', 'rejected'] as const
type Motivo = typeof MOTIVOS[number]

const ROTULO_MOTIVO = {
  auth: 'platform.mail.reason.auth',
  connection: 'platform.mail.reason.connection',
  timeout: 'platform.mail.reason.timeout',
  tls: 'platform.mail.reason.tls',
  rejected: 'platform.mail.reason.rejected',
  unknown: 'platform.mail.reason.unknown'
} as const

/**
 * Configurações → E-mail: prova o SMTP do deploy (`SMTP_URL` e `MAIL_FROM`, no
 * `.env`) mandando uma mensagem de verdade. O destino começa no e-mail de
 * avisos de Dados do SaaS; quando o envio falha, a tela diz o motivo (senha,
 * conexão, remetente), que é o que o log do servidor diria.
 */
export function PlatformMailSettings() {
  const { t } = useTranslation()
  const toast = useToast()
  const [destino, setDestino] = useState('')
  const [testando, setTestando] = useState(false)
  const [resultado, setResultado] = useState<{ ok: boolean; mensagem: string } | null>(null)

  useEffect(() => {
    let vivo = true
    platformAPI.getPlatformProfile().then((res) => {
      if (vivo && res.success && res.data?.values?.notifyEmail) {
        setDestino((atual) => atual || res.data!.values.notifyEmail || '')
      }
    }).catch(() => {})
    return () => { vivo = false }
  }, [])

  const testar = async (e: React.FormEvent) => {
    e.preventDefault()
    setTestando(true)
    setResultado(null)
    try {
      const res = await platformAPI.testPlatformMail(destino.trim() || undefined)
      let mensagem: string
      if (res.success) {
        mensagem = t('platform.mail.sent')
      } else if (res.code === 'not_configured') {
        mensagem = t('platform.mail.notConfigured')
      } else if (res.code === 'invalid_email') {
        mensagem = t('platform.mail.invalidEmail')
      } else if (res.code === 'send_failed') {
        const motivo = (MOTIVOS as readonly string[]).includes(res.reason ?? '') ? (res.reason as Motivo) : 'unknown'
        mensagem = `${t('platform.mail.failed')} ${t(ROTULO_MOTIVO[motivo])}`
      } else {
        mensagem = t('platform.mail.failed')
      }
      setResultado({ ok: res.success, mensagem })
      if (res.success) toast.success(t('platform.mail.sent'))
    } catch {
      setResultado({ ok: false, mensagem: t('platform.mail.failed') })
    } finally {
      setTestando(false)
    }
  }

  return (
    <form onSubmit={testar} className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('platform.settings.mail')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.mail.description')}</p>
      </div>

      <section className="rounded-md border border-border p-4 sm:p-5">
        <label className="block text-sm font-medium text-foreground" htmlFor="mail-test-to">
          {t('platform.mail.to')}
        </label>
        <input
          id="mail-test-to"
          type="email"
          value={destino}
          onChange={(e) => setDestino(e.target.value)}
          placeholder="voce@exemplo.com"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm sm:max-w-md"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('platform.mail.toHint')}</p>
        <div className="mt-4">
          <button type="submit" disabled={testando} className="modern-button">
            {testando ? t('platform.mail.testing') : t('platform.mail.test')}
          </button>
        </div>
        {resultado && (
          <p className={`mt-4 text-sm ${resultado.ok ? 'alert-success' : 'alert-error'}`} role="status">
            {resultado.mensagem}
          </p>
        )}
      </section>
    </form>
  )
}

export default PlatformMailSettings
