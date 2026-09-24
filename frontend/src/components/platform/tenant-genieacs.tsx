'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  platformAPI,
  type GenieAcsAuthType,
  type Tenant,
  type TenantGenieAcs as TenantGenieAcsData
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

interface Props {
  tenant: Tenant
}

const AUTH_LABELS: Record<GenieAcsAuthType, TranslationKey> = {
  none: 'settings.genieAuth.typeNone',
  basic: 'settings.genieAuth.typeBasic',
  bearer: 'settings.genieAuth.typeBearer'
}

/**
 * Para onde o painel deste provedor fala com o GenieACS, e com que credencial.
 *
 * No console e não na tela do provedor, pela mesma razão do gateway: quem
 * hospeda o ACS é a plataforma, e um provedor que pudesse apontar o próprio
 * painel para qualquer endereço usaria o painel como ponte para dentro da rede
 * da plataforma. Ele continua vendo o endereço e testando a conexão.
 *
 * O segredo nunca volta do servidor: o campo vazio mantém o guardado, e apagar
 * é um pedido explícito — a mesma regra da tela do provedor.
 */
export function TenantGenieAcs({ tenant }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const [data, setData] = useState<TenantGenieAcsData | null>(null)
  const [url, setUrl] = useState('')
  const [authType, setAuthType] = useState<GenieAcsAuthType>('none')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const preencher = useCallback((next: TenantGenieAcsData) => {
    setData(next)
    setUrl(next.url)
    setAuthType(next.auth.authType)
    setUsername(next.auth.username)
    setSecret('')
    setClearSecret(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    void platformAPI.getTenantGenieAcs(tenant.id).then((res) => {
      if (cancelled) return
      if (res.success && res.data) preencher(res.data)
      else toast.error(res.message || t('platform.genieacs.loadFailed'))
    })
    return () => { cancelled = true }
    // `toast` e `t` mudam de identidade a cada render; recarregar por isso
    // apagaria o que a pessoa está digitando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id, preencher])

  const salvar = async () => {
    if (authType === 'basic' && !username.trim()) {
      toast.error(t('settings.genieAuth.usernameRequired'))
      return
    }
    setSaving(true)
    try {
      const res = await platformAPI.updateTenantGenieAcs(tenant.id, {
        url: url.trim(),
        authType,
        username: username.trim(),
        ...(clearSecret ? { secret: '' } : secret ? { secret } : {})
      })
      if (res.success && res.data) {
        preencher(res.data)
        toast.success(t('platform.genieacs.saved', { provider: tenant.name }))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const testar = async () => {
    setTesting(true)
    setTestMessage(null)
    try {
      // Sem endereço no corpo testa o gravado, com a credencial gravada. Um
      // endereço diferente do gravado vai sem credencial — a mesma regra do
      // teste na tela do provedor.
      const digitado = url.trim()
      const res = await platformAPI.testTenantGenieAcs(tenant.id, digitado && digitado !== data?.url ? digitado : undefined)
      setTestMessage({ ok: res.success, text: res.message || (res.success ? t('settings.general.connectionOk') : t('platform.saveFailed')) })
    } finally {
      setTesting(false)
    }
  }

  if (!data) {
    return <p className="py-3 text-sm text-muted-foreground">{t('common.loading')}</p>
  }

  return (
    <div className="space-y-4 py-3">
      <div>
        <h3 className="font-semibold text-foreground">{t('platform.genieacs.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.description')}</p>
      </div>

      <div>
        <label htmlFor={`tenant-${tenant.id}-acs-url`} className="block text-sm font-medium mb-1">
          {t('settings.general.genieAcsUrl')}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`tenant-${tenant.id}-acs-url`}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="modern-input flex-1 font-mono"
            placeholder={data.suggestion || 'http://acs.exemplo.com:7557'}
            autoComplete="off"
          />
          {data.suggestion && data.suggestion !== url && (
            <button type="button" className="modern-button-secondary" onClick={() => setUrl(data.suggestion || '')}>
              {t('platform.genieacs.useSuggestion')}
            </button>
          )}
        </div>
        <p className="field-hint">{t('settings.general.urlHint', { path: '/devices' })}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label htmlFor={`tenant-${tenant.id}-acs-auth`} className="block text-sm font-medium mb-1">
            {t('settings.genieAuth.type')}
          </label>
          <select
            id={`tenant-${tenant.id}-acs-auth`}
            className="modern-input w-full"
            value={authType}
            onChange={(e) => setAuthType(e.target.value as GenieAcsAuthType)}
          >
            {data.auth.authTypes.filter((type) => AUTH_LABELS[type]).map((type) => (
              <option key={type} value={type}>{t(AUTH_LABELS[type])}</option>
            ))}
          </select>
        </div>
        {authType === 'basic' && (
          <div>
            <label htmlFor={`tenant-${tenant.id}-acs-user`} className="block text-sm font-medium mb-1">
              {t('settings.genieAuth.username')}
            </label>
            <input
              id={`tenant-${tenant.id}-acs-user`}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="modern-input w-full"
              autoComplete="off"
            />
          </div>
        )}
        {authType !== 'none' && (
          <div>
            <label htmlFor={`tenant-${tenant.id}-acs-secret`} className="block text-sm font-medium mb-1">
              {t(authType === 'basic' ? 'settings.genieAuth.password' : 'settings.genieAuth.token')}
            </label>
            <input
              id={`tenant-${tenant.id}-acs-secret`}
              type="password"
              autoComplete="new-password"
              value={secret}
              disabled={clearSecret}
              onChange={(e) => setSecret(e.target.value)}
              className="modern-input w-full"
              placeholder={t(data.auth.secretConfigured
                ? 'settings.genieAuth.placeholderStored'
                : 'settings.genieAuth.placeholderEmpty')}
            />
            {data.auth.secretConfigured && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} />
                {t('settings.genieAuth.clear')}
              </label>
            )}
          </div>
        )}
      </div>

      {testMessage && (
        <p className={`flex items-center gap-2 text-sm ${testMessage.ok ? 'text-[hsl(var(--status-success))]' : 'text-[hsl(var(--status-danger))]'}`}>
          <Icon name={testMessage.ok ? 'check' : 'x'} size={16} />
          {testMessage.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void salvar()} disabled={saving} className="modern-button">
          {saving ? t('common.saving') : t('platform.data.save')}
        </button>
        <button type="button" onClick={() => void testar()} disabled={testing || !url.trim()} className="modern-button-secondary">
          {testing ? t('settings.general.testing') : t('settings.general.testConnection')}
        </button>
      </div>
    </div>
  )
}
