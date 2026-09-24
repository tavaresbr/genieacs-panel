'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { contactsAPI, whatsappAPI, type WhatsAppContact, type WhatsAppContactState, type WhatsAppConversation } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { SGP_CONTACTS_HREF } from '@/components/settings/sgp-contacts-sync-panel'

/** Same pause as the inbox search: one request per word, not per letter. */
const SEARCH_DEBOUNCE_MS = 350
const PAGE = 50

/**
 * The status filter, in the order an operator reaches for it. `none` is a
 * client the SGP has with no contract at all, which the full sync brings in.
 */
const STATE_FILTERS = [
  ['', 'whatsapp.contacts.filterAll'],
  ['active', 'whatsapp.contacts.filterActive'],
  ['blocked', 'whatsapp.contacts.filterBlocked'],
  ['cancelled', 'whatsapp.contacts.filterCancelled'],
  ['none', 'whatsapp.contacts.filterNoContract']
] as const

type StateFilter = (typeof STATE_FILTERS)[number][0]

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
  // What the SGP answered for a CPF/CNPJ or contract. While set, it is what the
  // table shows — the panel's own directory comes back when the search changes.
  const [sgpResult, setSgpResult] = useState<{ term: string; contacts: WhatsAppContact[] } | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [stateFilter, setStateFilter] = useState<StateFilter>('')

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

  /**
   * Asks the SGP for what the panel's directory does not have: a subscriber
   * with no ONT here. The SGP answers by CPF/CNPJ or contract only, never by
   * name, and the button says so.
   */
  const lookupSgp = useCallback(async () => {
    const term = search.trim()
    if (!term) return
    setLookingUp(true)
    try {
      const res = await whatsappAPI.lookupContacts(term)
      if (!alive.current) return
      if (!res.success || !res.data) {
        // The server's own sentence: an SGP refusal ("integration off",
        // "unreachable") is already translated there, and a generic failure
        // would hide which one it was.
        toast.error(res.message || whatsappErrorMessage(t, res.code))
        return
      }
      setSgpResult({ term, contacts: res.data.contacts })
    } catch {
      if (alive.current) toast.error(t('api.requestFailed'))
    } finally {
      if (alive.current) setLookingUp(false)
    }
  }, [search, t, toast])

  const load = useCallback(async (term: string, state: StateFilter) => {
    const seq = ++requestSeq.current
    setLoading(true)
    const res = await whatsappAPI.listContacts({
      search: term || undefined,
      limit: PAGE,
      state: (state || undefined) as WhatsAppContactState | undefined
    })
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

  useEffect(() => { void load(debounced, stateFilter) }, [debounced, stateFilter, load])

  const loadMore = useCallback(async () => {
    const seq = requestSeq.current
    setLoadingMore(true)
    const res = await whatsappAPI.listContacts({
      search: debounced || undefined,
      limit: PAGE,
      offset: contacts.length,
      state: (stateFilter || undefined) as WhatsAppContactState | undefined
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
      ...page.filter((row) => !current.some((held) => held.key === row.key))
    ])
    setTotal(res.data.total)
  }, [contacts.length, debounced, stateFilter, t, toast])

  const open = useCallback(async (contact: WhatsAppContact) => {
    setOpeningContract(contact.key)
    try {
      const res = await whatsappAPI.openContactConversation(contact.key)
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
  const canOpenProfile = can('contacts.read')
  const canCreate = can('contacts.edit')
  const [creating, setCreating] = useState(false)
  const canLookup = can('sgp.read')
  const shown = sgpResult ? sgpResult.contacts : contacts

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('whatsapp.contacts.title')}</h2>
          <p className="section-description">{t('whatsapp.contacts.subtitle')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canCreate && (
            <button type="button" className="modern-button" onClick={() => setCreating(true)}>
              <Icon name="contacts" size={16} />
              {t('contacts.profile.new')}
            </button>
          )}
          <button
            type="button"
            className="modern-button-secondary"
            onClick={() => void load(debounced, stateFilter)}
            disabled={loading}
          >
            <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </header>
      {creating && <NewContactModal onClose={() => setCreating(false)} />}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          if (canLookup) void lookupSgp()
        }}
      >
        <input
          type="search"
          className="modern-input flex-1"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setSgpResult(null)
          }}
          placeholder={t('whatsapp.contacts.searchPlaceholder')}
          aria-label={t('whatsapp.contacts.searchPlaceholder')}
        />
        {canLookup && (
          <button
            type="submit"
            className="modern-button-secondary shrink-0"
            disabled={!search.trim() || lookingUp}
            title={t('whatsapp.contacts.lookupHint')}
          >
            <Icon name={lookingUp ? 'refresh' : 'search'} size={16} className={lookingUp ? 'animate-spin' : ''} />
            {t('whatsapp.contacts.lookup')}
          </button>
        )}
      </form>

      {!sgpResult && (
        <div className="tab-rail" role="tablist" aria-label={t('whatsapp.contacts.title')}>
          {STATE_FILTERS.map(([id, labelKey]) => (
            <button
              key={id || 'all'}
              type="button"
              className="tab-button"
              data-active={stateFilter === id}
              role="tab"
              aria-selected={stateFilter === id}
              onClick={() => setStateFilter(id)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}

      {sgpResult && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span>{t('whatsapp.contacts.lookupResult', { term: sgpResult.term, count: sgpResult.contacts.length })}</span>
          <button type="button" className="modern-button-secondary" onClick={() => setSgpResult(null)}>
            {t('whatsapp.contacts.lookupBack')}
          </button>
        </div>
      )}

      {loadError && (
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--status-danger))]" role="alert">
          <Icon name="warning" size={16} />
          {loadError}
        </p>
      )}

      <section className="modern-card overflow-hidden">
        {shown.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name={debounced || sgpResult ? 'search' : 'phone'} size={22} /></div>
            <p className="empty-state-title">
              {sgpResult
                ? t('whatsapp.contacts.lookupNone')
                : loading
                  ? t('common.loading')
                  : t(debounced ? 'whatsapp.contacts.noMatch' : 'whatsapp.contacts.empty')}
            </p>
            {!sgpResult && !loading && canLookup && (
              <p className="empty-state-copy">{t('whatsapp.contacts.lookupHint')}</p>
            )}
            {!sgpResult && !loading && !debounced && !stateFilter && can('sgp.config') && (
              <>
                <p className="empty-state-copy">{t('whatsapp.contacts.syncHint')}</p>
                <Link to={SGP_CONTACTS_HREF} className="modern-button-secondary mt-4">
                  <Icon name="settings" size={16} />
                  {t('settings.whatsapp.sgpContacts.open')}
                </Link>
              </>
            )}
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
                {shown.map((contact) => (
                  <tr key={contact.key} data-contract={contact.contract ?? ''}>
                    <td>
                      {canOpenProfile ? (
                        <Link
                          to={`/contacts/${encodeURIComponent(contact.key)}`}
                          className="block font-semibold hover:text-primary hover:underline"
                        >
                          {contact.clientName || '—'}
                        </Link>
                      ) : (
                        <span className="block font-semibold">{contact.clientName || '—'}</span>
                      )}
                      <span className="flex flex-wrap items-center gap-1.5">
                        {contact.document && (
                          <span className="text-xs text-muted-foreground">{contact.document}</span>
                        )}
                        {!contact.hasDevice && (
                          <span className="modern-badge" title={t('whatsapp.contacts.noDeviceHint')}>
                            {t('whatsapp.contacts.noDevice')}
                          </span>
                        )}
                        {contact.state === 'blocked' && (
                          <span className="modern-badge-warning">{t('whatsapp.contacts.stateBlocked')}</span>
                        )}
                        {contact.state === 'cancelled' && (
                          <span className="modern-badge-error">{t('whatsapp.contacts.stateCancelled')}</span>
                        )}
                      </span>
                    </td>
                    <td className="font-mono">
                      {contact.contract ?? <span className="font-sans text-muted-foreground">{t('whatsapp.contacts.noContract')}</span>}
                    </td>
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
                            name={openingContract === contact.key ? 'refresh' : 'chat'}
                            size={16}
                            className={openingContract === contact.key ? 'animate-spin' : ''}
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

      {!sgpResult && contacts.length > 0 && (
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

/** A client with no SGP behind it: the name is enough, the rest goes in the record after. */
function NewContactModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', document: '', whatsappPhone: '' })
  const [saving, setSaving] = useState(false)

  const create = async () => {
    setSaving(true)
    const res = await contactsAPI.create({
      name: form.name.trim(),
      ...(form.document.trim() ? { document: form.document.trim() } : {}),
      ...(form.whatsappPhone.trim() ? { whatsappPhone: form.whatsappPhone.trim() } : {})
    })
    setSaving(false)
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.profile.saveFailed'))
      return
    }
    toast.success(t('contacts.profile.created'))
    navigate(`/contacts/${encodeURIComponent(res.data.key)}`)
  }

  return (
    <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="new-contact-title">
      <div className="modern-card w-full max-w-md p-5 sm:p-6">
        <h2 id="new-contact-title" className="section-heading mb-1">{t('contacts.profile.new')}</h2>
        <p className="section-description mb-5">{t('contacts.profile.newHint')}</p>
        <div className="grid gap-4">
          {([
            ['name', 'contacts.profile.name'],
            ['document', 'contacts.profile.document'],
            ['whatsappPhone', 'contacts.profile.whatsappPhone']
          ] as const).map(([field, labelKey]) => (
            <div key={field}>
              <label className="field-label" htmlFor={`new-contact-${field}`}>{t(labelKey)}</label>
              <input
                id={`new-contact-${field}`}
                className="modern-input"
                value={form[field]}
                onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" disabled={saving || !form.name.trim()} onClick={() => void create()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
