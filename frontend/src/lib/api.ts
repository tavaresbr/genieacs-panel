import { getActiveLocale, translate } from '@/lib/i18n'
import type { OperatorRole, User } from '@/types'

const API_BASE_URL = import.meta.env.VITE_API_URL || ''

export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  message?: string
  error?: string
  code?: string
  /**
   * Only on a refusal, and only where the route has a breakdown to offer: the
   * billing build attaches it to its 409 so "every one of them is on the
   * do-not-disturb list" survives the failure. A refusal has no `data`, so
   * without this the reason is lost inside a bare status code.
   */
  skipped?: Record<string, number>
}

class ApiClient {
  private baseURL: string
  private token: string | null = null
  private refreshToken: string | null = null
  private refreshPromise: Promise<boolean> | null = null

  constructor(baseURL: string) {
    this.baseURL = baseURL
    this.token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
    this.refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryAfterRefresh = true
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseURL}/api${endpoint}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // The panel answers in the operator's chosen language, which is not
      // necessarily the browser's, so the backend is told explicitly.
      'Accept-Language': getActiveLocale(),
      ...options.headers as Record<string, string>,
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      })

      const contentType = response.headers.get('content-type') || ''
      const data = contentType.includes('application/json')
        ? await response.json()
        : { message: await response.text() }

      if (
        response.status === 403 &&
        data.code === 'invalid_token' &&
        retryAfterRefresh &&
        !['/auth/refresh', '/auth/login', '/auth/setup'].includes(endpoint)
      ) {
        const refreshed = await this.refreshAccessToken()
        if (refreshed) {
          return this.request<T>(endpoint, options, false)
        }
      }

      if (!response.ok) {
        return {
          success: false,
          // `missing_permission` é o 403 de quem tem sessão boa e papel curto.
          // A frase de reserva é a dele e não a genérica: sem isto, uma rota que
          // recusasse sem corpo cairia em "a requisição falhou", que manda a
          // pessoa tentar de novo para sempre falhar igual — e é vizinha do
          // `invalid_token` logo acima, cujo caminho termina em tela de login.
          // Nada aqui derruba a sessão, e é justamente esse o ponto.
          message: data.message || translate(
            getActiveLocale(),
            data.code === 'missing_permission' ? 'api.missingPermission' : 'api.requestFailed'
          ),
          error: data.error || translate(getActiveLocale(), 'api.unknownError'),
          code: data.code,
          // Forwarded, not rebuilt away: see `skipped` above.
          ...(data.skipped ? { skipped: data.skipped } : {}),
        }
      }

      return data
    } catch (error) {
      return {
        success: false,
        message: translate(getActiveLocale(), 'api.networkError'),
        error: error instanceof Error ? error.message : translate(getActiveLocale(), 'api.unknownError'),
      }
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false
    if (this.refreshPromise) return this.refreshPromise

    this.refreshPromise = (async () => {
      try {
        const response = await fetch(`${this.baseURL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        })
        const data = await response.json()
        if (!response.ok || !data.success || !data.data?.token || !data.data?.refreshToken) {
          this.clearTokens()
          return false
        }
        this.setTokens(data.data.token, data.data.refreshToken)
        return true
      } catch {
        this.clearTokens()
        return false
      } finally {
        this.refreshPromise = null
      }
    })()

    return this.refreshPromise
  }

  async get<T>(endpoint: string): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data?: any): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data?: any): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'DELETE' })
  }

  /**
   * A raw body, not JSON. `request` sets `Content-Type: application/json` and
   * stringifies, which would corrupt a file; this is the one call that needs
   * the bytes to arrive as they are.
   */
  async sendBlob<T>(
    endpoint: string,
    body: Blob,
    headers: Record<string, string>
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'POST', body, headers })
  }

  /**
   * A binary response. `request` reads JSON or text, so a file fetched through
   * it would arrive mangled and silently — hence its own path, with the same
   * Authorization header and the same locale.
   */
  async getBlob(endpoint: string): Promise<{ success: boolean; blob?: Blob; code?: string }> {
    const headers: Record<string, string> = { 'Accept-Language': getActiveLocale() }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    try {
      const response = await fetch(`${this.baseURL}/api${endpoint}`, { headers })
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        const data = contentType.includes('application/json') ? await response.json() : {}
        return { success: false, code: data.code }
      }
      return { success: true, blob: await response.blob() }
    } catch {
      return { success: false }
    }
  }

  async requestWithBody<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    data?: unknown
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method,
      body: data === undefined ? undefined : JSON.stringify(data),
    })
  }

  setTokens(token: string, refreshToken?: string) {
    this.token = token
    if (refreshToken !== undefined) {
      this.refreshToken = refreshToken
    }
    if (typeof window !== 'undefined') {
      localStorage.setItem('token', token)
      if (refreshToken !== undefined) {
        localStorage.setItem('refreshToken', refreshToken)
      }
    }
  }

  clearTokens() {
    this.token = null
    this.refreshToken = null
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token')
      localStorage.removeItem('refreshToken')
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
  }
}

export const apiClient = new ApiClient(API_BASE_URL)

// Authentication API
export const authAPI = {
  getSetupStatus: () =>
    apiClient.get('/auth/setup-status'),

  setupAdmin: (username: string, password: string) =>
    apiClient.post('/auth/setup', { username, password }),

  login: (username: string, password: string) =>
    apiClient.post('/auth/login', { username, password }),

  getCurrentUser: () =>
    apiClient.get('/auth/user'),

  logout: () =>
    apiClient.post('/auth/logout'),

  refreshToken: (refreshToken: string) =>
    apiClient.post('/auth/refresh', { refreshToken }),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiClient.post('/auth/change-password', { currentPassword, newPassword }),

  changeUsername: (currentUsername: string, newUsername: string) =>
    apiClient.post('/auth/change-username', { currentUsername, newUsername }),
}

// Operator accounts. Every route below is admin-only on the backend.
// An operator and the signed-in user are the same record, so they share a type.
export type Operator = User
export type { OperatorRole }

/**
 * What the login screen may know before anybody has signed in.
 *
 * Deliberately two fields. This route is public by necessity — it exists to be
 * read before there is a session — so it carries the provider's name and
 * nothing that would help enumerate: a host that names no provider answers the
 * same 404 as any other unresolvable one, and a suspended provider answers it
 * too, because telling "suspended" from "never existed" tells a prober which
 * slugs are real, and a slug is an ISP's name.
 */
export interface PublicTenant {
  slug: string
  name: string
}

/**
 * The provider the browser's own address resolves to.
 *
 * No parameter: the answer comes from the `Host` the request already carries,
 * which is the whole point — the address names the provider, so a caller
 * cannot ask about one they did not arrive at.
 *
 * Answers 404 where the deployment has no base domain configured, which is
 * every self-hosted install: the login screen then shows the panel's own name,
 * exactly as it does today.
 */
export const publicTenantAPI = {
  current: () => apiClient.get<PublicTenant>('/tenant/public')
}

/** One provider on the deployment, as the control plane sees it. */
export interface Tenant {
  id: number
  slug: string
  name: string
  status: 'active' | 'suspended'
  /** How many people hold a membership here. */
  operators: number
  createdAt: string | null
}

/** A person's membership at one provider, listed from the control plane. */
export interface TenantMembership {
  userId: number
  username: string
  role: OperatorRole
}

/**
 * The SaaS control plane.
 *
 * These routes exist only where `EDITION=saas`; on a self-hosted install they
 * are not mounted at all, so a call answers 404. That is deliberate — a 403
 * would tell whoever asked that a control plane is there.
 *
 * Every one of them requires a platform administrator, which is a plane ABOVE a
 * provider's own administrator: minting providers and reaching between them is
 * exactly what a provider's admin must not be able to do.
 */
export const platformAPI = {
  listTenants: () =>
    apiClient.get<{ tenants: Tenant[] }>('/platform/tenants'),

  createTenant: (payload: { slug: string; name: string }) =>
    apiClient.post<{ tenant: Tenant }>('/platform/tenants', payload),

  /**
   * Suspends or reactivates. There is no delete: the scoped tables point at
   * `tenants` without a cascade, so removing a provider that holds data would
   * fail on a foreign key — and succeeding would be worse.
   */
  setTenantStatus: (id: number, status: 'active' | 'suspended') =>
    apiClient.requestWithBody<{ tenant: Tenant }>('PATCH', `/platform/tenants/${id}`, { status }),

  listMemberships: (tenantId: number) =>
    apiClient.get<{ memberships: TenantMembership[] }>(`/platform/tenants/${tenantId}/members`),

  /**
   * Attaches a person who already exists to a provider. NEVER touches their
   * password: wave 12 refused this to a provider's own administrator precisely
   * because doing it with a password would reset a stranger's login.
   */
  addMembership: (tenantId: number, payload: { username: string; role: OperatorRole }) =>
    apiClient.post<{ membership: TenantMembership }>(`/platform/tenants/${tenantId}/members`, payload),

  removeMembership: (tenantId: number, userId: number) =>
    apiClient.delete<{ userId: number }>(`/platform/tenants/${tenantId}/members/${userId}`)
}

export const usersAPI = {
  list: () =>
    apiClient.get<{ users: Operator[] }>('/users'),

  create: (payload: { username: string; password: string; role: OperatorRole }) =>
    apiClient.post<{ user: Operator }>('/users', payload),

  /** Sends only what changes: a role, a new password, or both. */
  update: (id: number, payload: { role?: OperatorRole; password?: string }) =>
    apiClient.requestWithBody<{ user: Operator }>('PATCH', `/users/${id}`, payload),

  remove: (id: number) =>
    apiClient.delete<{ id: number }>(`/users/${id}`),
}

export interface PortalPasswordResponse {
  customerId: string
  password: string
  updatedAt?: string | null
}

// Devices API
export interface DeviceListParams {
  page?: number
  pageSize?: number
  search?: string
  status?: 'all' | 'online' | 'offline'
}

export interface DeviceListResponse<T> {
  devices: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface DeviceHistoryPoint {
  /** Seconds since the epoch. */
  t: number
  rx: number | null
  rxMin?: number | null
  rxMax?: number | null
  tc: number | null
  up: number | null
}

export interface DeviceHistory {
  deviceId: string
  /** Which grain the server chose for the requested window. */
  resolution: 'raw' | 'hourly'
  from: string
  to: string
  points: DeviceHistoryPoint[]
}

export interface DeviceSwap {
  id: number
  customerId: string | null
  pppoeUsername: string | null
  previousDeviceId: string
  deviceId: string
  contract: string | null
  /** Which identity matched: same firmware hashes the same, so most swaps are `identity_hash`. */
  matchedBy: 'identity_hash' | 'pppoe'
  /** What became of the previous ONT's SGP link. `held` means the pair is unstable. */
  linkAction: 'moved' | 'cleared' | 'none' | 'held'
  flapping: boolean
  repeatCount: number
  occurredAt: string | null
  acknowledgedAt: string | null
}

export interface DeviceSwapList {
  swaps: DeviceSwap[]
  open?: number
}

export const devicesAPI = {
  getDevices: (params: DeviceListParams = {}) => {
    const query = new URLSearchParams()
    if (params.page !== undefined) query.set('page', String(params.page))
    if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize))
    if (params.search) query.set('search', params.search)
    if (params.status && params.status !== 'all') query.set('status', params.status)
    const search = query.toString()
    return apiClient.get(`/devices${search ? `?${search}` : ''}`)
  },

  getDashboard: (force = false) =>
    apiClient.get(`/devices/dashboard${force ? '?refresh=1' : ''}`),

  getFaults: (limit = 50) =>
    apiClient.get(`/devices/faults?limit=${encodeURIComponent(limit)}`),

  clearFault: (faultId: string) =>
    apiClient.delete(`/devices/faults/${encodeURIComponent(faultId)}`),

  getDevice: (deviceId: string) =>
    apiClient.get(`/devices/${encodeURIComponent(deviceId)}`),

  getHistory: (deviceId: string, range: { from?: string; to?: string } = {}) => {
    const query = new URLSearchParams()
    if (range.from) query.set('from', range.from)
    if (range.to) query.set('to', range.to)
    const suffix = query.toString()
    return apiClient.get<DeviceHistory>(
      `/devices/${encodeURIComponent(deviceId)}/history${suffix ? `?${suffix}` : ''}`
    )
  },

  getSwaps: () => apiClient.get<DeviceSwapList>('/devices/swaps'),

  getDeviceSwaps: (deviceId: string) =>
    apiClient.get<DeviceSwapList>(`/devices/${encodeURIComponent(deviceId)}/swaps`),

  acknowledgeSwap: (id: number) =>
    apiClient.post<DeviceSwap>(`/devices/swaps/${encodeURIComponent(id)}/acknowledge`),

  deleteDevice: (deviceId: string) =>
    apiClient.delete(`/devices/${encodeURIComponent(deviceId)}`),

  rebootDevice: (deviceId: string) =>
    apiClient.post('/devices/reboot', { deviceId }),

  summonDevice: (deviceId: string, parameters?: string[]) =>
    apiClient.post('/devices/summon', { deviceId, parameters }),

  updateWanConfig: (deviceId: string, wanIndex: string, formData: any) => {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/update-wan`, { wanIndex, formData });
  },

  addWanConnection: (deviceId: string, containerPath: string, type: 'ppp' | 'ip') =>
    apiClient.post(`/devices/${encodeURIComponent(deviceId)}/add-wan`, { containerPath, type }),

  updateInstallationDate: (deviceId: string, installationDate: string) =>
    apiClient.put(`/devices/${encodeURIComponent(deviceId)}/installation-date`, { installationDate }),

  updateWifiConfig: (deviceId: string, index: number, formData: any) => {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/update-wifi`, { index, formData });
  },

  updateCredentials: (deviceId: string, type: 'super' | 'user', password: string) => {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/update-credentials`, { type, password });
  },

  getPortalPassword: (deviceId: string) =>
    apiClient.get<PortalPasswordResponse>(
      `/devices/${encodeURIComponent(deviceId)}/portal-password`
    ),

  resetPortalPassword: (deviceId: string) =>
    apiClient.post<PortalPasswordResponse>(
      `/devices/${encodeURIComponent(deviceId)}/portal-password/reset`
    )
}

// Settings API
export const settingsAPI = {
  getAll: () =>
    apiClient.get('/settings'),

  get: (key: string) =>
    apiClient.get(`/settings/${key}`),

  create: (key: string, value: string) =>
    apiClient.post('/settings', { key, value }),

  update: (key: string, value: string) =>
    apiClient.put(`/settings/${key}`, { value }),

  syncCustomerIds: () =>
    apiClient.post('/settings/sync-customer-ids'),

  delete: (key: string) =>
    apiClient.delete(`/settings/${key}`),

  testGenieAcs: (url: string) =>
    apiClient.post('/settings/test-genieacs', { url }),
}

export interface SgpConfig {
  enabled: boolean
  baseUrl: string
  app: string
  linkMode: 'pppoe' | 'customer_id' | 'manual'
  portalBilling: boolean
  portalUnlock: boolean
  invoiceLimit: number
  endpoints: { customer: string; invoices: string; unlock: string; ticket: string }
  tokenConfigured: boolean
  ready: boolean
  updatedAt: string | null
  webhookEnabled: boolean
  webhookRequireTimestamp: boolean
  webhookToleranceSeconds: number
  webhookSecretConfigured: boolean
  webhookPath: string
  reconcileEnabled: boolean
  reconcileIntervalMinutes: number
  reconcileBatchSize: number
  eventRetentionDays: number
  eventTypeMap: Record<string, string>
  ticketEnabled: boolean
  /** The install's own Tipo de Ocorrência id; SGP documents 5 as the default. */
  ticketOccurrenceType: number
}

export interface SgpTicket {
  contract: string
  /** Null when the install answers in a shape we do not recognise. */
  ticket: string | null
  message: string | null
}

export interface SgpEvent {
  id: number
  source: 'webhook' | 'reconcile' | 'manual'
  type: string
  rawType: string | null
  contract: string | null
  document: string | null
  login: string | null
  deviceId: string | null
  status: 'pending' | 'processed' | 'ignored' | 'failed'
  attempts: number
  payload: string | null
  error: string | null
  occurredAt: string | null
  receivedAt: string | null
  processedAt: string | null
}

export interface SgpContractLink {
  contract: string
  clientName: string | null
  document: string | null
  plan: string | null
  status: string | null
  statusLabel: string | null
  login: string | null
  blocked: boolean | null
  linkMode: 'auto' | 'manual'
  lastSyncedAt: string | null
}

export type SgpContractState = 'active' | 'blocked' | 'cancelled' | 'unknown'

export interface SgpLinkRow {
  deviceId: string
  contract: string
  clientName: string | null
  plan: string | null
  status: string | null
  statusLabel: string | null
  state: SgpContractState
  linkMode: 'auto' | 'manual'
  lastSyncedAt: string | null
}

export interface SgpDivergenceRow {
  deviceId: string
  contract: string
  clientName: string | null
  statusLabel: string | null
  state: SgpContractState
  lastInform: string | null
}

export interface SgpUnlinkedRow {
  deviceId: string
  customerId: string | null
  pppoe: string | null
}

export interface SgpSyncSummary {
  total: number
  linked: number
  created: number
  updated: number
  failed: number
  skipped: number
  durationMs: number
  startedAt: string | null
  finishedAt: string | null
}

export interface SgpFleetOverview {
  enabled: boolean
  // `totals` carries the full counts; the `divergences` lists are capped samples.
  totals: {
    devices: number
    linked: number
    unlinked: number
    onlineBlocked: number
    offlineActive: number
  }
  byState: Record<SgpContractState, number>
  divergences: {
    onlineBlocked: SgpDivergenceRow[]
    offlineActive: SgpDivergenceRow[]
    unlinked: SgpUnlinkedRow[]
  }
  lastSync: SgpSyncSummary | null
  generatedAt: string
}

export interface SgpInvoice {
  id: string | null
  description: string | null
  amount: number | null
  dueDate: string | null
  paidAt: string | null
  status: string | null
  digitableLine: string | null
  barcode: string | null
  link: string | null
  pix: string | null
  paid: boolean
}

// SGP (Sistema de Gestão de Provedores) integration API
export const sgpAPI = {
  getConfig: () =>
    apiClient.get<SgpConfig>('/sgp/config'),

  updateConfig: (config: Partial<SgpConfig> & { token?: string }) =>
    apiClient.put<SgpConfig>('/sgp/config', config),

  test: (payload: { baseUrl?: string; app?: string; token?: string; document?: string; contract?: string; login?: string }) =>
    apiClient.post<{ contracts: number; probe: string; message: string | null }>('/sgp/test', payload),

  lookup: (filters: { document?: string; contract?: string; login?: string }) => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })
    return apiClient.get<{ contracts: SgpContractLink[] }>(`/sgp/customers?${params.toString()}`)
  },

  getDeviceIntegration: (deviceId: string, options: { refresh?: boolean } = {}) =>
    apiClient.get<{
      link: SgpContractLink
      invoices: SgpInvoice[]
      invoiceError: string | null
      ticketEnabled: boolean
    }>(
      `/sgp/devices/${encodeURIComponent(deviceId)}${options.refresh ? '?refresh=1' : ''}`
    ),

  linkDevice: (deviceId: string, payload: { contract: string; document?: string }) =>
    apiClient.post<{ link: SgpContractLink }>(`/sgp/devices/${encodeURIComponent(deviceId)}/link`, payload),

  unlinkDevice: (deviceId: string) =>
    apiClient.delete(`/sgp/devices/${encodeURIComponent(deviceId)}/link`),

  requestTrustUnlock: (deviceId: string) =>
    apiClient.post<{ contract: string }>(`/sgp/devices/${encodeURIComponent(deviceId)}/unlock`),

  openTicket: (deviceId: string, payload: { content: string; note?: string }) =>
    apiClient.post<SgpTicket>(`/sgp/devices/${encodeURIComponent(deviceId)}/ticket`, payload),

  getLinks: () =>
    apiClient.get<{ links: SgpLinkRow[] }>('/sgp/links'),

  getOverview: () =>
    apiClient.get<SgpFleetOverview>('/sgp/overview'),

  syncAll: () =>
    apiClient.post<SgpSyncSummary>('/sgp/sync'),

  listEvents: (filters: { status?: string; type?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params.set(key, String(value))
    })
    const query = params.toString()
    return apiClient.get<{ events: SgpEvent[] }>(`/sgp/events${query ? `?${query}` : ''}`)
  },

  retryEvent: (id: number) =>
    apiClient.post<{ event: SgpEvent }>(`/sgp/events/${id}/retry`),

  // The secret comes back once and is never readable again.
  rotateWebhookSecret: () =>
    apiClient.post<{ secret: string; path: string }>('/sgp/events/secret/rotate'),

  reconcile: () =>
    apiClient.post<{ checked: number; changed: number; errors: number }>('/sgp/reconcile'),
}

export interface ProvisioningConfig {
  enabled: boolean
  intervalSeconds: number
  batchSize: number
  informWindowHours: number
  markerTag: string
  verifyEnabled: boolean
  verifyDelaySeconds: number
  requirePppoePassword: boolean
  runRetentionDays: number
  updatedAt: string | null
}

export interface ProvisioningProfile {
  id: number
  name: string
  planPatterns: string[]
  isDefault: boolean
  priority: number
  enabled: boolean
  applyWan: boolean
  applyPppoePassword: boolean
  wanName: string | null
  wanVlanId: number | null
  wanServiceList: string | null
  wanConnectionType: string | null
  wanNatEnabled: boolean | null
  applyWifi: boolean
  wifiIndexes: number[]
  wifiSsidTemplate: string | null
  wifiPasswordMode: 'fixed' | 'random' | 'keep'
  applyCredentials: boolean
  credentialTargets: 'super' | 'user' | 'both'
  description: string | null
  wifiPasswordConfigured: boolean
  cpePasswordConfigured: boolean
  updatedAt: string | null
}

export type ProvisioningProfileInput = Partial<Omit<ProvisioningProfile,
  'id' | 'wifiPasswordConfigured' | 'cpePasswordConfigured' | 'updatedAt'>>
  & { wifiPassword?: string; cpePassword?: string }

export interface ProvisioningStep {
  step: string
  target: string | number | null
  status: string
  detail: string | null
  parameters: { path: string; value: unknown }[]
  at?: string
}

export interface ProvisioningRun {
  id: number
  deviceId: string
  contract: string | null
  profileId: number | null
  profileName: string | null
  trigger: 'poller' | 'manual' | 'event' | 'dry_run'
  status: string
  attemptCount: number
  nextAttemptAt: string | null
  steps: ProvisioningStep[]
  /** Translation key the run recorded; `errorMessage` is it rendered. */
  error: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string | null
}

export interface ProvisioningPreview {
  deviceId: string
  login: string | null
  contract: SgpContractLink | null
  profile: { id: number; name: string } | null
  pppoePasswordFound?: boolean
  skip?: string
  steps: ProvisioningStep[]
}

/* Automatic provisioning API */
export const provisioningAPI = {
  getConfig: () =>
    apiClient.get<ProvisioningConfig>('/provisioning/config'),

  updateConfig: (config: Partial<ProvisioningConfig>) =>
    apiClient.put<ProvisioningConfig>('/provisioning/config', config),

  listProfiles: () =>
    apiClient.get<{ profiles: ProvisioningProfile[] }>('/provisioning/profiles'),

  createProfile: (profile: ProvisioningProfileInput) =>
    apiClient.post<{ profile: ProvisioningProfile }>('/provisioning/profiles', profile),

  updateProfile: (id: number, profile: ProvisioningProfileInput) =>
    apiClient.put<{ profile: ProvisioningProfile }>(`/provisioning/profiles/${id}`, profile),

  deleteProfile: (id: number) =>
    apiClient.delete(`/provisioning/profiles/${id}`),

  listRuns: (filters: { deviceId?: string; status?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params.set(key, String(value))
    })
    const query = params.toString()
    return apiClient.get<{ runs: ProvisioningRun[] }>(`/provisioning/runs${query ? `?${query}` : ''}`)
  },

  listDeviceRuns: (deviceId: string) =>
    apiClient.get<{ runs: ProvisioningRun[] }>(
      `/provisioning/devices/${encodeURIComponent(deviceId)}/runs`
    ),

  preview: (deviceId: string) =>
    apiClient.post<ProvisioningPreview>(
      `/provisioning/devices/${encodeURIComponent(deviceId)}/preview`
    ),

  provision: (deviceId: string, payload: { force?: boolean } = {}) =>
    apiClient.post<{ run: ProvisioningRun }>(
      `/provisioning/devices/${encodeURIComponent(deviceId)}/provision`, payload
    ),

  runPass: () =>
    apiClient.post<{ executed: number; verified: number; queued: number }>('/provisioning/run'),
}

/* Vendors API */
export const vendorsAPI = {
  getAll: () =>
    apiClient.get('/vendor-management'),

  get: (id: number) =>
    apiClient.get(`/vendor-management/${id}`),

  create: (vendorData: any) =>
    apiClient.post('/vendor-management', vendorData),

  update: (id: number, vendorData: any) =>
    apiClient.put(`/vendor-management/${id}`, vendorData),

  delete: (id: number) =>
    apiClient.delete(`/vendor-management/${id}`),

  // WiFi security mappings per vendor
  getWifiSecurityMappings: (vendorId: number) =>
    apiClient.get(`/vendor-management/${vendorId}/wifi-security`),

  createWifiSecurityMapping: (vendorId: number, mappingData: any) =>
    apiClient.post(`/vendor-management/${vendorId}/wifi-security`, mappingData),

  updateWifiSecurityMapping: (id: number, mappingData: any) =>
    apiClient.put(`/vendor-management/wifi-security/${id}`, mappingData),

  deleteWifiSecurityMapping: (id: number) =>
    apiClient.delete(`/vendor-management/wifi-security/${id}`),

  // WiFi security configs (by product class)
  getAllWifiSecurityConfigs: () =>
    apiClient.get('/vendor-management/wifi-security-configs'),

  getWifiSecurityConfig: (id: number) =>
    apiClient.get(`/vendor-management/wifi-security-configs/${id}`),

  getWifiSecurityConfigByProductClass: (productClass: string) =>
    apiClient.get(`/vendor-management/wifi-security-configs/by-product-class/${encodeURIComponent(productClass)}`),

  createWifiSecurityConfig: (configData: any) =>
    apiClient.post('/vendor-management/wifi-security-configs', configData),

  updateWifiSecurityConfig: (id: number, configData: any) =>
    apiClient.put(`/vendor-management/wifi-security-configs/${id}`, configData),

  deleteWifiSecurityConfig: (id: number) =>
    apiClient.delete(`/vendor-management/wifi-security-configs/${id}`),
}

// Mapping API
export const mappingAPI = {
  getNodes: () =>
    apiClient.get('/mapping-data/nodes'),

  getNode: (nodeId: string) =>
    apiClient.get(`/mapping-data/nodes/${encodeURIComponent(nodeId)}`),

  createNode: (nodeData: any) =>
    apiClient.post('/mapping-data/nodes', nodeData),

  updateNode: (nodeId: string, nodeData: any) =>
    apiClient.put(`/mapping-data/nodes/${encodeURIComponent(nodeId)}`, nodeData),

  deleteNode: (nodeId: string) =>
    apiClient.delete(`/mapping-data/nodes/${encodeURIComponent(nodeId)}`),

  getEdges: () =>
    apiClient.get('/mapping-data/edges'),

  getEdge: (edgeId: string) =>
    apiClient.get(`/mapping-data/edges/${encodeURIComponent(edgeId)}`),

  createEdge: (edgeData: any) =>
    apiClient.post('/mapping-data/edges', edgeData),

  updateEdge: (edgeId: string, edgeData: any) =>
    apiClient.put(`/mapping-data/edges/${encodeURIComponent(edgeId)}`, edgeData),

  deleteEdge: (edgeId: string) =>
    apiClient.delete(`/mapping-data/edges/${encodeURIComponent(edgeId)}`),

  syncData: (data: { nodes: any[], edges: any[] }) =>
    apiClient.post('/mapping-data/sync', data),

  resetData: (password: string) =>
    apiClient.requestWithBody('DELETE', '/mapping-data/reset', { password }),
}

// Map Settings API
export const mapSettingsAPI = {
  get: () =>
    apiClient.get('/map-settings'),

  update: (settings: any) =>
    apiClient.put('/map-settings', settings),

  reset: () =>
    apiClient.post('/map-settings/reset'),
}

export interface DbConfigPayload {
  client: 'sqlite3' | 'mysql2'
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  migrateData?: boolean
}

export const databaseAPI = {
  getConfig: () =>
    apiClient.get('/database/config'),

  test: (config: DbConfigPayload) =>
    apiClient.post('/database/test', config),

  switch: (config: DbConfigPayload) =>
    apiClient.post('/database/switch', config),
}

// WhatsApp via Evolution API
export interface WhatsAppConfig {
  enabled: boolean
  allowedHosts: string[]
  webhookBaseUrl: string
  rejectCallMessage: string
  // Where the customer portal answers from outside. Its own field, not the
  // panel's address: the portal is a separate app on a separate port.
  portalPublicUrl: string
  /** Days a stored attachment is kept. 0 means forever, and is the default. */
  mediaRetentionDays: number
  /** Days a message row is kept. 0 is forever, and is the default. */
  messageRetentionDays: number
  rateLimitPerMin: number
  managedUrl: string
  managed: boolean
  managedAdminKeyConfigured: boolean
  ready: boolean
  updatedAt: string | null
}

export type WhatsAppPurpose = 'general' | 'billing' | 'support' | 'sales' | 'alerts'
export type WhatsAppStatus = 'pending' | 'connecting' | 'connected' | 'disconnected' | 'expired'

export interface WhatsAppAccount {
  id: number
  name: string
  label: string | null
  purpose: WhatsAppPurpose
  flavor: 'go' | 'v2'
  baseUrl: string
  status: WhatsAppStatus
  /** Data URI, refreshed by the server while pairing. Never a stable value. */
  qrCode: string | null
  qrUpdatedAt: string | null
  phoneE164: string | null
  isDefault: boolean
  lastSeenAt: string | null
  lastError: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** `pending` with a null `qr` is a "not yet", not a failure — the GO client boots slowly. */
export interface WhatsAppQrResult {
  account: WhatsAppAccount
  qr: string | null
  pending: boolean
}

export interface WhatsAppTemplate {
  id: number
  name: string
  body: string
  category: string
  active: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface WhatsAppOptOut {
  id: number
  waPhoneE164: string | null
  waLid: string | null
  origin: 'customer' | 'operator'
  reasonText: string | null
  createdAt: string | null
}

/** A subscriber the billing cadence could contact. `daysOverdue` is negative when not yet due. */
export interface WhatsAppOverdueSubscriber {
  contract: string
  clientName: string | null
  document: string | null
  phone: string | null
  phoneSource: 'manual' | 'sgp' | null
  deviceId: string | null
  amount: number | null
  dueDate: string | null
  daysOverdue: number | null
}

export interface WhatsAppSkipCounts {
  noPhone: number
  optOut: number
  noInvoice: number
  futureOnly: number
  sgpRefused: number
  templateIncomplete: number
}

export interface WhatsAppBroadcast {
  id: number
  title: string
  body: string
  status: 'draft' | 'queued' | 'running' | 'paused' | 'done' | 'canceled' | 'failed'
  totalCount: number
  sentCount: number
  failedCount: number
  rateLimitPerMin: number | null
  startAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * One read that answers "is this working?".
 *
 * Every number here is something an operator today can only learn by opening
 * conversations one at a time — which means they learn it from a customer
 * complaining instead.
 */
export interface WhatsAppHealth {
  /** Connected numbers, and how many are not. */
  accounts: { total: number; connected: number; disconnected: number }
  outbox: {
    /** Waiting to go out. A number that only grows is the panel gone quiet. */
    queued: number
    /**
     * The slice of `queued` that is waiting out a retry rather than waiting for
     * the worker. Counted separately because a healthy backoff and a stuck
     * queue look identical from `queued` alone.
     */
    retrying: number
    sending: number
    /** Terminal failures in the last 24 hours. */
    failed24h: number
    /** ISO timestamp of the oldest message still waiting, or null. */
    oldestQueuedAt: string | null
  }
  inbox: { unread: number; openConversations: number }
  /** Nothing has come in or gone out since these, whatever the queue says. */
  lastInboundAt: string | null
  lastOutboundAt: string | null
  media: { files: number; bytes: number; oldestAt: string | null }
}

export type WhatsAppAlertRule = 'ont_offline' | 'rx_power_low' | 'temperature_high' | 'mass_outage'

export interface WhatsAppAlertSettings {
  enabled: boolean
  intervalSeconds: number
  recipients: string[]
  rules: Record<WhatsAppAlertRule, { enabled: boolean; threshold: number | null; cooldownMinutes: number }>
}

export interface WhatsAppConversation {
  id: number
  accountId: number
  waPhoneE164: string | null
  waLid: string | null
  pushName: string | null
  deviceId: string | null
  contract: string | null
  clientName: string | null
  /** The contact asked not to be contacted. Replying is still allowed. */
  optedOut: boolean
  lastMessageAt: string | null
  lastInboundAt: string | null
  unreadCount: number
  closedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface WhatsAppMessage {
  id: number
  conversationId: number
  direction: 'in' | 'out'
  body: string | null
  /**
   * What the panel says about a file, never where it is: the browser fetches
   * the bytes by message id through `fetchAttachment`. The stored path stays on
   * the server side of the wire.
   */
  attachment: { type: string | null; name: string | null } | null
  isNote: boolean
  /**
   * Who produced it. `sentBy` cannot answer that: it is NULL for the bot, for a
   * campaign and for an alert alike, so the three were indistinguishable in the
   * thread and in the bot's own hourly ceiling.
   */
  source: 'operator' | 'bot' | 'campaign' | 'alert'
  externalId: string | null
  deliveryStatus: 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | null
  deliveryError: string | null
  attempts: number
  /**
   * When the outbox may try this row again, or null for "now".
   *
   * A failed send is not terminal on the first bounce any more: it waits, and
   * the thread says so instead of showing a red mark the operator would read as
   * final. Null on every row that is not waiting.
   */
  nextAttemptAt: string | null
  sentBy: number | null
  readAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export const whatsappAPI = {
  getConfig: () =>
    apiClient.get<WhatsAppConfig>('/whatsapp/config'),

  // An omitted managedAdminKey keeps the stored one; "" clears it. The server
  // never returns it either way.
  updateConfig: (config: Partial<Omit<WhatsAppConfig, 'allowedHosts'>> & { allowedHosts?: string | string[]; managedAdminKey?: string }) =>
    apiClient.put<WhatsAppConfig>('/whatsapp/config', config),

  // ── Connected numbers ────────────────────────────────────────────────
  listAccounts: () =>
    apiClient.get<WhatsAppAccount[]>('/whatsapp/accounts'),

  // `baseUrl`/`adminKey` are ignored in managed mode, where the panel owns the
  // server and the operator never sees its address or its key.
  createAccount: (payload: { baseUrl?: string; adminKey?: string; label?: string; purpose?: WhatsAppPurpose }) =>
    apiClient.post<WhatsAppQrResult>('/whatsapp/accounts', payload),

  getQr: (id: number) =>
    apiClient.get<WhatsAppQrResult>(`/whatsapp/accounts/${id}/qr`),

  // Asks the server and writes back. This is the escape hatch for a lost
  // connection_update, which otherwise leaves a paired number amber forever.
  getStatus: (id: number) =>
    apiClient.get<{ account: WhatsAppAccount; state: WhatsAppStatus }>(`/whatsapp/accounts/${id}/status`),

  restartAccount: (id: number) =>
    apiClient.post<{ account: WhatsAppAccount }>(`/whatsapp/accounts/${id}/restart`, {}),

  // The only way to force a new QR: a server holding a session resumes it
  // instead of issuing one.
  disconnectAccount: (id: number) =>
    apiClient.post<{ account: WhatsAppAccount }>(`/whatsapp/accounts/${id}/disconnect`, {}),

  // The row goes either way; `serverError` is how the operator learns an
  // instance was left running on the server. No admin key is sent from here:
  // the one stored in the configuration covers a panel pointed at one server,
  // and a browser is the wrong place to be typing a server's master key.
  deleteAccount: (id: number) =>
    apiClient.delete<{ removedOnServer: boolean; serverError: string | null }>(`/whatsapp/accounts/${id}`),

  updateAccount: (id: number, patch: { label?: string; purpose?: WhatsAppPurpose; isDefault?: boolean }) =>
    apiClient.requestWithBody<{ account: WhatsAppAccount }>('PATCH', `/whatsapp/accounts/${id}`, patch),

  checkNumbers: (numbers: string[]) =>
    apiClient.post<{ number: string; exists: boolean }[]>('/whatsapp/accounts/check-number', { numbers }),

  // ── Templates ────────────────────────────────────────────────────────
  listTemplates: (params: { category?: string; includeInactive?: boolean } = {}) => {
    const query = new URLSearchParams()
    if (params.category) query.set('category', params.category)
    if (params.includeInactive) query.set('includeInactive', '1')
    const suffix = query.toString()
    return apiClient.get<WhatsAppTemplate[]>(`/whatsapp/templates${suffix ? `?${suffix}` : ''}`)
  },

  createTemplate: (payload: { name: string; body: string; category?: string }) =>
    apiClient.post<WhatsAppTemplate>('/whatsapp/templates', payload),

  updateTemplate: (id: number, patch: Partial<{ name: string; body: string; category: string; active: boolean }>) =>
    apiClient.put<WhatsAppTemplate>(`/whatsapp/templates/${id}`, patch),

  deleteTemplate: (id: number) =>
    apiClient.delete(`/whatsapp/templates/${id}`),

  // ── Do not disturb ───────────────────────────────────────────────────
  listOptOuts: () =>
    apiClient.get<WhatsAppOptOut[]>('/whatsapp/opt-outs'),

  createOptOut: (payload: { phone: string; reasonText?: string }) =>
    apiClient.post<WhatsAppOptOut>('/whatsapp/opt-outs', payload),

  revokeOptOut: (id: number) =>
    apiClient.delete(`/whatsapp/opt-outs/${id}`),

  // ── Billing cadence ──────────────────────────────────────────────────
  // The window is symmetric: a negative `daysMin` means "due within N days".
  listOverdue: (params: { daysMin?: number; daysMax?: number; search?: string; limit?: number } = {}) => {
    const query = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    })
    const suffix = query.toString()
    return apiClient.get<WhatsAppOverdueSubscriber[]>(`/whatsapp/billing/overdue${suffix ? `?${suffix}` : ''}`)
  },

  // Builds the campaign as a DRAFT and returns it. Messaging hundreds of people
  // is never the side effect of a click on a listing screen.
  buildBillingCampaign: (payload: { template: string; contracts: string[]; title?: string }) =>
    apiClient.post<{ broadcast: WhatsAppBroadcast; recipients: number; skipped: WhatsAppSkipCounts }>(
      '/whatsapp/billing/campaign',
      payload
    ),

  // ── Campaigns ────────────────────────────────────────────────────────
  listBroadcasts: () =>
    apiClient.get<WhatsAppBroadcast[]>('/whatsapp/broadcasts'),

  setBroadcastStatus: (id: number, status: 'running' | 'paused' | 'canceled') =>
    apiClient.post<WhatsAppBroadcast>(`/whatsapp/broadcasts/${id}/status`, { status }),

  // ── The subscriber's number ──────────────────────────────────────────
  // What an operator typed always beats what SGP synced, because the ERP
  // cadastre is stale and the operator is the one holding the correction. An
  // empty string clears the override and hands the contract back to the ERP.
  setSubscriberPhone: (contract: string, phone: string) =>
    apiClient.put<WhatsAppOverdueSubscriber>(
      `/whatsapp/subscribers/${encodeURIComponent(contract)}/phone`,
      { phone }
    ),

  // ── Technical alerts ─────────────────────────────────────────────────
  getAlertSettings: () =>
    apiClient.get<WhatsAppAlertSettings>('/whatsapp/alerts/settings'),

  updateAlertSettings: (settings: Partial<WhatsAppAlertSettings>) =>
    apiClient.put<WhatsAppAlertSettings>('/whatsapp/alerts/settings', settings),

  runAlertScan: () =>
    apiClient.post<{ fired: number; cleared: number }>('/whatsapp/alerts/scan', {}),

  // ── Inbox ────────────────────────────────────────────────────────────
  // `search` matches the phone, the pushed WhatsApp name, the contract and the
  // subscriber's name — an operator looking for a thread has one of those four
  // and does not know which the panel stores. `status` defaults to the open
  // ones: a closed thread is done, and an inbox that shows everything forever
  // stops being a list of what needs answering.
  listConversations: (params: {
    limit?: number
    offset?: number
    search?: string
    status?: 'open' | 'closed' | 'all'
  } = {}) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (params.offset) query.set('offset', String(params.offset))
    if (params.search) query.set('search', params.search)
    if (params.status) query.set('status', params.status)
    const suffix = query.toString()
    return apiClient.get<WhatsAppConversation[]>(`/whatsapp/conversations${suffix ? `?${suffix}` : ''}`)
  },

  // Closing is a filing decision, not a deletion: the thread and its history
  // stay, and an inbound message reopens it — a customer who writes again is
  // not answered by an archive.
  setConversationStatus: (conversationId: number, status: 'open' | 'closed') =>
    apiClient.post<WhatsAppConversation>(`/whatsapp/conversations/${conversationId}/status`, { status }),

  // Reading a thread clears its unread count server-side — the operator looking
  // at it is the only thing "read" can mean here.
  // `before` is the id of the oldest message already on screen — a cursor, not
  // an offset. The thread grows while it is being read, and an offset page
  // would repeat or skip a message every time a customer answers mid-scroll.
  listMessages: (conversationId: number, params: { limit?: number; before?: number } = {}) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (params.before) query.set('before', String(params.before))
    const suffix = query.toString() ? `?${query.toString()}` : ''
    return apiClient.get<{ conversation: WhatsAppConversation; messages: WhatsAppMessage[] }>(
      `/whatsapp/conversations/${conversationId}/messages${suffix}`
    )
  },

  // ── Is it working? ───────────────────────────────────────────────────
  // A single aggregate read. Cheap on purpose: a screen that polls it must not
  // be the reason the panel is slow.
  getHealth: () =>
    apiClient.get<WhatsAppHealth>('/whatsapp/health'),

  // The attachment sweep, on demand, for the operator who needs the disk back
  // before the next pass six hours from now. It takes no parameters: the window
  // and the rules come from the saved settings, so pressing the button can
  // never delete more than the settings screen already says it will.
  //
  // `skipped` is the answer that matters. "0 files" means one of retention
  // being off, nothing being old enough, or a pass already running — and those
  // read identically unless the reason comes back with the count.
  // Puts one failed message back in the queue, as ITSELF. The old screen-side
  // "resend" read the row's body and sent a new message, which left the failed
  // row behind, produced a duplicate for the subscriber, and did nothing at all
  // when the content was an attachment and the body was empty.
  requeueMessage: (id: number) =>
    apiClient.post<WhatsAppMessage>(`/whatsapp/messages/${id}/requeue`, {}),

  // Every message that failed inside the window, back in the queue, for the
  // campaign case: an Evolution restart during a dunning run fails thousands,
  // and requeuing them one at a time is not a recovery.
  requeueFailed: (hours: number) =>
    apiClient.post<{ requeued: number }>('/whatsapp/messages/requeue-failed', { hours }),

  sweepMedia: () =>
    apiClient.post<{ files: number; bytes: number; mb: number; skipped?: string }>(
      '/whatsapp/media/sweep',
      {}
    ),

  // ── Attachments ──────────────────────────────────────────────────────
  // The raw file as the body, its name in a header. No multipart, and so no
  // upload dependency for one screen — the same choice the SGP webhook makes
  // with `express.raw`. Returns the stored reference `sendMessage` takes.
  uploadAttachment: (file: File) =>
    apiClient.sendBlob<{ path: string; type: string; name: string }>(
      '/whatsapp/attachments',
      file,
      { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }
    ),

  // A blob rather than a URL, because the route is session-authenticated and an
  // `<img src>` cannot carry an Authorization header. The caller makes an object
  // URL from it and revokes that when the bubble goes away.
  fetchAttachment: (messageId: number) =>
    apiClient.getBlob(`/whatsapp/messages/${messageId}/media`),

  // Enqueues and returns; the outbox worker delivers. An internal note is
  // stored and never sent.
  sendMessage: (conversationId: number, payload: { body?: string; attachment?: { url: string; type?: string; name?: string }; isNote?: boolean }) =>
    apiClient.post<WhatsAppMessage>(`/whatsapp/conversations/${conversationId}/messages`, payload),

  // ── Subscriber phone ─────────────────────────────────────────────────
  // Overrides what SGP returned. An empty string clears the override and falls
  // back to the ERP value.
  setDevicePhone: (deviceId: string, phone: string) =>
    apiClient.put<{ phoneE164: string | null; phoneManual: string | null }>(
      `/whatsapp/devices/${encodeURIComponent(deviceId)}/phone`,
      { phone }
    ),
}
