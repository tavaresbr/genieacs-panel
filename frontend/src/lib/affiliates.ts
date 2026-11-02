import type { TranslationKey } from '@/lib/i18n'

/**
 * O programa de afiliados na tela (0124): o código do link, a taxa em
 * pontos-base, os selos e quais ações cada lote admite.
 *
 * Quem decide o dinheiro é o servidor — a comissão, a janela, o lote e o Pix.
 * Aqui só se lê, formata e esconde o botão que o servidor recusaria.
 */

export type AffiliateStatus = 'pending' | 'active' | 'suspended'
/** `held`: a comissão do afiliado suspenso, guardada até a reativação dentro da janela. */
export type AffiliateCommissionStatus = 'accrued' | 'reversed' | 'in_payout' | 'paid' | 'held'
export type AffiliatePayoutStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'paid' | 'failed' | 'canceled'
export type PixKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP'

export const PIX_KEY_TYPES: PixKeyType[] = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']

/** O código que veio no link (`?aff=`), como o servidor o lê — sempre com `A-` — ou nada. */
export function affiliateCodeFromQuery(valor: string | null | undefined) {
  const texto = String(valor ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')
  const corpo = texto.startsWith('A-') ? texto.slice(2) : texto.replace(/-/g, '')
  return /^[A-Z0-9]{3,13}$/.test(corpo) ? `A-${corpo}` : null
}

/** Pontos-base como porcentagem legível: 1000 → "10", 1250 → "12.5". */
export function bpToPercent(bp: number | null | undefined) {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return ''
  return String(Math.round(bp) / 100)
}

/**
 * A porcentagem digitada como pontos-base: vazio é `null` (vale o padrão), e
 * `undefined` quando não dá para ler ou passa de 100%.
 */
export function percentToBp(digitado: string): number | null | undefined {
  // Porcentagem, não dinheiro: a vírgula decimal vira ponto (não há milhar aqui).
  const texto = String(digitado ?? '').trim().replace(/,/g, '.')
  if (!texto) return null
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(texto)) return undefined
  const bp = Math.round(Number(texto) * 100)
  return bp >= 0 && bp <= 10000 ? bp : undefined
}

/** Meses digitados: vazio é `null`; 1 a 120, ou `undefined`. */
export function parseMonths(digitado: string): number | null | undefined {
  const texto = String(digitado ?? '').trim()
  if (!texto) return null
  const n = Number(texto)
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : undefined
}

/** O token do link de definir senha (`/afiliados#senha=<token>`), ou nulo. */
export function passwordTokenFromHash(hash: string | null | undefined) {
  const m = /(?:^#|&)senha=([0-9a-f]{64})(?:&|$)/.exec(String(hash ?? ''))
  return m ? m[1] : null
}

export const AFFILIATE_STATUS_KEYS: Record<AffiliateStatus, TranslationKey> = {
  pending: 'affiliates.status.pending',
  active: 'affiliates.status.active',
  suspended: 'affiliates.status.suspended'
}

export const COMMISSION_STATUS_KEYS: Record<AffiliateCommissionStatus, TranslationKey> = {
  accrued: 'affiliates.commissionStatus.accrued',
  reversed: 'affiliates.commissionStatus.reversed',
  in_payout: 'affiliates.commissionStatus.in_payout',
  paid: 'affiliates.commissionStatus.paid',
  held: 'affiliates.commissionStatus.held'
}

export const PAYOUT_STATUS_KEYS: Record<AffiliatePayoutStatus, TranslationKey> = {
  draft: 'affiliates.payouts.status.draft',
  approved: 'affiliates.payouts.status.approved',
  sending: 'affiliates.payouts.status.sending',
  sent: 'affiliates.payouts.status.sent',
  paid: 'affiliates.payouts.status.paid',
  failed: 'affiliates.payouts.status.failed',
  canceled: 'affiliates.payouts.status.canceled'
}

export function affiliateBadgeClass(status: string) {
  if (status === 'active' || status === 'paid') return 'modern-badge-success'
  if (status === 'pending' || status === 'draft' || status === 'approved' || status === 'sent' || status === 'sending' || status === 'in_payout') return 'modern-badge-warning'
  if (status === 'failed' || status === 'suspended') return 'modern-badge-error'
  return 'modern-badge'
}

/** O que cada lote admite agora — o mesmo que o servidor aceita (`affiliatePayoutService`). */
export function payoutActions(payout: {
  status: AffiliatePayoutStatus | string
  errorCode?: string | null
  amountCents: number
  pixKeyChanged?: boolean
}) {
  const s = payout.status
  // A chave Pix trocada depois da aprovação: o envio espera nova aprovação.
  const reaprovar = Boolean(payout.pixKeyChanged) && (s === 'approved' || s === 'failed')
  return {
    approve: (s === 'draft' && payout.amountCents > 0) || reaprovar,
    reapprove: reaprovar,
    send: s === 'approved' && !reaprovar,
    retry: s === 'failed' && !reaprovar,
    /** O reenvio (e o cancelamento) do falho incerto pede a confirmação de que nada saiu. */
    needsConfirm: s === 'failed' && payout.errorCode === 'uncertain',
    refresh: s === 'sent',
    markPaid: s === 'approved' || s === 'failed' || s === 'sent',
    cancel: s === 'draft' || s === 'approved' || s === 'failed'
  }
}
