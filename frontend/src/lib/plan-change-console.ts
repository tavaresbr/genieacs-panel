import type {
  ConsolePlanChangeOutcome,
  ConsolePlanPreview,
  PlanChangeMode,
  PlanChangePreview
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import type { PlanChangeKind } from '@/lib/plan-options'

/**
 * As contas da troca de plano pelo console que a tela faz em cima da prévia
 * do servidor (`GET .../subscription/plan-preview`). Nenhuma regra nova: a
 * decisão é do servidor, e isto só escolhe o que mostrar e quando o botão
 * pode ser apertado — o servidor recusa do mesmo jeito o que passar daqui.
 */

/** O que o modo escolhido faria, ou nulo (o `renewal` sem período pago correndo). */
export function previewForMode(preview: ConsolePlanPreview | null | undefined, mode: PlanChangeMode) {
  return preview?.modes?.[mode] ?? null
}

/** Se o motivo é obrigatório: forçar agora o que iria para a renovação, ou pular o limite. */
export function reasonRequired(
  preview: ConsolePlanPreview | null | undefined,
  mode: PlanChangeMode,
  skipLimitCheck: boolean
) {
  if (skipLimitCheck) return true
  return mode === 'now' && Boolean(preview?.reasonRequiredForNow)
}

/** Se o uso acima dos tetos barra a troca no modo escolhido — só a que vale agora. */
export function limitBlocks(
  preview: ConsolePlanPreview | null | undefined,
  mode: PlanChangeMode,
  skipLimitCheck: boolean
) {
  const doModo = previewForMode(preview, mode)
  return Boolean(doModo && doModo.timing === 'now' && (preview?.overLimit?.length ?? 0) > 0 && !skipLimitCheck)
}

/**
 * Se a troca vai substituir (ou desfazer) uma troca agendada — e portanto
 * pede o "substituir" explícito, ou o servidor responde `pending_change`.
 * Pedir a MESMA agendada de novo não substitui nada.
 */
export function replacesPending(
  preview: ConsolePlanPreview | null | undefined,
  mode: PlanChangeMode
) {
  const pendente = preview?.pending
  if (!pendente) return false
  const doModo = previewForMode(preview, mode)
  const mesma = pendente.planId === preview?.planId && pendente.cycle === preview?.cycle
  return !(mesma && doModo?.timing === 'renewal')
}

/** O plano e o ciclo escolhidos são os de agora, sem nada agendado: não há o que trocar. */
export function isNoop(preview: ConsolePlanPreview | null | undefined) {
  return preview?.direction === 'none' && !preview?.pending
}

/** Se o botão de aplicar pode ser apertado com o que está na tela. */
export function canApply(
  preview: ConsolePlanPreview | null | undefined,
  { mode, reason, skipLimitCheck, replacePending }: {
    mode: PlanChangeMode; reason: string; skipLimitCheck: boolean; replacePending: boolean
  }
) {
  if (!preview || isNoop(preview)) return false
  if (preview.blockers.length > 0) return false
  if (!previewForMode(preview, mode)) return false
  if (reasonRequired(preview, mode, skipLimitCheck) && !reason.trim()) return false
  if (limitBlocks(preview, mode, skipLimitCheck)) return false
  if (replacesPending(preview, mode) && !replacePending) return false
  return true
}

/** A chave da frase do "quando" de uma prévia. */
export function timingKey(previa: PlanChangePreview): TranslationKey {
  if (previa.timing === 'renewal') {
    return previa.deferredByUpgrade ? 'platform.planChange.timingDeferred' : 'platform.planChange.timingRenewal'
  }
  return 'platform.planChange.timingNow'
}

/** A frase do resultado da troca, para o aviso depois do clique. */
export function outcomeKey(outcome: ConsolePlanChangeOutcome | null | undefined): TranslationKey {
  if (!outcome) return 'platform.subs.planChanged'
  if (outcome.pendingCanceled) return 'platform.planChange.outcomePendingCanceled'
  if (outcome.scheduled) return 'platform.planChange.outcomeScheduled'
  if (!outcome.changed) return 'platform.planChange.outcomeUnchanged'
  return 'platform.planChange.outcomeNow'
}

/** A frase da pró-rata no resultado, ou nula quando não houve o que cobrar. */
export function outcomeProrationKey(outcome: ConsolePlanChangeOutcome | null | undefined): TranslationKey | null {
  const p = outcome?.proration
  if (!p) return null
  if (p.issued) return 'platform.planChange.prorationIssued'
  if (p.skipped === 'waived') return 'platform.planChange.prorationWaived'
  if (p.skipped === 'below_minimum') return 'plan.proration.belowMinimum'
  if (p.skipped === 'cycle_change') return 'platform.planChange.prorationCycle'
  return 'platform.planChange.prorationPending'
}

/**
 * O tipo de troca que a confirmação do PROVEDOR anuncia, a partir da prévia
 * que o servidor mandou na lista de planos (`changes`): quem decide "agora ou
 * na renovação" é a mesma regra da troca, e não uma conta refeita aqui.
 */
export function kindFromPreview(previa: PlanChangePreview): Exclude<PlanChangeKind, 'same'> {
  if (previa.timing === 'renewal') return previa.cycle !== previa.cycleFrom ? 'cycle-scheduled' : 'downgrade-scheduled'
  if (previa.direction === 'downgrade') return 'downgrade-now'
  return 'upgrade'
}
