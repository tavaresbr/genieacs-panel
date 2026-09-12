import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O aviso que chega ANTES do bloqueio.
 *
 * Até aqui o provedor descobria que o teste acabou — ou que o período pago
 * venceu — tomando 402 ao salvar. O painel sabia a data, mostrava a data na
 * tela de plano, e não dizia nada. Uma cobrança legítima virava chamado de
 * suporte, e o chamado chegava com o cliente já irritado.
 *
 * O que este arquivo guarda são as três maneiras de errar isto: não avisar,
 * avisar demais (o agendador roda de minuto em minuto), e avisar para
 * ninguém — porque `billing_email` é nulo em todo provedor que existe hoje.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: SubscriptionNoticeService } = await import(
  '../src/services/subscriptionNoticeService.js'
);
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');

const DIA = 24 * 60 * 60 * 1000;

let smtp;
let recebidas;
let alfa;

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'SkyGenPanel <nao-responda@exemplo.test>';
  resetMailTransport();

  await startTestServers();
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  // O dono, que é a reserva quando não há e-mail de cobrança.
  const [donoId] = await getDb()('users')
    .insert({ username: 'a-dona', password: 'x', role: 'owner', email: 'a-dona@exemplo.test' })
    .returning('id')
    .then((rows) => rows.map((r) => (typeof r === 'object' ? r.id : r)));
  await getDb()('tenant_users').insert({ tenant_id: alfa, user_id: donoId, role: 'owner' });
});

after(async () => {
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await stopTestServers();
  await new Promise((done) => smtp.close(done));
});

/** Põe a assinatura do provedor no estado pedido e esquece o cache. */
async function comAssinatura(patch) {
  await Subscription.upsertForTenant(alfa, {
    status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null,
    expiry_warned_for: null, ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

async function semEmailDeCobranca() {
  await getDb()('tenants').where({ id: alfa }).update({ billing_email: null });
}

const avisar = (now) => runInTenant(alfa, () => SubscriptionNoticeService.notifyCurrent({ now }));

const ultima = () => decodificarQuotedPrintable(recebidas[recebidas.length - 1]);

beforeEach(async () => {
  recebidas.length = 0;
  await semEmailDeCobranca();
});

describe('quando o aviso sai', () => {
  it('manda quando o teste está a três dias de acabar', async () => {
    await comAssinatura({ status: 'trial', trial_ends_at: new Date(Date.now() + 3 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.sent, true, JSON.stringify(resultado));
    assert.equal(resultado.kind, 'trial');
    assert.equal(recebidas.length, 1);
  });

  it('e quando o período pago está a dois dias de vencer', async () => {
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 2 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.sent, true);
    assert.equal(resultado.kind, 'renewal');
  });

  /**
   * Vencido também avisa, e é o caso que mais importa: é justamente quem já
   * está tomando 402 ao salvar e não sabe por quê.
   */
  it('e depois de vencer, porque é quem está sendo bloqueado agora', async () => {
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() - 1 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.sent, true);
    assert.equal(resultado.expired, true);
  });

  it('mas não manda com o prazo longe', async () => {
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 30 * DIA) });
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
    assert.equal(recebidas.length, 0);
  });

  it('nem para quem não tem prazo nenhum', async () => {
    await comAssinatura({ status: 'active', renews_at: null });
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
  });

  /**
   * Quem já foi bloqueado não precisa de aviso: `suspended` e `canceled` são
   * decisões de gente, e a gente que as tomou já falou com o cliente.
   */
  it('nem para quem já foi desligado à mão', async () => {
    for (const status of ['suspended', 'canceled']) {
      await comAssinatura({ status, renews_at: new Date(Date.now() + 2 * DIA) });
      assert.equal((await avisar(new Date())).reason, 'nothing_due', status);
    }
  });
});

describe('uma mensagem por prazo, nunca uma por passada do agendador', () => {
  it('não repete o aviso do mesmo prazo', async () => {
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 2 * DIA) });
    assert.equal((await avisar(new Date())).sent, true);
    recebidas.length = 0;
    // O agendador roda de minuto em minuto: a segunda passada é o teste.
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
    assert.equal(recebidas.length, 0, 'seriam mil e quatrocentas mensagens por dia');
  });

  /**
   * A marca guarda O PRAZO avisado, não a hora do aviso — então um pagamento
   * que empurra `renews_at` recomeça o ciclo sozinho, sem nenhum caminho
   * precisar lembrar de limpar nada.
   */
  it('mas recomeça sozinho quando o prazo muda', async () => {
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 2 * DIA) });
    await avisar(new Date());
    recebidas.length = 0;

    await runInTenant(alfa, () => SubscriptionService.recordPayment({ amountCents: 19990 }));
    await SubscriptionService.invalidate(alfa);
    // Trinta dias à frente: o prazo novo está longe, então nada sai agora...
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
    // ...mas sai quando ele chega perto, e a marca velha não atrapalha.
    const daquiA29 = new Date(Date.now() + 29 * DIA);
    assert.equal((await avisar(daquiA29)).sent, true);
  });

  /**
   * A marca só é gravada quando a mensagem SAIU. Marcar antes deixaria um
   * provedor sem aviso nenhum no dia em que o SMTP estivesse fora do ar — e a
   * marca é justamente o que impediria a segunda tentativa.
   */
  it('e não marca nada quando não havia para quem mandar', async () => {
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 2 * DIA) });
    await getDb()('tenant_users').where({ tenant_id: alfa }).del();
    try {
      assert.equal((await avisar(new Date())).reason, 'no_recipient');
      const linha = await getDb()('subscriptions').where({ tenant_id: alfa }).first();
      assert.equal(linha.expiry_warned_for, null, 'marcar sem mandar perde o aviso para sempre');
    } finally {
      const dono = await getDb()('users').where({ username: 'a-dona' }).first();
      await getDb()('tenant_users').insert({ tenant_id: alfa, user_id: dono.id, role: 'owner' });
    }
  });
});

describe('para quem vai', () => {
  it('para o e-mail de cobrança, quando ele existe', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_email: 'financeiro@alfa.test' });
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 2 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.sent, true);
    assert.match(ultima(), /financeiro@alfa\.test/);
  });

  /**
   * O campo de cobrança nasceu ontem: é nulo em 100% dos provedores que já
   * existem. Sem esta reserva, o aviso não chegaria a ninguém justamente nos
   * provedores que já estão pagando.
   */
  it('e para os donos do provedor quando ele é nulo, que é o caso de todos hoje', async () => {
    await comAssinatura({ status: 'trial', trial_ends_at: new Date(Date.now() + 1 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.sent, true);
    assert.match(ultima(), /a-dona@exemplo\.test/);
  });

  it('e a mensagem diz o provedor, a data e o caminho de volta', async () => {
    await comAssinatura({ status: 'trial', trial_ends_at: new Date(Date.now() + 1 * DIA) });
    await avisar(new Date());
    const texto = ultima();
    const tenant = await Tenant.findById(alfa);
    assert.ok(texto.includes(tenant.name), 'sem o nome do provedor a mensagem é anônima');
    assert.match(texto, /\d{4}-\d{2}-\d{2}/, 'a data vai em ISO: o idioma do destinatário é desconhecido');
  });
});

/**
 * O agendador entrega a linha do provedor que o laço já leu. Quem chama sem
 * ela continua funcionando — mas paga uma consulta, e é por isso que o
 * agendador não paga.
 */
describe('o provedor vem do laço, quando o laço o tem', () => {
  it('usa a linha entregue e não relê nada', async () => {
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 2 * DIA) });
    const linha = await Tenant.findById(alfa);
    const resultado = await runInTenant(alfa, () => SubscriptionNoticeService.notifyCurrent({
      now: new Date(),
      tenant: { ...linha, billing_email: 'do-laco@exemplo.test' }
    }));
    assert.equal(resultado.sent, true);
    assert.match(ultima(), /do-laco@exemplo\.test/, 'o endereço tinha que sair da linha entregue');
  });

  it('e relê quando ninguém a entregou', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_email: 'do-banco@exemplo.test' });
    await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 2 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.sent, true);
    assert.match(ultima(), /do-banco@exemplo\.test/);
  });
});

describe('sem transporte de e-mail', () => {
  it('não tenta, não marca, e não é erro', async () => {
    const antes = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    resetMailTransport();
    try {
      await comAssinatura({ status: 'active', renews_at: new Date(Date.now() + 2 * DIA) });
      assert.equal((await avisar(new Date())).reason, 'no_transport');
      const linha = await getDb()('subscriptions').where({ tenant_id: alfa }).first();
      assert.equal(linha.expiry_warned_for, null);
    } finally {
      process.env.SMTP_URL = antes;
      resetMailTransport();
    }
  });
});
