import { getDb, insertReturningId } from '../config/database.js';

/**
 * Os pedidos de demonstração da página pública.
 *
 * Lida fora de `tdb`, como `plans`: é da plataforma e não tem `tenant_id` —
 * quem pede ainda não é provedor. Só o console lê, atrás de
 * `requirePlatformAdmin`; a escrita pública só insere.
 */
export const LEAD_STATUSES = Object.freeze(['new', 'contacted', 'won', 'lost']);

class Lead {
  static async create(row) {
    const id = await insertReturningId('leads', row);
    return Lead.findById(id);
  }

  static async findById(id) {
    if (!id) return null;
    return (await getDb()('leads').where({ id }).first()) || null;
  }

  static async list({ status = null, limit = 200 } = {}) {
    let query = getDb()('leads').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit);
    if (status) query = query.where({ status });
    return query;
  }

  static async countByStatus() {
    const rows = await getDb()('leads').select('status').count({ n: '*' }).groupBy('status');
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
  }

  static async update(id, patch) {
    const changed = await getDb()('leads').where({ id }).update({ ...patch, updated_at: new Date() });
    return changed > 0 ? Lead.findById(id) : null;
  }
}

export default Lead;
