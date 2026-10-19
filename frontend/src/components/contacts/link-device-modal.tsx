import { useEffect, useState } from 'react'
import { devicesAPI, sgpAPI, type DeviceListResponse, type ContactProfileContract } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { Device } from '@/types'

/**
 * Vincula uma ONT a um contrato a partir da lista de contratos do cliente.
 *
 * O caminho inverso do da página da ONT: aqui o contrato já está escolhido e
 * falta achar o equipamento, pelo número de série, pelo modelo ou pelo login
 * PPPoE. A busca já abre com o login do contrato, que é o que costuma achar a
 * ONT certa; a que reporta esse login vem marcada.
 */
export function LinkDeviceModal({
  contract,
  replaceDeviceId,
  onClose,
  onLinked
}: {
  contract: ContactProfileContract
  /** A ONT a trocar: depois de vincular a nova, esta sai do contrato. */
  replaceDeviceId?: string
  onClose: () => void
  onLinked: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [term, setTerm] = useState(contract.login ?? '')
  const [devices, setDevices] = useState<Device[]>([])
  const [searching, setSearching] = useState(false)
  const [linking, setLinking] = useState<string | null>(null)
  const query = term.trim()
  const wantedLogin = (contract.login ?? '').trim().toLowerCase()

  useEffect(() => {
    if (!query) {
      setDevices([])
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      devicesAPI
        .getDevices({ page: 1, pageSize: 10, search: query })
        .then((res) => {
          if (cancelled) return
          const payload = res.success && res.data ? (res.data as DeviceListResponse<Device>) : null
          setDevices(payload?.devices ?? [])
        })
        .catch(() => {
          if (!cancelled) setDevices([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const link = async (deviceId: string) => {
    setLinking(deviceId)
    try {
      const res = await sgpAPI.linkDevice(deviceId, { contract: contract.contract })
      if (!res.success) {
        toast.error(res.message || t('contacts.profile.linkFailed'))
        return
      }
      // A nova entra primeiro: se a troca falhar no meio, o contrato fica com
      // as duas, e nunca com nenhuma.
      if (replaceDeviceId && replaceDeviceId !== deviceId) {
        const removed = await sgpAPI.unlinkDevice(replaceDeviceId)
        if (!removed.success) {
          toast.error(removed.message || t('contacts.profile.unlinkFailed'))
        }
      }
      toast.success(res.message || t('contacts.profile.linked'))
      onLinked()
    } finally {
      setLinking(null)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="link-device-title">
      <div className="modal-panel modern-card max-w-xl p-5 sm:p-6">
        <h2 id="link-device-title" className="section-heading mb-1">
          {t(replaceDeviceId ? 'contacts.profile.swapTitle' : 'contacts.profile.linkTitle', { contract: contract.contract })}
        </h2>
        <p className="section-description mb-4">{t('contacts.profile.linkHint')}</p>
        <input
          type="text"
          className="modern-input w-full"
          placeholder={t('contacts.profile.linkSearch')}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          autoFocus
        />
        <ul className="mt-3 max-h-72 divide-y divide-border overflow-y-auto" role="list">
          {devices.filter((device) => device._id !== replaceDeviceId).map((device) => {
            const matches = wantedLogin !== '' && (device.pppoe ?? '').trim().toLowerCase() === wantedLogin
            return (
              <li key={device._id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="font-mono font-semibold wrap-anywhere">{device.SerialNumber || device._id}</p>
                  <p className="text-xs text-muted-foreground wrap-anywhere">
                    {[device.manufacturer, device.productclass].filter(Boolean).join(' ') || '—'}
                    {device.pppoe ? ` · ${device.pppoe}` : ''}
                    {matches ? ` · ${t('contacts.profile.linkLoginMatch')}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="modern-button shrink-0"
                  disabled={linking !== null}
                  onClick={() => void link(device._id)}
                >
                  {t('contacts.profile.linkAction')}
                </button>
              </li>
            )
          })}
        </ul>
        {query && !searching && devices.length === 0 ? (
          <p className="field-hint mt-2">{t('contacts.profile.linkEmpty')}</p>
        ) : null}
        <div className="mt-5 flex justify-end">
          <button type="button" className="modern-button-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
