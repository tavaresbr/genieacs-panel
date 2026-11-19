/**
 * A lista de quem recebe os alertas (números de plantão e e-mails), um item por
 * vez. Funções puras: o vitest do projeto roda em `node`, e a regra de "o que
 * é um número" tem de bater com a do servidor (`normalizarTelefoneBr`), que é
 * quem decide no fim; aqui ela só avisa na hora, antes de salvar.
 */

export const MAX_RECIPIENTS = 20

export type RecipientError = 'empty' | 'short' | 'long' | 'invalid' | 'duplicate' | 'max'

export type PhoneParse = { ok: true; value: string } | { ok: false; error: 'empty' | 'short' | 'long' }

/**
 * O que a pessoa digitou, como número guardado (só dígitos, com o código do país).
 * Sem "+" vale o Brasil: DDD + telefone (10 ou 11 dígitos) ganha o 55; quem já
 * digitou o 55 (12 ou 13 dígitos) fica como está. Com "+" e outro país (não 55),
 * de 8 a 15 dígitos vale como veio.
 */
export function parsePhone(input: string): PhoneParse {
  const text = String(input ?? '').trim()
  const digits = text.replace(/\D/g, '')
  if (!digits) return { ok: false, error: 'empty' }
  if (text.startsWith('+') && !digits.startsWith('55')) {
    if (digits.length < 8) return { ok: false, error: 'short' }
    if (digits.length > 15) return { ok: false, error: 'long' }
    return { ok: true, value: digits }
  }
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return { ok: true, value: digits }
  if (digits.length === 10 || digits.length === 11) return { ok: true, value: `55${digits}` }
  return { ok: false, error: digits.length < 10 ? 'short' : 'long' }
}

/** `5593981215425` → `+55 (93) 98121-5425`; fora do Brasil, `+` e os dígitos. */
export function formatPhone(stored: string): string {
  const d = String(stored ?? '').replace(/\D/g, '')
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4)
    const local = d.slice(4)
    const cut = local.length - 4
    return `+55 (${ddd}) ${local.slice(0, cut)}-${local.slice(cut)}`
  }
  return d ? `+${d}` : ''
}

/** E-mail em minúsculas, ou `null` se não parece um. */
export function parseEmail(input: string): string | null {
  const value = String(input ?? '').trim().toLowerCase()
  if (!value || value.length > 254) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null
}

export type AddResult = { ok: true; list: string[]; value: string } | { ok: false; error: RecipientError }

/** Acrescenta um item à lista, ou diz por que não deu. */
export function addRecipient(kind: 'phone' | 'email', list: readonly string[], input: string, max = MAX_RECIPIENTS): AddResult {
  let value: string
  if (kind === 'phone') {
    const parsed = parsePhone(input)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    value = parsed.value
  } else {
    if (!String(input ?? '').trim()) return { ok: false, error: 'empty' }
    const email = parseEmail(input)
    if (!email) return { ok: false, error: 'invalid' }
    value = email
  }
  if (list.includes(value)) return { ok: false, error: 'duplicate' }
  if (list.length >= max) return { ok: false, error: 'max' }
  return { ok: true, list: [...list, value], value }
}

export function removeRecipient(list: readonly string[], value: string): string[] {
  return list.filter((item) => item !== value)
}
