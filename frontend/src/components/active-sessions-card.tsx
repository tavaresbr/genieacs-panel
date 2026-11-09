import { useCallback, useEffect, useState } from 'react'
import { apiClient, authAPI, type ActiveSession } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatDate, formatRelativeTime } from '@/lib/utils'

/**
 * "Sessões ativas" (0129): os aparelhos em que esta conta está conectada.
 *
 * Cada linha é uma família do refresh — um login num navegador —, com o
 * aparelho (pelo user agent), o IP, quando entrou e quando foi usada pela
 * última vez. "Encerrar" corta aquele aparelho na hora (o token de acesso dele
 * para de valer na próxima requisição); "Sair de todos" encerra todos,
 * inclusive este, e leva de volta ao login.
 *
 * "Sair" no menu continua encerrando só este aparelho.
 */
/**
 * 127.0.0.1 / ::1 não diz nada sobre o aparelho: é o proxy reverso falando com
 * o painel. Acontece quando o `TRUST_PROXY` não está ligado (ou o proxy não
 * repassa o `X-Forwarded-For`); melhor esconder do que mostrar um IP enganoso.
 */
function ipDeLoopback(ip: string): boolean {
  return /^(::ffff:)?127\./.test(ip) || ip === '::1'
}

export function ActiveSessionsCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const [sessoes, setSessoes] = useState<ActiveSession[] | null>(null)
  const [erro, setErro] = useState(false)
  const [ocupado, setOcupado] = useState<string | null>(null)

  const carregar = useCallback(async () => {
    setErro(false)
    const res = await authAPI.sessions()
    if (res.success && res.data) {
      setSessoes(res.data.sessions)
      setErro(false)
    } else {
      setErro(true)
    }
  }, [])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const encerrar = async (sessao: ActiveSession) => {
    if (sessao.current && !window.confirm(t('settings.sessions.confirmCurrent'))) return
    setOcupado(sessao.id)
    try {
      const res = await authAPI.revokeSession(sessao.id)
      if (!res.success) {
        toast.error(res.message || t('settings.sessions.revokeFailed'))
        return
      }
      toast.success(t('settings.sessions.revoked'))
      if (res.data?.current) {
        apiClient.clearTokens()
        return
      }
      await carregar()
    } finally {
      setOcupado(null)
    }
  }

  const sairDeTodos = async () => {
    if (!window.confirm(t('settings.sessions.confirmAll'))) return
    setOcupado('all')
    try {
      const res = await authAPI.revokeAllSessions()
      if (!res.success) {
        toast.error(res.message || t('settings.sessions.revokeFailed'))
        return
      }
      toast.success(t('settings.sessions.revokedAll'))
      apiClient.clearTokens()
    } finally {
      setOcupado(null)
    }
  }

  return (
    <section
      className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4"
      aria-labelledby="active-sessions-title"
      data-testid="active-sessions"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="active-sessions-title" className="font-semibold text-foreground">{t('settings.sessions.title')}</h3>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('settings.sessions.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => { void sairDeTodos() }}
          disabled={ocupado !== null || !sessoes?.length}
          className="modern-button-secondary shrink-0"
        >
          {t('settings.sessions.revokeAll')}
        </button>
      </div>

      {erro && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-destructive">{t('settings.sessions.loadFailed')}</p>
          <button type="button" className="modern-button-secondary" onClick={() => { void carregar() }}>
            {t('common.retry')}
          </button>
        </div>
      )}
      {!erro && sessoes === null && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {!erro && sessoes?.length === 0 && <p className="text-sm text-muted-foreground">{t('settings.sessions.empty')}</p>}

      {sessoes && sessoes.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border bg-background">
          {sessoes.map((sessao) => (
            <li key={sessao.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                  <span>{sessao.device ?? t('settings.sessions.unknownDevice')}</span>
                  {sessao.current && (
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {t('settings.sessions.current')}
                    </span>
                  )}
                  {sessao.kind === 'console' && (
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('settings.sessions.console')}</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {[
                    sessao.tenantName,
                    sessao.ip && !ipDeLoopback(sessao.ip) ? t('settings.sessions.ip', { ip: sessao.ip }) : null,
                    t('settings.sessions.lastUsed', { when: formatRelativeTime(sessao.lastUsedAt) }),
                    t('settings.sessions.since', { when: formatDate(sessao.createdAt) })
                  ].filter(Boolean).join(' · ')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { void encerrar(sessao) }}
                disabled={ocupado !== null}
                className="modern-button-secondary shrink-0"
              >
                {ocupado === sessao.id ? t('common.saving') : t('settings.sessions.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
