import { tdb, tinsert } from '../config/database.js';

/**
 * O registro das entregas da Meta que a ponte encaminhou ao Evolution.
 *
 * Só metadados — quando, que campos, quanto, e se o Evolution aceitou. Nunca o
 * corpo: texto de mensagem e telefone ficam de fora, e é isso que mantém esta
 * tabela fora do dado de assinante (ver `SEM_DADO_DE_ASSINANTE`).
 */
class WaMetaEvent {
  static async record(row) {
    await tinsert('wa_meta_events', row);
  }

  /**
   * O que a ponte fez por cada número nas últimas `hours` horas: quando foi a
   * última entrega, quantas o Evolution aceitou e quantas recusou.
   *
   * @returns {Promise<Map<number, { lastEventAt: Date|null, ok: number, failed: number }>>}
   */
  static async summarize({ hours = 24 } = {}) {
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await tdb('wa_meta_events')
      .whereNotNull('account_id')
      .where('received_at', '>=', since)
      .select('account_id', 'forward_status')
      .count({ n: 'id' })
      .max({ last: 'received_at' })
      .groupBy('account_id', 'forward_status');
    const out = new Map();
    for (const row of rows) {
      const entry = out.get(row.account_id) ?? { lastEventAt: null, ok: 0, failed: 0 };
      const n = Number(row.n) || 0;
      if (row.forward_status === 'ok') entry.ok += n;
      else entry.failed += n;
      const last = row.last ? new Date(row.last) : null;
      if (last && (!entry.lastEventAt || last > entry.lastEventAt)) entry.lastEventAt = last;
      out.set(row.account_id, entry);
    }
    return out;
  }

  /** Apaga o que passou de `days` dias; devolve quantas linhas. */
  static async purgeOlderThan(days) {
    return tdb('wa_meta_events')
      .where('received_at', '<', new Date(Date.now() - days * 86_400_000))
      .del();
  }
}

export default WaMetaEvent;
