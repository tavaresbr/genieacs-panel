'use client'

import { useEffect, useState } from 'react'
import { sgpAPI, type SgpCatalogImport, type SgpCatalogKind, type SgpConfig, type SgpSplitter } from '@/lib/api'
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
 * What the SGP sent, folded into what is on screen: the SGP's name wins for an
 * id it knows, rows typed by hand that it does not list stay.
 */
export function mergeRows(current: Row[], imported: Row[]): Row[] {
  const byId = new Map(imported.map((row) => [row.id, row]))
  const kept = current.filter((row) => row.id && !byId.has(row.id) && row.label.trim())
  return [...imported, ...kept]
}

const KIND_LABEL: Record<SgpCatalogKind, 'settings.sgp.preReg.plans' | 'settings.sgp.preReg.dueDays' | 'settings.sgp.preReg.pops' | 'settings.sgp.preReg.portadores' | 'settings.sgp.preReg.sellers' | 'settings.sgp.preReg.technicians' | 'settings.sgp.preReg.splitters'> = {
  plano: 'settings.sgp.preReg.plans',
  vencimento: 'settings.sgp.preReg.dueDays',
  pop: 'settings.sgp.preReg.pops',
  portador: 'settings.sgp.preReg.portadores',
  vendedor: 'settings.sgp.preReg.sellers',
  tecnico: 'settings.sgp.preReg.technicians',
  splitter: 'settings.sgp.preReg.splitters'
}

/**
 * The SGP ids a client-with-contract needs (Novo cliente → "Cliente com
 * contrato"). "Importar do SGP" tries the install's list routes (not in the
 * URA docs, so each list says whether it answered); what does not come is
 * typed here, with the name the operator will pick by.
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
  const [pops, setPops] = useState<Row[]>([])
  const [portadores, setPortadores] = useState<Row[]>([])
  const [sellers, setSellers] = useState<Row[]>([])
  const [technicians, setTechnicians] = useState<Row[]>([])
  const [splitters, setSplitters] = useState<SgpSplitter[]>([])
  const [listPath, setListPath] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<SgpCatalogImport | null>(null)
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
    setPops(toRows(config.preRegPops))
    setPortadores(toRows(config.preRegPortadores))
    setSellers(toRows(config.preRegSellers))
    setTechnicians(toRows(config.preRegTechnicians))
    setSplitters(config.preRegSplitters ?? [])
    setListPath(config.endpoints?.preRegistrationList ?? '/api/precadastro/{kind}/list')
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
        preRegPops: clean(pops),
        preRegPortadores: clean(portadores),
        preRegSellers: clean(sellers),
        preRegTechnicians: clean(technicians),
        preRegSplitters: splitters,
        endpoints: { preRegistrationList: listPath.trim() } as SgpConfig['endpoints'],
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

  // Fills the lists from the SGP. Nothing is saved until the admin saves, and
  // a list the SGP did not answer keeps what is on screen.
  const importFromSgp = async () => {
    setImporting(true)
    try {
      const res = await sgpAPI.importPreRegistration()
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.sgp.preReg.importFailed'))
        return
      }
      const { results } = res.data
      const rows = (kind: SgpCatalogKind) => toRows(results[kind].items)
      const apply = (kind: SgpCatalogKind, setRows: (update: (rows: Row[]) => Row[]) => void) => {
        if (results[kind].ok && results[kind].count > 0) setRows((current) => mergeRows(current, rows(kind)))
      }
      apply('plano', setPlans)
      apply('vencimento', setDueDays)
      apply('pop', setPops)
      apply('portador', setPortadores)
      apply('vendedor', setSellers)
      apply('tecnico', setTechnicians)
      if (results.splitter.ok && results.splitter.count > 0) {
        setSplitters(results.splitter.items.map((item) => ({ ...item, label: item.label ?? item.name ?? String(item.id) })))
      }
      setImportResult(res.data)
      const imported = Object.values(results).filter((entry) => entry.ok && entry.count > 0).length
      if (imported > 0) toast.success(t('settings.sgp.preReg.importDone', { count: imported }))
      else toast.error(t('settings.sgp.preReg.importNothing'))
    } finally {
      setImporting(false)
    }
  }

  const listEditor = (
    rows: Row[],
    setRows: (rows: Row[]) => void,
    labelKey: 'settings.sgp.preReg.planName' | 'settings.sgp.preReg.dueDayLabel' | 'settings.sgp.preReg.itemName',
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

      {canConfigure && (
        <div className="mt-4 rounded-md border border-border p-3" data-testid="sgp-prereg-import">
          <div className="flex flex-wrap items-end gap-3">
            <button type="button" className="modern-button-secondary" disabled={importing} onClick={() => void importFromSgp()}>
              <Icon name="refresh" size={16} className={importing ? 'animate-spin' : ''} />
              {importing ? t('settings.sgp.preReg.importing') : t('settings.sgp.preReg.import')}
            </button>
            <div className="min-w-[16rem] flex-1">
              <label className="field-label" htmlFor="sgp-prereg-list-path">{t('settings.sgp.preReg.listPath')}</label>
              <input
                id="sgp-prereg-list-path"
                className="modern-input font-mono"
                value={listPath}
                onChange={(event) => setListPath(event.target.value)}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('settings.sgp.preReg.importHint')}</p>
          {importResult && (
            <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2" data-testid="sgp-prereg-import-result">
              {(Object.keys(KIND_LABEL) as SgpCatalogKind[]).map((kind) => {
                const entry = importResult.results[kind]
                const good = entry?.ok && entry.count > 0
                return (
                  <li key={kind} className={good ? 'text-[hsl(var(--status-success))]' : 'text-muted-foreground'}>
                    {good ? '✓' : '✗'} {t(KIND_LABEL[kind])}: {good
                      ? t('settings.sgp.preReg.importCount', { count: entry.count })
                      : entry?.ok
                        ? t('settings.sgp.preReg.importEmpty')
                        : t('settings.sgp.preReg.importMissing', { error: entry?.error ?? '' })}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <p className="field-label">{t('settings.sgp.preReg.plans')}</p>
          {listEditor(plans, setPlans, 'settings.sgp.preReg.planName', 'sgp-prereg-plans')}
        </div>
        <div>
          <p className="field-label">{t('settings.sgp.preReg.dueDays')}</p>
          {listEditor(dueDays, setDueDays, 'settings.sgp.preReg.dueDayLabel', 'sgp-prereg-due-days')}
        </div>
        <div>
          <p className="field-label">{t('settings.sgp.preReg.sellers')}</p>
          {listEditor(sellers, setSellers, 'settings.sgp.preReg.itemName', 'sgp-prereg-sellers')}
        </div>
        <div>
          <p className="field-label">{t('settings.sgp.preReg.technicians')}</p>
          {listEditor(technicians, setTechnicians, 'settings.sgp.preReg.itemName', 'sgp-prereg-technicians')}
        </div>
        <div>
          <p className="field-label">{t('settings.sgp.preReg.pops')}</p>
          {listEditor(pops, setPops, 'settings.sgp.preReg.itemName', 'sgp-prereg-pops')}
        </div>
        <div>
          <p className="field-label">{t('settings.sgp.preReg.portadores')}</p>
          {listEditor(portadores, setPortadores, 'settings.sgp.preReg.itemName', 'sgp-prereg-portadores')}
        </div>
        {([
          ['sgp-prereg-pop', 'settings.sgp.preReg.popId', popId, setPopId, pops],
          ['sgp-prereg-portador', 'settings.sgp.preReg.portadorId', portadorId, setPortadorId, portadores],
          ['sgp-prereg-vendedor', 'settings.sgp.preReg.vendedorId', vendedorId, setVendedorId, sellers]
        ] as const).map(([id, labelKey, value, setValue, options]) => {
          const listed = options.filter((row) => row.id && row.label.trim())
          return (
            <div key={id}>
              <label className="field-label" htmlFor={id}>{t(labelKey)}</label>
              {listed.length > 0 ? (
                <select
                  id={id}
                  className="modern-input"
                  value={value}
                  disabled={!canConfigure}
                  onChange={(event) => setValue(event.target.value)}
                >
                  <option value="">—</option>
                  {value && !listed.some((row) => row.id === value) && <option value={value}>{value}</option>}
                  {listed.map((row) => <option key={row.id} value={row.id}>{row.label} ({row.id})</option>)}
                </select>
              ) : (
                <input
                  id={id}
                  className="modern-input font-mono"
                  inputMode="numeric"
                  value={value}
                  disabled={!canConfigure}
                  onChange={(event) => setValue(event.target.value.replace(/\D/g, ''))}
                />
              )}
            </div>
          )
        })}
        <div className="sm:col-span-2" data-testid="sgp-prereg-splitters">
          <p className="field-label">{t('settings.sgp.preReg.splitters')}</p>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>
              {splitters.length > 0
                ? t('settings.sgp.preReg.splittersSummary', {
                  count: splitters.length,
                  located: splitters.filter((splitter) => typeof splitter.lat === 'number').length
                })
                : t('settings.sgp.preReg.splittersNone')}
            </span>
            {canConfigure && splitters.length > 0 && (
              <button type="button" className="modern-button-secondary" onClick={() => setSplitters([])}>
                {t('settings.sgp.preReg.clear')}
              </button>
            )}
          </div>
        </div>
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
