/**
 * O cadastro de cada pessoa da equipe: máscaras, validação e o corpo do PATCH.
 *
 * O servidor guarda só dígitos (CPF, telefone, CEP) e é quem decide em última
 * instância — `utils/operatorProfileValidation.js`. A validação daqui só poupa
 * a ida ao servidor e aponta o campo errado; o algoritmo do CPF é o mesmo.
 */
import type { Operator, OperatorProfile } from '@/lib/api'
import { maskCep } from '@/lib/contact-address'

export const onlyDigits = (value: string | null | undefined) => String(value ?? '').replace(/\D/g, '')

/** `52998224725` → `529.982.247-25`, enquanto se digita. */
export function maskCpf(value: string | null | undefined): string {
  const d = onlyDigits(value).slice(0, 11)
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4')
}

/**
 * `11912345678` → `(11) 91234-5678`; `5511912345678` → `+55 (11) 91234-5678`.
 * O servidor aceita de 10 a 13 dígitos (com ou sem o 55 na frente).
 */
export function maskPhone(value: string | null | undefined): string {
  let d = onlyDigits(value).slice(0, 13)
  let prefix = ''
  if (d.length > 11 && d.startsWith('55')) {
    prefix = '+55 '
    d = d.slice(2)
  }
  if (d.length <= 2) return d ? `${prefix}(${d}` : prefix.trim()
  const ddd = d.slice(0, 2)
  const rest = d.slice(2)
  const cut = rest.length > 8 ? 5 : 4
  const body = rest.length > cut ? `${rest.slice(0, cut)}-${rest.slice(cut)}` : rest
  return `${prefix}(${ddd}) ${body}`
}

/** CPF com os dois dígitos verificadores; recusa as sequências repetidas. */
export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value)
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false
  for (const size of [9, 10]) {
    let sum = 0
    for (let i = 0; i < size; i += 1) sum += Number(cpf[i]) * (size + 1 - i)
    if (((sum * 10) % 11) % 10 !== Number(cpf[size])) return false
  }
  return true
}

export const isValidPhone = (value: string) => {
  const d = onlyDigits(value)
  return d.length >= 10 && d.length <= 13
}

export const FORM_KEYS = [
  'fullName', 'birthDate', 'rg', 'cpf', 'phone', 'whatsapp', 'personalEmail',
  'zip', 'street', 'number', 'complement', 'district', 'city', 'state',
  'jobTitle', 'admittedAt', 'emergencyName', 'emergencyPhone', 'notes'
] as const

export type ProfileFormKey = (typeof FORM_KEYS)[number]
export type ProfileForm = Record<ProfileFormKey, string>

/** Campos que o formulário mostra com máscara e o servidor guarda como dígitos. */
const MASKED: Partial<Record<ProfileFormKey, (value: string) => string>> = {
  cpf: maskCpf, phone: maskPhone, whatsapp: maskPhone, emergencyPhone: maskPhone, zip: maskCep
}

export const maskField = (key: ProfileFormKey, value: string) => (MASKED[key] ? MASKED[key]!(value) : value)

export const emptyProfileForm = (): ProfileForm =>
  Object.fromEntries(FORM_KEYS.map((key) => [key, ''])) as ProfileForm

/** O formulário a partir do que o servidor devolveu (campos ausentes viram vazio). */
export function profileFormFrom(profile: Partial<OperatorProfile> | null | undefined): ProfileForm {
  const form = emptyProfileForm()
  if (!profile) return form
  for (const key of FORM_KEYS) {
    const raw = profile[key]
    form[key] = maskField(key, typeof raw === 'string' ? raw : '')
  }
  return form
}

/** Normaliza para comparar: o que importa é o que o servidor guardaria. */
const comparable = (key: ProfileFormKey, value: string) => (
  MASKED[key] ? onlyDigits(value) : value.trim()
)

/**
 * O corpo do PATCH: só o que mudou em relação ao carregado. Vazio vira `null`
 * (apaga); CPF, telefone e CEP vão só com dígitos.
 */
export function profilePayload(form: ProfileForm, initial: ProfileForm): Record<string, string | null> {
  const body: Record<string, string | null> = {}
  for (const key of FORM_KEYS) {
    const now = comparable(key, form[key])
    if (now === comparable(key, initial[key])) continue
    body[key] = now === '' ? null : now
  }
  return body
}

/** A chave de i18n do primeiro campo inválido, ou `null`. */
export function profileProblem(form: ProfileForm): { key: ProfileFormKey; message: string } | null {
  if (form.cpf.trim() && !isValidCpf(form.cpf)) return { key: 'cpf', message: 'settings.operators.profile.cpfInvalid' }
  for (const key of ['phone', 'whatsapp', 'emergencyPhone'] as const) {
    if (form[key].trim() && !isValidPhone(form[key])) return { key, message: 'settings.operators.profile.phoneInvalid' }
  }
  if (form.zip.trim() && onlyDigits(form.zip).length !== 8) return { key: 'zip', message: 'settings.operators.profile.zipInvalid' }
  if (form.personalEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.personalEmail.trim())) {
    return { key: 'personalEmail', message: 'settings.operators.profile.emailInvalid' }
  }
  return null
}

/** Minúsculas e sem acento: "joao" acha "João". */
const fold = (value: string | null | undefined) =>
  String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/**
 * A busca da lista de operadores: cada palavra digitada tem que aparecer em
 * algum de usuário, e-mail, nome completo ou cargo (nenhuma ordem importa).
 * Busca vazia devolve a lista como veio.
 */
export function filterOperators(operators: Operator[], query: string): Operator[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return operators
  return operators.filter((operator) => {
    const haystack = fold([operator.username, operator.email, operator.profile?.fullName, operator.profile?.jobTitle].join(' '))
    return words.every((word) => haystack.includes(word))
  })
}
