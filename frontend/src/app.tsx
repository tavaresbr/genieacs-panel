import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router'
import Sidebar from '@/components/sidebar'
import { ThemeProvider } from '@/contexts/theme-context'
import { AuthProvider, useAuth } from '@/contexts/auth-context'
import { ToastProvider } from '@/components/ui/toast'
import { LoadingProvider, RouteChangeLoader } from '@/components/ui/loading'
import { BrandMark } from '@/components/brand-mark'
import { LanguageProvider, useTranslation } from '@/contexts/language-context'
import { SubscriptionNotice } from '@/components/subscription-notice'
import { TenantProvider, useTenant } from '@/contexts/tenant-context'
import { settingsAPI } from '@/lib/api'
import { onboardingDismissKey } from '@/lib/onboarding'
import type { Permission } from '@/lib/permissions'

const DashboardPage = lazy(() => import('@/pages/dashboard'))
const DevicesPage = lazy(() => import('@/pages/devices'))
const DeviceDetailPage = lazy(() => import('@/pages/device-detail'))
const NetworkMapPage = lazy(() => import('@/pages/network-map'))
const SettingsPage = lazy(() => import('@/pages/settings'))
const WhatsAppPage = lazy(() => import('@/pages/whatsapp'))
const PlatformPage = lazy(() => import('@/pages/platform'))
const LoginPage = lazy(() => import('@/pages/login'))
const SetupPage = lazy(() => import('@/pages/setup'))
const SignupPage = lazy(() => import('@/pages/signup'))
const PlanPage = lazy(() => import('@/pages/plan'))
const OnboardingPage = lazy(() => import('@/pages/onboarding'))

function PageFallback() {
  const { t } = useTranslation()
  return (
    <div className="page-shell" role="status" aria-live="polite">
      <div className="page-frame">
        <div className="mb-6 h-24 animate-pulse rounded-md bg-muted" />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="h-56 animate-pulse rounded-md bg-muted" />
          <div className="h-56 animate-pulse rounded-md bg-muted" />
        </div>
        <span className="sr-only">{t('app.loadingPage')}</span>
      </div>
    </div>
  )
}

function AuthFallback() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen items-center justify-center bg-background" role="status" aria-label={t('app.checkingAccess')}>
      <BrandMark className="size-11 animate-pulse" />
    </div>
  )
}

/**
 * Sends a freshly signed-up provider to the onboarding wizard, once.
 *
 * The test is the one fact a panel cannot work without: no GenieACS address.
 * Only on the SaaS edition (a self-hosted install has its own setup wizard),
 * only for somebody who can write settings, and never again once the wizard
 * was finished or skipped for this provider in this browser.
 */
function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { can } = useAuth()
  const { tenant, isSaas } = useTenant()
  const location = useLocation()
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(isSaas ? null : false)

  useEffect(() => {
    if (!isSaas || !tenant || !can('settings.write')) { setNeedsOnboarding(false); return }
    let dismissed = false
    try { dismissed = localStorage.getItem(onboardingDismissKey(tenant.slug)) === '1' } catch {}
    if (dismissed) { setNeedsOnboarding(false); return }
    let cancelled = false
    void settingsAPI.getAll().then((res) => {
      if (cancelled) return
      const url = res.success && res.data ? String((res.data as { genieAcsUrl?: string }).genieAcsUrl ?? '') : ''
      setNeedsOnboarding(res.success ? url.trim() === '' : false)
    })
    return () => { cancelled = true }
  }, [isSaas, tenant, can])

  if (needsOnboarding === null) return <PageFallback />
  if (needsOnboarding && location.pathname !== '/onboarding') return <Navigate to="/onboarding" replace />
  return <>{children}</>
}

function ProtectedShell() {
  const { isAuthenticated, loading, needsSetup } = useAuth()
  if (loading) return <AuthFallback />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (!isAuthenticated) return <Navigate to="/login" replace />

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1">
        {/* A faixa ou o muro da assinatura. Fica na casca e não numa tela
            porque a primeira requisição recusada pode vir de qualquer uma. */}
        <SubscriptionNotice />
        <Suspense fallback={<PageFallback />}>
          <OnboardingGate>
            <Outlet />
          </OnboardingGate>
        </Suspense>
      </main>
    </div>
  )
}

/** Signup only exists where a provider can be given an address. */
function SignupRoute() {
  const { isAuthenticated, loading } = useAuth()
  const { tenant, loading: tenantLoading } = useTenant()
  if (loading || tenantLoading) return <AuthFallback />
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  if (tenant?.edition !== 'saas' || !tenant.panelBaseDomain) return <Navigate to="/login" replace />
  return <SignupPage />
}

/**
 * Uma rota guardada pela capacidade que a tela precisa para carregar.
 *
 * Guardava por `role === 'admin'`, o que com quatro papéis fecharia o mapa e a
 * caixa do WhatsApp para o plantão, que é justamente quem trabalha ali. Quem
 * não tem a capacidade é mandado ao painel em vez de a uma tela onde cada
 * requisição responde 403 — e a capacidade escolhida é a da LEITURA que a tela
 * faz ao abrir, não a da ação mais poderosa que ela oferece: quem só lê entra e
 * vê; os botões de escrita se escondem sozinhos lá dentro.
 */
function PermissionRoute({ permission }: { permission: Permission }) {
  const { can, loading } = useAuth()
  if (loading) return <AuthFallback />
  if (!can(permission)) return <Navigate to="/dashboard" replace />
  return <Outlet />
}

/**
 * The control plane, which is a level above a provider's own administrator.
 *
 * Tem a forma de `PermissionRoute` e guarda outro fato, de propósito: estas
 * rotas existem só onde a instalação roda como SaaS, e só para quem está na
 * lista da plataforma. Nenhuma capacidade da matriz responde por isso — nem a
 * de um `owner`, que administra o provedor dele e nada acima —, e guardada por
 * uma delas a tela apareceria para quase todo administrador do painel,
 * apontando para rotas que respondem 404 a ele.
 */
function PlatformRoute() {
  const { user, loading } = useAuth()
  if (loading) return <AuthFallback />
  if (!user?.isPlatformAdmin) return <Navigate to="/dashboard" replace />
  return <Outlet />
}

function LoginRoute() {
  const { isAuthenticated, loading, needsSetup } = useAuth()
  if (loading) return <AuthFallback />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  return <LoginPage />
}

function SetupRoute() {
  const { isAuthenticated, loading, needsSetup } = useAuth()
  if (loading) return <AuthFallback />
  if (!needsSetup) return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />
  return <SetupPage />
}

export default function App() {
  return (
    <AuthProvider>
      <TenantProvider>
      <LanguageProvider>
        <ThemeProvider>
          <LoadingProvider>
            <ToastProvider>
              <RouteChangeLoader />
              <Routes>
                <Route path="/login" element={<Suspense fallback={<AuthFallback />}><LoginRoute /></Suspense>} />
                <Route path="/setup" element={<Suspense fallback={<AuthFallback />}><SetupRoute /></Suspense>} />
                <Route path="/signup" element={<Suspense fallback={<AuthFallback />}><SignupRoute /></Suspense>} />
                <Route element={<ProtectedShell />}>
                  <Route index element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/devices" element={<DevicesPage />} />
                  <Route path="/devices/detail" element={<DeviceDetailPage />} />
                  <Route element={<PlatformRoute />}>
                    <Route path="/platform" element={<PlatformPage />} />
                  </Route>
                  <Route element={<PermissionRoute permission="map.read" />}>
                    <Route path="/network-map" element={<NetworkMapPage />} />
                  </Route>
                  <Route element={<PermissionRoute permission="settings.read" />}>
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/plan" element={<PlanPage />} />
                  </Route>
                  <Route element={<PermissionRoute permission="settings.write" />}>
                    <Route path="/onboarding" element={<OnboardingPage />} />
                  </Route>
                  <Route element={<PermissionRoute permission="whatsapp.read" />}>
                    <Route path="/whatsapp" element={<WhatsAppPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Route>
              </Routes>
            </ToastProvider>
          </LoadingProvider>
        </ThemeProvider>
      </LanguageProvider>
      </TenantProvider>
    </AuthProvider>
  )
}
