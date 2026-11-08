/** The badge class for a TeiaH risk band: low is green, high is red, anything else amber. */
export function riskBadge(risk: string | null | undefined): string {
  const value = (risk ?? '').toUpperCase()
  if (value.startsWith('BAIX') || value.startsWith('LOW')) return 'modern-badge-success'
  if (value.startsWith('ALT') || value.startsWith('HIGH')) return 'modern-badge-error'
  return 'modern-badge-warning'
}

/** Whether a TeiaH risk band is the high one (the red badge). */
export function isHighRisk(risk: string | null | undefined): boolean {
  return riskBadge(risk) === 'modern-badge-error'
}

export type TeiahRiskReason =
  | { kind: 'cpf'; score: number | null; risk: string }
  | { kind: 'address'; score: number | null; risk: string }
  | { kind: 'debts'; count: number | null; amount: number | null }

/**
 * Why a registration deserves a second look before it goes to the SGP: the
 * CPF/CNPJ or the installation address with a high TeiaH risk, or debts found
 * at the address. Empty when there is nothing to warn about.
 */
export function teiahRiskWarnings({ cpf, address }: {
  cpf?: { score?: number | null; risk?: string | null } | null
  address?: { found?: boolean; score?: number | null; risk?: string | null; debtCount?: number | null; debtAmount?: number | null } | null
}): TeiahRiskReason[] {
  const reasons: TeiahRiskReason[] = []
  if (cpf?.risk && isHighRisk(cpf.risk)) reasons.push({ kind: 'cpf', score: cpf.score ?? null, risk: cpf.risk })
  if (address?.found !== false && address) {
    if (address.risk && isHighRisk(address.risk)) reasons.push({ kind: 'address', score: address.score ?? null, risk: address.risk })
    if ((address.debtCount ?? 0) > 0 || (address.debtAmount ?? 0) > 0) {
      reasons.push({ kind: 'debts', count: address.debtCount ?? null, amount: address.debtAmount ?? null })
    }
  }
  return reasons
}
