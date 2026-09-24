'use client'

import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import type { WhatsAppConversation } from '@/lib/api'
import { ContactsPanel } from '@/components/whatsapp/contacts-panel'

/**
 * The SGP subscribers on their own menu entry, for the operator who comes
 * looking for a person rather than for a conversation. The same panel as the
 * Contacts tab of WhatsApp; opening a conversation hands it to the inbox there.
 */
export default function ContactsPage() {
  const navigate = useNavigate()
  const openConversation = useCallback((conversation: WhatsAppConversation) => {
    navigate('/whatsapp', { state: { conversation } })
  }, [navigate])

  return (
    <div className="page-shell">
      <div className="page-frame">
        <ContactsPanel onOpenConversation={openConversation} defaultState="active" />
      </div>
    </div>
  )
}
