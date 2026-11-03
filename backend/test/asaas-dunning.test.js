import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaDunningService } = await import('../src/services/waDunningService.js');
const { default: WaBillingService } = await import('../src/services/waBillingService.js');
const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: AsaasInvoiceService } = await import('../src/services/asaasInvoiceService.js');
const { default: AsaasCustomer } = await import('../src/models/AsaasCustomer.js');
const { default: AsaasCharge } = await import('../src/models/AsaasCharge.js');

/**
 * A régua de cobrança com a conta Asaas do provedor como fonte.
 *
 * O que torna seguro ligar: o cliente que só existe no Asaas é cobrado pelo
 * contrato sintético e sem prender a conversa a nada; quem tem contrato no SGP
 * NÃO é cobrado duas vezes; e quem paga (webhook ou conferência) sai da fila.
 */
const APP = 'painel';
const SGP_TOKEN = 'token-sgp-regua-asaas';
const CHAVE = '$aact_hmlg_regua';
const DOC_SGP = '52998224725';
const DOC_ASAAS = '93541134780';
const FONE_SGP = '5593981130001';
const FONE_ASAAS = '5593981130002';
const LINHA_ASAAS = '23793381286000782713695000063305975520000012990';
const PIX_ASAAS = '00020126580014BR.GOV.BCB.PIX0136asaas-regua5204000053039865802BR';

const SEMPRE = {
  timezone: 'America/Sao_Paulo',
  week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: false, open: '00:00', close: '23:59' }))
};
function meioDia(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(15, 0, 0, 0);
  return d;
}
const dia = (offset) => {
  const d = meioDia();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

let panelUrl;
let token;
let sgpServer;
let asaasServer;
let asaasBase;
let live;
let tituloSgp;
let templateId;

function subirSgp() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (payload.app !== APP || payload.token !== SGP_TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith('/api/ura/titulos')) {
        if (String(payload.contrato) !== 'R-SGP') return send({ status: 0, msg: 'Contrato inexistente' });
        return send({ status: 1, titulos: tituloSgp ? [{ ...tituloSgp, vencimento: dia(tituloSgp.venceEmDias) }] : [] });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise((r) => sgpServer.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${sgpServer.address().port}`)));
}

function subirAsaas() {
  asaasServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const responder = (s, c) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(c)); };
    if (req.headers.access_token !== CHAVE) return responder(401, {});
    const id = url.pathname.split('/')[2];
    if (url.pathname.endsWith('/identificationField')) return responder(200, { identificationField: LINHA_ASAAS, barCode: '1' });
    if (url.pathname.endsWith('/pixQrCode')) return responder(200, { payload: PIX_ASAAS, encodedImage: 'x' });
    if (/^\/payments\/[^/]+$/.test(url.pathname)) return live[id] ? responder(200, live[id]) : responder(404, {});
    return responder(404, {});
  });
  return new Promise((r) => asaasServer.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${asaasServer.address().port}`)));
}

const dentro = (fn) => asTenant(fn);
const run = (options = {}) => dentro(() => WaDunningService.run({ now: meioDia(), ...options }));
const sends = () => dentro(() => getDb()('wa_dunning_sends').orderBy('id'));

async function semearAsaas(document, customerId, charges, { phone = null, name = 'Cliente Asaas' } = {}) {
  await dentro(async () => {
    await AsaasCustomer.upsertFromAsaas({ id: customerId, name, document, mobilePhone: phone }, { seenAt: new Date() });
    for (const c of charges) {
      await AsaasCharge.upsertFromAsaas({
        id: c.id, customerId, status: 'OVERDUE', billingType: 'BOLETO', valueCents: c.cents,
        dueDate: dia(c.venceEmDias), invoiceUrl: `https://asaas.test/i/${c.id}`
      }, { document, seenAt: new Date() });
      live[c.id] = { id: c.id, status: 'OVERDUE', value: c.cents / 100, dueDate: dia(c.venceEmDias), billingType: 'BOLETO' };
    }
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await subirSgp();
  asaasBase = await subirAsaas();
  AsaasInvoiceService.credentialFor = () => ({ apiKey: CHAVE, baseUrl: asaasBase });

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'op-regua', password: 'operator-password-1', email: 'op-regua@exemplo.test' }
  });
  token = setup.body.data.token;
  await dentro(() => SgpService.saveConfig({ enabled: true, baseUrl: sgpUrl, app: APP, token: SGP_TOKEN, linkMode: 'pppoe' }));
  await dentro(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  await dentro(() => WhatsAppAccount.create({
    name: 'painel-cobranca-asaas', purpose: 'billing', flavor: 'v2', base_url: 'https://evo.provedor.test', status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  const now = new Date();
  await dentro(() => getDb()('sgp_links').insert({
    device_id: 'ont-regua-asaas', contract: 'R-SGP', client_name: 'Maria SGP', document: DOC_SGP, state: 'active',
    link_mode: 'auto', phone_e164: FONE_SGP, created_at: now, updated_at: now
  }));

  const t = await call(`${panelUrl}/api/whatsapp/templates`, {
    method: 'POST', headers: authHeaders(token),
    body: { name: 'cobrança asaas', body: 'Olá {{nome}}, sua fatura de {{valor}} venceu há {{dias_atraso}} dias. PIX: {{pix}}', category: 'cobranca' }
  });
  templateId = t.body.data.id;
  await call(`${panelUrl}/api/whatsapp/dunning/rule`, {
    method: 'PUT', headers: authHeaders(token), body: { steps: [{ offsetDays: 1, templateId }], window: SEMPRE }
  });
  await call(`${panelUrl}/api/whatsapp/dunning/enabled`, { method: 'POST', headers: authHeaders(token), body: { enabled: true } });
});

after(async () => {
  await new Promise((r) => sgpServer.close(r));
  await new Promise((r) => asaasServer.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  live = {};
  tituloSgp = null;
  const db = getDb();
  for (const tabela of ['wa_messages', 'wa_dunning_sends', 'wa_conversations', 'asaas_charges', 'asaas_customers']) await db(tabela).del();
  await dentro(() => AsaasProviderService.saveConfig({
    enabled: true, environment: 'sandbox', apiKey: CHAVE, billingEnabled: true, botLookup: false
  }));
});

describe('cliente que só existe no Asaas', () => {
  it('é cobrado pelo contrato sintético, com o Pix do Asaas à parte, sem prender a conversa', async () => {
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: '(93) 98113-0002' });
    const resumo = await run();
    assert.equal(resumo.queued, 1, JSON.stringify(resumo));

    const [linha] = (await sends()).filter((l) => l.status === 'queued');
    assert.equal(linha.contract, 'asaas:cus_a');
    assert.equal(linha.invoice_key, 'pay_a');
    assert.equal(linha.phone_e164, FONE_ASAAS);

    const msgs = await dentro(() => getDb()('wa_messages').where({ direction: 'out' }).orderBy('id').pluck('body'));
    assert.match(msgs[0], /R\$ 89,90/);
    assert.match(msgs[0], /venceu há 5 dias/);
    assert.deepEqual(msgs.slice(1), [PIX_ASAAS], 'o Pix do Asaas vai sozinho, depois do texto');

    const conversa = await dentro(() => getDb()('wa_conversations').where({ wa_phone_e164: FONE_ASAAS }).first());
    assert.equal(conversa.contract, null, 'o contrato sintético não é do SGP: não prende a conversa');
  });

  it('sem telefone no Asaas, é pulado como "sem telefone"', async () => {
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: null });
    const resumo = await run();
    assert.equal(resumo.queued, 0);
    assert.equal(resumo.skipped.noPhone, 1);
  });

  it('com a opção desligada, ninguém do Asaas é cobrado', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ billingEnabled: false }));
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: '(93) 98113-0002' });
    const resumo = await run();
    assert.equal(resumo.queued, 0);
    assert.equal((await sends()).length, 0);
  });

  it('uma fatura que o gateway diz já paga não é cobrada', async () => {
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: '(93) 98113-0002' });
    live.pay_a.status = 'RECEIVED';
    const resumo = await run();
    assert.equal(resumo.queued, 0);
  });

  it('o pagamento pelo webhook retira a mensagem ainda na fila e marca a fatura como paga', async () => {
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: '(93) 98113-0002' });
    await run();
    const [antes] = await sends();
    assert.ok(antes.message_id);

    const retirou = await dentro(() => WaDunningService.settleByInvoiceKey('pay_a'));
    assert.equal(retirou, 1);
    const [depois] = await sends();
    assert.ok(depois.paid_at, 'a fatura fica marcada como paga');
    assert.equal(depois.status, 'canceled');
    assert.equal(await dentro(() => getDb()('wa_messages').where({ id: antes.message_id }).first()), undefined, 'a mensagem saiu da fila');
  });

  it('quem pagou continua na lista da passada para ela perceber o pagamento', async () => {
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: '(93) 98113-0002' });
    await run();
    // Pagou (importação ou webhook gravaram o status), e já não há fatura aberta.
    await dentro(() => AsaasCharge.applyStatus('pay_a', { status: 'RECEIVED', paymentDate: dia(0), dueDate: dia(-5) }));
    const resumo = await run({ now: meioDia(1) });
    assert.equal(resumo.paid, 1, JSON.stringify(resumo));
    const [linha] = await sends();
    assert.ok(linha.paid_at);
  });
});

describe('cliente com contrato no SGP e no Asaas', () => {
  it('é UM assinante só: a cobrança vem do SGP e do Asaas, nunca duas mensagens', async () => {
    tituloSgp = { numerodocumento: 'S1', valor: '129,90', venceEmDias: -3, linha_digitavel: '111', pix: 'pix-sgp' };
    await semearAsaas(DOC_SGP, 'cus_s', [{ id: 'pay_s', cents: 5000, venceEmDias: -9 }], { phone: '(93) 98113-0001' });
    const resumo = await run();
    assert.equal(resumo.queued, 1, 'mesmo CPF nas duas fontes = um assinante');
    const [linha] = (await sends()).filter((l) => l.status === 'queued');
    assert.equal(linha.contract, 'R-SGP', 'o assinante é o do SGP');
    assert.equal(linha.invoice_key, 'pay_s', 'a fatura mais antiga é a do Asaas');
  });

  it('a mesma dívida nas duas fontes some em uma: fica a do SGP', async () => {
    tituloSgp = { numerodocumento: 'S1', valor: '50,00', venceEmDias: -4, pix: 'pix-sgp' };
    await semearAsaas(DOC_SGP, 'cus_s', [{ id: 'pay_igual', cents: 5000, venceEmDias: -4 }], { phone: '(93) 98113-0001' });
    await run();
    const [linha] = (await sends()).filter((l) => l.status === 'queued');
    assert.equal(linha.invoice_key, 'S1');
  });

  it('com a opção desligada, só o SGP cobra', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ billingEnabled: false }));
    tituloSgp = { numerodocumento: 'S1', valor: '129,90', venceEmDias: -3, pix: 'pix-sgp' };
    await semearAsaas(DOC_SGP, 'cus_s', [{ id: 'pay_s', cents: 5000, venceEmDias: -9 }], { phone: '(93) 98113-0001' });
    await run();
    const [linha] = (await sends()).filter((l) => l.status === 'queued');
    assert.equal(linha.invoice_key, 'S1');
  });
});

describe('campanhas de cobrança e a lista de atrasados', () => {
  it('a lista de atrasados mostra o cliente só-Asaas, com o contrato sintético', async () => {
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: '(93) 98113-0002' });
    const lista = await dentro(() => WaBillingService.listOverdue({ daysMin: 1, daysMax: 90 }));
    const linha = lista.rows?.find((r) => r.contract === 'asaas:cus_a') ?? lista.find?.((r) => r.contract === 'asaas:cus_a');
    assert.ok(linha, JSON.stringify(lista));
    assert.equal(linha.phone, FONE_ASAAS);
  });

  it('montar a campanha com o contrato sintético cria o destinatário, sem tocar o SGP', async () => {
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: '(93) 98113-0002' });
    const built = await dentro(() => WaBillingService.buildCampaign({
      template: String(templateId), contracts: ['asaas:cus_a'], title: 'Atrasados do Asaas'
    }));
    assert.equal(built.recipients, 1, JSON.stringify(built));
    const [dest] = await dentro(() => getDb()('wa_broadcast_recipients').where({ broadcast_id: built.broadcast.id }));
    assert.equal(dest.contract, 'asaas:cus_a');
    assert.equal(dest.phone_e164, FONE_ASAAS);
    assert.match(dest.rendered_body, /R\$ 89,90/);
  });

  it('a campanha para o contrato sintético com a opção desligada não tem destinatário', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ billingEnabled: false }));
    await semearAsaas(DOC_ASAAS, 'cus_a', [{ id: 'pay_a', cents: 8990, venceEmDias: -5 }], { phone: '(93) 98113-0002' });
    await assert.rejects(dentro(() => WaBillingService.buildCampaign({
      template: String(templateId), contracts: ['asaas:cus_a'], title: 'x'
    })));
  });
});
