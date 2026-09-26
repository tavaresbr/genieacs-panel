'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  platformAPI,
  type GenieAcsAuthType,
  type Tenant,
  type TenantDeviceTagging,
  type TenantGenieAcs as TenantGenieAcsData
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { INSTALLER_VIRTUAL_PARAMETERS, VIRTUAL_PARAMETER_FIELDS } from '@/lib/virtual-parameters'

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
 *
 * A "tag de equipamentos" é o que separa provedores que dividem o mesmo
 * GenieACS: com ela, o painel do provedor só enxerga (e só age em) ONTs que a
 * carregam. A marcação em lote existe para a frota que já estava no ACS antes
 * da tag — sempre com prévia antes de aplicar.
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
  // Os caminhos TR-069 dependem dos scripts instalados no ACS — o da
  // plataforma, na SaaS —, e por isso moram aqui e não na tela do provedor.
  const [vps, setVps] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [deviceTag, setDeviceTag] = useState('')
  const [pppoePrefix, setPppoePrefix] = useState('')
  const [serials, setSerials] = useState('')
  const [tagging, setTagging] = useState(false)
  const [preview, setPreview] = useState<TenantDeviceTagging | null>(null)

  const preencher = useCallback((next: TenantGenieAcsData) => {
    setData(next)
    setUrl(next.url)
    setAuthType(next.auth.authType)
    setUsername(next.auth.username)
    setSecret('')
    setClearSecret(false)
    setVps({ ...next.virtualParameters })
    setDeviceTag(next.deviceTag ?? '')
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
        ...(clearSecret ? { secret: '' } : secret ? { secret } : {}),
        virtualParameters: vps,
        deviceTag: deviceTag.trim()
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

  const marcar = async (apply: boolean) => {
    setTagging(true)
    try {
      const res = await platformAPI.tagTenantDevices(tenant.id, {
        ...(pppoePrefix.trim() ? { pppoePrefix: pppoePrefix.trim() } : {}),
        ...(serials.trim() ? { serials } : {}),
        apply
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('platform.saveFailed'))
        return
      }
      setPreview(apply ? null : res.data)
      if (apply) toast.success(t('platform.genieacs.tagApplied', { count: res.data.tagged }))
    } finally {
      setTagging(false)
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

      <div className="border-t border-border pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-foreground">{t('settings.vp.title')}</h4>
            <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.vpDescription')}</p>
          </div>
          <button
            type="button"
            className="modern-button-secondary shrink-0"
            onClick={() => setVps((atual) => ({ ...atual, ...INSTALLER_VIRTUAL_PARAMETERS }))}
          >
            <Icon name="refresh" size={17} />
            {t('settings.vp.usePreset')}
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {VIRTUAL_PARAMETER_FIELDS.map((field) => (
            <div key={field.key}>
              <label htmlFor={`tenant-${tenant.id}-${field.key}`} className="block text-sm font-medium mb-1">
                {t(field.labelKey)}
              </label>
              <input
                id={`tenant-${tenant.id}-${field.key}`}
                value={vps[field.key] ?? ''}
                placeholder={field.hintKey ? t('settings.vp.optionalPlaceholder') : undefined}
                onChange={(e) => setVps((atual) => ({ ...atual, [field.key]: e.target.value }))}
                className="modern-input w-full font-mono text-sm"
                autoComplete="off"
              />
              <p className="field-hint">{field.hintKey ? t(field.hintKey) : field.parameterName}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <h4 className="font-semibold text-foreground">{t('platform.genieacs.scopeTitle')}</h4>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.scopeDescription')}</p>

        {data.sharedAcs.providers.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
            <Icon
              name="warning"
              size={16}
              className={`mt-0.5 shrink-0 ${data.sharedAcs.missingTag ? 'text-[hsl(var(--status-danger))]' : 'text-[hsl(var(--status-warning))]'}`}
            />
            <div className="text-sm leading-6">
              <p className="font-medium">
                {t(data.sharedAcs.missingTag ? 'platform.genieacs.sharedMissingTag' : 'platform.genieacs.sharedOk')}
              </p>
              <ul className="mt-1 list-disc pl-5">
                {data.sharedAcs.providers.map((p) => (
                  <li key={p.id}>
                    {p.name}: {p.deviceTag
                      ? <span className="font-mono">{p.deviceTag}</span>
                      : <span className="text-[hsl(var(--status-danger))]">{t('platform.genieacs.noTag')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="mt-4 max-w-sm">
          <label htmlFor={`tenant-${tenant.id}-acs-tag`} className="block text-sm font-medium mb-1">
            {t('platform.genieacs.deviceTag')}
          </label>
          <input
            id={`tenant-${tenant.id}-acs-tag`}
            value={deviceTag}
            onChange={(e) => setDeviceTag(e.target.value)}
            className="modern-input w-full font-mono"
            placeholder={(tenant.slug || 'provedor').replace(/-/g, '_')}
            maxLength={64}
            pattern="[A-Za-z0-9_]*"
            autoComplete="off"
          />
          <p className="field-hint">{t('platform.genieacs.deviceTagHint')}</p>
        </div>

        {data.deviceTag && (
          <div className="mt-4 rounded-md border border-border p-4">
            <h5 className="font-medium text-foreground">{t('platform.genieacs.bulkTitle', { tag: data.deviceTag })}</h5>
            <p className="mt-1 text-sm text-muted-foreground">{t('platform.genieacs.bulkDescription')}</p>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label htmlFor={`tenant-${tenant.id}-tag-prefix`} className="block text-sm font-medium mb-1">
                  {t('platform.genieacs.pppoePrefix')}
                </label>
                <input
                  id={`tenant-${tenant.id}-tag-prefix`}
                  value={pppoePrefix}
                  onChange={(e) => { setPppoePrefix(e.target.value); setPreview(null) }}
                  className="modern-input w-full font-mono"
                  placeholder="TA100"
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor={`tenant-${tenant.id}-tag-serials`} className="block text-sm font-medium mb-1">
                  {t('platform.genieacs.serials')}
                </label>
                <textarea
                  id={`tenant-${tenant.id}-tag-serials`}
                  value={serials}
                  onChange={(e) => { setSerials(e.target.value); setPreview(null) }}
                  className="modern-input w-full font-mono text-sm"
                  rows={3}
                  placeholder="ZTEG12345678"
                />
              </div>
            </div>

            {preview && (
              <div className="mt-3 text-sm leading-6">
                <p>{t('platform.genieacs.previewSummary', {
                  matched: preview.matched, toTag: preview.toTag, already: preview.alreadyTagged, conflicts: preview.conflictCount
                })}</p>
                {preview.conflictCount > 0 && (
                  <div className="mt-2">
                    <p className="text-[hsl(var(--status-warning))]">{t('platform.genieacs.conflictsHint')}</p>
                    <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                      {preview.conflicts.map((c) => (
                        <li key={c.id}>{c.serial || c.id}{c.pppoe ? ` · ${c.pppoe}` : ''} → {c.tags.join(', ')}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="modern-button-secondary"
                disabled={tagging || (!pppoePrefix.trim() && !serials.trim())}
                onClick={() => void marcar(false)}
              >
                {t('platform.genieacs.preview')}
              </button>
              {preview && preview.toTag > 0 && (
                <button type="button" className="modern-button" disabled={tagging} onClick={() => void marcar(true)}>
                  {t('platform.genieacs.applyTag', { count: preview.toTag })}
                </button>
              )}
            </div>
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
