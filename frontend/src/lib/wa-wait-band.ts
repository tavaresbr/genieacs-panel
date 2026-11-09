/**
 * A cor da faixa lateral da lista de conversas: o TEMPO DE ESPERA do cliente.
 *
 * Antes a marca era a situação do pagamento, que não muda quando se responde, e
 * a equipe não distinguia quem já foi atendido. Agora ela só existe enquanto o
 * cliente espera (`awaitingSince`: falou por último e ninguém respondeu) e
 * esquenta com o tempo: verde até 5 minutos, amarela até 15, vermelha depois.
 */
export const WAIT_WARN_MIN = 5
export const WAIT_LATE_MIN = 15

export type WaitBand = 'ok' | 'warn' | 'late'

/** `null` quando ninguém espera (já respondido): sem faixa. */
export function waitBand(minutes: number | null | undefined): WaitBand | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null
  if (minutes <= WAIT_WARN_MIN) return 'ok'
  if (minutes <= WAIT_LATE_MIN) return 'warn'
  return 'late'
}

// Classes escritas por inteiro: o Tailwind só gera o que aparece no código.
/** A faixa larga à esquerda da linha. */
export const WAIT_BAR: Record<WaitBand, string> = {
  ok: 'bg-[hsl(var(--status-success))]',
  warn: 'bg-[hsl(var(--status-warning))]',
  late: 'bg-[hsl(var(--status-danger))]'
}

/** O selo "Esperando N min": a mesma cor da faixa. */
export const WAIT_BADGE: Record<WaitBand, string> = {
  ok: 'border-[hsl(var(--status-success)/0.5)] bg-[hsl(var(--status-success)/0.12)] text-[hsl(var(--status-success))]',
  warn: 'border-[hsl(var(--status-warning)/0.6)] bg-[hsl(var(--status-warning)/0.14)] text-[hsl(var(--status-warning))]',
  late: 'border-[hsl(var(--status-danger)/0.6)] bg-[hsl(var(--status-danger)/0.12)] text-[hsl(var(--status-danger))]'
}
