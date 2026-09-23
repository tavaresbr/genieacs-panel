'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppContact, type WhatsAppConversation } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

/** Same pause as the inbox search: one request per word, not per letter. */
const SEARCH_DEBOUNCE_MS = 350
const PAGE = 50

interface ContactsPanelProps {
  /** Called with the thread to show — the page switches to the inbox with it open. */
  onOpenConversation: (conversation: WhatsAppConversation) => void
}

/**
 * The SGP's subscribers as WhatsApp contacts.
 *
 * The inbox only ever knew someone after they wrote in. This is the other
 * direction: look a subscriber up by name, contract, document or number, see
 * whether a thread with them already exists, and open it — or start one.
 * Starting sends nothing; the operator lands in an empty thread and writes.
 */
export function ContactsPanel({ onOpenConversation }: ContactsPanelProps) {
  const { t, intlLocale } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()

  const [contacts, setContacts] = useState<WhatsAppContact[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [openingContract, setOpeningContract] = useState<string | null>(null)

  const alive = useRef(true)
  // The newest request wins: a slow answer for "ben" must not overwrite the
  // answer for "benedita" that arrived first.
  const requestSeq = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const load = useCallback(async (term: string) => {
    const seq = ++requestSeq.current
    setLoading(true)
    const res = await whatsappAPI.listContacts({ search: term || undefined, limit: PAGE })
    if (!alive.current || seq !== requestSeq.current) return
    if (res.success && res.data) {
      setContacts(res.data.contacts)
      setTotal(res.data.total)
      setLoadError('')
    } else {
      setLoadError(whatsappErrorMessage(t, res.code))
    }
    setLoading(false)
  }, [t])

  useEffect(() => { void load(debounced) }, [debounced, load])

  const loadMore = useCallback(async () => {
    const seq = requestSeq.current
    setLoadingMore(true)
    const res = await whatsappAPI.listContacts({
      search: debounced || undefined,
      limit: PAGE,
      offset: contacts.length
    })
    if (!alive.current) return
    setLoadingMore(false)
    if (seq !== requestSeq.current) return
    if (!res.success || !res.data) {
      toast.error(whatsappErrorMessage(t, res.code))
      return
    }
    const page = res.data.contacts
    setContacts((current) => [
      ...current,
      ...page.filter((row) => !current.some((held) => held.contract === row.contract))
    ])
    setTotal(res.data.total)
  }, [contacts.length, debounced, t, toast])

  const open = useCallback(async (contact: WhatsAppContact) => {
    setOpeningContract(contact.contract)
    try {
      const res = await whatsappAPI.openContactConversation(contact.contract)
      if (!alive.current) return
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      onOpenConversation(res.data)
    } catch {
      if (alive.current) toast.error(t('api.requestFailed'))
    } finally {
      if (alive.current) setOpeningContract(null)
    }
  }, [onOpenConversation, t, toast])

  const stamp = (iso: string | null) => {
    if (!iso) return ''
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'short', timeStyle: 'short' }).format(date)
  }

  const canSend = can('whatsapp.send')

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('whatsapp.contacts.title')}</h2>
          <p className="section-description">{t('whatsapp.contacts.subtitle')}</p>
        </div>
        <button
          type="button"
          className="modern-button-secondary shrink-0"
          onClick={() => void load(debounced)}
          disabled={loading}
        >
          <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} />
          {t('common.refresh')}
        </button>
      </header>

      <input
        type="search"
        className="modern-input"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('whatsapp.contacts.searchPlaceholder')}
        aria-label={t('whatsapp.contacts.searchPlaceholder')}
      />

      {loadError && (
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--status-danger))]" role="alert">
          <Icon name="warning" size={16} />
          {loadError}
        </p>
      )}

      <section className="modern-card overflow-hidden">
        {contacts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name={debounced ? 'search' : 'phone'} size={22} /></div>
            <p className="empty-state-title">
              {loading
                ? t('common.loading')
                : t(debounced ? 'whatsapp.contacts.noMatch' : 'whatsapp.contacts.empty')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="modern-table">
              <thead>
                <tr>
                  <th scope="col">{t('whatsapp.inbox.subscriber')}</th>
                  <th scope="col">{t('whatsapp.inbox.contract')}</th>
                  <th scope="col">{t('whatsapp.optOut.phone')}</th>
                  <th scope="col">{t('whatsapp.contacts.lastMessage')}</th>
                  <th scope="col"><span className="sr-only">{t('whatsapp.contacts.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.contract} data-contract={contact.contract}>
                    <td>
                      <span className="block font-semibold">{contact.clientName || '—'}</span>
                      {contact.document && (
                        <span className="text-xs text-muted-foreground">{contact.document}</span>
                      )}
                    </td>
                    <td className="font-mono">{contact.contract}</td>
                    <td>
                      {contact.phone ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono">{contact.phone}</span>
                          {contact.phoneSource === 'manual' && (
                            <span className="modern-badge" title={t('whatsapp.contacts.phoneManualHint')}>
                              {t('whatsapp.contacts.phoneManual')}
                            </span>
                          )}
                          {contact.optedOut && (
                            <span className="modern-badge-warning" title={t('whatsapp.inbox.optedOutHint')}>
                              <Icon name="bell" size={12} />
                              {t('whatsapp.inbox.optedOut')}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t('whatsapp.contacts.noPhone')}</span>
                      )}
                    </td>
                    <td className="text-sm text-muted-foreground">
                      {contact.conversationId ? stamp(contact.lastMessageAt) || '—' : '—'}
                    </td>
                    <td className="text-end">
                      {canSend && (contact.conversationId || contact.phone) && (
                        <button
                          type="button"
                          className={contact.conversationId ? 'modern-button-secondary' : 'modern-button'}
                          disabled={openingContract !== null}
                          onClick={() => void open(contact)}
                        >
                          <Icon
                            name={openingContract === contact.contract ? 'refresh' : 'chat'}
                            size={16}
                            className={openingContract === contact.contract ? 'animate-spin' : ''}
                          />
                          {t(contact.conversationId
                            ? 'whatsapp.contacts.openConversation'
                            : 'whatsapp.contacts.startConversation')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {contacts.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{t('whatsapp.contacts.showing', { shown: contacts.length, total })}</span>
          {contacts.length < total && (
            <button
              type="button"
              className="modern-button-secondary"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {t('whatsapp.contacts.loadMore')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
