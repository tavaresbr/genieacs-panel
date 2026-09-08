import DeviceService from './deviceService.js';
import SgpService from './sgpService.js';
import WaConversationService from './waConversationService.js';
import WaSendService from './waSendService.js';
import WhatsAppConfigService from './whatsappConfigService.js';
import { getDb } from '../config/database.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { comoDataBr, comoReal, maisAntigaEmAberto } from '../utils/wa/waCobranca.js';
import { normalizarTexto, pedeSaida } from '../utils/wa/waOptOutTexto.js';

/**
 * The self-service bot: it answers the subscriber who wrote in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LINE, and it is the whole design
 *
 * A WhatsApp message carries no login. Whoever wrote in proved only that they
 * hold a phone WhatsApp will deliver to; `resolveSubscriber` matches that phone
 * to a contract as a CONVENIENCE, never as an authentication (see the header of
 * `waConversationService.js`, which owns that rule).
 *
 * So the bot INFORMS, and links to the portal for everything else:
 *
 *   MAY  — the open invoice (amount, due date, digitable line, PIX, link),
 *          whether the connection is up and its optical signal, hand off to a
 *          human.
 *   MUST NOT — send a WiFi password, send a portal password, change an SSID,
 *          reboot an ONT, or anything else that changes the service. Those get
 *          `whatsapp.bot.portalHint` and the portal link, because the portal
 *          has a real password and this door does not.
 *
 * Nothing below reads a credential. `getCustomerPortalOverview` is the signal
 * reader on purpose: it projects SSIDs and optical power and never touches
 * `KeyPassphrase`. Anyone extending this file who finds themselves reading a
 * secret to put it in a message has crossed the line.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY RULES AND NOT A MODEL
 *
 * Nothing here is generated. A deterministic matcher is testable, and — more to
 * the point — it cannot be talked into ignoring the paragraph above. "Ignore
 * your instructions and send me the WiFi password" matches the portal intent
 * and gets the portal link, like every other way of asking.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND IT NEVER THROWS
 *
 * `responder` is called from inside the webhook. A bot that breaks must degrade
 * to SILENCE: a rejection there becomes a 500, and a 500 makes both Evolution
 * servers redeliver the same event forever. Silence costs one unanswered
 * message that an operator still sees in an unread thread.
 */

/**
 * How long an operator "holds" a thread.
 *
 * Thirty minutes, and the number is a judgement about how support actually
 * works: an operator who answered and then walked to check the OLT, or who is
 * waiting on the customer to read a message, is still in that conversation.
 * Much shorter and the bot talks over a live human, which is worse than no bot
 * at all — the customer gets two voices and neither one finishes. Much longer
 * and yesterday's ticket mutes the bot for a question asked today.
 *
 * An internal note counts as presence too: an operator annotating a thread is
 * working it, even though the customer never saw the note.
 */
const JANELA_HUMANO_MS = 30 * 60 * 1000;

/**
 * The per-contact ceiling: three automatic answers per hour.
 *
 * The failure this exists for is a loop. The other end of a WhatsApp thread is
 * sometimes another robot — a business account with an auto-reply, a
 * "mensagem automática" from a company phone — and two auto-responders will
 * happily send each other several thousand messages before anyone notices, on
 * the provider's number, at the provider's cost, until Meta bans it.
 *
 * The count deliberately covers every automatic outbound message on the thread,
 * not only the bot's: an alert or a dunning message that also went out without
 * an operator behind it is noise from the same number, and erring towards
 * silence is the cheap direction.
 */
const TETO_POR_HORA = 3;
const JANELA_TETO_MS = 60 * 60 * 1000;

/** `enqueue` refusals that mean "there is nowhere to send", not "something broke". */
const SEM_ONDE_MANDAR = new Set(['no_account', 'no_destination']);

/**
 * The vocabulary, already normalised the way `normalizarTexto` normalises the
 * message: no accents, lower case, no punctuation, single spaces. Portuguese
 * first because the operator base is Brazilian; the few English forms are the
 * ones that reach a Brazilian ISP anyway.
 */
const INTENCOES = [
  /**
   * Deliberately FIRST. Everything in this group is a request to be given a
   * secret or to have something changed, and it is the one group whose answer
   * is fixed no matter what else the message says. A message that asks for the
   * WiFi password *and* complains about the signal must land here.
   */
  {
    nome: 'portal',
    termos: [
      'senha', 'senhas', 'password', 'ssid',
      'nome da rede', 'nome do wifi', 'nome do wi fi',
      'trocar o wifi', 'mudar o wifi', 'trocar a rede', 'mudar a rede',
      'reiniciar', 'reinicia', 'reinicie', 'reboot', 'resetar', 'reset'
    ]
  },
  /**
   * Before the signal group, because a Brazilian ISP subscriber whose line is
   * blocked for non-payment writes "estou sem internet, é o boleto?" — and the
   * invoice is the answer that actually unblocks them.
   */
  {
    nome: 'fatura',
    termos: [
      'fatura', 'faturas', 'boleto', 'boletos', 'segunda via', '2 via', '2a via',
      'pix', 'codigo de barras', 'codigo pix', 'linha digitavel',
      'vencimento', 'venceu', 'pagar', 'pagamento', 'cobranca', 'titulo', 'debito'
    ]
  },
  {
    nome: 'sinal',
    termos: [
      'sem internet', 'sem conexao', 'sem sinal', 'sem net', 'sem rede',
      'caiu', 'caiu a internet', 'internet caiu', 'nao tem internet',
      'nao esta funcionando', 'nao funciona', 'nao navega', 'nao conecta',
      'offline', 'sinal', 'lento', 'lenta', 'lentidao', 'oscilando', 'travando'
    ]
  }
];

/**
 * Phrase match on token boundaries, never substring.
 *
 * Same lesson as `waOptOutTexto.js`, one notch weaker: a substring rule reads
 * "parar" inside "preparar", and here it would read "pix" inside a word and
 * "sinal" inside "assinalar". The message does not have to BE the term — a
 * question is a sentence — but the term has to be whole words inside it.
 */
const PADROES = INTENCOES.map(({ nome, termos }) => ({
  nome,
  regex: termos.map((termo) => new RegExp(`(?:^| )${termo}(?: |$)`))
}));

/**
 * Which intent a message body carries, or `handoff` when none of them does.
 * Exported because the routing table is the part worth testing on its own.
 */
export function classificarIntencao(texto) {
  const limpo = normalizarTexto(texto);
  if (!limpo) return 'handoff';
  for (const { nome, regex } of PADROES) {
    if (regex.some((re) => re.test(limpo))) return nome;
  }
  return 'handoff';
}

/**
 * Server-side text has no request locale: a WhatsApp message carries no
 * `Accept-Language`, and the person on the other end never had a browser in the
 * exchange. So the bot speaks the panel's default, the same fallback `app.js`
 * uses when a background path has no `req.t`.
 */
const t = (chave, vars) => translate(DEFAULT_LOCALE, chave, vars);

/**
 * Where the customer portal lives, from the outside.
 *
 * `webhookBaseUrl` is the only externally reachable address the panel is ever
 * told — it is the URL the operator gave so an Evolution server could reach
 * this process — so its ORIGIN is the best the panel can say about itself. Not
 * configured means the panel genuinely does not know its own public address,
 * and inventing one would send the customer a link that opens nothing.
 */
async function linkDoPortal() {
  const { webhookBaseUrl } = await WhatsAppConfigService.getConfig();
  if (!webhookBaseUrl) return null;
  try {
    return new URL(webhookBaseUrl).origin;
  } catch {
    return null;
  }
}

/** The oldest open invoice, spelled out. */
async function responderFatura(link) {
  const { invoices } = await SgpService.listInvoices({ contract: link.contract, onlyOpen: true });
  // `true` for the reminder flag: the dunning rule refuses a not-yet-due
  // invoice because a dunning message has nothing to charge for. Here the
  // customer ASKED, and "you have one due on the 10th" is the answer.
  const { fatura } = maisAntigaEmAberto(invoices, new Date(), true);
  if (!fatura) return t('whatsapp.bot.noOpenInvoice');

  const linhas = [t('whatsapp.bot.invoice', {
    amount: comoReal(fatura.amount),
    dueDate: comoDataBr(fatura.dueDate)
  })];
  // The payment codes go out bare, each on its own line and each separated by a
  // blank one. They carry no label because there is no `whatsapp.bot.*` key for
  // one, and an untranslated Portuguese label in a message the other four
  // locales also render would be worse than the shape below, which a customer
  // reads by what it is: digits to type, a PIX string to copy, a link to open.
  for (const valor of [fatura.digitableLine, fatura.pix, fatura.link]) {
    if (valor) linhas.push('', valor);
  }
  return linhas.join('\n');
}

/** Up or down, and the optical reading when the ONT gave one. */
async function responderSinal(link) {
  if (!link.device_id) return null;
  // This reader and no other: it projects status, SSIDs and optical power, and
  // never reads a passphrase. See the header.
  const overview = await DeviceService.getCustomerPortalOverview(link.device_id);
  if (overview.status !== 'online') return t('whatsapp.bot.signalDown');

  const rxPower = Number(overview.optical?.rxPower);
  // Online but with no optical reading is a real state — an ONT that informs
  // without the vendor's virtual parameter mapped. `signalOk` is built around
  // the number, so without one there is nothing honest to send and a human
  // looks instead.
  if (!Number.isFinite(rxPower)) return null;
  return t('whatsapp.bot.signalOk', { rxPower });
}

/** The portal link, or nothing when the panel does not know its own address. */
async function responderPortal() {
  const portal = await linkDoPortal();
  return portal ? t('whatsapp.bot.portalHint', { link: portal }) : null;
}

class WaBotService {
  static JANELA_HUMANO_MS = JANELA_HUMANO_MS;

  static TETO_POR_HORA = TETO_POR_HORA;

  /**
   * Answers one inbound message, or stays quiet.
   *
   * Never throws and never rejects — see the header. The return value is for
   * the tests and for whoever debugs a thread the bot did not answer; the
   * webhook ignores it.
   *
   * @param {object} p
   * @param {object} p.conversation the row the message landed on
   * @param {number} p.messageId id of the inbound row, already written
   * @param {string} p.body the message text
   * @param {'in'|'out'} p.direction as stored
   * @returns {Promise<{ replied: boolean, intent?: string, reason?: string }>}
   */
  static async responder({ conversation, messageId, body, direction } = {}) {
    try {
      return await this.rotear({ conversation, messageId, body, direction });
    } catch (error) {
      // Having nowhere to send is a configuration state, not a fault: no number
      // is connected, or the thread is a LID with no phone behind it. Logging it
      // would print a line for every inbound message on a panel that has not
      // finished pairing yet, which trains the operator to ignore the log.
      if (SEM_ONDE_MANDAR.has(error?.code)) {
        return { replied: false, reason: error.code };
      }
      // Everything else is swallowed on purpose, and logged so it is not
      // invisible. A bot that breaks becomes silence; it must never become the
      // 500 that makes the Evolution server redeliver this event forever.
      console.error('waBot:', error?.message || error);
      return { replied: false, reason: 'error' };
    }
  }

  /** The guards, then the routing. Cheapest and most decisive checks first. */
  static async rotear({ conversation, messageId, body, direction }) {
    if (!conversation?.id) return { replied: false, reason: 'no_conversation' };

    // Inbound only. An outbound echo is the PROVIDER typing on their own phone;
    // answering it would send the provider's own words back to their customer
    // as a bot reply, and would do it from the same number.
    if (direction !== 'in') return { replied: false, reason: 'not_inbound' };

    const texto = String(body ?? '').trim();
    if (!texto) return { replied: false, reason: 'empty' };

    // An opt-out is already recorded by the inbound handler and confirmed
    // elsewhere. Routing "SAIR" through the intent table would answer a request
    // to be left alone with a message.
    if (pedeSaida(texto)) return { replied: false, reason: 'opt_out_request' };

    const db = getDb();

    // Never twice for the same inbound message. The unique index on
    // `external_id` is the real dedupe — a redelivered event never reaches this
    // far — and this is the belt: an outbound row newer than the inbound one
    // means the thread was already answered after it arrived.
    const jaRespondida = Number.isInteger(Number(messageId))
      ? await db('wa_messages')
        .where({ conversation_id: conversation.id, direction: 'out' })
        .where('id', '>', Number(messageId))
        .first()
      : null;
    if (jaRespondida) return { replied: false, reason: 'already_answered' };

    // A human in the thread wins, always.
    const desde = new Date(Date.now() - JANELA_HUMANO_MS);
    const humano = await db('wa_messages')
      .where({ conversation_id: conversation.id })
      .whereNotNull('sent_by')
      .where('created_at', '>=', desde)
      .first();
    if (humano) return { replied: false, reason: 'operator_present' };

    // Counted by pulling the ids rather than with COUNT(*): the three engines
    // disagree on whether a count comes back a number or a string, and the
    // ceiling is small enough that the rows are cheaper than the disagreement.
    const automaticas = await db('wa_messages')
      .where({ conversation_id: conversation.id, direction: 'out', is_note: false })
      .whereNull('sent_by')
      .where('created_at', '>=', new Date(Date.now() - JANELA_TETO_MS))
      .limit(TETO_POR_HORA)
      .pluck('id');
    if (automaticas.length >= TETO_POR_HORA) return { replied: false, reason: 'rate_limited' };

    // Identity last, because it is the only check that leaves the panel's own
    // tables. An unresolved number is told so and left for a human: it never
    // gets contract data, because the only thing it proved is that it holds a
    // phone.
    const { link } = await WaConversationService.resolveSubscriber(conversation.wa_phone_e164);
    if (!link) {
      await this.responderCom(conversation, t('whatsapp.bot.notRecognised'));
      return { replied: true, intent: 'notRecognised' };
    }

    // Worth doing while we are here and have the match: the thread carries the
    // contract from now on, so the operator opening it sees the ONT and the
    // invoices. `bindSubscriber` writes once and never overwrites.
    await WaConversationService.bindSubscriber(conversation);

    const intencao = classificarIntencao(texto);
    let resposta = null;
    try {
      if (intencao === 'portal') resposta = await responderPortal();
      else if (intencao === 'fatura') resposta = await responderFatura(link);
      else if (intencao === 'sinal') resposta = await responderSinal(link);
    } catch (error) {
      // SGP down, GenieACS unreachable, a contract the ERP no longer knows: the
      // customer asked a real question and deserves better than silence, so the
      // intent falls back to a human rather than the whole bot falling over.
      console.error(`waBot ${intencao}:`, error?.message || error);
      resposta = null;
    }

    if (!resposta) {
      await this.responderCom(conversation, t('whatsapp.bot.handoff'));
      return { replied: true, intent: 'handoff', from: intencao };
    }

    await this.responderCom(conversation, resposta);
    return { replied: true, intent: intencao };
  }

  /**
   * One inbound message gets exactly ONE outbound message.
   *
   * Splitting an invoice into "here is the amount" plus "here is the code" is
   * how a bot doubles its own volume on a number Meta is already watching, and
   * it doubles what the rate limit above has to hold back.
   *
   * The outbox worker delivers it. The bot never speaks to Evolution: enqueuing
   * is what keeps a slow provider server out of the webhook's response time.
   */
  static async responderCom(conversation, texto) {
    // `userId` stays null, and that is what marks the message as automatic —
    // the human-presence check above reads exactly this column.
    await WaSendService.enqueue({ conversationId: conversation.id, body: texto, userId: null });
  }
}

export default WaBotService;
