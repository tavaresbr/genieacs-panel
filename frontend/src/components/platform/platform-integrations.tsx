'use client'

import { useCallback, useEffect, useState } from 'react'
import { platformAPI, type AsaasIntegration, type AsaasIntegrationUpdate } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { copyToClipboard, formatRelativeTime } from '@/lib/utils'

/**
 * As integrações da PLATAFORMA — os serviços de terceiro com que o SaaS cobra
 * e atende os provedores, e não os de um provedor com os clientes dele (esses
 * moram na Configuração de cada ISP).
 *
 * Um cartão por integração. Hoje só a Asaas; a próxima entra como outro
 * cartão ao lado, sem mexer neste.
 *
 * Ao contrário da Saúde do deploy, esta tela ESCREVE: a chave e o token da
 * Asaas deixaram de morar só em variável de ambiente. A variável continua
 * valendo enquanto o painel não grava nada por cima — é o `*Source` que diz
 * qual das duas está valendo, e a tela mostra, porque "configurado" sem dizer
 * de onde esconde justamente o caso que confunde: apagar aqui e continuar
 * configurado, porque a variável de ambiente ainda está lá.
 */
export function PlatformIntegrations() {
  return (
    <div className="grid grid-cols-1 gap-6">
      <AsaasCard />
    </div>
  )
}

/** Os eventos que o webhook de cobrança precisa receber. Nomes da Asaas, não se traduzem. */
const EVENTOS_ASAAS = [
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_DELETED',
  'PAYMENT_REFUNDED'
]

/** De onde veio o valor que vale — o painel ou a variável de ambiente. */
function origem(source: AsaasIntegration['apiKeySource']): TranslationKey | null {
  if (source === 'db') return 'integrations.sourceDb'
  if (source === 'env') return 'integrations.sourceEnv'
  return null
}

function Selo({ ligado, sim, nao, source }: {
  ligado: boolean
  sim: TranslationKey
  nao: TranslationKey
  source: AsaasIntegration['apiKeySource']
}) {
  const { t } = useTranslation()
  const chave = ligado ? origem(source) : null
  return (
    <span className={ligado ? 'modern-badge-success' : 'modern-badge-warning'}>
      {t(ligado ? sim : nao)}
      {chave && <span className="ms-1 font-normal opacity-80">· {t(chave)}</span>}
    </span>
  )
}

function AsaasCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const [info, setInfo] = useState<AsaasIntegration | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [environment, setEnvironment] = useState<AsaasIntegration['environment']>('sandbox')
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [generating, setGenerating] = useState(false)
  /**
   * O token recém-gerado. Vive só no estado desta tela: o backend não o
   * devolve de novo, e é por isso que ele fica à mostra até a pessoa sair —
   * perder o token aqui é ter de gerar outro e colar outra vez na Asaas.
   */
  const [newToken, setNewToken] = useState<string | null>(null)

  const aplicar = useCallback((dados: AsaasIntegration) => {
    setInfo(dados)
    setEnvironment(dados.environment)
    setApiKey('')
    setClearApiKey(false)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.asaasIntegration()
    if (res.success && res.data) {
      aplicar(res.data)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [aplicar])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !info) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  if (error !== null && !info) {
    return <p className="text-sm text-destructive">{error || t('integrations.loadFailed')}</p>
  }
  if (!info) return null

  /* Manda só o que mudou: a rota distingue campo ausente (não mexe) de campo
     vazio (apaga), e mandar tudo a cada salvamento jogaria a diferença fora. */
  const corpo: AsaasIntegrationUpdate = {}
  if (environment !== info.environment) corpo.environment = environment
  if (clearApiKey) corpo.apiKey = ''
  else if (apiKey.trim()) corpo.apiKey = apiKey.trim()
  const mudou = Object.keys(corpo).length > 0

  const salvar = async () => {
    if (!mudou || saving) return
    setSaving(true)
    try {
      const res = await platformAPI.saveAsaasIntegration(corpo)
      if (res.success && res.data) {
        aplicar(res.data)
        toast.success(t('integrations.saved'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const testar = async () => {
    setTesting(true)
    try {
      const res = await platformAPI.testAsaasIntegration()
      if (res.success && res.data?.ok) {
        toast.success(res.data.accountName
          ? t('integrations.asaas.testOk', { account: res.data.accountName })
          : t('integrations.asaas.testOkNoName'))
      } else {
        // `ok: false` e o 400 de `not_configured` trazem o motivo em `message`.
        toast.error(res.message || t('integrations.asaas.testFailed'))
      }
    } finally {
      setTesting(false)
    }
  }

  const gerarToken = async () => {
    // Trocar o token derruba as entregas até o novo chegar à Asaas; só pede
    // confirmação quando HÁ um token a derrubar.
    if (info.webhookTokenConfigured && !window.confirm(t('integrations.asaas.generateConfirm'))) return
    setGenerating(true)
    try {
      const res = await platformAPI.generateAsaasWebhookToken()
      if (res.success && res.data) {
        setNewToken(res.data.webhookToken)
        toast.success(t('integrations.asaas.tokenGenerated'))
        // Recarrega para o selo passar a "configurado · pelo painel".
        const atual = await platformAPI.asaasIntegration()
        if (atual.success && atual.data) setInfo(atual.data)
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setGenerating(false)
    }
  }

  const copiar = async (texto: string) => {
    if (await copyToClipboard(texto)) toast.success(t('common.copied'))
  }

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-heading">{t('integrations.asaas.title')}</h2>
          <p className="field-hint mt-1">{t('integrations.asaas.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Selo
            ligado={info.apiKeyConfigured}
            sim="integrations.asaas.apiKeyConfigured"
            nao="integrations.asaas.apiKeyMissing"
            source={info.apiKeySource}
          />
          <Selo
            ligado={info.webhookTokenConfigured}
            sim="integrations.asaas.webhookTokenConfigured"
            nao="integrations.asaas.webhookTokenMissing"
            source={info.webhookTokenSource}
          />
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="asaas-environment" className="field-label">{t('integrations.asaas.environment')}</label>
          <select
            id="asaas-environment"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as AsaasIntegration['environment'])}
            className="modern-input w-full"
          >
            <option value="sandbox">{t('integrations.asaas.sandbox')}</option>
            <option value="production">{t('integrations.asaas.production')}</option>
          </select>
          <p className="field-hint">{t('integrations.asaas.environmentHint')}</p>
        </div>
        <div>
          <label htmlFor="asaas-api-key" className="field-label">{t('integrations.asaas.apiKey')}</label>
          <input
            id="asaas-api-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={clearApiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="modern-input w-full font-mono"
            placeholder={t(info.apiKeyConfigured
              ? 'integrations.asaas.placeholderStored'
              : 'integrations.asaas.placeholderEmpty')}
          />
          {/* Apagar só existe para o que o painel gravou: a variável de
              ambiente não se apaga por aqui, e a caixa prometeria isso. */}
          {info.apiKeySource === 'db' && (
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={clearApiKey} onChange={(e) => setClearApiKey(e.target.checked)} />
              {t('integrations.asaas.clearApiKey')}
            </label>
          )}
          <p className="field-hint">
            {t(info.apiKeySource === 'env' ? 'integrations.asaas.envOverrideHint' : 'integrations.asaas.apiKeyHint')}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className="modern-button" disabled={!mudou || saving} onClick={() => void salvar()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        {/* Testa o que está GRAVADO, não o que está digitado: é a chave que as
            cobranças vão usar. Por isso fica desligado com alteração pendente. */}
        <button
          type="button"
          className="modern-button-secondary"
          disabled={testing || mudou || !info.apiKeyConfigured}
          onClick={() => void testar()}
        >
          <Icon name="refresh" size={17} className={testing ? 'animate-spin' : ''} />
          {testing ? t('integrations.asaas.testing') : t('integrations.asaas.test')}
        </button>
        {info.updatedAt && (
          <span className="text-xs text-muted-foreground">
            {t('integrations.updatedAt', { when: formatRelativeTime(info.updatedAt) })}
          </span>
        )}
      </div>

      <div className="mt-6 space-y-4 border-t border-border pt-5">
        <div>
          <label htmlFor="asaas-webhook-url" className="field-label">{t('integrations.asaas.webhookUrl')}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="asaas-webhook-url"
              type="text"
              readOnly
              className="modern-input w-full font-mono text-xs"
              value={info.webhookUrl}
            />
            <button type="button" className="modern-button-secondary shrink-0" onClick={() => void copiar(info.webhookUrl)}>
              <Icon name="copy" size={16} /> {t('common.copy')}
            </button>
          </div>
          <p className="field-hint">{t('integrations.asaas.webhookUrlHint')}</p>
        </div>

        <div>
          <p className="field-label">{t('integrations.asaas.webhookToken')}</p>
          {!info.webhookTokenConfigured && (
            <p className="field-hint">{t('integrations.asaas.webhookTokenMissingHint')}</p>
          )}
          <button
            type="button"
            className="modern-button-secondary mt-2"
            disabled={generating}
            onClick={() => void gerarToken()}
          >
            {generating ? t('common.saving') : t('integrations.asaas.generateToken')}
          </button>
          {newToken && (
            <div className="mt-3 rounded-md border border-border p-3">
              <label htmlFor="asaas-new-token" className="field-label">{t('integrations.asaas.newTokenLabel')}</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="asaas-new-token"
                  type="text"
                  readOnly
                  className="modern-input w-full font-mono text-xs"
                  value={newToken}
                  onFocus={(e) => e.target.select()}
                />
                <button type="button" className="modern-button-secondary shrink-0" onClick={() => void copiar(newToken)}>
                  <Icon name="copy" size={16} /> {t('common.copy')}
                </button>
              </div>
              <p className="field-hint">{t('integrations.asaas.newTokenHint')}</p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-foreground">{t('integrations.asaas.stepsTitle')}</h3>
        <ol className="mt-2 list-decimal space-y-1.5 ps-5 text-sm text-muted-foreground">
          <li>{t('integrations.asaas.step1')}</li>
          <li>{t('integrations.asaas.step2')}</li>
          <li>{t('integrations.asaas.step3')}</li>
          <li>
            {t('integrations.asaas.step4')}{' '}
            <span className="break-words font-mono text-xs text-foreground">{EVENTOS_ASAAS.join(', ')}</span>
          </li>
          <li>{t('integrations.asaas.step5')}</li>
        </ol>
      </div>
    </section>
  )
}

export default PlatformIntegrations
