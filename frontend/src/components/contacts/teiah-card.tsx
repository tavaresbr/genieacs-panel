import { useState } from 'react'
import { contactsAPI, type ContactAddress, type ContactProfile } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatBrPhone } from '@/lib/phone'
import { isSafeExternalUrl } from '@/lib/sgp'
import { TeiahReportModal } from '@/components/contacts/teiah-report-modal'
import { riskBadge } from '@/lib/teiah'
import { TeiahAddressCheck } from '@/components/contacts/teiah-address-check'
import { useTeiahLimitOverride } from '@/components/contacts/use-teiah-limit'

function addressLine(address: { street?: string; number?: string; district?: string; city?: string; state?: string; zip?: string }) {
  const street = [address.street, address.number].filter(Boolean).join(', ')
  const place = [address.district, [address.city, address.state].filter(Boolean).join('/')].filter(Boolean).join(' - ')
  return [street, place, address.zip].filter(Boolean).join(' · ')
}

/** The same address however it was typed: street, number and CEP, lower-cased and bare. */
const addressKey = (address: ContactAddress) => [address.street, address.number, address.zip]
  .map((part) => String(part ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''))
  .join('|')

/**
 * "TeiaH Valid" on the record: what the TeiaH knows about this CPF/CNPJ — score
 * and risk, the mother's name, other addresses, and the phones and e-mails it
 * has that the record lacks. Asking is an operator's act (it costs a call and
 * sends the document out); adding to the record is a second, explicit click.
 */
export function TeiahCard({ profile, onProfile, onReload }: {
  profile: ContactProfile
  onProfile: (profile: ContactProfile) => void
  onReload: () => Promise<void>
}) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const limit = useTeiahLimitOverride()
  const teiah = profile.teiah ?? null

  const knownPhones = new Set(profile.fields.phones.value)
  const knownEmails = new Set(profile.fields.emails.value)
  const newPhones = teiah ? teiah.phones.filter((phone) => !knownPhones.has(phone)) : []
  const newEmails = teiah ? teiah.emails.filter((email) => !knownEmails.has(email)) : []
  const canAdd = newPhones.length > 0 || newEmails.length > 0 || (teiah?.phones.length && !profile.whatsappPhone)

  const consult = async () => {
    // "Consultar de novo" is a paid call: the TeiaH answer is reused for 30 days,
    // so asking again within that window needs an explicit yes.
    const asksAgain = teiah !== null
    if (asksAgain && teiah && Date.now() - Date.parse(teiah.consultedAt) < 30 * 86_400_000
      && !window.confirm(t('contacts.profile.teiahRefreshConfirm', { date: formatDateTime(teiah.consultedAt) }))) return
    setBusy(true)
    try {
      const res = await limit.retry(
        await contactsAPI.teiahConsult(profile.key, asksAgain),
        (password) => contactsAPI.teiahConsult(profile.key, asksAgain, password)
      )
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.teiahFailed'))
        return
      }
      if (res.data.cached) toast.info(t('contacts.profile.teiahFromCache', { date: formatDateTime(res.data.teiah.consultedAt) }))
      await onReload()
    } catch {
      toast.error(t('contacts.profile.teiahFailed'))
    } finally {
      setBusy(false)
    }
  }

  // One of the TeiaH's addresses kept on the record, among its other addresses.
  // The addresses on the record — the main one and the extra ones — each can be
  // checked on the TeiaH (a paid call, asked one by one).
  const recordAddresses = [profile.fields.address.value, ...profile.fields.extraAddresses.value]
    .filter((address): address is ContactAddress => Boolean(address && (address.street || address.zip)))
  const knownAddresses = new Set([profile.fields.address.value, ...profile.fields.extraAddresses.value]
    .filter((address): address is ContactAddress => Boolean(address)).map(addressKey))
  const addAddress = async (address: ContactAddress) => {
    setBusy(true)
    try {
      const res = await contactsAPI.update(profile.key, { extraAddresses: [...profile.fields.extraAddresses.value, address] })
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.teiahFailed'))
        return
      }
      onProfile(res.data)
      toast.success(t('contacts.profile.teiahAddressAdded'))
    } catch {
      toast.error(t('contacts.profile.teiahFailed'))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    setBusy(true)
    try {
      const res = await contactsAPI.teiahApply(profile.key)
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.teiahFailed'))
        return
      }
      onProfile(res.data.profile)
      toast.success(t('contacts.profile.teiahApplied', { phones: res.data.phonesAdded, emails: res.data.emailsAdded }))
    } catch {
      toast.error(t('contacts.profile.teiahFailed'))
    } finally {
      setBusy(false)
    }
  }

  const line = (label: string, value: string | null | undefined) => (
    value ? (
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">{label}:</dt>
        <dd className="font-medium wrap-anywhere">{value}</dd>
      </div>
    ) : null
  )

  return (
    <section className="modern-card mt-5 p-5 sm:p-6" data-testid="teiah-card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-heading">{t('contacts.profile.teiah')}</h2>
        <div className="flex flex-wrap items-center gap-2">
        {isSafeExternalUrl(profile.teiahWebUrl ?? null) && (
          <a href={profile.teiahWebUrl ?? undefined} target="_blank" rel="noopener noreferrer" className="modern-button-secondary">
            <Icon name="external" size={16} /> {t('contacts.profile.teiahOpen')}
          </a>
        )}
        <button type="button" className="modern-button" onClick={() => setReportOpen(true)} data-testid="teiah-report-open">
          <Icon name="document" size={16} /> {t('contacts.teiahReport.open')}
        </button>
        <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void consult()}>
          <Icon name="refresh" size={16} className={busy ? 'animate-spin' : ''} />
          {' '}{t(teiah ? 'contacts.profile.teiahRefresh' : 'contacts.profile.teiahConsult')}
        </button>
        </div>
      </div>

      {!teiah && <p className="text-sm text-muted-foreground">{t('contacts.profile.teiahNever')}</p>}
      {teiah && !teiah.found && <p className="text-sm text-muted-foreground">{t('contacts.profile.teiahNotFound')}</p>}

      {teiah?.found && (
        <div className="space-y-3 text-sm">
          {teiah.deceased && (
            <p className="text-[hsl(var(--status-warning))]" role="status">{t('contacts.profile.teiahDeceased')}</p>
          )}
          <dl className="grid gap-1 sm:grid-cols-2">
            {teiah.score && (
              <div className="flex flex-wrap items-center gap-x-2">
                <dt className="text-muted-foreground">{t('contacts.profile.teiahScore')}:</dt>
                <dd className="flex items-center gap-2 font-medium">
                  {teiah.score.score ?? '—'}
                  {teiah.score.risk && <span className={riskBadge(teiah.score.risk)}>{teiah.score.risk}</span>}
                </dd>
              </div>
            )}
            {line(t('contacts.profile.teiahPayment'), teiah.score?.paymentProbability ?? teiah.score?.paymentDescription)}
            {line(t('contacts.profile.teiahMother'), teiah.motherName)}
          </dl>

          {teiah.addresses.length > 0 && (
            <div>
              <p className="mb-1 text-muted-foreground">{t('contacts.profile.teiahAddresses')}:</p>
              <ul className="space-y-1">
                {teiah.addresses.map((address, index) => (
                  <li key={index} className="flex flex-wrap items-center gap-2">
                    <span className="wrap-anywhere">{addressLine(address)}</span>
                    {knownAddresses.has(addressKey(address))
                      ? <span className="modern-badge">{t('contacts.profile.teiahInRecord')}</span>
                      : (
                        <button
                          type="button"
                          className="text-primary hover:underline disabled:opacity-50"
                          disabled={busy || profile.fields.extraAddresses.value.length >= 5}
                          onClick={() => void addAddress(address)}
                        >
                          {t('contacts.profile.teiahAddAddress')}
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(teiah.phones.length > 0 || teiah.emails.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-muted-foreground">{t('contacts.profile.teiahPhones')}:</p>
                <ul className="space-y-1">
                  {teiah.phones.map((phone) => (
                    <li key={phone} className="flex items-center gap-2">
                      <span className="font-mono">{formatBrPhone(phone)}</span>
                      {knownPhones.has(phone) && <span className="modern-badge">{t('contacts.profile.teiahInRecord')}</span>}
                    </li>
                  ))}
                  {teiah.phones.length === 0 && <li className="text-muted-foreground">—</li>}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-muted-foreground">{t('contacts.profile.teiahEmails')}:</p>
                <ul className="space-y-1">
                  {teiah.emails.map((email) => (
                    <li key={email} className="flex items-center gap-2 break-all">
                      <span>{email}</span>
                      {knownEmails.has(email) && <span className="modern-badge">{t('contacts.profile.teiahInRecord')}</span>}
                    </li>
                  ))}
                  {teiah.emails.length === 0 && <li className="text-muted-foreground">—</li>}
                </ul>
              </div>
            </div>
          )}

          {canAdd ? (
            <button type="button" className="modern-button" disabled={busy} onClick={() => void apply()}>
              <Icon name="check" size={16} /> {t('contacts.profile.teiahApply')}
            </button>
          ) : null}
        </div>
      )}

      {teiah && <p className="mt-3 text-xs text-muted-foreground">{t('contacts.profile.teiahConsultedAt', { date: formatDateTime(teiah.consultedAt) })}</p>}

      {recordAddresses.length > 0 && (
        <div className="mt-4 border-t border-border pt-3" data-testid="teiah-record-addresses">
          <p className="mb-2 text-sm font-semibold">{t('contacts.profile.teiahAddressesCheck')}</p>
          <div className="space-y-2">
            {recordAddresses.map((address, index) => (
              <TeiahAddressCheck
                key={`${index}-${address.zip ?? ''}-${address.number ?? ''}`}
                compact
                testId={`teiah-record-address-${index}`}
                title={addressLine(address) || t('contacts.profile.teiahAddressIncomplete')}
                address={{
                  zip: address.zip ?? '',
                  street: address.street ?? '',
                  number: address.number ?? '',
                  district: address.district ?? '',
                  complement: address.complement ?? ''
                }}
              />
            ))}
          </div>
        </div>
      )}
      {limit.element}
      {reportOpen && (
        <TeiahReportModal
          reportKey={profile.key}
          load={(mode) => contactsAPI.teiahReport(profile.key, mode)}
          onClose={() => setReportOpen(false)}
          onConsult={consult}
          consulting={busy}
        />
      )}
    </section>
  )
}
