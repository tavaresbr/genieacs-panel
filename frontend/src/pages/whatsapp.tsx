'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  whatsappAPI,
  type WhatsAppConversation,
  type WhatsAppMessage
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { ConversationList } from '@/components/whatsapp/conversation-list'
import { ConversationThread } from '@/components/whatsapp/conversation-thread'
import { ThreadComposer, type ComposerAttachment } from '@/components/whatsapp/thread-composer'
import { BillingPanel } from '@/components/whatsapp/billing-panel'
import { CampaignsPanel } from '@/components/whatsapp/campaigns-panel'
import { TemplatesPanel } from '@/components/whatsapp/templates-panel'
import { OptOutPanel } from '@/components/whatsapp/opt-out-panel'
import { AlertsPanel } from '@/components/whatsapp/alerts-panel'
import { HealthStrip } from '@/components/whatsapp/health-strip'

// ─────────────────────────────────────────────────────────────────────────────
// Polling
//
// Two clocks, deliberately far apart.
//
// The LIST at 15 s is the screen's whole freshness promise: an inbound message
// has to raise a badge on a panel nobody has touched since morning. It is a
// read of one batched query, it is what the operator is scanning, and it is
// cheap enough to run all day.
//
// The OPEN THREAD at 45 s — three times slower — for three reasons, in order of
// weight:
//
//   1. `GET /conversations/:id/messages` is a GET that WRITES. Reading a thread
//      zeroes its `unread_count`. Running the expensive, mutating call on the
//      list's cadence would triple a write nobody asked for and race the list
//      poll over the same counter.
//   2. The list poll is already the fast path for the thing that matters. When
//      it sees the open thread's `lastMessageAt` move, it reloads the thread on
//      the spot — so a customer's reply still lands within the list's 15 s, and
//      the thread's own timer is only a backstop.
//   3. What that backstop is actually for is delivery-status promotion —
//      `sent → delivered → read` on messages already drawn. Nobody watches that
//      with a stopwatch, and replacing the message array under a viewport an
//      operator is reading and typing into is the one poll with a visible cost.
//
// The three rules under both are the ones the pairing block already proved:
// single-flight so a slow round trip is never queued behind itself, a hidden
// tab skips the tick entirely (this screen is left open in a background tab for
// hours), and a failing server is backed off `2 ** failures - 1` ticks instead
// of being hammered. Every timer is owned by an effect that clears on unmount —
// an interval that outlived this page would hit the panel forever.
// ─────────────────────────────────────────────────────────────────────────────
const LIST_POLL_MS = 15_000
const THREAD_POLL_MS = 45_000
const BACKOFF_CAP = 6

/**
 * Long enough that a typed name is one request instead of eight, short enough
 * that the list still feels like it is answering the keyboard.
 */
const SEARCH_DEBOUNCE_MS = 350

type ConversationStatus = 'open' | 'closed' | 'all'

/** The three piles, in the order an operator reaches for them. */
const FILTERS = [
  ['open', 'whatsapp.inbox.filterOpen'],
  ['closed', 'whatsapp.inbox.filterClosed'],
  ['all', 'whatsapp.inbox.filterAll']
] as const

/** The API caps the list at 200 and a thread at 500. */
const LIST_LIMIT = 100
const MESSAGE_PAGE = 60

/**
 * The newest page folded into what is already on screen, newest first.
 *
 * Only rows the page does not already carry are kept from `current`, so a
 * message the server has since changed — a delivery status moving from `sent`
 * to `read` — comes back in its new shape rather than pinned to the one this
 * browser first saw.
 */
function mergeNewest(page: WhatsAppMessage[], current: WhatsAppMessage[]): WhatsAppMessage[] {
  if (current.length === 0) return page
  const fresh = new Set(page.map((message) => message.id))
  return [...page, ...current.filter((message) => !fresh.has(message.id))]
    .sort((a, b) => b.id - a.id)
}

/**
 * The operator's WhatsApp inbox: conversations on the left, the open thread and
 * the reply box on the right. The routes it consumes are frozen in
 * `docs/whatsapp-api-contract.md`.
 */
function InboxTab() {
  const { t } = useTranslation()
  const toast = useToast()

  const [conversations, setConversations] = useState<WhatsAppConversation[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [conversation, setConversation] = useState<WhatsAppConversation | null>(null)
  const [messages, setMessages] = useState<WhatsAppMessage[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState<ConversationStatus>('open')

  const [loadingList, setLoadingList] = useState(true)
  const [loadingThread, setLoadingThread] = useState(false)
  const [sending, setSending] = useState(false)
  const [filing, setFiling] = useState(false)
  const [resendingId, setResendingId] = useState<number | null>(null)
  const [listError, setListError] = useState('')

  const alive = useRef(true)
  const listInFlight = useRef(false)
  const listFailures = useRef(0)
  const listBlockedUntil = useRef(0)
  // A filter change that lands while a poll is in flight is dropped by the
  // single-flight guard. Remembering that it was owed, and running it when the
  // call returns, is what keeps the list from showing the previous filter until
  // the next tick fifteen seconds later.
  const listOwed = useRef(false)
  const threadInFlight = useRef(false)
  const threadFailures = useRef(0)
  const threadBlockedUntil = useRef(0)

  // Read by the pollers, which must not be rebuilt — and their intervals with
  // them — every time a selection or a page size changes.
  const selectedIdRef = useRef<number | null>(null)
  const olderInFlight = useRef(false)
  const threadStampRef = useRef<string | null>(null)
  // The filter belongs in a ref for the same reason: a poll must ask for what
  // is on screen now, without the interval being torn down and restarted — and
  // its clock reset — every time the operator types a letter.
  const filterRef = useRef<{ search: string; status: ConversationStatus }>({ search: '', status: 'open' })

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  // One request per pause, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // ── The open thread ────────────────────────────────────────────────────────
  const loadThread = useCallback(async (id: number, silent: boolean) => {
    if (threadInFlight.current) return
    threadInFlight.current = true
    if (!silent) setLoadingThread(true)
    try {
      const res = await whatsappAPI.listMessages(id, { limit: MESSAGE_PAGE })
      if (!alive.current || selectedIdRef.current !== id) return
      if (!res.success || !res.data) {
        threadFailures.current += 1
        threadBlockedUntil.current = Date.now()
          + (2 ** Math.min(threadFailures.current, BACKOFF_CAP) - 1) * THREAD_POLL_MS
        if (!silent) toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      threadFailures.current = 0
      threadBlockedUntil.current = 0
      setConversation(res.data.conversation)
      // Merged, never replaced. This fetches the NEWEST page, and the operator
      // may have paged back through several older ones — replacing would throw
      // away everything they scrolled to, on a 45 s timer they did not ask for.
      const page = res.data.messages
      setMessages((current) => (silent ? mergeNewest(page, current) : page))
      if (!silent) setHasOlder(page.length >= MESSAGE_PAGE)
      threadStampRef.current = res.data.conversation.lastMessageAt

      // Reconciling the badge the server just cleared.
      //
      // That GET zeroed `unread_count` on the server, so every row already in
      // the list is stale the moment this resolves — and the next list poll is
      // up to fifteen seconds away. Leaving a "3 unread" badge on the thread
      // the operator is reading right now is how an inbox stops meaning
      // anything: the count is the only reason to look at a row twice.
      setConversations((rows) => rows.map((row) => (
        row.id === id && row.unreadCount !== 0 ? { ...row, unreadCount: 0 } : row
      )))
    } finally {
      threadInFlight.current = false
      if (!silent) setLoadingThread(false)
    }
  }, [t, toast])

  const loadThreadRef = useRef(loadThread)
  useEffect(() => { loadThreadRef.current = loadThread }, [loadThread])

  // ── The list ───────────────────────────────────────────────────────────────
  const loadList = useCallback(async (initial: boolean) => {
    if (listInFlight.current) {
      listOwed.current = true
      return
    }
    listInFlight.current = true
    try {
      const { search: term, status: pile } = filterRef.current
      const res = await whatsappAPI.listConversations({
        limit: LIST_LIMIT,
        status: pile,
        ...(term ? { search: term } : {})
      })
      if (!alive.current) return
      if (!res.success) {
        listFailures.current += 1
        listBlockedUntil.current = Date.now()
          + (2 ** Math.min(listFailures.current, BACKOFF_CAP) - 1) * LIST_POLL_MS
        // A failing poll stays quiet; only the first load, which has nothing to
        // show behind it, turns into a message on screen.
        if (initial) setListError(whatsappErrorMessage(t, res.code))
        return
      }
      listFailures.current = 0
      listBlockedUntil.current = 0
      setListError('')

      const rows = res.data ?? []
      const openId = selectedIdRef.current
      const open = openId === null ? undefined : rows.find((row) => row.id === openId)

      // The fast path for a customer's reply: the list sees the open thread
      // move before the thread's own 45 s timer does, so it pulls it in.
      if (open && open.lastMessageAt !== threadStampRef.current) {
        void loadThreadRef.current(openId as number, true)
      }

      // The open row's own count is written down as read here too: the server
      // cleared it when the thread was opened, and a row that re-grows a badge
      // for a second on every poll is worse than no badge at all.
      setConversations(openId === null
        ? rows
        : rows.map((row) => (row.id === openId ? { ...row, unreadCount: 0 } : row)))
    } finally {
      listInFlight.current = false
      if (initial) setLoadingList(false)
      if (listOwed.current) {
        listOwed.current = false
        void loadListRef.current(false)
      }
    }
  }, [t])

  const loadListRef = useRef(loadList)
  useEffect(() => { loadListRef.current = loadList }, [loadList])

  useEffect(() => { void loadList(true) }, [loadList])

  // A filter the operator changed is asked for at once rather than waited for.
  // The ref is written here, immediately before the reload it belongs to, so
  // the two can never describe different filters.
  useEffect(() => {
    const next = { search: debouncedSearch, status }
    const shown = filterRef.current
    // Unchanged on the first run, which is what keeps this from doubling the
    // initial load that the effect above already fired.
    if (shown.search === next.search && shown.status === next.status) return
    filterRef.current = next
    void loadListRef.current(false)
  }, [debouncedSearch, status])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() < listBlockedUntil.current) return
      void loadList(false)
    }, LIST_POLL_MS)
    return () => clearInterval(timer)
  }, [loadList])

  // Selecting a thread, or asking for more of it, loads it visibly.
  useEffect(() => {
    if (selectedId === null) return
    void loadThread(selectedId, false)
  }, [selectedId, loadThread])

  // The thread's own clock. It reads the selection from a ref so that switching
  // conversations does not restart the interval.
  useEffect(() => {
    const timer = setInterval(() => {
      const id = selectedIdRef.current
      if (id === null) return
      if (document.visibilityState !== 'visible') return
      if (Date.now() < threadBlockedUntil.current) return
      void loadThreadRef.current(id, true)
    }, THREAD_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const select = useCallback((next: WhatsAppConversation) => {
    if (next.id === selectedIdRef.current) return
    selectedIdRef.current = next.id
    threadStampRef.current = null
    threadFailures.current = 0
    threadBlockedUntil.current = 0
    // The row we already have draws the header while the history is in flight,
    // so the pane never opens blank.
    setConversation(next)
    setMessages([])
    setHasOlder(false)
    setSelectedId(next.id)
  }, [])

  /**
   * One page further back. The cursor is the oldest id on screen, so a customer
   * answering mid-scroll cannot shift the page boundary under the request —
   * which is exactly what an offset would have let happen.
   */
  const loadOlder = useCallback(async () => {
    const id = selectedIdRef.current
    const oldest = messages.at(-1)?.id
    if (id === null || !oldest || olderInFlight.current) return
    olderInFlight.current = true
    setLoadingOlder(true)
    try {
      const res = await whatsappAPI.listMessages(id, { limit: MESSAGE_PAGE, before: oldest })
      if (!alive.current || selectedIdRef.current !== id) return
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      const page = res.data.messages
      setMessages((current) => [
        ...current,
        ...page.filter((message) => !current.some((held) => held.id === message.id))
      ])
      // A short page is the end of the thread. A full one only means there may
      // be more, which is the honest thing for the button to offer.
      setHasOlder(page.length >= MESSAGE_PAGE)
    } finally {
      olderInFlight.current = false
      if (alive.current) setLoadingOlder(false)
    }
  }, [messages, t, toast])

  // ── Filing ─────────────────────────────────────────────────────────────────
  /**
   * Closes the open thread, or takes it back out.
   *
   * The thread stays on screen either way: the operator who just closed it is
   * owed the sight of the state they asked for, and the reopen button next to
   * it. What moves is the LIST — a closed thread leaves the default pile — so
   * the list is asked again rather than patched, since only the server knows
   * whether the row still belongs under the filter on screen.
   */
  const file = useCallback(async (next: 'open' | 'closed') => {
    const id = selectedIdRef.current
    if (id === null) return
    setFiling(true)
    try {
      const res = await whatsappAPI.setConversationStatus(id, next)
      if (!alive.current) return
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      if (selectedIdRef.current === id) setConversation(res.data)
      void loadListRef.current(false)
    } catch {
      if (alive.current) toast.error(t('api.requestFailed'))
    } finally {
      if (alive.current) setFiling(false)
    }
  }, [t, toast])

  // ── Sending ────────────────────────────────────────────────────────────────
  const submit = useCallback(async (
    body: string,
    isNote: boolean,
    attachment?: ComposerAttachment
  ): Promise<boolean> => {
    const id = selectedIdRef.current
    if (id === null) return false
    try {
      // The composer uploads the file first and hands back what the upload
      // route stored; this call is what puts it on a row. A caption is
      // optional, so `body` can be empty as long as there is a file.
      const res = await whatsappAPI.sendMessage(id, { body, attachment, isNote })
      if (!alive.current) return false
      if (!res.success || !res.data) {
        // Only the machine `code` is ever translated. The `message` beside it
        // can carry the Evolution server's own words, and those belong in a log,
        // not in front of an operator.
        toast.error(whatsappErrorMessage(t, res.code), { title: t('whatsapp.inbox.sendFailed') })
        return false
      }
      const created = res.data
      // The route answers with the row it wrote, so this is the real message,
      // not an optimistic stand-in — nothing here can disagree with the server.
      if (selectedIdRef.current === id) setMessages((rows) => [created, ...rows])
      setConversations((rows) => rows.map((row) => (
        row.id === id ? { ...row, lastMessageAt: created.createdAt ?? row.lastMessageAt } : row
      )))
      threadStampRef.current = created.createdAt ?? threadStampRef.current
      return true
    } catch {
      toast.error(t('api.requestFailed'), { title: t('whatsapp.inbox.sendFailed') })
      return false
    }
  }, [t, toast])

  const send = useCallback(async (body: string, isNote: boolean, attachment?: ComposerAttachment) => {
    setSending(true)
    try {
      return await submit(body, isNote, attachment)
    } finally {
      if (alive.current) setSending(false)
    }
  }, [submit])

  /**
   * A failed message is out of the worker's reach for good — three attempts
   * spent, `failed` is terminal. Resending queues the same words as a new row
   * rather than resurrecting the old one, which keeps the record of what did
   * not go out intact. A note is never offered this: it was never going out.
   */
  const resend = useCallback(async (message: WhatsAppMessage) => {
    if (!message.body) return
    setResendingId(message.id)
    try {
      await submit(message.body, false)
    } finally {
      if (alive.current) setResendingId(null)
    }
  }, [submit])

  const unreadTotal = conversations.reduce((sum, row) => sum + row.unreadCount, 0)

  return (
    <section className="space-y-5">
      <div>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="section-heading">{t('whatsapp.inbox.title')}</h2>
            <p className="section-description">{t('whatsapp.inbox.subtitle')}</p>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            {unreadTotal > 0 && (
              <span className="modern-badge-success">{t('whatsapp.inbox.unread', { count: unreadTotal })}</span>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t('common.refresh')}
              onClick={() => {
                void loadList(false)
                const id = selectedIdRef.current
                if (id !== null) void loadThreadRef.current(id, true)
              }}
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>
        </header>

        {listError ? (
          <section className="modern-card empty-state" role="alert">
            <div className="empty-state-icon text-[hsl(var(--status-danger))]"><Icon name="warning" size={22} /></div>
            <h2 className="empty-state-title">{t('common.error')}</h2>
            <p className="empty-state-copy">{listError}</p>
            <button type="button" className="modern-button mt-5" onClick={() => void loadList(true)}>
              {t('common.retry')}
            </button>
          </section>
        ) : (
          <section className="modern-card grid h-[calc(100vh-16rem)] min-h-[32rem] grid-cols-1 overflow-hidden lg:grid-cols-[minmax(17rem,22rem)_1fr]">
            <div className="flex min-h-0 flex-col border-border lg:border-r">
              <div className="space-y-2 border-b border-border px-3 py-3">
                <input
                  type="search"
                  className="modern-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('whatsapp.inbox.searchPlaceholder')}
                  aria-label={t('whatsapp.inbox.searchPlaceholder')}
                />
                <div className="tab-rail" role="tablist" aria-label={t('whatsapp.inbox.title')}>
                  {FILTERS.map(([id, labelKey]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setStatus(id)}
                      className="tab-button"
                      data-active={status === id}
                      role="tab"
                      aria-selected={status === id}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {loadingList
                  ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
                  : (
                    <ConversationList
                      conversations={conversations}
                      selectedId={selectedId}
                      onSelect={select}
                      // An empty list under a search term is a different fact
                      // from an empty inbox, and only one of the two is worth
                      // clearing the box for.
                      filtered={debouncedSearch !== '' || status !== 'open'}
                    />
                  )}
              </div>
            </div>

            <div className="flex min-h-0 flex-col">
              {conversation ? (
                <>
                  <ConversationThread
                    conversation={conversation}
                    messages={messages}
                    loading={loadingThread}
                    canLoadMore={hasOlder && !loadingOlder}
                    onLoadMore={() => void loadOlder()}
                    onResend={(message) => void resend(message)}
                    resendingId={resendingId}
                    filing={filing}
                    onFile={(next) => void file(next)}
                  />
                  <ThreadComposer optedOut={conversation.optedOut} sending={sending} onSend={send} />
                </>
              ) : (
                <div className="empty-state flex-1">
                  <div className="empty-state-icon"><Icon name="chat" size={22} /></div>
                  <p className="empty-state-title">{t('whatsapp.inbox.selectOne')}</p>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </section>
  )
}

/** The tabs, in the order an operator meets them. */
const TABS = [
  ['inbox', 'whatsapp.inbox.title'],
  ['billing', 'whatsapp.billing.title'],
  ['campaigns', 'whatsapp.broadcast.title'],
  ['templates', 'whatsapp.templates.title'],
  ['optOut', 'whatsapp.optOut.title'],
  ['alerts', 'whatsapp.alerts.title']
] as const

type TabId = (typeof TABS)[number][0]

/**
 * Everything the operator does with WhatsApp, behind one route.
 *
 * Only the open tab is mounted. That is not a rendering nicety: four of these
 * panels poll, and a mounted-but-hidden inbox would keep asking the panel for
 * conversations — and keep zeroing unread counts — from a screen nobody is
 * looking at. Switching tabs unmounts the old one and its effects clear their
 * own timers.
 *
 * The connection and the global settings are NOT here. They live under
 * Settings, because pairing a number is something an admin does once and this
 * page is where the work happens afterwards.
 */
export default function WhatsAppPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabId>('inbox')

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">{t('sidebar.nav.whatsapp')}</p>
            <h1 className="page-title">{t('sidebar.nav.whatsapp')}</h1>
            <p className="page-description">{t('sidebar.nav.whatsappDescription')}</p>
          </div>
        </header>

        {/*
          Above the rail, and outside the tab switch, on purpose. It is the
          first thing an operator sees on this route, and it must keep
          answering "is this working?" whichever tab they are working in —
          mounted inside one of them, the integration would go dark the moment
          somebody opened Campaigns.
        */}
        <HealthStrip />

        <div className="tab-rail" role="tablist" aria-label={t('sidebar.nav.whatsapp')}>
          {TABS.map(([id, labelKey]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className="tab-button"
              data-active={tab === id}
              role="tab"
              aria-selected={tab === id}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {tab === 'inbox' && <InboxTab />}
        {tab === 'billing' && <BillingPanel />}
        {tab === 'campaigns' && <CampaignsPanel />}
        {tab === 'templates' && <TemplatesPanel />}
        {tab === 'optOut' && <OptOutPanel />}
        {tab === 'alerts' && <AlertsPanel />}
      </div>
    </div>
  )
}
