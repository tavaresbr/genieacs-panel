'use client'

import { useEffect, useRef, useState } from 'react'
import { messengerAPI, whatsappAPI, type MessengerConversation, type WhatsAppContact } from '@/lib/api'
import { messengerErrorKey } from '@/lib/messenger'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

const SEARCH_DEBOUNCE_MS = 350
const RESULTS = 8

/**
 * "Quem é esta pessoa?", respondido pelo atendente.
 *
 * O PSID do Messenger não traz telefone, então a conversa não casa sozinha com
 * um assinante: o atendente procura no cadastro (a mesma busca de contatos do
 * WhatsApp) e escolhe. É esse vínculo que dá nome à conversa e liga a pessoa ao
 * dossiê da LGPD.
 */
export function MessengerSubscriberLinker({
  conversation,
  onLinked,
  onCancel,
}: {
  conversation: MessengerConversation
  onLinked: (conversation: MessengerConversation) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<WhatsAppContact[]>([])
  const [loading, setLoading] = useState(false)
  const [linking, setLinking] = useState<string | null>(null)
  const seq = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const term = search.trim()
    if (!term) {
      seq.current += 1
      setResults([])
      setLoading(false)
      return
    }
    const timer = setTimeout(async () => {
      const mine = ++seq.current
      setLoading(true)
      const res = await whatsappAPI.listContacts({ search: term, limit: RESULTS })
      // Uma resposta atrasada de uma busca antiga não pode apagar a nova.
      if (!alive.current || mine !== seq.current) return
      setLoading(false)
      if (res.success && res.data) setResults(res.data.contacts)
      else toast.error(t('messenger.link.searchFailed'))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search, t, toast])

  const link = async (contact: WhatsAppContact) => {
    setLinking(contact.key)
    try {
      const res = await messengerAPI.linkSubscriber(conversation.id, contact.key)
      if (!alive.current) return
      if (res.success && res.data) {
        toast.success(t('messenger.link.linked', { name: contact.clientName || contact.contract || contact.key }))
        onLinked(res.data)
      } else {
        toast.error(t(messengerErrorKey(res.code)))
      }
    } finally {
      if (alive.current) setLinking(null)
    }
  }

  return (
    <div className="space-y-3 border-b border-border bg-muted/30 px-4 py-3" data-testid="messenger-subscriber-linker">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{t('messenger.link.title')}</p>
        <button type="button" className="icon-button" aria-label={t('common.cancel')} onClick={onCancel}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <input
        type="search"
        className="modern-input"
        value={search}
        autoFocus
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('messenger.link.searchPlaceholder')}
        aria-label={t('messenger.link.searchPlaceholder')}
      />
      {loading && <p className="field-hint">{t('messenger.link.searching')}</p>}
      {!loading && search.trim() && results.length === 0 && <p className="field-hint">{t('messenger.link.none')}</p>}
      {results.length > 0 && (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border bg-card" role="list">
          {results.map((contact) => (
            <li key={contact.key}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-muted max-sm:min-h-12"
                disabled={linking !== null}
                onClick={() => void link(contact)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {contact.clientName || contact.contract || contact.key}
                  </span>
                  {contact.contract && (
                    <span className="block truncate font-mono text-[0.7rem] text-muted-foreground">{contact.contract}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs font-semibold text-primary">
                  {linking === contact.key ? t('messenger.link.linking') : t('messenger.link.action')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
