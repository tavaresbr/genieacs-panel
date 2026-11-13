import { useCallback, useEffect, useState } from 'react'
import { pushAPI, type PushEvent, type PushPreferences } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { sessionOwner } from '@/lib/session-owner'
import {
  PUSH_EVENT_ORDER,
  currentPushSupport,
  currentSubscription,
  disablePush,
  enablePush,
  type PushSupport,
} from '@/lib/push'
import { promptInstall, usePwa } from '@/lib/pwa'
import type { TranslationKey } from '@/lib/i18n/dictionary'

const EVENT_LABEL: Record<PushEvent, TranslationKey> = {
  invoice: 'settings.push.event.invoice',
  ont_offline: 'settings.push.event.ont_offline',
  mass_outage: 'settings.push.event.mass_outage',
  wa_disconnected: 'settings.push.event.wa_disconnected',
  new_message: 'settings.push.event.new_message',
}

/**
 * "Notificações neste aparelho" (0130): ativar o push neste navegador, mandar
 * um teste, escolher os eventos e instalar o app.
 *
 * Os eventos que aparecem são os que o papel permite (`available`): quem não
 * lê a frota não vê "ONT offline" para ligar. A escolha é da pessoa no
 * provedor, vale para todos os aparelhos dela; ativar é deste aparelho.
 */
export function PushNotificationsCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const pwa = usePwa()
  const { user } = useAuth()
  const [suporte] = useState<PushSupport>(() => currentPushSupport())
  const [ativo, setAtivo] = useState(false)
  const [prefs, setPrefs] = useState<PushPreferences | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const carregar = useCallback(async () => {
    try {
      const res = await pushAPI.preferences()
      if (res.success && res.data) setPrefs(res.data)
    } catch {
      /* sem as preferências o cartão mostra só o botão de ativar */
    }
    if (suporte === 'supported') {
      const sub = await currentSubscription()
      setAtivo(Boolean(sub) && Notification.permission === 'granted')
    }
  }, [suporte])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const ativar = async () => {
    setOcupado(true)
    try {
      const { result, message } = await enablePush(sessionOwner(user))
      if (result === 'enabled') {
        setAtivo(true)
        toast.success(t('settings.push.enabled'))
        await carregar()
      } else if (result === 'denied') {
        toast.error(t('settings.push.denied'))
      } else if (result === 'no-worker') {
        toast.error(t('settings.push.noWorker'))
      } else {
        toast.error(message || t('settings.push.failed'))
      }
    } finally {
      setOcupado(false)
    }
  }

  const desativar = async () => {
    setOcupado(true)
    try {
      await disablePush()
      setAtivo(false)
      toast.success(t('settings.push.disabled'))
      await carregar()
    } finally {
      setOcupado(false)
    }
  }

  const testar = async () => {
    setOcupado(true)
    try {
      const res = await pushAPI.test()
      if (res.success) toast.success(t('settings.push.testSent'))
      else toast.error(res.message || t('settings.push.failed'))
    } finally {
      setOcupado(false)
    }
  }

  const alternar = async (evento: PushEvent, valor: boolean) => {
    if (!prefs) return
    const anterior = prefs
    setPrefs({ ...prefs, events: { ...prefs.events, [evento]: valor } })
    const res = await pushAPI.savePreferences({ [evento]: valor })
    if (res.success && res.data) {
      setPrefs({ ...anterior, events: res.data.events, available: res.data.available })
      toast.success(t('settings.push.saved'))
    } else {
      setPrefs(anterior)
      toast.error(res.message || t('settings.push.failed'))
    }
  }

  const eventos = PUSH_EVENT_ORDER.filter((e) => prefs?.available.includes(e))

  return (
    <section
      className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4"
      data-testid="push-notifications-card"
      aria-labelledby="push-notifications-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="push-notifications-title" className="flex items-center gap-2 font-semibold text-foreground">
            <Icon name="bell" size={18} />
            {t('settings.push.title')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('settings.push.description')}</p>
        </div>
        {suporte === 'supported' && (
          <span className={ativo ? 'modern-badge-success' : 'modern-badge'}>
            {ativo ? t('settings.push.statusOn') : t('settings.push.statusOff')}
          </span>
        )}
      </div>

      {suporte === 'ios-install' && (
        <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-card p-3 text-sm text-foreground" role="note">
          <Icon name="phone" size={18} className="mt-0.5 shrink-0" />
          {t('settings.push.iosHint')}
        </p>
      )}
      {suporte === 'unsupported' && (
        <p className="mt-4 text-sm text-muted-foreground">{t('settings.push.unsupported')}</p>
      )}

      {suporte === 'supported' && (
        <div className="mt-4 flex flex-wrap gap-2">
          {ativo ? (
            <>
              <button type="button" className="modern-button-secondary" disabled={ocupado} onClick={() => void testar()}>
                {t('settings.push.test')}
              </button>
              <button type="button" className="modern-button-secondary" disabled={ocupado} onClick={() => void desativar()}>
                {t('settings.push.disable')}
              </button>
            </>
          ) : (
            <button type="button" className="modern-button" disabled={ocupado} onClick={() => void ativar()}>
              {t('settings.push.enable')}
            </button>
          )}
        </div>
      )}

      {prefs && prefs.devices > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">{t('settings.push.devices', { count: prefs.devices })}</p>
      )}

      {prefs && eventos.length > 0 && (
        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-foreground">{t('settings.push.eventsTitle')}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {eventos.map((evento) => (
              <label key={evento} className="flex min-h-10 items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={prefs.events[evento]}
                  onChange={(e) => void alternar(evento, e.target.checked)}
                />
                {t(EVENT_LABEL[evento])}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {(pwa.canInstall || pwa.standalone) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {pwa.standalone ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="check" size={16} />
              {t('settings.push.installed')}
            </span>
          ) : (
            <>
              <button type="button" className="modern-button-secondary" onClick={() => void promptInstall()}>
                <Icon name="phone" size={16} />
                {t('settings.push.install')}
              </button>
              <span className="text-sm text-muted-foreground">{t('settings.push.installHint')}</span>
            </>
          )}
        </div>
      )}
    </section>
  )
}
