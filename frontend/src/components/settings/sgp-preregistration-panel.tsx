'use client'

import { useEffect, useState } from 'react'
import { sgpAPI, type SgpConfig } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'

interface Props {
  config: SgpConfig
  onConfigChange: (config: SgpConfig) => void
}

type Row = { id: string; label: string }

const toRows = (items: { id: number; name?: string; label?: string }[] | undefined): Row[] =>
  (items ?? []).map((item) => ({ id: String(item.id), label: item.name ?? item.label ?? '' }))

const idText = (value: number | null | undefined) => (value ? String(value) : '')

/**
 * The SGP ids a client-with-contract needs (Novo cliente → "Cliente com
 * contrato"). The URA API has no call that lists plans, due days or POPs, so
 * the admin types them once here, with the name the operator will pick by.
 * Its own form and its own save, like the contacts sync panel above.
 */
export function SgpPreRegistrationPanel({ config, onConfigChange }: Props) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const canConfigure = can('sgp.config')

  const [plans, setPlans] = useState<Row[]>([])
  const [dueDays, setDueDays] = useState<Row[]>([])
  const [popId, setPopId] = useState('')
  const [portadorId, setPortadorId] = useState('')
  const [vendedorId, setVendedorId] = useState('')
  const [installOs, setInstallOs] = useState(true)
  const [activate, setActivate] = useState(false)
  const [saving, setSaving] = useState(false)

  const configKey = config.updatedAt ?? null
  useEffect(() => {
    setPlans(toRows(config.preRegPlans))
    setDueDays(toRows(config.preRegDueDays))
    setPopId(idText(config.preRegPopId))
    setPortadorId(idText(config.preRegPortadorId))
    setVendedorId(idText(config.preRegVendedorId))
    setInstallOs(config.preRegInstallOs !== false)
    setActivate(config.preRegActivate === true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey])

  const save = async () => {
    setSaving(true)
    try {
      const clean = (rows: Row[]) => rows
        .map((row) => ({ id: Number.parseInt(row.id, 10), label: row.label.trim() }))
        .filter((row) => Number.isInteger(row.id) && row.id > 0 && row.label)
      const res = await sgpAPI.updateConfig({
        preRegPlans: clean(plans).map((row) => ({ id: row.id, name: row.label })),
        preRegDueDays: clean(dueDays),
        preRegPopId: popId ? Number(popId) : null,
        preRegPortadorId: portadorId ? Number(portadorId) : null,
        preRegVendedorId: vendedorId ? Number(vendedorId) : null,
        preRegInstallOs: installOs,
        preRegActivate: activate
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.sgp.saveFailed'))
        return
      }
      onConfigChange(res.data)
      toast.success(t('settings.sgp.saved'))
    } finally {
      setSaving(false)
    }
  }

  const listEditor = (
    rows: Row[],
    setRows: (rows: Row[]) => void,
    labelKey: 'settings.sgp.preReg.planName' | 'settings.sgp.preReg.dueDayLabel',
    testId: string
  ) => (
    <div className="space-y-2" data-testid={testId}>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            className="modern-input w-24 font-mono"
            inputMode="numeric"
            placeholder="ID"
            aria-label="ID"
            value={row.id}
            disabled={!canConfigure}
            onChange={(event) => setRows(rows.map((item, i) => (i === index ? { ...item, id: event.target.value.replace(/\D/g, '') } : item)))}
          />
          <input
            className="modern-input flex-1"
            placeholder={t(labelKey)}
            aria-label={t(labelKey)}
            value={row.label}
            disabled={!canConfigure}
            onChange={(event) => setRows(rows.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))}
          />
          {canConfigure && (
            <button
              type="button"
              className="modern-button-secondary"
              aria-label={t('common.delete')}
              onClick={() => setRows(rows.filter((_, i) => i !== index))}
            >
              <Icon name="trash" size={16} />
            </button>
          )}
        </div>
      ))}
      {canConfigure && (
        <button type="button" className="modern-button-secondary" onClick={() => setRows([...rows, { id: '', label: '' }])}>
          {t('settings.sgp.preReg.add')}
        </button>
      )}
    </div>
  )

  return (
    <div className="mt-6 border-t border-border pt-5" data-testid="sgp-preregistration">
      <h3 className="font-semibold">{t('settings.sgp.preReg.title')}</h3>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('settings.sgp.preReg.hint')}</p>

      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <p className="field-label">{t('settings.sgp.preReg.plans')}</p>
          {listEditor(plans, setPlans, 'settings.sgp.preReg.planName', 'sgp-prereg-plans')}
        </div>
        <div>
          <p className="field-label">{t('settings.sgp.preReg.dueDays')}</p>
          {listEditor(dueDays, setDueDays, 'settings.sgp.preReg.dueDayLabel', 'sgp-prereg-due-days')}
        </div>
        {([
          ['sgp-prereg-pop', 'settings.sgp.preReg.popId', popId, setPopId],
          ['sgp-prereg-portador', 'settings.sgp.preReg.portadorId', portadorId, setPortadorId],
          ['sgp-prereg-vendedor', 'settings.sgp.preReg.vendedorId', vendedorId, setVendedorId]
        ] as const).map(([id, labelKey, value, setValue]) => (
          <div key={id}>
            <label className="field-label" htmlFor={id}>{t(labelKey)}</label>
            <input
              id={id}
              className="modern-input font-mono"
              inputMode="numeric"
              value={value}
              disabled={!canConfigure}
              onChange={(event) => setValue(event.target.value.replace(/\D/g, ''))}
            />
          </div>
        ))}
        <label className="flex items-start gap-3 sm:col-span-2">
          <input type="checkbox" className="mt-1" checked={installOs} disabled={!canConfigure} onChange={(event) => setInstallOs(event.target.checked)} />
          <span className="text-sm">
            <span className="block font-semibold">{t('settings.sgp.preReg.installOs')}</span>
            <span className="text-muted-foreground">{t('settings.sgp.preReg.installOsHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-3 sm:col-span-2">
          <input type="checkbox" className="mt-1" checked={activate} disabled={!canConfigure} onChange={(event) => setActivate(event.target.checked)} />
          <span className="text-sm">
            <span className="block font-semibold">{t('settings.sgp.preReg.activate')}</span>
            <span className="text-muted-foreground">{t('settings.sgp.preReg.activateHint')}</span>
          </span>
        </label>
      </div>

      {canConfigure && (
        <div className="mt-4">
          <button type="button" className="modern-button" disabled={saving} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      )}
    </div>
  )
}
