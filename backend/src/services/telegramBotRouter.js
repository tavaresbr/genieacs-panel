import { tdb } from '../config/database.js';
import TelegramConversation from '../models/TelegramConversation.js';
import SgpLink from '../models/SgpLink.js';
import WaBotService, { classificarIntencao } from './waBotService.js';
import WaBotConfigService from './waBotConfigService.js';
import AddonService from './addonService.js';
import TelegramCustomerBotService from './telegramCustomerBotService.js';
import TelegramSendService from './telegramSendService.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { pedeSaida } from '../utils/wa/waOptOutTexto.js';

/**
 * O bot que responde o cliente no Telegram: fatura, conexão, menu e "quero um
 * atendente".
 *
 * É o mesmo desenho do bot do WhatsApp (`waBotService.rotear`) e USA OS MESMOS
 * CONSTRUTORES DE RESPOSTA — fatura em partes, sinal óptico, queda e manutenção
 * do nó, o menu e a passagem para um humano, todos exportados por
 * `WaBotService` (a IA do painel já os usa assim). Por isso o que o bot diz, e
 * principalmente o que ele NUNCA diz (senha de Wi-Fi, senha do portal, trocar
 * SSID, reiniciar ONT: tudo isso é a dica do portal), é uma regra só nos dois
 * canais. O bot do WhatsApp não foi tocado.
 *
 * O que muda de um canal para o outro, e é a razão de este arquivo existir:
 *
 *  - QUEM é o cliente. No WhatsApp o telefone casa com o cadastro; no Telegram
 *    não há telefone. A conversa só é respondida depois de VINCULADA a um
 *    contrato (pelo link `?start=` ou pela equipe — `telegramLinkTokenService`).
 *    Quem não está vinculado recebe a orientação de pedir o link, e nenhum dado
 *    de contrato. Sem identificação por CPF nesta etapa.
 *  - LIGADO só pelo provedor (`auto_reply`, desligado por padrão).
 *  - Sem a liberação em confiança: ela grava a auditoria como o bot do
 *    WhatsApp, e "quero liberar" recebe a fatura, que é o que desbloqueia.
 *
 * As travas são as do WhatsApp: um atendente na conversa nos últimos 30 minutos
 * cala o bot, no máximo 6 respostas por hora (o laço de dois robôs), e o pedido
 * de atendente o cala por 4 horas.
 *
 * NUNCA lança: é chamado de dentro do webhook, e um bot que quebra vira
 * silêncio, não uma reentrega.
 */
const JANELA_HUMANO_MS = WaBotService.JANELA_HUMANO_MS;
const PAUSA_ATENDENTE_MS = WaBotService.PAUSA_ATENDENTE_MS;
const TETO_POR_HORA = WaBotService.TETO_POR_HORA;
const JANELA_TETO_MS = 60 * 60 * 1000;
const ORIGEM_BOT = 'bot';

const t = (chave, vars) => translate(DEFAULT_LOCALE, chave, vars);

const TEXTO = Object.freeze({
  naoVinculado: 'Ainda não consegui identificar o seu cadastro por aqui. Peça à nossa equipe o link do Telegram (ele vem na fatura ou pelo atendimento) ou escreva "atendente" para falar com uma pessoa.'
});

/** O vínculo que os construtores de resposta esperam: o contrato e a ONT dele. */
async function vinculoDaConversa(conversation) {
  if (!conversation.contract) return null;
  const links = await SgpLink.getByContract(conversation.contract);
  const comAparelho = links.find((item) => item.device_id) ?? links[0] ?? null;
  return { contract: conversation.contract, device_id: comAparelho?.device_id ?? null };
}

class TelegramBotRouter {
  /**
   * Responde uma mensagem do cliente, ou fica calado. Devolve o que houve (para
   * os testes e para quem depura uma conversa que o bot não respondeu).
   *
   * @returns {Promise<{ replied: boolean, intent?: string, reason?: string }>}
   */
  static async answer({ conversation, text }) {
    try {
      return await this.route({ conversation, text });
    } catch (error) {
      // O que não dá para dizer (bloqueado, bot fora) não é falha; o resto vai
      // ao log, sem o texto da mensagem.
      if (!['chat_blocked', 'bot_unavailable'].includes(error?.code)) {
        console.error('telegram bot:', error?.name || 'Error');
      }
      return { replied: false, reason: 'error' };
    }
  }

  static async say(conversation, messages) {
    for (const message of (Array.isArray(messages) ? messages : [messages])) {
      // eslint-disable-next-line no-await-in-loop -- a ordem é o ponto (a fatura sai em partes)
      await TelegramSendService.sendText(conversation.id, message, null, { source: ORIGEM_BOT });
    }
  }

  static async pause(conversation, until) {
    await TelegramConversation.update(conversation.id, { bot_paused_until: until });
  }

  static async route({ conversation, text }) {
    if (!conversation?.id) return { replied: false, reason: 'no_conversation' };
    const texto = String(text ?? '').trim();
    if (!texto) return { replied: false, reason: 'empty' };

    // Desligado (o padrão): o provedor atende tudo à mão.
    const active = await TelegramCustomerBotService.active();
    if (!active || !(active.bot.auto_reply === true || active.bot.auto_reply === 1)) {
      return { replied: false, reason: 'disabled' };
    }
    if (!(await AddonService.allows('whatsapp'))) return { replied: false, reason: 'addon_required' };

    // Um pedido para sair já foi tratado (`/parar`) ou é a palavra solta: não
    // se responde "SAIR" com um menu.
    if (pedeSaida(texto)) return { replied: false, reason: 'opt_out_request' };

    // Um humano na conversa vence, sempre: quem respondeu pelo painel nos
    // últimos 30 minutos ainda está nela.
    const humano = await tdb('telegram_messages')
      .where({ conversation_id: conversation.id, direction: 'out', source: 'operator' })
      .where('created_at', '>=', new Date(Date.now() - JANELA_HUMANO_MS))
      .first();
    if (humano) return { replied: false, reason: 'operator_present' };

    // O teto: só as respostas do próprio bot contam (aviso e confirmação do
    // vínculo não gastam o orçamento de quem fez uma pergunta de verdade).
    const automaticas = await tdb('telegram_messages')
      .where({ conversation_id: conversation.id, direction: 'out', source: ORIGEM_BOT })
      .where('created_at', '>=', new Date(Date.now() - JANELA_TETO_MS))
      .limit(TETO_POR_HORA)
      .pluck('id');
    if (automaticas.length >= TETO_POR_HORA) return { replied: false, reason: 'rate_limited' };

    const intencao = classificarIntencao(texto);

    // Quem pediu um atendente não recebe o menu a cada mensagem: a conversa fica
    // com os humanos até a pausa vencer — ou até o cliente pedir o menu.
    const pausadoAte = conversation.bot_paused_until ? new Date(conversation.bot_paused_until).getTime() : 0;
    if (pausadoAte > Date.now()) {
      if (!WaBotService.pedeMenu(texto)) return { replied: false, reason: 'paused' };
      await this.pause(conversation, null);
    }

    const link = await vinculoDaConversa(conversation);
    if (!link) {
      if (intencao === 'atendente') {
        await this.pause(conversation, new Date(Date.now() + PAUSA_ATENDENTE_MS));
        await this.say(conversation, await WaBotService.textoPassagem('handoffQueued'));
        return { replied: true, intent: 'atendente' };
      }
      await this.say(conversation, TEXTO.naoVinculado);
      return { replied: true, intent: 'notLinked' };
    }

    // O menu sem a opção de liberação (não oferecida no Telegram): o link vai
    // sem contrato só para esta montagem.
    const menu = () => WaBotService.menu({ contract: null, device_id: link.device_id });

    if (intencao === 'menu') {
      await this.say(conversation, await menu());
      return { replied: true, intent: 'menu' };
    }
    if (intencao === 'atendente') {
      await this.pause(conversation, new Date(Date.now() + PAUSA_ATENDENTE_MS));
      await this.say(conversation, await WaBotService.textoPassagem('handoffQueued'));
      return { replied: true, intent: 'atendente' };
    }

    // Uma opção que o provedor desligou na aba Chatbot responde com o menu —
    // que já não a mostra. "Atendente" nunca é desligado de verdade.
    const { options } = await WaBotConfigService.getConfig();
    const desligada = ((intencao === 'fatura' || intencao === 'liberar') && !options.invoice)
      || (intencao === 'sinal' && !options.signal);
    if (desligada) {
      await this.say(conversation, await menu());
      return { replied: true, intent: 'menu', from: intencao };
    }

    // `wa_phone_e164` nulo: o Telegram não tem telefone, e quem pergunta da queda
    // ou da manutenção fica marcado como avisado sem número novo no cadastro.
    const quem = { id: conversation.id, wa_phone_e164: null };
    let resposta = null;
    try {
      if (intencao === 'portal') resposta = await WaBotService.textoPortal();
      else if (intencao === 'fatura' || intencao === 'liberar') {
        resposta = await WaBotService.partesFatura(link);
      } else if (intencao === 'sinal') {
        const manutencao = link.device_id ? await WaBotService.textoManutencao(link, quem) : null;
        if (manutencao) {
          await this.say(conversation, manutencao);
          return { replied: true, intent: 'maintenance' };
        }
        const queda = link.device_id ? await WaBotService.textoQueda(link, quem) : null;
        if (queda) {
          await this.say(conversation, queda);
          return { replied: true, intent: 'outage' };
        }
        resposta = link.device_id ? await WaBotService.textoSinal(link) : t('whatsapp.bot.noDevice');
      }
    } catch (error) {
      // SGP fora, GenieACS inalcançável, contrato que o ERP não conhece: o
      // cliente fez uma pergunta de verdade e merece mais que o silêncio.
      console.error(`telegram bot ${intencao}:`, error?.name || 'Error');
      resposta = null;
    }

    if (!resposta || (Array.isArray(resposta) && resposta.length === 0)) {
      await this.say(conversation, await WaBotService.textoPassagem('handoff'));
      return { replied: true, intent: 'handoff', from: intencao };
    }
    await this.say(conversation, resposta);
    return { replied: true, intent: intencao === 'liberar' ? 'fatura' : intencao };
  }
}

export default TelegramBotRouter;
