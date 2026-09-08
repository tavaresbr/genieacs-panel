import type { TranslationKey, TranslationVars } from '@/lib/i18n/dictionary'

/**
 * The customer portal API answers with a machine-readable `code` next to its
 * `message`. The message is written in the backend's own language, so the
 * portal translates the code and only falls back to the message for codes it
 * does not know yet.
 */
export interface ApiMessageSource {
  code?: string
  message?: string
}

export type Translator = (key: TranslationKey, vars?: TranslationVars) => string

/** Every code the customer portal API is documented to emit. */
export const API_MESSAGE_KEYS = {
  // Successful operations
  login_ok: 'portal.api.loginOk',
  session_active: 'portal.api.sessionActive',
  overview_ok: 'portal.api.overviewOk',
  wifi_updated: 'portal.api.wifiUpdated',
  wifi_password_ok: 'portal.api.wifiPasswordOk',
  logout_ok: 'portal.api.logoutOk',

  // Portal errors
  invalid_credentials: 'portal.api.invalidCredentials',
  login_failed: 'portal.api.loginFailed',
  device_not_found: 'portal.api.deviceNotFound',
  overview_unavailable: 'portal.api.overviewUnavailable',
  invalid_wifi_index: 'portal.api.invalidWifiIndex',
  invalid_ssid: 'portal.api.invalidSsid',
  invalid_wifi_password: 'portal.api.invalidWifiPassword',
  wifi_network_not_found: 'portal.api.wifiNetworkNotFound',
  wifi_rejected: 'portal.api.wifiRejected',
  wifi_update_failed: 'portal.api.wifiUpdateFailed',
  wifi_password_not_saved: 'portal.api.wifiPasswordNotSaved',
  wifi_password_unavailable: 'portal.api.wifiPasswordUnavailable',

  // Session
  customer_session_required: 'portal.api.sessionRequired',
  customer_session_invalid: 'portal.api.sessionInvalid',
  customer_session_expired: 'portal.api.sessionExpired',

  // Rate limits
  rate_limited: 'portal.api.rateLimited',
  rate_limited_login: 'portal.api.rateLimitedLogin',
  rate_limited_wifi: 'portal.api.rateLimitedWifi',
  rate_limited_reveal: 'portal.api.rateLimitedReveal',
  rate_limited_billing: 'portal.api.rateLimitedBilling',
  rate_limited_unlock: 'portal.api.rateLimitedUnlock',

  // Operator billing system (SGP), raised as `SgpError.code`
  billing_disabled: 'portal.api.billingDisabled',
  unlock_disabled: 'portal.api.unlockDisabled',
  not_configured: 'portal.api.sgpNotConfigured',
  unlinked: 'portal.api.sgpUnlinked',
  not_found: 'portal.api.sgpNotFound',
  timeout: 'portal.api.sgpTimeout',
  unreachable: 'portal.api.sgpUnreachable',
  http_error: 'portal.api.sgpHttpError',
  invalid_response: 'portal.api.sgpInvalidResponse',
  sgp_rejected: 'portal.api.sgpRejected',
  unauthorized: 'portal.api.sgpUnauthorized',
  missing_filter: 'portal.api.sgpMissingFilter',
  missing_contract: 'portal.api.sgpMissingContract',
} as const satisfies Record<string, TranslationKey>

export type ApiMessageCode = keyof typeof API_MESSAGE_KEYS

/**
 * Codes whose backend message carries detail no dictionary can reproduce — the
 * ONT's own rejection reason — so the message wins over the generic string.
 */
const PREFER_BACKEND_MESSAGE = new Set<ApiMessageCode>(['wifi_rejected'])

/** Codes that mean the portal session is gone and the browser must sign in again. */
export const CUSTOMER_SESSION_CODES = [
  'customer_session_required',
  'customer_session_invalid',
  'customer_session_expired',
] as const satisfies readonly ApiMessageCode[]

const SESSION_CODES = new Set<string>(CUSTOMER_SESSION_CODES)

export function isApiMessageCode(code: string | undefined): code is ApiMessageCode {
  return code !== undefined && Object.prototype.hasOwnProperty.call(API_MESSAGE_KEYS, code)
}

/** True when the response says the customer session ended. */
export function isCustomerSessionCode(code: string | undefined): boolean {
  return code !== undefined && SESSION_CODES.has(code)
}

/**
 * Turns an API response into a string the subscriber can read: the translation
 * of its `code`, else the backend `message`, else `fallbackKey`.
 */
export function translateApiMessage(
  result: ApiMessageSource | null | undefined,
  t: Translator,
  fallbackKey: TranslationKey = 'portal.api.unexpected',
): string {
  const code = result?.code
  const message = result?.message?.trim()
  if (isApiMessageCode(code)) {
    if (message && PREFER_BACKEND_MESSAGE.has(code)) return message
    return t(API_MESSAGE_KEYS[code])
  }
  return message || t(fallbackKey)
}
