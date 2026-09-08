import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  asTenant,
  authHeaders,
  call,
  getDb,
  insertReturningId,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaBotService } = await import('../src/services/waBotService.js');

const INSTANCE = 'painel-bot';
const INSTANCE_TOKEN = 'token-instancia-bot';
const WEBHOOK_TOKEN = 'segredo-webhook-bot';
const APP = 'painel';
const SGP_TOKEN = 'token-secreto-bot';

const DEVICE_ID = 'bot-device-1';
const CONTRACT = '4321';
const PORTAL_BASE = 'https://painel.provedor.example';

/** The subscriber's number, and a number the panel has never seen. */
const ASSINANTE = '5593981110001';
const DESCONHECIDO = '5593981119999';

/**
 * The WiFi passphrase the stub ONT holds. It exists for exactly one assertion:
 * that no bot answer ever contains it. If this string ever shows up in an
 * outbound body, the bot has become a second, weaker door into the portal.
 */
const SENHA_WIFI = 'senha-secreta-do-wifi-99';

/** The optical reading `whatsapp.bot.signalOk` is built around. */
const RX_POWER = -22.4;

const LINHA_DIGITAVEL = '34191790010104351004791020150008699999999999';
const PIX = '00020126580014BR.GOV.BCB.PIX0136bot-teste-chave-pix5204000053039865802BR';
const LINK_BOLETO = 'https://provedor.example/boleto/900123/';

let panelUrl;
let token;
let genie;
let sgpServer;
let sgpUrl;

/** A stub ONT that carries an optical reading AND a WiFi passphrase. */
function ontDoTeste() {
  const device = buildDevice({ id: DEVICE_ID, ssid: 'CLIENTE-WIFI' });
  device.VirtualParameters.OpticalRXPower = {
    _value: RX_POWER,
    _writable: false,
    _timestamp: '2026-09-01T00:00:00.000Z'
  };
  const wlan = device.InternetGatewayDevice.LANDevice[1].WLANConfiguration;
  wlan[1].PreSharedKey[1].KeyPassphrase._value = SENHA_WIFI;
  wlan[5].PreSharedKey[1].KeyPassphrase._value = SENHA_WIFI;
  return device;
}

/** Minimal SGP that answers one contract with one open and one settled title. */
function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== SGP_TOKEN) {
        return send({ status: 0, msg: 'Token inválido' });
      }
      if (req.url.startsWith('/api/ura/titulos')) {
        return send({
          status: 1,
          titulos: [
            {
              numerodocumento: '900123',
              valor: '129,90',
              vencimento: '10/10/2026',
              status: 'Em aberto',
              linha_digitavel: LINHA_DIGITAVEL,
              pix: PIX,
              link: LINK_BOLETO
            },
            {
              numerodocumento: '900122',
              valor: 129.9,
              vencimento: '2026-09-10',
              status: 'Pago',
              dataPagamento: '2026-09-08'
            }
          ]
        });
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 0, msg: 'Endpoint inexistente' }));
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${sgpServer.address().port}`);
    });
  });
}

/** Every event goes in the way the Evolution server sends it: over HTTP. */
async function hook(body) {
  return call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });
}

let contadorDeIds = 0;

/** One inbound (or `fromMe`) text message from `telefone`. */
async function receber(telefone, texto, { fromMe = false, id } = {}) {
  contadorDeIds += 1;
  const externalId = id ?? `BOT-${contadorDeIds}`;
  const { body } = await hook({
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe, id: externalId },
      pushName: 'Cliente',
      message: { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  });
  return body;
}

async function conversaDe(telefone) {
  return getDb()('wa_conversations').where({ wa_phone_e164: telefone }).first();
}

/**
 * What the PANEL put on this contact's thread, oldest first.
 *
 * `external_id IS NULL` is what separates the two kinds of outbound row: an
 * echo of the provider typing on their own phone arrives from the server with
 * an id already on it, while a message the panel composed has none until the
 * outbox worker sends it — and no worker runs in this suite.
 */
async function respostas(telefone) {
  const conversa = await conversaDe(telefone);
  if (!conversa) return [];
  return getDb()('wa_messages')
    .where({ conversation_id: conversa.id, direction: 'out' })
    .whereNull('external_id')
    .orderBy('id')
    .pluck('body');
}

/**
 * Starts the subscriber's thread over.
 *
 * There is exactly one subscriber fixture because `sgp_links.device_id` is
 * unique and the signal answer has to reach the one ONT the GenieACS stub
 * serves. So every test that needs a RESOLVED contact reuses that number and
 * clears the thread first — otherwise the per-contact ceiling, which is the
 * point of another test, would silence the ones after it.
 */
async function limparFio(telefone) {
  const conversa = await conversaDe(telefone);
  if (!conversa) return;
  await getDb()('wa_messages').where({ conversation_id: conversa.id }).del();
  await getDb()('wa_opt_outs').where({ conversation_id: conversa.id }).del();
  await getDb()('wa_conversations').where({ id: conversa.id }).del();
}

/**
 * A thread that exists and holds nothing.
 *
 * The seeded tests below need the conversation — `wa_messages.conversation_id`
 * has to point somewhere — but not a single message on it, and `limparFio`
 * takes the conversation with it. So the thread is opened the only way the
 * panel opens one, by an inbound message, and then emptied.
 */
async function fioVazio(telefone) {
  await limparFio(telefone);
  await receber(telefone, 'oi');
  const conversa = await conversaDe(telefone);
  await getDb()('wa_messages').where({ conversation_id: conversa.id }).del();
  return conversa;
}

/**
 * Automatic outbound rows, written the way the sender named by `origem` writes
 * them: inside the hour, no `sent_by`, delivered by nobody.
 *
 * `origem` of `null` omits the column entirely rather than writing a null into
 * it, which is exactly the shape of a row that existed before the migration:
 * `source` is NOT NULL DEFAULT 'operator', so the upgrade gave every old row
 * that value and none of them may be read as the bot's.
 */
async function semear(conversa, origem, quantas) {
  const agora = new Date();
  for (let i = 0; i < quantas; i += 1) {
    const linha = {
      conversation_id: conversa.id,
      direction: 'out',
      body: `mensagem automatica ${origem ?? 'sem origem'} ${i}`,
      is_note: false,
      delivery_status: 'sent',
      sent_by: null,
      created_at: agora,
      updated_at: agora
    };
    if (origem) linha.source = origem;
    // eslint-disable-next-line no-await-in-loop -- the ceiling counts rows, and the order they were written in is the fixture
    await insertReturningId('wa_messages', linha);
  }
}

/** What the panel put on this thread, with the origin recorded against each. */
async function origens(telefone) {
  const conversa = await conversaDe(telefone);
  if (!conversa) return [];
  return getDb()('wa_messages')
    .where({ conversation_id: conversa.id, direction: 'out' })
    .orderBy('id')
    .pluck('source');
}

/** The single answer to one inbound message, asserted to be exactly one. */
async function unicaResposta(telefone, texto) {
  await limparFio(telefone);
  await receber(telefone, texto);
  const saidas = await respostas(telefone);
  assert.equal(saidas.length, 1, `expected exactly one answer, got ${saidas.length}`);
  return saidas[0];
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [ontDoTeste()] });
  sgpUrl = await startSgpStub();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1' }
  });
  token = setup.body.data.token;

  await call(`${panelUrl}/api/settings/genieAcsUrl`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { value: genie.url }
  });
  await call(`${panelUrl}/api/sgp/config`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { enabled: true, baseUrl: sgpUrl, app: APP, token: SGP_TOKEN, linkMode: 'pppoe' }
  });
  // The webhook address the Evolution server would reach, and — separately —
  // where the customer portal answers. Two settings because they are two
  // addresses: the portal is its own Express app on its own port, and only a
  // reverse proxy in front of both makes them the same hostname.
  await WhatsAppConfigService.saveConfig({
    webhookBaseUrl: `${PORTAL_BASE}/api/whatsapp-webhook`,
    portalPublicUrl: PORTAL_BASE
  });

  // The number has to be CONNECTED or `enqueue` refuses every answer with
  // `no_account`, and the bot would look silent for the wrong reason.
  await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(INSTANCE_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));

  // What makes `ASSINANTE` a subscriber and `DESCONHECIDO` a stranger.
  await insertReturningId('sgp_links', {
    device_id: DEVICE_ID,
    contract: CONTRACT,
    client_name: 'João da Silva',
    document: '12345678909',
    login: 'joao@provedor',
    state: 'active',
    link_mode: 'manual',
    phone_e164: ASSINANTE
  });
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await genie.close();
  await stopTestServers();
});

describe('intent routing for a resolved subscriber', () => {
  it('answers a second-copy request with the oldest open invoice and its codes', async () => {
    const texto = await unicaResposta(ASSINANTE, 'boa tarde, queria a segunda via do boleto');
    assert.match(texto, /R\$ 129,90/);
    assert.match(texto, /10\/10\/2026/);
    assert.ok(texto.includes(LINHA_DIGITAVEL), 'the digitable line should be there');
    assert.ok(texto.includes(PIX), 'the PIX code should be there');
    assert.ok(texto.includes(LINK_BOLETO), 'the second-copy link should be there');
    // Labelled, not three bare walls of digits: a PIX string pasted into a
    // bank's barcode field simply fails, so the customer has to be able to tell
    // which is which.
    assert.match(texto, /Linha digitável:/);
    assert.match(texto, /PIX copia e cola:/);
    assert.match(texto, /Segunda via:/);
  });

  it('answers "sem internet" with the connection state and the optical signal', async () => {
    const texto = await unicaResposta(ASSINANTE, 'minha internet caiu, o que houve?');
    assert.match(texto, /online/i);
    assert.ok(texto.includes(String(RX_POWER)), 'the rxPower reading should be there');
  });

  it('reports an ONT that is not answering rather than an optical reading', async () => {
    genie.state.devices = [{ ...ontDoTeste(), _lastInform: '2026-01-01T00:00:00.000Z' }];
    try {
      const texto = await unicaResposta(ASSINANTE, 'estou sem internet desde ontem');
      assert.ok(!texto.includes(String(RX_POWER)), 'a stale ONT has no signal to report');
      assert.match(texto, /não está respondendo/i);
      // What it must NOT say is that a ticket was opened: this panel has no
      // ticket system, and the sentence used to promise one.
      assert.ok(!/chamado/i.test(texto), 'the bot must not promise a ticket it cannot open');
    } finally {
      genie.state.devices = [ontDoTeste()];
    }
  });

  it('says the connection is online when the ONT reports no optical reading', async () => {
    // An ONT that informs but has no vendor optical parameter mapped is a real
    // state, and the customer asked whether the connection is up — which the
    // panel knows. It answers that and stops there rather than inventing a
    // number or falling silent.
    const semOptico = ontDoTeste();
    delete semOptico.VirtualParameters.OpticalRXPower;
    genie.state.devices = [semOptico];
    try {
      const texto = await unicaResposta(ASSINANTE, 'estou sem internet, o sinal caiu');
      assert.match(texto, /online/i);
      // Not "0 dBm": the overview returns null for a parameter the ONT does
      // not carry, and `Number(null)` is 0, which would read as an impossibly
      // strong signal rather than as a missing one.
      assert.ok(!/dBm/i.test(texto), 'no reading means no reading is quoted');
      assert.ok(!texto.includes('0'), 'a missing reading must not become a zero');
    } finally {
      genie.state.devices = [ontDoTeste()];
    }
  });

  it('sends anything else to a human', async () => {
    const texto = await unicaResposta(ASSINANTE, 'vocês atendem no bairro Aeroporto?');
    assert.match(texto, /atendente/i);
  });
});

describe('the line the bot must not cross', () => {
  it('answers "qual a senha do meu wifi" with the portal link and NO credential', async () => {
    const telefone = ASSINANTE;
    const texto = await unicaResposta(telefone, 'qual a senha do meu wifi?');

    // The whole point of the feature.
    assert.ok(
      !texto.includes(SENHA_WIFI),
      'the bot must never put a WiFi password in a message'
    );
    assert.ok(texto.includes(PORTAL_BASE), 'the portal link should be there');
    assert.match(texto, /portal/i);

    // And not by any other route either: nothing on the thread carries it.
    const todas = await respostas(telefone);
    assert.ok(todas.every((body) => !String(body).includes(SENHA_WIFI)));
  });

  it('sends a request to change the network name to the portal, not to the ONT', async () => {
    const texto = await unicaResposta(ASSINANTE, 'quero trocar o nome da rede wifi');
    assert.ok(texto.includes(PORTAL_BASE));
    assert.ok(!texto.includes(SENHA_WIFI));
  });

  it('sends a reboot request to the portal and reboots nothing', async () => {
    const antes = genie.state.tasks.length;
    const texto = await unicaResposta(ASSINANTE, 'pode reiniciar meu equipamento?');
    assert.ok(texto.includes(PORTAL_BASE));
    assert.equal(genie.state.tasks.length, antes, 'the bot must not post a task to GenieACS');
  });

  it('hands off instead of sending a broken link when no public URL is configured', async () => {
    await WhatsAppConfigService.saveConfig({ portalPublicUrl: '' });
    try {
      const texto = await unicaResposta(ASSINANTE, 'esqueci a senha do wifi');
      assert.match(texto, /atendente/i);
      assert.ok(!texto.includes('http'), 'no link at all beats a link that opens nothing');
    } finally {
      await WhatsAppConfigService.saveConfig({ portalPublicUrl: PORTAL_BASE });
    }
  });

  it('never answers contract data to a number it does not recognise', async () => {
    const texto = await unicaResposta(DESCONHECIDO, 'me manda a segunda via do boleto');
    assert.match(texto, /contrato/i);
    assert.ok(!texto.includes(LINHA_DIGITAVEL), 'no digitable line to an unknown number');
    assert.ok(!texto.includes(PIX), 'no PIX code to an unknown number');
    assert.ok(!texto.includes('129,90'), 'no amount to an unknown number');
  });
});

describe('when the bot stays quiet', () => {
  it('says nothing to a fromMe echo', async () => {
    const telefone = '5593981110030';
    await receber(telefone, 'segunda via do boleto', { fromMe: true });
    assert.deepEqual(await respostas(telefone), []);
  });

  it('stays silent while an operator is in the thread', async () => {
    const telefone = ASSINANTE;
    await limparFio(telefone);
    await receber(telefone, 'oi');
    const conversa = await conversaDe(telefone);

    // The operator answers by hand. `sent_by` is what marks a human.
    const agora = new Date();
    await insertReturningId('wa_messages', {
      conversation_id: conversa.id,
      direction: 'out',
      body: 'Oi João, já estou vendo aqui.',
      is_note: false,
      delivery_status: 'sent',
      sent_by: 1,
      created_at: agora,
      updated_at: agora
    });
    const antes = (await respostas(telefone)).length;

    await receber(telefone, 'queria a segunda via do boleto');
    const depois = await respostas(telefone);
    assert.equal(depois.length, antes, 'the bot must not talk over an operator');
    assert.ok(depois.every((body) => !String(body).includes(LINHA_DIGITAVEL)));
  });

  it('answers a redelivered message exactly once', async () => {
    const telefone = ASSINANTE;
    await limparFio(telefone);
    const externalId = 'BOT-REDELIVERY-1';
    await receber(telefone, 'quero a segunda via', { id: externalId });
    const primeira = await respostas(telefone);
    assert.equal(primeira.length, 1);

    // The same event again, byte for byte, which is what both servers do.
    const repetido = await receber(telefone, 'quero a segunda via', { id: externalId });
    assert.equal(repetido.duplicate, true);
    assert.deepEqual(await respostas(telefone), primeira);
  });

  it('says nothing to an opt-out request', async () => {
    const telefone = '5593981110033';
    await receber(telefone, 'SAIR');
    assert.deepEqual(await respostas(telefone), []);
    const optOut = await getDb()('wa_opt_outs').where({ wa_phone_e164: telefone }).first();
    assert.ok(optOut, 'the opt-out itself must still be recorded');
  });

  it('holds the per-contact ceiling', async () => {
    const telefone = ASSINANTE;
    await limparFio(telefone);
    for (let i = 0; i < WaBotService.TETO_POR_HORA + 3; i += 1) {
      // Sequential on purpose: the ceiling is a count of rows already written.
      // eslint-disable-next-line no-await-in-loop
      await receber(telefone, `segunda via do boleto ${i}`);
    }
    const saidas = await respostas(telefone);
    assert.equal(saidas.length, WaBotService.TETO_POR_HORA);
    // And every one of the rows it stopped at is its own: the ceiling counts
    // what the bot wrote, so what the bot writes has to say so.
    assert.deepEqual(await origens(telefone), Array(WaBotService.TETO_POR_HORA).fill('bot'));
  });
});

/**
 * The bug this column exists for.
 *
 * All three automatic senders write `sent_by: NULL`, so a ceiling built on that
 * column counted a billing campaign and a technical alert as the bot's own
 * answers. A subscriber who got three dunning messages in an hour had spent the
 * bot's whole budget on their thread before asking anything, and the question
 * they then asked was met with silence — no reply, no hand-off, nothing on the
 * thread at all.
 */
describe('the ceiling counts the bot and nothing else', () => {
  it('still answers after three campaign messages on the same thread', async () => {
    const telefone = ASSINANTE;
    const conversa = await fioVazio(telefone);
    await semear(conversa, 'campaign', WaBotService.TETO_POR_HORA);

    const antes = await respostas(telefone);
    assert.equal(antes.length, WaBotService.TETO_POR_HORA, 'the campaign wrote its three');

    await receber(telefone, 'quero a segunda via do boleto');

    const depois = await respostas(telefone);
    assert.equal(depois.length, antes.length + 1, 'a campaign must not spend the bot budget');
    assert.ok(
      depois.at(-1).includes(LINHA_DIGITAVEL),
      'and the answer is the real one, not a hand-off'
    );
  });

  it('answers even when a campaign wrote into the thread after the question', async () => {
    // The dedupe belt reads an outbound row newer than the inbound one as "this
    // was already answered". A campaign message landing in the seconds between
    // the two is not an answer to anything, and reading it as one swallows a
    // real question — the same misidentification as the ceiling, one guard up.
    const telefone = ASSINANTE;
    const conversa = await fioVazio(telefone);

    const entrada = await asTenant(() => insertReturningId('wa_messages', {
      conversation_id: conversa.id,
      direction: 'in',
      body: 'quero a segunda via do boleto',
      is_note: false,
      created_at: new Date(),
      updated_at: new Date()
    }));
    // Written AFTER the question, exactly as a campaign flush would.
    await semear(conversa, 'campaign', 1);

    const resposta = await asTenant(() => WaBotService.responder({
      conversation: conversa,
      messageId: entrada,
      body: 'quero a segunda via do boleto',
      direction: 'in'
    }));
    assert.equal(resposta.replied, true, resposta.reason ?? '');
    const depois = await respostas(telefone);
    assert.ok(depois.at(-1).includes(LINHA_DIGITAVEL));
  });

  it('goes quiet after three of its own replies', async () => {
    const telefone = ASSINANTE;
    const conversa = await fioVazio(telefone);
    await semear(conversa, 'bot', WaBotService.TETO_POR_HORA);

    await receber(telefone, 'quero a segunda via do boleto');

    const depois = await respostas(telefone);
    assert.equal(depois.length, WaBotService.TETO_POR_HORA, 'the loop guard still holds');
    assert.ok(depois.every((body) => !String(body).includes(LINHA_DIGITAVEL)));
  });

  it('never reads a row written before the column existed as one of its own', async () => {
    const telefone = ASSINANTE;
    const conversa = await fioVazio(telefone);
    // Three rows with no `source` given: the migration's default is what they
    // carry, and the panel cannot tell whose they were. Counting them as the
    // bot's would silence it over history it has no evidence about.
    await semear(conversa, null, WaBotService.TETO_POR_HORA);
    assert.deepEqual(
      await origens(telefone),
      Array(WaBotService.TETO_POR_HORA).fill('operator'),
      'the column is NOT NULL DEFAULT operator, so an old row reads as operator'
    );

    await receber(telefone, 'quero a segunda via do boleto');

    const depois = await respostas(telefone);
    assert.equal(depois.length, WaBotService.TETO_POR_HORA + 1);
    assert.ok(depois.at(-1).includes(LINHA_DIGITAVEL));
  });

  it('does not let an alert on the thread count against it either', async () => {
    const telefone = ASSINANTE;
    const conversa = await fioVazio(telefone);
    // An on-duty number is a subscriber too, and a busy night is three alerts.
    await semear(conversa, 'alert', WaBotService.TETO_POR_HORA);

    await receber(telefone, 'quero a segunda via do boleto');

    const depois = await respostas(telefone);
    assert.equal(depois.length, WaBotService.TETO_POR_HORA + 1);
    assert.ok(depois.at(-1).includes(LINHA_DIGITAVEL));
  });

  it('stays quiet while the provider answers from their own phone', async () => {
    const telefone = ASSINANTE;
    await limparFio(telefone);
    await receber(telefone, 'oi, tudo bem?');
    // The provider answers on the phone app, not in the panel. That echo comes
    // back `fromMe` with the server's id on it and no `sent_by` behind it —
    // which the ceiling used to catch by accident, three messages late, because
    // it counted every outbound row without a `sent_by` as automatic.
    await receber(telefone, 'oi João, já estou vendo', { fromMe: true });
    const antes = (await respostas(telefone)).length;

    await receber(telefone, 'quero a segunda via do boleto');

    const depois = await respostas(telefone);
    assert.equal(depois.length, antes, 'the bot must not talk over the phone in a hand');
    assert.ok(depois.every((body) => !String(body).includes(LINHA_DIGITAVEL)));
  });

  it('marks its own answer as the bot\'s and leaves the inbound message alone', async () => {
    const telefone = ASSINANTE;
    await limparFio(telefone);
    await receber(telefone, 'quero a segunda via do boleto');

    assert.deepEqual(await origens(telefone), ['bot']);
    const conversa = await conversaDe(telefone);
    const entrada = await getDb()('wa_messages')
      .where({ conversation_id: conversa.id, direction: 'in' })
      .first();
    // The panel composed none of an inbound message, and neither did any of its
    // automatic senders — 'operator' is the value that means "not one of them".
    assert.equal(entrada.source, 'operator');
  });
});

describe('the bot never breaks the webhook', () => {
  it('takes a message with no text at all without throwing', async () => {
    await limparFio(ASSINANTE);
    const { status, body } = await hook({
      event: 'messages.upsert',
      instance: INSTANCE,
      data: {
        key: { remoteJid: `${ASSINANTE}@s.whatsapp.net`, fromMe: false, id: 'BOT-VAZIA-1' },
        pushName: 'Cliente',
        message: {},
        messageTimestamp: 1739990000
      }
    });
    assert.equal(status, 200);
    assert.equal(body.handled, true);
    assert.deepEqual(await respostas(ASSINANTE), []);
  });

  it('degrades to silence, not to a 500, when the answer cannot be built', async () => {
    const telefone = ASSINANTE;
    await limparFio(telefone);
    // SGP pointed at a port nothing is listening on: `listInvoices` throws
    // inside the intent, which must reach the customer as a hand-off and the
    // webhook as a 200.
    await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { baseUrl: 'http://127.0.0.1:1', app: APP, token: SGP_TOKEN }
    });
    try {
      const { status, body } = await hook({
        event: 'messages.upsert',
        instance: INSTANCE,
        data: {
          key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe: false, id: 'BOT-SGP-DOWN-1' },
          pushName: 'Cliente',
          message: { conversation: 'manda a segunda via do boleto' },
          messageTimestamp: 1739990000
        }
      });
      assert.equal(status, 200);
      assert.equal(body.handled, true);
      const saidas = await respostas(telefone);
      assert.equal(saidas.length, 1);
      assert.match(saidas[0], /atendente/i);
    } finally {
      await call(`${panelUrl}/api/sgp/config`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: { baseUrl: sgpUrl, app: APP, token: SGP_TOKEN }
      });
    }
  });

  it('answers a garbled event with a 200 and no reply', async () => {
    const { status, body } = await hook({
      event: 'messages.upsert',
      instance: INSTANCE,
      data: { key: { remoteJid: 'nao-e-um-jid', fromMe: false, id: 'BOT-LIXO-1' } }
    });
    assert.equal(status, 200);
    assert.equal(body.handled, false);
  });
});

describe('the intent table on its own', () => {
  it('reads accents, case and punctuation as the same intent', async () => {
    const { classificarIntencao } = await import('../src/services/waBotService.js');
    assert.equal(classificarIntencao('SEGUNDA VIA!!!'), 'fatura');
    assert.equal(classificarIntencao('Qual é a senha do Wi-Fi?'), 'portal');
    assert.equal(classificarIntencao('estou sem internet'), 'sinal');
    assert.equal(classificarIntencao('bom dia'), 'handoff');
    assert.equal(classificarIntencao(''), 'handoff');
    assert.equal(classificarIntencao(null), 'handoff');
  });

  it('does not read a term inside a longer word', async () => {
    const { classificarIntencao } = await import('../src/services/waBotService.js');
    // The lesson `waOptOutTexto.js` paid for: substring matching turns
    // "assinalar" into a signal complaint and "prepago" into a payment.
    assert.equal(classificarIntencao('preciso assinalar uma coisa'), 'handoff');
    assert.equal(classificarIntencao('quero resenha do plano'), 'handoff');
  });

  it('sends a message that asks for a secret to the portal even when it also complains', async () => {
    const { classificarIntencao } = await import('../src/services/waBotService.js');
    assert.equal(classificarIntencao('estou sem internet e esqueci a senha do wifi'), 'portal');
  });
});
