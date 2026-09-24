import { useEffect, useState } from 'react'
import { mapSettingsAPI } from '@/lib/api'
import { LocationPicker } from '@/components/location-picker'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * Onde o mapa da rede abre. O mesmo par de campos e o mesmo seletor do
 * onboarding — sem isto, quem pulou o assistente ou marcou o ponto errado
 * não tinha outro lugar para corrigir.
 *
 * Só para quem tem `map.write` (quem chama decide).
 *
 * Tem o próprio Salvar: grava em `/map-settings`, não nas configurações que
 * o Salvar do resto da aba grava, e o PUT exige os níveis de zoom junto — por
 * isso lê o registro inteiro e só troca o centro.
 */
export function MapCenterPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [center, setCenter] = useState<{ lat: string; lng: string }>({ lat: '', lng: '' })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const res = await mapSettingsAPI.get()
      const data = res.data as { center_lat?: string; center_lng?: string } | undefined
      if (res.success && data) setCenter({ lat: String(data.center_lat ?? ''), lng: String(data.center_lng ?? '') })
      setLoaded(true)
    })()
  }, [])

  const lat = Number(center.lat), lng = Number(center.lng)
  const valid = center.lat.trim() !== '' && center.lng.trim() !== ''
    && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

  const save = async () => {
    if (!valid) { toast.error(t('settings.mapCenter.invalid')); return }
    setBusy(true)
    try {
      const current = await mapSettingsAPI.get()
      if (!current.success) { toast.error(current.message || t('settings.saveError')); return }
      const res = await mapSettingsAPI.update({ ...(current.data as object ?? {}), center_lat: String(lat), center_lng: String(lng) })
      if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
      toast.success(t('settings.mapCenter.saved'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modern-card max-w-3xl p-5 sm:p-6">
      <h2 className="section-heading">{t('settings.mapCenter.title')}</h2>
      <p className="section-description mb-6">{t('settings.mapCenter.description')}</p>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="map-center-lat" className="field-label">{t('onboarding.identity.lat')}</label>
            <input id="map-center-lat" className="modern-input w-full" inputMode="decimal" value={center.lat} onChange={(e) => setCenter((c) => ({ ...c, lat: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="map-center-lng" className="field-label">{t('onboarding.identity.lng')}</label>
            <input id="map-center-lng" className="modern-input w-full" inputMode="decimal" value={center.lng} onChange={(e) => setCenter((c) => ({ ...c, lng: e.target.value }))} />
          </div>
        </div>
        {/* Monta depois da leitura: o seletor só abre no ponto salvo se já o
            recebe na primeira renderização. */}
        {loaded && (
          <LocationPicker
            lat={center.lat.trim() === '' ? null : lat}
            lng={center.lng.trim() === '' ? null : lng}
            onChange={(la, ln) => setCenter({ lat: String(la), lng: String(ln) })}
          />
        )}
        <p className="field-hint">{t('onboarding.identity.mapHint')}</p>
        <button type="button" className="modern-button" disabled={busy || !loaded} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
