'use client'

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { mapSettingsAPI, settingsAPI, tenantAPI, usersAPI, type GenieAcsAuthType } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useTenant } from '@/contexts/tenant-context'
import { onboardingDismissKey } from '@/lib/onboarding'

/**
 * The first minutes of a provider that just signed up: what it is called and
 * where its plant is, which GenieACS it manages and how to authenticate to it,
 * and a first colleague. Three screens, each a form the settings page already
 * has — this is the same API in a different order, not a second way to write
 * any of it.
 *
 * Shown by `OnboardingGate` while the provider has no GenieACS address, which
 * is the one thing a panel cannot do anything without. Skippable, and the skip
 * is remembered per provider in the browser: an operator who wants to set
 * things up from the settings page is not nagged into a wizard.
 */

type Step = 'identity' | 'acs' | 'team'
const STEPS: Step[] = ['identity', 'acs', 'team']

export default function Onboarding() {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { tenant, name: currentName, refresh } = useTenant()
  const [step, setStep] = useState<Step>('identity')
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState(currentName)
  const [center, setCenter] = useState<{ lat: string; lng: string }>({ lat: '', lng: '' })
  const [acs, setAcs] = useState({ url: '', authType: 'none' as GenieAcsAuthType, username: '', secret: '' })
  const [testResult, setTestResult] = useState<string | null>(null)
  const [colleague, setColleague] = useState({ username: '', password: '' })

  useEffect(() => {
    setName(currentName)
  }, [currentName])

  useEffect(() => {
    void (async () => {
      const map = await mapSettingsAPI.get()
      const data = map.data as { center_lat?: string; center_lng?: string } | undefined
      if (map.success && data) setCenter({ lat: String(data.center_lat ?? ''), lng: String(data.center_lng ?? '') })
    })()
  }, [])

  const finish = () => {
    if (tenant?.slug) {
      try { localStorage.setItem(onboardingDismissKey(tenant.slug), '1') } catch {}
    }
    navigate('/dashboard', { replace: true })
  }

  const saveIdentity = async () => {
    setBusy(true)
    try {
      const trimmed = name.trim()
      if (trimmed && trimmed !== currentName) {
        const res = await tenantAPI.rename(trimmed)
        if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
        await refresh()
      }
      const lat = Number(center.lat), lng = Number(center.lng)
      if (center.lat !== '' && center.lng !== '' && Number.isFinite(lat) && Number.isFinite(lng)) {
        const current = await mapSettingsAPI.get()
        const res = await mapSettingsAPI.update({ ...(current.data as object ?? {}), center_lat: String(lat), center_lng: String(lng) })
        if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
      }
      setStep('acs')
    } finally {
      setBusy(false)
    }
  }

  const testAcs = async () => {
    setBusy(true)
    setTestResult(null)
    try {
      const res = await settingsAPI.testGenieAcs(acs.url.trim())
      setTestResult(res.success ? t('onboarding.acs.testOk') : (res.message || t('onboarding.acs.testFailed')))
    } finally {
      setBusy(false)
    }
  }

  const saveAcs = async () => {
    const url = acs.url.trim()
    if (!url) { toast.error(t('onboarding.acs.urlRequired')); return }
    if (acs.authType === 'basic' && !acs.username.trim()) { toast.error(t('settings.genieAuth.usernameRequired')); return }
    setBusy(true)
    try {
      const saved = await settingsAPI.update('genieAcsUrl', url)
      if (!saved.success) { toast.error(saved.message || t('settings.saveError')); return }
      const auth = await settingsAPI.updateGenieAcsAuth({
        authType: acs.authType,
        username: acs.username.trim(),
        ...(acs.authType !== 'none' && acs.secret ? { secret: acs.secret } : {})
      })
      if (!auth.success) { toast.error(auth.message || t('settings.genieAuth.saveFailed')); return }
      setStep('team')
    } finally {
      setBusy(false)
    }
  }

  const saveColleague = async () => {
    if (!colleague.username.trim()) { finish(); return }
    setBusy(true)
    try {
      const res = await usersAPI.create({ username: colleague.username.trim(), password: colleague.password, role: 'tech' })
      if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
      finish()
    } finally {
      setBusy(false)
    }
  }

  const index = STEPS.indexOf(step)

  return (
    <div className="page-shell">
      <div className="page-frame max-w-2xl">
        <header className="page-header">
          <div>
            <p className="page-kicker">{t('onboarding.kicker', { step: index + 1, total: STEPS.length })}</p>
            <h1 className="page-title">{t(`onboarding.${step}.title`)}</h1>
            <p className="page-description">{t(`onboarding.${step}.description`)}</p>
          </div>
          <button type="button" className="modern-button-secondary" onClick={finish}>{t('onboarding.skip')}</button>
        </header>

        <div className="modern-card space-y-5 p-5 sm:p-6">
          {step === 'identity' && (
            <>
              <div>
                <label htmlFor="ob-name" className="field-label">{t('settings.general.appName')}</label>
                <input id="ob-name" className="modern-input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="ob-lat" className="field-label">{t('onboarding.identity.lat')}</label>
                  <input id="ob-lat" className="modern-input w-full" inputMode="decimal" value={center.lat} onChange={(e) => setCenter((c) => ({ ...c, lat: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="ob-lng" className="field-label">{t('onboarding.identity.lng')}</label>
                  <input id="ob-lng" className="modern-input w-full" inputMode="decimal" value={center.lng} onChange={(e) => setCenter((c) => ({ ...c, lng: e.target.value }))} />
                </div>
              </div>
              <p className="field-hint">{t('onboarding.identity.mapHint')}</p>
              <button type="button" className="modern-button" disabled={busy} onClick={() => void saveIdentity()}>
                {busy ? t('common.saving') : t('common.next')}
              </button>
            </>
          )}

          {step === 'acs' && (
            <>
              <div>
                <label htmlFor="ob-acs" className="field-label">{t('settings.general.genieAcsUrl')}</label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input id="ob-acs" className="modern-input flex-1" placeholder="https://acs.seu-provedor.com.br:7557" value={acs.url} onChange={(e) => setAcs((a) => ({ ...a, url: e.target.value }))} />
                  <button type="button" className="modern-button-secondary" disabled={busy || !acs.url.trim()} onClick={() => void testAcs()}>
                    {t('settings.general.testConnection')}
                  </button>
                </div>
                {testResult && <p className="field-hint">{testResult}</p>}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="ob-auth" className="field-label">{t('settings.genieAuth.type')}</label>
                  <select id="ob-auth" className="modern-input w-full" value={acs.authType} onChange={(e) => setAcs((a) => ({ ...a, authType: e.target.value as GenieAcsAuthType }))}>
                    <option value="none">{t('settings.genieAuth.typeNone')}</option>
                    <option value="basic">{t('settings.genieAuth.typeBasic')}</option>
                    <option value="bearer">{t('settings.genieAuth.typeBearer')}</option>
                  </select>
                </div>
                {acs.authType === 'basic' && (
                  <div>
                    <label htmlFor="ob-user" className="field-label">{t('settings.genieAuth.username')}</label>
                    <input id="ob-user" className="modern-input w-full" autoComplete="off" value={acs.username} onChange={(e) => setAcs((a) => ({ ...a, username: e.target.value }))} />
                  </div>
                )}
                {acs.authType !== 'none' && (
                  <div>
                    <label htmlFor="ob-secret" className="field-label">{t(acs.authType === 'basic' ? 'settings.genieAuth.password' : 'settings.genieAuth.token')}</label>
                    <input id="ob-secret" type="password" className="modern-input w-full" autoComplete="new-password" value={acs.secret} onChange={(e) => setAcs((a) => ({ ...a, secret: e.target.value }))} />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => setStep('identity')}>{t('common.back')}</button>
                <button type="button" className="modern-button" disabled={busy} onClick={() => void saveAcs()}>
                  {busy ? t('common.saving') : t('common.next')}
                </button>
              </div>
            </>
          )}

          {step === 'team' && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="ob-colleague" className="field-label">{t('settings.operators.username')}</label>
                  <input id="ob-colleague" className="modern-input w-full" autoComplete="off" value={colleague.username} onChange={(e) => setColleague((c) => ({ ...c, username: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="ob-colleague-pw" className="field-label">{t('login.password')}</label>
                  <input id="ob-colleague-pw" type="password" className="modern-input w-full" autoComplete="new-password" value={colleague.password} onChange={(e) => setColleague((c) => ({ ...c, password: e.target.value }))} />
                </div>
              </div>
              <p className="field-hint">{t('onboarding.team.hint')}</p>
              <div className="flex gap-2">
                <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => setStep('acs')}>{t('common.back')}</button>
                <button type="button" className="modern-button" disabled={busy || (colleague.username.trim() !== '' && colleague.password.length < 8)} onClick={() => void saveColleague()}>
                  <Icon name="check" size={17} />
                  {colleague.username.trim() ? t('onboarding.team.addAndFinish') : t('onboarding.finish')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
