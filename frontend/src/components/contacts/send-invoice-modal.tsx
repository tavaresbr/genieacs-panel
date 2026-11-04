'use client'

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { contactsAPI, type ContactInvoiceMessage } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { sessionOwner } from '@/lib/session-owner'
import { formatBrPhone } from '@/lib/phone'

const phoneText = formatBrPhone

/** O texto do boleto para o WhatsApp do cliente: prévia editável, e só sai quando o operador manda. */
export function SendInvoiceModal({ contactKey, invoiceId, onClose }: { contactKey: string; invoiceId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [preview, setPreview] = useState<ContactInvoiceMessage | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<Awaited<ReturnType<typeof contactsAPI.sendInvoice>>['data'] | null>(null)

  useEffect(() => {
    let alive = true
    contactsAPI.invoiceMessage(contactKey, invoiceId)
      .then((res) => {
        if (!alive) return
        if (!res.success || !res.data) {
          setError(res.message || t('contacts.profile.sendInvoiceFailed'))
          return
        }
        setPreview(res.data)
        setText(res.data.text)
      })
      .catch(() => { if (alive) setError(t('api.requestFailed')) })
    return () => { alive = false }
  }, [contactKey, invoiceId, t])

  const send = async () => {
    setBusy(true)
    try {
      const res = await contactsAPI.sendInvoice(contactKey, invoiceId, text)
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.sendInvoiceFailed'))
        return
      }
      toast.success(t('contacts.profile.sendInvoiceDone'))
      setSent(res.data)
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="send-invoice-title">
      <div className="modal-panel modern-card max-w-xl p-5 sm:p-6">
        <h2 id="send-invoice-title" className="section-heading mb-1">{t('contacts.profile.sendInvoiceTitle')}</h2>
        {preview?.phone && (
          <p className="section-description mb-4">{t('contacts.profile.sendInvoiceTo', { phone: phoneText(preview.phone) })}</p>
        )}

        {error ? (
          <p className="text-sm text-[hsl(var(--status-warning))]" role="status">{error}</p>
        ) : !preview ? (
          <p className="text-sm text-muted-foreground">{t('contacts.profile.loading')}</p>
        ) : sent ? (
          <p className="text-sm">{t('contacts.profile.sendInvoiceDone')}</p>
        ) : (
          <>
            <label className="field-label" htmlFor="send-invoice-text">{t('contacts.profile.sendInvoiceText')}</label>
            <textarea
              id="send-invoice-text"
              className="modern-input min-h-64 font-mono text-xs"
              value={text}
              maxLength={4000}
              onChange={(event) => setText(event.target.value)}
            />
          </>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>
            {sent ? t('common.close') : t('common.cancel')}
          </button>
          {sent ? (
            <button type="button" className="modern-button" onClick={() => navigate('/whatsapp', { state: { conversation: sent.conversation, owner: sessionOwner(user) } })}>
              <Icon name="chat" size={16} /> {t('contacts.profile.openConversation')}
            </button>
          ) : (
            <button type="button" className="modern-button" disabled={busy || !preview || !text.trim()} onClick={() => void send()}>
              <Icon name="chat" size={16} /> {busy ? t('contacts.profile.sending') : t('contacts.profile.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
