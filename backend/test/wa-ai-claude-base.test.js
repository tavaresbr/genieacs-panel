import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { AI_ADAPTERS } = await import('../src/services/waAiAdapters.js');
const { modeloDaTarefa, prepararFio } = await import('../src/services/waAiService.js');
const { default: WaAiUsageService } = await import('../src/services/waAiUsageService.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');

const img = { type: 'image', mediaType: 'image/png', data: 'AAAA' };

describe('Claude: cache de prompt e partes', () => {
  const sistema = {
    role: 'system',
    content: [{ text: 'REGRAS', cache: true }, { text: 'VARIÁVEL' }]
  };

  it('Anthropic: sistema vira blocos com cache_control só onde marcado', () => {
    const { body } = AI_ADAPTERS.anthropic.buildRequest({
      apiKey: 'k', model: 'claude-sonnet-5-5', maxTokens: 100,
      messages: [sistema, { role: 'user', content: 'oi' }]
    });
    assert.deepEqual(body.system, [
      { type: 'text', text: 'REGRAS', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'VARIÁVEL' }
    ]);
  });

  it('Anthropic: sem ponto de cache o sistema segue string', () => {
    const { body } = AI_ADAPTERS.anthropic.buildRequest({
      apiKey: 'k', model: 'claude-sonnet-5-5', maxTokens: 100,
      messages: [{ role: 'system', content: 'Seja breve.' }, { role: 'user', content: 'oi' }]
    });
    assert.equal(body.system, 'Seja breve.');
  });

  it('Anthropic: imagem do cliente vira bloco base64', () => {
    const { body } = AI_ADAPTERS.anthropic.buildRequest({
      apiKey: 'k', model: 'claude-sonnet-5-5', maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'olha' }, img] }]
    });
    const blocos = body.messages[0].content;
    assert.equal(blocos[0].text, 'olha');
    assert.deepEqual(blocos[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  });

  it('OpenAI: partes viram texto único e nada de imagem vaza', () => {
    const { body } = AI_ADAPTERS['openai-compatible'].buildRequest({
      apiKey: 'k', model: 'm', maxTokens: 100,
      messages: [sistema, { role: 'user', content: [{ type: 'text', text: 'olha' }, img] }]
    });
    assert.equal(typeof body.messages[0].content, 'string');
    assert.match(body.messages[0].content, /REGRAS[\s\S]*VARIÁVEL/);
    assert.equal(typeof body.messages[1].content, 'string');
    assert.doesNotMatch(JSON.stringify(body), /AAAA/);
  });

  it('usage é lido nos dois formatos', () => {
    const a = AI_ADAPTERS.anthropic.parse({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 3 }
    });
    assert.deepEqual(a.usage, { input: 10, output: 5, cacheRead: 90, cacheWrite: 3 });
    const o = AI_ADAPTERS['openai-compatible'].parse({
      choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 7, completion_tokens: 2 }
    });
    assert.equal(o.usage.input, 7);
    assert.equal(o.usage.output, 2);
  });

  it('prepararFio aceita partes e funde turnos do mesmo papel', () => {
    const fio = prepararFio([
      { role: 'user', content: 'oi' },
      { role: 'user', content: [{ type: 'text', text: 'foto' }, img] }
    ]);
    assert.equal(fio.length, 1);
    assert.ok(Array.isArray(fio[0].content));
    assert.ok(fio[0].content.some((p) => p.type === 'image'));
  });
});

describe('Claude: modelo rápido', () => {
  it('só tarefas simples usam fastModel', () => {
    const ai = { model: 'grande', fastModel: 'pequeno' };
    assert.equal(modeloDaTarefa(ai, 'resumo'), 'pequeno');
    assert.equal(modeloDaTarefa(ai, 'classificar'), 'pequeno');
    assert.equal(modeloDaTarefa(ai, 'conversa'), 'grande');
    assert.equal(modeloDaTarefa({ model: 'grande', fastModel: '' }, 'resumo'), 'grande');
  });
});

describe('Claude: uso por tarefa', () => {
  before(startTestServers);
  after(stopTestServers);

  it('soma chamadas e tokens por dia/tarefa/modelo e calcula o cache', async () => {
    await asTenant(async () => {
      await getDb()('wa_ai_usage').del();
      const uso = { input: 100, output: 20, cacheRead: 300, cacheWrite: 0 };
      await WaAiUsageService.registrar({ task: 'conversa', model: 'm1', usage: uso });
      await WaAiUsageService.registrar({ task: 'conversa', model: 'm1', usage: uso });
      await WaAiUsageService.registrar({ task: 'inexistente', model: 'm1', usage: uso });
      await WaAiUsageService.registrar({ task: 'resumo', model: 'm1', usage: null });
      const r = await WaAiUsageService.resumo({ days: 30 });
      const conversa = r.tasks.find((t) => t.task === 'conversa');
      assert.equal(conversa.calls, 2);
      assert.equal(conversa.inputTokens, 200);
      assert.equal(r.tasks.find((t) => t.task === 'outro').calls, 1);
      assert.equal(r.tasks.find((t) => t.task === 'resumo'), undefined);
      assert.equal(r.cacheHitRate, 75);
    });
  });

  it('ai.fastModel é validado na configuração', async () => {
    await asTenant(async () => {
      await WaBotConfigService.saveConfig({ ai: { fastModel: '  claude-haiku-5-5 ' } });
      assert.equal((await WaBotConfigService.getConfig()).ai.fastModel, 'claude-haiku-5-5');
      await assert.rejects(() => WaBotConfigService.saveConfig({ ai: { fastModel: 'x'.repeat(200) } }), { code: 'invalid_bot_ai' });
      assert.equal((await WaBotConfigService.getConfig()).ai.fastModel, 'claude-haiku-5-5');
    });
  });
});
