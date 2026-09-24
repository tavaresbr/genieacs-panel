import { useEffect, useState } from 'react'
import { mapSettingsAPI, subscriptionAPI, tenantAPI, type TenantBilling } from '@/lib/api'
import { ADDRESS_FIELDS, CLASSE_LARGURA } from '@/components/billing-profile'
import { LocationPicker } from '@/components/location-picker'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/**
 * O endereço principal do provedor e o ponto dele no mapa, num bloco só.
 *
 * Nenhum dado novo: o endereço é o do cadastro fiscal (o mesmo que a tela
 * Plano edita) e o ponto é o centro do mapa da rede. Aqui é onde o operador
 * procura "o endereço do provedor"; lá é onde o contador procura a nota.
 *
 * Cada metade exige a própria permissão — `settings.write` para o endereço,
 * `map.write` para o ponto — e o Salvar só grava a metade que a pessoa pode
 * gravar. Do endereço vão só os campos que mudaram: a rota trata campo
 * ausente como "não mexe", e o resto do cadastro fiscal (razão social, CNPJ…)
 * nem aparece aqui.
 */
type AddressForm = Record<string, string>

function addressFrom(billing: TenantBilling | null): AddressForm {
  const out: AddressForm = {}
  for (const { chave } of ADDRESS_FIELDS) out[chave] = (billing?.[chave] ?? '') as string
  return out
}

export function ProviderAddressPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const { can } = useAuth()
  const canAddress = can('settings.write')
  const canMap = can('map.write')

  const [address, setAddress] = useState<AddressForm>(() => addressFrom(null))
  const [savedAddress, setSavedAddress] = useState<AddressForm>(() => addressFrom(null))
  const [center, setCenter] = useState<{ lat: string; lng: string }>({ lat: '', lng: '' })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const [sub, map] = await Promise.all([subscriptionAPI.current(), mapSettingsAPI.get()])
      if (sub.success && sub.data) {
        const initial = addressFrom(sub.data.billing)
        setAddress(initial)
        setSavedAddress(initial)
      }
      const data = map.data as { center_lat?: string; center_lng?: string } | undefined
      if (map.success && data) setCenter({ lat: String(data.center_lat ?? ''), lng: String(data.center_lng ?? '') })
      setLoaded(true)
    })()
  }, [])

  const lat = Number(center.lat), lng = Number(center.lng)
  const validPoint = center.lat.trim() !== '' && center.lng.trim() !== ''
    && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

  const save = async () => {
    if (canMap && !validPoint) { toast.error(t('settings.providerAddress.invalid')); return }
    setBusy(true)
    try {
      if (canAddress) {
        const patch: Partial<TenantBilling> = {}
        for (const { chave } of ADDRESS_FIELDS) {
          if ((address[chave] ?? '') !== (savedAddress[chave] ?? '')) patch[chave] = address[chave] ?? ''
        }
        if (Object.keys(patch).length) {
          const res = await tenantAPI.updateBilling(patch)
          if (!res.success || !res.data) { toast.error(res.message || t('billing.saveFailed')); return }
          const fresh = addressFrom(res.data.billing)
          setAddress(fresh)
          setSavedAddress(fresh)
        }
      }
      if (canMap) {
        const current = await mapSettingsAPI.get()
        if (!current.success) { toast.error(current.message || t('settings.saveError')); return }
        const res = await mapSettingsAPI.update({ ...(current.data as object ?? {}), center_lat: String(lat), center_lng: String(lng) })
        if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
      }
      toast.success(t('settings.providerAddress.saved'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modern-card max-w-3xl p-5 sm:p-6">
      <h2 className="section-heading">{t('settings.providerAddress.title')}</h2>
      <p className="section-description mb-6">{t('settings.providerAddress.description')}</p>
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          {ADDRESS_FIELDS.map(({ chave, label, largura, maxLength, inputMode }) => (
            <div key={chave} className={CLASSE_LARGURA[largura]}>
              <label htmlFor={`provider-${chave}`} className="field-label">{t(label)}</label>
              <input
                id={`provider-${chave}`}
                className="modern-input w-full"
                value={address[chave] ?? ''}
                maxLength={maxLength}
                inputMode={inputMode}
                disabled={!canAddress || busy || !loaded}
                onChange={(e) => setAddress((a) => ({ ...a, [chave]: e.target.value }))}
              />
            </div>
          ))}
        </div>

        <div className="border-t border-border pt-5">
          <h3 className="font-semibold">{t('settings.providerAddress.mapLabel')}</h3>
          <p className="field-hint mb-4 mt-1">{t('onboarding.identity.mapHint')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="provider-lat" className="field-label">{t('onboarding.identity.lat')}</label>
              <input id="provider-lat" className="modern-input w-full" inputMode="decimal" disabled={!canMap || busy || !loaded} value={center.lat} onChange={(e) => setCenter((c) => ({ ...c, lat: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="provider-lng" className="field-label">{t('onboarding.identity.lng')}</label>
              <input id="provider-lng" className="modern-input w-full" inputMode="decimal" disabled={!canMap || busy || !loaded} value={center.lng} onChange={(e) => setCenter((c) => ({ ...c, lng: e.target.value }))} />
            </div>
          </div>
          {/* Monta depois da leitura: o seletor só abre no ponto salvo se já o
              recebe na primeira renderização. Sem `map.write`, só mostra. */}
          {loaded && (
            <div className="mt-4">
              <LocationPicker
                lat={center.lat.trim() === '' ? null : lat}
                lng={center.lng.trim() === '' ? null : lng}
                onChange={(la, ln) => { if (canMap) setCenter({ lat: String(la), lng: String(ln) }) }}
              />
            </div>
          )}
        </div>

        <button type="button" className="modern-button" disabled={busy || !loaded} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
