'use client'

import { useCallback, useEffect, useState } from 'react'
import { asaasProviderAPI, type AsaasProviderConfig, type AsaasEnvironment } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'

/**
 * Asaas: a conta do PROVEDOR — a que cobra os assinantes dele. Não é a
 * assinatura do painel (essa fica em Plano). Nesta etapa só a conexão: chave
 * da API, ambiente e teste. A chave nunca volta do servidor; o campo em branco
 * mantém a guardada, e "Remover chave" a apaga de propósito.
 */
export function AsaasPanel() {
  const { t, formatDateTime } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const canConfigure = can('asaas.config')

  const [config, setConfig] = useState<AsaasProviderConfig | null>(null)
  const [form, setForm] = useState({ enabled: false, environment: 'sandbox' as AsaasEnvironment, apiKey: '' })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const applyConfig = useCallback((next: AsaasProviderConfig) => {
    setConfig(next)
    setForm({ enabled: next.enabled, environment: next.environment, apiKey: '' })
  }, [])

  useEffect(() => {
    if (!canConfigure) return
    void asaasProviderAPI.getConfig().then((res) => {
      if (res.success && res.data) applyConfig(res.data)
      else toast.error(res.message || t('settings.asaas.loadFailed'))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canConfigure, applyConfig])

  const save = async (clearKey = false) => {
    setSaving(true)
    try {
      const res = await asaasProviderAPI.updateConfig({
        enabled: clearKey ? false : form.enabled,
        environment: form.environment,
        // Em branco mantém a chave guardada; o botão de remover manda "" de propósito.
        ...(clearKey ? { apiKey: '' } : form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.asaas.save'))
        return
      }
      applyConfig(res.data)
      toast.success(clearKey ? t('settings.asaas.keyRemoved') : (res.message || t('settings.asaas.saveFailed')))
    } finally {
      setSaving(false)
    }
  }

  const removeKey = () => {
    if (!confirm(t('settings.asaas.removeKeyConfirm'))) return
    void save(true)
  }

  const runTest = async () => {
    setTesting(true)
    try {
      const res = await asaasProviderAPI.test({
        environment: form.environment,
        apiKey: form.apiKey.trim() || undefined
      })
      if (!res.success) {
        toast.error(res.message || t('settings.asaas.testFailed'))
        return
      }
      toast.success(res.message || t('settings.asaas.statusOn'))
      // O teste da chave guardada grava o nome da conta: relê para mostrá-lo.
      if (!form.apiKey.trim()) {
        const fresh = await asaasProviderAPI.getConfig()
        if (fresh.success && fresh.data) setConfig(fresh.data)
      }
    } finally {
      setTesting(false)
    }
  }

  if (!canConfigure) return null

  return (
    <div className="modern-card max-w-3xl p-5 sm:p-6" data-testid="asaas-panel">
      <p className="page-kicker">{t('settings.asaas.kicker')}</p>
      <h2 className="section-heading">{t('settings.asaas.title')}</h2>
      <p className="section-description mb-6">{t('settings.asaas.description')}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <span className="field-label" id="asaas-env-label">{t('settings.asaas.environment')}</span>
          <div className="flex flex-wrap gap-4" role="radiogroup" aria-labelledby="asaas-env-label">
            {(['production', 'sandbox'] as const).map((environment) => (
              <label key={environment} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="asaas-environment"
                  checked={form.environment === environment}
                  onChange={() => setForm((current) => ({ ...current, environment }))}
                />
                {t(environment === 'production' ? 'settings.asaas.environmentProduction' : 'settings.asaas.environmentSandbox')}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.asaas.environmentHint')}</p>
        </div>

        <div className="sm:col-span-2">
          <label className="field-label" htmlFor="asaas-api-key">{t('settings.asaas.apiKey')}</label>
          <input
            id="asaas-api-key"
            type="password"
            autoComplete="off"
            className="modern-input font-mono"
            value={form.apiKey}
            placeholder={config?.apiKeyConfigured ? t('settings.asaas.apiKeySaved') : t('settings.asaas.apiKeyPlaceholder')}
            onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.asaas.apiKeyHint')}</p>
        </div>

        <label className="flex items-start gap-3 sm:col-span-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={form.enabled}
            onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
          />
          <span className="text-sm font-semibold">{t('settings.asaas.enable')}</span>
        </label>
      </div>

      {(config?.accountName || config?.lastTestAt) && (
        <p className="mt-4 text-sm text-muted-foreground">
          {config.accountName && <span className="mr-3">{t('settings.asaas.account', { name: config.accountName })}</span>}
          {config.lastTestAt && <span>{t('settings.asaas.lastTest', { date: formatDateTime(config.lastTestAt) })}</span>}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="modern-button" disabled={saving} onClick={() => void save()}>
          {t(saving ? 'settings.asaas.saving' : 'settings.asaas.save')}
        </button>
        <button
          type="button"
          className="modern-button-secondary"
          disabled={testing || (!form.apiKey.trim() && !config?.apiKeyConfigured)}
          onClick={() => void runTest()}
        >
          {t(testing ? 'settings.asaas.testing' : 'settings.asaas.test')}
        </button>
        {config?.apiKeyConfigured && (
          <button type="button" className="modern-button-secondary" disabled={saving} onClick={removeKey}>
            {t('settings.asaas.removeKey')}
          </button>
        )}
      </div>
    </div>
  )
}
