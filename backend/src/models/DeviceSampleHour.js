import { tdb, tinsert } from '../config/database.js';
import { timestampMs } from '../utils/helpers.js';

/**
 * Baldes por comando. Com as onze colunas, 200 linhas são 2.200 variáveis —
 * folgado no teto do SQLite e no pacote do MySQL.
 */
const UPSERT_CHUNK = 200;

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    bucket_at: timestampMs(row.bucket_at),
    sample_count: Number(row.sample_count ?? 0),
    rx_min: numberOrNull(row.rx_min),
    rx_avg: numberOrNull(row.rx_avg),
    rx_max: numberOrNull(row.rx_max),
    temp_min: numberOrNull(row.temp_min),
    temp_avg: numberOrNull(row.temp_avg),
    temp_max: numberOrNull(row.temp_max),
    uptime_last: numberOrNull(row.uptime_last)
  };
}

class DeviceSampleHour {
  /**
   * Writes a batch of buckets, replacing any that are already there.
   *
   * Substitui, não acumula: o rollup recalcula o balde inteiro a partir das
   * amostras cruas da hora e reescreve todas as colunas — é isso que faz
   * rodá-lo de novo ser correção e não duplicação. Por isso o `merge` abaixo
   * sobrescreve as colunas com o valor novo, sem somar nada ao que havia.
   *
   * Era um SELECT e um UPDATE/INSERT por balde: uma frota de mil aparelhos com
   * um dia de atraso dava 48 mil viagens ao banco numa passada. Agora é um
   * `insert ... onConflict(tenant_id, device_id, bucket_at).merge(...)` por
   * lote. O knex escreve isso nos três dialetos — `ON CONFLICT ... DO UPDATE
   * SET col = excluded.col` no Postgres e no SQLite, `ON DUPLICATE KEY UPDATE
   * col = VALUES(col)` no MySQL, que ignora a lista de colunas e casa pela
   * única chave única da tabela além do id — exatamente essa.
   */
  static async upsertMany(input) {
    if (!Array.isArray(input) || input.length === 0) return 0;
    // O mesmo balde duas vezes num lote é erro no Postgres ("ON CONFLICT DO
    // UPDATE command cannot affect row a second time"). O laço antigo deixava
    // a última escrita valer; o mapa faz o mesmo.
    const unicos = new Map();
    for (const row of input) unicos.set(`${row.device_id} ${new Date(row.bucket_at).getTime()}`, row);
    const rows = [...unicos.values()];
    // `tenant_id` também fica de fora do merge: é parte da chave do conflito.
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
      .filter((column) => !['device_id', 'bucket_at', 'tenant_id', 'id'].includes(column));
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const insert = tinsert('device_sample_hours', chunk)
        .onConflict(['tenant_id', 'device_id', 'bucket_at']);
      // eslint-disable-next-line no-await-in-loop -- um lote por vez
      await (columns.length ? insert.merge(columns) : insert.ignore());
    }
    // Quantos baldes foram pedidos, como o laço antigo contava.
    return input.length;
  }

  static async listRange(deviceId, fromMs, toMs, limit = 1000) {
    const rows = await tdb('device_sample_hours')
      .where({ device_id: deviceId })
      .where('bucket_at', '>=', new Date(fromMs))
      .where('bucket_at', '<=', new Date(toMs))
      .orderBy('bucket_at', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 1000, 1), 5000));
    return rows.map(parseRow);
  }

  static async pruneOlderThan(cutoffMs, { batchSize = 5000, maxBatches = 20 } = {}) {
    let removed = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // eslint-disable-next-line no-await-in-loop -- bounded, each batch depends on the last
      const ids = await tdb('device_sample_hours')
        .select('id')
        .where('bucket_at', '<', new Date(cutoffMs))
        .limit(batchSize);
      if (ids.length === 0) break;
      // eslint-disable-next-line no-await-in-loop -- see above
      removed += await tdb('device_sample_hours').whereIn('id', ids.map((row) => row.id)).del();
      if (ids.length < batchSize) break;
    }
    return removed;
  }
}

export default DeviceSampleHour;
