import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaAiKnowledgeService } = await import('../src/services/waAiKnowledgeService.js');
const { escolherConhecimento, blocoCobertura, limparLugares, limparCobertura, nomesDoLugar, lerGatilhos, normalizar, EXEMPLOS } = await import('../src/utils/wa/conhecimento.js');

before(async () => { await startTestServers(); });
after(async () => { await stopTestServers(); });

const item = (kind, title, answer, triggers = '', active = true) => ({ id: title, kind, title, answer, triggers, active });

describe('o que entra na conversa', () => {
  const base = [
    item('vantagem', 'Suporte', 'Atendemos todos os dias.'),
    item('objecao', 'Acha caro', 'O plano inclui Wi-Fi 6.', 'caro, preço alto'),
    item('objecao', 'Cai', 'Rede em fibra monitorada.', 'cai, instável'),
    item('faq', 'Fidelidade', 'Sem fidelidade.', 'fidelidade', false)
  ];
  it('vantagens sempre; objeção só com o gatilho (sem ligar para acento ou caixa)', () => {
    const sem = escolherConhecimento(base, 'oi, quero internet');
    assert.deepEqual(sem.itens.map((i) => i.title), ['Suporte']);
    const com = escolherConhecimento(base, 'achei o PREÇO alto demais');
    assert.deepEqual(com.itens.map((i) => i.title), ['Acha caro', 'Suporte'], 'o que combina vem antes');
    assert.deepEqual(com.usados.map((i) => i.title), ['Acha caro']);
    assert.match(com.texto, /não invente nada além disso/);
  });
  it('item inativo nunca entra, mesmo com o gatilho', () => {
    assert.ok(!escolherConhecimento(base, 'tem fidelidade?').itens.some((i) => i.title === 'Fidelidade'));
  });
  it('respeita o limite de tamanho', () => {
    const grande = [item('vantagem', 'A', 'x'.repeat(900)), item('vantagem', 'B', 'y'.repeat(900)), item('vantagem', 'C', 'curta')];
    const { itens } = escolherConhecimento(grande, '', 1500);
    assert.deepEqual(itens.map((i) => i.title), ['A', 'C']);
  });
  it('sem nada ativo, texto vazio', () => {
    assert.equal(escolherConhecimento([], 'caro').texto, '');
  });
  it('gatilhos e lugares são limpos', () => {
    assert.deepEqual(lerGatilhos(' Caro , preço  Alto,, a '), ['caro', 'preco alto']);
    assert.equal(normalizar('  Não  Está '), 'nao esta');
    assert.deepEqual(limparLugares(['Itaituba', ' itaituba ', '', 'Moraes  Almeida']), ['Itaituba', 'Moraes Almeida']);
    assert.equal(limparLugares('x'), null);
    assert.equal(blocoCobertura([]), '');
    assert.match(blocoCobertura(['Itaituba']), /Itaituba.*NÃO está nesta lista.*transferir_para_atendente/s);
  });
});

describe('a cobertura com apelidos', () => {
  it('aceita o formato antigo (texto) e o novo, sem repetir nome nem apelido', () => {
    assert.deepEqual(limparCobertura(['Itaituba', ' itaituba ', 'Moraes Almeida']), [
      { name: 'Itaituba', aliases: [] }, { name: 'Moraes Almeida', aliases: [] }
    ]);
    const lista = limparCobertura([
      { name: 'Jardim das Araras', aliases: ['Araras', ' jd. araras ', 'ARARAS', 'Jardim das Araras', ''] },
      { name: 'Centro', aliases: ['Araras', 'Centrão'] },
      'Miritituba'
    ]);
    assert.deepEqual(lista, [
      { name: 'Jardim das Araras', aliases: ['Araras', 'jd. araras'] },
      { name: 'Centro', aliases: ['Centrão'] },
      { name: 'Miritituba', aliases: [] }
    ], 'um apelido não é repetido em outro lugar, nem repete o nome');
    assert.equal(limparCobertura('x'), null);
    assert.deepEqual(nomesDoLugar(lista[0]), ['Jardim das Araras', 'Araras', 'jd. araras']);
    assert.deepEqual(nomesDoLugar('Itaituba'), ['Itaituba']);
  });
  it('limita o tamanho: 100 lugares, 10 apelidos de 80 caracteres', () => {
    const muitos = Array.from({ length: 150 }, (_, i) => ({ name: `Lugar ${i}` }));
    assert.equal(limparCobertura(muitos).length, 100);
    const [um] = limparCobertura([{ name: 'A', aliases: Array.from({ length: 15 }, (_, i) => `apelido ${i}`.padEnd(120, 'x')) }]);
    assert.equal(um.aliases.length, 10);
    assert.ok(um.aliases.every((a) => a.length <= 80));
  });
  it('o prompt lista os apelidos; sem apelido a linha é a de sempre', () => {
    assert.match(blocoCobertura([{ name: 'Itaituba', aliases: ['Itaitu', 'ITB'] }, { name: 'Moraes Almeida', aliases: [] }]),
      /Itaituba \(também: Itaitu, ITB\), Moraes Almeida\./);
    assert.match(blocoCobertura(['Itaituba', 'Moraes Almeida']), /Lugares atendidos pela empresa: Itaituba, Moraes Almeida\./);
  });
});

describe('a base do provedor', () => {
  it('nasce com os exemplos desativados, e só uma vez', async () => {
    const lista = await asTenant(() => WaAiKnowledgeService.list());
    assert.equal(lista.length, EXEMPLOS.length);
    assert.ok(lista.every((i) => !i.active && i.origin === 'exemplo'));
    const de_novo = await asTenant(() => WaAiKnowledgeService.list());
    assert.equal(de_novo.length, EXEMPLOS.length, 'não semeia de novo');
  });

  it('exemplo não ativa sem editar; editado vira do operador e pode valer', async () => {
    const [exemplo] = (await asTenant(() => WaAiKnowledgeService.list())).filter((i) => i.title === 'Acha caro');
    await assert.rejects(asTenant(() => WaAiKnowledgeService.update(exemplo.id, { active: true })), { code: 'ai_knowledge_example_unedited' });
    const editado = await asTenant(() => WaAiKnowledgeService.update(exemplo.id, { answer: 'Nosso plano inclui Wi-Fi 6 e suporte.', active: true }));
    assert.equal(editado.origin, 'manual');
    assert.equal(editado.active, true);
    const texto = await asTenant(() => WaAiKnowledgeService.paraPrompt('acho caro'));
    assert.match(texto, /Nosso plano inclui Wi-Fi 6/);
    assert.doesNotMatch(texto, /Descreva aqui/);
  });

  it('cria, valida e apaga', async () => {
    const criado = await asTenant(() => WaAiKnowledgeService.create({ kind: 'vantagem', title: '  Instalação   rápida ', answer: 'Instalamos em até 48 h.' }));
    assert.equal(criado.title, 'Instalação rápida');
    assert.equal(criado.active, true);
    assert.equal(criado.origin, 'manual');
    await assert.rejects(asTenant(() => WaAiKnowledgeService.create({ kind: 'x', title: 'a', answer: 'b' })), { code: 'ai_knowledge_kind_invalid' });
    await assert.rejects(asTenant(() => WaAiKnowledgeService.create({ kind: 'faq', title: '', answer: 'b' })), { code: 'ai_knowledge_title_required' });
    await assert.rejects(asTenant(() => WaAiKnowledgeService.create({ kind: 'faq', title: 'a', answer: '' })), { code: 'ai_knowledge_answer_required' });
    await assert.rejects(asTenant(() => WaAiKnowledgeService.create({ kind: 'faq', title: 'a', answer: 'z'.repeat(601) })), { code: 'ai_knowledge_answer_too_long' });
    await asTenant(() => WaAiKnowledgeService.remove(criado.id));
    await assert.rejects(asTenant(() => WaAiKnowledgeService.remove(criado.id)), { code: 'ai_knowledge_not_found' });
    await assert.rejects(asTenant(() => WaAiKnowledgeService.update(criado.id, { title: 'x' })), { code: 'ai_knowledge_not_found' });
  });
});
