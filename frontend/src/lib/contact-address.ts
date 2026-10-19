/**
 * The address blocks of the client record's edit form, and what a CEP lookup
 * does to one of them.
 */

export const ADDRESS_FORM_PARTS = [
  'street', 'number', 'complement', 'district', 'city', 'state', 'zip', 'reference'
] as const

export type AddressForm = Record<(typeof ADDRESS_FORM_PARTS)[number], string>

export const emptyAddressForm = (): AddressForm =>
  Object.fromEntries(ADDRESS_FORM_PARTS.map((part) => [part, ''])) as AddressForm

/** `68181190` → `68181-190`, as typed. */
export const maskCep = (value: string) => value.replace(/\D/g, '').slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2')

export interface CepFound {
  addressLine?: string
  district?: string
  city?: string
  state?: string
}

/**
 * What the CEP knows put into an address block. Number and complement are the
 * operator's and never change. When the CEP is a new one (`replace`), what it
 * knows replaces the street, district, city and state — but only with values
 * it actually has: a city-wide CEP has no street and must not wipe the one
 * typed. With the same CEP, it only completes what is still empty.
 */
export function applyCep(current: AddressForm, found: CepFound, replace: boolean): AddressForm {
  const pick = (own: string, known: string | undefined) => (known && (replace || !own.trim()) ? known : own)
  return {
    ...current,
    street: pick(current.street, found.addressLine),
    district: pick(current.district, found.district),
    city: pick(current.city, found.city),
    state: pick(current.state, found.state)
  }
}

/** The block as the API takes it: trimmed, empty parts left out. */
export const addressPayload = (form: AddressForm) =>
  Object.fromEntries(ADDRESS_FORM_PARTS.map((part) => [part, form[part].trim()]).filter(([, value]) => value))

export const addressFormFrom = (address: (Partial<Record<(typeof ADDRESS_FORM_PARTS)[number], string>> & { line?: string }) | null | undefined): AddressForm => {
  const value = address ?? {}
  return Object.fromEntries(ADDRESS_FORM_PARTS.map((part) => [
    part, part === 'street' && !value.street && value.line ? value.line : (value[part] ?? '')
  ])) as AddressForm
}

export const sameAddress = (a: AddressForm, b: AddressForm) =>
  ADDRESS_FORM_PARTS.every((part) => a[part].trim() === b[part].trim())
