import crypto from 'node:crypto';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { PURPOSES, WaError, randomToken } from './whatsappConfigService.js';
import { EvolutionClient, clientForAccount } from './evolutionClient.js';
import { safeFetch } from '../utils/wa/ssrfGuard.js';
import { mintNonce, probeBody, probeVerdict } from '../utils/wa/waWebhookProbe.js';
import { sign as signProbeTicket } from '../utils/wa/waProbeTicket.js';
import { WA_WEBHOOK_PATH } from '../config/waWebhookPath.js';
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
  readWebhook,
  reconnectRequest,
  setWebhookRequest,
  statusRequest,
  findWebhookRequest,
  webhookUrlWithToken,
  webhookVerdict,
  WEBHOOK_VERDICTS,
  readLicenseBlock,
  redigirToken,
  flavorFromProbes
} from '../utils/wa/evolutionApi.js';

/** How much of a server message is kept in `last_error` / `serverError`. */
const FAILURE_TEXT_LIMIT = 300;

/**
 * Prazo da volta do webhook.
 *
 * Bem mais curto que os 30 s do padrão, e de propósito: quem apertou o botão
 * está olhando a tela. Um endereço que leva meio minuto para responder já é o
 * diagnóstico — e o operador prefere saber disso em cinco segundos.
 */
const PROBE_TIMEOUT_MS = 5_000;

/** O que se procura na volta cabe em 32 caracteres; o resto é destino errado. */
const PROBE_MAX_BYTES = 64 * 1024;

/**
 * O rótulo que a sonda de CONFIGURAÇÃO leva no lugar do nome da instância.
 *
 * Com o bilhete assinado a rota responde antes de procurar o nome, então este
 * valor não seleciona nada. Ele é explícito — e deliberadamente fora do formato
 * de `mintName()` — para que ninguém lendo um log do painel ou do proxy confunda
 * a sonda com uma instância de verdade.
 */
const CONFIG_PROBE_INSTANCE = 'panel-config-test';

/**
 * As duas sondas trazem assinatura de um Evolution?
 *
 * `flavorFromProbes` responde 'v2' quando nada é conclusivo, e está certo para
 * quem vai criar instância: errar para 'v2' contra um GO devolve um 404
 * legível. Para DIAGNOSTICAR, esse mesmo palpite viraria "é um servidor v2"
 * sobre um proxy que respondeu 502 — a afirmação mais cara possível, porque
 * manda o operador conferir a chave admin de um servidor que não existe.
 */
function ehEvolution(serverOk, raiz) {
  const go = serverOk?.ok && serverOk.data && typeof serverOk.data === 'object'
    && serverOk.data.status === 'ok';
  const v2 = raiz?.ok && raiz.data && typeof raiz.data === 'object'
    && typeof raiz.data.version === 'string';
  return Boolean(go || v2);
}

/**
 * Ponto de injeção para o teste, como `setMediaFetcher` no serviço de mídia.
 *
 * A volta só é prova se ela puder ser exercida de verdade, e o caso que mais
 * importa — 200 devolvendo o HTML do frontend em vez do webhook — não existe
 * sem um destino que responda exatamente isso. `safeFetch` recusa loopback, e
 * corretamente: é o guarda que impede o campo do webhook de virar um jeito de
 * fazer o painel bater em endereço interno. A costura fica aqui, e não lá.
 */
let buscarNaVolta = safeFetch;

export function setProbeFetcher(fn) {
  buscarNaVolta = typeof fn === 'function' ? fn : safeFetch;
  return buscarNaVolta;
}

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


  /**
   * A URL de webhook que o painel escreveria para esta conta HOJE.
   *
   * Reconstruída do `webhookBaseUrl` atual e do token guardado, e não lida de
   * lugar nenhum: é justamente por o painel nunca ter guardado a URL que
   * escreveu que a divergência com o servidor podia durar para sempre.
   */
  static expectedWebhookUrl(account, config) {
    const token = WhatsAppConfigService.decryptWebhookToken(account);
    if (!config.webhookBaseUrl || !token) return '';
    return webhookUrlWithToken(config.webhookBaseUrl, token);
  }

  /**
   * Pergunta ao servidor qual webhook ele tem, e compara com o que deveria ser.
   *
   * É a resposta para a pergunta que o painel não sabia responder: "o número
   * está conectado e não chega nada — de quem é a culpa?". Sem esta leitura, o
   * webhook ausente, o webhook apontando para outro lugar e o webhook certo que
   * ninguém está chamando são o mesmo silêncio.
   *
   * NÃO consome a falha de rede como veredito errado: um servidor fora do ar
   * responde `unreachable` e não `absent`. A diferença importa porque `absent`
   * manda o operador reescrever o webhook, e reescrever contra um servidor
   * mudo não conserta nada — só troca o token e, se a reescrita falhar no meio,
   * deixa o painel esperando um token que o servidor não tem.
   */
  static async inspectWebhook(id) {
    const config = await this.requireConfig();
    const account = await this.loadAccount(id);
    const esperado = this.expectedWebhookUrl(account, config);

    // O GO não tem rota que devolva o webhook: ele vive em `instance.Webhook` e
    // só o connect escreve. Lá a conferência não existe, e dizer o contrário
    // seria inventar um veredito — o conserto (reescrever) continua disponível
    // e é idempotente.
    const pedido = findWebhookRequest(account.flavor, account.name);
    if (!pedido) {
      return { account, verdict: null, supported: false, serverUrl: '', expectedUrl: esperado };
    }
    if (!esperado) {
      // Sem `webhookBaseUrl` configurado não há com o que comparar, e o
      // problema é aqui, não lá.
      throw new WaError('whatsapp.error.webhookBaseMissing', {
        code: 'webhook_base_missing',
        status: 409
      });
    }

    const client = this.clientFor(account, config);
    let resultado;
    try {
      resultado = await client.send(pedido);
    } catch {
      resultado = null;
    }
    if (!resultado?.ok) {
      const registrado = await this.recordWebhookCheck(account, {
        verdict: WEBHOOK_VERDICTS.UNREACHABLE,
        serverUrl: ''
      });
      return {
        account: registrado,
        verdict: WEBHOOK_VERDICTS.UNREACHABLE,
        supported: true,
        serverUrl: '',
        expectedUrl: esperado
      };
    }

    const { verdict, serverUrl } = webhookVerdict(readWebhook(resultado.data), esperado);
    const registrado = await this.recordWebhookCheck(account, { verdict, serverUrl });
    return { account: registrado, verdict, supported: true, serverUrl, expectedUrl: esperado };
  }

  /**
   * Reescreve o webhook no servidor e confere o resultado lendo de volta.
   *
   * O token é o MESMO, e isso é decisão e não economia. Trocá-lo a cada
   * conserto deixaria uma janela em que o painel já espera o token novo e o
   * servidor ainda manda o antigo — todo evento dessa janela vira 401, que é
   * exatamente a falha que este conserto existe para acabar. O token só é novo
   * quando não há nenhum guardado.
   *
   * A leitura de volta é o que separa "mandei" de "está valendo": um v2 que
   * aceita o POST e ignora metade do payload responde 200 do mesmo jeito.
   */
  static async reapplyWebhook(id) {
    const config = await this.requireConfig({ requireWebhook: true });
    let account = await this.loadAccount(id);

    let token = WhatsAppConfigService.decryptWebhookToken(account);
    if (!token) {
      token = randomToken();
      account = await WhatsAppAccount.update(
        account.id,
        WhatsAppConfigService.encryptWebhookToken(token)
      );
    }
    const url = webhookUrlWithToken(config.webhookBaseUrl, token);

    const client = this.clientFor(account, config);
    await client.sendOrThrow(setWebhookRequest(account.flavor, account.name, url));

    // O GO não devolve o webhook, então ali o conserto é a própria escrita e o
    // veredito fica sem conferência — dizer `ok` sem ter lido seria a mesma
    // confiança cega que criou este problema.
    const conferencia = findWebhookRequest(account.flavor, account.name)
      ? await this.inspectWebhook(account.id)
      : { account, verdict: null, supported: false, serverUrl: '', expectedUrl: url };
    return { ...conferencia, expectedUrl: url };
  }

  /**
   * Guarda o veredito da última conferência.
   *
   * Guardado, e não só devolvido, porque a tela que mais precisa dele — a tira
   * de saúde, que é onde o operador olha quando desconfia — roda a cada minuto
   * e não pode ir ao servidor Evolution a cada volta.
   */
  static async recordWebhookCheck(account, { verdict, serverUrl }) {
    return WhatsAppAccount.update(account.id, {
      webhook_verdict: verdict,
      webhook_server_url: serverUrl || null,
      webhook_checked_at: new Date()
    });
  }


  /**
   * A volta completa: o painel se chama pela porta da frente.
   *
   * `inspectWebhook` compara o que o servidor guarda com o que o painel espera,
   * e as DUAS pontas dessa comparação saem do mesmo `webhookBaseUrl`. Quando
   * esse endereço está errado — e ele é digitado à mão, conferido só na forma —
   * os dois lados concordam, o veredito responde `ok`, e nada chega mesmo
   * assim. Esta é a única conferência que pergunta o que importa: **uma entrada
   * por este endereço chega até aqui?**
   *
   * Vai por `safeFetch` e não por `fetch`: o endereço é digitado por quem
   * administra, e o mesmo guarda que protege a busca ao servidor Evolution vale
   * aqui — revalidando o host a cada redirecionamento, com prazo e teto de
   * corpo. Sem isso, o campo do webhook viraria um jeito de fazer o painel
   * bater em endereço interno e contar o resultado.
   */
  static async probeWebhook(id) {
    const config = await this.requireConfig({ requireWebhook: true });
    const account = await this.loadAccount(id);
    const url = this.expectedWebhookUrl(account, config);
    if (!url) {
      throw new WaError('whatsapp.error.webhookBaseMissing', {
        code: 'webhook_base_missing',
        status: 409
      });
    }

    const nonce = mintNonce();
    let resposta = { status: null, corpo: '', falhou: true };
    try {
      const r = await buscarNaVolta(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(probeBody(account.name, nonce)),
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBytes: PROBE_MAX_BYTES
      });
      // Só o começo do corpo. O que se procura nele é um valor de 32 caracteres
      // que o painel acabou de sortear, e ler uma página inteira para achá-lo
      // só aumenta o que um destino errado consegue fazer o painel carregar.
      resposta = { status: r.status, corpo: String(await r.text()).slice(0, 2048), falhou: false };
    } catch {
      // Qualquer falha de transporte é `unreachable` e não exceção: o operador
      // pediu um diagnóstico, e "não deu para chegar" É o diagnóstico. Lançar
      // aqui trocaria a resposta útil por um 502 genérico.
      resposta = { status: null, corpo: '', falhou: true };
    }

    const verdict = probeVerdict(resposta, nonce);
    const atualizada = await WhatsAppAccount.update(account.id, {
      webhook_probe_verdict: verdict,
      webhook_probed_at: new Date()
    });
    return { account: atualizada, verdict, status: resposta.status };
  }


  /**
   * As seis perguntas que a tela de configuração não sabia responder.
   *
   * POR QUE ISTO EXISTE, e por que não bastava o que já havia
   * ---------------------------------------------------------
   * A sonda por conta e a leitura do webhook no servidor já existem, já têm
   * rota e já estão na tela. Só que TODAS são por número conectado — e o
   * operador que acabou de preencher esta aba tem zero números. Ele configura
   * servidor, chave admin e webhook, salva, e não tem como saber se acertou até
   * conseguir parear um número, que é justamente o passo que depende de ter
   * acertado. A tela mostra "Integração ativa", que diz só que há um registro
   * no banco.
   *
   * O QUE ELA NÃO FAZ, de propósito
   * -------------------------------
   * Não escreve nada no servidor Evolution: não cria instância, não reescreve
   * webhook, não apaga nada. É diagnóstico, e consertar continua sendo editar o
   * campo e salvar. E roda contra a configuração SALVA, não contra o que está
   * digitado na tela — a chave admin nunca volta ao navegador, então testar o
   * digitado exigiria retypá-la a cada clique.
   *
   * O QUE ELA PROVA A MENOS que a sonda por conta, e a tela diz
   * ----------------------------------------------------------
   * A volta aqui não carrega token de conta nenhuma (não há conta), então ela
   * prova que o endereço chega a este painel e NÃO que o token de uma conta
   * futura será aceito. E prova isso do ponto de rede do PAINEL: um firewall
   * que solte o painel e barre o servidor Evolution passa neste teste.
   *
   * A DEPENDÊNCIA ENTRE OS PASSOS é o que impede o resultado de mentir
   * -----------------------------------------------------------------
   * Passo bloqueado recebe `skipped`, nunca ✗ — afirmar que a chave admin está
   * errada quando o servidor sequer respondeu é a forma de erro que esta
   * sessão inteira vem perseguindo. E a volta depende só de 1 e 2, não de 3:
   * servidor fora do ar com webhook certo é um estado real, e calar sobre a
   * volta ali perderia a informação que o operador foi buscar.
   */
  static async testConfig() {
    const passos = [];
    const add = (passo, veredito, detalhe = null) => {
      passos.push(detalhe === null ? { passo, veredito } : { passo, veredito, detalhe });
      return veredito;
    };

    // ── 1. a configuração está completa ──────────────────────────────────
    let config = null;
    try {
      config = await WhatsAppConfigService.getConfig();
    } catch {
      config = null;
    }
    if (!config || !config.enabled) {
      add('config', 'disabled');
      for (const passo of ['webhookPath', 'server', 'license', 'adminKey', 'roundTrip']) {
        add(passo, 'skipped');
      }
      return { passos };
    }

    const alvo = this.resolveTarget(config, {});
    // Três faltas distintas e uma só linha de resultado: a primeira que
    // aparecer é a que o operador tem que resolver, e listar as três de uma vez
    // só faria ele consertar a terceira e voltar aqui pela primeira.
    const faltando = !config.webhookBaseUrl
      ? 'webhook_missing'
      : !alvo.baseUrl
        ? 'server_missing'
        : !alvo.adminKey
          ? 'admin_key_missing'
          : 'ok';
    add('config', faltando);

    // ── 2. o caminho do webhook é o que este painel atende ───────────────
    //
    // Hoje `normalizeWebhookBaseUrl` garante isso na gravação. A conferência
    // continua valendo para a linha gravada ANTES dessa garantia existir — que
    // é exatamente o painel em produção onde o defeito apareceu, e onde o
    // endereço guardado aponta para a raiz.
    const caminhoOk = config.webhookBaseUrl
      ? this.#webhookPathVerdict(config.webhookBaseUrl)
      : 'skipped';
    add('webhookPath', caminhoOk, config.webhookBaseUrl ? redigirToken(config.webhookBaseUrl) : null);

    // ── 6 (executado aqui, exibido no fim): a volta ──────────────────────
    //
    // Sai na frente dos passos de servidor porque não depende deles, e porque
    // é a única que fala com o mundo pelo lado de FORA do painel.
    const voltaVeredito = caminhoOk === 'ok'
      ? await this.#probeConfigWebhook(config.webhookBaseUrl)
      : 'skipped';

    // ── 3. alcanço o servidor, e ele é v2 ou GO ──────────────────────────
    let client = null;
    let flavor = null;
    let servidorOk = false;
    let licenca = null;
    if (faltando === 'webhook_missing' || !alvo.baseUrl) {
      add('server', 'skipped');
    } else {
      client = new EvolutionClient({
        baseUrl: alvo.baseUrl,
        allowedHosts: config.allowedHosts,
        adminKey: alvo.adminKey
      });
      try {
        // As duas sondas lidas CRUAS, e não por `detectFlavor()`. Aquele engole
        // a falha e cai para 'v2' — certo para criar instância, porque o 404 de
        // um v2 contra um GO é legível; errado para diagnosticar, porque
        // transformaria "não respondeu" em "é um v2".
        const [serverOk, raiz] = await Promise.all([client.probe('/server/ok'), client.probe('/')]);

        // A licença vem antes do sabor, e não depois: uma distribuição
        // licenciada recusa TODA rota com o mesmo 503, raiz inclusive. Lida
        // depois, ela apareceria como "não parece um servidor Evolution" — o
        // diagnóstico errado, e o único dos dois que o operador não consegue
        // agir em cima.
        licenca = readLicenseBlock(raiz.status, raiz.data)
          || readLicenseBlock(serverOk.status, serverOk.data);

        if (serverOk.status === 0 && raiz.status === 0) {
          add('server', 'unreachable');
        } else if (licenca) {
          // Respondeu, e o que respondeu foi a recusa da licença. Conta como
          // servidor alcançado — o passo seguinte dirá o que há —, mas NÃO
          // como `ok`: aquele veredito promete o sabor no detalhe, e aqui não
          // há sabor a dar, porque a licença recusa até a raiz. Dito como `ok`
          // com detalhe vazio, a tela mostrava "Respondeu ().".
          servidorOk = true;
          flavor = 'v2';
          add('server', 'answered');
        } else if (ehEvolution(serverOk, raiz)) {
          flavor = flavorFromProbes(serverOk, raiz);
          servidorOk = true;
          add('server', 'ok', flavor);
        } else {
          // Alguma coisa atendeu e não se parece com nenhum dos dois sabores.
          // Um proxy, o painel de outro serviço, uma página de erro. Afirmar
          // qualquer coisa sobre licença ou chave admin daqui seria inventar.
          add('server', 'unknown_flavor', raiz.status || serverOk.status || null);
        }
      } catch (error) {
        // `assertTarget` recusa antes de abrir socket: URL inválida, http
        // simples, host fora da lista de autorizados, endereço interno. Cada
        // uma tem conserto próprio, então cada uma tem veredito próprio.
        add('server', error instanceof WaError ? String(error.code || 'unreachable') : 'unreachable');
      }
    }

    // ── 4, 5 e 7: uma chamada só, três vereditos ─────────────────────────
    //
    // `send` levanta `license_required` antes de olhar o 401, então a licença
    // sai da mesma tentativa que testa a chave. A leitura da raiz acima é o que
    // cobre o caso sem chave admin salva, em que esta chamada nem acontece.
    let nomesNoServidor = null;
    if (!servidorOk) {
      add('license', 'skipped');
      add('adminKey', 'skipped');
    } else if (licenca) {
      add('license', 'required', licenca.registerUrl);
      add('adminKey', 'skipped');
    } else if (!alvo.adminKey) {
      add('license', 'ok');
      add('adminKey', 'skipped');
    } else {
      try {
        const listed = await client.send(listInstancesRequest(flavor));
        add('license', 'ok');
        if (listed.ok) {
          const instancias = readInstances(flavor, listed.data);
          nomesNoServidor = new Set(instancias.map((i) => i.name));
          add('adminKey', 'ok', instancias.length);
        } else {
          add('adminKey', 'http_error', listed.status);
        }
      } catch (error) {
        const code = error instanceof WaError ? String(error.code || '') : '';
        if (code === 'license_required') {
          add('license', 'required', error.details ?? null);
          add('adminKey', 'skipped');
        } else {
          // Chegou ao servidor no passo 3, então o que falhou aqui é da
          // credencial ou da rota — nunca "o servidor está fora do ar", que
          // acabou de ser desmentido.
          add('license', 'ok');
          add('adminKey', code === 'unauthorized' ? 'unauthorized' : code || 'unreachable');
        }
      }
    }

    // ── 7. os dois lados batem? ──────────────────────────────────────────
    //
    // "Instâncias no servidor: 2" ao lado de "Nenhum número conectado ainda" é
    // informação, e hoje ela depende de alguém reparar no número. Foi assim que
    // um painel em produção descobriu ter duas instâncias órfãs carregando um
    // webhook antigo — o valor é escrito no create e em lugar nenhum depois,
    // então consertar a configuração do painel não alcança as que já existem.
    //
    // As duas metades têm consequências opostas e merecem frases próprias:
    //
    //   - **órfã**: instância no servidor sem linha aqui. Não quebra nada que o
    //     painel faça, mas ocupa o servidor e pode guardar webhook velho.
    //     É AVISO, não falha: o servidor pode legitimamente hospedar instância
    //     de outro sistema.
    //   - **faltando**: linha aqui sem instância lá. O painel mostra o número
    //     como conectado e ele não envia nem recebe nada. Isso é falha.
    //
    // Só CONTAGENS saem daqui, nunca nomes. Quem roda este teste já tem a chave
    // admin global do servidor e pode listar tudo com um curl — então a
    // contagem não concede nada —, mas imprimir na tela o nome da instância de
    // um vizinho é outra coisa, e não é necessária para o diagnóstico.
    if (!nomesNoServidor) {
      add('instances', 'skipped');
    } else {
      const doPainel = (await WhatsAppAccount.getAll()).map((linha) => linha.name);
      const orfas = [...nomesNoServidor].filter((nome) => !doPainel.includes(nome)).length;
      const faltando = doPainel.filter((nome) => !nomesNoServidor.has(nome)).length;
      if (orfas && faltando) add('instances', 'both');
      else if (faltando) add('instances', 'missing', faltando);
      else if (orfas) add('instances', 'orphans', orfas);
      else add('instances', 'ok', doPainel.length);
    }

    add('roundTrip', voltaVeredito);
    return { passos };
  }

  /** O caminho gravado atende a este painel? */
  static #webhookPathVerdict(webhookBaseUrl) {
    let pathname;
    try {
      ({ pathname } = new URL(webhookBaseUrl));
    } catch {
      return 'invalid_url';
    }
    return pathname.replace(/\/+$/, '').endsWith(WA_WEBHOOK_PATH) ? 'ok' : 'path_wrong';
  }

  /**
   * A volta, sem conta nenhuma.
   *
   * O nome da instância é uma constante explícita e não um valor no formato de
   * `mintName()`: com o bilhete a rota responde antes de procurar o nome, e
   * quem ler um log não pode confundir a sonda com instância de verdade.
   *
   * Vai por `buscarNaVolta` (`safeFetch`) como a sonda por conta, e pelo mesmo
   * motivo: o endereço é digitado por quem administra, e sem o guarda o campo
   * do webhook viraria um jeito de fazer o painel bater em endereço interno e
   * contar o resultado.
   */
  static async #probeConfigWebhook(webhookBaseUrl) {
    const nonce = mintNonce();
    let resposta = { status: null, corpo: '', falhou: true };
    try {
      const r = await buscarNaVolta(webhookBaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(probeBody(CONFIG_PROBE_INSTANCE, nonce, signProbeTicket(nonce))),
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBytes: PROBE_MAX_BYTES
      });
      resposta = { status: r.status, corpo: String(await r.text()).slice(0, 2048), falhou: false };
    } catch {
      resposta = { status: null, corpo: '', falhou: true };
    }
    return probeVerdict(resposta, nonce);
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
