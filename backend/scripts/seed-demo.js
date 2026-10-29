import 'dotenv/config';

/**
 * Dados de demonstração para a edição SaaS: o que os testes no navegador
 * (`frontend/e2e`) percorrem, e o que alguém quer ver ao abrir o console num
 * ambiente de desenvolvimento sem cliente nenhum.
 *
 *   node scripts/seed-demo.js
 *
 * O que fica no banco:
 *
 * - dois planos pagos, com preço mensal e anual (`demo-essencial`,
 *   `demo-profissional`);
 * - três provedores, cada um com um dono que entra com senha conhecida
 *   (`DEMO_PROVIDERS` abaixo):
 *   - **Alfa Fibra** em dia, no mensal, com faturas pagas e a do próximo
 *     período em aberto (com id no gateway — é a da "segunda via");
 *   - **Beta Net** vencida há 8 dias, com a renovação vencida no gateway;
 *   - **Gama Telecom** no anual, suspensa por falta de pagamento, com o
 *     cancelamento agendado;
 * - um alerta da plataforma que falhou (o "Reenviar" do histórico).
 *
 * As cobranças com id no gateway pressupõem um Asaas — de verdade não, que
 * isto é dado de mentira: o e2e sobe um gateway falso (`frontend/e2e/support`)
 * que responde por esses ids.
 *
 * ## Só fora de produção
 *
 * Recusa-se a rodar sem `APP_ENV=test` ou `development`. Os donos têm senha
 * escrita neste arquivo, que é público — num banco de verdade isso é uma porta
 * aberta com o endereço publicado.
 *
 * ## Rodar de novo é seguro
 *
 * Cada linha é procurada pela sua chave natural antes de ser escrita (código do
 * plano, slug, usuário, id no gateway, chave do alerta), e o que já existe fica
 * como está. As datas são relativas a AGORA na primeira passada; a segunda não
 * as move.
 */

const AMBIENTES = new Set(['test', 'development']);
if (!AMBIENTES.has(process.env.APP_ENV) || process.env.NODE_ENV === 'production') {
  console.error(
    `seed-demo refuses to run with APP_ENV=${process.env.APP_ENV ?? '(unset)'}: `
    + 'it writes known passwords, so it only runs with APP_ENV=test or APP_ENV=development.'
  );
  process.exit(1);
}

// Dinâmicos de propósito: `config/database.js` lê `DATA_DIR` no carregamento,
// e a recusa acima tem que vir antes de qualquer conexão.
const { default: bcrypt } = await import('bcryptjs');
const { getDb, closePool, tinsertReturningId } = await import('../src/config/database.js');
const { runInTenant, runUnscoped } = await import('../src/config/tenantContext.js');
const { ensureSchema } = await import('../src/config/schema.js');
const { seedDefaults } = await import('../src/config/seed.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: User } = await import('../src/models/User.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: OnboardingService } = await import('../src/services/onboardingService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');

const DIA = 24 * 60 * 60 * 1000;
/** Instantes ao segundo: o MySQL arredonda os milissegundos. */
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const daqui = (dias) => aoSegundo(Date.now() + dias * DIA);
const dia = (instante) => ChargeIssuingService.isoDate(instante);

const DEMO_PLANS = Object.freeze([
  {
    code: 'demo-essencial',
    name: 'Essencial',
    price_cents: 19900,
    price_yearly_cents: 199000,
    max_operators: 5,
    max_subscribers: 1000,
    max_devices: 1000,
    sort_order: 10
  },
  {
    code: 'demo-profissional',
    name: 'Profissional',
    price_cents: 39900,
    price_yearly_cents: 399000,
    max_operators: 20,
    max_subscribers: 5000,
    max_devices: 5000,
    sort_order: 20,
    featured: true
  }
]);

/**
 * Os provedores e os seus donos. As senhas são públicas: ver o cabeçalho. O
 * e2e entra com as mesmas (`frontend/e2e/support/demo.ts`).
 */
const DEMO_PROVIDERS = Object.freeze([
  {
    slug: 'alfa-fibra',
    name: 'Alfa Fibra',
    owner: { username: 'alfa.dono', email: 'dono@alfa-fibra.test', password: 'Alfa-Demo-2026' },
    taxId: '11222333000181'
  },
  {
    slug: 'beta-net',
    name: 'Beta Net',
    owner: { username: 'beta.dono', email: 'dono@beta-net.test', password: 'Beta-Demo-2026' },
    taxId: '11444777000161'
  },
  {
    slug: 'gama-telecom',
    name: 'Gama Telecom',
    owner: { username: 'gama.dono', email: 'dono@gama-telecom.test', password: 'Gama-Demo-2026' },
    taxId: '45723174000110'
  }
]);

async function garantirPlano(spec) {
  const existente = await Plan.findByCode(spec.code);
  if (existente) return existente;
  await Plan.create({
    currency: 'BRL', period_days: 30, trial_days: 0, active: true, public: true, featured: false, ...spec
  });
  return Plan.findByCode(spec.code);
}

async function garantirProvedor(spec) {
  const db = getDb();
  let tenant = await Tenant.findBySlug(spec.slug);
  let novo = false;
  if (!tenant) {
    // Como o console cria (`PlatformController.create`): a linha e os padrões
    // do provedor juntos.
    await db.transaction(async (trx) => {
      const id = await Tenant.create({ slug: spec.slug, name: spec.name }, trx);
      await seedDefaults(trx, { tenantIds: [id] });
    });
    tenant = await Tenant.findBySlug(spec.slug);
    novo = true;
  }
  if (novo) {
    // tenant-scope-exempt: o cadastro de cobrança mora na linha do provedor, acima de qualquer escopo.
    await db('tenants').where({ id: tenant.id }).update({
      billing_legal_name: `${spec.name} Ltda`,
      billing_tax_id: spec.taxId,
      billing_email: spec.owner.email,
      billing_phone: '11987654321',
      billing_postal_code: '01310100',
      billing_address_line: 'Avenida Paulista',
      billing_address_number: '1000',
      billing_district: 'Bela Vista',
      billing_city: 'São Paulo',
      billing_state: 'SP',
      billing_gateway: 'asaas',
      billing_customer_ref: `cus_demo_${spec.slug.replace(/-/g, '_')}`
    });
  }

  let usuario = await db('users').where({ username: spec.owner.username }).first();
  if (!usuario) {
    const id = await User.create({
      username: spec.owner.username,
      email: spec.owner.email,
      password: await bcrypt.hash(spec.owner.password, 10),
      role: 'owner'
    });
    usuario = await db('users').where({ id }).first();
  }
  if (!(await db('tenant_users').where({ tenant_id: tenant.id, user_id: usuario.id }).first())) {
    await TenantUser.create({ tenantId: tenant.id, userId: usuario.id, role: 'owner' });
  }
  // Sem o assistente de primeiro acesso: o painel de um provedor recém-criado
  // abriria nele, e a demonstração é do que vem depois.
  await runInTenant(tenant.id, async () => {
    await OnboardingService.dismiss('wizard');
    await OnboardingService.dismiss('checklist');
  });
  return { tenant, usuario, novo };
}

/** Uma cobrança, só se o id no gateway ainda não existe neste provedor. */
async function garantirCobranca(tenantId, row) {
  return runInTenant(tenantId, async () => {
    const db = getDb();
    // tenant-scope-exempt: lido por id do provedor explícito, dentro do escopo dele.
    const existente = await db('billing_charges')
      .where({ tenant_id: tenantId, gateway_charge_id: row.gateway_charge_id })
      .first();
    if (existente) return Number(existente.id);
    const subscription = await Subscription.forTenant(tenantId);
    return tinsertReturningId('billing_charges', {
      subscription_id: subscription?.id ?? null,
      currency: 'BRL',
      provider: 'asaas',
      kind: 'renewal',
      billing_type: 'UNDEFINED',
      invoice_url: `https://sandbox.asaas.test/i/${row.gateway_charge_id}`,
      attempts: 1,
      ...row
    });
  });
}

/** O pagamento no extrato, como o webhook o grava — é dele que sai a receita. */
async function garantirPagamento(tenantId, { externalId, amountCents, paidAt, planId }) {
  return runInTenant(tenantId, async () => {
    const db = getDb();
    // tenant-scope-exempt: idem, por id do provedor explícito.
    if (await db('billing_events').where({ tenant_id: tenantId, external_id: externalId }).first()) return;
    const subscription = await Subscription.forTenant(tenantId);
    await tinsertReturningId('billing_events', {
      subscription_id: subscription?.id ?? null,
      type: 'payment.recorded',
      amount_cents: amountCents,
      currency: 'BRL',
      provider: 'asaas',
      external_id: externalId,
      detail: JSON.stringify({ planId, method: 'PIX', seed: 'demo' }),
      created_at: paidAt
    });
  });
}

/** Faturas pagas dos `meses` períodos anteriores a `renovaEm`. */
async function historicoPago(tenantId, { renovaEm, meses, valor, planId, prefixo }) {
  for (let k = 1; k <= meses; k += 1) {
    const fim = new Date(renovaEm.getTime() - k * 30 * DIA);
    const gatewayId = `pay_demo_${prefixo}_paid_${k}`;
    const pagoEm = aoSegundo(fim.getTime() - 2 * DIA);
    // eslint-disable-next-line no-await-in-loop -- poucas linhas, em ordem
    await garantirCobranca(tenantId, {
      period_end: dia(fim),
      amount_cents: valor,
      status: 'paid',
      due_date: dia(fim),
      gateway_charge_id: gatewayId,
      plan_id: planId,
      billing_cycle: 'monthly',
      created_at: aoSegundo(fim.getTime() - 5 * DIA),
      updated_at: pagoEm
    });
    // eslint-disable-next-line no-await-in-loop -- idem
    await garantirPagamento(tenantId, { externalId: gatewayId, amountCents: valor, paidAt: pagoEm, planId });
  }
}

async function main() {
  await ensureSchema();
  const db = getDb();

  const planos = [];
  for (const spec of DEMO_PLANS) {
    // eslint-disable-next-line no-await-in-loop -- dois planos
    planos.push(await garantirPlano(spec));
  }
  const [planoEssencial, planoProfissional] = planos;

  const provedores = {};
  for (const spec of DEMO_PROVIDERS) {
    // eslint-disable-next-line no-await-in-loop -- três provedores
    provedores[spec.slug] = await garantirProvedor(spec);
  }
  const alfa = provedores['alfa-fibra'];
  const beta = provedores['beta-net'];
  const gama = provedores['gama-telecom'];

  // As assinaturas, só na primeira passada: rodar de novo não move as datas.
  const LIMPA = {
    status: 'active', trial_ends_at: null, canceled_at: null, billing_exempt_at: null,
    billing_exempt_until: null, suspended_reason: null, paused_until: null, pause_started_at: null,
    cancel_at: null, proration_due_at: null, pending_plan_id: null, pending_plan_at: null
  };
  if (alfa.novo) {
    await Subscription.upsertForTenant(alfa.tenant.id, {
      ...LIMPA, plan_id: planoEssencial.id, billing_cycle: 'monthly', renews_at: daqui(20)
    });
  }
  if (beta.novo) {
    await Subscription.upsertForTenant(beta.tenant.id, {
      ...LIMPA, plan_id: planoProfissional.id, billing_cycle: 'monthly', renews_at: daqui(-8)
    });
  }
  if (gama.novo) {
    await Subscription.upsertForTenant(gama.tenant.id, {
      ...LIMPA,
      plan_id: planoEssencial.id,
      billing_cycle: 'annual',
      renews_at: daqui(-40),
      status: 'suspended',
      suspended_reason: 'auto_nonpayment',
      cancel_at: daqui(30)
    });
    // tenant-scope-exempt: a suspensão do provedor é da linha dele, acima de qualquer escopo.
    await db('tenants').where({ id: gama.tenant.id }).update({ suspended_at: daqui(-25) });
  }

  // Alfa: pago, pago, pago, e a do próximo período em aberto no gateway.
  const alfaRenova = new Date((await Subscription.forTenant(alfa.tenant.id)).renews_at);
  await historicoPago(alfa.tenant.id, {
    renovaEm: alfaRenova, meses: 3, valor: planoEssencial.price_cents, planId: planoEssencial.id, prefixo: 'alfa'
  });
  await garantirCobranca(alfa.tenant.id, {
    period_end: dia(alfaRenova),
    amount_cents: planoEssencial.price_cents,
    status: 'pending',
    due_date: dia(alfaRenova),
    gateway_charge_id: 'pay_demo_alfa_open',
    plan_id: planoEssencial.id,
    billing_cycle: 'monthly'
  });

  // Beta: pagou dois meses e a renovação venceu.
  const betaRenova = new Date((await Subscription.forTenant(beta.tenant.id)).renews_at);
  await historicoPago(beta.tenant.id, {
    renovaEm: betaRenova, meses: 2, valor: planoProfissional.price_cents, planId: planoProfissional.id, prefixo: 'beta'
  });
  await garantirCobranca(beta.tenant.id, {
    period_end: dia(betaRenova),
    amount_cents: planoProfissional.price_cents,
    status: 'overdue',
    due_date: dia(betaRenova),
    gateway_charge_id: 'pay_demo_beta_overdue',
    plan_id: planoProfissional.id,
    billing_cycle: 'monthly'
  });

  // Gama: a anuidade venceu há 40 dias.
  const gamaRenova = new Date((await Subscription.forTenant(gama.tenant.id)).renews_at);
  await garantirCobranca(gama.tenant.id, {
    period_end: dia(gamaRenova),
    amount_cents: planoEssencial.price_yearly_cents,
    status: 'overdue',
    due_date: dia(gamaRenova),
    gateway_charge_id: 'pay_demo_gama_overdue',
    plan_id: planoEssencial.id,
    billing_cycle: 'annual'
  });

  // O cancelamento agendado da Gama, como `CancellationService.confirm` o grava.
  await runInTenant(gama.tenant.id, async () => {
    // tenant-scope-exempt: por id do provedor explícito, dentro do escopo dele.
    const ja = await db('cancellation_requests').where({ tenant_id: gama.tenant.id }).first();
    if (ja) return;
    const subscription = await Subscription.forTenant(gama.tenant.id);
    await tinsertReturningId('cancellation_requests', {
      reason: 'too_expensive',
      comment: 'Demonstração: o preço subiu e a operação encolheu.',
      offers_presented: 'discount,pause',
      offer: null,
      outcome: 'canceled',
      billing_cycle: 'annual',
      cancel_at: subscription.cancel_at ?? daqui(30),
      created_by: gama.usuario.id,
      created_at: daqui(-2),
      decided_at: daqui(-2)
    });
  });

  // O alerta que falhou: o "Reenviar" do histórico tem o que reenviar.
  await runUnscoped('the demo seed writes the platform alert queue, which sits above every provider', async () => {
    const chave = 'seed-demo:card_refused:beta-net';
    if (await db('platform_alerts').where({ dedupe_key: chave }).first()) return;
    await db('platform_alerts').insert({
      event: 'card_refused',
      tenant_id: beta.tenant.id,
      payload: JSON.stringify({ provider: beta.tenant.name, slug: beta.tenant.slug, reason: 'saldo insuficiente' }),
      dedupe_key: chave,
      status: 'failed',
      attempts: 5,
      next_attempt_at: null,
      last_error: 'send_failed',
      sent_at: null,
      created_at: daqui(-1)
    });
  });

  console.log('Demo data ready:');
  for (const spec of DEMO_PROVIDERS) {
    const { tenant, novo } = provedores[spec.slug];
    console.log(`  ${tenant.name} (${tenant.slug}, id ${tenant.id})${novo ? '' : ' — already there'}: login ${spec.owner.email}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`seed-demo failed: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
