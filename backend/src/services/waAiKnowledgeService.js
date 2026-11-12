import { tdb, tinsertReturningId } from '../config/database.js';
import AppState from '../models/AppState.js';
import { WaError } from './whatsappConfigService.js';
import { EXEMPLOS, TIPOS_DE_CONHECIMENTO, escolherConhecimento, lerGatilhos } from '../utils/wa/conhecimento.js';

const TITLE_LIMIT = 120;
const TRIGGERS_LIMIT = 300;
const ANSWER_LIMIT = 600;
const SEEDED_KEY = 'wa_ai_knowledge_seeded';
/** Um trecho entre colchetes é um espaço a preencher ("[escreva o seu prazo]"): a IA o repetiria ao cliente. */
const ESPACO_A_PREENCHER = /\[[^\]]*\]/;

const invalido = (codigo) => new WaError('whatsapp.aiKnowledge.invalid', { code: codigo, status: 400 });
const limpar = (valor) => String(valor ?? '').replace(/\s+/g, ' ').trim();

function ler(corpo, { parcial }) {
  const dados = {};
  if (!parcial || corpo.kind !== undefined) {
    if (!TIPOS_DE_CONHECIMENTO.includes(corpo.kind)) throw invalido('ai_knowledge_kind_invalid');
    dados.kind = corpo.kind;
  }
  if (!parcial || corpo.title !== undefined) {
    const title = limpar(corpo.title);
    if (!title) throw new WaError('whatsapp.aiKnowledge.titleRequired', { code: 'ai_knowledge_title_required', status: 400 });
    if (title.length > TITLE_LIMIT) throw invalido('ai_knowledge_title_too_long');
    dados.title = title;
  }
  if (!parcial || corpo.answer !== undefined) {
    const answer = limpar(corpo.answer);
    if (!answer) throw new WaError('whatsapp.aiKnowledge.answerRequired', { code: 'ai_knowledge_answer_required', status: 400 });
    if (answer.length > ANSWER_LIMIT) throw invalido('ai_knowledge_answer_too_long');
    dados.answer = answer;
  }
  if (corpo.triggers !== undefined) {
    const triggers = limpar(corpo.triggers);
    if (triggers.length > TRIGGERS_LIMIT) throw invalido('ai_knowledge_triggers_too_long');
    dados.triggers = triggers || null;
  }
  if (corpo.active !== undefined) dados.active = corpo.active === true;
  return dados;
}

const publico = (l) => ({
  id: l.id,
  kind: l.kind,
  title: l.title,
  triggers: l.triggers ?? '',
  answer: l.answer,
  active: Boolean(l.active),
  origin: l.origin,
  uses: l.uses ?? 0
});

/**
 * A base de conhecimento da IA de vendas, por provedor. Os exemplos que nascem
 * com ela (`origin = 'exemplo'`) não valem até o operador editá-los: ativar um
 * texto de exemplo faria a IA dizer ao cliente "descreva aqui o seu suporte".
 */
class WaAiKnowledgeService {
  /** Semeia os exemplos, desativados, uma vez por provedor. */
  static async semear() {
    if (!(await AppState.insertIfMissing(SEEDED_KEY, new Date().toISOString()))) return;
    const agora = new Date();
    for (const exemplo of EXEMPLOS) {
      // eslint-disable-next-line no-await-in-loop -- oito linhas, uma vez
      await tinsertReturningId('wa_ai_knowledge', {
        ...exemplo, active: false, origin: 'exemplo', created_at: agora, updated_at: agora
      });
    }
  }

  static async list() {
    await this.semear();
    const linhas = await tdb('wa_ai_knowledge').orderBy([{ column: 'kind' }, { column: 'title' }]);
    return linhas.map(publico);
  }

  static async create(corpo) {
    const dados = ler(corpo ?? {}, { parcial: false });
    if (dados.active !== false && ESPACO_A_PREENCHER.test(dados.answer)) {
      throw new WaError('whatsapp.aiKnowledge.placeholder', { code: 'ai_knowledge_placeholder', status: 409 });
    }
    const agora = new Date();
    const id = await tinsertReturningId('wa_ai_knowledge', {
      active: true, ...dados, origin: 'manual', created_at: agora, updated_at: agora
    });
    return publico(await tdb('wa_ai_knowledge').where({ id }).first());
  }

  static async update(id, corpo) {
    const atual = await tdb('wa_ai_knowledge').where({ id }).first();
    if (!atual) throw new WaError('whatsapp.aiKnowledge.notFound', { code: 'ai_knowledge_not_found', status: 404 });
    const dados = ler(corpo ?? {}, { parcial: true });
    const editou = ['kind', 'title', 'answer', 'triggers'].some((c) => dados[c] !== undefined && dados[c] !== atual[c]);
    if (atual.origin === 'exemplo' && dados.active === true && !editou) {
      throw new WaError('whatsapp.aiKnowledge.exampleUnedited', { code: 'ai_knowledge_example_unedited', status: 409 });
    }
    const respostaFinal = dados.answer ?? atual.answer;
    if (dados.active === true && ESPACO_A_PREENCHER.test(respostaFinal)) {
      throw new WaError('whatsapp.aiKnowledge.placeholder', { code: 'ai_knowledge_placeholder', status: 409 });
    }
    // Editar um exemplo o torna do operador: só então ele pode valer.
    const origin = atual.origin === 'exemplo' && editou ? 'manual' : atual.origin;
    await tdb('wa_ai_knowledge').where({ id }).update({ ...dados, origin, updated_at: new Date() });
    return publico(await tdb('wa_ai_knowledge').where({ id }).first());
  }

  static async remove(id) {
    const apagadas = await tdb('wa_ai_knowledge').where({ id }).del();
    if (!apagadas) throw new WaError('whatsapp.aiKnowledge.notFound', { code: 'ai_knowledge_not_found', status: 404 });
  }

  /**
   * O texto da base para o prompt, dado o que o cliente escreveu. Conta o uso
   * dos itens que entraram por gatilho; nunca lança (a conversa não pode
   * depender do contador).
   */
  static async paraPrompt(conversa) {
    const linhas = await tdb('wa_ai_knowledge').where({ active: true });
    const { texto, usados } = escolherConhecimento(linhas, conversa);
    if (usados.length) {
      tdb('wa_ai_knowledge').whereIn('id', usados.map((i) => i.id)).increment('uses', 1).catch(() => {});
    }
    return texto;
  }
}

export { lerGatilhos };
export default WaAiKnowledgeService;
