'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  whatsappAPI,
  type WhatsAppAccount,
  type WhatsAppConversation,
  type WhatsAppMessage
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { ConversationList } from '@/components/whatsapp/conversation-list'
import { ConversationThread } from '@/components/whatsapp/conversation-thread'
import { SubscriberPanel } from '@/components/whatsapp/subscriber-panel'
import { ThreadComposer, type ComposerAttachment } from '@/components/whatsapp/thread-composer'
import { BillingPanel } from '@/components/whatsapp/billing-panel'
import { CampaignsPanel } from '@/components/whatsapp/campaigns-panel'
import { TemplatesPanel } from '@/components/whatsapp/templates-panel'
import { OptOutPanel } from '@/components/whatsapp/opt-out-panel'
import { AlertsPanel } from '@/components/whatsapp/alerts-panel'
import { ContactsPanel } from '@/components/whatsapp/contacts-panel'
import { HealthStrip } from '@/components/whatsapp/health-strip'
import { useAuth } from '@/contexts/auth-context'
import { useLocation } from 'react-router'

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
/** Where the operator's choice to keep the SGP module open is remembered. */
const SGP_PANEL_KEY = 'whatsapp.sgpPanelOpen'

/**
 * Open by default only where it fits beside the thread. Below xl it is a drawer
 * over the conversation, and one that opens by itself on every thread would
 * hide what the operator came to read.
 */
function readPanelPreference(): boolean {
  let wide: boolean
  try {
    wide = window.matchMedia('(min-width: 1280px)').matches
  } catch {
    wide = false
  }
  try {
    const stored = window.localStorage.getItem(SGP_PANEL_KEY)
    return stored === null ? wide : stored === '1'
  } catch {
    return wide
  }
}

interface InboxTabProps {
  /**
   * A thread to open on arrival — the one the Contacts tab just opened or
   * started. Drawn from this row while its history loads, like a click.
   */
  initialConversation?: WhatsAppConversation | null
}

function InboxTab({ initialConversation = null }: InboxTabProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const { can } = useAuth()
  // The module reads the ERP, so it is there only for whoever may read it;
  // an inbox-only operator keeps the two-column screen they had.
  const canSeeSgp = can('sgp.read')
  const [sgpPanelOpen, setSgpPanelOpen] = useState(readPanelPreference)
  const toggleSgpPanel = useCallback(() => {
    setSgpPanelOpen((open) => {
      try {
        window.localStorage.setItem(SGP_PANEL_KEY, open ? '0' : '1')
      } catch {
        // A browser that will not store it just forgets it on reload.
      }
      return !open
    })
  }, [])
  const showSgpPanel = canSeeSgp && sgpPanelOpen
  // What the SGP module hands the reply box — the second copy's text.
  const [draft, setDraft] = useState<{ id: number; text: string } | null>(null)

  const [conversations, setConversations] = useState<WhatsAppConversation[]>([])
  // Os números do provedor, para cada conversa dizer por qual deles chegou.
  // Lidos uma vez: número novo é raro, e entra na próxima abertura da tela.
  const [accounts, setAccounts] = useState<ReadonlyMap<number, WhatsAppAccount>>(() => new Map())
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
  // Nasce vazia e é preenchida no efeito abaixo: `loadList` a lê no próprio
  // corpo, então ela tem de existir antes dele.
  const loadListRef = useRef<((initial: boolean) => Promise<void>) | null>(null)
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
        void loadListRef.current?.(false)
      }
    }
  }, [t])

  useEffect(() => { loadListRef.current = loadList }, [loadList])

  useEffect(() => { void loadList(true) }, [loadList])

  // Falhar aqui não derruba a caixa: sem os números, as conversas aparecem sem
  // cor, como antes de existir cor. Por isso nem toast — a caixa funciona.
  useEffect(() => {
    let vivo = true
    void whatsappAPI.listAccounts().then((res) => {
      if (!vivo || !res.success || !Array.isArray(res.data)) return
      setAccounts(new Map(res.data.map((account) => [account.id, account])))
    }).catch(() => {})
    return () => { vivo = false }
  }, [])

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
    void loadListRef.current?.(false)
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

  // Arriving from Contacts with a thread in hand. Opened once, on mount — the
  // page remounts this tab for every thread it hands over.
  useEffect(() => {
    if (initialConversation) select(initialConversation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * The operator linked the open thread to a subscriber by hand: the header
   * shows the contract at once, and the list is asked again so the row's
   * name follows.
   */
  const linked = useCallback((next: WhatsAppConversation) => {
    if (selectedIdRef.current === next.id) setConversation(next)
    setConversations((rows) => rows.map((row) => (row.id === next.id ? { ...row, ...next } : row)))
    void loadListRef.current?.(false)
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
      void loadListRef.current?.(false)
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
   * Puts a failed message back in the queue — the SAME row, not a copy.
   *
   * This used to read `message.body` and call `submit`, which posted a new
   * message: the failed row stayed on screen, the subscriber got the same
   * notice twice, and a message whose content was an attachment could not be
   * resent at all, because there was no body to read and the button returned
   * without a word. `requeueMessage` moves the row itself back to `queued`, so
   * the id, the file and the place in the thread survive.
   *
   * The row is replaced where it stands rather than prepended: it is the same
   * message, and moving it to the foot of the thread would misdate it.
   */
  const resend = useCallback(async (message: WhatsAppMessage) => {
    setResendingId(message.id)
    try {
      const res = await whatsappAPI.requeueMessage(message.id)
      if (!alive.current) return
      if (!res.success || !res.data) {
        // The route's `message` and not only its `code`: unlike a send, whose
        // text can be the Evolution server's own words, every refusal here is
        // the panel's own sentence, already translated by `req.t`. "Only a
        // message that failed can be sent again" is worth more to the operator
        // who just lost a race with a colleague than "the request failed".
        toast.error(
          res.message || whatsappErrorMessage(t, res.code),
          { title: t('whatsapp.inbox.resendFailedTitle') }
        )
        return
      }
      const requeued = res.data
      setMessages((rows) => rows.map((row) => (row.id === requeued.id ? requeued : row)))
    } catch {
      if (alive.current) {
        toast.error(t('api.requestFailed'), { title: t('whatsapp.inbox.resendFailedTitle') })
      }
    } finally {
      if (alive.current) setResendingId(null)
    }
  }, [t, toast])

  const unreadTotal = conversations.reduce((sum, row) => sum + row.unreadCount, 0)

  return (
    <section className="space-y-5">
      <div>
        {/* Sem título próprio: a aba ativa já diz "Conversas", e um segundo
            título aqui era uma faixa inteira repetindo o nome dela. O contador
            e o atualizar moram agora no topo da lista, onde se usam. */}
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
          // A altura desconta o que fica acima e abaixo da caixa em tela
          // larga: o respiro da página em cima e embaixo, a linha do título e
          // as abas — medido num print, 10,5rem. Era 16rem para um topo de
          // cinco camadas, e o topo novo deixava a caixa curta; um topo que
          // voltar a crescer faz a página rolar, que é o que este número evita.
          <section
            className={`modern-card grid h-[calc(100vh-10.5rem)] min-h-[32rem] grid-cols-1 overflow-hidden lg:grid-cols-[minmax(17rem,22rem)_1fr] ${
              showSgpPanel && conversation ? 'xl:grid-cols-[minmax(16rem,20rem)_1fr_minmax(18rem,22rem)]' : ''
            }`}
          >
            <div className="flex min-h-0 flex-col border-border lg:border-e">
              <div className="space-y-2 border-b border-border px-3 py-3">
                <div className="flex items-center gap-2">
                  <input
                    type="search"
                    className="modern-input"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('whatsapp.inbox.searchPlaceholder')}
                    aria-label={t('whatsapp.inbox.searchPlaceholder')}
                  />
                  <button
                    type="button"
                    className="icon-button shrink-0"
                    aria-label={t('common.refresh')}
                    title={t('common.refresh')}
                    onClick={() => {
                      void loadList(false)
                      const id = selectedIdRef.current
                      if (id !== null) void loadThreadRef.current(id, true)
                    }}
                  >
                    <Icon name="refresh" size={18} />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <div className="tab-rail min-w-0 flex-1" role="tablist" aria-label={t('whatsapp.inbox.title')}>
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
                  {unreadTotal > 0 && (
                    <span className="modern-badge-success shrink-0">{t('whatsapp.inbox.unread', { count: unreadTotal })}</span>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {loadingList
                  ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
                  : (
                    <ConversationList
                      conversations={conversations}
                      accounts={accounts}
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
                    accounts={accounts}
                    messages={messages}
                    loading={loadingThread}
                    canLoadMore={hasOlder && !loadingOlder}
                    onLoadMore={() => void loadOlder()}
                    onResend={(message) => void resend(message)}
                    resendingId={resendingId}
                    filing={filing}
                    onFile={(next) => void file(next)}
                    sgpPanelOpen={canSeeSgp ? showSgpPanel : undefined}
                    onToggleSgpPanel={canSeeSgp ? toggleSgpPanel : undefined}
                    onLinked={linked}
                  />
                  <ThreadComposer optedOut={conversation.optedOut} sending={sending} onSend={send} draft={draft} />
                </>
              ) : (
                <div className="empty-state flex-1">
                  <div className="empty-state-icon"><Icon name="chat" size={22} /></div>
                  <p className="empty-state-title">{t('whatsapp.inbox.selectOne')}</p>
                </div>
              )}
            </div>

            {/* Beside the thread from xl up. Narrower, a third column would
                squeeze the conversation, so it is a drawer over it instead —
                above the mobile top bar (z 1200), whose height would otherwise
                hide the drawer's own close button, and below the navigation
                menu (z 2000). */}
            {showSgpPanel && conversation && (
              <div className="fixed inset-y-0 end-0 z-[1500] w-[min(22rem,100vw)] border-s border-border shadow-xl xl:static xl:z-auto xl:h-full xl:min-h-0 xl:w-auto xl:shadow-none">
                <SubscriberPanel
                  conversationId={conversation.id}
                  boundContract={conversation.contract}
                  onClose={toggleSgpPanel}
                  onDraft={(text) => setDraft((current) => ({ id: (current?.id ?? 0) + 1, text }))}
                  onBound={() => {
                    void loadList(false)
                    void loadThreadRef.current(conversation.id, true)
                  }}
                />
              </div>
            )}
          </section>
        )}
      </div>
    </section>
  )
}

/**
 * "Delete the old attachments now", under the health strip.
 *
 * `POST /whatsapp/media/sweep` has existed since the attachment retention
 * landed and had no screen: the policy was set in Settings and then applied
 * only by a six-hour timer, so an operator whose disk was full today had
 * nothing to press. This is that button, and it takes no parameters — the
 * window and the rules come from the saved settings, so pressing it can never
 * remove more than the settings screen already says it will.
 *
 * It sits BESIDE the strip rather than inside it. The strip is a poll surface
 * that refreshes itself every sixty seconds and renders nothing at all while
 * it is loading or failing; a destructive action that disappears under the
 * operator's cursor when a poll fails is not a button. Keeping it out here also
 * keeps the strip's own rule intact: that component only ever counts.
 *
 * Admin-only, because the route is. A viewer who could press it would get a
 * 403 and no way to tell that from the sweep having failed.
 *
 * The whole point of the reporting below is `skipped`. "0 files" is a real and
 * common answer with at least four different causes, and an operator staring
 * at a full disk reads an unexplained zero as a broken button — so retention
 * being off, a pass already running, a failure, and genuinely nothing old
 * enough each get their own sentence.
 */
function MediaSweepButton() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [sweeping, setSweeping] = useState(false)

  // `whatsapp.config` e não `whatsapp.send`, como a rota: esta é a única ação
  // da integração que APAGA arquivo, e o plantão que responde a assinante não
  // aplica política de retenção.
  if (!can('whatsapp.config')) return null

  const sweep = async () => {
    setSweeping(true)
    try {
      const res = await whatsappAPI.sweepMedia()
      if (!res.success || !res.data) {
        toast.error(t('whatsapp.health.sweepFailed'))
        return
      }
      const { skipped, files, mb } = res.data
      // Retention off is the one answer that is not a failure and not a
      // no-op worth apologising for: it is the configured state, and the
      // message says where to change it.
      if (skipped === 'disabled') {
        toast.info(t('whatsapp.health.sweepOff'))
        return
      }
      if (skipped === 'busy') {
        toast.info(t('whatsapp.health.sweepBusy'))
        return
      }
      // `failed`, `no_provider` and `unscoped` are three different bugs and one
      // operator sentence. None of them is something the person at the panel
      // can act on differently, and the server log already tells them apart for
      // whoever can.
      if (skipped) {
        toast.error(t('whatsapp.health.sweepFailed'))
        return
      }
      if (!files) {
        toast.info(t('whatsapp.health.sweepNothing'))
        return
      }
      toast.success(t('whatsapp.health.sweepDone', { files, mb }))
    } catch {
      toast.error(t('whatsapp.health.sweepFailed'))
    } finally {
      setSweeping(false)
    }
  }

  return (
    <button
      type="button"
      className="modern-button-secondary min-h-9 px-3 py-1 text-xs"
      disabled={sweeping}
      onClick={() => void sweep()}
    >
      <Icon name="trash" size={14} />
      {t('whatsapp.health.sweepNow')}
    </button>
  )
}

/**
 * The window the bulk requeue asks for, and the one the route will give.
 *
 * The backend clamps `hours` to the same twenty-four, so this number is not a
 * limit the screen enforces — it is the number the confirmation must not lie
 * about. It is also the window the health strip counts as `failed24h`, which is
 * the figure the operator is looking at when they reach for this button.
 */
const REQUEUE_WINDOW_HOURS = 24

/**
 * "Send the failed ones again", beside the sweep and under the health strip.
 *
 * This is where the button belongs because this is where the failure is
 * reported: the strip above says `failed24h: 3200` after an Evolution restart
 * ate a dunning run, and the answer to that number has to be within reach of
 * it. Inside the inbox tab it would be a per-thread action, which is what the
 * bubble's own resend already is; the campaign case never has a thread open.
 *
 * It is NOT destructive and still asks first, because it is bulk: an operator
 * has to be told how wide the window is before three thousand messages go back
 * on the wire. What it cannot do is duplicate anything — the route requeues the
 * rows themselves, and only rows that failed — and the confirmation says so.
 *
 * Admin-only, because the route is. A viewer who could press it would get a 403
 * with no way to tell that from a queue that refused to move.
 */
function RequeueFailedButton() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [requeuing, setRequeuing] = useState(false)

  // Reenfileirar é reenviar, então é `whatsapp.send`, como a rota. Quem estava
  // de plantão quando a campanha caiu é exatamente quem precisa deste botão.
  if (!can('whatsapp.send')) return null

  const requeueAll = async () => {
    if (!window.confirm(t('whatsapp.outbox.requeueAllConfirm', { hours: REQUEUE_WINDOW_HOURS }))) return
    setRequeuing(true)
    try {
      const res = await whatsappAPI.requeueFailed(REQUEUE_WINDOW_HOURS)
      if (!res.success || !res.data) {
        toast.error(t('whatsapp.outbox.requeueFailed'))
        return
      }
      // Zero is a real answer with its own sentence. "Nothing failed in the
      // last day" and "the button is broken" look identical otherwise, and the
      // operator pressing this has just watched a campaign fall over.
      if (!res.data.requeued) {
        toast.info(t('whatsapp.outbox.requeueAllNone'))
        return
      }
      toast.success(t('whatsapp.outbox.requeueAllDone', { count: res.data.requeued }))
    } catch {
      toast.error(t('whatsapp.outbox.requeueFailed'))
    } finally {
      setRequeuing(false)
    }
  }

  return (
    <button
      type="button"
      className="modern-button-secondary min-h-9 px-3 py-1 text-xs"
      disabled={requeuing}
      onClick={() => void requeueAll()}
    >
      <Icon name="refresh" size={14} className={requeuing ? 'animate-spin' : ''} />
      {t('whatsapp.outbox.requeueAll')}
    </button>
  )
}

/**
 * As abas, na ordem em que o operador as encontra, cada uma com a capacidade
 * que ela precisa para LER — que é o que decide se a aba aparece.
 *
 * Alertas é a única que sai da lista do plantão: as três rotas dela exigem
 * `whatsapp.config`, então para um `tech` a aba abriria vazia e cada leitura
 * responderia 403. As demais ele lê; o que ele não pode escrever é recusado
 * pelo servidor com uma frase que diz isso.
 */
const TABS = [
  ['inbox', 'whatsapp.inbox.title', 'whatsapp.read'],
  ['contacts', 'whatsapp.contacts.title', 'whatsapp.read'],
  ['billing', 'whatsapp.billing.title', 'campaigns.read'],
  ['campaigns', 'whatsapp.broadcast.title', 'campaigns.read'],
  ['templates', 'whatsapp.templates.title', 'campaigns.read'],
  ['optOut', 'whatsapp.optOut.title', 'campaigns.read'],
  ['alerts', 'whatsapp.alerts.title', 'whatsapp.config']
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
  const { can } = useAuth()
  const [tab, setTab] = useState<TabId>('inbox')
  // The thread Contacts handed over, and a counter that remounts the inbox for
  // each hand-over so it opens that thread even when it was already on screen.
  // The Contacts page (its own menu entry) hands one over through the route.
  const location = useLocation()
  const routed = (location.state as { conversation?: WhatsAppConversation } | null)?.conversation ?? null
  const [handOver, setHandOver] = useState<{ conversation: WhatsAppConversation; seq: number } | null>(
    routed ? { conversation: routed, seq: 1 } : null
  )
  const visibleTabs = TABS.filter(([, , permission]) => can(permission))

  return (
    <div className="page-shell">
      <div className="page-frame">
        {/*
          Uma linha só: o título, a tira e as ações. Esta página é ferramenta de
          trabalho o dia todo, e o cabeçalho de página padrão (rótulo, título,
          subtítulo, divisória) mais a tira em cartão e uma fileira só para dois
          botões empurravam a caixa de entrada para fora da tela.

          A tira fica aqui, fora da troca de abas, de propósito: tem que
          continuar respondendo "está funcionando?" em qualquer aba — montada
          dentro de uma delas, a integração sumiria ao abrir Campanhas.
        */}
        <header className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border pb-3">
          <h1 className="text-xl font-bold leading-tight text-foreground">{t('sidebar.nav.whatsapp')}</h1>
          <HealthStrip
            actions={(disponivel) => (
              <>
                {/* Na ordem em que os números da tira se leem: as falhas
                    primeiro, o disco depois. E só quando há o que fazer. */}
                {disponivel.requeue && <RequeueFailedButton />}
                {disponivel.sweep && <MediaSweepButton />}
              </>
            )}
          />
        </header>

        <div className="tab-rail" role="tablist" aria-label={t('sidebar.nav.whatsapp')}>
          {visibleTabs.map(([id, labelKey]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setTab(id)
                setHandOver(null)
              }}
              className="tab-button"
              data-active={tab === id}
              role="tab"
              aria-selected={tab === id}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {tab === 'inbox' && (
          <InboxTab key={handOver?.seq ?? 0} initialConversation={handOver?.conversation ?? null} />
        )}
        {tab === 'contacts' && (
          <ContactsPanel
            onOpenConversation={(conversation) => {
              setHandOver((current) => ({ conversation, seq: (current?.seq ?? 0) + 1 }))
              setTab('inbox')
            }}
          />
        )}
        {tab === 'billing' && <BillingPanel />}
        {tab === 'campaigns' && <CampaignsPanel />}
        {tab === 'templates' && <TemplatesPanel />}
        {tab === 'optOut' && <OptOutPanel />}
        {/* Pela capacidade e não pela aba escolhida: o estado inicial é `inbox`,
            mas um papel que perca `whatsapp.config` enquanto está em Alertas
            continuaria montando um painel cujas requisições todas falham. */}
        {tab === 'alerts' && can('whatsapp.config') && <AlertsPanel />}
      </div>
    </div>
  )
}
