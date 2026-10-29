import { tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';
import { reminderStepColumn } from '../services/reminderPolicy.js';

/**
 * Os lembretes de cobrança mandados a um provedor (0092): uma linha por
 * etapa (`before`, `due`, `after`) por prazo.
 *
 * Só por `tdb`/`tinsert`: quem chama abre o escopo do provedor antes, como em
 * `BillingCharge`.
 *
 * ## A linha nasce antes do envio
 *
 * Pelo mesmo motivo da cobrança: gravar depois da resposta deixaria a janela
 * aberta, e duas passadas que se cruzassem mandariam o mesmo lembrete duas
 * vezes. A inserção é o bilhete que ganha a corrida — o índice único
 * `(tenant_id, due_at, step)` decide —, e quem perde não manda nada.
 *
 * A linha tomada tem `sent_at` nulo e `claimed_until` no futuro. Se o envio
 * falha em todos os canais ela é APAGADA (`release`), e a próxima passada tenta
 * de novo; se o processo morre no meio, `claimed_until` vence e outra passada a
 * retoma (`claim`).
 *
 * ## `step_key` (0121)
 *
 * Com a régua configurável, a etapa é o PASSO (o id dele, até 16), e não o
 * tipo: dois passos `before` no mesmo prazo são dois lembretes. A chave que
 * vale passou a ser `(tenant_id, due_at, step_key)`. `step` continua sendo
 * gravado — os nomes antigos como eram, os passos novos com um código curto
 * do id (`reminderStepColumn`) —, porque o índice antigo `(tenant_id, due_at,
 * step)` fica até a migração seguinte e uma versão anterior do painel que
 * rodasse sobre este banco continuaria lendo `step`. O registro de antes da
 * 0121 (`step_key = step`) é o passo de mesmo id da régua padrão: um `before`
 * já mandado não sai de novo depois da troca.
 */
// `manual`: o lembrete pedido pelo console (painel de inadimplência), com a
// chave no dia do envio em vez do prazo — ver `SubscriptionNoticeService.remindNow`.
export const REMINDER_STEPS = Object.freeze(['before', 'due', 'after', 'suspension_warning', 'suspended', 'manual']);

/**
 * As etapas da suspensão automática (0102) como a coluna as guarda: `step`
 * tem oito caracteres (0092), e os nomes delas não cabem. A tradução fica
 * aqui, nas duas direções, e nenhum outro lugar vê o nome curto.
 */
const STEP_NA_COLUNA = Object.freeze({ suspension_warning: 'suspwarn', suspended: 'suspend' });
const STEP_DA_COLUNA = Object.freeze(Object.fromEntries(Object.entries(STEP_NA_COLUNA).map(([a, b]) => [b, a])));

const naColuna = (step) => STEP_NA_COLUNA[step] ?? step;

/** A chave do passo: o id do passo da régua, ou o nome curto das etapas de fora dela. */
const chaveDe = (etapa, stepKey) => String(stepKey ?? naColuna(etapa)).slice(0, 16);

/**
 * A linha do passo `chave` no prazo: pela chave nova, ou — a linha que uma
 * versão anterior do painel gravou sem `step_key` durante a troca de versão —
 * pelo `step` que o passo teria.
 */
const daChave = (dueAt, chave) => tdb('subscription_reminder_sends')
  .where({ due_at: dueAt })
  .where((q) => q.where({ step_key: chave })
    .orWhere((velha) => velha.whereNull('step_key').where({ step: reminderStepColumn(chave) })))
  .first();

class SubscriptionReminderSend {
  /**
   * Toma a etapa do prazo para mandar. Devolve o id da linha, ou nulo quando
   * ela já foi mandada ou está nas mãos de outra passada.
   */
  static async claim({
    dueAt, step: etapa, stepKey = null, until, now = new Date()
  }) {
    const chave = chaveDe(etapa, stepKey);
    try {
      return await tinsertReturningId('subscription_reminder_sends', {
        due_at: dueAt, step: reminderStepColumn(chave), step_key: chave, claimed_until: until, created_at: now
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    // A linha já existe: mandada, ou tomada por alguém. Só se retoma a tomada
    // cuja garra venceu — e com um UPDATE condicional, para que duas passadas
    // que chegarem juntas aqui não a retomem as duas. Sem linha com esta
    // chave, quem barrou foi o índice antigo (`step`, um código de outro passo
    // igual ao deste): não se manda — na dúvida, um lembrete a menos, nunca
    // um a mais.
    const linha = await daChave(dueAt, chave);
    if (!linha || linha.sent_at) return null;
    const mudou = await tdb('subscription_reminder_sends')
      .where({ id: linha.id })
      .whereNull('sent_at')
      .where((q) => q.whereNull('claimed_until').orWhere('claimed_until', '<', now))
      .update({ claimed_until: until });
    return mudou > 0 ? linha.id : null;
  }

  /**
   * Quando a etapa daquele prazo SAIU — ou nulo. É o que a suspensão
   * automática lê para nunca suspender sem o aviso antes (0102).
   */
  static async sentAt({ dueAt, step: etapa, stepKey = null }) {
    const linha = await daChave(dueAt, chaveDe(etapa, stepKey));
    return linha?.sent_at ? new Date(linha.sent_at) : null;
  }

  /** O lembrete saiu: grava por onde e quando, e solta a garra. */
  static async markSent(id, { channels, at = new Date() }) {
    await tdb('subscription_reminder_sends').where({ id }).update({
      channels: channels.join(',').slice(0, 32), sent_at: at, claimed_until: null
    });
  }

  /** Nada saiu: a linha some, e a próxima passada tenta de novo. */
  static async release(id) {
    await tdb('subscription_reminder_sends').where({ id }).whereNull('sent_at').del();
  }

  /** Os lembretes que saíram, do mais recente para trás — o que o console mostra. */
  static async listSent({ limit = 30 } = {}) {
    const linhas = await tdb('subscription_reminder_sends')
      .whereNotNull('sent_at')
      .orderBy('sent_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit);
    return linhas.map((linha) => ({
      dueAt: String(linha.due_at).slice(0, 10),
      step: STEP_DA_COLUNA[linha.step] ?? linha.step_key ?? linha.step,
      channels: String(linha.channels ?? '').split(',').filter(Boolean),
      sentAt: linha.sent_at ? new Date(linha.sent_at).toISOString() : null
    }));
  }
}

export default SubscriptionReminderSend;
