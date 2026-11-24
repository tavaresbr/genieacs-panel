'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppAccount, type WhatsAppPurpose } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import {
  SIGNUP_CLOSE_GRACE_MS,
  SIGNUP_POPUP_FEATURES,
  SIGNUP_STATE_REFRESH_MS,
  canRetryCoexistenceSync,
  coexistenceStatus,
  isSignupSuccess,
  parseSignupMessage,
  signupFailureKey,
  signupPopupUrl,
  type SignupPhase,
  type SignupStart
} from '@/lib/wa-embedded-signup'

interface EmbeddedSignupProps {
  /** Coexistência: o número continua no app WhatsApp Business do celular. */
  coexistence: boolean
  onCoexistenceChange: (value: boolean) => void
  /** O que o formulário já tem; vai com o `complete` para o número nascer com eles. */
  label: string
  purpose: WhatsAppPurpose
  /** Self-host: o servidor Evolution e a chave dele. Na plataforma gerenciada, `null`. */
  server: { baseUrl: string; adminKey: string } | null
  onConnected: (account: WhatsAppAccount) => void
  /** O código de erro da API virado em frase (o mapa de erros mora na tela de conexão). */
  errorText: (code?: string) => string
  /** `false` quando a plataforma não configurou o app da Meta: a tela cai no formulário manual. */
  onAvailableChange: (available: boolean) => void
}

/**
 * O botão "Conectar com a Meta".
 *
 * O popup do Embedded Signup roda no domínio cadastrado no app da Meta, que não
 * é o do painel. Aqui só se abre a janela e se escuta a resposta; quem confere o
 * `code`, troca pelo token e cria o número é o servidor (`/complete`).
 */
export function EmbeddedSignup({
  coexistence, onCoexistenceChange, label, purpose, server, onConnected, errorText, onAvailableChange
}: EmbeddedSignupProps) {
  const { t } = useTranslation()
  const [start, setStart] = useState<SignupStart | null>(null)
  const [loading, setLoading] = useState(true)
  const [phase, setPhase] = useState<SignupPhase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)
  const startRef = useRef<SignupStart | null>(null)
  const phaseRef = useRef<SignupPhase>('idle')
  const mounted = useRef(true)
  // O que `complete` leva é o que a pessoa digitou ATÉ o clique; guardado num ref
  // para o ouvinte de mensagens (registrado uma vez) não ler um formulário velho.
  const formRef = useRef({ label, purpose, server })
  const onConnectedRef = useRef(onConnected)
  const errorTextRef = useRef(errorText)
  // Refs lidos pelos ouvintes (registrados uma vez) são atualizados depois do render, não durante.
  useEffect(() => {
    formRef.current = { label, purpose, server }
    onConnectedRef.current = onConnected
    errorTextRef.current = errorText
  })

  const setPhaseBoth = useCallback((next: SignupPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  /** Pede um `state` novo. Cada um vale uma tentativa, então roda de novo a cada uma. */
  const prepare = useCallback(async () => {
    const res = await whatsappAPI.startEmbeddedSignup(window.location.origin)
    if (!mounted.current) return
    setLoading(false)
    if (res.success && res.data?.available) {
      const { appId, configId, state, returnOrigin, signupUrl } = res.data
      const data: SignupStart = { appId, configId, state, returnOrigin, signupUrl }
      startRef.current = data
      setStart(data)
      onAvailableChange(true)
    } else {
      startRef.current = null
      setStart(null)
      // Sem app configurado é a resposta normal da plataforma; só então a tela cai no manual.
      if (res.success) onAvailableChange(false)
    }
  }, [onAvailableChange])

  useEffect(() => {
    mounted.current = true
    void prepare()
    const timer = window.setInterval(() => {
      // Não troca o `state` debaixo de uma tentativa em andamento.
      if (phaseRef.current === 'idle' || phaseRef.current === 'error') void prepare()
    }, SIGNUP_STATE_REFRESH_MS)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [prepare])

  const finish = useCallback((next: SignupPhase, text: string | null) => {
    setMessage(text)
    setPhaseBoth(next)
    // O `state` é de uso único: depois de qualquer desfecho, um novo.
    if (next !== 'done') void prepare()
  }, [prepare, setPhaseBoth])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const current = startRef.current
      if (!current || phaseRef.current !== 'waiting') return
      const result = parseSignupMessage(event, popupRef.current, current.signupUrl, current.state)
      if (!result) return
      if (!isSignupSuccess(result)) {
        finish('error', t(signupFailureKey(result)))
        return
      }
      // O `code` vale 30 s: sai daqui direto para o servidor.
      setPhaseBoth('connecting')
      const form = formRef.current
      void whatsappAPI.completeEmbeddedSignup({
        state: current.state,
        code: result.code,
        wabaId: result.wabaId,
        phoneNumberId: result.phoneNumberId,
        event: result.event,
        ...(form.label ? { label: form.label } : {}),
        purpose: form.purpose,
        ...(form.server?.baseUrl ? { baseUrl: form.server.baseUrl } : {}),
        ...(form.server?.adminKey ? { adminKey: form.server.adminKey } : {})
      }).then((res) => {
        if (!mounted.current) return
        if (!res.success || !res.data) {
          finish('error', errorTextRef.current(res.code))
          return
        }
        finish('done', t('whatsapp.cloud.signup.done'))
        onConnectedRef.current(res.data.account)
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [finish, setPhaseBoth, t])

  // Popup fechado sem resposta = a pessoa desistiu. A mensagem pode estar a caminho, então há uma folga.
  useEffect(() => {
    if (phase !== 'waiting') return undefined
    let closedAt: number | null = null
    const timer = window.setInterval(() => {
      const popup = popupRef.current
      if (!popup || !popup.closed) {
        closedAt = null
        return
      }
      closedAt ??= Date.now()
      if (Date.now() - closedAt >= SIGNUP_CLOSE_GRACE_MS && phaseRef.current === 'waiting') {
        finish('error', t('whatsapp.cloud.signup.cancelled'))
      }
    }, 400)
    return () => window.clearInterval(timer)
  }, [phase, finish, t])

  const open = () => {
    const current = startRef.current
    const url = current ? signupPopupUrl(current, { coexistence }) : null
    if (!url) {
      setMessage(t('whatsapp.cloud.signup.failed'))
      setPhaseBoth('error')
      return
    }
    // Dentro do clique, sem nada assíncrono antes: é o que mantém o popup livre do bloqueio.
    const popup = window.open(url, 'wa-embedded-signup', SIGNUP_POPUP_FEATURES)
    if (!popup) {
      finish('error', t('whatsapp.cloud.signup.popupBlocked'))
      return
    }
    popupRef.current = popup
    setMessage(null)
    setPhaseBoth('waiting')
  }

  if (loading) return <p className="field-hint">{t('whatsapp.cloud.signup.preparing')}</p>
  if (!start) return null

  const busy = phase === 'waiting' || phase === 'connecting'
  return (
    <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-4">
      <div>
        <p className="text-sm font-semibold text-foreground">{t('whatsapp.cloud.signup.title')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('whatsapp.cloud.signup.hint')}</p>
      </div>
      <label className="flex items-start gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          className="mt-1"
          checked={coexistence}
          disabled={busy}
          onChange={(event) => onCoexistenceChange(event.target.checked)}
        />
        <span>
          {t('whatsapp.cloud.signup.coexistence')}
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t('whatsapp.cloud.signup.coexistenceHint')}
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="modern-button" disabled={busy} onClick={open}>
          <Icon name="phone" size={16} />
          {t('whatsapp.cloud.signup.button')}
        </button>
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {phase === 'waiting' && t('whatsapp.cloud.signup.waiting')}
          {phase === 'connecting' && t('whatsapp.cloud.signup.connecting')}
          {phase === 'done' && t('whatsapp.cloud.signup.done')}
        </span>
      </div>
      {phase === 'error' && message && (
        <p role="alert" className="text-xs text-[hsl(var(--status-danger))]">{message}</p>
      )}
    </div>
  )
}

/**
 * A sincronização de contatos e histórico de um número em coexistência.
 *
 * A Meta dá 24 horas, a partir da conexão, e cada tipo de sincronização só pode
 * ser pedido uma vez; o servidor pede sozinho ao concluir o cadastro. Aqui o
 * operador vê em que pé está, quanto falta e, se a Meta recusou, tenta de novo.
 */
export function CoexistenceSync({
  account, onChange
}: { account: WhatsAppAccount; onChange: (account: WhatsAppAccount) => void }) {
  const { t, formatDateTime } = useTranslation()
  const [busy, setBusy] = useState(false)
  // O prazo corre sozinho: reavalia a cada minuto, sem chamar `Date.now()` no render.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const status = coexistenceStatus(account, now)
  if (!status) return null

  const retry = async () => {
    setBusy(true)
    try {
      const res = await whatsappAPI.retryCoexistenceSync(account.id)
      if (res.success && res.data) onChange(res.data.account)
    } finally {
      setBusy(false)
    }
  }

  const tone = status.state === 'ok'
    ? 'text-[hsl(var(--status-success))]'
    : status.state === 'pending' ? 'text-muted-foreground' : 'text-[hsl(var(--status-danger))]'
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/20 p-3" data-testid="coexistence-sync">
      <p className="text-xs font-semibold text-foreground">{t('whatsapp.cloud.sync.title')}</p>
      <p className={`mt-1 text-xs ${tone}`}>
        {status.state === 'ok' && t('whatsapp.cloud.sync.ok')}
        {status.state === 'expired' && t('whatsapp.cloud.sync.expired')}
        {status.state === 'pending' && t('whatsapp.cloud.sync.pending', { hours: status.hoursLeft })}
        {status.state === 'error' && t('whatsapp.cloud.sync.error', {
          reason: status.reason ?? t('common.notAvailable'),
          hours: status.hoursLeft
        })}
      </p>
      {account.metaCoexistenceDeadlineAt && status.state !== 'ok' && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('whatsapp.cloud.sync.deadline', { when: formatDateTime(account.metaCoexistenceDeadlineAt) })}
        </p>
      )}
      {canRetryCoexistenceSync(status) && (
        <button
          type="button"
          className="modern-button-secondary mt-2 min-h-9 px-3 py-1 text-xs"
          disabled={busy}
          onClick={() => void retry()}
        >
          {t('whatsapp.cloud.sync.retry')}
        </button>
      )}
    </div>
  )
}
