'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppOptOut } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

/**
 * What to call the entry.
 *
 * The phone is what the campaign asks about, so it leads. A row that only ever
 * had a LID — someone who wrote in from an account WhatsApp gave us no number
 * for — still has to be revocable, so the chain never ends empty.
 */
function optOutAddress(entry: WhatsAppOptOut): string {
  return entry.waPhoneE164 || entry.waLid || `#${entry.id}`
}

/**
 * The list of people the provider must not open a conversation with.
 *
 * Self-contained: it owns its own fetch, its own form and its own refusals.
 */
export function OptOutPanel() {
  const { t, intlLocale } = useTranslation()
  const toast = useToast()

  const [entries, setEntries] = useState<WhatsAppOptOut[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const [revokingId, setRevokingId] = useState<number | null>(null)

  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const res = await whatsappAPI.listOptOuts()
    if (!alive.current) return
    if (res.success && Array.isArray(res.data)) {
      setEntries(res.data)
      setLoadError('')
    } else {
      setLoadError(whatsappErrorMessage(t, res.code))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const stamp = useCallback(
    (iso: string | null) => {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'short', timeStyle: 'short' }).format(date)
    },
    [intlLocale]
  )

  const add = useCallback(async () => {
    const typed = phone.trim()
    if (!typed) return
    setAdding(true)
    setAddError('')
    // The number is normalised by the SERVER, not here: the campaign asks in
    // the normalised form, and a second normaliser in the browser is a second
    // thing to drift. What comes back is what was stored.
    const res = await whatsappAPI.createOptOut({
      phone: typed,
      reasonText: reason.trim() || undefined
    })
    if (!alive.current) return
    setAdding(false)
    if (!res.success) {
      const message = whatsappErrorMessage(t, res.code)
      setAddError(message)
      toast.error(message)
      return
    }
    setPhone('')
    setReason('')
    toast.success(t('common.success'))
    await load()
  }, [load, phone, reason, t, toast])

  const revoke = useCallback(
    async (entry: WhatsAppOptOut) => {
      // A confirm, because the outcome is not "a row disappears": it is that
      // the provider may again START a conversation with somebody who asked for
      // silence. That is the sentence the dialog says out loud.
      if (!window.confirm(t('whatsapp.optOut.confirmRevoke', { phone: optOutAddress(entry) }))) return
      setRevokingId(entry.id)
      const res = await whatsappAPI.revokeOptOut(entry.id)
      if (!alive.current) return
      setRevokingId(null)
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      toast.success(t('common.success'))
      await load()
    },
    [load, t, toast]
  )

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('whatsapp.optOut.title')}</h2>
          <p className="section-description">{t('whatsapp.optOut.description')}</p>
        </div>
        <button
          type="button"
          className="modern-button-secondary shrink-0"
          onClick={() => void load()}
          disabled={loading}
        >
          <Icon name="refresh" size={16} />
          {t('common.refresh')}
        </button>
      </header>

      <form
        className="modern-card flex flex-col gap-4 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="wa-optout-phone">
              {t('whatsapp.optOut.phone')}
            </label>
            <input
              id="wa-optout-phone"
              className="modern-input font-mono"
              value={phone}
              inputMode="tel"
              autoComplete="off"
              onChange={(event) => {
                setPhone(event.target.value)
                setAddError('')
              }}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="wa-optout-reason">
              {t('whatsapp.optOut.reason')}
            </label>
            <input
              id="wa-optout-reason"
              className="modern-input"
              value={reason}
              autoComplete="off"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>

        {addError && (
          <p className="flex items-start gap-2 rounded-md border border-[hsl(var(--status-danger)/0.3)] bg-[hsl(var(--status-danger)/0.08)] p-3 text-xs leading-5 text-[hsl(var(--status-danger))]">
            <Icon name="warning" size={16} />
            <span>{addError}</span>
          </p>
        )}

        <div>
          <button type="submit" className="modern-button" disabled={!phone.trim() || adding}>
            <Icon name="bell" size={16} />
            {t('whatsapp.optOut.add')}
          </button>
        </div>
      </form>

      {loadError && (
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--status-danger))]">
          <Icon name="warning" size={16} />
          {loadError}
        </p>
      )}

      {loading && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : entries.length === 0 ? (
        <div className="modern-card">
          <div className="empty-state">
            <div className="empty-state-icon">
              <Icon name="bell" size={22} />
            </div>
            <p className="empty-state-title">{t('whatsapp.optOut.empty')}</p>
          </div>
        </div>
      ) : (
        <ul className="modern-card divide-y divide-border" role="list">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-sm font-semibold text-foreground">
                    {optOutAddress(entry)}
                  </span>
                  {/* Who put them here changes what revoking means: a customer
                      who wrote "PARAR" asked for this themselves. */}
                  <span className={entry.origin === 'customer' ? 'modern-badge-warning' : 'modern-badge'}>
                    <Icon name={entry.origin === 'customer' ? 'chat' : 'settings'} size={12} />
                    {t(entry.origin === 'customer' ? 'whatsapp.optOut.originCustomer' : 'whatsapp.optOut.originOperator')}
                  </span>
                </div>
                {entry.reasonText && (
                  <p className="mt-1.5 break-words text-sm leading-5 text-muted-foreground">{entry.reasonText}</p>
                )}
                {entry.createdAt && (
                  <p className="mt-1.5 font-mono text-[0.68rem] tabular-nums text-muted-foreground">
                    {stamp(entry.createdAt)}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="modern-button-secondary shrink-0"
                onClick={() => void revoke(entry)}
                disabled={revokingId === entry.id}
              >
                <Icon name="x" size={16} />
                {t('whatsapp.optOut.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
