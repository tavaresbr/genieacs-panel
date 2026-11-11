import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaConversationService } = await import('../src/services/waConversationService.js');
const { default: WaSalesPlanService } = await import('../src/services/waSalesPlanService.js');
const { default: WaSalesReportService } = await import('../src/services/waSalesReportService.js');

let account;
let plano;
let contador = 0;

before(async () => {
  await startTestServers();
  account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-lead', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-lead'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-lead')
  }));
  plano = await asTenant(() => WaSalesPlanService.create({ name: 'Fibra Família', priceCents: 8990, profile: 'equilibrado' }));
});

after(async () => { await stopTestServers(); });

/** Uma conversa aberta; `lead` a marca como venda entregue pela IA. */
const conversa = async ({ lead = true } = {}) => {
  contador += 1;
  const row = await asTenant(() => WaConversation.ensure({
    accountId: account.id, externalThreadId: `55939811500${contador}@s.whatsapp.net`,
    waPhone: `55939811500${contador}`, waLid: null, pushName: 'Cliente'
  }));
  if (lead) await getDb()('wa_conversations').where({ id: row.id }).update({ lead_at: new Date() });
  return row;
};
const encerrar = (id, lead) => asTenant(() => WaConversationService.setStatus(id, 'closed', { survey: false, lead }));
const lido = (id) => getDb()('wa_conversations').where({ id }).first();

describe('o resultado da venda ao encerrar', () => {
  it('fechou, com o plano: grava e a conversa encerra', async () => {
    const c = await conversa();
    const r = await encerrar(c.id, { outcome: 'won', planId: plano.id });
    assert.equal(r.leadOutcome, 'won');
    const linha = await lido(c.id);
    assert.equal(linha.lead_outcome, 'won');
    assert.equal(linha.lead_plan_id, plano.id);
    assert.ok(linha.closed_at);
  });

  it('perdeu, com o motivo', async () => {
    const c = await conversa();
    await encerrar(c.id, { outcome: 'lost', reason: 'price' });
    const linha = await lido(c.id);
    assert.equal(linha.lead_outcome, 'lost');
    assert.equal(linha.lead_lost_reason, 'price');
  });

  it('não sei, ou nada, encerra sem gravar', async () => {
    const a = await conversa();
    await encerrar(a.id, { outcome: 'unknown' });
    const b = await conversa();
    await encerrar(b.id, undefined);
    for (const c of [a, b]) {
      const linha = await lido(c.id);
      assert.equal(linha.lead_outcome, null);
      assert.ok(linha.closed_at);
    }
  });

  it('recusa o que não faz sentido, sem encerrar a conversa', async () => {
    const c = await conversa();
    const tenta = (lead, codigo) => assert.rejects(encerrar(c.id, lead), { code: codigo });
    await tenta({ outcome: 'talvez' }, 'lead_outcome_invalid');
    await tenta({ outcome: 'lost' }, 'lead_reason_invalid');
    await tenta({ outcome: 'lost', reason: 'preguiça' }, 'lead_reason_invalid');
    await tenta({ outcome: 'lost', reason: 'price', planId: plano.id }, 'lead_plan_only_when_won');
    await tenta({ outcome: 'won', reason: 'price' }, 'lead_reason_only_when_lost');
    await tenta({ outcome: 'won', planId: 999999 }, 'lead_plan_invalid');
    assert.equal((await lido(c.id)).closed_at, null, 'continua aberta');
  });

  it('conversa que não é venda recusa o resultado', async () => {
    const c = await conversa({ lead: false });
    await assert.rejects(encerrar(c.id, { outcome: 'won' }), { code: 'lead_not_a_sale' });
    await encerrar(c.id, undefined);
    assert.ok((await lido(c.id)).closed_at, 'encerra normalmente sem resultado');
  });
});

describe('o relatório de vendas', () => {
  it('conta leads, resultados, motivos, planos e a conversão; só do provedor', async () => {
    await getDb()('wa_conversations').update({ lead_at: null, lead_outcome: null, lead_lost_reason: null, lead_plan_id: null });
    const a = await conversa(); const b = await conversa(); const c = await conversa(); const d = await conversa();
    await encerrar(a.id, { outcome: 'won', planId: plano.id });
    await encerrar(b.id, { outcome: 'lost', reason: 'competitor' });
    await encerrar(c.id, { outcome: 'lost', reason: 'competitor' });
    void d;
    const r = await asTenant(() => WaSalesReportService.report({ days: 30 }));
    assert.equal(r.leads, 4);
    assert.equal(r.won, 1);
    assert.equal(r.lost, 2);
    assert.equal(r.open, 1);
    assert.equal(r.conversionRate, 25);
    assert.equal(r.lostReasons.competitor, 2);
    assert.equal(r.lostReasons.price, 0);
    assert.deepEqual(r.topPlans, [{ planId: plano.id, name: 'Fibra Família', sales: 1 }]);

    // Outro provedor não vê nada disto.
    const outro = await getDb()('tenants').orderBy('id', 'desc').first();
    const mesmo = await getDb()('tenants').orderBy('id', 'asc').first();
    if (outro.id !== mesmo.id) {
      const vazio = await runInTenant(outro.id, () => WaSalesReportService.report({ days: 30 }));
      assert.equal(vazio.leads, 0);
    }
  });

  it('período inválido vira 30; sem leads a conversão é nula', async () => {
    await getDb()('wa_conversations').update({ lead_at: null });
    const r = await asTenant(() => WaSalesReportService.report({ days: 5 }));
    assert.equal(r.days, 30);
    assert.equal(r.leads, 0);
    assert.equal(r.conversionRate, null);
  });
});
