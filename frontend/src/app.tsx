import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router'
import Sidebar from '@/components/sidebar'
import { ThemeProvider } from '@/contexts/theme-context'
import { AuthProvider, useAuth } from '@/contexts/auth-context'
import { ToastProvider } from '@/components/ui/toast'
import { LoadingProvider, RouteChangeLoader } from '@/components/ui/loading'
import { BrandMark } from '@/components/brand-mark'
import { LanguageProvider, useTranslation } from '@/contexts/language-context'

const DashboardPage = lazy(() => import('@/pages/dashboard'))
const DevicesPage = lazy(() => import('@/pages/devices'))
const DeviceDetailPage = lazy(() => import('@/pages/device-detail'))
const NetworkMapPage = lazy(() => import('@/pages/network-map'))
const SettingsPage = lazy(() => import('@/pages/settings'))
const LoginPage = lazy(() => import('@/pages/login'))
const SetupPage = lazy(() => import('@/pages/setup'))

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

function ProtectedShell() {
  const { isAuthenticated, loading, needsSetup } = useAuth()
  if (loading) return <AuthFallback />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (!isAuthenticated) return <Navigate to="/login" replace />

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1">
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
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
      <LanguageProvider>
        <ThemeProvider>
          <LoadingProvider>
            <ToastProvider>
              <RouteChangeLoader />
              <Routes>
                <Route path="/login" element={<Suspense fallback={<AuthFallback />}><LoginRoute /></Suspense>} />
                <Route path="/setup" element={<Suspense fallback={<AuthFallback />}><SetupRoute /></Suspense>} />
                <Route element={<ProtectedShell />}>
                  <Route index element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/devices" element={<DevicesPage />} />
                  <Route path="/devices/detail" element={<DeviceDetailPage />} />
                  <Route path="/network-map" element={<NetworkMapPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Route>
              </Routes>
            </ToastProvider>
          </LoadingProvider>
        </ThemeProvider>
      </LanguageProvider>
    </AuthProvider>
  )
}
