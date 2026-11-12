import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaSalesPlanService } = await import('../src/services/waSalesPlanService.js');
const { escolherPlanos, perfilDoCliente, descreverPlano, reais, cidadesDoPlano, planoVaiNaCidade, planosDaCidade, variaPorCidade } = await import('../src/utils/wa/planosVenda.js');

before(async () => { await startTestServers(); });
after(async () => { await stopTestServers(); });

const plano = (name, profile, price_cents, extra = {}) => ({ name, profile, price_cents, active: true, ...extra });
const CATALOGO = [
  plano('Essencial', 'economico', 6990),
  plano('Família', 'equilibrado', 8990),
  plano('Gamer', 'premium', 12990),
  plano('Giga', 'premium', 19990, { active: false }),
  plano('Sem preço', 'equilibrado', null)
];

describe('escolher no máximo dois planos', () => {
  it('quem quer economizar vê o econômico e o equilibrado', () => {
    assert.deepEqual(escolherPlanos(CATALOGO, 'economico').map((p) => p.name), ['Essencial', 'Família']);
  });
  it('quem quer qualidade vê o premium e o equilibrado', () => {
    assert.deepEqual(escolherPlanos(CATALOGO, 'qualidade').map((p) => p.name), ['Gamer', 'Família']);
  });
  it('equilibrado vê o equilibrado e o premium', () => {
    assert.deepEqual(escolherPlanos(CATALOGO, 'equilibrado').map((p) => p.name), ['Família', 'Gamer']);
  });
  it('sem perfil: o plano de entrada e o equilibrado', () => {
    assert.deepEqual(escolherPlanos(CATALOGO, null).map((p) => p.name), ['Essencial', 'Família']);
  });
  it('nunca devolve plano inativo, sem preço, nem mais de dois', () => {
    for (const perfil of ['economico', 'equilibrado', 'qualidade', null, 'lixo']) {
      const nomes = escolherPlanos(CATALOGO, perfil).map((p) => p.name);
      assert.ok(nomes.length <= 2);
      assert.ok(!nomes.includes('Giga') && !nomes.includes('Sem preço'));
    }
  });
  it('com um plano só, devolve um; sem nenhum, nada', () => {
    assert.equal(escolherPlanos([plano('Único', 'premium', 9900)], 'economico').length, 1);
    assert.deepEqual(escolherPlanos([], 'economico'), []);
    assert.deepEqual(escolherPlanos([plano('Sem preço', 'economico', null)], null), []);
  });
  it('sem o perfil pedido, cai no vizinho', () => {
    const so = [plano('Família', 'equilibrado', 8990), plano('Gamer', 'premium', 12990)];
    assert.deepEqual(escolherPlanos(so, 'economico').map((p) => p.name), ['Família', 'Gamer']);
  });
  it('perfil do cliente e texto do plano', () => {
    assert.equal(perfilDoCliente('qualidade'), 'premium');
    assert.equal(perfilDoCliente('x'), null);
    assert.equal(reais(8990), 'R$ 89,90');
    assert.equal(descreverPlano({ ...CATALOGO[1], speed_mbps: 300, includes: 'Wi-Fi 6' }), 'Família — 300 Mega — R$ 89,90 por mês — inclui: Wi-Fi 6');
  });
});

describe('o catálogo do provedor', () => {
  it('cria, edita, valida, recusa duplicado e apaga', async () => {
    const criado = await asTenant(() => WaSalesPlanService.create({
      name: '  Fibra   Família ', speedMbps: 300, priceCents: 8990, includes: 'Wi-Fi 6', profile: 'equilibrado'
    }));
    assert.equal(criado.name, 'Fibra Família');
    assert.equal(criado.priceCents, 8990);
    assert.equal(criado.active, true);

    await assert.rejects(asTenant(() => WaSalesPlanService.create({ name: 'Fibra Família' })), { code: 'sales_plan_duplicate' });
    await assert.rejects(asTenant(() => WaSalesPlanService.create({ name: '' })), { code: 'sales_plan_name_required' });
    await assert.rejects(asTenant(() => WaSalesPlanService.create({ name: 'X', priceCents: -5 })), { code: 'sales_plan_price_invalid' });
    await assert.rejects(asTenant(() => WaSalesPlanService.create({ name: 'Y', profile: 'vip' })), { code: 'sales_plan_profile_invalid' });

    const editado = await asTenant(() => WaSalesPlanService.update(criado.id, { priceCents: 9990, active: false }));
    assert.equal(editado.priceCents, 9990);
    assert.equal(editado.active, false);
    assert.equal(editado.name, 'Fibra Família', 'o que não veio fica como estava');

    assert.equal(await asTenant(() => WaSalesPlanService.contarOfereciveis()), 0, 'inativo não conta');
    await asTenant(() => WaSalesPlanService.update(criado.id, { active: true }));
    assert.equal(await asTenant(() => WaSalesPlanService.contarOfereciveis()), 1);
    assert.deepEqual((await asTenant(() => WaSalesPlanService.paraIa('economico'))).planos.map((p) => p.name), ['Fibra Família']);

    await asTenant(() => WaSalesPlanService.remove(criado.id));
    await assert.rejects(asTenant(() => WaSalesPlanService.update(criado.id, { name: 'Z' })), { code: 'sales_plan_not_found' });
    await assert.rejects(asTenant(() => WaSalesPlanService.remove(criado.id)), { code: 'sales_plan_not_found' });
  });
});

describe('planos por cidade', () => {
  it('sem cidade marcada vale para todas; com cidades, só para elas (sem acento, com sobrenome)', () => {
    const todas = { name: 'A', cities: null };
    const so = { name: 'B', cities: JSON.stringify(['Itaituba', 'Moraes Almeida']) };
    assert.deepEqual(cidadesDoPlano(todas), []);
    assert.deepEqual(cidadesDoPlano(so), ['Itaituba', 'Moraes Almeida']);
    assert.deepEqual(cidadesDoPlano({ cities: 'quebrado' }), []);
    assert.equal(planoVaiNaCidade(todas, 'Qualquer lugar'), true);
    assert.equal(planoVaiNaCidade(so, 'itaituba'), true);
    assert.equal(planoVaiNaCidade(so, 'ITAITUBÁ-PA'), true);
    assert.equal(planoVaiNaCidade(so, 'centro de Itaituba'), true);
    assert.equal(planoVaiNaCidade(so, 'Santarém'), false);
    assert.equal(planoVaiNaCidade(so, ''), false);
    assert.deepEqual(planosDaCidade([todas, so], 'Santarém').map((p) => p.name), ['A']);
    assert.equal(variaPorCidade([todas]), false);
    assert.equal(variaPorCidade([todas, so]), true);
  });

  it('o catálogo guarda as cidades e a IA só recebe os planos do lugar', async () => {
    const a = await asTenant(() => WaSalesPlanService.create({ name: 'Fibra Itaituba', priceCents: 8990, profile: 'equilibrado', cities: ['Itaituba', ' itaituba ', 'Miritituba'] }));
    assert.deepEqual(a.cities, ['Itaituba', 'Miritituba'], 'limpo e sem repetido');
    const b = await asTenant(() => WaSalesPlanService.create({ name: 'Rádio Moraes', priceCents: 5990, profile: 'economico', cities: ['Moraes Almeida'] }));
    const c = await asTenant(() => WaSalesPlanService.create({ name: 'Essencial Todas', priceCents: 6990, profile: 'economico' }));
    assert.deepEqual(c.cities, []);
    try {
      const sem = await asTenant(() => WaSalesPlanService.paraIa('economico', null));
      assert.equal(sem.precisaCidade, true, 'há plano que varia por cidade: precisa saber onde mora');
      assert.deepEqual(sem.planos, []);
      const it = await asTenant(() => WaSalesPlanService.paraIa('economico', 'Itaituba'));
      assert.deepEqual(it.planos.map((p) => p.name).sort(), ['Essencial Todas', 'Fibra Itaituba']);
      const mo = await asTenant(() => WaSalesPlanService.paraIa('economico', 'Moraes Almeida'));
      assert.deepEqual(mo.planos.map((p) => p.name).sort(), ['Essencial Todas', 'Rádio Moraes']);
      const fora = await asTenant(() => WaSalesPlanService.paraIa('economico', 'Santarém'));
      assert.deepEqual(fora.planos.map((p) => p.name), ['Essencial Todas'], 'só o plano de todas as cidades');
      await assert.rejects(asTenant(() => WaSalesPlanService.update(a.id, { cities: 'Itaituba' })), { code: 'sales_plan_cities_invalid' });
      const limpo = await asTenant(() => WaSalesPlanService.update(a.id, { cities: [] }));
      assert.deepEqual(limpo.cities, [], 'sem nenhuma volta a valer para todas');
    } finally {
      for (const p of [a, b, c]) await asTenant(() => WaSalesPlanService.remove(p.id));
    }
  });
});

describe('planos por cidade com apelidos', () => {
  const cobertura = [
    { name: 'Jardim das Araras', aliases: ['Araras', 'Jd. Araras'] },
    { name: 'Itaituba', aliases: [] }
  ];
  const plano = { name: 'Rádio Araras', cities: JSON.stringify(['Jardim das Araras']) };

  it('o plano marcado num lugar vale para o nome e para os apelidos dele', () => {
    assert.equal(planoVaiNaCidade(plano, 'Jardim das Araras', cobertura), true);
    assert.equal(planoVaiNaCidade(plano, 'Araras', cobertura), true);
    assert.equal(planoVaiNaCidade(plano, 'jd araras', cobertura), true, 'contém o apelido Araras');
    assert.equal(planoVaiNaCidade(plano, 'Jd. Araras', cobertura), true);
    assert.equal(planoVaiNaCidade(plano, 'moro no Jd. Araras, perto da escola', cobertura), true);
    assert.equal(planoVaiNaCidade(plano, 'Itaituba', cobertura), false);
    assert.equal(planoVaiNaCidade(plano, 'Jd. Araras', []), false, 'sem a cobertura, só o nome marcado vale');
    assert.deepEqual(planosDaCidade([plano, { name: 'Todas' }], 'Araras', cobertura).map((p) => p.name), ['Rádio Araras', 'Todas']);
  });

  it('a IA recebe o plano quando o cliente usa um apelido da cobertura salva', async () => {
    const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
    const criado = await asTenant(() => WaSalesPlanService.create({ name: 'Rádio Araras', priceCents: 5990, profile: 'economico', cities: ['Jardim das Araras'] }));
    try {
      await asTenant(() => WaBotConfigService.saveConfig({ ai: { coverage: ['Itaituba', { name: 'Jardim das Araras', aliases: ['Araras'] }] } }));
      const { ai } = await asTenant(() => WaBotConfigService.getConfig());
      assert.deepEqual(ai.coverage[1], { name: 'Jardim das Araras', aliases: ['Araras'] });
      const comApelido = await asTenant(() => WaSalesPlanService.paraIa('economico', 'Araras'));
      assert.deepEqual(comApelido.planos.map((p) => p.name), ['Rádio Araras']);
      const fora = await asTenant(() => WaSalesPlanService.paraIa('economico', 'Itaituba'));
      assert.deepEqual(fora.planos, [], 'o plano é só do Jardim das Araras');
    } finally {
      await asTenant(() => WaBotConfigService.saveConfig({ ai: { coverage: [] } }));
      await asTenant(() => WaSalesPlanService.remove(criado.id));
    }
  });
});
