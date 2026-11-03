'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { addonsAPI, type ConsoleTenantAddons } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { displayDate } from '@/lib/date-format'

/**
 * Os add-ons de UM provedor, no console (0127): os vivos e o histórico, e os
 * dois gestos — dar de graça e revogar na hora —, sempre com motivo; o
 * servidor grava nas duas trilhas.
 */
export function TenantAddons({ tenantId }: { tenantId: number }) {
  const { t } = useTranslation()
  const toast = useToast()
  const ids = useId()
  const [dados, setDados] = useState<ConsoleTenantAddons | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [codigo, setCodigo] = useState('')
  const [motivo, setMotivo] = useState('')
  const [salvando, setSalvando] = useState(false)

  const carregar = useCallback(async () => {
    const res = await addonsAPI.ofTenant(tenantId)
    if (res.success && res.data) {
      setDados(res.data)
      setErro(null)
    } else {
      setErro(res.message || t('platform.addons.loadFailed'))
    }
  }, [tenantId, t])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const dar = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!codigo || !motivo.trim()) {
      toast.error(t('platform.addons.reasonRequired'))
      return
    }
    setSalvando(true)
    try {
      const res = await addonsAPI.grant(tenantId, { code: codigo, reason: motivo.trim() })
      if (res.success && res.data) {
        setDados(res.data)
        setCodigo('')
        setMotivo('')
        toast.success(t('platform.addons.granted'))
      } else {
        toast.error(res.message || t('platform.addons.saveFailed'))
      }
    } finally {
      setSalvando(false)
    }
  }

  const revogar = async (code: string, nome: string) => {
    const razao = window.prompt(t('platform.addons.revokePrompt', { name: nome }))
    if (razao === null) return
    if (!razao.trim()) {
      toast.error(t('platform.addons.reasonRequired'))
      return
    }
    const res = await addonsAPI.revoke(tenantId, code, razao.trim())
    if (res.success && res.data) {
      setDados(res.data)
      toast.success(t('platform.addons.revoked'))
    } else {
      toast.error(res.message || t('platform.addons.saveFailed'))
    }
  }

  if (erro) return <p className="text-sm text-destructive">{erro}</p>
  if (!dados) return null
  const vivos = dados.addons.filter((linha) => linha.status === 'active')
  const historico = dados.addons.filter((linha) => linha.status !== 'active')

  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-3">
      <h4 className="text-sm font-semibold text-foreground">{t('platform.addons.tenantTitle')}</h4>
      {vivos.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('platform.addons.tenantNone')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {vivos.map((linha) => (
            <li key={linha.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
              <span className="min-w-0">
                {linha.name ?? linha.code}
                {linha.free && <span className="ml-2 modern-badge-info">{t('platform.addons.free')}</span>}
                {linha.cancelAt && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t('addons.cancelsOn', { date: displayDate(linha.cancelAt) ?? '' })}
                  </span>
                )}
              </span>
              {linha.code && (
                <button type="button" className="modern-button-secondary" onClick={() => void revogar(linha.code!, linha.name ?? linha.code!)}>
                  {t('platform.addons.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {historico.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary>{t('platform.addons.history', { count: historico.length })}</summary>
          <ul className="mt-1 space-y-1">
            {historico.map((linha) => (
              <li key={linha.id}>
                {linha.name ?? linha.code} · {displayDate(linha.startedAt) ?? '—'} → {displayDate(linha.canceledAt) ?? '—'}
                {linha.reason ? ` · ${linha.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      <form onSubmit={(e) => void dar(e)} className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`${ids}-code`} className="field-label">{t('platform.addons.grantAddon')}</label>
          <select id={`${ids}-code`} className="modern-input" value={codigo} onChange={(e) => setCodigo(e.target.value)}>
            <option value="">—</option>
            {dados.catalog.map((addon) => (
              <option key={addon.id} value={addon.code}>{addon.name}</option>
            ))}
          </select>
        </div>
        <div className="min-w-[12rem] flex-1">
          <label htmlFor={`${ids}-reason`} className="field-label">{t('platform.addons.reason')}</label>
          <input id={`${ids}-reason`} className="modern-input w-full" value={motivo} maxLength={255} onChange={(e) => setMotivo(e.target.value)} />
        </div>
        <button type="submit" className="modern-button-secondary" disabled={salvando}>
          {t('platform.addons.grant')}
        </button>
      </form>
    </div>
  )
}
