/**
 * Um CPF ou CNPJ como se lê: 12345678900 → 123.456.789-00 e
 * 12345678000199 → 12.345.678/0001-99. Qualquer outro tamanho sai como veio.
 */
export function formatDocument(value: string | null | undefined): string {
  const raw = String(value ?? '')
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
  if (digits.length === 14) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
  return raw
}
