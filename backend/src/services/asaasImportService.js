import AppState from '../models/AppState.js';
import AsaasCustomer from '../models/AsaasCustomer.js';
import AsaasCharge, { OPEN_STATUSES } from '../models/AsaasCharge.js';
import AsaasProviderService, { AsaasProviderError } from './asaasProviderService.js';
import { AsaasError, listCustomersPage, listChargesPage, getCharge, MAX_PAGE_SIZE } from './billing/asaasClient.js';
import { currentTenantId } from '../config/tenantContext.js';

const STATE_KEY = 'asaas_import_last_run';
const ERROR_KEY = 'asaas_import_last_error';

/**
 * Os tetos que impedem uma listagem defeituosa de rodar para sempre: 5 000
 * páginas de 100 são meio milhão de linhas, longe de qualquer provedor que o
 * painel atende.
 */
const MAX_PAGES = 5000;

/** Quantas cobranças que saíram da lista de abertas são conferidas uma a uma por passada. */
const RECONCILE_LIMIT = 200;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function readJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Os clientes e as cobranças em aberto da conta Asaas do provedor, para dentro
 * do painel.
 *
 * ## Só leitura, e nada é apagado
 *
 * A importação lê do gateway e grava em `asaas_customers`/`asaas_charges`.
 * Não escreve no Asaas e não toca no SGP: o cadastro do SGP continua sendo o do
 * SGP, e o encontro entre as duas fontes é pelo CPF/CNPJ, em leitura. Um
 * cliente que some do gateway fica com a linha e o `last_seen_at` antigo.
 *
 * ## Por que a cobrança paga precisa de uma conferência à parte
 *
 * A listagem pede só `PENDING` e `OVERDUE`. Uma cobrança paga SAI dessa lista,
 * e só ausência não diz se foi paga, cancelada ou apagada — e deixá-la "em
 * aberto" aqui seria o bot cobrando de quem já pagou. Então, ao fim de uma
 * passada COMPLETA, o que estava aberto e não foi visto é lido uma a uma
 * (`getCharge`) e leva o status de verdade. Uma passada que falhou no meio não
 * faz essa conferência: o que não apareceu pode só não ter sido lido.
 */
class AsaasImportService {
  /** Provedores com uma importação em curso: o relógio e o botão nunca se sobrepõem. */
  static running = new Set();

  /** A pausa entre páginas, para não martelar a conta do provedor. Campo de classe: o teste a zera. */
  static PAGE_PACE_MS = 250;

  /** A credencial de saída. Um ponto só, para o teste apontar o gateway de mentira. */
  static credentialFor(config) {
    return AsaasProviderService.credentialOf(config);
  }

  static async getStatus() {
    const [customers, openCharges, overdueCharges, withoutDocument, duplicateDocuments, matchingSgp] = await Promise.all([
      AsaasCustomer.count(),
      AsaasCharge.countOpen(),
      AsaasCharge.countOverdue(),
      AsaasCustomer.countWithoutDocument(),
      AsaasCustomer.countDuplicateDocuments(),
      AsaasCustomer.countMatchingSgp()
    ]);
    return {
      lastRun: readJson(await AppState.get(STATE_KEY)),
      running: this.running.has(currentTenantId()),
      lastError: readJson(await AppState.get(ERROR_KEY)),
      totals: { customers, openCharges, overdueCharges, withoutDocument, duplicateDocuments, matchingSgp }
    };
  }

  static requireReady(config) {
    if (!AsaasProviderService.isReady(config)) {
      throw new AsaasProviderError('asaas.error.notConfigured', { code: 'not_configured', status: 409 });
    }
    if (!config.importCustomers && !config.importCharges) {
      throw new AsaasProviderError('asaas.error.nothingToImport', { code: 'nothing_to_import', status: 409 });
    }
    return config;
  }

  /**
   * A entrada do botão: confere o que dá para conferir na hora e deixa a
   * passada seguir no fundo. Milhares de clientes levam mais que o proxy
   * espera por uma resposta, então a tela pergunta `getStatus` até acabar.
   */
  static async start() {
    this.requireReady(await AsaasProviderService.getConfig());
    if (this.running.has(currentTenantId())) {
      throw new AsaasProviderError('asaas.error.importRunning', { code: 'import_running', status: 409 });
    }
    void this.syncAll().catch((error) => {
      console.warn(`Asaas import failed: ${error.code || error.message}`);
    });
  }

  static async syncAll() {
    const tenantId = currentTenantId();
    if (this.running.has(tenantId)) {
      throw new AsaasProviderError('asaas.error.importRunning', { code: 'import_running', status: 409 });
    }
    this.running.add(tenantId);
    try {
      const result = await this.run();
      await AppState.upsert(ERROR_KEY, '');
      return result;
    } catch (error) {
      const translated = AsaasProviderService.translateGatewayError(error);
      await AppState.upsert(ERROR_KEY, JSON.stringify({
        at: new Date().toISOString(),
        code: translated.code || 'error',
        translationKey: translated.translationKey || null,
        translationVars: translated.translationVars || null,
        message: translated.translationKey ? null : String(translated.message || '')
      })).catch(() => {});
      throw translated;
    } finally {
      this.running.delete(tenantId);
    }
  }

  static async run() {
    const config = this.requireReady(await AsaasProviderService.getConfig());
    const credential = this.credentialFor(config);
    const startedAt = new Date();
    const summary = {
      pages: 0,
      customers: { total: 0, created: 0, updated: 0 },
      charges: { total: 0, created: 0, updated: 0, withoutCustomer: 0, reconciled: 0, gone: 0 }
    };

    try {
      if (config.importCustomers) await this.importCustomers(credential, startedAt, summary);
      if (config.importCharges) {
        const seen = await this.importCharges(credential, startedAt, summary);
        await this.reconcile(credential, seen, summary);
      }
    } catch (error) {
      // O que já foi gravado fica gravado — e é dito: uma passada que morre na
      // página 40 já trouxe quatro mil clientes.
      if (summary.pages > 0) {
        summary.partial = true;
        await this.saveRun(summary, startedAt);
      }
      throw error;
    }
    return this.saveRun(summary, startedAt);
  }

  static async importCustomers(credential, startedAt, summary) {
    // O deslocamento anda pelo que o gateway DEVOLVEU, e não pelo que se pediu:
    // um gateway que corta a página abaixo do pedido, com `hasMore` verdadeiro,
    // faria `página × 100` pular linhas em silêncio.
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (summary.pages > 0) await sleep(this.PAGE_PACE_MS);
      const { rows, hasMore } = await listCustomersPage({ offset, limit: MAX_PAGE_SIZE }, credential);
      offset += rows.length;
      summary.pages += 1;
      for (const row of rows) {
        const outcome = await AsaasCustomer.upsertFromAsaas(row, { seenAt: startedAt });
        summary.customers.total += 1;
        summary.customers[outcome] += 1;
      }
      if (!hasMore || rows.length === 0) return;
    }
    summary.partial = true;
    summary.reason = 'ceiling';
  }

  /** Devolve os ids do gateway vistos nesta passada: é contra eles que `reconcile` confere o que sumiu. */
  static async importCharges(credential, startedAt, summary) {
    const seen = new Set();
    // O CPF/CNPJ de cada cliente, lido do banco uma vez por cliente e guardado.
    const documents = new Map();
    const documentOf = async (customerId) => {
      if (!customerId) return null;
      if (!documents.has(customerId)) {
        const customer = await AsaasCustomer.getByAsaasId(customerId);
        documents.set(customerId, customer?.document ?? null);
      }
      return documents.get(customerId);
    };

    for (const status of OPEN_STATUSES) {
      let offset = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        if (summary.pages > 0) await sleep(this.PAGE_PACE_MS);
        const { rows, hasMore } = await listChargesPage({ status, offset, limit: MAX_PAGE_SIZE }, credential);
        offset += rows.length;
        summary.pages += 1;
        for (const row of rows) {
          const document = await documentOf(row.customerId);
          if (!document) summary.charges.withoutCustomer += 1;
          const outcome = await AsaasCharge.upsertFromAsaas(row, { document, seenAt: startedAt });
          seen.add(row.id);
          summary.charges.total += 1;
          summary.charges[outcome] += 1;
        }
        if (!hasMore || rows.length === 0) break;
        if (page === MAX_PAGES - 1) {
          summary.partial = true;
          summary.reason = 'ceiling';
        }
      }
    }
    return seen;
  }

  /**
   * As que estavam em aberto e saíram da lista: lidas uma a uma, com o status
   * de verdade. Só depois de uma passada completa (ver o cabeçalho da classe).
   *
   * "Saíram da lista" é conferido pelos ids vistos NESTA passada, e não por um
   * `last_seen_at` anterior ao início dela: o MySQL guarda o timestamp em
   * segundos e arredonda, então duas passadas no mesmo segundo se confundiam —
   * a que acabou de ser vista parecia velha e a velha parecia recém-vista.
   */
  static async reconcile(credential, seen, summary) {
    if (summary.partial) return;
    const stale = (await AsaasCharge.listOpen())
      .filter((charge) => !seen.has(charge.asaas_id))
      .slice(0, RECONCILE_LIMIT);
    for (const charge of stale) {
      await sleep(this.PAGE_PACE_MS);
      try {
        const current = await getCharge(charge.asaas_id, credential);
        await AsaasCharge.applyStatus(charge.asaas_id, {
          status: current.status,
          paymentDate: current.paidOn,
          dueDate: current.dueDate
        });
        summary.charges.reconciled += 1;
      } catch (error) {
        if (error instanceof AsaasError && error.status === 404) {
          await AsaasCharge.markDeleted(charge.asaas_id);
          summary.charges.gone += 1;
        } else if (error instanceof AsaasError && error.code === 'unauthorized') {
          throw error;
        }
        // Qualquer outra falha deixa a cobrança como está: a próxima passada tenta de novo.
      }
    }
  }

  static async saveRun(summary, startedAt) {
    const finishedAt = new Date();
    const result = {
      ...summary,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString()
    };
    await AppState.upsert(STATE_KEY, JSON.stringify(result));
    return result;
  }
}

export default AsaasImportService;
