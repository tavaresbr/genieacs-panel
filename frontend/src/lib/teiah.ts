/** The badge class for a TeiaH risk band: low is green, high is red, anything else amber. */
export function riskBadge(risk: string | null | undefined): string {
  const value = (risk ?? '').toUpperCase()
  if (value.startsWith('BAIX') || value.startsWith('LOW')) return 'modern-badge-success'
  if (value.startsWith('ALT') || value.startsWith('HIGH')) return 'modern-badge-error'
  return 'modern-badge-warning'
}
