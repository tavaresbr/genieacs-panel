import AppState from '../models/AppState.js';
import WaMarketingOptOut from '../models/WaMarketingOptOut.js';
import WaOptOut from '../models/WaOptOut.js';
import WaSendService from './waSendService.js';
import WaConversationService from './waConversationService.js';
import { WaError } from './whatsappConfigService.js';
import { normalizarTexto } from '../utils/wa/waOptOutTexto.js';

const CONFIG_KEY = 'wa_marketing_opt_out_config';

/** Tetos do que a tela grava. */
const MAX_WORDS = 40;
const MAX_WORD_LENGTH = 60;
const MAX_TEXT_LENGTH = 500;

/**
 * As palavras que, SOZINHAS, pedem para parar as promoções. Já na forma
 * comparável (`normalizarTexto`): sem acento, minúscula, sem pontuação.
 *
 * A regra é a de `waOptOutTexto.js`, e pelo mesmo motivo: a mensagem INTEIRA
 * tem que ser o pedido. "Vou parar no caminho e passo aí" não tira ninguém da
 * lista; "PARAR!" tira.
 */
export const PALAVRAS_DE_SAIDA_PADRAO = Object.freeze([
  'parar',
  'pare',
  'sair',
  'stop',
  'parar promocoes',
  'parar promocao',
  'cancelar promocoes',
  'cancelar promocao',
  'nao quero receber',
  'nao quero mais receber',
  'nao quero promocoes',
  'nao quero mais promocoes',
  'sem promocoes',
  'stop promotions'
]);

/** E as que desfazem o pedido. Só valem para quem tem um pedido ativo. */
export const PALAVRAS_DE_VOLTA_PADRAO = Object.freeze([
  'voltar',
  'start',
  'quero receber',
  'voltar a receber',
  'receber promocoes'
]);

/**
 * O botão "Parar promoções" que a Meta põe nos modelos de MARKETING, nas
 * línguas em que o provedor costuma criá-los. Chega como resposta de botão
 * (quick reply) e é reconhecido mesmo que o provedor tire as palavras da lista:
 * é o próprio WhatsApp dizendo o que o cliente pediu.
 */
export const BOTOES_DA_META = Object.freeze([
  'parar promocoes',
  'stop promotions',
  'interromper promocoes',
  'detener promociones'
]);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  stopWords: PALAVRAS_DE_SAIDA_PADRAO,
  resumeWords: PALAVRAS_DE_VOLTA_PADRAO,
  // A resposta padrão é em pt-BR: é o que o assinante lê, e a tela deixa o
  // provedor trocar. Vazio é "não responder".
  confirmText: 'Pronto! Você não vai mais receber nossas promoções por aqui. Se mudar de ideia, é só enviar VOLTAR.',
  resumeText: 'Combinado! Você voltou a receber nossas novidades e promoções. Para parar de novo, é só enviar PARAR.'
});

/** Uma lista de palavras como chega da tela, na forma comparável e sem repetição. */
function lerPalavras(valor, padrao) {
  if (valor === undefined || valor === null) return [...padrao];
  const lista = Array.isArray(valor) ? valor : String(valor).split(/[\n,;]+/);
  return [...new Set(lista
    .map((palavra) => normalizarTexto(palavra))
    .filter((palavra) => palavra && palavra.length <= MAX_WORD_LENGTH))]
    .slice(0, MAX_WORDS);
}

function lerTexto(valor, padrao) {
  if (valor === undefined || valor === null) return padrao;
  return String(valor).trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * O que uma mensagem recebida pede, ou null.
 *
 * Pura: nada de banco. `botao` diz que a mensagem é a resposta a um botão de
 * modelo — o "Parar promoções" da Meta conta mesmo fora da lista do provedor.
 *
 * @returns {{ acao: 'stop'|'resume', source: 'keyword'|'button' } | null}
 */
export function classificarPedido(texto, config = DEFAULT_CONFIG, { botao = false } = {}) {
  const limpo = normalizarTexto(texto);
  if (!limpo) return null;
  const saida = config.stopWords ?? PALAVRAS_DE_SAIDA_PADRAO;
  const volta = config.resumeWords ?? PALAVRAS_DE_VOLTA_PADRAO;
  if (botao && (BOTOES_DA_META.includes(limpo) || saida.includes(limpo))) {
    return { acao: 'stop', source: 'button' };
  }
  if (saida.includes(limpo)) return { acao: 'stop', source: 'keyword' };
  if (volta.includes(limpo)) return { acao: 'resume', source: 'keyword' };
  return null;
}

/**
 * "Não quero promoção": a configuração, o pedido que chega pelo WhatsApp e a
 * marcação da equipe na conversa.
 *
 * O bloqueio em si mora em quem envia — `WaSendService.enqueue`/`dispatch` e o
 * laço de `WaBroadcastService` — e consulta `WaMarketingOptOut` direto: o envio
 * não pode depender deste serviço, que depende dele para responder.
 */
class WaMarketingOptOutService {
  static async getConfig() {
    const raw = await AppState.get(CONFIG_KEY);
    let salvo = {};
    try {
      salvo = raw ? JSON.parse(raw) : {};
    } catch {
      salvo = {};
    }
    return {
      enabled: salvo.enabled !== false,
      stopWords: lerPalavras(salvo.stopWords, DEFAULT_CONFIG.stopWords),
      resumeWords: lerPalavras(salvo.resumeWords, DEFAULT_CONFIG.resumeWords),
      confirmText: lerTexto(salvo.confirmText, DEFAULT_CONFIG.confirmText),
      resumeText: lerTexto(salvo.resumeText, DEFAULT_CONFIG.resumeText)
    };
  }

  /** O que a tela recebe: a configuração e os padrões, para o botão "restaurar". */
  static async getPublic() {
    return {
      ...(await this.getConfig()),
      metaButtons: [...BOTOES_DA_META],
      defaults: {
        stopWords: [...DEFAULT_CONFIG.stopWords],
        resumeWords: [...DEFAULT_CONFIG.resumeWords],
        confirmText: DEFAULT_CONFIG.confirmText,
        resumeText: DEFAULT_CONFIG.resumeText
      }
    };
  }

  /** Campo ausente mantém o gravado. */
  static async saveConfig(input = {}) {
    const atual = await this.getConfig();
    const next = {
      enabled: input.enabled === undefined ? atual.enabled : input.enabled !== false,
      stopWords: input.stopWords === undefined ? atual.stopWords : lerPalavras(input.stopWords, []),
      resumeWords: input.resumeWords === undefined ? atual.resumeWords : lerPalavras(input.resumeWords, []),
      confirmText: input.confirmText === undefined ? atual.confirmText : lerTexto(input.confirmText, ''),
      resumeText: input.resumeText === undefined ? atual.resumeText : lerTexto(input.resumeText, '')
    };
    // A mesma palavra nos dois lados faria a mensagem sair e voltar ao mesmo
    // tempo; quem decide qual vale é o provedor, não a ordem do código.
    const nasDuas = next.stopWords.filter((palavra) => next.resumeWords.includes(palavra));
    if (nasDuas.length > 0) {
      throw new WaError('whatsapp.marketingOptOut.wordsOverlap', {
        code: 'marketing_words_overlap',
        status: 400,
        vars: { words: nasDuas.join(', ') }
      });
    }
    await AppState.upsert(CONFIG_KEY, JSON.stringify(next));
    return this.getPublic();
  }

  /**
   * Uma mensagem recebida que pode ser o pedido (ou a volta). Nunca lança: é
   * chamada de dentro do webhook, e uma falha aqui não pode virar o 500 que faz
   * o servidor reenviar o evento para sempre.
   *
   * Só entrada. Um eco de saída com "parar" é o provedor digitando no próprio
   * celular, e não é pedido de ninguém.
   *
   * @returns {Promise<{ consumed: true, action: 'opted_out'|'opted_in', created?: boolean } | null>}
   *   `consumed` quer dizer que a mensagem era o pedido e já foi respondida: o
   *   bot não a responde de novo e ela não vai para a fila de atendimento.
   */
  static async handleInbound({ conversation, text, button = false, fromMe = false } = {}) {
    if (fromMe || !conversation?.id) return null;
    try {
      const config = await this.getConfig();
      if (!config.enabled) return null;
      const pedido = classificarPedido(text, config, { botao: button });
      if (!pedido) return null;
      const endereco = { waPhone: conversation.wa_phone_e164, waLid: conversation.wa_lid };

      if (pedido.acao === 'stop') {
        const { created } = await WaMarketingOptOut.record({
          ...endereco,
          conversationId: conversation.id,
          source: pedido.source,
          triggerText: text
        });
        // Uma vez só: repetir "parar" não é motivo para mandar outra mensagem
        // a quem acabou de pedir menos mensagens.
        if (created) await this.responder(conversation, config.confirmText);
        return { consumed: true, action: 'opted_out', created };
      }

      // A volta só existe para quem saiu. "voltar" de quem nunca pediu nada é
      // conversa comum — pode ser o menu do bot —, e segue o fluxo normal.
      const revogadas = await WaMarketingOptOut.revoke({ ...endereco, source: 'keyword' });
      if (revogadas === 0) return null;
      // O "SAIR" que gravou também o não perturbe inteiro foi pedido pelo
      // mesmo cliente, pela mesma conversa; a volta dele desfaz os dois. O que
      // a EQUIPE marcou (`origin: operator`) fica: não é do cliente desfazer.
      const inteiro = await WaOptOut.findActive(endereco);
      if (inteiro && inteiro.origin === 'customer') await WaOptOut.revoke(inteiro.id, null);
      await this.responder(conversation, config.resumeText);
      return { consumed: true, action: 'opted_in' };
    } catch (error) {
      console.error('waMarketingOptOut:', error?.message || error);
      return null;
    }
  }

  /**
   * A confirmação. É resposta a quem acabou de escrever — dentro da janela de
   * 24 h da Meta e fora de qualquer bloqueio, que só vale para o que o
   * provedor inicia. Sem número conectado, o pedido continua gravado e só a
   * resposta fica para trás.
   */
  static async responder(conversation, texto) {
    const corpo = String(texto ?? '').trim();
    if (!corpo) return;
    try {
      await WaSendService.enqueue({ conversationId: conversation.id, body: corpo, userId: null, source: 'bot' });
    } catch (error) {
      console.warn(`waMarketingOptOut: confirmação não enfileirada na conversa ${conversation.id}: ${error?.code || error?.message || error}`);
    }
  }

  /**
   * A equipe marca ou desmarca na conversa. Devolve a conversa como a tela a
   * lê e se algo mudou, para a trilha de auditoria.
   */
  static async setForConversation(conversationId, optedOut, { userId = null } = {}) {
    const conversation = await WaConversationService.get(conversationId);
    const endereco = { waPhone: conversation.wa_phone_e164, waLid: conversation.wa_lid };
    if (!endereco.waPhone && !endereco.waLid) {
      throw new WaError('whatsapp.error.noDestination', { code: 'no_destination', status: 409 });
    }
    let changed;
    if (optedOut) {
      const { created } = await WaMarketingOptOut.record({
        ...endereco,
        conversationId: conversation.id,
        source: 'operator',
        userId
      });
      changed = created;
    } else {
      changed = (await WaMarketingOptOut.revoke({ ...endereco, source: 'operator', userId })) > 0;
    }
    return { changed, conversation: await WaConversationService.decorate(conversation) };
  }
}

export { CONFIG_KEY, DEFAULT_CONFIG };
export default WaMarketingOptOutService;
