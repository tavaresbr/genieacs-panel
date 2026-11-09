import SgpClient from '../models/SgpClient.js';
import SgpContact from '../models/SgpContact.js';
import { tdb } from '../config/database.js';
import TeiahService, { TeiahError } from './teiahService.js';
import ContactProfileService, { ContactProfileError, shownValue, whatsappPhoneOf } from './contactProfileService.js';
import WaContactService, { contactKey } from './waContactService.js';
import { personTypeOf } from './contactOnboardingService.js';
import AuditLog from '../models/AuditLog.js';
import WaAlertService from './waAlertService.js';

/** One scan reads this many clients: each is a paid call to the TeiaH. */
export const SCAN_LIMIT = 30;
/** A client the TeiaH answered about is not asked again for this long. */
const RECONSULT_DAYS = 30;
const SCAN_CONCURRENCY = 3;
/** The most clients one "apply" writes. */
export const APPLY_LIMIT = 200;
const PENDING_LIMIT = 500;

const MOBILE = /^55\d{2}9\d{8}$/;

/** A client consulted longer ago than this is "stale" for the admin's reconsult. */
export const STALE_MONTHS = 6;
/** The most clients one reconsult run asks the TeiaH about. */
export const RECONSULT_LIMIT = 100;

/**
 * Where a TeiaH risk band sits: 1 low, 2 medium, 3 high; `null` when the band
 * is missing or not one the panel knows. Same reading as the frontend badge.
 */
export function riskRank(risk) {
  const value = String(risk ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  if (!value) return null;
  if (value.startsWith('BAIX') || value.startsWith('LOW')) return 1;
  if (value.startsWith('ALT') || value.startsWith('HIGH')) return 3;
  if (value.startsWith('MED') || value.startsWith('MODERAD')) return 2;
  return null;
}

function digitsOf(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** The consultation as the record keeps it: what the TeiaH said, with the day it said it. */
function snapshotOf(found, consultedAt) {
  return {
    consultedAt: consultedAt ?? new Date().toISOString(),
    found: found.found === true,
    score: found.score ?? null,
    motherName: found.motherName ?? null,
    deceased: found.deceased === true,
    addresses: found.addresses ?? (found.address ? [found.address] : []),
    phones: found.phones ?? [],
    emails: found.emails ?? []
  };
}

function recent(snapshot) {
  const at = Date.parse(snapshot?.consultedAt ?? '');
  return Number.isFinite(at) && Date.now() - at < RECONSULT_DAYS * 86_400_000;
}

/** Runs `task` over `items`, `size` at a time, keeping the order of the results. */
async function pool(items, size, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- each worker takes the next item only when its last is done
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/**
 * What the TeiaH knows about a client already in the panel: asked by CPF/CNPJ,
 * kept on the client's record (`sgp_clients.teiah`) as a snapshot, and only
 * then — by an operator's decision — merged into the record.
 *
 * Keeping the snapshot is what makes "preview, then apply" cheap and honest:
 * applying reads what was already paid for and shown, never asks again, and
 * never takes numbers from the browser.
 */
class ContactTeiahService {
  /** The TeiaH of one client: the CPF/CNPJ the record shows, and the record it lands on. */
  static async consult(key, { fresh = false, override = false } = {}) {
    const row = await ContactProfileService.rowFor(key);
    if (!row) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const existing = await ContactProfileService.clientFor(row);
    const document = digitsOf(shownValue('document', existing, row));
    if (!personTypeOf(document)) {
      throw new ContactProfileError('contacts.error.invalidDocument', { code: 'invalid_document' });
    }
    TeiahService.requireReady(await TeiahService.getConfig());
    // The panel's memory first: a consultation younger than 30 days is not paid
    // for twice, whoever made it (this record, "Novo cliente" or the bulk run).
    const consulted = await TeiahService.consultCached(document, { fresh, override });
    const client = await ContactProfileService.ensureClient(row);
    const teiah = snapshotOf(consulted.result, consulted.consultedAt);
    await SgpClient.setTeiah(client.id, teiah);
    const worsened = await this.noteWorsening(key, existing, row, teiah);
    return { teiah, cached: consulted.cached, worsened };
  }

  /**
   * The risk band went up since the last consultation (low → high, say): kept
   * in the audit trail, which the admins' list reads, and sent to the team's
   * alert channels when the admin turned that on. Never throws.
   *
   * @returns {Promise<{ from: string, to: string } | null>}
   */
  static async noteWorsening(key, existing, row, teiah) {
    try {
      const from = existing?.teiah?.score?.risk ?? null;
      const to = teiah?.score?.risk ?? null;
      const before = riskRank(from);
      const after = riskRank(to);
      if (before === null || after === null || after <= before) return null;
      const name = String(shownValue('name', existing, row) ?? '').slice(0, 80) || String(key);
      const score = teiah.score?.score ?? null;
      await AuditLog.record({
        action: AuditLog.ACTIONS.CONTACT_TEIAH_RISK_UP,
        actorKind: 'system',
        subjectType: 'contact',
        subjectId: key,
        detail: { name, from, to, score }
      });
      const guards = await TeiahService.getGuards();
      if (guards.alertWorsening) {
        await WaAlertService.notifyEvent({
          rule: 'teiah_risk_up',
          subject: `teiah:${key}`,
          vars: { name, from, to, score: score ?? '-' }
        });
      }
      return { from, to };
    } catch (error) {
      console.warn(`TeiaH worsening not noted: ${String(error?.message).slice(0, 200)}`);
      return null;
    }
  }

  /** The clients whose risk went up lately, newest first, from the audit trail. */
  static async worsened({ limit = 50 } = {}) {
    const rows = await AuditLog.list({ action: AuditLog.ACTIONS.CONTACT_TEIAH_RISK_UP, limit });
    return rows.map((row) => {
      let detail = {};
      try {
        detail = JSON.parse(row.detail || '{}') || {};
      } catch {
        detail = {};
      }
      return {
        key: row.subject_id,
        name: detail.name ?? null,
        from: detail.from ?? null,
        to: detail.to ?? null,
        score: detail.score ?? null,
        at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
      };
    });
  }

  /**
   * Active clients whose TeiaH snapshot is older than `STALE_MONTHS`: one per
   * document (a client with several contracts is asked once), oldest first.
   */
  static async staleCandidates({ months = STALE_MONTHS } = {}) {
    const subscribers = await WaContactService.collect({ state: 'active' });
    const byDocument = new Map();
    for (const subscriber of subscribers) {
      const document = digitsOf(subscriber.document);
      if (!personTypeOf(document) || byDocument.has(document)) continue;
      byDocument.set(document, { key: contactKey(subscriber), name: subscriber.clientName, document });
    }
    const snapshots = await this.snapshotsByDocument([...byDocument.keys()]);
    const cutoff = Date.now() - months * 30 * 86_400_000;
    const stale = [];
    for (const entry of byDocument.values()) {
      const at = Date.parse(snapshots.get(entry.document)?.consultedAt ?? '');
      if (Number.isFinite(at) && at < cutoff) stale.push({ ...entry, consultedAt: new Date(at).toISOString() });
    }
    return stale.sort((a, b) => a.consultedAt.localeCompare(b.consultedAt));
  }

  /** What a reconsult would do: how many clients, and what it would cost by the admin's prices. */
  static async reconsultPreview() {
    const stale = await this.staleCandidates();
    const guards = await TeiahService.getGuards();
    const usage = await TeiahService.monthUsage();
    const next = Math.min(stale.length, RECONSULT_LIMIT);
    return {
      count: stale.length,
      batch: next,
      priceCpf: guards.priceCpf,
      estimatedCost: Math.round(next * guards.priceCpf * 100) / 100,
      usage,
      sample: stale.slice(0, 10).map(({ key, name, consultedAt }) => ({ key, name, consultedAt }))
    };
  }

  /**
   * Asks the TeiaH again about the stale clients, at most `max` (≤ 100). The
   * monthly limit applies (no override here): reaching it stops the run.
   */
  static async reconsultStale({ max = RECONSULT_LIMIT } = {}) {
    const cap = Math.min(Math.max(Math.floor(Number(max)) || RECONSULT_LIMIT, 1), RECONSULT_LIMIT);
    const stale = await this.staleCandidates();
    const batch = stale.slice(0, cap);
    if (batch.length > 0) TeiahService.requireReady(await TeiahService.getConfig());
    let processed = 0;
    let failed = 0;
    let stoppedByLimit = false;
    const worsened = [];
    await pool(batch, SCAN_CONCURRENCY, async (entry) => {
      if (stoppedByLimit) return;
      try {
        const done = await this.consult(entry.key, { fresh: true });
        processed += 1;
        if (done.worsened) worsened.push({ key: entry.key, name: entry.name, ...done.worsened });
      } catch (error) {
        if (error instanceof TeiahError && error.code === 'teiah_limit_reached') {
          stoppedByLimit = true;
          return;
        }
        if (error instanceof TeiahError && ['unauthorized', 'credentials_rejected', 'not_configured'].includes(error.code)) throw error;
        failed += 1;
      }
    });
    return {
      processed,
      failed,
      worsened,
      stoppedByLimit,
      remaining: stale.length - processed
    };
  }

  /**
   * The TeiaH's own report of this client (the one its site shows and prints),
   * as a PDF: the latest consultation of the record's CPF/CNPJ in the
   * provider's TeiaH history, made from data the TeiaH already holds — no new
   * paid call, and nothing of it kept in the panel.
   *
   * @returns {Promise<{ pdf: Buffer, consultationId: string, document: string }>}
   */
  static async report(key, mode = 'completo') {
    const row = await ContactProfileService.rowFor(key);
    if (!row) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const client = await ContactProfileService.clientFor(row);
    const document = digitsOf(shownValue('document', client, row));
    if (!personTypeOf(document)) {
      throw new ContactProfileError('contacts.error.invalidDocument', { code: 'invalid_document' });
    }
    TeiahService.requireReady(await TeiahService.getConfig());
    const found = await TeiahService.findPrintableConsultation(document);
    if (!found) {
      throw new TeiahError('teiah.error.reportNone', { code: 'teiah_report_none', status: 404 });
    }
    const pdf = await TeiahService.consultationPdf(found.id, mode);
    return { pdf, consultationId: found.id, document };
  }

  /**
   * Merges the snapshot's phones and e-mails into the record, the way an
   * operator's edit does (restorable, nothing removed), and gives the contracts
   * that have no WhatsApp number the first mobile.
   */
  static async apply(key, actor) {
    const row = await ContactProfileService.rowFor(key);
    if (!row) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const client = await ContactProfileService.clientFor(row);
    const teiah = client?.teiah;
    if (!teiah) throw new ContactProfileError('contacts.error.teiahNotConsulted', { code: 'teiah_not_consulted', status: 409 });

    const phones = shownValue('phones', client, row) ?? [];
    const emails = shownValue('emails', client, row) ?? [];
    const newPhones = [...new Set(teiah.phones ?? [])].filter((phone) => !phones.includes(phone));
    const newEmails = [...new Set(teiah.emails ?? [])].filter((email) => !emails.includes(email));

    const body = {};
    if (newPhones.length) body.phones = [...phones, ...newPhones];
    if (newEmails.length) body.emails = [...emails, ...newEmails];

    // The number WhatsApp reaches: a mobile when the TeiaH has one.
    const best = (teiah.phones ?? []).find((phone) => MOBILE.test(phone)) ?? (teiah.phones ?? [])[0] ?? null;
    let whatsappSet = 0;
    if (best) {
      if (!(await ContactProfileService.get(key))?.whatsappPhone) {
        body.whatsappPhone = best;
        whatsappSet += 1;
      }
      // The client's other contracts, when they have no number either.
      const others = await SgpContact.getByClient(client.sgp_client_id);
      for (const other of others) {
        if (!other.contract || other.id === row.id) continue;
        if (whatsappPhoneOf(null, other).phone) continue;
        // eslint-disable-next-line no-await-in-loop -- a handful of contracts per client
        await SgpContact.setManualPhoneById(other.id, best);
        whatsappSet += 1;
      }
    }

    if (Object.keys(body).length > 0) {
      await ContactProfileService.update(key, body, actor ? `${actor} · TeiaH` : 'TeiaH');
    }
    return { phonesAdded: newPhones.length, emailsAdded: newEmails.length, whatsappSet };
  }

  /** Active clients with no phone, each with the key the list gives it and its document. */
  static async withoutPhone() {
    const subscribers = await WaContactService.collect({ state: 'active', noPhone: true });
    return subscribers
      .map((subscriber) => ({
        key: contactKey(subscriber),
        name: subscriber.clientName,
        document: digitsOf(subscriber.document)
      }))
      .filter((entry) => personTypeOf(entry.document));
  }

  /** The snapshots the panel holds, by document. */
  static async snapshotsByDocument(documents) {
    const wanted = [...new Set(documents)];
    const map = new Map();
    if (wanted.length === 0) return map;
    for (let at = 0; at < wanted.length; at += 500) {
      // eslint-disable-next-line no-await-in-loop -- pages of an IN list
      const rows = await tdb('sgp_clients').whereIn('document', wanted.slice(at, at + 500)).whereNotNull('teiah').select('document', 'teiah');
      for (const row of rows) map.set(row.document, SgpClient.parse(row).teiah);
    }
    return map;
  }

  /**
   * Asks the TeiaH about the next clients with no phone — at most `SCAN_LIMIT`
   * a call — and files each answer on its record. Nothing is merged: that is
   * `applyMany`, after the operator saw `pending`.
   */
  static async scan() {
    const candidates = await this.withoutPhone();
    const snapshots = await this.snapshotsByDocument(candidates.map((entry) => entry.document));
    const todo = candidates.filter((entry) => !recent(snapshots.get(entry.document)));
    const batch = todo.slice(0, SCAN_LIMIT);
    if (batch.length > 0) TeiahService.requireReady(await TeiahService.getConfig());

    let failed = 0;
    let fromCache = 0;
    await pool(batch, SCAN_CONCURRENCY, async (entry) => {
      try {
        const done = await this.consult(entry.key);
        if (done.cached) fromCache += 1;
      } catch (error) {
        // A refused key or an integration turned off ends the run for everyone;
        // one client the TeiaH could not answer is only counted.
        if (error instanceof TeiahError && ['unauthorized', 'credentials_rejected', 'not_configured'].includes(error.code)) throw error;
        failed += 1;
      }
    });
    return {
      eligible: candidates.length,
      processed: batch.length,
      failed,
      // Answered from what the panel already held: no call to the TeiaH, no credits.
      fromCache,
      remaining: todo.length - batch.length
    };
  }

  /** The clients with no phone for whom the TeiaH has one, to show before applying. */
  static async pending() {
    const candidates = await this.withoutPhone();
    const snapshots = await this.snapshotsByDocument(candidates.map((entry) => entry.document));
    const rows = [];
    for (const entry of candidates) {
      const teiah = snapshots.get(entry.document);
      if (!teiah?.phones?.length) continue;
      rows.push({ key: entry.key, name: entry.name, phones: teiah.phones, emails: teiah.emails ?? [], consultedAt: teiah.consultedAt ?? null });
      if (rows.length >= PENDING_LIMIT) break;
    }
    return rows;
  }

  /** Applies the snapshots of the clients the operator ticked. */
  static async applyMany(keys, actor) {
    const list = [...new Set((Array.isArray(keys) ? keys : []).map(String))].slice(0, APPLY_LIMIT);
    const total = { clients: 0, phonesAdded: 0, emailsAdded: 0, whatsappSet: 0, skipped: 0 };
    for (const key of list) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each client is written with its own record
        const done = await this.apply(key, actor);
        total.clients += 1;
        total.phonesAdded += done.phonesAdded;
        total.emailsAdded += done.emailsAdded;
        total.whatsappSet += done.whatsappSet;
      } catch (error) {
        if (!(error instanceof ContactProfileError)) throw error;
        total.skipped += 1;
      }
    }
    return total;
  }
}

export default ContactTeiahService;
