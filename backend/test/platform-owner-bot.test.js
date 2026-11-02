import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O atendimento dos donos de provedor pelo WhatsApp da plataforma.
 *
 * SaaS, sem domínio-base: a caixa da plataforma existe e `/api/public` atende
 * no mesmo endereço. Toda mensagem entra pelo webhook, como a Evolution manda,
 * na conta da CAIXA — e uma, de propósito, na conta de um provedor, para
 * provar que o fluxo do SGP continua o mesmo ali.
 *
 * O que não pode dar errado:
 *
 * 1. **Dado de cobrança antes do documento.** O telefone só diz de quem PODE
 *    ser a conversa; nada sai antes dos 5 ÚLTIMOS dígitos do CNPJ/CPF de
 *    cobrança (os primeiros são a raiz do CNPJ, pública).
 * 2. **Um provedor receber o dado de outro.** Mesmo com o telefone ambíguo —
 *    que nem ouve o nome dos provedores antes dos dígitos.
 * 3. **O link do recibo abrir o que não devia.** Adulterado, vencido, de
 *    cobrança não paga ou trocado de provedor: o mesmo 404, sem nome nenhum.
 * 4. **O bot falar por cima de gente.** Humano na conversa cala o bot.
 */
process.env.EDITION = 'saas';
process.env.PUBLIC_BASE_URL = 'https://plataforma.exemplo.test';

const {
  call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { tinsertReturningId } = await import('../src/config/database.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
const { default: PlatformOwnerBotService } = await import('../src/services/platformOwnerBotService.js');
const { signReceiptToken, verifyReceiptToken } = await import('../src/utils/receiptLinkToken.js');
const { translate } = await import('../src/i18n/index.js');
const { default: NpsService, hashToken } = await import('../src/services/npsService.js');
const { runUnscoped } = await import('../src/config/tenantContext.js');

const t = (chave, vars) => translate('pt-BR', chave, vars);

const INSTANCIA_CAIXA = 'plataforma-wa';
const TOKEN_CAIXA = 'token-instancia-caixa';
const WEBHOOK_CAIXA = 'segredo-webhook-caixa';
const INSTANCIA_ALFA = 'alfa-wa';
const TOKEN_ALFA = 'token-instancia-alfa';
const WEBHOOK_ALFA = 'segredo-webhook-alfa';

/** Os telefones: o de cobrança da Alfa, o do dono da Beta, o compartilhado e um estranho. */
const FONE_ALFA = '5593981110001';
const FONE_ALFA_ANTIGO = '559381110001'; // o mesmo celular, sem o nono dígito
const FONE_BETA = '5593981110002';
const FONE_AMBIGUO = '5593981110003';
const FONE_ESTRANHO = '5593981119999';

const DOC_ALFA = '12345678000195';
const DOC_BETA = '98765432000110';
const DOC_GAMA = '55555555000155';

let panelUrl;
let caixa;
let alfa;
let beta;
let gama;
let donoBeta;
let pagaAlfa;
let abertaAlfa;
let pagaBeta;

async function hook(token, instancia, telefone, texto, id) {
  return call(`${panelUrl}/api/whatsapp-webhook?t=${token}`, {
    method: 'POST',
    body: {
      event: 'messages.upsert',
      instance: instancia,
      data: {
        key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe: false, id },
        pushName: 'Dono',
        message: { conversation: texto },
        messageType: 'conversation',
        messageTimestamp: 1739990000
      }
    }
  });
}

let ids = 0;
/** Uma mensagem do dono para o número da plataforma. */
async function receber(telefone, texto) {
  ids += 1;
  const { status } = await hook(WEBHOOK_CAIXA, INSTANCIA_CAIXA, telefone, texto, `PO-${ids}`);
  assert.equal(status, 200);
}

async function conversa(telefone, tenantId = caixa) {
  return getDb()('wa_conversations').where({ tenant_id: tenantId, wa_phone_e164: telefone }).first();
}

/** O que o bot pôs na conversa, mais antigo primeiro. */
async function respostas(telefone, tenantId = caixa) {
  const c = await conversa(telefone, tenantId);
  if (!c) return [];
  return getDb()('wa_messages')
    .where({ conversation_id: c.id, direction: 'out' })
    .orderBy('id')
    .pluck('body');
}

/** Esvazia as SAÍDAS (o teto por hora conta as do bot) e guarda o passo da conversa. */
async function limparSaidas(telefone) {
  const c = await conversa(telefone);
  if (c) await getDb()('wa_messages').where({ conversation_id: c.id }).del();
}

/** Recebe e devolve só o que saiu desta vez. */
async function trocar(telefone, texto) {
  await limparSaidas(telefone);
  await receber(telefone, texto);
  return respostas(telefone);
}

/** Recomeça a conversa do zero. */
async function apagarConversa(telefone) {
  const c = await conversa(telefone);
  if (!c) return;
  await getDb()('wa_messages').where({ conversation_id: c.id }).del();
  await getDb()('wa_conversations').where({ id: c.id }).del();
}

/** Uma cobrança escrita direto. */
let periodo = 0;
async function cobranca(tenantId, patch) {
  periodo += 1;
  return runInTenant(tenantId, () => tinsertReturningId('billing_charges', {
    period_end: `2026-${String((periodo % 12) + 1).padStart(2, '0')}-${String(10 + periodo).padStart(2, '0')}`,
    amount_cents: 19900,
    currency: 'BRL',
    provider: 'asaas',
    status: 'pending',
    due_date: '2026-12-10',
    ...patch
  }));
}

/** A segunda via de mentira: lê a cobrança NO ESCOPO em que foi chamada. */
async function segundaViaFalsa(chargeId) {
  const linha = await BillingCharge.findById(chargeId);
  if (!linha) throw new Error('fora do escopo');
  return {
    chargeId: Number(linha.id),
    status: linha.status,
    amountCents: Number(linha.amount_cents),
    dueDate: '2026-12-10',
    invoiceUrl: `https://gateway.exemplo.test/i/${linha.gateway_charge_id}`,
    pix: { payload: `PIX-${linha.gateway_charge_id}` },
    boleto: { identificationField: `LINHA-${linha.gateway_charge_id}` }
  };
}

async function dono(tenantId, username, phone) {
  const id = await insertReturningId('users', {
    username, password: 'hash-qualquer', role: 'admin', email: `${username}@exemplo.test`, phone
  });
  await getDb()('tenant_users').insert({ tenant_id: tenantId, user_id: id, role: 'owner' });
  return id;
}

async function assinatura(tenantId, plano) {
  await runInTenant(tenantId, async () => {
    await getDb()('subscriptions').where({ tenant_id: tenantId }).del();
    await Subscription.createCurrent({
      plan_id: plano.id, status: 'active', renews_at: new Date('2026-12-10T12:00:00Z')
    });
  });
  SubscriptionService.invalidate(tenantId);
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  alfa = (await db('tenants').where({ kind: 'provider' }).orderBy('id', 'asc').first()).id;
  caixa = (await Tenant.platform())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await Tenant.platform()).id;
  }
  beta = await Tenant.create({ slug: 'beta-bot', name: 'Provedor Beta' });
  gama = await Tenant.create({ slug: 'gama-bot', name: 'Provedor Gama' });
  await db('tenants').where({ id: alfa }).update({
    name: 'Provedor Alfa', billing_phone: '(93) 98111-0001', billing_tax_id: '12.345.678/0001-95'
  });
  await db('tenants').where({ id: beta }).update({ billing_tax_id: DOC_BETA });
  await db('tenants').where({ id: gama }).update({ billing_phone: '+55 93 98111-0003', billing_tax_id: DOC_GAMA });
  donoBeta = await dono(beta, 'dono-beta', '93 98111-0002');
  // O dono da Alfa tem o mesmo celular da cobrança da Gama: o telefone ambíguo.
  await dono(alfa, 'dono-alfa', '(93) 98111-0003');

  // O número da plataforma, conectado na caixa.
  await runInTenant(caixa, () => WhatsAppAccount.create({
    name: INSTANCIA_CAIXA,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.plataforma.example',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(TOKEN_CAIXA),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_CAIXA)
  }));
  // E um número de PROVEDOR, para provar que ali nada mudou.
  await runInTenant(alfa, () => WhatsAppAccount.create({
    name: INSTANCIA_ALFA,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.alfa.example',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(TOKEN_ALFA),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_ALFA)
  }));

  abertaAlfa = await cobranca(alfa, { gateway_charge_id: 'pay_alfa_aberta', amount_cents: 19900 });
  pagaAlfa = await cobranca(alfa, { gateway_charge_id: 'pay_alfa_paga', status: 'paid', amount_cents: 19900 });
  await cobranca(beta, { gateway_charge_id: 'pay_beta_aberta', amount_cents: 29900 });
  pagaBeta = await cobranca(beta, { gateway_charge_id: 'pay_beta_paga', status: 'paid', amount_cents: 29900 });

  const plano = await Plan.create({
    code: 'bot-pro', name: 'Plano Pro do Bot', price_cents: 19900, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  await assinatura(alfa, plano);
  await assinatura(beta, plano);

  PlatformOwnerBotService.setDepsForTests({ paymentInfo: segundaViaFalsa });
  PlatformOwnerBotService.clearCache();
});

afterEach(() => {
  PlatformOwnerBotService.setDepsForTests({ paymentInfo: segundaViaFalsa });
});

after(async () => {
  PlatformOwnerBotService.setDepsForTests(null);
  delete process.env.PUBLIC_BASE_URL;
  await stopTestServers();
});

/** Confirma a Alfa até o menu, do zero. */
async function confirmarAlfa(telefone = FONE_ALFA) {
  await apagarConversa(telefone);
  const [pedido] = await trocar(telefone, 'oi');
  assert.equal(pedido, t('whatsapp.platformBot.askTaxId', { name: 'Provedor Alfa' }));
  const [menu] = await trocar(telefone, DOC_ALFA.slice(-5));
  assert.equal(menu, t('whatsapp.platformBot.menu', { name: 'Provedor Alfa' }));
}

describe('identificação pelo telefone', () => {
  it('um número que não é de provedor nenhum vai para a equipe, sem dado nenhum', async () => {
    const saidas = await trocar(FONE_ESTRANHO, 'oi, quero contratar');
    assert.deepEqual(saidas, [t('whatsapp.platformBot.unknownNumber')]);
    const c = await conversa(FONE_ESTRANHO);
    assert.ok(new Date(c.bot_paused_until).getTime() > Date.now(), 'a conversa fica com a equipe');
  });

  it('o telefone de cobrança acha o provedor e pede os 5 últimos dígitos antes de qualquer dado', async () => {
    await apagarConversa(FONE_ALFA);
    // Pedir a fatura logo de cara não adianta: primeiro o documento.
    const [pedido] = await trocar(FONE_ALFA, '1');
    assert.equal(pedido, t('whatsapp.platformBot.askTaxId', { name: 'Provedor Alfa' }));
    // Um número curto não é tentativa: pede de novo, sem contar erro.
    const [denovo] = await trocar(FONE_ALFA, '1');
    assert.equal(denovo, t('whatsapp.platformBot.askTaxIdAgain', { name: 'Provedor Alfa' }));
    assert.equal(Number((await conversa(FONE_ALFA)).bot_doc_attempts), 0);
    const tudo = await respostas(FONE_ALFA);
    assert.ok(tudo.every((m) => !m.includes('pay_alfa')), 'nada de cobrança antes do documento');

    // Os 5 PRIMEIROS (a raiz do CNPJ, pública) não servem mais: é tentativa errada.
    const [raiz] = await trocar(FONE_ALFA, '12.345');
    assert.equal(raiz, t('whatsapp.platformBot.wrongTaxId', { remaining: 2 }));
    // Os 5 últimos, com a pontuação do CNPJ, conferem.
    const [menu] = await trocar(FONE_ALFA, '001-95');
    assert.equal(menu, t('whatsapp.platformBot.menu', { name: 'Provedor Alfa' }));
    // O documento inteiro também passa: o fim dele é o fim do documento.
    await apagarConversa(FONE_ALFA);
    await trocar(FONE_ALFA, 'oi');
    assert.deepEqual(await trocar(FONE_ALFA, '12.345.678/0001-95'), [t('whatsapp.platformBot.menu', { name: 'Provedor Alfa' })]);
  });

  it('a grafia antiga do celular (sem o nono dígito) acha o mesmo provedor', async () => {
    // Sem a conversa da grafia nova: senão a mensagem cairia nela (o painel
    // junta as duas grafias num fio só), e não é isso que se prova aqui.
    await apagarConversa(FONE_ALFA);
    await apagarConversa(FONE_ALFA_ANTIGO);
    const [pedido] = await trocar(FONE_ALFA_ANTIGO, 'oi');
    assert.equal(pedido, t('whatsapp.platformBot.askTaxId', { name: 'Provedor Alfa' }));
    await apagarConversa(FONE_ALFA_ANTIGO);
  });

  it('o telefone do DONO (users.phone) também identifica', async () => {
    await apagarConversa(FONE_BETA);
    const [pedido] = await trocar(FONE_BETA, 'bom dia');
    assert.equal(pedido, t('whatsapp.platformBot.askTaxId', { name: 'Provedor Beta' }));
  });

  it('com dois provedores no mesmo telefone, pede os dígitos sem nomear nenhum — e os dígitos escolhem', async () => {
    await apagarConversa(FONE_AMBIGUO);
    const [pedido] = await trocar(FONE_AMBIGUO, 'oi');
    assert.equal(pedido, t('whatsapp.platformBot.askTaxIdMulti'));
    assert.ok(!/Provedor (Alfa|Gama)/.test(pedido), 'nenhum nome antes da confirmação');
    // Um número curto (o "2" de quem esperava uma lista) não é tentativa.
    assert.deepEqual(await trocar(FONE_AMBIGUO, '2'), [t('whatsapp.platformBot.askTaxIdMultiAgain')]);
    assert.equal(Number((await conversa(FONE_AMBIGUO)).bot_doc_attempts), 0);
    // Dígitos que não são de nenhum dos dois: tentativa errada, e nada sai.
    const [erro] = await trocar(FONE_AMBIGUO, '99999');
    assert.equal(erro, t('whatsapp.platformBot.wrongTaxId', { remaining: 2 }));
    // A raiz do CNPJ da Gama não é o que se pede.
    assert.deepEqual(await trocar(FONE_AMBIGUO, DOC_GAMA.slice(0, 5)), [t('whatsapp.platformBot.wrongTaxId', { remaining: 1 })]);

    const [menu] = await trocar(FONE_AMBIGUO, DOC_GAMA.slice(-5));
    assert.equal(menu, t('whatsapp.platformBot.menu', { name: 'Provedor Gama' }));
    assert.equal(Number((await conversa(FONE_AMBIGUO)).bot_doc_attempts), 0, 'a confirmação zera os erros');
    // A Gama não tem cobrança: a resposta é dela, e não a da Alfa.
    const saidas = await trocar(FONE_AMBIGUO, '1');
    assert.deepEqual(saidas, [t('whatsapp.platformBot.noOpenInvoice', { name: 'Provedor Gama' })]);
  });

  it('o mesmo final em dois provedores: só então a lista — dos que conferiram, já confirmados', async () => {
    // A Gama com um documento que termina como o da Alfa.
    await getDb()('tenants').where({ id: gama }).update({ billing_tax_id: '55555555000195' });
    try {
      await apagarConversa(FONE_AMBIGUO);
      assert.deepEqual(await trocar(FONE_AMBIGUO, 'oi'), [t('whatsapp.platformBot.askTaxIdMulti')]);
      const [lista] = await trocar(FONE_AMBIGUO, '00195');
      assert.equal(lista, [
        t('whatsapp.platformBot.chooseProvider'),
        t('whatsapp.platformBot.providerOption', { n: 1, name: 'Provedor Alfa' }),
        t('whatsapp.platformBot.providerOption', { n: 2, name: 'Provedor Gama' })
      ].join('\n'));
      // Escolher é confirmar: os dígitos já conferiram com os dois.
      assert.deepEqual(await trocar(FONE_AMBIGUO, '2'), [t('whatsapp.platformBot.menu', { name: 'Provedor Gama' })]);
      assert.deepEqual(await trocar(FONE_AMBIGUO, '1'), [t('whatsapp.platformBot.noOpenInvoice', { name: 'Provedor Gama' })]);
    } finally {
      await getDb()('tenants').where({ id: gama }).update({ billing_tax_id: DOC_GAMA });
    }
  });

  it('o cadastro que muda vale na hora para tirar acesso, mesmo com o índice em cache', async () => {
    await getDb()('tenants').where({ id: gama }).update({ billing_phone: null });
    try {
      await apagarConversa(FONE_AMBIGUO);
      const [pedido] = await trocar(FONE_AMBIGUO, 'oi');
      // Só a Alfa (pelo dono) sobra: direto ao documento, sem lista.
      assert.equal(pedido, t('whatsapp.platformBot.askTaxId', { name: 'Provedor Alfa' }));
    } finally {
      await getDb()('tenants').where({ id: gama }).update({ billing_phone: '+55 93 98111-0003' });
    }
  });
});

describe('o documento errado e o bloqueio', () => {
  it('três erros travam por uma hora, e nem o documento certo passa no bloqueio', async () => {
    await apagarConversa(FONE_BETA);
    await trocar(FONE_BETA, 'oi');
    assert.deepEqual(await trocar(FONE_BETA, '11111'), [t('whatsapp.platformBot.wrongTaxId', { remaining: 2 })]);
    assert.deepEqual(await trocar(FONE_BETA, '22222'), [t('whatsapp.platformBot.wrongTaxId', { remaining: 1 })]);
    assert.deepEqual(await trocar(FONE_BETA, '33333'), [t('whatsapp.platformBot.locked')]);
    assert.deepEqual(await trocar(FONE_BETA, DOC_BETA.slice(-5)), [t('whatsapp.platformBot.locked')]);
    assert.deepEqual(await trocar(FONE_BETA, '1'), [t('whatsapp.platformBot.locked')]);
    assert.equal((await conversa(FONE_BETA)).bot_step, PlatformOwnerBotService.PASSO_BLOQUEIO);

    // Uma hora e pouco depois: recomeça do pedido do documento.
    const depois = Date.now() + PlatformOwnerBotService.BLOQUEIO_MS + 60_000;
    PlatformOwnerBotService.setDepsForTests({ paymentInfo: segundaViaFalsa, now: () => depois });
    assert.deepEqual(await trocar(FONE_BETA, DOC_BETA.slice(-5)),
      [t('whatsapp.platformBot.askTaxId', { name: 'Provedor Beta' })]);
    assert.deepEqual(await trocar(FONE_BETA, DOC_BETA.slice(-5)),
      [t('whatsapp.platformBot.menu', { name: 'Provedor Beta' })]);
  });

  it('a confirmação vence em 30 minutos: depois, pede o documento de novo', async () => {
    await confirmarAlfa();
    const depois = Date.now() + PlatformOwnerBotService.CONFIRMACAO_MS + 60_000;
    PlatformOwnerBotService.setDepsForTests({ paymentInfo: segundaViaFalsa, now: () => depois });
    const saidas = await trocar(FONE_ALFA, '1');
    assert.deepEqual(saidas, [t('whatsapp.platformBot.askTaxId', { name: 'Provedor Alfa' })]);
  });

  it('o provedor sem documento de cobrança vai para a equipe', async () => {
    await getDb()('tenants').where({ id: gama }).update({ billing_tax_id: null });
    try {
      await getDb()('tenants').where({ id: alfa }).update({ billing_phone: null });
      await getDb()('users').where({ username: 'dono-alfa' }).update({ phone: null });
      PlatformOwnerBotService.clearCache();
      await apagarConversa(FONE_AMBIGUO);
      const saidas = await trocar(FONE_AMBIGUO, 'oi');
      assert.deepEqual(saidas, [t('whatsapp.platformBot.noTaxId', { name: 'Provedor Gama' })]);
    } finally {
      await getDb()('tenants').where({ id: gama }).update({ billing_tax_id: DOC_GAMA });
      await getDb()('tenants').where({ id: alfa }).update({ billing_phone: '(93) 98111-0001' });
      await getDb()('users').where({ username: 'dono-alfa' }).update({ phone: '(93) 98111-0003' });
      PlatformOwnerBotService.clearCache();
    }
  });
});

describe('o menu de quem confirmou', () => {
  it('1 — a segunda via sai em partes, só a da Alfa, e a trilha não guarda o Pix', async () => {
    await confirmarAlfa();
    const saidas = await trocar(FONE_ALFA, '1');
    assert.equal(saidas.length, 3, JSON.stringify(saidas));
    assert.match(saidas[0], /Provedor Alfa/);
    assert.match(saidas[0], /R\$ 199,00/);
    assert.match(saidas[0], /10\/12\/2026/);
    assert.match(saidas[0], /gateway\.exemplo\.test\/i\/pay_alfa_aberta/);
    assert.equal(saidas[1], 'PIX-pay_alfa_aberta');
    assert.equal(saidas[2], 'LINHA-pay_alfa_aberta');

    const trilha = await getDb()('platform_audit')
      .where({ action: 'bot.billing_disclosed', tenant_id: alfa })
      .orderBy('id', 'desc')
      .first();
    assert.ok(trilha, 'o envio fica na trilha da plataforma');
    const detalhe = JSON.parse(trilha.detail);
    assert.equal(detalhe.what, 'invoice');
    assert.equal(detalhe.chargeId, abertaAlfa);
    assert.deepEqual(detalhe.sent, ['link', 'pix', 'boleto']);
    assert.ok(!trilha.detail.includes('PIX-') && !trilha.detail.includes('LINHA-'), 'nunca o Pix nem a linha');
    assert.ok(!trilha.detail.includes(FONE_ALFA), 'o telefone vai mascarado');
  });

  it('um provedor nunca recebe o dado de outro', async () => {
    await apagarConversa(FONE_BETA);
    await trocar(FONE_BETA, 'oi');
    await trocar(FONE_BETA, DOC_BETA.slice(-5));
    const beta1 = await trocar(FONE_BETA, '1');
    assert.equal(beta1[1], 'PIX-pay_beta_aberta');
    assert.match(beta1[0], /R\$ 299,00/);

    // Varredura das duas conversas: nenhuma traz uma linha da outra.
    const todasAlfa = await getDb()('wa_messages as m')
      .join('wa_conversations as c', 'c.id', 'm.conversation_id')
      .whereIn('c.wa_phone_e164', [FONE_ALFA, FONE_ALFA_ANTIGO, FONE_AMBIGUO])
      .pluck('m.body');
    const todasBeta = await getDb()('wa_messages as m')
      .join('wa_conversations as c', 'c.id', 'm.conversation_id')
      .where('c.wa_phone_e164', FONE_BETA)
      .pluck('m.body');
    assert.ok(todasAlfa.every((m) => !/pay_beta|Provedor Beta|299,00/.test(m)));
    assert.ok(todasBeta.every((m) => !/pay_alfa|Provedor Alfa/.test(m)));
  });

  it('2 — a situação da assinatura: plano, estado, vencimento e valor', async () => {
    await confirmarAlfa();
    const [situacao] = await trocar(FONE_ALFA, '2');
    assert.match(situacao, /Plano Pro do Bot/);
    assert.match(situacao, new RegExp(t('whatsapp.platformBot.statusLabel.active')));
    assert.match(situacao, /10\/12\/2026/);
    assert.match(situacao, /R\$ 199,00/);
    const trilha = await getDb()('platform_audit')
      .where({ action: 'bot.billing_disclosed', tenant_id: alfa })
      .orderBy('id', 'desc')
      .first();
    assert.equal(JSON.parse(trilha.detail).what, 'status');
  });

  it('3 — o recibo do último pagamento, por um link que abre sem login', async () => {
    await confirmarAlfa();
    const [mensagem] = await trocar(FONE_ALFA, '3');
    // O token no FRAGMENTO da página pública, nunca no caminho da API.
    const achado = /https:\/\/plataforma\.exemplo\.test\/receipt#([A-Za-z0-9_.-]+)/.exec(mensagem);
    assert.ok(achado, mensagem);
    assert.ok(!mensagem.includes('/api/public/receipt/'), 'o link novo não leva o token no caminho');
    const alvo = verifyReceiptToken(achado[1]);
    assert.deepEqual([alvo.tenantId, alvo.chargeId], [alfa, pagaAlfa]);

    // A página manda o token no corpo.
    const resposta = await fetch(`${panelUrl}/api/public/receipt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: achado[1] })
    });
    assert.equal(resposta.status, 200);
    assert.match(resposta.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(resposta.headers.get('cache-control'), 'no-store');
    const html = await resposta.text();
    assert.match(html, /Provedor Alfa/);
    assert.ok(!html.includes('Provedor Beta'));

    const trilha = await getDb()('platform_audit')
      .where({ action: 'bot.billing_disclosed', tenant_id: alfa })
      .orderBy('id', 'desc')
      .first();
    assert.equal(JSON.parse(trilha.detail).what, 'receipt');
    assert.ok(!trilha.detail.includes(achado[1]), 'o token não vai para a trilha');
  });

  it('4 — falar com a equipe pausa o bot e passa a conversa', async () => {
    await confirmarAlfa();
    const saidas = await trocar(FONE_ALFA, '4');
    assert.deepEqual(saidas, [await runInTenant(caixa, () => WaBotConfigService.message('handoffQueued'))]);
    assert.ok(new Date((await conversa(FONE_ALFA)).bot_paused_until).getTime() > Date.now());
    // Em pausa, o bot fica calado.
    assert.deepEqual(await trocar(FONE_ALFA, '1'), []);
    await getDb()('wa_conversations').where({ id: (await conversa(FONE_ALFA)).id }).update({ bot_paused_until: null });
  });

  it('com um humano na conversa, o bot não fala', async () => {
    await confirmarAlfa();
    await limparSaidas(FONE_ALFA);
    const c = await conversa(FONE_ALFA);
    await getDb()('wa_messages').insert({
      conversation_id: c.id,
      tenant_id: caixa,
      direction: 'out',
      body: 'Oi, aqui é da equipe',
      is_note: false,
      delivery_status: 'sent',
      sent_by: donoBeta,
      created_at: new Date(),
      updated_at: new Date()
    });
    await receber(FONE_ALFA, '1');
    const saidas = await respostas(FONE_ALFA);
    assert.deepEqual(saidas, ['Oi, aqui é da equipe'], 'só a mensagem do humano');
  });
});

describe('o link público do recibo', () => {
  const abrir = (token) => fetch(`${panelUrl}/api/public/receipt/${token}`);
  const abrirPeloCorpo = (token) => fetch(`${panelUrl}/api/public/receipt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token === undefined ? {} : { token })
  });

  it('pelo corpo: as mesmas recusas, o mesmo 404; o válido abre', async () => {
    const valido = signReceiptToken({ tenantId: alfa, chargeId: pagaAlfa });
    const recusas = [
      undefined,
      'nao-e-um-token',
      signReceiptToken({ tenantId: alfa, chargeId: abertaAlfa }),
      signReceiptToken({ tenantId: beta, chargeId: pagaAlfa })
    ];
    const corpos = new Set();
    for (const token of recusas) {
      // eslint-disable-next-line no-await-in-loop
      const r = await abrirPeloCorpo(token);
      assert.equal(r.status, 404, String(token));
      // eslint-disable-next-line no-await-in-loop
      corpos.add(await r.text());
    }
    assert.equal(corpos.size, 1);
    const ok = await abrirPeloCorpo(valido);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(await ok.text(), /Provedor Alfa/);
  });

  it('o link antigo, com o token no caminho, sai do log de acesso mascarado', async () => {
    const { redactPath, setLogSink } = await import('../src/utils/logger.js');
    const valido = signReceiptToken({ tenantId: alfa, chargeId: pagaAlfa });
    assert.equal(redactPath(`/api/public/receipt/${valido}`), '/api/public/receipt/:token');
    assert.equal(redactPath('/api/public/receipt'), '/api/public/receipt');
    assert.equal(redactPath('/api/public/plans'), '/api/public/plans');

    // E na linha de verdade: o middleware grava o caminho mascarado.
    const linhas = [];
    setLogSink((linha) => { linhas.push(String(linha)); });
    try {
      assert.equal((await abrir(valido)).status, 200);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      setLogSink(null);
    }
    const doRecibo = linhas.filter((l) => l.includes('/api/public/receipt'));
    assert.ok(doRecibo.length >= 1, 'a linha de acesso existe');
    assert.ok(doRecibo.every((l) => !l.includes(valido)), 'o token não vai para o log');
  });

  it('adulterado, vencido, não pago ou trocado de provedor: o mesmo 404, sem nome nenhum', async () => {
    const valido = signReceiptToken({ tenantId: alfa, chargeId: pagaAlfa });
    const [corpo, assinatura] = valido.split('.');
    const trocaUmCaractere = `${corpo}.${assinatura.slice(0, -1)}${assinatura.endsWith('A') ? 'B' : 'A'}`;
    // O corpo de outro token com a assinatura deste: a assinatura não serve.
    const corpoDaBeta = signReceiptToken({ tenantId: beta, chargeId: pagaBeta }).split('.')[0];
    const casos = {
      adulterado: trocaUmCaractere,
      corpoTrocado: `${corpoDaBeta}.${assinatura}`,
      vencido: signReceiptToken({ tenantId: alfa, chargeId: pagaAlfa }, Date.now() - 8 * 24 * 60 * 60 * 1000),
      naoPago: signReceiptToken({ tenantId: alfa, chargeId: abertaAlfa }),
      deOutroProvedor: signReceiptToken({ tenantId: beta, chargeId: pagaAlfa }),
      daCaixa: signReceiptToken({ tenantId: caixa, chargeId: pagaAlfa }),
      inexistente: signReceiptToken({ tenantId: alfa, chargeId: 999999 }),
      lixo: 'nao-e-um-token'
    };
    const corpos = new Set();
    for (const [nome, token] of Object.entries(casos)) {
      // eslint-disable-next-line no-await-in-loop -- uma de cada vez, para o limite não confundir
      const resposta = await abrir(token);
      assert.equal(resposta.status, 404, nome);
      assert.match(resposta.headers.get('content-security-policy'), /default-src 'none'/, nome);
      // eslint-disable-next-line no-await-in-loop
      const html = await resposta.text();
      assert.ok(!/Provedor (Alfa|Beta)|12\.345|98\.765/.test(html), `${nome} vazou dado`);
      corpos.add(html);
    }
    assert.equal(corpos.size, 1, 'toda recusa é a mesma resposta');

    // E o válido abre.
    assert.equal((await abrir(valido)).status, 200);
  });

  it('o token não aceita uma validade estendida à mão', () => {
    const valido = signReceiptToken({ tenantId: alfa, chargeId: pagaAlfa });
    const [corpo, assinatura] = valido.split('.');
    const texto = Buffer.from(corpo, 'base64url').toString('utf8').replace(/\.(\d+)$/, '.99999999999');
    const forjado = `${Buffer.from(texto).toString('base64url')}.${assinatura}`;
    assert.equal(verifyReceiptToken(forjado), null);
  });
});

describe('o gancho numérico (para a pesquisa)', () => {
  it('reclama um número sozinho fora de um passo, e não no meio do documento', async () => {
    const vistos = [];
    const desfazer = PlatformOwnerBotService.registerNumericHandler(async (ctx) => {
      vistos.push(ctx);
      if (!ctx.tenantIds.includes(alfa)) return null;
      return { consumed: true, reply: `nota ${ctx.number} recebida`, intent: 'nps' };
    });
    try {
      await apagarConversa(FONE_ALFA);
      assert.deepEqual(await trocar(FONE_ALFA, '9'), ['nota 9 recebida']);
      assert.deepEqual(vistos.at(-1).tenantIds, [alfa]);

      // No meio do documento o número é a resposta do passo, e o gancho não é chamado.
      await trocar(FONE_ALFA, 'oi');
      const antes = vistos.length;
      assert.deepEqual(await trocar(FONE_ALFA, '10'), [t('whatsapp.platformBot.askTaxIdAgain', { name: 'Provedor Alfa' })]);
      assert.equal(vistos.length, antes);
    } finally {
      desfazer();
    }
  });
});

describe('a nota da pesquisa pelo WhatsApp (o gancho ligado no arranque)', () => {
  let sequencia = 0;
  /** Uma pesquisa pendente do provedor, mandada pelos canais dados. */
  async function pendente(tenantId, channel = 'email,whatsapp') {
    sequencia += 1;
    await runInTenant(tenantId, () => tinsertReturningId('platform_nps', {
      wave: 'manual',
      wave_key: null,
      token_hash: hashToken(`token-da-pesquisa-${tenantId}-${sequencia}`.padEnd(43, 'x')),
      status: 'pending',
      channel,
      asked_at: new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
    }));
  }
  const linhasNps = (tenantId) => runUnscoped('test reads the NPS rows', () => getDb()('platform_nps')
    .where({ tenant_id: tenantId }).orderBy('id'));
  const limparNps = () => runUnscoped('test clears the NPS rows', () => getDb()('platform_nps').del());

  afterEach(limparNps);

  it('está ligado: a pergunta convida a responder pelo WhatsApp', () => {
    assert.equal(NpsService.whatsappReplyEnabled, true);
  });

  it('o telefone de cobrança, ainda sem confirmar, responde a nota da pesquisa pendente', async () => {
    await pendente(alfa);
    await apagarConversa(FONE_ALFA);
    assert.deepEqual(await trocar(FONE_ALFA, '9'), [translate('pt-BR', 'nps.whatsappThanks', { score: 9 })]);
    const [linha] = await linhasNps(alfa);
    assert.equal(linha.status, 'answered');
    assert.equal(Number(linha.score), 9);
    assert.equal(linha.answer_channel, 'whatsapp');
  });

  it('com o menu confirmado, "1" é a segunda via, e não uma nota', async () => {
    await confirmarAlfa();
    await pendente(alfa);
    const saidas = await trocar(FONE_ALFA, '1');
    assert.equal(saidas.length, 3, JSON.stringify(saidas));
    assert.match(saidas[0], /Provedor Alfa/);
    assert.equal((await linhasNps(alfa))[0].status, 'pending');
  });

  it('a pesquisa mandada só por e-mail não é respondida pelo WhatsApp', async () => {
    await pendente(alfa, 'email');
    await apagarConversa(FONE_ALFA);
    assert.deepEqual(await trocar(FONE_ALFA, '9'), [t('whatsapp.platformBot.askTaxId', { name: 'Provedor Alfa' })]);
    assert.equal((await linhasNps(alfa))[0].status, 'pending');
  });

  it('o telefone só do DONO (não o de cobrança) não responde', async () => {
    await pendente(beta);
    await apagarConversa(FONE_BETA);
    assert.deepEqual(await trocar(FONE_BETA, '9'), [t('whatsapp.platformBot.askTaxId', { name: 'Provedor Beta' })]);
    assert.equal((await linhasNps(beta))[0].status, 'pending');
  });

  it('o telefone de cobrança de dois provedores com pesquisa pendente não responde nenhuma', async () => {
    await getDb()('tenants').where({ id: beta }).update({ billing_phone: '93 98111-0001' });
    PlatformOwnerBotService.clearCache();
    try {
      await pendente(alfa);
      await pendente(beta);
      await apagarConversa(FONE_ALFA);
      assert.deepEqual(await trocar(FONE_ALFA, '9'), [t('whatsapp.platformBot.askTaxIdMulti')]);
      assert.equal((await linhasNps(alfa))[0].status, 'pending');
      assert.equal((await linhasNps(beta))[0].status, 'pending');
    } finally {
      await getDb()('tenants').where({ id: beta }).update({ billing_phone: null });
      PlatformOwnerBotService.clearCache();
    }
  });
});

describe('os outros provedores', () => {
  it('o número de um provedor segue o fluxo do SGP, sem nada do bot da plataforma', async () => {
    ids += 1;
    const { status } = await hook(WEBHOOK_ALFA, INSTANCIA_ALFA, FONE_ALFA, '1', `PROV-${ids}`);
    assert.equal(status, 200);
    const saidas = await respostas(FONE_ALFA, alfa);
    assert.equal(saidas.length, 1, JSON.stringify(saidas));
    assert.equal(saidas[0], await runInTenant(alfa, () => WaBotConfigService.message('notRecognised')));
    assert.ok(!saidas[0].includes('CNPJ ou CPF de cobrança'));
    assert.equal(await runInTenant(alfa, () => PlatformOwnerBotService.isPlatformScope()), false);
    assert.equal(await runInTenant(caixa, () => PlatformOwnerBotService.isPlatformScope()), true);
  });
});
