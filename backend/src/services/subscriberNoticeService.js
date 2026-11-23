import AppState from '../models/AppState.js';
import TelegramMessage from '../models/TelegramMessage.js';
import TelegramCustomerBotService from './telegramCustomerBotService.js';
import { tdb, tinsert, isUniqueViolation } from '../config/database.js';

/** Os tipos de aviso que o Telegram dos clientes leva. */
export const NOTICE_KINDS = Object.freeze(['billing', 'outage', 'maintenance', 'campaign']);

/**
 * Quais tipos saem por padrão. Queda e manutenção avisam de uma coisa que já
 * aconteceu na rede do cliente; cobrança e promoção em um canal novo só com o
 * provedor ligando de propósito.
 */
export const DEFAULT_NOTICE_SETTINGS = Object.freeze({
  billing: false, outage: true, maintenance: true, campaign: false
});

const SETTINGS_KEY = 'telegram_customer_notices';
const IN_CHUNK = 400;
const BODY_LIMIT = 4000;

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Os avisos do provedor ao assinante pelo Telegram — AO LADO do WhatsApp.
 *
 * Quem chama (a régua de cobrança, a queda, a manutenção, as campanhas) já
 * mandou o seu pelo WhatsApp e só então chama aqui, dentro de um `try`. Aqui:
 *
 * - o aviso só vai a quem VINCULOU o Telegram a um contrato (o bot não escreve
 *   primeiro, e não há outro endereço), não bloqueou o bot e não mandou `/parar`;
 * - cada (tipo, referência, conversa) sai uma vez — `telegram_notices` é o que
 *   faz "Avisar de novo", a reexecução da régua e a reentrega não repetirem;
 * - a mensagem entra na FILA (`telegram_messages`, `queued`, `source='notice'`)
 *   e quem envia é `telegramOutboxWorker`, com recuo e ritmo.
 *
 * NUNCA lança: um aviso extra não pode derrubar o do WhatsApp.
 */
class SubscriberNoticeService {
  static async getSettings() {
    let stored = {};
    try {
      const raw = await AppState.get(SETTINGS_KEY);
      stored = raw ? JSON.parse(raw) || {} : {};
    } catch {
      stored = {};
    }
    const settings = {};
    for (const kind of NOTICE_KINDS) {
      settings[kind] = typeof stored[kind] === 'boolean' ? stored[kind] : DEFAULT_NOTICE_SETTINGS[kind];
    }
    return settings;
  }

  /** Campo ausente mantém o gravado; só os tipos conhecidos, só booleanos. */
  static async saveSettings(patch = {}) {
    const next = await this.getSettings();
    for (const kind of NOTICE_KINDS) {
      if (typeof patch?.[kind] === 'boolean') next[kind] = patch[kind];
    }
    await AppState.upsert(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  /** As conversas que podem receber um aviso agora: vinculadas ao contrato, sem bloqueio e sem `/parar`. */
  static async eligibleConversations(contracts) {
    const wanted = [...new Set((contracts ?? []).map((c) => String(c ?? '').trim()).filter(Boolean))];
    const found = [];
    for (const part of chunks(wanted, IN_CHUNK)) {
      // eslint-disable-next-line no-await-in-loop -- poucas leituras, em ordem
      found.push(...await tdb('telegram_conversations')
        .whereIn('contract', part)
        .whereNull('blocked_at')
        .whereNull('notices_off_at')
        .select('id', 'contract'));
    }
    return found;
  }

  /** Enfileira o texto a UMA conversa, uma vez por (tipo, referência). Devolve se enfileirou. */
  static async queueOne({ conversationId, kind, refKey, bodies }) {
    try {
      await tinsert('telegram_notices', { conversation_id: conversationId, kind, ref_key: refKey });
    } catch (error) {
      // Já avisada: é o índice único fazendo o trabalho.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- a ordem das mensagens é o ponto
      await TelegramMessage.insert({
        conversation_id: conversationId,
        direction: 'out',
        body,
        source: 'notice',
        delivery_status: 'queued'
      });
    }
    return true;
  }

  /**
   * Avisa os contratos. `body` é um texto ou uma lista (ex.: o texto da cobrança
   * e, depois, o código do PIX em mensagem só dele). Devolve quantas conversas
   * entraram na fila; nunca lança.
   */
  static async notifyTelegram({ contracts, kind, refKey, body }) {
    try {
      if (!NOTICE_KINDS.includes(kind) || !refKey) return { queued: 0 };
      const bodies = (Array.isArray(body) ? body : [body])
        .map((text) => String(text ?? '').trim().slice(0, BODY_LIMIT))
        .filter(Boolean);
      if (bodies.length === 0) return { queued: 0 };
      if (!(await this.getSettings())[kind]) return { queued: 0 };
      if (!(await TelegramCustomerBotService.active())) return { queued: 0 };
      let queued = 0;
      for (const conversation of await this.eligibleConversations(contracts)) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequencial: um erro numa conversa não para as outras
          if (await this.queueOne({ conversationId: conversation.id, kind, refKey: String(refKey).slice(0, 128), bodies })) queued += 1;
        } catch {
          console.warn('Telegram notice could not be queued');
        }
      }
      return { queued };
    } catch {
      console.warn('Telegram notice failed');
      return { queued: 0 };
    }
  }

  /**
   * O aviso de FECHAMENTO ("normalizado", "manutenção concluída"): só a quem
   * recebeu o aviso `fromRefKey` do mesmo tipo — quem não ouviu falar do
   * problema não precisa ouvir que ele acabou. Nunca lança.
   */
  static async notifyFollowUp({ kind, fromRefKey, refKey, body }) {
    try {
      if (!NOTICE_KINDS.includes(kind) || !fromRefKey || !refKey) return { queued: 0 };
      const text = String(Array.isArray(body) ? body[0] : body ?? '').trim().slice(0, BODY_LIMIT);
      if (!text) return { queued: 0 };
      if (!(await this.getSettings())[kind]) return { queued: 0 };
      if (!(await TelegramCustomerBotService.active())) return { queued: 0 };
      const rows = await tdb('telegram_notices')
        .where({ kind, ref_key: String(fromRefKey).slice(0, 128) })
        .select('conversation_id');
      let queued = 0;
      for (const { conversation_id: conversationId } of rows) {
        const conversation = await tdb('telegram_conversations')
          .where({ id: conversationId }).whereNull('blocked_at').whereNull('notices_off_at').first();
        if (!conversation) continue;
        try {
          // eslint-disable-next-line no-await-in-loop -- idem
          if (await this.queueOne({ conversationId, kind, refKey: String(refKey).slice(0, 128), bodies: [text] })) queued += 1;
        } catch {
          console.warn('Telegram follow-up notice could not be queued');
        }
      }
      return { queued };
    } catch {
      console.warn('Telegram follow-up notice failed');
      return { queued: 0 };
    }
  }
}

export default SubscriberNoticeService;
