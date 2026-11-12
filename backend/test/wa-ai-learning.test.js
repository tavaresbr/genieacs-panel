import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaAiLearningService, lerSugestoes, validarSugestao } = await import('../src/services/waAiLearningService.js');
const { default: WaAiClient } = await import('../src/services/waAiClient.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');

let account;
let contador = 0;
const chamadas = [];
let resposta = '[]';
const chatOriginal = WaAiClient.chat;

before(async () => {
  await startTestServers();
  account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-aprende', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-aprende'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-aprende')
  }));
  await asTenant(() => WaBotConfigService.saveConfig({ ai: { enabled: true, apiKey: 'chave-de-teste-da-ia' } }));
  WaAiClient.chat = async (pedido) => { chamadas.push(pedido); return { content: resposta, toolCalls: [] }; };
});

after(async () => {
  WaAiClient.chat = chatOriginal;
  await stopTestServers();
});

beforeEach(() => { chamadas.length = 0; resposta = '[]'; });

const venda = async ({ outcome = 'lost', reason = 'price', falas = null } = {}) => {
  contador += 1;
  const c = await asTenant(() => WaConversation.ensure({
    accountId: account.id, externalThreadId: `55939812${String(contador).padStart(4, '0')}@s.whatsapp.net`,
    waPhone: `55939812${String(contador).padStart(4, '0')}`, waLid: null, pushName: 'Cliente'
  }));
  await getDb()('wa_conversations').where({ id: c.id }).update({ lead_at: new Date(), lead_outcome: outcome, lead_lost_reason: outcome === 'lost' ? reason : null });
  const roteiro = falas ?? [['in', 'achei caro, meu vizinho paga menos'], ['out', 'Entendo! O plano inclui Wi-Fi 6.'], ['in', 'meu CPF é 123.456.789-09 se quiser olhar']];
  for (const [direcao, corpo] of roteiro) {
    // eslint-disable-next-line no-await-in-loop
    await getDb()('wa_messages').insert({ tenant_id: c.tenant_id, conversation_id: c.id, direction: direcao, body: corpo, is_note: false, created_at: new Date() });
  }
  return c;
};
const pendentes = () => getDb()('wa_ai_knowledge').where({ origin: 'sugerida' });
const JSON_OK = JSON.stringify([
  { kind: 'objecao', title: 'Vizinho paga menos', triggers: 'vizinho, mais barato', answer: 'Compare o que o plano inclui; [preencha a condição real].' },
  { kind: 'faq', title: 'Tem fidelidade?', triggers: 'fidelidade', answer: 'Descreva sua regra.' }
]);

describe('o parser e a validação das sugestões', () => {
  it('lê JSON com cerca ou texto em volta; lixo vira vazio', () => {
    assert.equal(lerSugestoes('```json\n[{"a":1}]\n```').length, 1);
    assert.deepEqual(lerSugestoes('não sei'), []);
    assert.deepEqual(lerSugestoes('[quebrado'), []);
    assert.deepEqual(lerSugestoes('{"a":1}'), []);
  });
  it('recusa tipo desconhecido, sem título ou resposta; limita tamanhos', () => {
    assert.equal(validarSugestao({ kind: 'preco', title: 'a', answer: 'b' }), null);
    assert.equal(validarSugestao({ kind: 'faq', title: '', answer: 'b' }), null);
    assert.equal(validarSugestao({ kind: 'faq', title: 'a', answer: '' }), null);
    assert.equal(validarSugestao(null), null);
    const v = validarSugestao({ kind: 'vantagem', title: 'a'.repeat(300), triggers: 'x', answer: 'b'.repeat(900) });
    assert.equal(v.title.length, 120);
    assert.equal(v.answer.length, 600);
    assert.equal(v.triggers, null, 'vantagem não tem gatilho');
  });
});

describe('aprovar uma sugestão', () => {
  it('com espaço a preencher entre colchetes não ativa; editada, sim', async () => {
    resposta = JSON.stringify([{ kind: 'objecao', title: 'Preço do concorrente', triggers: 'concorrente', answer: 'Compare o que inclui; [preencha a condição real].' }]);
    const c = await venda();
    await asTenant(() => WaAiLearningService.sugerir(c.id));
    const { default: WaAiKnowledgeService } = await import('../src/services/waAiKnowledgeService.js');
    const alvo = (await pendentes()).find((l) => /\[/.test(l.answer));
    assert.ok(alvo, 'a sugestão traz um espaço a preencher');
    await assert.rejects(asTenant(() => WaAiKnowledgeService.update(alvo.id, { active: true })), { code: 'ai_knowledge_placeholder' });
    const aprovada = await asTenant(() => WaAiKnowledgeService.update(alvo.id, { answer: 'Compare o que o plano inclui, sem fidelidade.', active: true }));
    assert.equal(aprovada.active, true);
    assert.equal(aprovada.origin, 'sugerida', 'continua marcada como vinda da IA');
    await assert.rejects(asTenant(() => WaAiKnowledgeService.create({ kind: 'faq', title: 'Prazo', answer: 'Instalamos em [N] dias.' })), { code: 'ai_knowledge_placeholder' });
  });
});

describe('sugerir itens para a base depois da venda', () => {
  it('grava sugestões inativas, marcadas como sugeridas, sem mudar o que a IA diz', async () => {
    resposta = JSON_OK;
    const c = await venda();
    const antes = (await pendentes()).length;
    assert.equal(await asTenant(() => WaAiLearningService.sugerir(c.id)), 2);
    const linhas = (await pendentes()).filter((l) => ['Vizinho paga menos', 'Tem fidelidade?'].includes(l.title));
    assert.equal((await pendentes()).length, antes + 2);
    assert.equal(linhas.length, 2);
    assert.ok(linhas.every((l) => !l.active && l.origin === 'sugerida'));
    const { default: WaAiKnowledgeService } = await import('../src/services/waAiKnowledgeService.js');
    const texto = await asTenant(() => WaAiKnowledgeService.paraPrompt('vizinho mais barato fidelidade'));
    assert.doesNotMatch(texto, /Vizinho paga menos/, 'nada entra no prompt sem aprovação');
  });

  it('CPF e PIX saem da conversa antes de ir à IA, e o desfecho vai junto', async () => {
    resposta = '[]';
    const c = await venda({ reason: 'competitor' });
    await asTenant(() => WaAiLearningService.sugerir(c.id));
    assert.equal(chamadas.length, 1);
    const enviado = chamadas[0].messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(enviado, /123\.456\.789-09/);
    assert.match(enviado, /\[documento omitido\]/);
    assert.match(enviado, /PERDEU por um concorrente/);
    assert.equal(chamadas[0].tools, undefined, 'sem ferramentas');
  });

  it('uma chamada só por venda, mesmo se encerrar de novo', async () => {
    resposta = JSON_OK;
    const c = await venda();
    await asTenant(() => WaAiLearningService.sugerir(c.id));
    await asTenant(() => WaAiLearningService.sugerir(c.id));
    assert.equal(chamadas.length, 1);
  });

  it('não repete título já cadastrado; ignora item inválido; no máximo três', async () => {
    resposta = JSON.stringify([
      { kind: 'faq', title: 'tem fidelidade?', answer: 'repetido do teste anterior' },
      { kind: 'xyz', title: 'Tipo ruim', answer: 'a' },
      { kind: 'vantagem', title: 'Instalação ágil', answer: 'Preencha o prazo real.' },
      { kind: 'vantagem', title: 'Suporte local', answer: 'b' },
      { kind: 'vantagem', title: 'Rede em fibra', answer: 'c' },
      { kind: 'vantagem', title: 'Quarta', answer: 'd' }
    ]);
    const c = await venda({ outcome: 'won' });
    const antes = (await pendentes()).length;
    const gravadas = await asTenant(() => WaAiLearningService.sugerir(c.id));
    assert.equal(gravadas, 3, 'o repetido e o inválido caem; para na terceira válida');
    assert.equal((await pendentes()).length, antes + 3);
  });

  it('não gasta chamada sem resultado, sem IA ligada ou com conversa vazia', async () => {
    const semResultado = await venda();
    await getDb()('wa_conversations').where({ id: semResultado.id }).update({ lead_outcome: null });
    assert.equal(await asTenant(() => WaAiLearningService.sugerir(semResultado.id)), 0);
    const vazia = await venda({ falas: [['in', 'oi']] });
    assert.equal(await asTenant(() => WaAiLearningService.sugerir(vazia.id)), 0);
    assert.equal(chamadas.length, 0);

    await asTenant(() => WaBotConfigService.saveConfig({ ai: { enabled: false, suggest: false } }));
    const c = await venda();
    assert.equal(await asTenant(() => WaAiLearningService.sugerir(c.id)), 0);
    assert.equal(chamadas.length, 0);
    await asTenant(() => WaBotConfigService.saveConfig({ ai: { enabled: true } }));
  });

  it('falha da IA ou resposta quebrada nunca lança', async () => {
    WaAiClient.chat = async () => { throw new Error('fora do ar'); };
    const c = await venda();
    assert.equal(await asTenant(() => WaAiLearningService.sugerir(c.id)), 0);
    WaAiClient.chat = async (pedido) => { chamadas.push(pedido); return { content: 'não é json', toolCalls: [] }; };
    const d = await venda();
    assert.equal(await asTenant(() => WaAiLearningService.sugerir(d.id)), 0);
  });
});
void WaMessage;
