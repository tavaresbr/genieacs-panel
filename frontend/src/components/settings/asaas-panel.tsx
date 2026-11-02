'use client'

import { useCallback, useEffect, useState } from 'react'
import { asaasProviderAPI, type AsaasProviderConfig, type AsaasEnvironment, type AsaasImportStatus } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import type { TranslationKey } from '@/lib/i18n'

const IMPORT_POLL_MS = 3000

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
  const [importForm, setImportForm] = useState({
    importCustomers: true,
    importCharges: true,
    botLookup: false,
    allowWriteCustomers: false,
    syncEnabled: false,
    syncIntervalHours: 24
  })
  const [importSaving, setImportSaving] = useState(false)
  const [importStatus, setImportStatus] = useState<AsaasImportStatus | null>(null)
  const [starting, setStarting] = useState(false)

  const applyConfig = useCallback((next: AsaasProviderConfig) => {
    setConfig(next)
    setForm({ enabled: next.enabled, environment: next.environment, apiKey: '' })
    setImportForm({
      importCustomers: next.importCustomers,
      importCharges: next.importCharges,
      botLookup: next.botLookup,
      allowWriteCustomers: next.allowWriteCustomers,
      syncEnabled: next.syncEnabled,
      syncIntervalHours: next.syncIntervalHours
    })
  }, [])

  const loadImport = useCallback(async () => {
    const res = await asaasProviderAPI.getImport()
    if (!res.success || !res.data) return null
    setImportStatus(res.data)
    return res.data
  }, [])

  useEffect(() => {
    if (!canConfigure) return
    void asaasProviderAPI.getConfig().then((res) => {
      if (res.success && res.data) applyConfig(res.data)
      else toast.error(res.message || t('settings.asaas.loadFailed'))
    })
    void loadImport()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canConfigure, applyConfig])

  // A importação segue no servidor; a tela pergunta o andamento até ela acabar.
  const running = Boolean(importStatus?.running)
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => {
      void loadImport().then((current) => {
        if (!current || current.running) return
        if (current.lastError) toast.error(t('settings.asaas.import.runFailed'))
        else toast.success(t('settings.asaas.import.done'))
      })
    }, IMPORT_POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, loadImport, toast, t])

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

  const saveImport = async () => {
    setImportSaving(true)
    try {
      const res = await asaasProviderAPI.updateConfig(importForm)
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.asaas.saveFailed'))
        return
      }
      applyConfig(res.data)
      toast.success(res.message || t('settings.asaas.save'))
    } finally {
      setImportSaving(false)
    }
  }

  const startImport = async () => {
    setStarting(true)
    try {
      const res = await asaasProviderAPI.startImport()
      if (!res.success) {
        toast.error(res.message || t('settings.asaas.import.runFailed'))
        return
      }
      await loadImport()
    } finally {
      setStarting(false)
    }
  }

  if (!canConfigure) return null

  const lastRun = importStatus?.lastRun ?? null
  const lastError = importStatus?.lastError ?? null
  const totals = importStatus?.totals
  const totalRows: [TranslationKey, number | undefined][] = [
    ['settings.asaas.import.totals.customers', totals?.customers],
    ['settings.asaas.import.totals.openCharges', totals?.openCharges],
    ['settings.asaas.import.totals.overdue', totals?.overdueCharges],
    ['settings.asaas.import.totals.matchingSgp', totals?.matchingSgp],
    ['settings.asaas.import.totals.withoutDocument', totals?.withoutDocument],
    ['settings.asaas.import.totals.duplicates', totals?.duplicateDocuments]
  ]

  return (
    <div className="space-y-6">
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

    {config?.ready && (
      <div className="modern-card max-w-3xl p-5 sm:p-6" data-testid="asaas-import-panel">
        <h2 className="section-heading">{t('settings.asaas.import.title')}</h2>
        <p className="section-description mb-6">{t('settings.asaas.import.description')}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={importForm.importCustomers}
              onChange={(event) => setImportForm((current) => ({ ...current, importCustomers: event.target.checked }))}
            />
            <span className="text-sm font-semibold">{t('settings.asaas.import.customers')}</span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={importForm.importCharges}
              onChange={(event) => setImportForm((current) => ({ ...current, importCharges: event.target.checked }))}
            />
            <span className="text-sm">
              <span className="block font-semibold">{t('settings.asaas.import.charges')}</span>
              <span className="text-muted-foreground">{t('settings.asaas.import.chargesHint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={importForm.botLookup}
              onChange={(event) => setImportForm((current) => ({ ...current, botLookup: event.target.checked }))}
            />
            <span className="text-sm">
              <span className="block font-semibold">{t('settings.asaas.import.botLookup')}</span>
              <span className="text-muted-foreground">{t('settings.asaas.import.botLookupHint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={importForm.allowWriteCustomers}
              onChange={(event) => setImportForm((current) => ({ ...current, allowWriteCustomers: event.target.checked }))}
            />
            <span className="text-sm">
              <span className="block font-semibold">{t('settings.asaas.import.allowWrite')}</span>
              <span className="text-muted-foreground">{t('settings.asaas.import.allowWriteHint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={importForm.syncEnabled}
              onChange={(event) => setImportForm((current) => ({ ...current, syncEnabled: event.target.checked }))}
            />
            <span className="text-sm font-semibold">{t('settings.asaas.import.auto')}</span>
          </label>
          {importForm.syncEnabled && (
            <div>
              <label className="field-label" htmlFor="asaas-sync-interval">{t('settings.asaas.import.interval')}</label>
              <input
                id="asaas-sync-interval"
                type="number"
                min={1}
                max={168}
                className="modern-input"
                value={importForm.syncIntervalHours}
                onChange={(event) => setImportForm((current) => ({
                  ...current,
                  syncIntervalHours: Number(event.target.value) || 24
                }))}
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="modern-button" disabled={importSaving} onClick={() => void saveImport()}>
            {t(importSaving ? 'settings.asaas.saving' : 'settings.asaas.save')}
          </button>
          <button
            type="button"
            className="modern-button-secondary"
            disabled={starting || running}
            onClick={() => void startImport()}
          >
            {t(running ? 'settings.asaas.import.syncing' : 'settings.asaas.import.syncNow')}
          </button>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          {lastRun
            ? t('settings.asaas.import.lastRun', {
              date: formatDateTime(lastRun.finishedAt),
              customers: lastRun.customers.total,
              charges: lastRun.charges.total
            })
            : t('settings.asaas.import.neverRun')}
        </p>
        {lastRun?.partial && (
          <p className="mt-1 text-sm text-amber-600">{t('settings.asaas.import.partial')}</p>
        )}
        {lastError && !running && (
          <p className="mt-1 text-sm text-red-600">
            {t('settings.asaas.import.lastError', {
              reason: lastError.translationKey
                ? t(lastError.translationKey as TranslationKey)
                : (lastError.message ?? lastError.code)
            })}
          </p>
        )}

        {totals && (
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            {totalRows.map(([label, value]) => (
              <div key={label} className="rounded-md border border-border p-3">
                <dt className="text-xs text-muted-foreground">{t(label)}</dt>
                <dd className="text-lg font-semibold">{value ?? 0}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    )}
    </div>
  )
}
