'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { publicTenantAPI, type PublicTenant } from '@/lib/api'

/**
 * The provider the browser's own address resolves to, read once at boot.
 *
 * This is where the name on the sidebar, the login screen and the tab comes
 * from now. It used to be `settings.appName`, copied into `localStorage` and
 * broadcast on a custom event — which meant a name that lived in three places
 * and agreed in none of them for the first second after a change. The
 * `tenants` row is the provider; the public profile answers from it before
 * anybody has signed in, which is exactly when the login screen needs it.
 *
 * `edition` and `panelBaseDomain` ride along because the screens that differ
 * by product — signup, the database switcher — have to know which product
 * they are in, and the backend is the only one that does.
 */
export const FALLBACK_NAME = 'SkyGenPanel'

interface TenantContextValue {
  tenant: PublicTenant | null
  loading: boolean
  /** The name to show, never empty: the provider's, or the product's while it loads or when the host names nobody. */
  name: string
  isSaas: boolean
  /** The platform's own front door: a SaaS host that names no provider. Only sign-up lives here. */
  isPlatformHost: boolean
  /** Re-read after the provider renamed itself. */
  refresh: () => Promise<void>
}

const TenantContext = createContext<TenantContextValue | undefined>(undefined)

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenant] = useState<PublicTenant | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const res = await publicTenantAPI.current()
    setTenant(res.success && res.data ? res.data : null)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const name = tenant?.name || FALLBACK_NAME

  // The tab title follows the provider, the same way `<html lang>` follows the
  // locale: one place, so no screen has to remember to set it.
  useEffect(() => {
    document.title = name
  }, [name])

  const value = useMemo<TenantContextValue>(() => ({
    tenant,
    loading,
    name,
    isSaas: tenant?.edition === 'saas',
    isPlatformHost: tenant !== null && tenant.slug === null,
    refresh
  }), [tenant, loading, name, refresh])

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
}

export function useTenant() {
  const context = useContext(TenantContext)
  if (!context) throw new Error('useTenant must be used within a TenantProvider')
  return context
}
