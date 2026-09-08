'use client'

import { useState, useEffect } from 'react'
import { apiClient, vendorsAPI, settingsAPI, authAPI, databaseAPI, sgpAPI, type DbConfigPayload, type SgpConfig } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useLoading } from '@/components/ui/loading'
import { Icon } from '@/components/ui/icon'
import { LanguageSwitcher } from '@/components/language-switcher'
import { ProvisioningTab } from '@/components/settings/provisioning-tab'
import { SgpEventsPanel } from '@/components/settings/sgp-events-panel'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import type { Vendor as VendorType, WifiSecurityConfig as WifiSecurityConfigType } from '@/types'

const INSTALLER_VIRTUAL_PARAMETERS = {
  vpPppoeUsername: 'VirtualParameters.PPPUsername',
  vpWanBridge: 'VirtualParameters.WANBridge',
  vpRxPower: 'VirtualParameters.OpticalRXPower',
  vpTemperature: 'VirtualParameters.OpticalTemperature',
  vpActiveDevices: 'VirtualParameters.TotalStations',
  vpSuperAdmin: 'VirtualParameters.LoginSuperUser',
  vpSuperPassword: 'VirtualParameters.LoginSuperPass',
  vpUserAdmin: '',
  vpUserPassword: ''
}

/** `hintKey` is set for the fields the installer does not provide; the others show the raw parameter name. */
const VIRTUAL_PARAMETER_FIELDS: {
  key: keyof typeof INSTALLER_VIRTUAL_PARAMETERS
  labelKey: TranslationKey
  parameterName?: string
  hintKey?: TranslationKey
}[] = [
  { key: 'vpPppoeUsername', labelKey: 'settings.vp.pppoeUsername', parameterName: 'PPPUsername' },
  { key: 'vpWanBridge', labelKey: 'settings.vp.wanBridge', parameterName: 'WANBridge' },
  { key: 'vpRxPower', labelKey: 'settings.vp.rxPower', parameterName: 'OpticalRXPower' },
  { key: 'vpTemperature', labelKey: 'settings.vp.temperature', parameterName: 'OpticalTemperature' },
  { key: 'vpActiveDevices', labelKey: 'settings.vp.activeDevices', parameterName: 'TotalStations' },
  { key: 'vpSuperAdmin', labelKey: 'settings.vp.superAdmin', parameterName: 'LoginSuperUser' },
  { key: 'vpSuperPassword', labelKey: 'settings.vp.superPassword', parameterName: 'LoginSuperPass' },
  { key: 'vpUserAdmin', labelKey: 'settings.vp.userAdmin', hintKey: 'settings.vp.optionalHint' },
  { key: 'vpUserPassword', labelKey: 'settings.vp.userPassword', hintKey: 'settings.vp.optionalHint' }
]

export default function Settings() {
  const { t, formatDateTime } = useTranslation()
  const [settings, setSettings] = useState({
    appName: 'SkyGenPanel',
    genieAcsUrl: 'http://127.0.0.1:7557',
    autoGenerateCustomerId: 'false',
    customerIdPrefixMode: 'default',
    customerIdCompanyPrefix: 'CSG',
    customerIdSuffixMode: 'random',
    ...INSTALLER_VIRTUAL_PARAMETERS
  })
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [testResult, setTestResult] = useState<{success: boolean, message: string, deviceCount?: number} | null>(null)
  const [dbForm, setDbForm] = useState<DbConfigPayload>({
    client: 'mysql2', host: 'localhost', port: 3306, user: '', password: '', database: '', migrateData: true
  })
  const [activeDb, setActiveDb] = useState<{ client: string; host?: string; database?: string } | null>(null)
  const [sgpConfig, setSgpConfig] = useState<SgpConfig | null>(null)
  const [sgpForm, setSgpForm] = useState({
    enabled: false,
    baseUrl: '',
    app: '',
    token: '',
    linkMode: 'pppoe' as SgpConfig['linkMode'],
    portalBilling: true,
    portalUnlock: false,
    invoiceLimit: 6,
    sample: ''
  })
  const [sgpSaving, setSgpSaving] = useState(false)
  const [sgpTesting, setSgpTesting] = useState(false)
  const [sgpTestResult, setSgpTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [dbTesting, setDbTesting] = useState(false)
  const [dbSwitching, setDbSwitching] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await settingsAPI.getAll()
      if (!cancelled && res.success && res.data) {
        setSettings(prev => ({ ...prev, ...(res.data as any) }))
      }
      setTestResult(null)
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (activeTab !== 'database') return
    let cancelled = false
    ;(async () => {
      const res = await databaseAPI.getConfig()
      if (!cancelled && res.success && res.data) {
        setActiveDb(res.data as any)
      }
    })()
    return () => { cancelled = true }
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'sgp') return
    let cancelled = false
    ;(async () => {
      const res = await sgpAPI.getConfig()
      if (cancelled || !res.success || !res.data) return
      const config = res.data
      setSgpConfig(config)
      setSgpForm((current) => ({
        ...current,
        enabled: config.enabled,
        baseUrl: config.baseUrl,
        app: config.app,
        // The stored token never leaves the server; an empty field keeps it.
        token: '',
        linkMode: config.linkMode,
        portalBilling: config.portalBilling,
        portalUnlock: config.portalUnlock,
        invoiceLimit: config.invoiceLimit
      }))
      setSgpTestResult(null)
    })()
    return () => { cancelled = true }
  }, [activeTab])

  const sgpSamplePayload = () => {
    const sample = sgpForm.sample.trim()
    if (!sample) return {}
    if (/^\d[\d.\-/]*$/.test(sample)) {
      return sample.replace(/\D/g, '').length > 8
        ? { document: sample }
        : { contract: sample }
    }
    return { login: sample }
  }

  const handleSgpTest = async () => {
    setSgpTesting(true)
    setSgpTestResult(null)
    try {
      const res = await sgpAPI.test({
        baseUrl: sgpForm.baseUrl,
        app: sgpForm.app,
        token: sgpForm.token || undefined,
        ...sgpSamplePayload()
      })
      const message = res.message || t(res.success ? 'settings.sgp.testSuccess' : 'settings.sgp.testFailed')
      setSgpTestResult({ success: res.success, message })
      toast[res.success ? 'success' : 'error'](message)
    } finally {
      setSgpTesting(false)
    }
  }

  const handleSgpSave = async () => {
    setSgpSaving(true)
    try {
      const res = await sgpAPI.updateConfig({
        enabled: sgpForm.enabled,
        baseUrl: sgpForm.baseUrl,
        app: sgpForm.app,
        // Only send the token when the operator typed a new one.
        ...(sgpForm.token ? { token: sgpForm.token } : {}),
        linkMode: sgpForm.linkMode,
        portalBilling: sgpForm.portalBilling,
        portalUnlock: sgpForm.portalUnlock,
        invoiceLimit: sgpForm.invoiceLimit
      })
      if (res.success && res.data) {
        setSgpConfig(res.data)
        setSgpForm((current) => ({ ...current, token: '' }))
      }
      toast[res.success ? 'success' : 'error'](
        res.message || t(res.success ? 'settings.sgp.saved' : 'settings.sgp.saveFailed')
      )
    } finally {
      setSgpSaving(false)
    }
  }

  const handleSgpClearToken = async () => {
    if (!confirm(t('settings.sgp.clearTokenConfirm'))) return
    setSgpSaving(true)
    try {
      const res = await sgpAPI.updateConfig({ enabled: false, token: '' })
      if (res.success && res.data) {
        setSgpConfig(res.data)
        setSgpForm((current) => ({ ...current, enabled: false, token: '' }))
      }
      toast[res.success ? 'success' : 'error'](res.message || t('settings.sgp.tokenCleared'))
    } finally {
      setSgpSaving(false)
    }
  }

  const handleDbTest = async () => {
    setDbTesting(true)
    try {
      const res = await databaseAPI.test(dbForm)
      const message = res.message || (res.success ? t('settings.db.testSuccess') : t('settings.db.testFailed'))
      toast[res.success ? 'success' : 'error'](message)
    } catch (e: any) {
      toast.error(e?.message || t('settings.db.testFailed'))
    } finally {
      setDbTesting(false)
    }
  }

  const handleDbSwitch = async () => {
    const label = dbForm.client === 'sqlite3'
      ? t('settings.db.sqlite')
      : t('settings.db.mysql', { database: String(dbForm.database), host: String(dbForm.host) })
    const dataNotice = dbForm.migrateData ? t('settings.db.confirmCopy') : t('settings.db.confirmNoCopy')
    if (!confirm(t('settings.db.confirmSwitch', { label, dataNotice }))) return
    setDbSwitching(true)
    try {
      const res = await databaseAPI.switch(dbForm)
      const message = res.message || (res.success ? t('settings.db.switched') : t('settings.db.switchFailed'))
      toast[res.success ? 'success' : 'error'](message)
      if (res.success && res.data) setActiveDb(res.data as any)
    } catch (e: any) {
      toast.error(e?.message || t('settings.db.switchFailed'))
    } finally {
      setDbSwitching(false)
    }
  }

  const handleTestConnection = async () => {
    setLoading(true)
    loadingCtl.show(t('settings.general.testingProgress'))
    try {
      const res = await settingsAPI.testGenieAcs(settings.genieAcsUrl)
      if (res.success) {
        setTestResult({
          success: true,
          message: res.message || t('settings.general.connectionOk'),
          deviceCount: (res.data as any)?.deviceCount
        })
        toast.success(t('settings.general.connectionToastOk'))
      } else {
        setTestResult({
          success: false,
          message: res.message || t('settings.general.connectionFailed')
        })
        toast.error(res.message || t('settings.general.connectionFailed'))
      }
    } finally {
      setLoading(false)
      loadingCtl.hide()
    }
  }

  const toast = useToast()
  const loadingCtl = useLoading()

  const [usernameForm, setUsernameForm] = useState<{ currentUsername: string; newUsername: string }>({
    currentUsername: '',
    newUsername: ''
  })
  const [passwordForm, setPasswordForm] = useState<{ currentPassword: string; newPassword: string; confirmNewPassword: string }>({
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: ''
  })

  const submitChangeUsername = async () => {
    const res = await authAPI.changeUsername(usernameForm.currentUsername, usernameForm.newUsername)
    if (res.success) {
      toast.success(res.message || t('settings.security.usernameUpdated'))
      setUsernameForm({ currentUsername: '', newUsername: '' })
    } else {
      toast.error(res.message || t('settings.security.usernameFailed'))
    }
  }

  const submitChangePassword = async () => {
    if (!passwordForm.newPassword || passwordForm.newPassword !== passwordForm.confirmNewPassword) {
      toast.error(t('settings.security.passwordMismatch'))
      return
    }
    const res = await authAPI.changePassword(passwordForm.currentPassword, passwordForm.newPassword)
    if (res.success) {
      toast.success(t('settings.security.passwordUpdated'))
      setPasswordForm({ currentPassword: '', newPassword: '', confirmNewPassword: '' })
      apiClient.clearTokens()
    } else {
      toast.error(res.message || t('settings.security.passwordFailed'))
    }
  }

  const handleSaveSettings = async () => {
    setLoading(true)
    loadingCtl.show(t('settings.savingProgress'))
    let ok = true
    try {
      const entries = Object.entries(settings).sort(([left], [right]) => {
        if (left === 'autoGenerateCustomerId') return 1
        if (right === 'autoGenerateCustomerId') return -1
        return 0
      })
      for (const [key, value] of entries) {
        const res = await settingsAPI.update(key, String(value))
        if (!res.success) {
          ok = false
          break
        }
      }
      let successMessage = t('settings.saveSuccess')
      let errorMessage = t('settings.saveError')
      if (ok && settings.autoGenerateCustomerId === 'true') {
        const sync = await settingsAPI.syncCustomerIds()
        if (!sync.success) {
          ok = false
          errorMessage = sync.message || t('settings.syncError')
        } else {
          const result = sync.data as { generated?: number; existing?: number; pending?: number }
          successMessage = t('settings.syncSummary', {
            message: sync.message || t('settings.syncSuccess'),
            generated: result.generated || 0,
            existing: result.existing || 0,
          })
        }
      }
      toast[ok ? 'success' : 'error'](ok ? successMessage : errorMessage)
      if (ok) {
        try {
          localStorage.setItem('appName', settings.appName)
          window.dispatchEvent(new CustomEvent('appNameChanged', { detail: settings.appName }))
        } catch {}
      }
    } finally {
      setLoading(false)
      loadingCtl.hide()
    }
  }

  const [vendorList, setVendorList] = useState<VendorType[]>([])
  const [vendorsLoading, setVendorsLoading] = useState(false)
  const [creatingVendor, setCreatingVendor] = useState(false)
  const [editingVendor, setEditingVendor] = useState<VendorType | null>(null)

  const [vendorForm, setVendorForm] = useState<{
    name: string
    parameter_prefix: string
    manufacturer_patterns: string
    product_patterns: string
    service_list_path: string
    lan_binding_path: string
    vlan_id_path: string
    wifi_password_path: string
    http_wan_enable_path: string
    firewall_level_path: string
    priority: number
    enabled: number
    description: string
  }>({
    name: '',
    parameter_prefix: '',
    manufacturer_patterns: '',
    product_patterns: '',
    service_list_path: '',
    lan_binding_path: '',
    vlan_id_path: '',
    wifi_password_path: '',
    http_wan_enable_path: '',
    firewall_level_path: '',
    priority: 10,
    enabled: 1,
    description: '',
  })

  const fetchVendors = async () => {
    setVendorsLoading(true)
    const res = await vendorsAPI.getAll()
    if (res.success && Array.isArray(res.data)) {
      setVendorList(res.data as unknown as VendorType[])
    }
    setVendorsLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'vendors') {
      fetchVendors()
    }
  }, [activeTab])

  const resetVendorForm = () => {
    setVendorForm({
      name: '',
      parameter_prefix: '',
      manufacturer_patterns: '',
      product_patterns: '',
      service_list_path: '',
      lan_binding_path: '',
      vlan_id_path: '',
      wifi_password_path: '',
      http_wan_enable_path: '',
      firewall_level_path: '',
      priority: 10,
      enabled: 1,
      description: '',
    })
    setEditingVendor(null)
    setCreatingVendor(false)
  }

  const submitVendor = async () => {
    const payload: any = {
      name: vendorForm.name,
      parameter_prefix: vendorForm.parameter_prefix || null,
      manufacturer_patterns: vendorForm.manufacturer_patterns.split(',').map(s => s.trim()).filter(Boolean),
      product_patterns: vendorForm.product_patterns.split(',').map(s => s.trim()).filter(Boolean),
      service_list_path: vendorForm.service_list_path || null,
      lan_binding_path: vendorForm.lan_binding_path || null,
      vlan_id_path: vendorForm.vlan_id_path || null,
      wifi_password_path: vendorForm.wifi_password_path || null,
      http_wan_enable_path: vendorForm.http_wan_enable_path || null,
      firewall_level_path: vendorForm.firewall_level_path || null,
      priority: Number(vendorForm.priority) || 10,
      enabled: Number(vendorForm.enabled) ? 1 : 0,
      description: vendorForm.description || null,
    }
    let res
    if (editingVendor) {
      res = await vendorsAPI.update(editingVendor.id, payload)
    } else {
      res = await vendorsAPI.create(payload)
    }
    if (res.success) {
      const msg = editingVendor ? t('settings.vendors.updated') : t('settings.vendors.created')
      toast.success(msg)
      await fetchVendors()
      resetVendorForm()
    } else {
      const msg = res.message || t('settings.operationFailed')
      toast.error(msg)
    }
  }

  const deleteVendor = async (id: number) => {
    const vendor = vendorList.find((item) => item.id === id)
    if (!confirm(t('settings.vendors.confirmDelete', { name: vendor?.name || id }))) return
    const res = await vendorsAPI.delete(id)
    if (res.success) {
      setVendorList(prev => prev.filter(v => v.id !== id))
      toast.success(t('settings.vendors.deleted'))
    } else {
      const msg = res.message || t('settings.vendors.deleteFailed')
      toast.error(msg)
    }
  }

  const [wifiConfigs, setWifiConfigs] = useState<WifiSecurityConfigType[]>([])
  const [wifiConfigLoading, setWifiConfigLoading] = useState(false)
  const [creatingConfig, setCreatingConfig] = useState(false)
  const [configForm, setConfigForm] = useState<{ product_class: string; security_types: string; password_param_path: string }>({
    product_class: '',
    security_types: '',
    password_param_path: ''
  })
  const [editingConfig, setEditingConfig] = useState<WifiSecurityConfigType | null>(null)

  const fetchWifiConfigs = async () => {
    setWifiConfigLoading(true)
    const res = await vendorsAPI.getAllWifiSecurityConfigs()
    if (res.success && Array.isArray(res.data)) {
      setWifiConfigs(res.data as unknown as WifiSecurityConfigType[])
    }
    setWifiConfigLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'wifi-security') {
      fetchWifiConfigs()
    }
  }, [activeTab])

  const resetConfigForm = () => {
    setConfigForm({ product_class: '', security_types: '', password_param_path: '' })
    setEditingConfig(null)
    setCreatingConfig(false)
  }

  const submitWifiConfig = async () => {
    const payload = {
      product_class: configForm.product_class,
      security_types: configForm.security_types,
      password_param_path: configForm.password_param_path,
    }
    let res
    if (editingConfig) {
      res = await vendorsAPI.updateWifiSecurityConfig(editingConfig.id, payload)
    } else {
      res = await vendorsAPI.createWifiSecurityConfig(payload)
    }
    if (res.success) {
      const msg = editingConfig ? t('settings.wifi.updated') : t('settings.wifi.created')
      toast.success(msg)
      await fetchWifiConfigs()
      resetConfigForm()
    } else {
      const msg = res.message || t('settings.operationFailed')
      toast.error(msg)
    }
  }

  const deleteWifiConfig = async (id: number) => {
    const config = wifiConfigs.find((item) => item.id === id)
    if (!confirm(t('settings.wifi.confirmDelete', { name: config?.product_class || id }))) return
    const res = await vendorsAPI.deleteWifiSecurityConfig(id)
    if (res.success) {
      setWifiConfigs(prev => prev.filter(c => c.id !== id))
      toast.success(t('settings.wifi.deleted'))
    } else {
      const msg = res.message || t('settings.wifi.deleteFailed')
      toast.error(msg)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">{t('settings.kicker')}</p>
            <h1 className="page-title">{t('settings.title')}</h1>
            <p className="page-description">{t('settings.description')}</p>
          </div>
        </header>

        <div className="mb-6">
          <div className="tab-rail" role="tablist" aria-label={t('settings.sectionsAria')}>
            <button
              onClick={() => setActiveTab('general')}
              className="tab-button"
              data-active={activeTab === 'general'}
              role="tab"
              aria-selected={activeTab === 'general'}
            >
              {t('settings.tab.general')}
            </button>
            <button
              onClick={() => setActiveTab('virtual-params')}
              className="tab-button"
              data-active={activeTab === 'virtual-params'}
              role="tab"
              aria-selected={activeTab === 'virtual-params'}
            >
              {t('settings.tab.virtualParams')}
            </button>
            <button
              onClick={() => setActiveTab('customer-portal')}
              className="tab-button"
              data-active={activeTab === 'customer-portal'}
              role="tab"
              aria-selected={activeTab === 'customer-portal'}
            >
              {t('settings.tab.customerPortal')}
            </button>
            <button
              onClick={() => setActiveTab('sgp')}
              className="tab-button"
              data-active={activeTab === 'sgp'}
              role="tab"
              aria-selected={activeTab === 'sgp'}
            >
              {t('settings.tab.sgp')}
            </button>
            <button
              onClick={() => setActiveTab('provisioning')}
              className="tab-button"
              data-active={activeTab === 'provisioning'}
              role="tab"
              aria-selected={activeTab === 'provisioning'}
            >
              {t('settings.tab.provisioning')}
            </button>
            <button
              onClick={() => setActiveTab('security')}
              className="tab-button"
              data-active={activeTab === 'security'}
              role="tab"
              aria-selected={activeTab === 'security'}
            >
              {t('settings.tab.security')}
            </button>
            <button
              onClick={() => setActiveTab('vendors')}
              className="tab-button"
              data-active={activeTab === 'vendors'}
              role="tab"
              aria-selected={activeTab === 'vendors'}
            >
              {t('settings.tab.vendors')}
            </button>
            <button
              onClick={() => setActiveTab('wifi-security')}
              className="tab-button"
              data-active={activeTab === 'wifi-security'}
              role="tab"
              aria-selected={activeTab === 'wifi-security'}
            >
              {t('settings.tab.wifiSecurity')}
            </button>
            <button
              onClick={() => setActiveTab('database')}
              className="tab-button"
              data-active={activeTab === 'database'}
              role="tab"
              aria-selected={activeTab === 'database'}
            >
              {t('settings.tab.database')}
            </button>
          </div>
        </div>

        {/* Content */}
        {activeTab === 'general' && (
          <div className="space-y-6">
            {/* App Settings */}
            <div className="modern-card max-w-3xl p-5 sm:p-6">
              <h2 className="section-heading">{t('settings.general.title')}</h2>
              <p className="section-description mb-6">{t('settings.general.description')}</p>
              <div className="space-y-4">
                <div>
                  <label htmlFor="application-name" className="field-label">{t('settings.general.appName')}</label>
                  <input
                    id="application-name"
                    type="text"
                    value={settings.appName}
                    onChange={(e) => setSettings({...settings, appName: e.target.value})}
                    className="modern-input w-full"
                  />
                </div>
                <div>
                  <p className="field-label">{t('settings.general.language')}</p>
                  <LanguageSwitcher className="w-full sm:w-72" />
                  <p className="field-hint">{t('settings.general.languageHint')}</p>
                </div>
                <div>
                  <label htmlFor="genieacs-url" className="field-label">{t('settings.general.genieAcsUrl')}</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="genieacs-url"
                    type="url"
                    placeholder="http://127.0.0.1:7557"
                    value={settings.genieAcsUrl}
                    onChange={(e) => setSettings({...settings, genieAcsUrl: e.target.value})}
                    className="modern-input flex-1"
                    />
                    <button
                      onClick={handleTestConnection}
                      disabled={loading}
                      className="modern-button"
                    >
                      {loading ? t('settings.general.testing') : t('settings.general.testConnection')}
                    </button>
                  </div>
                  <p className="field-hint">{t('settings.general.urlHint', { path: '/devices' })}</p>
                </div>
              </div>

              {testResult && (
                <div className={`mt-4 p-4 rounded-md ${
                  testResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'
                }`}>
                  <div className="flex items-center">
                    <Icon name={testResult.success ? 'check' : 'x'} size={18} className="mr-2" />
                    <span className="font-medium">{testResult.message}</span>
                    {testResult.deviceCount && (
                      <span className="ml-2 text-sm">
                        {t('settings.general.devicesFound', { count: testResult.deviceCount })}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'virtual-params' && (
          <div className="modern-card p-5 sm:p-6">
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="section-heading">{t('settings.vp.title')}</h2>
                <p className="section-description mt-1">
                  {t('settings.vp.description', { repo: 'skydashnet/genieacs-installer' })}
                </p>
              </div>
              <button
                type="button"
                className="modern-button-secondary shrink-0"
                onClick={() => setSettings((current) => ({ ...current, ...INSTALLER_VIRTUAL_PARAMETERS }))}
              >
                <Icon name="refresh" size={17} />
                {t('settings.vp.usePreset')}
              </button>
            </div>
            <div className="mb-6 rounded-md border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] p-4 text-sm text-foreground">
              {t('settings.vp.readOnlyNotice')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {VIRTUAL_PARAMETER_FIELDS.map((field) => (
                <div key={field.key}>
                  <label htmlFor={field.key} className="field-label">
                    {t(field.labelKey)}
                  </label>
                  <input
                    id={field.key}
                    type="text"
                    value={settings[field.key]}
                    placeholder={field.hintKey ? t('settings.vp.optionalPlaceholder') : undefined}
                    onChange={(e) => setSettings({...settings, [field.key]: e.target.value})}
                    className="modern-input w-full font-mono text-sm"
                  />
                  <p className="field-hint">{field.hintKey ? t(field.hintKey) : field.parameterName}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'customer-portal' && (
          <div className="modern-card max-w-3xl p-5 sm:p-6">
            <p className="page-kicker">{t('settings.portal.kicker')}</p>
            <h2 className="section-heading">{t('settings.portal.title')}</h2>
            <p className="section-description mb-6">
              {t('settings.portal.description', { port: '5891' })}
            </p>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                checked={settings.autoGenerateCustomerId === 'true'}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  autoGenerateCustomerId: event.target.checked ? 'true' : 'false'
                }))}
              />
              <span>
                <span className="block font-semibold">{t('settings.portal.autoGenerate')}</span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                  {t('settings.portal.autoGenerateHint', { format: 'CSG-XXXXXXX-XXXXXX' })}
                </span>
              </span>
            </label>

            <div className="mt-5 grid gap-5 rounded-md border border-border p-4 sm:grid-cols-2">
              <fieldset>
                <legend className="field-label">{t('settings.portal.prefixLegend')}</legend>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="customer-prefix" value="default"
                      checked={settings.customerIdPrefixMode === 'default'}
                      onChange={() => setSettings((current) => ({ ...current, customerIdPrefixMode: 'default' }))} />
                    {t('settings.portal.prefixDefault')} <span className="font-mono font-semibold">CSG</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="customer-prefix" value="company"
                      checked={settings.customerIdPrefixMode === 'company'}
                      onChange={() => setSettings((current) => ({ ...current, customerIdPrefixMode: 'company' }))} />
                    {t('settings.portal.prefixCompany')}
                  </label>
                  {settings.customerIdPrefixMode === 'company' && (
                    <input
                      aria-label={t('settings.portal.companyIdAria')}
                      className="modern-input mt-2 font-mono uppercase"
                      minLength={2}
                      maxLength={4}
                      pattern="[A-Za-z]{2,4}"
                      value={settings.customerIdCompanyPrefix}
                      onChange={(event) => setSettings((current) => ({
                        ...current,
                        customerIdCompanyPrefix: event.target.value.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 4)
                      }))}
                      placeholder="ISP"
                    />
                  )}
                </div>
                <p className="field-hint">{t('settings.portal.prefixHint')}</p>
              </fieldset>

              <fieldset>
                <legend className="field-label">{t('settings.portal.suffixLegend')}</legend>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="customer-suffix" value="random"
                      checked={settings.customerIdSuffixMode === 'random'}
                      onChange={() => setSettings((current) => ({ ...current, customerIdSuffixMode: 'random' }))} />
                    {t('settings.portal.suffixRandom')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="customer-suffix" value="installation_date"
                      checked={settings.customerIdSuffixMode === 'installation_date'}
                      onChange={() => setSettings((current) => ({ ...current, customerIdSuffixMode: 'installation_date' }))} />
                    {t('settings.portal.suffixDate')} <span className="font-mono text-xs text-muted-foreground">YYMMDD</span>
                  </label>
                </div>
                <p className="field-hint">{t('settings.portal.suffixHint')}</p>
              </fieldset>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border p-4">
                <p className="metric-label">{t('settings.portal.loginTitle')}</p>
                <p className="mt-2 text-sm font-semibold">{t('settings.portal.loginValue')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('settings.portal.loginHint')}</p>
              </div>
              <div className="rounded-md border border-border p-4">
                <p className="metric-label">{t('settings.portal.identityTitle')}</p>
                <p className="mt-2 text-sm font-semibold">{t('settings.portal.identityValue')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('settings.portal.identityHint')}</p>
              </div>
            </div>

            <div className="mt-5 rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 p-4 text-sm leading-6">
              {t('settings.portal.disabledNotice')}
            </div>
          </div>
        )}

        {activeTab === 'sgp' && (
          <div className="modern-card max-w-3xl p-5 sm:p-6">
            <p className="page-kicker">{t('settings.sgp.kicker')}</p>
            <h2 className="section-heading">{t('settings.sgp.title')}</h2>
            <p className="section-description mb-6">
              {t('settings.sgp.description', { path: '/api/ura/' })}
            </p>

            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className={sgpConfig?.ready ? 'modern-badge-success' : 'modern-badge'}>
                {t(sgpConfig?.ready ? 'settings.sgp.statusActive' : 'settings.sgp.statusInactive')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(sgpConfig?.tokenConfigured ? 'settings.sgp.tokenStored' : 'settings.sgp.tokenMissing')}
                {sgpConfig?.updatedAt
                  ? ` · ${t('settings.sgp.updatedAt', { time: formatDateTime(sgpConfig.updatedAt) })}`
                  : ''}
              </span>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="sgp-base-url" className="field-label">{t('settings.sgp.baseUrl')}</label>
                <input
                  id="sgp-base-url"
                  type="url"
                  className="modern-input w-full"
                  placeholder="https://provedor.sgp.net.br"
                  value={sgpForm.baseUrl}
                  onChange={(event) => setSgpForm((current) => ({ ...current, baseUrl: event.target.value }))}
                />
                <p className="field-hint">{t('settings.sgp.baseUrlHint')}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="sgp-app" className="field-label">{t('settings.sgp.app')}</label>
                  <input
                    id="sgp-app"
                    type="text"
                    className="modern-input w-full"
                    placeholder="nome-do-app"
                    value={sgpForm.app}
                    onChange={(event) => setSgpForm((current) => ({ ...current, app: event.target.value }))}
                  />
                  <p className="field-hint">{t('settings.sgp.appHint')}</p>
                </div>
                <div>
                  <label htmlFor="sgp-token" className="field-label">{t('settings.sgp.token')}</label>
                  <input
                    id="sgp-token"
                    type="password"
                    autoComplete="new-password"
                    className="modern-input w-full"
                    placeholder={t(sgpConfig?.tokenConfigured ? 'settings.sgp.tokenPlaceholderStored' : 'settings.sgp.tokenPlaceholderEmpty')}
                    value={sgpForm.token}
                    onChange={(event) => setSgpForm((current) => ({ ...current, token: event.target.value }))}
                  />
                  <p className="field-hint">{t('settings.sgp.tokenHint')}</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="sgp-link-mode" className="field-label">{t('settings.sgp.linkMode')}</label>
                  <select
                    id="sgp-link-mode"
                    className="modern-input w-full"
                    value={sgpForm.linkMode}
                    onChange={(event) => setSgpForm((current) => ({
                      ...current,
                      linkMode: event.target.value as SgpConfig['linkMode']
                    }))}
                  >
                    <option value="pppoe">{t('settings.sgp.linkModePppoe')}</option>
                    <option value="customer_id">{t('settings.sgp.linkModeCustomerId')}</option>
                    <option value="manual">{t('settings.sgp.linkModeManual')}</option>
                  </select>
                  <p className="field-hint">{t('settings.sgp.linkModeHint')}</p>
                </div>
                <div>
                  <label htmlFor="sgp-invoice-limit" className="field-label">{t('settings.sgp.invoiceLimit')}</label>
                  <input
                    id="sgp-invoice-limit"
                    type="number"
                    min={1}
                    max={24}
                    className="modern-input w-full"
                    value={sgpForm.invoiceLimit}
                    onChange={(event) => setSgpForm((current) => ({
                      ...current,
                      invoiceLimit: Number(event.target.value) || 1
                    }))}
                  />
                  <p className="field-hint">{t('settings.sgp.invoiceLimitHint')}</p>
                </div>
              </div>

              <div className="space-y-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                    checked={sgpForm.enabled}
                    onChange={(event) => setSgpForm((current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  <span>
                    <span className="block font-semibold">{t('settings.sgp.enable')}</span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                      {t('settings.sgp.enableHint')}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                    checked={sgpForm.portalBilling}
                    onChange={(event) => setSgpForm((current) => ({ ...current, portalBilling: event.target.checked }))}
                  />
                  <span>
                    <span className="block font-semibold">{t('settings.sgp.portalBilling')}</span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                      {t('settings.sgp.portalBillingHint')}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                    checked={sgpForm.portalUnlock}
                    onChange={(event) => setSgpForm((current) => ({ ...current, portalUnlock: event.target.checked }))}
                  />
                  <span>
                    <span className="block font-semibold">{t('settings.sgp.portalUnlock')}</span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                      {t('settings.sgp.portalUnlockHint')}
                    </span>
                  </span>
                </label>
              </div>

              <div>
                <label htmlFor="sgp-sample" className="field-label">{t('settings.sgp.sample')}</label>
                <input
                  id="sgp-sample"
                  type="text"
                  className="modern-input w-full"
                  placeholder={t('settings.sgp.samplePlaceholder')}
                  value={sgpForm.sample}
                  onChange={(event) => setSgpForm((current) => ({ ...current, sample: event.target.value }))}
                />
                <p className="field-hint">{t('settings.sgp.sampleHint')}</p>
              </div>
            </div>

            {sgpTestResult && (
              <div className={`mt-4 rounded-md p-4 ${
                sgpTestResult.success
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'
              }`}>
                <div className="flex items-center">
                  <Icon name={sgpTestResult.success ? 'check' : 'x'} size={18} className="mr-2" />
                  <span className="font-medium">{sgpTestResult.message}</span>
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void handleSgpTest()}
                disabled={sgpTesting}
                className="modern-button-secondary"
              >
                {sgpTesting ? t('settings.sgp.testing') : t('settings.sgp.test')}
              </button>
              <button
                type="button"
                onClick={() => void handleSgpSave()}
                disabled={sgpSaving}
                className="modern-button"
              >
                {sgpSaving ? t('common.saving') : t('settings.sgp.save')}
              </button>
              {sgpConfig?.tokenConfigured && (
                <button
                  type="button"
                  onClick={() => void handleSgpClearToken()}
                  disabled={sgpSaving}
                  className="modern-button-secondary"
                >
                  {t('settings.sgp.clearToken')}
                </button>
              )}
            </div>

            <SgpEventsPanel config={sgpConfig} onConfigChange={setSgpConfig} />
          </div>
        )}

        {activeTab === 'provisioning' && <ProvisioningTab />}

        {activeTab === 'security' && (
          <div className="modern-card max-w-5xl p-5 sm:p-6">
            <h2 className="section-heading">{t('settings.security.title')}</h2>
            <p className="section-description mb-6">{t('settings.security.description')}</p>
            <div className="space-y-6">
              <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <h3 className="font-semibold text-foreground">{t('settings.security.changeUsername')}</h3>
                <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('settings.security.changeUsernameHint')}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.currentUsername')}</label>
                    <input
                      value={usernameForm.currentUsername}
                      onChange={(e) => setUsernameForm(f => ({ ...f, currentUsername: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.currentUsername').toLowerCase()}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.newUsername')}</label>
                    <input
                      value={usernameForm.newUsername}
                      onChange={(e) => setUsernameForm(f => ({ ...f, newUsername: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.newUsername').toLowerCase()}
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <button onClick={submitChangeUsername} className="modern-button">{t('settings.security.updateUsername')}</button>
                </div>
              </section>

              <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <h3 className="font-semibold text-foreground">{t('settings.security.changePassword')}</h3>
                <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('settings.security.changePasswordHint')}</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.currentPassword')}</label>
                    <input
                      type="password"
                      value={passwordForm.currentPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, currentPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.currentPassword').toLowerCase()}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.newPassword')}</label>
                    <input
                      type="password"
                      value={passwordForm.newPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.newPassword').toLowerCase()}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.confirmPassword')}</label>
                    <input
                      type="password"
                      value={passwordForm.confirmNewPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, confirmNewPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.confirmPassword').toLowerCase()}
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <button onClick={submitChangePassword} className="modern-button">{t('settings.security.updatePassword')}</button>
                </div>
              </section>
            </div>
          </div>
        )}

        {/* Vendors Tab */}
        {activeTab === 'vendors' && (
          <div className="space-y-6">
            {/* Vendor List */}
            <div className="modern-card p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('settings.vendors.title')}</h2>
                <button
                  onClick={() => { resetVendorForm(); setCreatingVendor(true) }}
                  className="modern-button"
                >
                  {t('settings.vendors.add')}
                </button>
              </div>

              {(creatingVendor || editingVendor) && (
                <div className="mb-6 p-4 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                    {/* General Info */}
                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.name')} *</label>
                      <input
                        value={vendorForm.name}
                        onChange={(e) => setVendorForm(v => ({ ...v, name: e.target.value }))}
                        className="modern-input w-full"
                        placeholder={t('settings.vendors.namePlaceholder')}
                      />
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.manufacturerPatterns')} *</label>
                      <input
                        value={vendorForm.manufacturer_patterns}
                        onChange={(e) => setVendorForm(v => ({ ...v, manufacturer_patterns: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="huawei, hw"
                      />
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.productPatterns')} *</label>
                      <input
                        value={vendorForm.product_patterns}
                        onChange={(e) => setVendorForm(v => ({ ...v, product_patterns: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="hg8, eg8, f660"
                      />
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.parameterPrefix')}</label>
                      <input
                        value={vendorForm.parameter_prefix}
                        onChange={(e) => setVendorForm(v => ({ ...v, parameter_prefix: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW"
                      />
                    </div>

                    {/* WAN Connection Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">{t('settings.vendors.wanSection')}</h3>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.serviceListPath')}</label>
                      <input
                        value={vendorForm.service_list_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, service_list_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_SERVICELIST"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.lanBindingPath')}</label>
                      <input
                        value={vendorForm.lan_binding_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, lan_binding_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_LANBIND"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.vlanIdPath')}</label>
                      <input
                        value={vendorForm.vlan_id_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, vlan_id_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_VLAN"
                      />
                    </div>

                    {/* WiFi & Security Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">{t('settings.vendors.wifiSection')}</h3>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.wifiPasswordPath')}</label>
                      <input
                        value={vendorForm.wifi_password_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, wifi_password_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. PreSharedKey.1.KeyPassphrase"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.httpWanEnablePath')}</label>
                      <input
                        value={vendorForm.http_wan_enable_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, http_wan_enable_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. ...AclServices.HTTPWanEnable"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.firewallLevelPath')}</label>
                      <input
                        value={vendorForm.firewall_level_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, firewall_level_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. ...X_HW_FirewallLevel"
                      />
                    </div>

                    {/* Other Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">{t('settings.vendors.otherSection')}</h3>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.priority')}</label>
                      <input
                        type="number"
                        value={vendorForm.priority}
                        onChange={(e) => setVendorForm(v => ({ ...v, priority: Number(e.target.value) }))}
                        className="modern-input w-full"
                        placeholder="10"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.status')}</label>
                      <select
                        value={vendorForm.enabled}
                        onChange={(e) => setVendorForm(v => ({ ...v, enabled: Number(e.target.value) }))}
                        className="modern-input w-full"
                      >
                        <option value={1}>{t('common.enabled')}</option>
                        <option value={0}>{t('common.disabled')}</option>
                      </select>
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.descriptionLabel')}</label>
                      <textarea
                        value={vendorForm.description}
                        onChange={(e) => setVendorForm(v => ({ ...v, description: e.target.value }))}
                        className="modern-input w-full"
                        rows={2}
                        placeholder={t('settings.vendors.descriptionPlaceholder')}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-4">
                    <button onClick={submitVendor} className="modern-button">
                      {editingVendor ? t('settings.vendors.update') : t('settings.vendors.create')}
                    </button>
                    <button
                      onClick={resetVendorForm}
                      className="modern-button-secondary"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="modern-table">
                  <thead>
                    <tr>
                      <th>{t('settings.vendors.name')}</th>
                      <th>{t('settings.vendors.parameterPrefix')}</th>
                      <th>{t('settings.vendors.patterns')}</th>
                      <th>{t('settings.vendors.priority')}</th>
                      <th>{t('settings.vendors.status')}</th>
                      <th>{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorsLoading ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8">
                          <div className="w-8 h-8 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin mx-auto"></div>
                          <p className="mt-2 text-gray-500 dark:text-gray-400">{t('settings.vendors.loading')}</p>
                        </td>
                      </tr>
                    ) : vendorList.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8 text-gray-500 dark:text-gray-400">
                          {t('settings.vendors.empty')}
                        </td>
                      </tr>
                    ) : (
                      vendorList.map((v) => (
                        <tr key={v.id}>
                          <td className="font-medium">{v.name}</td>
                          <td className="font-mono text-xs">{v.parameter_prefix || '-'}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {(v.manufacturer_patterns || []).concat(v.product_patterns || []).map((p, idx) => (
                                <span key={idx} className="modern-badge">{p}</span>
                              ))}
                            </div>
                          </td>
                          <td>{v.priority}</td>
                          <td>
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${v.enabled ? 'modern-badge-success' : 'modern-badge-error'}`}>
                              {v.enabled ? t('common.enabled') : t('common.disabled')}
                            </span>
                          </td>
                          <td>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => {
                                  setEditingVendor(v)
                                  setCreatingVendor(true)
                                  setVendorForm({
                                    name: v.name,
                                    parameter_prefix: v.parameter_prefix || '',
                                    manufacturer_patterns: (v.manufacturer_patterns || []).join(','),
                                    product_patterns: (v.product_patterns || []).join(','),
                                    service_list_path: v.service_list_path || '',
                                    lan_binding_path: v.lan_binding_path || '',
                                    vlan_id_path: v.vlan_id_path || '',
                                    wifi_password_path: v.wifi_password_path || '',
                                    http_wan_enable_path: v.http_wan_enable_path || '',
                                    firewall_level_path: v.firewall_level_path || '',
                                    priority: v.priority,
                                    enabled: v.enabled,
                                    description: v.description || ''
                                  })
                                }}
                                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                                title={t('common.edit')}
                                aria-label={t('common.edit')}
                              >
                                <Icon name="edit" size={18} />
                              </button>
                              <button
                                onClick={() => deleteVendor(v.id)}
                                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                                title={t('common.delete')}
                                aria-label={t('common.delete')}
                              >
                                <Icon name="trash" size={18} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* WiFi Security Tab */}
        {activeTab === 'wifi-security' && (
          <div className="space-y-6">
            {/* WiFi Security Configs */}
            <div className="modern-card p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('settings.wifi.title')}</h2>
                <button
                  onClick={() => {
                    resetConfigForm();
                    setCreatingConfig(true);
                  }}
                  className="modern-button"
                >
                  {t('settings.wifi.add')}
                </button>
              </div>
              {(creatingConfig || editingConfig) && (
                <div className="mb-6 p-4 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.wifi.productClass')}</label>
                      <input
                        value={configForm.product_class}
                        onChange={(e) => setConfigForm(c => ({ ...c, product_class: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="e.g. HG8245H"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.wifi.securityTypes')}</label>
                      <input
                        value={configForm.security_types}
                        onChange={(e) => setConfigForm(c => ({ ...c, security_types: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="WPA2-PSK,WPA3-PSK"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.wifi.passwordPath')}</label>
                      <input
                        value={configForm.password_param_path}
                        onChange={(e) => setConfigForm(c => ({ ...c, password_param_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="...KeyPassphrase"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-4">
                    <button onClick={submitWifiConfig} className="modern-button">
                      {editingConfig ? t('settings.wifi.update') : t('settings.wifi.create')}
                    </button>
                    <button onClick={resetConfigForm} className="modern-button-secondary">{t('common.cancel')}</button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="modern-table">
                  {/* Style Header Tabel Sesuai SS */}
                  <thead>
                    <tr>
                      <th className="uppercase">{t('settings.wifi.productClass')}</th>
                      <th className="uppercase">{t('settings.wifi.passwordPath')}</th>
                      <th className="uppercase">{t('settings.wifi.securityTypes')}</th>
                      <th className="uppercase">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wifiConfigLoading ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-gray-500 dark:text-gray-400">{t('settings.wifi.loading')}</td>
                      </tr>
                    ) : wifiConfigs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-gray-500 dark:text-gray-400">{t('settings.wifi.empty')}</td>
                      </tr>
                    ) : (
                      wifiConfigs.map(cfg => (
                        <tr key={cfg.id}>
                          <td className="font-medium">{cfg.product_class}</td>
                          <td className="font-mono text-xs">{cfg.password_param_path}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {(cfg.security_types_array || []).map((s, idx) => (
                                <span key={idx} className="modern-badge">{s}</span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => {
                                  setEditingConfig(cfg);
                                  setCreatingConfig(false);
                                  setConfigForm({
                                    product_class: cfg.product_class,
                                    security_types: cfg.security_types,
                                    password_param_path: cfg.password_param_path
                                  })
                                }}
                                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-medium text-sm"
                              >
                                {t('common.edit')}
                              </button>
                              <button
                                onClick={() => deleteWifiConfig(cfg.id)}
                                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 font-medium text-sm"
                              >
                                {t('common.delete')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'database' && (
          <div className="modern-card p-6 max-w-2xl">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">{t('settings.db.title')}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t('settings.db.active', {
                database: activeDb
                  ? (activeDb.client === 'mysql2'
                      ? t('settings.db.mysql', { database: String(activeDb.database), host: String(activeDb.host) })
                      : t('settings.db.sqlite'))
                  : '…',
              })}
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.type')}</label>
              <select
                value={dbForm.client}
                onChange={(e) => setDbForm({ ...dbForm, client: e.target.value as DbConfigPayload['client'] })}
                className="modern-input w-full"
              >
                <option value="mysql2">MySQL / MariaDB</option>
                <option value="sqlite3">{t('settings.db.sqlite')}</option>
              </select>
            </div>

            {dbForm.client === 'mysql2' && (
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.host')}</label>
                  <input className="modern-input w-full" value={dbForm.host || ''}
                    onChange={(e) => setDbForm({ ...dbForm, host: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.port')}</label>
                  <input type="number" className="modern-input w-full" value={dbForm.port || 3306}
                    onChange={(e) => setDbForm({ ...dbForm, port: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.user')}</label>
                  <input className="modern-input w-full" value={dbForm.user || ''}
                    onChange={(e) => setDbForm({ ...dbForm, user: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.password')}</label>
                  <input type="password" className="modern-input w-full" value={dbForm.password || ''}
                    onChange={(e) => setDbForm({ ...dbForm, password: e.target.value })} />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.database')}</label>
                  <input className="modern-input w-full" value={dbForm.database || ''}
                    onChange={(e) => setDbForm({ ...dbForm, database: e.target.value })} />
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 mb-6 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={Boolean(dbForm.migrateData)}
                onChange={(e) => setDbForm({ ...dbForm, migrateData: e.target.checked })} />
              {t('settings.db.copyData')}
            </label>

            <div className="flex gap-3">
              <button onClick={handleDbTest} disabled={dbTesting} className="modern-button-secondary">
                {dbTesting ? t('settings.db.testing') : t('settings.db.test')}
              </button>
              <button onClick={handleDbSwitch} disabled={dbSwitching} className="modern-button">
                {dbSwitching ? t('settings.db.switching') : t('settings.db.switch')}
              </button>
            </div>

            <p className="text-xs text-gray-400 mt-4">
              {t('settings.db.restartHint')}
            </p>
          </div>
        )}

        {/* Save Button */}
        {(activeTab === 'general' || activeTab === 'virtual-params' || activeTab === 'customer-portal') && (
          <div className="flex justify-end mt-8">
            <button
              onClick={handleSaveSettings}
              disabled={loading}
              className="modern-button"
            >
              {loading ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
