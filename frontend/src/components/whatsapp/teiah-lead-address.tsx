import { useState } from 'react'
import { contactsAPI } from '@/lib/api'
import { TeiahAddressCheck, type TeiahAddressOutcome } from '@/components/contacts/teiah-address-check'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { Icon } from '@/components/ui/icon'

/**
 * The address a lead gives in the chat, checked on the TeiaH before the lead
 * goes to sales. CEP first (the street, district and city come from it), then
 * the number. "Usar na resposta" puts a one-line summary in the reply box —
 * nothing is sent by itself.
 */
export interface LeadAddress { zip: string; street: string; number: string; district: string; complement: string; city: string; state: string }

export function TeiahLeadAddress({ onDraft, onRegister }: {
  onDraft?: (text: string) => void
  /** "Cadastrar como novo cliente" with this address; absent without the permission. */
  onRegister?: (address: LeadAddress) => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<LeadAddress>({ zip: '', street: '', number: '', district: '', complement: '', city: '', state: '' })
  const [cepLooking, setCepLooking] = useState(false)
  const set = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }))

  const fillFromCep = async () => {
    const digits = form.zip.replace(/\D/g, '')
    if (digits.length !== 8) return
    setCepLooking(true)
    try {
      const res = await contactsAPI.lookupCep(digits)
      if (!res.success || !res.data) return
      const data = res.data
      setForm((current) => ({
        ...current,
        street: current.street || data.addressLine || '',
        district: current.district || data.district || '',
        city: current.city || data.city || '',
        state: current.state || data.state || ''
      }))
    } finally {
      setCepLooking(false)
    }
  }

  const summary = ({ result }: TeiahAddressOutcome) => {
    const city = [form.city.trim(), form.state.trim()].filter(Boolean).join('/')
    const place = [`${form.street.trim()}, ${form.number.trim()}`, form.district.trim(), city].filter(Boolean).join(' - ')
    if (!result.found) return t('whatsapp.sgp.teiahAddress.draftNone', { address: place })
    return t('whatsapp.sgp.teiahAddress.draft', {
      address: place,
      score: result.score ?? '—',
      risk: result.risk ?? '—',
      debts: result.debtCount
        ? t('whatsapp.sgp.teiahAddress.draftDebts', {
          count: result.debtCount,
          amount: result.debtAmount ? formatMoney(Math.round(result.debtAmount * 100), 'BRL') : '—'
        })
        : ''
    }).trim()
  }

  return (
    <div className="space-y-2" data-testid="wa-teiah-address">
      <p className="text-xs text-muted-foreground">{t('whatsapp.sgp.teiahAddress.hint')}</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="metric-label" htmlFor="wa-teiah-zip">{t('contacts.profile.addressPart.zip')}</label>
          <input
            id="wa-teiah-zip"
            className="modern-input"
            inputMode="numeric"
            placeholder="00000-000"
            value={form.zip}
            onChange={(event) => set('zip', event.target.value.replace(/[^\d-]/g, '').slice(0, 9))}
            onBlur={() => void fillFromCep()}
          />
        </div>
        <div>
          <label className="metric-label" htmlFor="wa-teiah-number">{t('contacts.profile.addressPart.number')}</label>
          <input id="wa-teiah-number" className="modern-input" value={form.number} onChange={(event) => set('number', event.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="metric-label" htmlFor="wa-teiah-street">{t('contacts.profile.addressPart.street')}</label>
          <input
            id="wa-teiah-street"
            className="modern-input"
            value={form.street}
            placeholder={cepLooking ? t('contacts.profile.loading') : undefined}
            onChange={(event) => set('street', event.target.value)}
          />
        </div>
        <div>
          <label className="metric-label" htmlFor="wa-teiah-district">{t('contacts.profile.addressPart.district')}</label>
          <input id="wa-teiah-district" className="modern-input" value={form.district} onChange={(event) => set('district', event.target.value)} />
        </div>
        <div>
          <label className="metric-label" htmlFor="wa-teiah-complement">{t('contacts.profile.addressPart.complement')}</label>
          <input id="wa-teiah-complement" className="modern-input" value={form.complement} onChange={(event) => set('complement', event.target.value)} />
        </div>
      </div>
      <TeiahAddressCheck
        compact
        testId="wa-teiah-address-check"
        address={form}
        footer={onDraft ? (outcome) => (
          <button type="button" className="font-semibold text-primary hover:underline" onClick={() => onDraft(summary(outcome))}>
            {t('whatsapp.sgp.teiahAddress.useInReply')}
          </button>
        ) : undefined}
      />
      {onRegister && (
        <button type="button" className="modern-button-secondary w-full" onClick={() => onRegister(form)} data-testid="wa-teiah-register">
          <Icon name="contacts" size={16} /> {t('whatsapp.sgp.teiahAddress.register')}
        </button>
      )}
    </div>
  )
}
