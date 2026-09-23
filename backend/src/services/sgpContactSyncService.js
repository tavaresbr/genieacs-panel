import SgpService, { SgpError } from './sgpService.js';
import SgpContact from '../models/SgpContact.js';
import AppState from '../models/AppState.js';
import { tdb } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';

const STATE_KEY = 'sgp_contacts_sync_last_run';

/** A pause between pages, so a sync of thousands of clients does not hammer the SGP. */
const PAGE_PACE_MS = 200;

/**
 * The ceilings that keep a misconfigured listing from running forever.
 *
 * An SGP that ignores the paging parameters answers every request with the
 * same first page; without a stop the sync would read it until the process
 * died. The repeat check catches that on the second page, and the ceilings
 * catch anything subtler. 2 000 pages of 500 is a million rows — no provider
 * this panel serves is close to it.
 */
const MAX_PAGES = 2000;
const MAX_ROWS = 1_000_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The identity of a normalized row, for spotting a page the SGP served twice. */
function rowKey(row) {
  return row ? `${row.contract ?? ''}|${row.clientId ?? ''}|${row.document ?? ''}` : '';
}

/**
 * Every client of the SGP, into `sgp_contacts` — with or without a contract,
 * with or without equipment in the panel.
 *
 * The listing path is configured per install (`endpoints.customerList`): the
 * URA reference has no "list everyone" call, and the path differs between SGP
 * versions. Until it is set, every entry point here refuses with
 * `customer_list_not_configured` and nothing runs on a timer.
 *
 * Nothing is ever deleted. A client that disappears from the SGP keeps its row
 * with an old `last_seen_at`, which the contacts screen shows; conversations
 * and a manually corrected phone stay attached to it.
 */
class SgpContactSyncService {
  /** Providers with a sync in flight, so a timer tick and a button press never overlap. */
  static running = new Set();

  static async getLastRun() {
    const raw = await AppState.get(STATE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * The first page only, written nowhere. What the settings screen's test
   * button shows, so an operator can tell a right path from a wrong one before
   * the sync runs.
   */
  static async test() {
    const config = await SgpService.getConfig();
    const page = await SgpService.listCustomersPage(0, config);
    return {
      received: page.received,
      rows: page.rows.length,
      withContract: page.rows.filter((row) => row.contract).length,
      withPhone: page.rows.filter((row) => row.phone).length,
      fields: page.fields,
      sample: page.rows.slice(0, 3).map((row) => ({
        contract: row.contract ?? null,
        name: row.name ?? null,
        hasPhone: Boolean(row.phone)
      }))
    };
  }

  static async syncAll() {
    const tenantId = currentTenantId();
    if (this.running.has(tenantId)) {
      throw new SgpError('sgp.error.contactsSyncRunning', { code: 'contacts_sync_running', status: 409 });
    }
    this.running.add(tenantId);
    try {
      return await this.run();
    } finally {
      this.running.delete(tenantId);
    }
  }

  static async run() {
    const config = SgpService.requireReady(await SgpService.getConfig());
    const startedAt = new Date();
    const summary = { total: 0, created: 0, updated: 0, withoutContract: 0, pages: 0, partial: false };

    let previousFirst = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (page > 0) await sleep(PAGE_PACE_MS);
      const { rows, received } = await SgpService.listCustomersPage(page, config);
      summary.pages += 1;
      if (received === 0) break;

      // The same first row as the previous page: the SGP is not paging.
      const first = rowKey(rows[0]);
      if (page > 0 && first && first === previousFirst) {
        summary.partial = true;
        summary.reason = 'paging_ignored';
        break;
      }
      previousFirst = first;

      for (const row of rows) {
        const outcome = await this.store(row, startedAt);
        if (!outcome) continue;
        summary.total += 1;
        summary[outcome] += 1;
        if (!row.contract) summary.withoutContract += 1;
      }

      if (received < config.contactsPageSize) break;
      if (summary.total >= MAX_ROWS || page === MAX_PAGES - 1) {
        summary.partial = true;
        summary.reason = 'ceiling';
        break;
      }
    }

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

  /** @returns {Promise<'created'|'updated'|null>} */
  static async store(row, seenAt) {
    const record = SgpService.contractToContactRow(row);
    if (!record.contract && !record.sgp_client_id && !record.document) return null;

    const existing = record.contract
      ? await SgpContact.getByContract(record.contract)
      : (record.sgp_client_id ? await SgpContact.getClientRow(record.sgp_client_id) : null);
    const stored = await SgpContact.upsertFromSgp(record, { seenAt });

    // A client that gained a contract: the row it had without one is retired,
    // and what hung on it moves to the contract.
    if (record.contract && row.clientId && stored) await this.retireClientRow(row.clientId, stored);
    return existing ? 'updated' : 'created';
  }

  static async retireClientRow(clientId, contractRow) {
    const old = await SgpContact.getClientRow(clientId);
    if (!old) return;
    await tdb('wa_conversations')
      .where({ sgp_contact_id: old.id })
      .update({ sgp_contact_id: null, contract: contractRow.contract, updated_at: new Date() });
    // The operator's correction survives the move, unless the contract already
    // carries one of its own.
    if (old.phone_manual && !contractRow.phone_manual) {
      await SgpContact.setManualPhoneById(contractRow.id, old.phone_manual);
    }
    await tdb('sgp_contacts').where({ id: old.id }).del();
  }
}

export default SgpContactSyncService;
