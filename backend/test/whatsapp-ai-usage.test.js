import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';
import { tinsert } from '../src/config/database.js';

const { default: WaAiUsageService } = await import('../src/services/waAiUsageService.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');

/** O painel "Uso da IA": só contagem por tarefa, no período pedido. */

let panelUrl;
let token;
const api = (p) => call(`${panelUrl}/api/whatsapp${p}`, { headers: authHeaders(token) });

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
});
after(stopTestServers);

describe('GET /ai-usage', () => {
  it('sem uso: tudo zerado, sem taxa de cache', async () => {
    const res = await api('/ai-usage?days=30');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.total.calls, 0);
    assert.equal(res.body.data.cacheHitRate, null);
    assert.equal(res.body.data.fastModelSet, false);
  });

  it('soma por tarefa, respeita o período e diz se o modelo rápido está configurado', async () => {
    await asTenant(async () => {
      const uso = { input: 100, output: 10, cacheRead: 300, cacheWrite: 0 };
      await WaAiUsageService.registrar({ task: 'conversa', model: 'm', usage: uso });
      await WaAiUsageService.registrar({ task: 'resumo', model: 'm', usage: uso });
      const velho = new Date(Date.now() - 20 * 24 * 3600_000).toISOString().slice(0, 10);
      await tinsert('wa_ai_usage', { day: velho, task: 'conversa', model: 'm', calls: 5, input_tokens: 50, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, updated_at: new Date() });
      await WaBotConfigService.saveConfig({ ai: { fastModel: 'claude-haiku-5-5' } });
    });
    const trinta = await api('/ai-usage?days=30');
    assert.equal(trinta.body.data.tasks.find((t) => t.task === 'conversa').calls, 6);
    assert.equal(trinta.body.data.total.calls, 7);
    assert.equal(trinta.body.data.fastModelSet, true);
    const sete = await api('/ai-usage?days=7');
    assert.equal(sete.body.data.tasks.find((t) => t.task === 'conversa').calls, 1);
    assert.equal(sete.body.data.days, 7);
    assert.equal(trinta.body.data.cacheHitRate, 70.6);
  });

  it('período fora da lista cai em 30 dias; sem login é 401', async () => {
    assert.equal((await api('/ai-usage?days=3')).body.data.days, 30);
    assert.equal((await call(`${panelUrl}/api/whatsapp/ai-usage`)).status, 401);
  });
});
