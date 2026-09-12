import SgpService, { SgpError } from './sgpService.js';
import SgpLink from '../models/SgpLink.js';
import WaBroadcast from '../models/WaBroadcast.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WaTemplateService from './waTemplateService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { currentTenantId } from '../config/tenantContext.js';
import {
  comoDataBr,
  diasEntre,
  maisAntigaEmAberto,
  modeloEhLembrete,
  renderCobranca,
  variaveisDeCobranca
} from '../utils/wa/waCobranca.js';

/**
 * Pause between two SGP calls.
 *
 * The provider's SGP is a production billing system that is, at the same
 * moment, answering the phone menu real subscribers are calling. A campaign
 * build is one round trip per recipient; hammering it would degrade the URA for
 * people who are on the line right now.
 */
const SGP_PACE_MS = 150;

/** Recipients one campaign may carry. */
export const MAX_RECIPIENTS = 300;

/** How many campaign builds are allowed, and over what window. */
const BUILD_WINDOW_MS = 5 * 60 * 1000;
const MAX_BUILDS_PER_WINDOW = 3;

/** Default window for the overdue listing, in days past the due date. */
const DEFAULT_DAYS_MIN = 1;
const DEFAULT_DAYS_MAX = 90;
const DEFAULT_LIST_LIMIT = 50;

/** `wa_broadcasts.title` is 200 characters wide. */
const TITLE_LIMIT = 200;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Turning the SGP's invoices into WhatsApp campaigns.
 *
 * Two rules shape everything below, and neither is a matter of operator
 * discipline:
 *
 * 1. **Building a campaign never sends.** `buildCampaign` writes a `draft` and
 *    stops. Messaging hundreds of people must not be the side effect of a click
 *    on a listing screen — an operator opens the campaign, reads the rendered
 *    bodies, and presses start.
 *
 * 2. **Skips are counted by reason.** "412 skipped" tells an operator nothing.
 *    "83 with no mobile on record, 12 asked not to be contacted" tells them what
 *    to fix, and which of the two problems is theirs.
 */
class WaBillingService {
  /**
   * Os instantes das montagens de campanha na última janela, POR PROVEDOR.
   *
   * Um campo de classe em vez de um middleware, a mesma forma que o
   * `waOutboxWorker` usa para o teto dele: o que se limita é o custo para o
   * ERP do provedor (uma ida e volta por destinatário), não a taxa de
   * requisições de um navegador.
   *
   * A chave por provedor é o conserto. Era um array só, compartilhado pelo
   * processo inteiro: o provedor A montava três campanhas e os provedores B, C
   * e D levavam 429 por cinco minutos sem terem feito nada. Negação de serviço
   * cruzada, trivial de disparar, num painel que vende isolamento.
   *
   * É exatamente a classe de defeito que `config/tenantCache.js` documenta como
   * já corrigida em quatro serviços — "deixou de estar certo no momento em que
   * a configuração passou a ser por provedor". Este teto ficou de fora daquela
   * passagem.
   */
  static buildWindows = new Map();

  /**
   * Subscribers the billing cadence could contact.
   *
   * The window is SYMMETRIC around the due date: `daysOverdue` is positive for
   * an invoice that has come due and negative for one that has not, so
   * `daysMin: -5` reads as "including anyone due within the next five days".
   * One scale for both directions is what lets the same screen prepare a
   * dunning run and a reminder run.
   */
  static async listOverdue({ daysMin, daysMax, search, limit } = {}) {
    // Checked once, up front: with the integration off there is nothing to
    // list, and finding that out one contract at a time would look like every
    // subscriber having been refused.
    SgpService.requireReady(await SgpService.getConfig());

    const min = Number.isFinite(Number(daysMin)) ? Math.trunc(Number(daysMin)) : DEFAULT_DAYS_MIN;
    const max = Number.isFinite(Number(daysMax)) ? Math.trunc(Number(daysMax)) : DEFAULT_DAYS_MAX;
    const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_RECIPIENTS);
    const needle = String(search ?? '').trim().toLowerCase();

    const subscribers = this.subscribersFrom(await SgpLink.getAll())
      .filter((row) => !needle || [row.contract, row.clientName, row.phone]
        .some((field) => String(field ?? '').toLowerCase().includes(needle)))
      .slice(0, cap);

    const hoje = new Date();
    const found = [];
    for (const subscriber of subscribers) {
      // eslint-disable-next-line no-await-in-loop -- the pace IS the point; see SGP_PACE_MS
      const invoices = await this.pacedInvoices(subscriber.contract, found.length > 0);
      if (invoices === null) continue; // the SGP refused this contract; not a reason to stop
      // `true` so the listing shows the next invoice to fall due as well: at
      // this stage nobody has chosen a template, so the screen must be able to
      // show both a dunning candidate and a reminder candidate.
      const { fatura } = maisAntigaEmAberto(invoices, hoje, true);
      if (!fatura) continue;
      const days = diasEntre(fatura.dueDate, hoje);
      if (days === null || days < min || days > max) continue;
      found.push({
        contract: subscriber.contract,
        clientName: subscriber.clientName,
        document: subscriber.document,
        phone: subscriber.phone,
        phoneSource: subscriber.phoneSource,
        deviceId: subscriber.deviceId,
        amount: fatura.amount ?? null,
        dueDate: fatura.dueDate || null,
        daysOverdue: days
      });
    }
    return found;
  }

  /**
   * Builds a campaign and returns it as a DRAFT.
   *
   * Nothing here sends, and nothing here queues: the outbox never sees a
   * message until an operator moves the campaign to `running`.
   *
   * @returns {Promise<{ broadcast: object, recipients: number, skipped: object }>}
   */
  static async buildCampaign({ template, contracts, title, userId = null } = {}) {
    // Reserved on the ATTEMPT, not on success: the cost being limited is the
    // round trips, and a build that ends with nobody to contact spent them too.
    this.reserveBuild();

    const { body, templateId, name } = await WaTemplateService.resolveBody(template);
    const wanted = [...new Set(
      (Array.isArray(contracts) ? contracts : [])
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean)
    )];

    const skipped = {
      noPhone: 0,
      optOut: 0,
      noInvoice: 0,
      futureOnly: 0,
      sgpRefused: 0,
      templateIncomplete: 0
    };

    if (wanted.length === 0) {
      throw noRecipients(skipped);
    }
    if (wanted.length > MAX_RECIPIENTS) {
      throw new WaError('whatsapp.error.tooManyRecipients', {
        code: 'too_many_recipients',
        status: 400,
        vars: { max: MAX_RECIPIENTS }
      });
    }
    SgpService.requireReady(await SgpService.getConfig());

    const wantedSet = new Set(wanted);
    const byContract = new Map(
      this.subscribersFrom((await SgpLink.getAll()).filter((link) => wantedSet.has(String(link.contract ?? '').trim())))
        .map((row) => [row.contract, row])
    );

    // A contract the panel has never linked to an ONT has no phone anywhere, so
    // it lands in the same bucket as one whose cadastre is blank. From the
    // operator's side both mean the same thing: no mobile on record.
    const withPhone = [];
    for (const contract of wanted) {
      const subscriber = byContract.get(contract);
      if (!subscriber?.phone) skipped.noPhone += 1;
      else withPhone.push(subscriber);
    }

    // ONE query for the whole campaign. Asking per recipient would be hundreds
    // of round trips to answer a question a single `IN` answers.
    const blocked = await WaOptOut.activePhones(withPhone.map((row) => row.phone));
    const reachable = withPhone.filter((row) => {
      if (!blocked.has(row.phone)) return true;
      skipped.optOut += 1;
      return false;
    });

    // The template declares itself: citing `{{dias_para_vencer}}` is what makes
    // a body a reminder, and only a reminder may pick an invoice that has not
    // come due. See the header of utils/wa/waCobranca.js.
    const lembrete = modeloEhLembrete(body);
    const hoje = new Date();
    const recipients = [];
    let calls = 0;

    for (const subscriber of reachable) {
      // eslint-disable-next-line no-await-in-loop -- one round trip per recipient, paced on purpose
      const invoices = await this.pacedInvoices(subscriber.contract, calls++ > 0);
      if (invoices === null) {
        skipped.sgpRefused += 1;
        continue;
      }
      const { fatura, soFuturas } = maisAntigaEmAberto(invoices, hoje, lembrete);
      if (!fatura) {
        // Two different facts, counted apart: "owes nothing" is good news and
        // "owes something that has not come due yet" is a reason to send a
        // reminder template instead.
        if (soFuturas) skipped.futureOnly += 1;
        else skipped.noInvoice += 1;
        continue;
      }
      const rendered = renderCobranca(
        body,
        variaveisDeCobranca(fatura, subscriber.clientName, hoje)
      );
      // A null render means a variable the body cites has no value. The
      // recipient is DROPPED — never sent a partial message. "PIX: " with
      // nothing after it tells a subscriber to pay a placeholder.
      if (rendered === null) {
        skipped.templateIncomplete += 1;
        continue;
      }
      recipients.push({
        contract: subscriber.contract,
        clientName: subscriber.clientName,
        phone: subscriber.phone,
        body: rendered
      });
    }

    if (recipients.length === 0) throw noRecipients(skipped);

    const config = await WhatsAppConfigService.getConfig();
    const account = await WhatsAppAccount.getForPurpose('billing');
    const broadcast = await WaBroadcast.create({
      title: String(title || name || `Cobrança ${comoDataBr(hoje)}`).trim().slice(0, TITLE_LIMIT),
      template_id: templateId,
      body,
      // Recorded as the intended sender, not as a commitment: the flush loop
      // resolves the number again at send time, because a campaign can sit in
      // draft for a day and numbers reconnect.
      account_id: account?.id ?? null,
      status: 'draft',
      rate_limit_per_min: config.rateLimitPerMin,
      total_count: recipients.length,
      created_by: userId
    });
    await WaBroadcast.addRecipients(broadcast.id, recipients);

    return { broadcast, recipients: recipients.length, skipped };
  }

  /**
   * One SGP round trip, paced.
   *
   * Live rather than from a snapshot on purpose: a boleto that was reissued has
   * a new digitable line and a new PIX code, and a message carrying the old one
   * sends the subscriber to a bank that will refuse it.
   *
   * @returns {Promise<object[]|null>} null when the SGP refused this contract
   */
  static async pacedInvoices(contract, pace = true) {
    if (pace) await sleep(SGP_PACE_MS);
    try {
      const { invoices } = await SgpService.listInvoices({ contract, onlyOpen: true });
      return invoices;
    } catch (error) {
      // One refused contract is a fact about that contract — an unknown
      // customer, a cadastre in a state the ERP will not answer for. It must
      // not end the run for everybody else.
      if (error instanceof SgpError) return null;
      throw error;
    }
  }

  /**
   * Sets or clears the operator's correction to a subscriber's number.
   *
   * The whole billing cadence hangs off this one field. A number the ERP has
   * wrong does not announce itself: the subscriber lands in `noPhone` — or,
   * worse, someone else's phone rings — quietly, campaign after campaign, and
   * until now the only way to fix it was an UPDATE typed against the database.
   *
   * An empty `phone` CLEARS the override and hands the contract back to
   * whatever the last sync wrote. That is a real operation and not a malformed
   * request: an operator who mistyped a correction has to be able to undo it
   * without inventing a number, and the ERP's own record is the fallback the
   * reader already prefers when there is no manual one.
   *
   * @returns {Promise<object>} the subscriber as the listing shows them, minus
   *   the invoice fields — those cost an SGP round trip and nothing about this
   *   write can have changed them.
   */
  static async setSubscriberPhone(contract, phone) {
    const key = String(contract ?? '').trim();
    // Read before write: `update` reports rows touched, which on a contract
    // that does not exist and on one whose number is already the typed value
    // is the same zero. Only one of those is a 404.
    const existing = key ? await SgpLink.getByContract(key) : [];
    if (existing.length === 0) {
      throw new WaError('whatsapp.error.subscriberNotFound', {
        code: 'subscriber_not_found',
        status: 404
      });
    }

    const wanted = String(phone ?? '').trim();
    const digits = wanted ? normalizarTelefoneBr(wanted) : '';
    // Only a non-empty entry can be invalid. `normalizarTelefoneBr` refuses
    // rather than guessing — it never invents the ninth digit — so what it
    // rejects here is a number that could not be dialled, not one it is unsure
    // about.
    if (wanted && !digits) {
      throw new WaError('whatsapp.error.invalidPhone', { code: 'invalid_phone', status: 400 });
    }

    // Stored normalised, in the form a send actually uses. Keeping "(93)
    // 98111-0449" would leave the correction looking right on screen and
    // matching nothing at dispatch time — the same failure the do-not-disturb
    // list normalises on the way in to avoid.
    await SgpLink.setManualPhone(key, digits || null);

    const [subscriber] = this.subscribersFrom(await SgpLink.getByContract(key));
    return subscriber;
  }

  /** `sgp_links` rows as subscribers, one per contract. */
  static subscribersFrom(links) {
    const byContract = new Map();
    for (const link of links || []) {
      const contract = String(link.contract ?? '').trim();
      if (!contract || byContract.has(contract)) continue;
      // The manual override wins and a sync never touches it: an operator who
      // corrected a number did so because the ERP's is wrong.
      const manual = normalizarTelefoneBr(link.phone_manual);
      const fromSgp = normalizarTelefoneBr(link.phone_e164);
      byContract.set(contract, {
        contract,
        clientName: link.client_name || null,
        document: link.document || null,
        deviceId: link.device_id || null,
        phone: manual || fromSgp || null,
        phoneSource: manual ? 'manual' : (fromSgp ? 'sgp' : null)
      });
    }
    return [...byContract.values()];
  }

  // ── The build ceiling ──────────────────────────────────────────────

  static reserveBuild() {
    const tenantId = currentTenantId();
    const cutoff = Date.now() - BUILD_WINDOW_MS;
    const janela = (this.buildWindows.get(tenantId) || []).filter((at) => at > cutoff);

    if (janela.length >= MAX_BUILDS_PER_WINDOW) {
      // A janela podada volta para o mapa mesmo na recusa: sem isso, um
      // provedor que insiste mantém entradas velhas vivas para sempre.
      this.buildWindows.set(tenantId, janela);
      throw new WaError('whatsapp.error.rateLimited', { code: 'rate_limited', status: 429 });
    }

    janela.push(Date.now());
    this.buildWindows.set(tenantId, janela);
  }

  /** Esquece a janela de um provedor. Existe para o teste, e para o `stop`. */
  static resetBuildWindow(tenantId = currentTenantId()) {
    this.buildWindows.delete(tenantId);
  }
}

/**
 * Nobody left to contact.
 *
 * The counts ride along on the error because they are the answer the operator
 * actually needs: the build failing is not news, "every one of them is on the
 * do-not-disturb list" is.
 */
function noRecipients(skipped) {
  const error = new WaError('whatsapp.error.noRecipients', {
    code: 'no_recipients',
    status: 409
  });
  error.skipped = skipped;
  return error;
}

export default WaBillingService;
