import { tdb, tinsertReturningId, isUniqueViolation } from '../config/database.js';

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
 */
export const REMINDER_STEPS = Object.freeze(['before', 'due', 'after']);

class SubscriptionReminderSend {
  /**
   * Toma a etapa do prazo para mandar. Devolve o id da linha, ou nulo quando
   * ela já foi mandada ou está nas mãos de outra passada.
   */
  static async claim({ dueAt, step, until, now = new Date() }) {
    try {
      return await tinsertReturningId('subscription_reminder_sends', {
        due_at: dueAt, step, claimed_until: until, created_at: now
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    // A linha já existe: mandada, ou tomada por alguém. Só se retoma a tomada
    // cuja garra venceu — e com um UPDATE condicional, para que duas passadas
    // que chegarem juntas aqui não a retomem as duas.
    const linha = await tdb('subscription_reminder_sends').where({ due_at: dueAt, step }).first();
    if (!linha || linha.sent_at) return null;
    const mudou = await tdb('subscription_reminder_sends')
      .where({ id: linha.id })
      .whereNull('sent_at')
      .where((q) => q.whereNull('claimed_until').orWhere('claimed_until', '<', now))
      .update({ claimed_until: until });
    return mudou > 0 ? linha.id : null;
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
      step: linha.step,
      channels: String(linha.channels ?? '').split(',').filter(Boolean),
      sentAt: linha.sent_at ? new Date(linha.sent_at).toISOString() : null
    }));
  }
}

export default SubscriptionReminderSend;
