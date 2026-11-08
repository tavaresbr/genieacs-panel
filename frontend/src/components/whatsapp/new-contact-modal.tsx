'use client'

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { contactsAPI, type ContactDocumentLookup, type PreRegistrationOptions } from '@/lib/api'
import { TeiahAddressCheck, type TeiahAddressOutcome } from '@/components/contacts/teiah-address-check'
import { teiahRiskWarnings } from '@/lib/teiah'
import { formatMoney } from '@/lib/money'
import { formatDistance, sortSplitters } from '@/lib/pre-registration'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import type { TranslationKey } from '@/lib/i18n/dictionary'

type AddressField = 'zip' | 'street' | 'number' | 'complement' | 'district' | 'city' | 'state' | 'reference'

const EMPTY_FORM = {
  name: '',
  tradeName: '',
  responsibleName: '',
  responsibleDocument: '',
  birthDate: '',
  whatsappPhone: '',
  email: '',
  zip: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '',
  reference: '',
  latitude: undefined as number | undefined,
  longitude: undefined as number | undefined
}

type Form = typeof EMPTY_FORM

/** The form filled from what a source holds (the TeiaH, the Receita, the SGP's record). */
function formFrom(prefill: ContactDocumentLookup['prefill'] | ContactDocumentLookup['existing'] | undefined): Form {
  if (!prefill) return { ...EMPTY_FORM }
  return {
    ...EMPTY_FORM,
    name: prefill.name ?? '',
    tradeName: prefill.tradeName ?? '',
    birthDate: prefill.birthDate ?? '',
    email: prefill.email ?? '',
    whatsappPhone: prefill.phone ?? '',
    zip: (prefill.address.zip ?? '').replace(/\D/g, '').slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2'),
    street: prefill.address.street ?? '',
    number: prefill.address.number ?? '',
    complement: prefill.address.complement ?? '',
    district: prefill.address.district ?? '',
    city: prefill.address.city ?? '',
    state: prefill.address.state ?? '',
    reference: prefill.address.reference ?? ''
  }
}

const ADDRESS_FIELDS: [AddressField, TranslationKey, string][] = [
  ['street', 'contacts.profile.addressPart.street', 'sm:col-span-4'],
  ['number', 'contacts.profile.addressPart.number', 'sm:col-span-2'],
  ['complement', 'contacts.profile.addressPart.complement', 'sm:col-span-3'],
  ['district', 'contacts.profile.addressPart.district', 'sm:col-span-3'],
  ['city', 'contacts.profile.addressPart.city', 'sm:col-span-4'],
  ['state', 'contacts.profile.addressPart.state', 'sm:col-span-2'],
  ['reference', 'contacts.profile.addressPart.reference', 'sm:col-span-6']
]

/** CPF 000.000.000-00, CNPJ 00.000.000/0000-00, as it is typed. */
function maskDocument(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 14)
  if (digits.length <= 11) {
    return digits
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2')
  }
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2')
}

/**
 * "Novo cliente", in two steps.
 *
 * The CPF/CNPJ first: the panel asks the SGP whether the client is already
 * there (and then offers the record instead of a duplicate) and, for a company
 * nobody has, fills the form from the Receita. A CPF has no public source, so a
 * person is typed by hand. Then the form — and, for whoever may write to the
 * ERP, "Cadastrar também no SGP", which creates the client there first and
 * files it here under the SGP's own id.
 */
/** What the caller already knows (the WhatsApp lead: phone, name, the address checked). */
export type NewContactInitial = Partial<Pick<Form, 'name' | 'whatsappPhone' | 'zip' | 'street' | 'number' | 'complement' | 'district' | 'city' | 'state'>>

export function NewContactModal({ onClose, initial }: { onClose: () => void; initial?: NewContactInitial }) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { can } = useAuth()

  const [document, setDocument] = useState('')
  const [looking, setLooking] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookup, setLookup] = useState<ContactDocumentLookup | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [inSgp, setInSgp] = useState(true)
  // Escrever na conta Asaas é sempre uma escolha explícita: começa desmarcado.
  const [inAsaasToo, setInAsaasToo] = useState(false)
  // With a contract (the SGP's pre-registration): the lists come from
  // Settings → SGP, and the option shows only once a plan is configured there.
  const [withContract, setWithContract] = useState(false)
  // A new contract for a client the SGP already has: the form filled from the
  // SGP's record, always with a contract, sent with `newContract`.
  const [newContract, setNewContract] = useState(false)
  const [preRegOptions, setPreRegOptions] = useState<PreRegistrationOptions | null>(null)
  const [contract, setContract] = useState({
    planId: '', dueDayId: '', login: '', password: '', installOs: true,
    sellerId: '', technicianId: '', splitterId: '', splitterPort: ''
  })
  // The last login checked against the SGP contracts and the panel's accounts.
  const [loginCheck, setLoginCheck] = useState<{ login: string; taken: boolean; suggestion: string | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const [cepLooking, setCepLooking] = useState(false)
  // The TeiaH address check of the installation address, as the box reports it
  // (null when there is none for the address typed now): the risk warning reads it.
  const [addressOutcome, setAddressOutcome] = useState<TeiahAddressOutcome | null>(null)

  const isCompany = lookup?.personType === 'PJ'
  const canCreateInSgp = can('sgp.act') && Boolean(lookup?.sgpChecked)
  const toSgp = canCreateInSgp && inSgp
  const canCreateInAsaas = can('asaas.act') && Boolean(lookup?.asaasWritable) && (lookup?.inAsaas.length ?? 0) === 0
  const toAsaas = canCreateInAsaas && inAsaasToo
  const set = (field: keyof Form, value: string) => setForm((current) => ({ ...current, [field]: value }))
  // What the caller passed fills only what the source (SGP, TeiaH, Receita) left empty.
  const withInitial = (filled: Form): Form => {
    if (!initial) return filled
    const merged = { ...filled }
    for (const [field, value] of Object.entries(initial) as [keyof NewContactInitial, string | undefined][]) {
      if (value && !String(merged[field] ?? '').trim()) merged[field] = value
    }
    return merged
  }

  const canPreRegister = toSgp && Boolean(preRegOptions?.plans.length) && Boolean(preRegOptions?.dueDays.length)
  const toPreRegister = canPreRegister && withContract

  useEffect(() => {
    if (!canCreateInSgp || preRegOptions) return
    void contactsAPI.preRegistrationOptions().then((res) => {
      if (!res.success || !res.data) return
      const options = res.data
      setPreRegOptions(options)
      // The usual plan and due day (most active contracts) and the default seller, pre-selected.
      setContract((current) => ({
        ...current,
        installOs: options.installOs !== false,
        planId: current.planId || (options.suggestedPlanId ? String(options.suggestedPlanId) : ''),
        dueDayId: current.dueDayId || (options.suggestedDueDayId ? String(options.suggestedDueDayId) : ''),
        sellerId: current.sellerId || (options.defaultSellerId ? String(options.defaultSellerId) : '')
      }))
    })
  }, [canCreateInSgp, preRegOptions])

  // A login out of the name ("maria.silva") and a password to change, so the
  // operator rarely has to invent either.
  const suggestLogin = (name = form.name) => {
    const parts = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean)
    return parts.length ? [parts[0], parts.at(-1)].filter((part, index, all) => all.indexOf(part) === index).join('.') : ''
  }
  const suggestPassword = () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
    const bytes = new Uint8Array(10)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
  }
  const loginTyped = contract.login.trim().toLowerCase()
  useEffect(() => {
    if (!toPreRegister || !loginTyped) return
    const timer = window.setTimeout(() => {
      void contactsAPI.checkPreRegistrationLogin(loginTyped).then((res) => {
        if (res.success && res.data) setLoginCheck(res.data)
      })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [toPreRegister, loginTyped])
  const loginTaken = Boolean(loginTyped) && loginCheck?.login === loginTyped && loginCheck.taken

  const splitters = useMemo(
    () => sortSplitters(preRegOptions?.splitters ?? [], form.latitude, form.longitude),
    [preRegOptions?.splitters, form.latitude, form.longitude]
  )
  const chosenSplitter = splitters.find((splitter) => String(splitter.id) === contract.splitterId)
  const missingContract = toPreRegister && (!contract.planId || !contract.dueDayId || loginTaken)

  const open = (key: string) => navigate(`/contacts/${encodeURIComponent(key)}`)

  const canCheckAddress = can('teiah.act') && Boolean(lookup?.teiahReady)

  const canNewContract = can('sgp.act') && Boolean(lookup?.sgpChecked) &&
    Boolean(preRegOptions?.plans.length) && Boolean(preRegOptions?.dueDays.length)
  const startNewContract = () => {
    const existing = lookup?.existing ?? null
    const filled = formFrom(existing)
    setForm({
      ...withInitial(filled),
      latitude: existing?.address.latitude ?? undefined,
      longitude: existing?.address.longitude ?? undefined
    })
    setInSgp(true)
    setWithContract(true)
    setNewContract(true)
    setContract((current) => ({
      ...current,
      login: current.login || suggestLogin(filled.name),
      password: current.password || suggestPassword()
    }))
    setShowForm(true)
  }

  const runLookup = async (fresh = false) => {
    // A new consultation is a paid call; ask first when the panel already holds one.
    if (fresh && !window.confirm(t('contacts.new.teiahRefreshConfirm', { date: lookup?.teiahConsultedAt ? formatDateTime(lookup.teiahConsultedAt) : '' }))) return
    setLooking(true)
    setLookupError(null)
    setLookup(null)
    setShowForm(false)
    setNewContract(false)
    try {
      const res = await contactsAPI.lookupDocument(document, fresh)
      if (!res.success || !res.data) {
        setLookupError(res.message || t('contacts.new.invalidDocument'))
        return
      }
      const found = res.data
      setLookup(found)
      if (found.inSgp.length > 0 || found.inPanel) return
      setForm(withInitial(formFrom(found.prefill)))
      setShowForm(true)
    } finally {
      setLooking(false)
    }
  }

  const fillFromCep = async () => {
    const digits = form.zip.replace(/\D/g, '')
    if (digits.length !== 8) return
    setCepLooking(true)
    try {
      const res = await contactsAPI.lookupCep(digits)
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.new.cepNotFound'))
        return
      }
      const data = res.data
      // What the CEP knows replaces only what is still empty: an address the
      // Receita or the operator already wrote stays.
      setForm((current) => ({
        ...current,
        street: current.street || data.addressLine || '',
        district: current.district || data.district || '',
        city: current.city || data.city || '',
        state: current.state || data.state || '',
        latitude: data.lat ?? current.latitude,
        longitude: data.lng ?? current.longitude
      }))
    } finally {
      setCepLooking(false)
    }
  }

  const missingForSgp = !form.name.trim() || !form.street.trim() || !form.district.trim() || !form.city.trim()
    || !/^[A-Za-z]{2}$/.test(form.state.trim()) || form.zip.replace(/\D/g, '').length !== 8

  // A high TeiaH risk (the CPF or the installation address), or debts at the
  // address: said above the button, and asked again before the SGP gets it.
  const riskReasons = teiahRiskWarnings({ cpf: lookup?.teiahScore ?? null, address: addressOutcome?.result ?? null })
  const riskText = riskReasons.map((reason) => {
    if (reason.kind === 'cpf') return t('contacts.new.riskReason.cpf', { risk: reason.risk, score: reason.score ?? '—' })
    if (reason.kind === 'address') return t('contacts.new.riskReason.address', { risk: reason.risk, score: reason.score ?? '—' })
    return t('contacts.new.riskReason.debts', {
      count: reason.count ?? '—',
      amount: reason.amount ? formatMoney(Math.round(reason.amount * 100), 'BRL') : '—'
    })
  })

  const save = async () => {
    const sendsToSgp = toPreRegister || toSgp
    const riskAcknowledged = sendsToSgp && riskText.length > 0
    if (riskAcknowledged && !window.confirm(t('contacts.new.riskConfirm', { reasons: riskText.join('\n') }))) return
    setSaving(true)
    const address = {
      street: form.street.trim(),
      number: form.number.trim(),
      complement: form.complement.trim(),
      district: form.district.trim(),
      city: form.city.trim(),
      state: form.state.trim().toUpperCase(),
      zip: form.zip.replace(/\D/g, ''),
      reference: form.reference.trim()
    }
    const sgpClient = {
      document: lookup?.document ?? '',
      name: form.name.trim(),
      ...(isCompany ? {
        tradeName: form.tradeName.trim(),
        responsibleName: form.responsibleName.trim(),
        responsibleDocument: form.responsibleDocument.trim()
      } : {}),
      email: form.email.trim(),
      whatsappPhone: form.whatsappPhone.trim(),
      birthDate: form.birthDate,
      address: { ...address, latitude: form.latitude, longitude: form.longitude }
    }
    const res = toPreRegister
      ? await contactsAPI.createPreRegistration({
        ...sgpClient,
        planId: Number(contract.planId),
        dueDayId: Number(contract.dueDayId),
        login: contract.login.trim(),
        password: contract.password,
        installOs: contract.installOs,
        ...(contract.sellerId ? { sellerId: Number(contract.sellerId) } : {}),
        ...(contract.technicianId ? { technicianId: Number(contract.technicianId) } : {}),
        ...(contract.splitterId ? { splitterId: Number(contract.splitterId) } : {}),
        ...(contract.splitterId && contract.splitterPort ? { splitterPort: Number(contract.splitterPort) } : {}),
        ...(newContract ? { newContract: true } : {}),
        ...(riskAcknowledged ? { riskAcknowledged: true } : {})
      })
      : toSgp
      ? await contactsAPI.createInSgp({
        document: lookup?.document ?? '',
        name: form.name.trim(),
        ...(isCompany ? {
          tradeName: form.tradeName.trim(),
          responsibleName: form.responsibleName.trim(),
          responsibleDocument: form.responsibleDocument.trim()
        } : {}),
        email: form.email.trim(),
        whatsappPhone: form.whatsappPhone.trim(),
        birthDate: form.birthDate,
        address: { ...address, latitude: form.latitude, longitude: form.longitude },
        ...(riskAcknowledged ? { riskAcknowledged: true } : {})
      })
      : await contactsAPI.create({
        name: form.name.trim(),
        ...(lookup?.document ? { document: lookup.document, personType: lookup.personType } : {}),
        ...(form.whatsappPhone.trim() ? { whatsappPhone: form.whatsappPhone.trim() } : {}),
        ...(form.email.trim() ? { emails: [form.email.trim()] } : {}),
        ...(form.birthDate ? { birthDate: form.birthDate } : {}),
        ...(Object.values(address).some(Boolean)
          ? { address: Object.fromEntries(Object.entries(address).filter(([, value]) => value)) }
          : {})
      })
    if (!res.success || !res.data) {
      setSaving(false)
      toast.error(res.message || t('contacts.profile.saveFailed'))
      return
    }
    // O Asaas vem DEPOIS, sobre o contato que já está salvo: se ele recusar, o
    // cadastro não se perde e a ficha oferece "Criar no Asaas" para tentar de novo.
    if (toAsaas) {
      const asaas = await contactsAPI.createInAsaas(res.data.key)
      if (!asaas.success) {
        toast.warning(t('contacts.new.asaasFailed', { reason: asaas.message || '' }))
      } else if (asaas.message) {
        toast.success(asaas.message)
      }
    }
    setSaving(false)
    toast.success(t(newContract ? 'contacts.new.newContractSent' : toPreRegister ? 'contacts.new.preRegistered' : toSgp ? 'contacts.new.createdInSgp' : 'contacts.profile.created'))
    open(res.data.key)
  }

  const documentDigits = document.replace(/\D/g, '')

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-contact-title">
      <div className="modal-panel modern-card max-h-[92vh] w-full max-w-2xl overflow-y-auto p-5 sm:p-6" data-testid="new-contact-modal">
        <h2 id="new-contact-title" className="section-heading mb-1">{t('contacts.profile.new')}</h2>
        <p className="section-description mb-5">{t('contacts.new.documentHint')}</p>

        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => { event.preventDefault(); void runLookup() }}
        >
          <div className="flex-1">
            <label className="field-label" htmlFor="new-contact-document">{t('contacts.profile.document')}</label>
            <input
              id="new-contact-document"
              className="modern-input font-mono"
              inputMode="numeric"
              autoComplete="off"
              value={document}
              placeholder="000.000.000-00"
              onChange={(event) => {
                setDocument(maskDocument(event.target.value))
                setLookup(null)
                setLookupError(null)
              }}
            />
          </div>
          <button
            type="submit"
            className="modern-button"
            disabled={looking || (documentDigits.length !== 11 && documentDigits.length !== 14)}
          >
            <Icon name="search" size={16} className={looking ? 'animate-spin' : ''} />
            {t('contacts.new.lookup')}
          </button>
        </form>
        {lookupError && (
          <p className="mt-2 text-sm text-destructive" role="alert">{lookupError}</p>
        )}

        {lookup && lookup.inSgp.length > 0 && (
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3" data-testid="new-contact-in-sgp">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Icon name="check" size={16} />
              {t('contacts.new.inSgp')}
            </p>
            <ul className="mt-2 space-y-2">
              {lookup.inSgp.map((client) => (
                <li key={client.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    {client.name || '—'}
                    {client.contract && <span className="ms-2 font-mono text-xs text-muted-foreground">{client.contract}</span>}
                  </span>
                  <button type="button" className="modern-button-secondary" onClick={() => open(client.key)}>
                    <Icon name="external" size={16} />
                    {t('contacts.new.open')}
                  </button>
                </li>
              ))}
            </ul>
            {can('sgp.act') && lookup.sgpChecked && !newContract && (
              <div className="mt-3 border-t border-border pt-3">
                <button
                  type="button"
                  className="modern-button"
                  disabled={!canNewContract}
                  data-testid="new-contact-new-contract"
                  onClick={startNewContract}
                >
                  <Icon name="document" size={16} />
                  {t('contacts.new.newContract')}
                </button>
                {preRegOptions && !canNewContract && (
                  <p className="mt-2 text-xs text-muted-foreground">{t('contacts.new.newContractNeedsConfig')}</p>
                )}
              </div>
            )}
          </div>
        )}

        {lookup && lookup.inAsaas.length > 0 && (
          <p className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid="new-contact-in-asaas">
            <Icon name="check" size={16} />
            <span><span className="font-semibold">{t('contacts.new.inAsaas')}</span> · {lookup.inAsaas[0].name || '—'}</span>
          </p>
        )}

        {lookup && lookup.inSgp.length === 0 && lookup.inPanel && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <span><span className="font-semibold">{t('contacts.new.inPanel')}</span> · {lookup.inPanel.name || '—'}</span>
            <button type="button" className="modern-button-secondary" onClick={() => open(lookup.inPanel!.key)}>
              <Icon name="external" size={16} />
              {t('contacts.new.open')}
            </button>
          </div>
        )}

        {!lookup && !showForm && (
          <button type="button" className="mt-3 text-sm text-muted-foreground underline max-sm:min-h-10" onClick={() => { setForm(withInitial(EMPTY_FORM)); setShowForm(true) }}>
            {t('contacts.new.withoutDocument')}
          </button>
        )}

        {showForm && (
          <>
            {lookup && (
              <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
                <Icon name="info" size={16} />
                <span>
                  {newContract
                    ? t('contacts.new.newContractFor', { name: form.name || '—' })
                    : !lookup.sgpChecked
                    ? t('contacts.new.sgpNotChecked')
                    : lookup.prefill?.source === 'teiah'
                      ? t('contacts.new.teiahPrefilled')
                      : isCompany
                        ? t(lookup.prefill ? 'contacts.new.cnpjPrefilled' : 'contacts.new.cnpjFailed')
                        : t(lookup.teiahConsulted ? 'contacts.new.teiahNotFound' : 'contacts.new.cpfNoSource')}
                </span>
              </p>
            )}
            {lookup?.teiahCached && lookup.teiahConsultedAt && (
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="new-contact-teiah-cached">
                <span>{t('contacts.new.teiahCachedNote', { date: formatDateTime(lookup.teiahConsultedAt) })}</span>
                <button type="button" className="font-semibold text-primary hover:underline" disabled={looking} onClick={() => void runLookup(true)}>
                  {t('contacts.new.teiahRefresh')}
                </button>
              </p>
            )}
            {lookup?.deceased && (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                <Icon name="warning" size={16} />
                <span>{t('contacts.new.teiahDeceased')}</span>
              </p>
            )}
            {lookup?.teiahScore && (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm" data-testid="new-contact-teiah-score">
                <span className="font-semibold">
                  {t('contacts.new.teiahScore', { score: lookup.teiahScore.score ?? '—' })}
                </span>
                {lookup.teiahScore.risk && (
                  <span className="text-muted-foreground">{t('contacts.new.teiahRisk', { risk: lookup.teiahScore.risk })}</span>
                )}
                {lookup.teiahScore.paymentDescription && (
                  <span className="text-muted-foreground">{lookup.teiahScore.paymentDescription}</span>
                )}
                {lookup.teiahScore.paymentProbability && (
                  <span className="text-muted-foreground">
                    {t('contacts.new.teiahPaymentProbability', { value: lookup.teiahScore.paymentProbability })}
                  </span>
                )}
              </div>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-6">
              <div className="sm:col-span-6">
                <label className="field-label" htmlFor="new-contact-name">
                  {t(isCompany ? 'contacts.new.legalName' : 'contacts.profile.name')}
                </label>
                <input
                  id="new-contact-name"
                  className="modern-input"
                  value={form.name}
                  readOnly={newContract}
                  onChange={(event) => set('name', event.target.value)}
                />
              </div>
              {isCompany && (
                <>
                  <div className="sm:col-span-6">
                    <label className="field-label" htmlFor="new-contact-trade">{t('contacts.new.tradeName')}</label>
                    <input id="new-contact-trade" className="modern-input" value={form.tradeName} onChange={(event) => set('tradeName', event.target.value)} />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="field-label" htmlFor="new-contact-resp">{t('contacts.new.responsibleName')}</label>
                    <input id="new-contact-resp" className="modern-input" value={form.responsibleName} onChange={(event) => set('responsibleName', event.target.value)} />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="field-label" htmlFor="new-contact-resp-doc">{t('contacts.new.responsibleDocument')}</label>
                    <input
                      id="new-contact-resp-doc"
                      className="modern-input font-mono"
                      inputMode="numeric"
                      value={form.responsibleDocument}
                      onChange={(event) => set('responsibleDocument', maskDocument(event.target.value).slice(0, 14))}
                    />
                  </div>
                </>
              )}
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-contact-birth">
                  {t(isCompany ? 'contacts.new.foundedAt' : 'contacts.profile.birthDate')}
                </label>
                <input id="new-contact-birth" type="date" className="modern-input" value={form.birthDate} onChange={(event) => set('birthDate', event.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-contact-whatsapp">{t('contacts.profile.whatsappPhone')}</label>
                <input id="new-contact-whatsapp" className="modern-input" inputMode="tel" value={form.whatsappPhone} onChange={(event) => set('whatsappPhone', event.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-contact-email">{t('contacts.new.email')}</label>
                <input id="new-contact-email" type="email" className="modern-input" value={form.email} onChange={(event) => set('email', event.target.value)} />
              </div>

              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-contact-zip">{t('contacts.profile.addressPart.zip')}</label>
                <input
                  id="new-contact-zip"
                  className="modern-input font-mono"
                  inputMode="numeric"
                  value={form.zip}
                  onChange={(event) => set('zip', event.target.value.replace(/\D/g, '').slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2'))}
                  onBlur={() => void fillFromCep()}
                />
              </div>
              <p className="self-end pb-2 text-xs text-muted-foreground sm:col-span-4">
                {cepLooking ? t('contacts.profile.loading') : t('contacts.new.zipHint')}
              </p>
              {ADDRESS_FIELDS.map(([field, labelKey, span]) => (
                <div key={field} className={span}>
                  <label className="field-label" htmlFor={`new-contact-${field}`}>{t(labelKey)}</label>
                  <input
                    id={`new-contact-${field}`}
                    className="modern-input"
                    value={form[field]}
                    maxLength={field === 'state' ? 2 : undefined}
                    onChange={(event) => set(field, field === 'state' ? event.target.value.toUpperCase() : event.target.value)}
                  />
                </div>
              ))}
            </div>

            {canCheckAddress && (
              <TeiahAddressCheck
                testId="new-contact-teiah-address"
                address={{ zip: form.zip, street: form.street, number: form.number, district: form.district, complement: form.complement }}
                onResult={setAddressOutcome}
              />
            )}

            {canCreateInSgp && !newContract && (
              <label className="mt-5 flex items-start gap-3">
                <input type="checkbox" className="mt-1" checked={inSgp} onChange={(event) => setInSgp(event.target.checked)} />
                <span className="text-sm">
                  <span className="block font-semibold">{t('contacts.new.createInSgp')}</span>
                  <span className="text-muted-foreground">{t('contacts.new.createInSgpHint')}</span>
                </span>
              </label>
            )}
            {canCreateInAsaas && (
              <label className="mt-5 flex items-start gap-3">
                <input type="checkbox" className="mt-1" checked={inAsaasToo} onChange={(event) => setInAsaasToo(event.target.checked)} />
                <span className="text-sm">
                  <span className="block font-semibold">{t('contacts.new.alsoAsaas')}</span>
                  <span className="text-muted-foreground">{t('contacts.new.alsoAsaasHint')}</span>
                </span>
              </label>
            )}
            {toSgp && missingForSgp && (
              <p className="mt-2 text-xs text-[hsl(var(--status-warning))]">{t('contacts.new.requiredForSgp')}</p>
            )}
            {canPreRegister && preRegOptions && (
              <div className="mt-4 rounded-md border border-border p-3" data-testid="new-contact-contract">
                <div className={`flex flex-wrap gap-4 text-sm${newContract ? ' hidden' : ''}`} role="radiogroup">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="new-contact-mode" checked={!withContract} onChange={() => setWithContract(false)} />
                    {t('contacts.new.clientOnly')}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="new-contact-mode"
                      checked={withContract}
                      onChange={() => {
                        setWithContract(true)
                        setContract((current) => ({
                          ...current,
                          login: current.login || suggestLogin(),
                          password: current.password || suggestPassword()
                        }))
                      }}
                    />
                    {t('contacts.new.withContract')}
                  </label>
                </div>
                {withContract && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="field-label" htmlFor="new-contact-plan">{t('contacts.new.plan')}</label>
                      <select
                        id="new-contact-plan"
                        className="modern-input"
                        value={contract.planId}
                        onChange={(event) => setContract((current) => ({ ...current, planId: event.target.value }))}
                      >
                        <option value="">—</option>
                        {preRegOptions.plans.map((plan) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.name}{plan.id === preRegOptions.suggestedPlanId ? ` · ${t('contacts.new.mostUsed')}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="field-label" htmlFor="new-contact-due">{t('contacts.new.dueDay')}</label>
                      <select
                        id="new-contact-due"
                        className="modern-input"
                        value={contract.dueDayId}
                        onChange={(event) => setContract((current) => ({ ...current, dueDayId: event.target.value }))}
                      >
                        <option value="">—</option>
                        {preRegOptions.dueDays.map((day) => (
                          <option key={day.id} value={day.id}>
                            {day.label}{day.id === preRegOptions.suggestedDueDayId ? ` · ${t('contacts.new.mostUsed')}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="field-label" htmlFor="new-contact-login">{t('contacts.new.login')}</label>
                      <input
                        id="new-contact-login"
                        className="modern-input font-mono"
                        autoComplete="off"
                        value={contract.login}
                        aria-invalid={loginTaken || undefined}
                        onChange={(event) => setContract((current) => ({ ...current, login: event.target.value.replace(/\s/g, '') }))}
                      />
                      {loginTaken && (
                        <p className="mt-1 text-xs text-[hsl(var(--status-warning))]" data-testid="new-contact-login-taken">
                          {t('contacts.new.loginTaken')}
                          {loginCheck?.suggestion && (
                            <>
                              {' '}
                              <button
                                type="button"
                                className="font-semibold underline"
                                onClick={() => setContract((current) => ({ ...current, login: loginCheck.suggestion ?? current.login }))}
                              >
                                {t('contacts.new.useLogin', { login: loginCheck.suggestion })}
                              </button>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="field-label" htmlFor="new-contact-password">{t('contacts.new.password')}</label>
                      <input
                        id="new-contact-password"
                        className="modern-input font-mono"
                        autoComplete="off"
                        value={contract.password}
                        onChange={(event) => setContract((current) => ({ ...current, password: event.target.value }))}
                      />
                    </div>
                    {Boolean(preRegOptions.sellers?.length) && (
                      <div>
                        <label className="field-label" htmlFor="new-contact-seller">{t('contacts.new.seller')}</label>
                        <select
                          id="new-contact-seller"
                          className="modern-input"
                          value={contract.sellerId}
                          onChange={(event) => setContract((current) => ({ ...current, sellerId: event.target.value }))}
                        >
                          <option value="">—</option>
                          {preRegOptions.sellers?.map((seller) => <option key={seller.id} value={seller.id}>{seller.label}</option>)}
                        </select>
                      </div>
                    )}
                    {Boolean(preRegOptions.technicians?.length) && (
                      <div>
                        <label className="field-label" htmlFor="new-contact-technician">{t('contacts.new.technician')}</label>
                        <select
                          id="new-contact-technician"
                          className="modern-input"
                          value={contract.technicianId}
                          onChange={(event) => setContract((current) => ({ ...current, technicianId: event.target.value }))}
                        >
                          <option value="">—</option>
                          {preRegOptions.technicians?.map((tech) => <option key={tech.id} value={tech.id}>{tech.label}</option>)}
                        </select>
                      </div>
                    )}
                    {splitters.length > 0 && (
                      <>
                        <div>
                          <label className="field-label" htmlFor="new-contact-splitter">{t('contacts.new.splitter')}</label>
                          <select
                            id="new-contact-splitter"
                            className="modern-input"
                            value={contract.splitterId}
                            onChange={(event) => setContract((current) => ({ ...current, splitterId: event.target.value, splitterPort: '' }))}
                          >
                            <option value="">—</option>
                            {splitters.map((splitter) => (
                              <option key={splitter.id} value={splitter.id}>
                                {splitter.label}{splitter.distance !== null ? ` · ${formatDistance(splitter.distance)}` : ''}
                              </option>
                            ))}
                          </select>
                          {splitters[0]?.distance !== null && splitters[0]?.distance !== undefined && (
                            <p className="mt-1 text-xs text-muted-foreground">{t('contacts.new.splitterByDistance')}</p>
                          )}
                        </div>
                        <div>
                          <label className="field-label" htmlFor="new-contact-splitter-port">{t('contacts.new.splitterPort')}</label>
                          {chosenSplitter?.ports ? (
                            <select
                              id="new-contact-splitter-port"
                              className="modern-input"
                              value={contract.splitterPort}
                              onChange={(event) => setContract((current) => ({ ...current, splitterPort: event.target.value }))}
                            >
                              <option value="">—</option>
                              {Array.from({ length: chosenSplitter.ports }, (_, index) => index + 1).map((port) => (
                                <option key={port} value={port}>{port}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              id="new-contact-splitter-port"
                              className="modern-input font-mono"
                              inputMode="numeric"
                              disabled={!contract.splitterId}
                              value={contract.splitterPort}
                              onChange={(event) => setContract((current) => ({ ...current, splitterPort: event.target.value.replace(/\D/g, '').slice(0, 3) }))}
                            />
                          )}
                        </div>
                      </>
                    )}
                    <label className="flex items-center gap-2 text-sm sm:col-span-2">
                      <input
                        type="checkbox"
                        checked={contract.installOs}
                        onChange={(event) => setContract((current) => ({ ...current, installOs: event.target.checked }))}
                      />
                      {t('contacts.new.installOs')}
                    </label>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {showForm && riskText.length > 0 && (
          <div className="mt-5 rounded-md border border-[hsl(var(--status-danger))] bg-[hsl(var(--status-danger)/0.08)] p-3 text-sm" role="alert" data-testid="new-contact-risk">
            <p className="font-semibold text-[hsl(var(--status-danger))]">{t('contacts.new.riskWarning')}</p>
            <ul className="mt-1 list-disc ps-5">
              {riskText.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          {showForm && (
            <button
              type="button"
              className="modern-button"
              disabled={saving || !form.name.trim() || (toSgp && missingForSgp) || missingContract}
              onClick={() => void save()}
            >
              {newContract ? t('contacts.new.newContract') : toPreRegister ? t('contacts.new.preRegister') : toSgp ? t('contacts.new.createInSgp') : t('common.save')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
