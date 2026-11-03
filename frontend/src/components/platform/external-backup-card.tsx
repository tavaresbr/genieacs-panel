'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  externalBackupAPI,
  type ExternalBackupRun,
  type ExternalBackupSettings,
  type ExternalBackupUpdate,
  type ExternalBackupVerification
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { copyToClipboard, formatRelativeTime } from '@/lib/utils'
import {
  generateBrowserKeyPair, privateKeyFile, privateKeyFileName, supportsBrowserKeygen, type BackupKeyPair
} from '@/lib/backup-keys'

/**
 * Integrações → Backup externo: o S3 compatível para onde vai a cópia
 * cifrada do banco, a chave pública que cifra, e o estado do último envio e
 * da última verificação.
 *
 * A regra que esta tela existe para cumprir: **a chave privada não fica no
 * servidor.** O par nasce aqui, no navegador; a privada vira um arquivo que a
 * pessoa baixa e guarda fora (cofre de senhas, mídia offline), e só a pública
 * sobe — e só depois de a pessoa dizer que guardou, porque um backup cifrado
 * para uma chave que ninguém tem é um backup que não existe.
 */

type Form = {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
  enabled: boolean
  runner: ExternalBackupSettings['runner']
  hour: number
  keepDaily: number
  keepWeekly: number
  includeMedia: boolean
}

function formOf(info: ExternalBackupSettings): Form {
  return {
    endpoint: info.endpoint,
    region: info.region || 'us-east-1',
    bucket: info.bucket,
    prefix: info.prefix,
    forcePathStyle: info.forcePathStyle,
    accessKeyId: '',
    secretAccessKey: '',
    enabled: info.enabled,
    runner: info.runner,
    hour: info.hour,
    keepDaily: info.keepDaily,
    keepWeekly: info.keepWeekly,
    includeMedia: info.includeMedia
  }
}

/** Só o que mudou: a access key e a secret só vão quando digitadas. */
export function backupPatch(info: ExternalBackupSettings, form: Form): ExternalBackupUpdate {
  const patch: ExternalBackupUpdate = {}
  const comparar = ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'enabled', 'runner', 'hour', 'keepDaily', 'keepWeekly', 'includeMedia'] as const
  for (const campo of comparar) {
    const atual = campo === 'region' ? (info.region || 'us-east-1') : info[campo]
    if (form[campo] !== atual) (patch as Record<string, unknown>)[campo] = form[campo]
  }
  if (form.accessKeyId.trim()) patch.accessKeyId = form.accessKeyId.trim()
  if (form.secretAccessKey.trim()) patch.secretAccessKey = form.secretAccessKey.trim()
  return patch
}

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '-'
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB']
  let valor = bytes
  let i = 0
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024
    i += 1
  }
  return `${valor.toFixed(i === 0 ? 0 : 1)} ${unidades[i]}`
}

function baixar(nome: string, conteudo: string) {
  const blob = new Blob([conteudo], { type: 'application/x-pem-file' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nome
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const ESTADO: Record<string, { rotulo: TranslationKey; classe: string }> = {
  ok: { rotulo: 'integrations.backup.statusOk', classe: 'modern-badge-success' },
  warning: { rotulo: 'integrations.backup.statusWarning', classe: 'modern-badge-warning' },
  failed: { rotulo: 'integrations.backup.statusFailed', classe: 'modern-badge-error' },
  running: { rotulo: 'integrations.backup.statusRunning', classe: 'modern-badge-warning' },
  skipped: { rotulo: 'integrations.backup.statusSkipped', classe: 'modern-badge-warning' }
}

function Estado({ status }: { status: string }) {
  const { t } = useTranslation()
  const e = ESTADO[status] ?? ESTADO.failed
  return <span className={e.classe}>{t(e.rotulo)}</span>
}

function LinhaEnvio({ titulo, run }: { titulo: TranslationKey; run: ExternalBackupRun | null }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t(titulo)}</span>
        {run ? <Estado status={run.status} /> : <span className="text-muted-foreground">{t('integrations.backup.never')}</span>}
      </div>
      {run && (
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
          {(run.finishedAt || run.startedAt) && (
            <div>{t('integrations.backup.when', { when: formatRelativeTime((run.finishedAt || run.startedAt) as string) })}</div>
          )}
          {run.bytes !== undefined && <div>{t('integrations.backup.size', { size: formatBytes(run.bytes) })}</div>}
          {run.durationMs !== undefined && (
            <div>{t('integrations.backup.duration', { seconds: String(Math.round(run.durationMs / 100) / 10) })}</div>
          )}
          {run.source && <div>{t(run.source === 'host' ? 'integrations.backup.byHost' : 'integrations.backup.byPanel')}</div>}
          {run.key && <div className="break-all font-mono sm:col-span-2">{run.key}</div>}
          {run.error && <div className="text-destructive sm:col-span-2">{run.error}</div>}
          {run.retentionError && <div className="text-destructive sm:col-span-2">{run.retentionError}</div>}
        </dl>
      )}
    </div>
  )
}

function LinhaVerificacao({ v }: { v: ExternalBackupVerification | null }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t('integrations.backup.lastVerification')}</span>
        {v ? <Estado status={v.status} /> : <span className="text-muted-foreground">{t('integrations.backup.never')}</span>}
      </div>
      {v && (
        <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
          <div>{t('integrations.backup.when', { when: formatRelativeTime(v.at) })}</div>
          {v.bytes !== undefined && <div>{t('integrations.backup.size', { size: formatBytes(v.bytes) })}</div>}
          {v.key && <div className="break-all font-mono">{v.key}</div>}
          {v.error && <div className="text-destructive">{v.error}</div>}
        </dl>
      )}
      <p className="field-hint mt-2">{t('integrations.backup.verificationHint')}</p>
    </div>
  )
}

export function ExternalBackupCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const [info, setInfo] = useState<ExternalBackupSettings | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<null | 'test' | 'run' | 'verify' | 'key'>(null)
  /** O par recém-gerado no navegador, até a pessoa confirmar que guardou a privada. */
  const [pendente, setPendente] = useState<BackupKeyPair | null>(null)
  /** A privada gerada pelo servidor (sem WebCrypto): a pública já foi gravada. */
  const [doServidor, setDoServidor] = useState<BackupKeyPair | null>(null)
  const [guardei, setGuardei] = useState(false)
  const [importar, setImportar] = useState('')

  const aplicar = useCallback((dados: ExternalBackupSettings) => {
    setInfo(dados)
    setForm(formOf(dados))
  }, [])

  const load = useCallback(async () => {
    const res = await externalBackupAPI.get()
    if (res.success && res.data) {
      aplicar(res.data)
      setError(null)
    } else {
      setError(res.message || '')
    }
  }, [aplicar])

  useEffect(() => {
    void load()
  }, [load])

  // Enquanto uma passada roda no servidor, a tela pergunta de novo a cada
  // poucos segundos — o "fazer agora" responde 202 e o resultado chega depois.
  useEffect(() => {
    if (!info?.running) return undefined
    const id = window.setInterval(async () => {
      const res = await externalBackupAPI.get()
      if (res.success && res.data) {
        setInfo(res.data)
        if (!res.data.running) window.clearInterval(id)
      }
    }, 3000)
    return () => window.clearInterval(id)
  }, [info?.running])

  if (error !== null && !info) return <p className="text-sm text-destructive">{error || t('integrations.loadFailed')}</p>
  if (!info || !form) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>

  const patch = backupPatch(info, form)
  const mudou = Object.keys(patch).length > 0
  const set = <K extends keyof Form>(campo: K, valor: Form[K]) => setForm((f) => (f ? { ...f, [campo]: valor } : f))

  const salvar = async () => {
    if (!mudou || saving) return
    setSaving(true)
    try {
      const res = await externalBackupAPI.save(patch)
      if (res.success && res.data) {
        aplicar(res.data)
        toast.success(t('integrations.saved'))
      } else toast.error(res.message || t('platform.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const testar = async () => {
    setBusy('test')
    try {
      const res = await externalBackupAPI.test()
      if (res.success && res.data?.ok) toast.success(t('integrations.backup.testOk'))
      else toast.error(res.data?.error || res.message || t('integrations.backup.testFailed'))
    } finally {
      setBusy(null)
    }
  }

  const disparar = async (tipo: 'run' | 'verify') => {
    setBusy(tipo)
    try {
      const res = tipo === 'run' ? await externalBackupAPI.runNow() : await externalBackupAPI.verifyNow()
      if (res.success) {
        toast.success(t('integrations.backup.started'))
        setInfo((i) => (i ? { ...i, running: true } : i))
      } else toast.error(res.message || t('platform.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  const gerar = async () => {
    if (info.publicKey && !window.confirm(t('integrations.backup.replaceConfirm'))) return
    setBusy('key')
    setGuardei(false)
    try {
      if (await supportsBrowserKeygen()) {
        setPendente(await generateBrowserKeyPair())
        return
      }
      // Sem X25519 no navegador: o servidor gera, grava a pública e devolve a
      // privada nesta resposta, uma vez.
      const res = await externalBackupAPI.serverKeyPair()
      if (res.success && res.data) {
        setDoServidor({ publicKey: res.data.publicKey, privateKeyPem: res.data.privateKeyPem, keyId: res.data.keyId })
        aplicar(res.data.settings)
      } else toast.error(res.message || t('platform.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  const usarPendente = async () => {
    if (!pendente || !guardei) return
    setBusy('key')
    try {
      const res = await externalBackupAPI.setPublicKey(pendente.publicKey, 'browser')
      if (res.success && res.data) {
        aplicar(res.data)
        setPendente(null)
        toast.success(t('integrations.backup.keySaved'))
      } else toast.error(res.message || t('platform.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  const importarChave = async () => {
    if (!importar.trim()) return
    if (info.publicKey && !window.confirm(t('integrations.backup.replaceConfirm'))) return
    setBusy('key')
    try {
      const res = await externalBackupAPI.setPublicKey(importar.trim(), 'imported')
      if (res.success && res.data) {
        aplicar(res.data)
        setImportar('')
        toast.success(t('integrations.backup.keySaved'))
      } else toast.error(res.message || t('platform.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  const privada = pendente ?? doServidor

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-heading">{t('integrations.backup.title')}</h2>
          <p className="field-hint mt-1">{t('integrations.backup.description')}</p>
        </div>
        <span className={info.configured ? 'modern-badge-success' : 'modern-badge-warning'}>
          {t(info.configured ? 'integrations.backup.configured' : 'integrations.backup.notConfigured')}
        </span>
      </div>

      {!info.platformBox && <p className="mt-3 text-sm text-destructive">{t('integrations.backup.noPlatformBox')}</p>}
      {!info.connectionReadable && <p className="mt-3 text-sm text-destructive">{t('integrations.backup.connectionUnreadable')}</p>}

      <div className="mt-5 space-y-4">
        <div className="rounded-lg border border-border bg-[hsl(var(--surface-subtle))] p-4 sm:p-5">
          <h3 className="mb-4 flex items-center gap-2 text-base font-semibold"><Icon name="database" size={18} />{t('integrations.backup.connectionTitle')}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label htmlFor="bkp-endpoint" className="field-label">{t('integrations.backup.endpoint')}</label>
              <input id="bkp-endpoint" className="modern-input w-full font-mono" value={form.endpoint}
                placeholder="https://s3.us-east-1.amazonaws.com" onChange={(e) => set('endpoint', e.target.value)} />
              <p className="field-hint">{t('integrations.backup.endpointHint')}</p>
            </div>
            <div>
              <label htmlFor="bkp-region" className="field-label">{t('integrations.backup.region')}</label>
              <input id="bkp-region" className="modern-input w-full font-mono" value={form.region} onChange={(e) => set('region', e.target.value)} />
            </div>
            <div>
              <label htmlFor="bkp-bucket" className="field-label">{t('integrations.backup.bucket')}</label>
              <input id="bkp-bucket" className="modern-input w-full font-mono" value={form.bucket} onChange={(e) => set('bucket', e.target.value)} />
            </div>
            <div>
              <label htmlFor="bkp-prefix" className="field-label">{t('integrations.backup.prefix')}</label>
              <input id="bkp-prefix" className="modern-input w-full font-mono" value={form.prefix} placeholder="skygenpanel/"
                onChange={(e) => set('prefix', e.target.value)} />
              <p className="field-hint">{t('integrations.backup.prefixHint')}</p>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.forcePathStyle} onChange={(e) => set('forcePathStyle', e.target.checked)} />
                {t('integrations.backup.pathStyle')}
              </label>
            </div>
            <div>
              <label htmlFor="bkp-access" className="field-label">{t('integrations.backup.accessKeyId')}</label>
              <input id="bkp-access" className="modern-input w-full font-mono" autoComplete="off" value={form.accessKeyId}
                placeholder={info.accessKeyIdHint ?? ''} onChange={(e) => set('accessKeyId', e.target.value)} />
            </div>
            <div>
              <label htmlFor="bkp-secret" className="field-label">{t('integrations.backup.secretAccessKey')}</label>
              <input id="bkp-secret" type="password" autoComplete="new-password" className="modern-input w-full font-mono"
                value={form.secretAccessKey} onChange={(e) => set('secretAccessKey', e.target.value)}
                placeholder={t(info.secretAccessKeyConfigured ? 'integrations.backup.placeholderStored' : 'integrations.backup.placeholderEmpty')} />
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-[hsl(var(--surface-subtle))] p-4 sm:p-5">
          <h3 className="mb-4 flex items-center gap-2 text-base font-semibold"><Icon name="refresh" size={18} />{t('integrations.backup.scheduleTitle')}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              {t('integrations.backup.enabled')}
            </label>
            <div>
              <label htmlFor="bkp-runner" className="field-label">{t('integrations.backup.runner')}</label>
              <select id="bkp-runner" className="modern-input w-full" value={form.runner}
                onChange={(e) => set('runner', e.target.value as Form['runner'])}>
                <option value="panel">{t('integrations.backup.runnerPanel')}</option>
                <option value="host">{t('integrations.backup.runnerHost')}</option>
              </select>
              <p className="field-hint">{t('integrations.backup.runnerHint')}</p>
            </div>
            <div>
              <label htmlFor="bkp-hour" className="field-label">{t('integrations.backup.hour')}</label>
              <select id="bkp-hour" className="modern-input w-full" value={form.hour} disabled={form.runner === 'host'}
                onChange={(e) => set('hour', Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
              </select>
              <p className="field-hint">{t('integrations.backup.hourHint')}</p>
            </div>
            <div>
              <label htmlFor="bkp-daily" className="field-label">{t('integrations.backup.keepDaily')}</label>
              <input id="bkp-daily" type="number" min={1} max={365} className="modern-input w-full" value={form.keepDaily}
                onChange={(e) => set('keepDaily', Number(e.target.value))} />
            </div>
            <div>
              <label htmlFor="bkp-weekly" className="field-label">{t('integrations.backup.keepWeekly')}</label>
              <input id="bkp-weekly" type="number" min={0} max={520} className="modern-input w-full" value={form.keepWeekly}
                onChange={(e) => set('keepWeekly', Number(e.target.value))} />
            </div>
            <p className="field-hint md:col-span-2">{t('integrations.backup.retentionHint')}</p>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input type="checkbox" checked={form.includeMedia} onChange={(e) => set('includeMedia', e.target.checked)} />
              {t('integrations.backup.includeMedia')}
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className="modern-button" disabled={!mudou || saving} onClick={() => void salvar()}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={busy !== null || mudou || !info.secretAccessKeyConfigured}
              onClick={() => void testar()}>
              {busy === 'test' ? t('integrations.backup.testing') : t('integrations.backup.test')}
            </button>
            {info.updatedAt && (
              <span className="text-xs text-muted-foreground">{t('integrations.updatedAt', { when: formatRelativeTime(info.updatedAt) })}</span>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-[hsl(var(--surface-subtle))] p-4 sm:p-5">
          <h3 className="mb-2 flex items-center gap-2 text-base font-semibold"><Icon name="lock" size={18} />{t('integrations.backup.keyTitle')}</h3>
          <p className="field-hint">{t('integrations.backup.keyHint')}</p>
          <div className="mt-3 text-sm">
            {info.keyId ? (
              <p>
                {t('integrations.backup.keyId')}: <code className="font-mono">{info.keyId}</code>
                {info.keyOrigin && <span className="ms-2 text-xs text-muted-foreground">· {t(`integrations.backup.keyOrigin.${info.keyOrigin}` as TranslationKey)}</span>}
                {info.keyCreatedAt && <span className="ms-2 text-xs text-muted-foreground">· {formatRelativeTime(info.keyCreatedAt)}</span>}
              </p>
            ) : <p className="text-muted-foreground">{t('integrations.backup.keyNone')}</p>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="modern-button-secondary" disabled={busy !== null || pendente !== null} onClick={() => void gerar()}>
              <Icon name="lock" size={17} />
              {busy === 'key' ? t('integrations.backup.generating') : t('integrations.backup.generate')}
            </button>
          </div>

          {privada && (
            <div className="mt-4 rounded-md border border-destructive/40 p-3">
              <p className="text-sm font-semibold text-destructive">{t('integrations.backup.privateKeyTitle')}</p>
              <p className="field-hint mt-1">{t(doServidor ? 'integrations.backup.serverFallback' : 'integrations.backup.privateKeyWarning')}</p>
              <p className="mt-2 text-xs">{t('integrations.backup.keyId')}: <code className="font-mono">{privada.keyId}</code></p>
              <textarea readOnly className="modern-input mt-2 h-32 w-full font-mono text-xs" value={privada.privateKeyPem} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" className="modern-button-secondary"
                  onClick={() => baixar(privateKeyFileName(privada.keyId), privateKeyFile(privada))}>
                  {t('integrations.backup.download')}
                </button>
                <button type="button" className="modern-button-secondary"
                  onClick={() => void copyToClipboard(privada.privateKeyPem).then((ok) => ok && toast.success(t('common.copied')))}>
                  <Icon name="copy" size={17} />{t('common.copy')}
                </button>
              </div>
              {pendente ? (
                <div className="mt-3 space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={guardei} onChange={(e) => setGuardei(e.target.checked)} />
                    {t('integrations.backup.savedConfirm')}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="modern-button" disabled={!guardei || busy !== null} onClick={() => void usarPendente()}>
                      {t('integrations.backup.usePublic')}
                    </button>
                    <button type="button" className="modern-button-secondary" onClick={() => setPendente(null)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="modern-button mt-3" onClick={() => setDoServidor(null)}>{t('integrations.backup.savedDone')}</button>
              )}
            </div>
          )}

          <div className="mt-4">
            <label htmlFor="bkp-import" className="field-label">{t('integrations.backup.importLabel')}</label>
            <div className="flex flex-wrap gap-2">
              <input id="bkp-import" className="modern-input min-w-0 flex-1 font-mono text-xs" value={importar}
                placeholder="skygp-backup-pub-1:…" onChange={(e) => setImportar(e.target.value)} />
              <button type="button" className="modern-button-secondary" disabled={!importar.trim() || busy !== null}
                onClick={() => void importarChave()}>{t('integrations.backup.importButton')}</button>
            </div>
            <p className="field-hint">{t('integrations.backup.importHint')}</p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-[hsl(var(--surface-subtle))] p-4 sm:p-5">
          <h3 className="mb-4 flex items-center gap-2 text-base font-semibold"><Icon name="chart" size={18} />{t('integrations.backup.statusTitle')}</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <LinhaEnvio titulo="integrations.backup.lastRun" run={info.status.lastRun} />
            <LinhaEnvio titulo="integrations.backup.lastSuccess" run={info.status.lastSuccess} />
            <LinhaVerificacao v={info.status.lastVerification} />
            {info.status.hostFailure && (
              <div className="rounded-md border border-destructive/40 p-3 text-sm">
                <p className="font-medium text-destructive">{t('integrations.backup.hostFailure')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatRelativeTime(info.status.hostFailure.at)} · {info.status.hostFailure.reason}</p>
              </div>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className="modern-button" disabled={!info.configured || info.running || busy !== null}
              onClick={() => void disparar('run')}>
              {info.running ? t('integrations.backup.statusRunning') : t('integrations.backup.runNow')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={!info.configured || info.running || busy !== null || !info.status.lastSuccess}
              onClick={() => void disparar('verify')}>
              {t('integrations.backup.verifyNow')}
            </button>
          </div>
          <p className="field-hint mt-3">{t('integrations.backup.restoreHint')}</p>
        </div>
      </div>
    </section>
  )
}
