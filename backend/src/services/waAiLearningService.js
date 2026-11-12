import { tdb, tinsertReturningId } from '../config/database.js';
import AddonService from './addonService.js';
import WaBotConfigService from './waBotConfigService.js';
import WaAiClient from './waAiClient.js';
import { mascararSensivel } from '../utils/wa/sensivel.js';
import { logSafe } from '../utils/logger.js';
import { TIPOS_DE_CONHECIMENTO, normalizar } from '../utils/wa/conhecimento.js';

const MENSAGENS = 40;
const POR_MENSAGEM = 400;
const MAX_SUGESTOES = 3;
/** Sugestões à espera de decisão: passando disto, a IA para de propor até a equipe revisar. */
const MAX_PENDENTES = 30;

const MOTIVOS = {
  price: 'o preço',
  competitor: 'um concorrente',
  no_coverage: 'falta de cobertura',
  no_interest: 'falta de interesse',
  other: 'outro motivo'
};

const INSTRUCAO = [
  'Você ajuda um provedor de internet a melhorar o atendimento de vendas por WhatsApp.',
  'Abaixo está uma conversa de venda que já terminou, e como terminou. Proponha de 1 a 3 itens NOVOS para a base de conhecimento da empresa, que ajudem o atendente virtual nas próximas conversas parecidas:',
  '- "objecao": uma dúvida ou resistência que o cliente teve, com a resposta que ajuda. Em "triggers", as palavras (separadas por vírgula) que o cliente usa quando isso acontece.',
  '- "faq": uma pergunta que o cliente fez e que a base poderia responder. Mesmo formato de "triggers".',
  '- "vantagem": algo que a empresa tem de bom e que a conversa mostrou ter peso para o cliente (sem "triggers").',
  'Regras: escreva respostas curtas e prontas para serem editadas, SEM inventar preço, prazo, desconto, cobertura ou qualquer fato que a conversa não tenha confirmado; quando faltar o fato, diga o que o operador deve preencher. Não repita os títulos já cadastrados. Não inclua dados pessoais (nome, telefone, endereço, documento).',
  'Responda SÓ com JSON, sem texto fora dele: [{"kind":"objecao|faq|vantagem","title":"...","triggers":"...","answer":"..."}]. Se nada vale a pena propor, responda [].'
].join('\n');

/** O JSON da resposta, com tolerância a cerca de código e a texto em volta. */
export function lerSugestoes(resposta) {
  const texto = String(resposta ?? '');
  const inicio = texto.indexOf('[');
  const fim = texto.lastIndexOf(']');
  if (inicio < 0 || fim <= inicio) return [];
  try {
    const lista = JSON.parse(texto.slice(inicio, fim + 1));
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

const limpar = (valor, max) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Uma sugestão válida e já limpa, ou null. Nunca confia no formato do modelo. */
export function validarSugestao(bruta) {
  if (!bruta || typeof bruta !== 'object') return null;
  if (!TIPOS_DE_CONHECIMENTO.includes(bruta.kind)) return null;
  const title = limpar(bruta.title, 120);
  const answer = limpar(bruta.answer, 600);
  if (!title || !answer) return null;
  const triggers = bruta.kind === 'vantagem' ? null : limpar(bruta.triggers, 300) || null;
  return { kind: bruta.kind, title, triggers, answer };
}

/**
 * O aprendizado supervisionado: depois que uma venda termina (fechou ou perdeu),
 * a própria IA configurada lê a conversa e PROPÕE itens para a base. Eles entram
 * inativos e marcados `sugerida`; só valem quando alguém da equipe aprova na
 * tela. Nada aqui altera o que a IA diz a um cliente.
 *
 * Nunca lança: é um extra do encerramento, e falhar não pode atrapalhá-lo.
 */
class WaAiLearningService {
  /**
   * @returns {Promise<number>} quantas sugestões foram gravadas
   */
  static async sugerir(conversationId) {
    try {
      if (!(await AddonService.allows('ai'))) return 0;
      const ai = await WaBotConfigService.aiSettings();
      if (!ai.enabled || !ai.apiKey) return 0;

      const conversa = await tdb('wa_conversations').where({ id: conversationId }).first();
      if (!conversa?.lead_at || !conversa.lead_outcome) return 0;

      const pendentes = await tdb('wa_ai_knowledge').where({ origin: 'sugerida', active: false }).count({ total: '*' });
      if (Number(pendentes[0]?.total) >= MAX_PENDENTES) return 0;

      // Reivindica a conversa: uma só chamada paga por venda, mesmo com dois encerramentos.
      const marcadas = await tdb('wa_conversations').where({ id: conversationId }).whereNull('lead_learned_at').update({ lead_learned_at: new Date() });
      if (!marcadas) return 0;

      const linhas = await tdb('wa_messages')
        .where({ conversation_id: conversationId, is_note: false })
        .whereNotNull('body')
        .orderBy('id', 'desc')
        .limit(MENSAGENS)
        .select('direction', 'body');
      const fala = linhas.reverse()
        .map((m) => `${m.direction === 'in' ? 'Cliente' : 'Atendimento'}: ${mascararSensivel(String(m.body).trim()).slice(0, POR_MENSAGEM)}`)
        .filter((l) => l.length > 14);
      if (fala.length < 2) return 0;

      const titulos = (await tdb('wa_ai_knowledge').select('title')).map((i) => i.title);
      const desfecho = conversa.lead_outcome === 'won'
        ? 'A venda FECHOU.'
        : `A venda se PERDEU por ${MOTIVOS[conversa.lead_lost_reason] ?? 'motivo não informado'}.`;

      const resposta = await WaAiClient.chat({
        provider: ai.provider,
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey,
        workspaceId: ai.workspaceId,
        model: ai.model,
        maxTokens: 900,
        messages: [
          { role: 'system', content: INSTRUCAO },
          { role: 'user', content: `${desfecho}\n\nTítulos já cadastrados: ${titulos.join('; ') || '(nenhum)'}\n\nConversa:\n${fala.join('\n')}` }
        ]
      });

      const vistos = new Set(titulos.map(normalizar));
      let gravadas = 0;
      for (const bruta of lerSugestoes(resposta.content)) {
        if (gravadas >= MAX_SUGESTOES) break;
        const sugestao = validarSugestao(bruta);
        if (!sugestao || vistos.has(normalizar(sugestao.title))) continue;
        vistos.add(normalizar(sugestao.title));
        const agora = new Date();
        // eslint-disable-next-line no-await-in-loop -- no máximo três linhas
        await tinsertReturningId('wa_ai_knowledge', { ...sugestao, active: false, origin: 'sugerida', created_at: agora, updated_at: agora });
        gravadas += 1;
      }
      return gravadas;
    } catch (error) {
      console.warn(`[wa] IA: sugestões para a base: ${JSON.stringify(logSafe(error?.code || error?.message, 200))}`);
      return 0;
    }
  }
}

export default WaAiLearningService;
