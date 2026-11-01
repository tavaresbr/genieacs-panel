import type { ReminderChannel, ReminderPolicy, ReminderStep, ReminderStepKind } from '@/lib/api'

/**
 * A régua de cobrança (0121) do lado da tela: as mesmas regras de
 * `backend/src/services/reminderPolicy.js`, para a tela recusar antes de
 * mandar — quem decide continua sendo o servidor — e a pré-visualização com
 * dados de exemplo.
 */

export const REMINDER_MAX_STEPS = 8
export const REMINDER_SUBJECT_MAX = 150
export const REMINDER_BODY_MAX = 2000
export const REMINDER_CHANNELS: readonly ReminderChannel[] = ['whatsapp', 'email']
export const REMINDER_KINDS: readonly ReminderStepKind[] = ['before', 'due', 'after']
export const REMINDER_VARIABLES = ['empresa', 'valor', 'vencimento', 'link', 'plano'] as const
export type ReminderVariable = typeof REMINDER_VARIABLES[number]

/** Os dias em relação ao vencimento que cada tipo aceita. */
export const REMINDER_OFFSETS: Record<ReminderStepKind, { min: number; max: number }> = {
  before: { min: -30, max: -1 },
  due: { min: 0, max: 0 },
  after: { min: 1, max: 60 }
}

const ID_RE = /^[a-z0-9_-]{1,16}$/
const RESERVED_IDS = ['suspwarn', 'suspend', 'suspended', 'manual', 'suspension_warning']

/** O código de erro de um passo, como o servidor o responderia. */
export type ReminderStepError =
  | 'invalid_step_id'
  | 'duplicate_step_id'
  | 'invalid_offset'
  | 'invalid_channels'
  | 'subject_too_long'
  | 'body_too_long'
  | 'too_many_steps'

/** O primeiro erro da régua, com o índice do passo — ou nulo. */
export function validateReminderPolicy(policy: ReminderPolicy): { code: ReminderStepError; index: number | null } | null {
  if (policy.steps.length > REMINDER_MAX_STEPS) return { code: 'too_many_steps', index: null }
  const ids = new Set<string>()
  for (const [index, step] of policy.steps.entries()) {
    if (!ID_RE.test(step.id) || RESERVED_IDS.includes(step.id)) return { code: 'invalid_step_id', index }
    if (ids.has(step.id)) return { code: 'duplicate_step_id', index }
    ids.add(step.id)
    const faixa = REMINDER_OFFSETS[step.kind]
    if (!Number.isInteger(step.offsetDays) || step.offsetDays < faixa.min || step.offsetDays > faixa.max) {
      return { code: 'invalid_offset', index }
    }
    if (step.enabled && !step.channels.length) return { code: 'invalid_channels', index }
    if (step.subject.trim().length > REMINDER_SUBJECT_MAX) return { code: 'subject_too_long', index }
    if (step.body.length > REMINDER_BODY_MAX) return { code: 'body_too_long', index }
  }
  return null
}

/** Os dias que o tipo novo aceita, partindo dos de agora. */
export function offsetForKind(kind: ReminderStepKind, atual: number): number {
  const { min, max } = REMINDER_OFFSETS[kind]
  if (kind === 'due') return 0
  const dias = Math.abs(atual) || (kind === 'before' ? 5 : 3)
  const comSinal = kind === 'before' ? -dias : dias
  return Math.min(max, Math.max(min, comSinal))
}

/**
 * Um id novo, curto e que nunca existiu: `p` + o instante em base 36 (`p` +
 * 8 caracteres, até 16 com o desempate). O id é a chave da deduplicação no
 * servidor — um `passo1` apagado e recriado com o mesmo nome contaria como
 * já enviado no prazo de agora. Sem colidir com os da régua na tela.
 */
export function newStepId(steps: ReminderStep[], now: number = Date.now()): string {
  const usados = new Set(steps.map((s) => s.id))
  const base = `p${Math.max(0, Math.floor(now)).toString(36)}`.slice(0, 13)
  if (!usados.has(base)) return base
  for (let n = 1; ; n += 1) {
    const id = `${base}-${n}`
    if (!usados.has(id)) return id
  }
}

/** O passo novo do "Adicionar": depois do vencimento, um dia depois do último. */
export function newStep(steps: ReminderStep[], now: number = Date.now()): ReminderStep {
  const maior = steps.reduce((m, s) => Math.max(m, s.offsetDays), 0)
  return {
    id: newStepId(steps, now),
    kind: 'after',
    offsetDays: Math.min(REMINDER_OFFSETS.after.max, Math.max(1, maior + 1)),
    channels: ['whatsapp', 'email'],
    enabled: true,
    subject: '',
    body: ''
  }
}

/** Ordenados pelo dia, como o servidor grava (estável). */
export function sortSteps(steps: ReminderStep[]): ReminderStep[] {
  return steps.map((s, i) => [s, i] as const)
    .sort((a, b) => a[0].offsetDays - b[0].offsetDays || a[1] - b[1])
    .map(([s]) => s)
}

/** A mesma limpeza do servidor: uma linha, sem controle e sem `<`/`>`. */
export function sanitizeReminderValue(valor: string): string {
  return String(valor ?? '')
    // eslint-disable-next-line no-control-regex -- é justamente o que se tira
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** Troca as variáveis numa passada só; as chaves desconhecidas ficam. Texto puro. */
export function renderReminderTemplate(template: string, valores: Partial<Record<ReminderVariable, string>>): string {
  return String(template ?? '').replace(/\{(empresa|valor|vencimento|link|plano)\}/g,
    (_, nome: ReminderVariable) => sanitizeReminderValue(valores[nome] ?? ''))
}

/** Os dados de exemplo da pré-visualização (os mesmos do "Enviar teste"). */
export function sampleValues(offsetDays: number, now: Date = new Date()): Record<ReminderVariable, string> {
  const prazo = new Date(now.getTime() - offsetDays * 86_400_000)
  return {
    empresa: 'Provedor Exemplo',
    valor: 'R$ 199,90',
    vencimento: prazo.toISOString().slice(0, 10),
    link: 'https://painel.exemplo.com/fatura',
    plano: 'Pro'
  }
}

/** Insere `{variavel}` no texto, na posição do cursor (ou no fim). */
export function insertVariable(texto: string, variavel: ReminderVariable, posicao?: number | null): { text: string; caret: number } {
  const marca = `{${variavel}}`
  const em = posicao == null || posicao < 0 || posicao > texto.length ? texto.length : posicao
  return { text: texto.slice(0, em) + marca + texto.slice(em), caret: em + marca.length }
}

/** Se duas réguas são a mesma (para o "nada mudou" e o aviso de não salvo). */
export function samePolicy(a: ReminderPolicy | null | undefined, b: ReminderPolicy | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
