'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  contactsAPI,
  type ContactAddress,
  type ContactField,
  type ContactProfile,
  type ContactProfileField,
  type ContactProfilePatch,
  type SgpInvoice
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { copyToClipboard, formatBrl, isSafeExternalUrl } from '@/lib/sgp'

const ADDRESS_PARTS = ['street', 'number', 'complement', 'district', 'city', 'state', 'zip', 'reference'] as const

/** An address on one line, from its parts or as the SGP sent it. */
export function addressText(address: ContactAddress | null | undefined) {
  if (!address) return ''
  if (address.line) return address.line
  const street = [address.street, address.number].filter(Boolean).join(', ')
  const place = [address.district, [address.city, address.state].filter(Boolean).join('/')].filter(Boolean).join(' - ')
  return [street, address.complement, place, address.zip].filter(Boolean).join(' · ')
}

/** A phone as a person reads it: 5593991261076 → (93) 99126-1076. */
function phoneText(phone: string) {
  const local = phone.startsWith('55') ? phone.slice(2) : phone
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`
  return phone
}

function documentText(document: string | null) {
  const digits = String(document ?? '')
  if (digits.length === 11) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
  if (digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
  }
  return digits
}

export default function ContactDetailPage() {
  const { key = '' } = useParams()
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [profile, setProfile] = useState<ContactProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [editing, setEditing] = useState(false)
  const canEdit = can('contacts.edit')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await contactsAPI.get(key)
    setLoading(false)
    if (!res.success || !res.data) {
      setNotFound(true)
      return
    }
    setNotFound(false)
    setProfile(res.data)
  }, [key])

  useEffect(() => { void load() }, [load])

  const save = async (patch: ContactProfilePatch) => {
    const res = await contactsAPI.update(key, patch)
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.profile.saveFailed'))
      return false
    }
    setProfile(res.data)
    toast.success(t('contacts.profile.saved'))
    return true
  }

  if (!can('contacts.read')) {
    return (
      <div className="page-shell"><div className="page-frame">
        <p className="text-sm text-muted-foreground">{t('contacts.profile.noAccess')}</p>
      </div></div>
    )
  }

  if (loading && !profile) {
    return (
      <div className="page-shell"><div className="page-frame">
        <p className="text-sm text-muted-foreground">{t('contacts.profile.loading')}</p>
      </div></div>
    )
  }

  if (notFound || !profile) {
    return (
      <div className="page-shell"><div className="page-frame">
        <div className="empty-state">
          <h2 className="empty-state-title">{t('contacts.profile.notFound')}</h2>
          <button type="button" className="modern-button mt-5" onClick={() => navigate('/contacts')}>
            {t('contacts.profile.back')}
          </button>
        </div>
      </div></div>
    )
  }

  const { fields } = profile
  const restore = (field: ContactProfileField) => () => void save({ [field]: null })

  return (
    <div className="page-shell">
      <div className="page-frame" data-testid="contact-detail">
        <header className="page-header">
          <div className="min-w-0">
            <Link to="/contacts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <Icon name="back" size={14} /> {t('contacts.profile.back')}
            </Link>
            <h1 className="page-title break-words">{fields.name.value || '—'}</h1>
            <p className="page-description flex flex-wrap items-center gap-2">
              {profile.source === 'panel'
                ? <span className="modern-badge-info">{t('contacts.profile.sourcePanel')}</span>
                : profile.clientId && <span>{t('contacts.profile.sgpClient', { id: profile.clientId })}</span>}
              {profile.lastSeenAt && (
                <span>{t('contacts.profile.lastSeen', { time: new Date(profile.lastSeenAt).toLocaleString() })}</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {profile.sgpUrl && isSafeExternalUrl(profile.sgpUrl) && (
              <a className="modern-button-secondary" href={profile.sgpUrl} target="_blank" rel="noreferrer">
                <Icon name="external" size={16} /> {t('contacts.profile.openInSgp')}
              </a>
            )}
            {canEdit && (
              <button type="button" className="modern-button" onClick={() => setEditing(true)}>
                <Icon name="edit" size={16} /> {t('contacts.profile.edit')}
              </button>
            )}
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={t('contacts.profile.personal')}>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <FieldRow label={t('contacts.profile.name')} field={fields.name} canEdit={canEdit} onRestore={restore('name')}>
                {fields.name.value}
              </FieldRow>
              <FieldRow label={t('contacts.profile.personType')} field={fields.personType} canEdit={canEdit} onRestore={restore('personType')}>
                {fields.personType.value}
              </FieldRow>
              <FieldRow label={t('contacts.profile.document')} field={fields.document} canEdit={canEdit} onRestore={restore('document')}>
                {documentText(fields.document.value)}
              </FieldRow>
              <FieldRow label={t('contacts.profile.birthDate')} field={fields.birthDate} canEdit={canEdit} onRestore={restore('birthDate')}>
                {fields.birthDate.value}
              </FieldRow>
              <FieldRow label={t('contacts.profile.gender')} field={fields.gender} canEdit={canEdit} onRestore={restore('gender')}>
                {fields.gender.value}
              </FieldRow>
              <Row label={t('contacts.profile.registeredAt')}>{profile.registeredAt}</Row>
            </dl>
          </Card>

          <Card title={t('contacts.profile.address')}>
            <dl className="grid gap-x-6 gap-y-4">
              <FieldRow label={t('contacts.profile.address')} field={fields.address} canEdit={canEdit} onRestore={restore('address')}>
                {addressText(fields.address.value)}
              </FieldRow>
            </dl>
          </Card>

          <Card title={t('contacts.profile.contacts')}>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Row label={t('contacts.profile.whatsappPhone')}>
                {profile.whatsappPhone && (
                  <span className="flex flex-wrap items-center gap-2">
                    {phoneText(profile.whatsappPhone)}
                    {profile.whatsappPhoneSource === 'manual' && <span className="modern-badge-info">{t('contacts.profile.edited')}</span>}
                  </span>
                )}
              </Row>
              <FieldRow label={t('contacts.profile.phones')} field={fields.phones} canEdit={canEdit} onRestore={restore('phones')}>
                {fields.phones.value.length > 0 && (
                  <ul className="space-y-1">{fields.phones.value.map((phone) => <li key={phone}>{phoneText(phone)}</li>)}</ul>
                )}
              </FieldRow>
              <FieldRow label={t('contacts.profile.emails')} field={fields.emails} canEdit={canEdit} onRestore={restore('emails')}>
                {fields.emails.value.length > 0 && (
                  <ul className="space-y-1 break-all">{fields.emails.value.map((email) => <li key={email}>{email}</li>)}</ul>
                )}
              </FieldRow>
            </dl>
          </Card>

          <Card title={t('contacts.profile.notes')}>
            <p className="whitespace-pre-wrap text-sm">{profile.notes || <span className="text-muted-foreground">—</span>}</p>
          </Card>
        </div>

        <Card title={t('contacts.profile.contracts')} className="mt-5">
          {profile.contracts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('contacts.profile.noContracts')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="modern-table w-full">
                <thead>
                  <tr>
                    <th>{t('contacts.profile.contract')}</th>
                    <th>{t('contacts.profile.status')}</th>
                    <th>{t('contacts.profile.plan')}</th>
                    <th>{t('contacts.profile.dueDay')}</th>
                    <th>{t('contacts.profile.since')}</th>
                    <th>{t('contacts.profile.device')}</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.contracts.map((contract) => (
                    <tr key={contract.contract}>
                      <td className="font-mono">{contract.contract}</td>
                      <td>
                        {contract.status || '—'}
                        {contract.statusReason && <span className="block text-xs text-muted-foreground">{contract.statusReason}</span>}
                      </td>
                      <td>{contract.plan || '—'}</td>
                      <td>{contract.dueDay || '—'}</td>
                      <td>{contract.createdAt || '—'}</td>
                      <td>
                        {contract.deviceId
                          ? <Link className="text-primary hover:underline" to={`/devices/${encodeURIComponent(contract.deviceId)}`}>{contract.deviceId}</Link>
                          : <span className="text-muted-foreground">{t('contacts.profile.noDevice')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {profile.contracts.length > 0 && <InvoicesCard contactKey={profile.key} />}

        {editing && (
          <EditModal
            profile={profile}
            onClose={() => setEditing(false)}
            onSave={async (patch) => {
              if (Object.keys(patch).length === 0) {
                setEditing(false)
                return
              }
              if (await save(patch)) setEditing(false)
            }}
          />
        )}
      </div>
    </div>
  )
}

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`modern-card p-5 sm:p-6 ${className}`}>
      <h2 className="section-heading mb-4">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-border pb-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  )
}

/** A field that an operator may have changed: the mark, and the way back to the SGP's value. */
function FieldRow<T>({ label, field, canEdit, onRestore, children }: {
  label: string
  field: ContactField<T>
  canEdit: boolean
  onRestore: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Row label={label}>
      {children}
      {field.edited && (
        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="modern-badge-info" title={field.editedBy ? t('contacts.profile.editedBy', { name: field.editedBy }) : undefined}>
            {t('contacts.profile.edited')}
          </span>
          {canEdit && (
            <button type="button" className="text-primary hover:underline" onClick={onRestore}>
              {t('contacts.profile.restore')}
            </button>
          )}
        </span>
      )}
    </Row>
  )
}

function InvoicesCard({ contactKey }: { contactKey: string }) {
  const { t, intlLocale } = useTranslation()
  const toast = useToast()
  const [groups, setGroups] = useState<{ contract: string; invoices: SgpInvoice[] }[] | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    const res = await contactsAPI.invoices(contactKey)
    setLoading(false)
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.profile.invoicesFailed'))
      return
    }
    setGroups(res.data)
  }

  const all = groups?.flatMap((group) => group.invoices.map((invoice) => ({ ...invoice, contract: group.contract }))) ?? []

  return (
    <Card title={t('contacts.profile.invoices')} className="mt-5">
      {groups === null ? (
        <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
          <Icon name="invoice" size={16} /> {loading ? t('contacts.profile.loading') : t('contacts.profile.loadInvoices')}
        </button>
      ) : all.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('contacts.profile.noInvoices')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {all.map((invoice, index) => (
            <li key={`${invoice.contract}-${invoice.id ?? index}`} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span>
                <span className="font-semibold">{formatBrl(invoice.amount, intlLocale)}</span>
                <span className="ms-2 text-muted-foreground">{t('contacts.profile.dueOn', { date: invoice.dueDate ?? '—' })}</span>
                <span className="ms-2 font-mono text-xs text-muted-foreground">{invoice.contract}</span>
              </span>
              <span className="flex gap-2">
                {invoice.digitableLine && (
                  <button type="button" className="modern-button-secondary" onClick={() => void copyToClipboard(invoice.digitableLine!).then(() => toast.success(t('contacts.profile.copied')))}>
                    <Icon name="copy" size={14} /> {t('contacts.profile.copyLine')}
                  </button>
                )}
                {invoice.pix && (
                  <button type="button" className="modern-button-secondary" onClick={() => void copyToClipboard(invoice.pix!).then(() => toast.success(t('contacts.profile.copied')))}>
                    <Icon name="copy" size={14} /> PIX
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

interface EditForm {
  name: string
  personType: string
  document: string
  gender: string
  birthDate: string
  address: Record<(typeof ADDRESS_PARTS)[number], string>
  phones: string
  emails: string
  whatsappPhone: string
  notes: string
}

function formFrom(profile: ContactProfile): EditForm {
  const address = profile.fields.address.value ?? {}
  return {
    name: profile.fields.name.value ?? '',
    personType: profile.fields.personType.value ?? '',
    document: profile.fields.document.value ?? '',
    gender: profile.fields.gender.value ?? '',
    birthDate: profile.fields.birthDate.value ?? '',
    address: Object.fromEntries(ADDRESS_PARTS.map((part) => [
      part, part === 'street' && !address.street && address.line ? address.line : (address[part] ?? '')
    ])) as EditForm['address'],
    phones: profile.fields.phones.value.join('\n'),
    emails: profile.fields.emails.value.join('\n'),
    whatsappPhone: profile.whatsappPhone ?? '',
    notes: profile.notes ?? ''
  }
}

const lines = (value: string) => value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean)

/** Only what the operator changed goes to the server: an untouched field stays the SGP's. */
function patchFrom(before: EditForm, after: EditForm): ContactProfilePatch {
  const patch: ContactProfilePatch = {}
  for (const field of ['name', 'personType', 'document', 'gender', 'birthDate'] as const) {
    if (after[field].trim() !== before[field].trim()) patch[field] = after[field].trim() || null
  }
  if (ADDRESS_PARTS.some((part) => after.address[part].trim() !== before.address[part].trim())) {
    patch.address = Object.fromEntries(ADDRESS_PARTS.map((part) => [part, after.address[part].trim()]).filter(([, value]) => value))
  }
  if (lines(after.phones).join() !== lines(before.phones).join()) patch.phones = lines(after.phones)
  if (lines(after.emails).join() !== lines(before.emails).join()) patch.emails = lines(after.emails)
  if (after.whatsappPhone.trim() !== before.whatsappPhone.trim()) patch.whatsappPhone = after.whatsappPhone.trim() || null
  if (after.notes !== before.notes) patch.notes = after.notes.trim() || null
  return patch
}

function EditModal({ profile, onClose, onSave }: {
  profile: ContactProfile
  onClose: () => void
  onSave: (patch: ContactProfilePatch) => Promise<void>
}) {
  const { t } = useTranslation()
  const [initial] = useState(() => formFrom(profile))
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const set = (field: keyof EditForm) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [field]: event.target.value }))
  const setAddress = (part: (typeof ADDRESS_PARTS)[number]) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, address: { ...current.address, [part]: event.target.value } }))

  return (
    <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="contact-edit-title">
      <div className="modern-card max-h-[90vh] w-full max-w-3xl overflow-y-auto p-5 sm:p-6">
        <h2 id="contact-edit-title" className="section-heading mb-1">{t('contacts.profile.editTitle')}</h2>
        <p className="section-description mb-5">{t('contacts.profile.editHint')}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput id="contact-name" label={t('contacts.profile.name')} value={form.name} onChange={set('name')} wide />
          <div>
            <label className="field-label" htmlFor="contact-person-type">{t('contacts.profile.personType')}</label>
            <select id="contact-person-type" className="modern-input" value={form.personType} onChange={set('personType')}>
              <option value="">—</option>
              <option value="PF">{t('contacts.profile.personPf')}</option>
              <option value="PJ">{t('contacts.profile.personPj')}</option>
            </select>
          </div>
          <TextInput id="contact-document" label={t('contacts.profile.document')} value={form.document} onChange={set('document')} />
          <TextInput id="contact-birth" label={t('contacts.profile.birthDate')} value={form.birthDate} onChange={set('birthDate')} />
          <TextInput id="contact-gender" label={t('contacts.profile.gender')} value={form.gender} onChange={set('gender')} />

          <h3 className="mt-2 font-semibold sm:col-span-2">{t('contacts.profile.address')}</h3>
          {ADDRESS_PARTS.map((part) => (
            <TextInput
              key={part}
              id={`contact-address-${part}`}
              label={t(`contacts.profile.addressPart.${part}`)}
              value={form.address[part]}
              onChange={setAddress(part)}
              wide={part === 'street' || part === 'reference'}
            />
          ))}

          <h3 className="mt-2 font-semibold sm:col-span-2">{t('contacts.profile.contacts')}</h3>
          <TextInput id="contact-whatsapp" label={t('contacts.profile.whatsappPhone')} value={form.whatsappPhone} onChange={set('whatsappPhone')} />
          <div />
          <div>
            <label className="field-label" htmlFor="contact-phones">{t('contacts.profile.phones')}</label>
            <textarea id="contact-phones" className="modern-input min-h-24" value={form.phones} onChange={set('phones')} />
            <p className="field-hint">{t('contacts.profile.onePerLine')}</p>
          </div>
          <div>
            <label className="field-label" htmlFor="contact-emails">{t('contacts.profile.emails')}</label>
            <textarea id="contact-emails" className="modern-input min-h-24" value={form.emails} onChange={set('emails')} />
            <p className="field-hint">{t('contacts.profile.onePerLine')}</p>
          </div>
          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="contact-notes">{t('contacts.profile.notes')}</label>
            <textarea id="contact-notes" className="modern-input min-h-24" value={form.notes} onChange={set('notes')} />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button
            type="button"
            className="modern-button"
            disabled={saving || !form.name.trim()}
            onClick={async () => {
              setSaving(true)
              await onSave(patchFrom(initial, form))
              setSaving(false)
            }}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function TextInput({ id, label, value, onChange, wide = false }: {
  id: string
  label: string
  value: string
  onChange: (event: { target: { value: string } }) => void
  wide?: boolean
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} className="modern-input" value={value} onChange={onChange} />
    </div>
  )
}
