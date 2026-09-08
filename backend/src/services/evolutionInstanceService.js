import crypto from 'node:crypto';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { PURPOSES, WaError, randomToken } from './whatsappConfigService.js';
import { EvolutionClient, clientForAccount } from './evolutionClient.js';
import {
  checkNumbersRequest,
  connectRequest,
  createInstanceRequest,
  deleteRequest,
  listInstancesRequest,
  logoutRequest,
  qrRequest,
  readInstances,
  readNumberChecks,
  readQr,
  readStatus,
  reconnectRequest,
  statusRequest,
  webhookUrlWithToken
} from '../utils/wa/evolutionApi.js';

/** How much of a server message is kept in `last_error` / `serverError`. */
const FAILURE_TEXT_LIMIT = 300;

/** One check request is one round trip to WhatsApp, so it stays bounded. */
const MAX_NUMBER_CHECK = 100;

/**
 * A name the panel minted is recognisable in the server's own listing, and two
 * panels pointed at one Evolution server never collide.
 */
function mintName() {
  return `skygp_${crypto.randomBytes(4).toString('hex')}_${Date.now().toString(36)}`;
}

function bodyText(data) {
  if (data === null || data === undefined) return '';
  return typeof data === 'string' ? data : JSON.stringify(data);
}

function httpError(result) {
  return new WaError('whatsapp.error.httpError', {
    code: 'http_error',
    status: 502,
    vars: { status: result.status, body: bodyText(result.data).slice(0, FAILURE_TEXT_LIMIT) }
  });
}

/**
 * A failure as a short line that can be stored and shown.
 *
 * `WaError.message` is a translation key, which is meaningless in a database
 * column read months later, so what gets kept is the machine code plus the
 * server's own words when it had any.
 */
function describeFailure(error) {
  if (error instanceof WaError) {
    const vars = error.translationVars || {};
    const detail = vars.body ?? vars.reason ?? '';
    return [error.code, detail].filter(Boolean).join(': ').slice(0, FAILURE_TEXT_LIMIT);
  }
  return String(error?.message || error).slice(0, FAILURE_TEXT_LIMIT);
}

/**
 * Creating an instance whose name the server already knows is the RECONNECT
 * path, not a failure: the row can be gone from the panel while the instance
 * survives on the server. Treating it as an error would leave that instance
 * unreachable from here forever.
 */
const ALREADY_EXISTS = /already exists|already in use/i;

/**
 * Evolution GO answers `400 {"error":"no QR code available"}` for the few
 * seconds its whatsmeow client takes to boot. Reporting that as an error sends
 * the operator looking for a problem that fixes itself; it is a "not yet".
 */
const QR_PENDING = /no qr|qr[^"]{0,20}not (yet )?available|not available/i;

/** The server has nothing to restart — pairing again is the only way forward. */
const NO_SESSION = /no active session|no session|not logged in|not connected/i;

/**
 * Reads the instance id the server echoes back from a create.
 *
 * Ours is sent in the payload and Evolution GO adopts it as the primary key,
 * but v2 mints its own, and on GO the delete route takes the id and nothing
 * else — so the value the server confirms is preferred over the one we asked
 * for.
 */
function readInstanceId(data) {
  const d = data && typeof data === 'object' ? data : {};
  const inner = d.data && typeof d.data === 'object' ? d.data : {};
  const nested = d.instance && typeof d.instance === 'object' ? d.instance : {};
  for (const value of [nested.instanceId, nested.id, inner.instanceId, inner.id, d.instanceId, d.id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * The key the instance will actually answer to.
 *
 * v2 may accept the token we sent and then hand back a different `hash`; on GO
 * that same value is what selects the instance on every later request. Storing
 * the one we minted when the server chose another means every subsequent call
 * reaches either nothing or — worse, on GO — no instance at all.
 */
function readApiKey(data) {
  const d = data && typeof data === 'object' ? data : {};
  const inner = d.data && typeof d.data === 'object' ? d.data : {};
  const hash = d.hash ?? inner.hash;
  for (const value of [hash?.apikey, hash, d.apikey, inner.apikey, inner.token]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

class EvolutionInstanceService {
  /**
   * The configuration, refusing early when the integration cannot work.
   *
   * `requireWebhook` is only true for account creation: the webhook URL is
   * written into the instance at create time and nowhere else, while asking a
   * server for a QR or a state does not depend on it.
   */
  static async requireConfig({ requireWebhook = false } = {}) {
    const config = await WhatsAppConfigService.getConfig();
    if (!config.enabled) {
      throw new WaError('whatsapp.error.notConfigured', { code: 'not_configured', status: 400 });
    }
    if (requireWebhook && !config.webhookBaseUrl) {
      throw new WaError('whatsapp.error.incompleteConfig', { code: 'incomplete_config', status: 400 });
    }
    return config;
  }

  /**
   * Which Evolution server this create is aimed at.
   *
   * With `managedUrl` set the panel owns the server and the operator never sees
   * its address or its key; without it each account carries its own, and the
   * request has to supply both.
   */
  static resolveTarget(config, { baseUrl, adminKey } = {}) {
    if (config.managedUrl) {
      return { baseUrl: config.managedUrl, adminKey: config.managedAdminKey };
    }
    return { baseUrl: String(baseUrl || '').trim(), adminKey: String(adminKey || '').trim() };
  }

  static async loadAccount(id) {
    const numeric = Number.parseInt(String(id ?? ''), 10);
    // Parsed here rather than in the controller because a non-numeric id
    // reaching knex is a database error on Postgres, not a 404.
    const account = Number.isInteger(numeric) && numeric > 0
      ? await WhatsAppAccount.getById(numeric)
      : null;
    if (!account) {
      throw new WaError('whatsapp.error.accountNotFound', { code: 'account_not_found', status: 404 });
    }
    return account;
  }

  /** A client bound to one stored account, carrying that account's token. */
  static clientFor(account, config) {
    return clientForAccount(account, config, WhatsAppConfigService.decryptInstanceToken(account));
  }

  static normalizePurpose(value, fallback = 'general') {
    if (value === undefined || value === null || value === '') return fallback;
    const purpose = String(value).trim();
    if (!PURPOSES.includes(purpose)) {
      // No dedicated key exists for this, and it is not worth one: only a
      // hand-written request can get here, since the panel offers a fixed list.
      throw new WaError('whatsapp.accountActionFailed', { code: 'invalid_purpose', status: 400 });
    }
    return purpose;
  }

  /**
   * Creates an instance on the server and pairs it with a row here.
   *
   * The expensive path of the integration: it mints two secrets, talks to the
   * server up to four times and leaves an instance behind on it. Everything it
   * touches is therefore recorded, including a create that only got half way —
   * see the persist step.
   */
  static async createAccount({ baseUrl, adminKey, label, purpose } = {}) {
    const config = await this.requireConfig({ requireWebhook: true });
    const target = this.resolveTarget(config, { baseUrl, adminKey });
    const chosenPurpose = this.normalizePurpose(purpose);

    const client = new EvolutionClient({
      baseUrl: target.baseUrl,
      allowedHosts: config.allowedHosts,
      adminKey: target.adminKey
    });
    // Before any payload is built. The two servers share almost no field names,
    // and discovering which one answers by reading its 400s is how the system
    // this is ported from spent its first week.
    const flavor = await client.detectFlavor();

    const name = mintName();
    const instanceToken = randomToken();
    const webhookToken = randomToken();
    const webhookUrl = webhookUrlWithToken(config.webhookBaseUrl, webhookToken);
    let instanceId = crypto.randomUUID();

    const created = await client.send(createInstanceRequest(flavor, {
      name,
      token: instanceToken,
      instanceId,
      webhookUrl,
      rejectCallMessage: config.rejectCallMessage
    }));

    let apiKey = instanceToken;
    if (created.ok) {
      instanceId = readInstanceId(created.data) || instanceId;
      apiKey = readApiKey(created.data) || instanceToken;
    } else {
      if (!ALREADY_EXISTS.test(bodyText(created.data))) throw httpError(created);
      // The listing is the only way back to the server's id for an instance we
      // did not just create. It does not carry the instance token — that is
      // stripped on purpose in `readInstances` — so the token we minted is kept
      // and a GO instance that already had another one will need pairing again.
      instanceId = (await this.findServerId(client, flavor, name)) || instanceId;
    }

    // From here the instance exists on the server, so every call carries its
    // own credential rather than the server's global key.
    client.instanceToken = apiKey;

    let qr = readQr(created.data).qr;
    let lastError = null;
    try {
      if (flavor === 'go') {
        // GO writes `instance.Webhook` and starts the whatsmeow client here,
        // not on create. Skipping it leaves an instance that exists and never
        // connects.
        await client.sendOrThrow(connectRequest(flavor, webhookUrl));
      }
      if (!qr) qr = await this.readFreshQr(client, flavor, name);
    } catch (error) {
      // The row is written anyway: the instance is already on the server, and
      // this row is the only handle the panel will ever have on it. Without it
      // the operator cannot even delete what was just created.
      lastError = describeFailure(error);
    }

    const account = await WhatsAppAccount.create({
      name,
      label: label ? String(label).trim().slice(0, 128) : null,
      purpose: chosenPurpose,
      flavor,
      base_url: client.baseUrl,
      instance_id: instanceId,
      status: 'connecting',
      qr_code: qr,
      qr_updated_at: qr ? new Date() : null,
      last_error: lastError,
      ...WhatsAppConfigService.encryptInstanceToken(apiKey),
      ...WhatsAppConfigService.encryptWebhookToken(webhookToken)
    });

    return { account, qr, pending: !qr };
  }

  /** The server's own id for an instance it says it already has. */
  static async findServerId(client, flavor, name) {
    const listed = await client.send(listInstancesRequest(flavor));
    if (!listed.ok) return null;
    const found = readInstances(flavor, listed.data).find((instance) => instance.name === name);
    return found?.id || null;
  }

  /**
   * One QR read, where "not yet" is `null` rather than an exception.
   *
   * @returns {Promise<string|null>}
   */
  static async readFreshQr(client, flavor, name) {
    const result = await client.send(qrRequest(flavor, name));
    if (!result.ok) {
      if (QR_PENDING.test(bodyText(result.data))) return null;
      throw httpError(result);
    }
    return readQr(result.data).qr;
  }

  /** A fresh QR for an account that is waiting to be paired. */
  static async refreshQr(id) {
    const config = await this.requireConfig();
    const account = await this.loadAccount(id);
    const client = this.clientFor(account, config);
    const qr = await this.readFreshQr(client, account.flavor, account.name);
    if (!qr) return { account, qr: null, pending: true };

    // A server that hands out a QR is by definition unpaired, whatever the row
    // says — a number that dropped without a `connection_update` reaching us
    // would otherwise sit on 'connected' while showing a QR.
    const updated = await WhatsAppAccount.update(account.id, {
      qr_code: qr,
      qr_updated_at: new Date(),
      status: 'connecting',
      last_error: null
    });
    return { account: updated, qr, pending: false };
  }

  /**
   * Asks the server what it thinks, and writes back only when the answer is
   * worth more than what is stored.
   *
   * The rule is asymmetric on purpose. `connected` always wins: a lost
   * `connection_update` would otherwise leave a paired number amber forever,
   * and this is the escape hatch an operator can press. `disconnected` only
   * wins over `connected`, because a number that never finished pairing reads
   * as disconnected from the server for as long as the QR is on screen, and
   * overwriting `connecting` with it would erase the pairing in progress.
   */
  static async checkStatus(id) {
    const config = await this.requireConfig();
    const account = await this.loadAccount(id);
    const client = this.clientFor(account, config);
    const result = await client.sendOrThrow(statusRequest(account.flavor, account.name));
    const state = readStatus(account.flavor, result.data);

    const write = state === 'connected'
      || (state === 'disconnected' && account.status === 'connected');
    if (!write) return { account, state };

    const patch = { status: state, last_error: null };
    if (state === 'connected') {
      patch.last_seen_at = new Date();
      // The QR is spent the moment the pairing lands; keeping it would offer
      // the operator a code that can no longer be scanned.
      patch.qr_code = null;
      patch.qr_updated_at = null;
    }
    return { account: await WhatsAppAccount.update(account.id, patch), state };
  }

  /** Reconnect (GO) / restart (v2), for a session that exists but went quiet. */
  static async restart(id) {
    const config = await this.requireConfig();
    const account = await this.loadAccount(id);
    const client = this.clientFor(account, config);
    const result = await client.send(reconnectRequest(account.flavor, account.name));
    if (!result.ok) {
      if (NO_SESSION.test(bodyText(result.data))) {
        // Distinct from a transport failure: there is nothing to restart, and
        // the way out is to disconnect and pair again.
        throw new WaError('whatsapp.error.noSession', { code: 'no_session', status: 409 });
      }
      throw httpError(result);
    }
    return { account: await WhatsAppAccount.update(account.id, { status: 'connecting', last_error: null }) };
  }

  /** Logout. The only way to make the server issue a new QR for a paired number. */
  static async disconnect(id) {
    const config = await this.requireConfig();
    const account = await this.loadAccount(id);
    const client = this.clientFor(account, config);
    await client.sendOrThrow(logoutRequest(account.flavor, account.name));
    return {
      account: await WhatsAppAccount.update(account.id, {
        status: 'disconnected',
        qr_code: null,
        qr_updated_at: null
      })
    };
  }

  /**
   * Removes the instance from the server and the row from the panel.
   *
   * The row goes regardless of what the server answers, and the caller is told
   * which of the two happened. Refusing to delete locally because a server that
   * may no longer exist did not confirm would leave the operator with a row
   * they cannot get rid of; claiming success when the instance is still running
   * would leave one they do not know about.
   */
  static async remove(id, { adminKey } = {}) {
    const config = await WhatsAppConfigService.getConfig();
    const account = await this.loadAccount(id);
    const client = this.clientFor(account, config);
    // Self-host accounts store no admin key — the server's global key belongs
    // to the configuration, not to a row — so the request may carry it.
    if (adminKey) client.adminKey = String(adminKey).trim();

    let removedOnServer = false;
    let serverError = null;
    try {
      // Best effort: an instance that cannot log out is one we are deleting
      // anyway, and its failure must not stop the delete below.
      await client.send(logoutRequest(account.flavor, account.name)).catch(() => null);

      const request = deleteRequest(account.flavor, account.name, account.instance_id);
      if (!request) {
        // GO deletes by id and by nothing else.
        serverError = 'missing_instance_id';
      } else {
        const result = await client.send(request);
        removedOnServer = result.ok;
        if (!result.ok) serverError = describeFailure(httpError(result));
      }
    } catch (error) {
      serverError = describeFailure(error);
    }

    await WhatsAppAccount.remove(account.id);
    return { removedOnServer, serverError };
  }

  /** Panel-side metadata. Nothing here reaches the Evolution server. */
  static async updateAccount(id, { label, purpose, isDefault } = {}) {
    const account = await this.loadAccount(id);
    const patch = {};
    if (label !== undefined) {
      const text = String(label ?? '').trim().slice(0, 128);
      patch.label = text || null;
    }
    if (purpose !== undefined) patch.purpose = this.normalizePurpose(purpose, account.purpose);
    if (isDefault === false) patch.is_default = false;

    let updated = Object.keys(patch).length ? await WhatsAppAccount.update(account.id, patch) : account;
    // Through the model, because exactly one row may hold the flag and clearing
    // the others is part of setting it.
    if (isDefault === true) updated = await WhatsAppAccount.setDefault(account.id);
    return updated;
  }

  /**
   * Which of these numbers are on WhatsApp.
   *
   * Answered by whichever connected number the routing picks: the question is
   * about WhatsApp, not about the account, and asking through a disconnected
   * instance would report every number as absent.
   */
  static async checkNumbers(numbers) {
    const config = await this.requireConfig();
    const requested = (Array.isArray(numbers) ? numbers : [])
      .map((value) => String(value ?? '').replace(/\D/g, ''))
      .filter(Boolean)
      .slice(0, MAX_NUMBER_CHECK);
    if (!requested.length) return [];

    const account = await WhatsAppAccount.getForPurpose('general');
    if (!account) {
      throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 400 });
    }
    const client = this.clientFor(account, config);
    const result = await client.sendOrThrow(
      checkNumbersRequest(account.flavor, account.name, requested)
    );
    const found = readNumberChecks(account.flavor, result.data);

    // Answered in the order asked, and keyed back to what was asked. WhatsApp
    // normalises Brazilian numbers by adding or dropping the ninth digit, so an
    // exact match on what came back would report a real number as absent; the
    // last eight digits survive that rewrite.
    return requested.map((number) => {
      const exact = found.find((entry) => entry.number === number);
      const tail = exact || found.find((entry) => entry.number.endsWith(number.slice(-8)));
      return { number, exists: Boolean(tail?.exists) };
    });
  }
}

export default EvolutionInstanceService;
