'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router'
import { devicesAPI, sgpAPI, vendorsAPI, type SgpContractState, type SgpLinkRow } from '@/lib/api'
import { useLoading } from '@/components/ui/loading'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { formatDate } from '@/lib/utils'
import type { Device, Vendor } from '@/types'

interface ProcessedDevice extends Device {
  isOnline: boolean
  brand: string
}

type SgpFilter = 'all' | SgpContractState | 'unlinked'

const SGP_STATE_BADGES: Record<SgpContractState, string> = {
  active: 'modern-badge-success',
  blocked: 'modern-badge-warning',
  cancelled: 'modern-badge-error',
  unknown: 'modern-badge',
}

const SGP_STATE_LABEL_KEYS = {
  active: 'devices.sgp.state.active',
  blocked: 'devices.sgp.state.blocked',
  cancelled: 'devices.sgp.state.cancelled',
  unknown: 'devices.sgp.state.unknown',
} as const

export default function DevicesPage() {
  const [devices, setDevices] = useState<ProcessedDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterSgp, setFilterSgp] = useState<SgpFilter>('all')
  const [sgpLinks, setSgpLinks] = useState<Map<string, SgpLinkRow>>(new Map())
  const [sgpAvailable, setSgpAvailable] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)

  const loadingCtl = useLoading()
  const toast = useToast()
  const { t } = useTranslation()

  const getSignalStrengthInfo = (rxPowerStr: any) => {
    const rxpower = parseFloat(String(rxPowerStr));

    if (isNaN(rxpower)) {
      return {
        color: 'text-gray-500 dark:text-gray-400',
        label: t('common.na'),
        badgeClass: 'modern-badge'
      };
    }

    if (rxpower >= -21.99) {
      return {
        color: 'text-green-600 dark:text-green-400',
        label: t('devices.signal.excellent'),
        badgeClass: 'modern-badge-success'
      };
    }
    if (rxpower >= -24.99) {
      return {
        color: 'text-blue-600 dark:text-blue-400',
        label: t('devices.signal.good'),
        badgeClass: 'modern-badge-info'
      };
    }
    if (rxpower >= -26.99) {
      return {
        color: 'text-yellow-600 dark:text-yellow-400',
        label: t('devices.signal.poor'),
        badgeClass: 'modern-badge-warning'
      };
    }
    return {
      color: 'text-red-600 dark:text-red-400',
      label: t('devices.signal.danger'),
      badgeClass: 'modern-badge-error'
    };
  }

  const findBrand = useCallback((manufacturer: string, productClass: string, vendors: Vendor[]) => {
    manufacturer = manufacturer?.toLowerCase() || ''
    productClass = productClass?.toLowerCase() || ''

    const sortedVendors = [...vendors].sort((a, b) => (b.priority || 0) - (a.priority || 0))

    for (const vendor of sortedVendors) {
      const manPatterns = vendor.manufacturer_patterns || []
      const prodPatterns = vendor.product_patterns || []

      const manMatch = manPatterns.some((p: string) => manufacturer.includes(p.toLowerCase()))
      const prodMatch = prodPatterns.some((p: string) => productClass.includes(p.toLowerCase()))

      if (manMatch || prodMatch) {
        return vendor.name
      }
    }

    return manufacturer || 'Unknown'
  }, [])

  const processDeviceData = useCallback((devices: Device[], vendors: Vendor[]) => {
    const now = new Date()
    return devices.map((item: Device) => {
      const lastInform = item._lastInform ? new Date(item._lastInform) : null
      const lastInformMs = lastInform?.getTime()
      const ageMs = lastInformMs === undefined ? Number.NaN : now.getTime() - lastInformMs
      const isOnline = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 10 * 60 * 1000

      const manufacturer = item.manufacturer || ''
      const productClass = item.productclass || 'Unknown'
      const brand = findBrand(manufacturer, productClass, vendors)

      return {
        ...item,
        isOnline,
        brand: brand,
      }
    })
  }, [findBrand])

  const handleSummon = async (e: React.MouseEvent, deviceId: string) => {
    e.preventDefault();
    e.stopPropagation();

    loadingCtl.show(t('devices.summon.loading'));
    try {
      const res = await devicesAPI.summonDevice(deviceId);
      if (res.success) {
        toast.success(res.message || t('devices.summon.success'));
      } else {
        toast.error(res.message || t('devices.summon.failed'));
      }
    } catch (error: any) {
      toast.error(error.message || t('devices.summon.error'));
    } finally {
      loadingCtl.hide();
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')

    const fetchData = async () => {
      try {
        const [devicesRes, vendorsRes] = await Promise.all([
          devicesAPI.getDevices(),
          vendorsAPI.getAll()
        ]);

        if (cancelled) return

        if (devicesRes.success && vendorsRes.success) {
          const devices = devicesRes.data as Device[]
          const vendors = vendorsRes.data as Vendor[]

          const processed = processDeviceData(devices, vendors)
          setDevices(processed)

        } else {
          setLoadError(t('devices.error.inventory'))
        }
      } catch {
        if (!cancelled) {
          setLoadError(t('devices.error.unreachable'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchData()

    return () => { cancelled = true }
  }, [processDeviceData, refreshNonce, t])

  // The SGP links load apart from the inventory: when the integration is off
  // (or momentarily unreachable) the panel simply drops the contract column.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      const res = await sgpAPI.getLinks()
      if (cancelled) return
      if (!res.success || !res.data) {
        setSgpAvailable(false)
        setSgpLinks(new Map())
        return
      }
      setSgpAvailable(true)
      setSgpLinks(new Map((res.data.links || []).map((link) => [link.deviceId, link])))
    })()

    return () => { cancelled = true }
  }, [refreshNonce])

  const filteredDevices = useMemo(() => {
    return devices.filter(device => {
      const search = searchTerm.toLowerCase()
      const statusMatch = filterStatus === 'all' ||
                          (filterStatus === 'online' && device.isOnline) ||
                          (filterStatus === 'offline' && !device.isOnline)

      const link = sgpLinks.get(device._id)
      const sgpMatch = !sgpAvailable || filterSgp === 'all' ||
                       (filterSgp === 'unlinked' ? !link : link?.state === filterSgp)

      const searchMatch = !search ||
                          (device._id || '').toLowerCase().includes(search) ||
                          (device.SerialNumber || '').toLowerCase().includes(search) ||
                          device.brand.toLowerCase().includes(search) ||
                          (device.productclass || '').toLowerCase().includes(search) ||
                          device.pppoe?.toLowerCase().includes(search) ||
                          device.customerId?.toLowerCase().includes(search) ||
                          link?.contract.toLowerCase().includes(search) ||
                          link?.clientName?.toLowerCase().includes(search)

      return statusMatch && sgpMatch && searchMatch
    })
  }, [devices, searchTerm, filterStatus, filterSgp, sgpAvailable, sgpLinks])

  if (loading) {
    return (
      <div className="page-shell">
        <div className="page-frame">
          <div className="mb-5 h-24 animate-pulse rounded-md bg-muted" />
          <div className="modern-card h-[28rem] animate-pulse bg-muted" aria-label={t('devices.loadingAria')} />
        </div>
      </div>
    )
  }

  const totalOnline = devices.filter((device) => device.isOnline).length
  const hasFilters = Boolean(searchTerm) || filterStatus !== 'all' || filterSgp !== 'all'
  const clearFilters = () => { setSearchTerm(''); setFilterStatus('all'); setFilterSgp('all') }

  const DeviceStatus = ({ device }: { device: ProcessedDevice }) => (
    <span className={device.isOnline ? 'modern-badge-success' : 'modern-badge-error'}>
      <span className="status-dot" />
      {device.isOnline ? t('devices.status.online') : t('devices.status.offline')}
    </span>
  )

  const renderSgpCell = (device: ProcessedDevice) => {
    const link = sgpLinks.get(device._id)
    if (!link) {
      return <span className="modern-badge">{t('devices.sgp.unlinked')}</span>
    }
    return (
      <>
        <span className={SGP_STATE_BADGES[link.state]}>{t(SGP_STATE_LABEL_KEYS[link.state])}</span>
        <span className="mt-1 block truncate font-mono text-[0.68rem] text-muted-foreground" title={link.clientName || undefined}>
          {link.contract}{link.clientName ? ` · ${link.clientName}` : ''}
        </span>
      </>
    )
  }

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">{t('devices.kicker')}</p>
            <h1 className="page-title">{t('devices.title')}</h1>
            <p className="page-description">{t('devices.description')}</p>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span><strong className="data-value">{totalOnline}</strong> {t('devices.onlineLabel')}</span>
            <span aria-hidden="true">/</span>
            <span><strong className="data-value">{devices.length}</strong> {t('devices.totalLabel')}</span>
            <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} className="icon-button" aria-label={t('devices.refreshAria')}>
              <Icon name="refresh" size={18} />
            </button>
          </div>
        </header>

        {loadError ? (
          <section className="modern-card empty-state" role="alert">
            <div className="empty-state-icon text-[hsl(var(--status-danger))]"><Icon name="warning" size={22} /></div>
            <h2 className="empty-state-title">{t('devices.error.title')}</h2>
            <p className="empty-state-copy">{loadError}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} className="modern-button">{t('devices.error.retry')}</button>
              <Link to="/settings" className="modern-button-secondary">{t('devices.error.checkConfig')}</Link>
            </div>
          </section>
        ) : (
          <>
            <section className={`mb-4 grid gap-3 rounded-[var(--radius)] border border-border bg-card p-3 lg:items-end ${sgpAvailable ? 'lg:grid-cols-[minmax(16rem,1fr)_12rem_13rem_auto]' : 'lg:grid-cols-[minmax(18rem,1fr)_13rem_auto]'}`}>
              <div>
                <label htmlFor="device-search" className="field-label">{t('devices.filter.searchLabel')}</label>
                <div className="relative">
                  <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="device-search"
                    type="search"
                    placeholder={t('devices.filter.searchPlaceholder')}
                    className="modern-input pl-10"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="device-status" className="field-label">{t('devices.filter.statusLabel')}</label>
                <div className="relative">
                  <select id="device-status" className="modern-input appearance-none pr-10" value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}>
                    <option value="all">{t('devices.filter.all')}</option>
                    <option value="online">{t('devices.filter.onlineOnly')}</option>
                    <option value="offline">{t('devices.filter.offlineOnly')}</option>
                  </select>
                  <Icon name="chevron-down" size={17} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
              {sgpAvailable && (
                <div>
                  <label htmlFor="device-sgp" className="field-label">{t('devices.sgp.filterLabel')}</label>
                  <div className="relative">
                    <select id="device-sgp" className="modern-input appearance-none pr-10" value={filterSgp} onChange={(event) => setFilterSgp(event.target.value as SgpFilter)}>
                      <option value="all">{t('devices.sgp.filterAll')}</option>
                      <option value="active">{t('devices.sgp.filterActive')}</option>
                      <option value="blocked">{t('devices.sgp.filterBlocked')}</option>
                      <option value="cancelled">{t('devices.sgp.filterCancelled')}</option>
                      <option value="unlinked">{t('devices.sgp.filterUnlinked')}</option>
                    </select>
                    <Icon name="chevron-down" size={17} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
              )}
              <div className="flex min-h-11 items-center justify-between gap-3 px-1 text-sm text-muted-foreground lg:justify-end">
                <span><strong className="data-value">{filteredDevices.length}</strong> {t('devices.shownLabel')}</span>
                {hasFilters && (
                  <button type="button" onClick={clearFilters} className="font-semibold text-primary hover:underline">
                    {t('devices.filter.clear')}
                  </button>
                )}
              </div>
            </section>

            {filteredDevices.length === 0 ? (
              <section className="modern-card empty-state">
                <div className="empty-state-icon"><Icon name={hasFilters ? 'search' : 'server'} size={22} /></div>
                <h2 className="empty-state-title">{hasFilters ? t('devices.empty.filteredTitle') : t('devices.empty.title')}</h2>
                <p className="empty-state-copy">
                  {hasFilters ? t('devices.empty.filteredCopy') : t('devices.empty.copy')}
                </p>
                {hasFilters ? (
                  <button type="button" onClick={clearFilters} className="modern-button-secondary mt-5">{t('devices.filter.clear')}</button>
                ) : (
                  <Link to="/settings" className="modern-button mt-5">{t('devices.empty.checkConnection')}</Link>
                )}
              </section>
            ) : (
              <>
                <section className="modern-card desktop-table overflow-hidden">
                  <div className="max-h-[calc(100vh-18rem)] overflow-auto">
                    <table className="modern-table">
                      <thead>
                        <tr>
                          <th>{t('devices.table.status')}</th>
                          <th>{t('devices.table.serial')}</th>
                          <th>{t('devices.table.vendorModel')}</th>
                          <th>{t('devices.table.subscriber')}</th>
                          <th>{t('devices.table.customerId')}</th>
                          {sgpAvailable && <th>{t('devices.sgp.column')}</th>}
                          <th>{t('devices.table.opticalRx')}</th>
                          <th>{t('devices.table.lastInform')}</th>
                          <th><span className="sr-only">{t('common.actions')}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDevices.map((device) => {
                          const signalInfo = getSignalStrengthInfo(device.rxpower)
                          return (
                            <tr key={device._id}>
                              <td><DeviceStatus device={device} /></td>
                              <td className="max-w-[18rem]">
                                <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="block truncate font-mono text-sm font-semibold text-primary hover:underline">
                                  {device.SerialNumber || device._id}
                                </Link>
                                {device.SerialNumber && <span className="mt-1 block truncate font-mono text-[0.68rem] text-muted-foreground">{device._id}</span>}
                              </td>
                              <td>
                                <span className="block font-semibold">{device.brand}</span>
                                <span className="mt-0.5 block text-xs text-muted-foreground">{device.productclass || t('devices.modelNotReported')}</span>
                              </td>
                              <td className="font-mono text-xs">{device.pppoe || t('devices.notReported')}</td>
                              <td className="font-mono text-xs font-semibold">{device.customerId || t('devices.notGenerated')}</td>
                              {sgpAvailable && <td className="max-w-[14rem]">{renderSgpCell(device)}</td>}
                              <td>
                                <span className={`font-mono text-sm font-semibold ${signalInfo.color}`}>
                                  {device.rxpower !== null && device.rxpower !== undefined ? `${device.rxpower} dBm` : t('common.na')}
                                </span>
                                <span className="mt-0.5 block text-[0.68rem] text-muted-foreground">{signalInfo.label}</span>
                              </td>
                              <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(device._lastInform)}</td>
                              <td>
                                <div className="flex justify-end gap-1">
                                  <button onClick={(event) => handleSummon(event, device._id)} className="icon-button" title={t('devices.summon.title')} aria-label={t('devices.summon.aria', { device: device.SerialNumber || device._id })}>
                                    <Icon name="bell" size={17} />
                                  </button>
                                  <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="icon-button" aria-label={t('devices.summon.open', { device: device.SerialNumber || device._id })}>
                                    <Icon name="chevron-right" size={17} />
                                  </Link>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="mobile-card-list space-y-3" aria-label={t('devices.title')}>
                  {filteredDevices.map((device) => {
                    const signalInfo = getSignalStrengthInfo(device.rxpower)
                    return (
                      <article key={device._id} className="mobile-data-card">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <DeviceStatus device={device} />
                            <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="mt-2 block truncate font-mono text-sm font-semibold text-primary">
                              {device.SerialNumber || device._id}
                            </Link>
                            <p className="mt-1 truncate text-xs text-muted-foreground">{device.brand} · {device.productclass || t('devices.unknownModel')}</p>
                          </div>
                          <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="icon-button shrink-0" aria-label={t('devices.summon.open', { device: device.SerialNumber || device._id })}>
                            <Icon name="chevron-right" size={18} />
                          </Link>
                        </div>
                        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 text-sm">
                          <div><dt className="text-xs text-muted-foreground">PPPoE</dt><dd className="mt-1 truncate font-mono text-xs">{device.pppoe || t('devices.notReported')}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">{t('devices.table.customerId')}</dt><dd className="mt-1 truncate font-mono text-xs font-semibold">{device.customerId || t('devices.notGenerated')}</dd></div>
                          {sgpAvailable && <div className="col-span-2"><dt className="text-xs text-muted-foreground">{t('devices.sgp.column')}</dt><dd className="mt-1">{renderSgpCell(device)}</dd></div>}
                          <div><dt className="text-xs text-muted-foreground">{t('devices.table.opticalRx')}</dt><dd className={`mt-1 font-mono text-xs font-semibold ${signalInfo.color}`}>{device.rxpower ?? t('common.na')}{device.rxpower !== null && device.rxpower !== undefined ? ' dBm' : ''}</dd></div>
                          <div className="col-span-2"><dt className="text-xs text-muted-foreground">{t('devices.table.lastInform')}</dt><dd className="mt-1 text-xs">{formatDate(device._lastInform)}</dd></div>
                        </dl>
                        <button onClick={(event) => handleSummon(event, device._id)} className="modern-button-secondary mt-4 w-full">
                          <Icon name="bell" size={17} /> {t('devices.summon.button')}
                        </button>
                      </article>
                    )
                  })}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
