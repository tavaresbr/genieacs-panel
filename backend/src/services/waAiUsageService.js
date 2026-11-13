import { tdb, tinsert } from '../config/database.js';

/** As tarefas que o painel distingue; qualquer outra vira `outro`. */
export const TAREFAS_DA_IA = Object.freeze([
  'conversa', 'sugestao', 'rascunho', 'resumo', 'reescrever', 'classificar', 'visao', 'teste', 'outro'
]);

const hoje = () => new Date().toISOString().slice(0, 10);

/**
 * O consumo da IA do WhatsApp: contadores por dia, tarefa e modelo (chamadas e
 * tokens de entrada, saída e cache). Nenhum texto de conversa é guardado.
 *
 * Nunca lança: contar o uso não pode derrubar a resposta ao cliente.
 */
class WaAiUsageService {
  static async registrar({ task, model, usage }) {
    try {
      if (!usage) return;
      const chave = {
        day: hoje(),
        task: TAREFAS_DA_IA.includes(task) ? task : 'outro',
        model: String(model ?? '').slice(0, 64)
      };
      const somas = {
        calls: 1,
        input_tokens: Math.max(0, Math.round(usage.input || 0)),
        output_tokens: Math.max(0, Math.round(usage.output || 0)),
        cache_read_tokens: Math.max(0, Math.round(usage.cacheRead || 0)),
        cache_write_tokens: Math.max(0, Math.round(usage.cacheWrite || 0))
      };
      const atualizadas = await tdb('wa_ai_usage').where(chave).increment(somas);
      if (atualizadas) return;
      try {
        await tinsert('wa_ai_usage', { ...chave, ...somas, updated_at: new Date() });
      } catch {
        // Duas respostas no mesmo instante criaram a linha ao mesmo tempo: a segunda soma na existente.
        await tdb('wa_ai_usage').where(chave).increment(somas);
      }
    } catch (error) {
      console.warn(`[wa] IA: uso não registrado: ${error?.code || error?.message}`);
    }
  }

  /** O consumo dos últimos `dias` dias, por tarefa, com a parcela lida do cache. */
  static async resumo({ days = 30 } = {}) {
    const desde = new Date(Date.now() - days * 24 * 3600_000).toISOString().slice(0, 10);
    const linhas = await tdb('wa_ai_usage').where('day', '>=', desde).select('task', 'model', 'calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens');
    const porTarefa = new Map();
    for (const l of linhas) {
      const atual = porTarefa.get(l.task) ?? { task: l.task, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      atual.calls += Number(l.calls);
      atual.inputTokens += Number(l.input_tokens);
      atual.outputTokens += Number(l.output_tokens);
      atual.cacheReadTokens += Number(l.cache_read_tokens);
      atual.cacheWriteTokens += Number(l.cache_write_tokens);
      porTarefa.set(l.task, atual);
    }
    const tarefas = [...porTarefa.values()].sort((a, b) => b.calls - a.calls);
    const total = tarefas.reduce((t, x) => ({
      calls: t.calls + x.calls,
      inputTokens: t.inputTokens + x.inputTokens,
      outputTokens: t.outputTokens + x.outputTokens,
      cacheReadTokens: t.cacheReadTokens + x.cacheReadTokens
    }), { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    // Do que o modelo leu na entrada, quanto veio do cache (que sai bem mais barato).
    const lidos = total.inputTokens + total.cacheReadTokens;
    return { days, tasks: tarefas, total, cacheHitRate: lidos ? Math.round((total.cacheReadTokens / lidos) * 1000) / 10 : null };
  }
}

export default WaAiUsageService;
