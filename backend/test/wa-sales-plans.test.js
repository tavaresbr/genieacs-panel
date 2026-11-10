import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaSalesPlanService } = await import('../src/services/waSalesPlanService.js');
const { escolherPlanos, perfilDoCliente, descreverPlano, reais } = await import('../src/utils/wa/planosVenda.js');

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
    assert.deepEqual((await asTenant(() => WaSalesPlanService.paraIa('economico'))).map((p) => p.name), ['Fibra Família']);

    await asTenant(() => WaSalesPlanService.remove(criado.id));
    await assert.rejects(asTenant(() => WaSalesPlanService.update(criado.id, { name: 'Z' })), { code: 'sales_plan_not_found' });
    await assert.rejects(asTenant(() => WaSalesPlanService.remove(criado.id)), { code: 'sales_plan_not_found' });
  });
});
