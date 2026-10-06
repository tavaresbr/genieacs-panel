import { tdb, tinsert, isUniqueViolation } from '../config/database.js';

/** Os recursos que têm teto no plano, e portanto pico — na ordem da tela. */
export const USAGE_RESOURCES = Object.freeze(['operators', 'subscribers', 'devices']);

/**
 * O maior uso de cada recurso em cada período (0104), que a cobrança por
 * excedente lê na renovação.
 *
 * Só por `tdb`/`tinsert`: quem chama abre o escopo do provedor antes, como em
 * `BillingCharge`.
 *
 * O pico só SOBE. Gravar é "o maior entre o guardado e o de agora", e a
 * escrita é condicional (`peak < novo`), não uma leitura seguida de escrita:
 * duas passadas que se cruzem nunca trocam um pico maior por um menor.
 */
class UsagePeak {
  /**
   * Registra `value` como uso de `resource` no período `periodEnd`, se for
   * maior que o guardado. Devolve o pico que fica.
   */
  static async record(periodEnd, resource, value) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    const valor = Math.floor(Number(value));
    if (!chave || !USAGE_RESOURCES.includes(resource) || !Number.isFinite(valor) || valor < 0) return null;
    const onde = { period_end: chave, resource };
    const subiu = await tdb('usage_peaks').where(onde).where('peak', '<', valor)
      .update({ peak: valor, updated_at: new Date() });
    if (subiu > 0) return valor;
    const existente = await tdb('usage_peaks').where(onde).first();
    if (existente) return Number(existente.peak);
    try {
      await tinsert('usage_peaks', { ...onde, peak: valor, updated_at: new Date() });
      return valor;
    } catch (error) {
      // Outra passada inseriu no meio: o índice único decidiu, e a escrita
      // condicional de cima, repetida, leva o pico ao maior dos dois.
      if (!isUniqueViolation(error)) throw error;
      await tdb('usage_peaks').where(onde).where('peak', '<', valor)
        .update({ peak: valor, updated_at: new Date() });
      const agora = await tdb('usage_peaks').where(onde).first();
      return agora ? Number(agora.peak) : valor;
    }
  }

  /** Os picos do período, como `{ operators, subscribers, devices }` — nulo onde não há. */
  static async forPeriod(periodEnd) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    const picos = { operators: null, subscribers: null, devices: null };
    if (!chave) return picos;
    const linhas = await tdb('usage_peaks').where({ period_end: chave });
    for (const linha of linhas) {
      if (USAGE_RESOURCES.includes(linha.resource)) picos[linha.resource] = Number(linha.peak);
    }
    return picos;
  }
}

export default UsagePeak;
export { UsagePeak };
