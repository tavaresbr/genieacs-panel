import crypto from 'node:crypto';

/**
 * A régua de cobrança configurável (0121): os passos que avisam o provedor
 * antes, no dia e depois do prazo — e o texto de cada um.
 *
 * Puro, sem banco: o console grava a régua em `platformProfileService`
 * (`reminderPolicy`), o agendador a lê, e as contas — validação, janelas,
 * modelo de texto e a chave de deduplicação — moram aqui, para as três pontas
 * (console, régua e emissão) fazerem a MESMA conta.
 *
 * ## O passo
 *
 *   id          slug curto (a-z, 0-9, `_`, `-`; até 16) e único — é a chave da
 *               deduplicação (`subscription_reminder_sends.step_key`). Mudar
 *               os dias de um passo sem mudar o id NÃO o reenvia no mesmo prazo.
 *   kind        before | due | after.
 *   offsetDays  before: −30..−1; due: 0; after: 1..60 (dias em relação ao prazo).
 *   channels    whatsapp e/ou email; não vazio quando ligado.
 *   enabled     desligado não sai, e não conta para as janelas dos outros.
 *   subject     até 150; vazio usa o texto padrão do i18n.
 *   body        até 2000; vazio usa o texto padrão do i18n.
 *
 * ## A janela de cada passo
 *
 * Um passo sai a partir de `prazo + offsetDays` e até o PRÓXIMO passo ligado
 * (o de offset maior seguinte), com um teto de `REMINDER_WINDOW_MAX_DAYS` dias.
 * O `before` nunca passa do prazo (dizer "vence em…" a quem venceu é pior que
 * não dizer nada), e o `after` só sai enquanto ninguém pagou (`past_due`).
 * A régua padrão (−5, 0, +3) dá exatamente as janelas de antes: before de −5
 * ao prazo, due do prazo a +3, after de +3 a +10.
 *
 * O passo cuja janela passou sem sair (o agendador parado, o SMTP fora) não
 * sai atrasado — a mesma regra de sempre.
 */

export const REMINDER_KINDS = Object.freeze(['before', 'due', 'after']);
export const REMINDER_CHANNELS = Object.freeze(['whatsapp', 'email']);
export const REMINDER_MAX_STEPS = 8;
export const REMINDER_WINDOW_MAX_DAYS = 7;
export const REMINDER_SUBJECT_MAX = 150;
export const REMINDER_BODY_MAX = 2000;
export const REMINDER_ID_MAX = 16;
/** As variáveis dos textos, sem chaves: `{empresa}` etc. */
export const REMINDER_VARIABLES = Object.freeze(['empresa', 'valor', 'vencimento', 'link', 'plano']);
export const REMINDER_OFFSETS = Object.freeze({
  before: { min: -30, max: -1 },
  due: { min: 0, max: 0 },
  after: { min: 1, max: 60 }
});

/**
 * Os valores que a coluna `step` (oito caracteres, 0092) já guarda e que
 * continuam sendo dela: os três passos da régua padrão e as etapas fora da
 * régua (suspensão automática e o lembrete manual). Um passo da régua não
 * pode ter id com esses nomes de fora.
 */
const LEGACY_STEP_VALUES = Object.freeze(['before', 'due', 'after', 'suspwarn', 'suspend', 'manual']);
const RESERVED_IDS = Object.freeze(['suspwarn', 'suspend', 'suspended', 'manual', 'suspension_warning']);

const ID_RE = /^[a-z0-9_-]{1,16}$/;

/** A régua de hoje, passo a passo: os ids são os nomes antigos de `step`. */
export function defaultReminderPolicy() {
  return {
    steps: [
      { id: 'before', kind: 'before', offsetDays: -5, channels: ['whatsapp', 'email'], enabled: true, subject: '', body: '' },
      { id: 'due', kind: 'due', offsetDays: 0, channels: ['whatsapp', 'email'], enabled: true, subject: '', body: '' },
      { id: 'after', kind: 'after', offsetDays: 3, channels: ['whatsapp', 'email'], enabled: true, subject: '', body: '' }
    ]
  };
}

export class ReminderPolicyError extends Error {
  constructor(message, { code, index = null } = {}) {
    super(message);
    this.name = 'ReminderPolicyError';
    this.code = code;
    this.index = index;
  }
}

/**
 * O valor da coluna `step` para o passo `stepKey`. Os nomes antigos ficam
 * como estão — um registro `before` de antes da 0121 é o passo `before` de
 * agora, e não sai de novo. Os outros ganham um código curto derivado do id
 * (`p` + sete caracteres), para o índice único antigo `(tenant_id, due_at,
 * step)`, que continua existindo, não confundir dois passos `before`
 * personalizados no mesmo prazo. A chave que vale é `step_key`.
 */
export function reminderStepColumn(stepKey) {
  const chave = String(stepKey);
  if (LEGACY_STEP_VALUES.includes(chave)) return chave;
  const hex = crypto.createHash('sha256').update(chave).digest('hex').slice(0, 12);
  return `p${BigInt(`0x${hex}`).toString(36).padStart(7, '0').slice(-7)}`;
}

const erro = (message, code, index = null) => new ReminderPolicyError(message, { code, index });

/** Uma linha de texto: sem quebra (é o assunto do e-mail), aparada. */
const umaLinha = (texto) => texto.replace(/[\r\n\t]+/g, ' ').trim();

/**
 * A régua recebida → a régua a gravar (passos ordenados pelo offset, estável).
 * Lança `ReminderPolicyError` com `code` e o índice do passo.
 */
export function normalizeReminderPolicy(bruto) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto) || !Array.isArray(bruto.steps)) {
    throw erro('reminderPolicy must be an object with a steps list', 'invalid_policy');
  }
  if (bruto.steps.length > REMINDER_MAX_STEPS) {
    throw erro(`reminderPolicy accepts at most ${REMINDER_MAX_STEPS} steps`, 'too_many_steps');
  }
  const ids = new Set();
  const colunas = new Set();
  const passos = bruto.steps.map((passo, index) => {
    if (!passo || typeof passo !== 'object' || Array.isArray(passo)) throw erro('Invalid step', 'invalid_step', index);
    const id = typeof passo.id === 'string' ? passo.id.trim() : '';
    if (!ID_RE.test(id) || RESERVED_IDS.includes(id)) {
      throw erro('Step id must be 1-16 characters of a-z, 0-9, _ or -', 'invalid_step_id', index);
    }
    if (ids.has(id)) throw erro(`Duplicate step id: ${id}`, 'duplicate_step_id', index);
    ids.add(id);
    const coluna = reminderStepColumn(id);
    if (colunas.has(coluna)) throw erro(`Step id collides with another: ${id}`, 'duplicate_step_id', index);
    colunas.add(coluna);

    if (!REMINDER_KINDS.includes(passo.kind)) throw erro('Step kind must be before, due or after', 'invalid_kind', index);
    const faixa = REMINDER_OFFSETS[passo.kind];
    const dias = passo.offsetDays;
    if (!Number.isInteger(dias) || dias < faixa.min || dias > faixa.max) {
      throw erro(`offsetDays of a ${passo.kind} step must be from ${faixa.min} to ${faixa.max}`, 'invalid_offset', index);
    }
    let enabled = true;
    if (passo.enabled !== undefined) {
      if (typeof passo.enabled !== 'boolean') throw erro('enabled must be a boolean', 'invalid_enabled', index);
      enabled = passo.enabled;
    }
    if (!Array.isArray(passo.channels) || passo.channels.some((c) => !REMINDER_CHANNELS.includes(c))) {
      throw erro('channels must be a list of whatsapp and email', 'invalid_channels', index);
    }
    const channels = REMINDER_CHANNELS.filter((c) => passo.channels.includes(c));
    if (enabled && !channels.length) throw erro('An enabled step needs at least one channel', 'invalid_channels', index);

    const texto = (campo, max, codigo) => {
      const valor = passo[campo];
      if (valor === undefined || valor === null) return '';
      if (typeof valor !== 'string') throw erro(`${campo} must be text`, `invalid_${campo}`, index);
      const limpo = campo === 'subject' ? umaLinha(valor) : valor.replace(/\r\n?/g, '\n');
      if (!limpo.trim()) return '';
      if (limpo.length > max) throw erro(`${campo} must have at most ${max} characters`, codigo, index);
      return limpo;
    };
    const subject = texto('subject', REMINDER_SUBJECT_MAX, 'subject_too_long');
    const body = texto('body', REMINDER_BODY_MAX, 'body_too_long');
    return { id, kind: passo.kind, offsetDays: dias, channels, enabled, subject, body };
  });
  // Ordenados pelo dia (estável): a tela mostra na ordem em que saem.
  const ordenados = passos.map((p, i) => [p, i]).sort((a, b) => a[0].offsetDays - b[0].offsetDays || a[1] - b[1]);
  return { steps: ordenados.map(([p]) => p) };
}

/** A régua como vale: a gravada, se ainda é válida; senão a padrão. */
export function reminderPolicyOf(stored) {
  const gravada = stored?.reminderPolicy;
  if (gravada === undefined || gravada === null) return defaultReminderPolicy();
  try {
    return normalizeReminderPolicy(gravada);
  } catch {
    return defaultReminderPolicy();
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Os passos ligados com a janela de cada um, em ms relativos ao prazo:
 * `[startMs, endMs)`. Ver "A janela de cada passo" acima.
 */
export function reminderWindows(policy) {
  const ligados = (policy?.steps ?? []).filter((p) => p.enabled && p.channels?.length);
  const offsets = [...new Set(ligados.map((p) => p.offsetDays))].sort((a, b) => a - b);
  return ligados.map((passo) => {
    const proximo = offsets.find((o) => o > passo.offsetDays);
    let fim = passo.offsetDays + REMINDER_WINDOW_MAX_DAYS;
    if (proximo !== undefined) fim = Math.min(fim, proximo);
    if (passo.kind === 'before') fim = Math.min(fim, 0);
    return { step: passo, startMs: passo.offsetDays * DAY_MS, endMs: fim * DAY_MS };
  });
}

/** Quantos dias antes do prazo sai o primeiro `before` ligado (0 sem nenhum). */
export function maxBeforeDays(policy) {
  return (policy?.steps ?? [])
    .filter((p) => p.enabled && p.kind === 'before' && p.channels?.length)
    .reduce((maior, p) => Math.max(maior, -p.offsetDays), 0);
}

/**
 * Um valor que entra no texto: uma linha só, sem caractere de controle e sem
 * `<`/`>` — o e-mail sai só em texto, mas o mesmo texto é lido em cliente que
 * o renderiza, e o nome do provedor é digitado por ele. Cortado em 300.
 */
export function sanitizeReminderValue(valor) {
  return String(valor ?? '')
    // eslint-disable-next-line no-control-regex -- é justamente o que se tira
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Troca `{empresa}`, `{valor}`, `{vencimento}`, `{link}` e `{plano}` numa
 * passada só — um valor que contenha `{link}` não é trocado de novo. Outras
 * chaves ficam como estão. Texto puro: nada aqui vira HTML.
 */
export function renderReminderTemplate(template, valores = {}) {
  return String(template ?? '').replace(/\{(empresa|valor|vencimento|link|plano)\}/g,
    (_, nome) => sanitizeReminderValue(valores[nome]));
}

export default {
  REMINDER_KINDS,
  REMINDER_CHANNELS,
  REMINDER_MAX_STEPS,
  REMINDER_VARIABLES,
  defaultReminderPolicy,
  normalizeReminderPolicy,
  reminderPolicyOf,
  reminderWindows,
  reminderStepColumn,
  maxBeforeDays,
  renderReminderTemplate,
  sanitizeReminderValue
};
