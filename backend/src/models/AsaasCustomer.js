import { tdb, tinsert, withDeadlockRetry } from '../config/database.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { normalizeTaxId } from '../utils/taxId.js';
import { currentTenantId } from '../config/tenantContext.js';

/**
 * Os clientes da conta Asaas do provedor, como a importação os guarda.
 *
 * O CPF/CNPJ vira só dígitos e o telefone vira E.164 AQUI, na entrada: quem lê
 * (o bot, a ficha, a união com o SGP) compara com o que já está normalizado e
 * não precisa repetir o cuidado.
 */
class AsaasCustomer {
  /** Grava (ou atualiza) um cliente; `seenAt` é o instante da passada que o viu. */
  static async upsertFromAsaas(row, { seenAt }) {
    const now = new Date();
    const document = normalizeTaxId(row.document);
    const phone = normalizarTelefoneBr(row.mobilePhone || row.phone);
    const values = {
      asaas_id: row.id,
      document: document || null,
      name: row.name ?? null,
      email: row.email ?? null,
      phone: row.phone ?? null,
      mobile_phone: row.mobilePhone ?? null,
      phone_e164: phone || null,
      postal_code: row.postalCode ?? null,
      address: row.address ?? null,
      address_number: row.addressNumber ?? null,
      complement: row.complement ?? null,
      province: row.province ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      external_reference: row.externalReference ?? null,
      deleted: row.deleted === true,
      last_seen_at: seenAt,
      updated_at: now
    };
    const existing = await tdb('asaas_customers').where({ asaas_id: row.id }).first();
    await withDeadlockRetry(() => tinsert('asaas_customers', values)
      .onConflict(['tenant_id', 'asaas_id']).merge(values));
    return existing ? 'updated' : 'created';
  }

  static async getByAsaasId(asaasId) {
    return (await tdb('asaas_customers').where({ asaas_id: String(asaasId) }).first()) || null;
  }

  /** Os clientes de um CPF/CNPJ (só dígitos) que o gateway não marcou como removidos. */
  static async listByDocument(document) {
    const digits = normalizeTaxId(document);
    if (!digits) return [];
    return tdb('asaas_customers').where({ document: digits, deleted: false }).orderBy('id');
  }

  static async count() {
    const [row] = await tdb('asaas_customers').where({ deleted: false }).count({ n: '*' });
    return Number(row?.n ?? 0);
  }

  /** Quantos CPF/CNPJ aparecem em mais de um cliente ativo — o cadastro duplicado no Asaas. */
  static async countDuplicateDocuments() {
    const rows = await tdb('asaas_customers')
      .where({ deleted: false })
      .whereNotNull('document')
      .groupBy('document')
      .havingRaw('count(*) > 1')
      .select('document');
    return rows.length;
  }

  static async countWithoutDocument() {
    const [row] = await tdb('asaas_customers')
      .where({ deleted: false })
      .whereNull('document')
      .count({ n: '*' });
    return Number(row?.n ?? 0);
  }

  /**
   * Quantos clientes do Asaas têm o CPF/CNPJ de alguém que já está no SGP — o
   * mesmo assinante nas duas fontes. Leitura: nada do SGP é alterado.
   */
  static async countMatchingSgp() {
    const tenantId = currentTenantId();
    const [row] = await tdb('asaas_customers')
      .where({ deleted: false })
      .whereNotNull('document')
      .whereIn('document', function procurarNoSgp() {
        this.select('document').from('sgp_contacts')
          .where('sgp_contacts.tenant_id', tenantId)
          .whereNotNull('document');
      })
      .count({ n: '*' });
    return Number(row?.n ?? 0);
  }
}

export default AsaasCustomer;
