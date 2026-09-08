import { useTranslation } from '@/contexts/language-context'

/**
 * The operator's WhatsApp inbox. Placeholder: the routes it consumes are frozen
 * in `docs/whatsapp-api-contract.md` and the screen is being built against them.
 */
export default function WhatsAppInbox() {
  const { t } = useTranslation()
  return (
    <div className="page-shell">
      <div className="page-frame">
        <h1 className="page-title">{t('whatsapp.inbox.title')}</h1>
        <p className="section-description">{t('whatsapp.inbox.subtitle')}</p>
      </div>
    </div>
  )
}
