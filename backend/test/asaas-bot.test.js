import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: AsaasProviderService } = await import('../src/services/asaasProviderService.js');
const { default: AsaasInvoiceService } = await import('../src/services/asaasInvoiceService.js');
const { default: AsaasCustomer } = await import('../src/models/AsaasCustomer.js');
const { default: AsaasCharge } = await import('../src/models/AsaasCharge.js');
const { mergeOpenInvoices } = await import('../src/services/invoiceSourceService.js');

/**
 * O bot do WhatsApp com a conta Asaas do provedor como segunda fonte de fatura.
 *
 * Três situações, e a terceira é a que mais engana:
 *   1. o assinante tem contrato no SGP e uma cobrança só no Asaas → a mais
 *      antiga das duas;
 *   2. a mesma dívida nas duas fontes (boleto do SGP emitido pelo Asaas) → UMA
 *      só, a do SGP;
 *   3. o CPF só existe no Asaas → o bot responde a fatura de lá.
 */
const INSTANCE = 'painel-asaas';
const INSTANCE_TOKEN = 'token-instancia-asaas';
const WEBHOOK_TOKEN = 'segredo-webhook-asaas';
const APP = 'painel';
const SGP_TOKEN = 'token-sgp-asaas';
const CHAVE = '$aact_hmlg_bot-de-teste';

const FONE = '5593981112222';
const DOC_SGP = '52998224725';
const DOC_SO_ASAAS = '93541134780';

const LINHA_SGP = '34191790010104351004791020150008699999999999';
const PIX_SGP = '00020126580014BR.GOV.BCB.PIX0136sgp-chave5204000053039865802BR';
const LINHA_ASAAS = '23793381286000782713695000063305975520000012990';
const PIX_ASAAS = '00020126580014BR.GOV.BCB.PIX0136asaas-chave5204000053039865802BR';

let panelUrl;
let token;
let sgpServer;
let asaasServer;
let asaasBase;
let live;
let tituloDoSgp;

function subirSgp() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (payload.app !== APP || payload.token !== SGP_TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith('/api/ura/consultacliente')) {
        return payload.cpfcnpj === DOC_SGP
          ? send({ status: 1, contratos: [{ contratoId: '8001', cpfcnpj: DOC_SGP, razaoSocial: 'Maria Souza', contratoStatusDisplay: 'Ativo', bloqueado: false, endereco: 'Rua A, 10' }] })
          : send({ status: 0, msg: 'Cliente não encontrado' });
      }
      if (req.url.startsWith('/api/ura/titulos')) {
        return send({ status: 1, titulos: [tituloDoSgp] });
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
    if (url.pathname.endsWith('/identificationField')) return responder(200, { identificationField: LINHA_ASAAS, barCode: '123' });
    if (url.pathname.endsWith('/pixQrCode')) return responder(200, { payload: PIX_ASAAS, encodedImage: 'x' });
    if (/^\/payments\/[^/]+$/.test(url.pathname)) {
      return live[id] ? responder(200, live[id]) : responder(404, {});
    }
    return responder(404, {});
  });
  return new Promise((r) => asaasServer.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${asaasServer.address().port}`)));
}

let contador = 0;
async function receber(texto) {
  contador += 1;
  await call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, {
    method: 'POST',
    body: {
      event: 'messages.upsert',
      instance: INSTANCE,
      data: {
        key: { remoteJid: `${FONE}@s.whatsapp.net`, fromMe: false, id: `ASAAS-${contador}` },
        pushName: 'Cliente',
        message: { conversation: texto },
        messageType: 'conversation',
        messageTimestamp: 1739990000
      }
    }
  });
}
const conversa = () => getDb()('wa_conversations').where({ wa_phone_e164: FONE }).first();
async function respostas() {
  const c = await conversa();
  if (!c) return [];
  return getDb()('wa_messages').where({ conversation_id: c.id, direction: 'out' }).whereNull('external_id').orderBy('id').pluck('body');
}
async function limpar() {
  const c = await conversa();
  if (!c) return;
  await getDb()('wa_messages').where({ conversation_id: c.id }).del();
  await getDb()('wa_conversations').where({ id: c.id }).del();
}

const dentro = (fn) => asTenant(fn);

async function semearAsaas(document, charges) {
  await dentro(async () => {
    await AsaasCustomer.upsertFromAsaas({ id: `cus_${document}`, name: 'Cliente Asaas', document }, { seenAt: new Date() });
    for (const c of charges) {
      await AsaasCharge.upsertFromAsaas({
        id: c.id, customerId: `cus_${document}`, status: 'PENDING', billingType: 'BOLETO',
        valueCents: c.cents, dueDate: c.due, invoiceUrl: `https://asaas.test/i/${c.id}`
      }, { document, seenAt: new Date() });
      live[c.id] = { id: c.id, status: c.liveStatus ?? 'PENDING', value: c.cents / 100, dueDate: c.due, billingType: 'BOLETO', invoiceUrl: `https://asaas.test/i/${c.id}` };
    }
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await subirSgp();
  asaasBase = await subirAsaas();
  AsaasInvoiceService.credentialFor = () => ({ apiKey: CHAVE, baseUrl: asaasBase });

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'op-asaas', password: 'operator-password-1', email: 'op-asaas@exemplo.test' }
  });
  token = setup.body.data.token;
  await call(`${panelUrl}/api/sgp/config`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` },
    body: { enabled: true, baseUrl: sgpUrl, app: APP, token: SGP_TOKEN, linkMode: 'pppoe' }
  });
  await asTenant(() => WhatsAppConfigService.saveConfig({
    webhookBaseUrl: 'https://painel.provedor.example/api/whatsapp-webhook',
    portalPublicUrl: 'https://painel.provedor.example'
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE, purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(INSTANCE_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
});

after(async () => {
  await new Promise((r) => sgpServer.close(r));
  await new Promise((r) => asaasServer.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  live = {};
  tituloDoSgp = {
    numerodocumento: '900500', valor: '129,90', vencimento: '10/10/2026', status: 'Em aberto',
    linha_digitavel: LINHA_SGP, pix: PIX_SGP, link: 'https://provedor.example/boleto/900500/'
  };
  await limpar();
  await getDb()('asaas_charges').del();
  await getDb()('asaas_customers').del();
  await dentro(() => AsaasProviderService.saveConfig({
    enabled: true, environment: 'sandbox', apiKey: CHAVE, botLookup: true
  }));
});

describe('mergeOpenInvoices', () => {
  const sgp = { id: 's1', amount: 129.9, dueDate: '2026-10-10', paid: false };

  it('some a fatura do Asaas que é a mesma dívida: mesmo vencimento e mesmo valor', () => {
    const merged = mergeOpenInvoices([sgp], [{ id: 'pay_1', source: 'asaas', amount: 129.9, dueDate: '2026-10-10' }]);
    assert.deepEqual(merged.map((i) => i.id), ['s1']);
  });

  it('mantém as duas quando o valor ou o vencimento diferem', () => {
    const merged = mergeOpenInvoices([sgp], [
      { id: 'pay_1', source: 'asaas', amount: 50, dueDate: '2026-10-10' },
      { id: 'pay_2', source: 'asaas', amount: 129.9, dueDate: '2026-11-10' }
    ]);
    assert.deepEqual(merged.map((i) => i.id), ['s1', 'pay_1', 'pay_2']);
  });

  it('uma fatura do SGP já paga não esconde a do Asaas', () => {
    const merged = mergeOpenInvoices([{ ...sgp, paid: true }], [{ id: 'pay_1', source: 'asaas', amount: 129.9, dueDate: '2026-10-10' }]);
    assert.deepEqual(merged.map((i) => i.id), ['s1', 'pay_1']);
  });

  it('sem Asaas devolve só as do SGP', () => {
    assert.deepEqual(mergeOpenInvoices([sgp], []).map((i) => i.id), ['s1']);
    assert.deepEqual(mergeOpenInvoices(null, null), []);
  });
});

describe('assinante com contrato no SGP', () => {
  beforeEach(async () => {
    await getDb()('sgp_contacts').where({ contract: '8001' }).del();
    await getDb()('sgp_contacts').insert({
      tenant_id: (await getDb()('tenants').first()).id, contract: '8001', document: DOC_SGP, client_name: 'Maria Souza', state: 'active'
    });
  });

  it('a cobrança mais antiga é a do Asaas: vai com o Pix e a linha digitável de lá', async () => {
    await semearAsaas(DOC_SGP, [{ id: 'pay_old', cents: 5000, due: '2026-09-01' }]);
    await receber(DOC_SGP);
    await receber('1');
    const saidas = await respostas();
    const texto = saidas.join('\n---\n');
    assert.ok(texto.includes('R$ 50,00'), texto);
    assert.ok(saidas.includes(PIX_ASAAS) && saidas.includes(LINHA_ASAAS), texto);
    assert.ok(!texto.includes(PIX_SGP), 'misturou o código do SGP com a fatura do Asaas');
  });

  it('a mesma dívida nas duas fontes aparece uma vez só, com os códigos do SGP', async () => {
    await semearAsaas(DOC_SGP, [{ id: 'pay_same', cents: 12990, due: '2026-10-10' }]);
    await receber(DOC_SGP);
    await receber('1');
    const saidas = await respostas();
    assert.ok(saidas.includes(PIX_SGP) && saidas.includes(LINHA_SGP));
    assert.ok(!saidas.includes(PIX_ASAAS));
  });

  it('com o bot sem consulta ao Asaas, só o SGP responde', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ botLookup: false }));
    await semearAsaas(DOC_SGP, [{ id: 'pay_old', cents: 5000, due: '2026-09-01' }]);
    await receber(DOC_SGP);
    await receber('1');
    const saidas = await respostas();
    assert.ok(saidas.includes(PIX_SGP));
    assert.ok(!saidas.join('').includes('R$ 50,00'));
  });

  it('uma cobrança do Asaas que o gateway diz já paga é pulada, e o banco é corrigido', async () => {
    await semearAsaas(DOC_SGP, [{ id: 'pay_paga', cents: 5000, due: '2026-09-01', liveStatus: 'RECEIVED' }]);
    await receber(DOC_SGP);
    await receber('1');
    const saidas = await respostas();
    assert.ok(saidas.includes(PIX_SGP), 'devia cair na fatura do SGP');
    const linha = await getDb()('asaas_charges').where({ asaas_id: 'pay_paga' }).first();
    assert.equal(linha.status, 'RECEIVED');
  });
});

describe('CPF que só existe no Asaas', () => {
  it('o bot responde a fatura de lá, sem ligar a conversa a contrato nenhum', async () => {
    await semearAsaas(DOC_SO_ASAAS, [{ id: 'pay_solo', cents: 8990, due: '2026-10-20' }]);
    await receber('oi');
    await receber(DOC_SO_ASAAS);
    const saidas = await respostas();
    const texto = saidas.join('\n---\n');
    assert.ok(texto.includes('R$ 89,90'), texto);
    assert.ok(saidas.includes(PIX_ASAAS) && saidas.includes(LINHA_ASAAS), texto);
    const c = await conversa();
    assert.equal(c.contract, null);
    assert.equal(c.bot_step, null);
  });

  it('cliente do Asaas sem fatura em aberto ouve que não há fatura', async () => {
    await semearAsaas(DOC_SO_ASAAS, []);
    await receber('oi');
    await receber(DOC_SO_ASAAS);
    assert.match((await respostas()).at(-1), /fatura/i);
    assert.ok(!(await respostas()).join('').includes('Não encontrei cadastro'));
  });

  it('com o bot sem consulta ao Asaas, o CPF segue "não encontrado"', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ botLookup: false }));
    await semearAsaas(DOC_SO_ASAAS, [{ id: 'pay_solo', cents: 8990, due: '2026-10-20' }]);
    await receber('oi');
    await receber(DOC_SO_ASAAS);
    assert.match((await respostas()).at(-1), /Não encontrei cadastro/);
  });

  it('CPF que não está em lugar nenhum segue "não encontrado"', async () => {
    await receber('oi');
    await receber(DOC_SO_ASAAS);
    assert.match((await respostas()).at(-1), /Não encontrei cadastro/);
  });
});

describe('a ficha do cliente', () => {
  beforeEach(async () => {
    await getDb()('sgp_contacts').where({ contract: '8001' }).del();
    await getDb()('sgp_contacts').insert({
      tenant_id: (await getDb()('tenants').first()).id, contract: '8001', document: DOC_SGP, client_name: 'Maria Souza', state: 'active'
    });
  });
  const ficha = () => call(`${panelUrl}/api/contacts/8001/asaas-invoices`, { headers: authHeaders(token) });

  it('lista as faturas em aberto do Asaas pelo CPF do cliente, com a origem', async () => {
    await semearAsaas(DOC_SGP, [{ id: 'pay_a', cents: 5000, due: '2026-09-01' }]);
    const res = await ficha();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.enabled, true);
    assert.deepEqual(res.body.data.invoices.map((i) => [i.id, i.source, i.amount]), [['pay_a', 'asaas', 50]]);
  });

  it('sem importar cobranças, diz que está desligado e não lista nada', async () => {
    await dentro(() => AsaasProviderService.saveConfig({ importCharges: false }));
    await semearAsaas(DOC_SGP, [{ id: 'pay_a', cents: 5000, due: '2026-09-01' }]);
    const res = await ficha();
    assert.equal(res.body.data.enabled, false);
    assert.deepEqual(res.body.data.invoices, []);
  });

  it('não mostra a cobrança de outro CPF', async () => {
    await semearAsaas(DOC_SO_ASAAS, [{ id: 'pay_outro', cents: 7000, due: '2026-09-01' }]);
    const res = await ficha();
    assert.deepEqual(res.body.data.invoices, []);
  });
});
