import NpsService from './npsService.js';
import PlatformOwnerBotService from './platformOwnerBotService.js';

/**
 * A ligação entre a pesquisa de satisfação (0123) e o bot do WhatsApp da
 * plataforma: a nota mandada como um número sozinho ("9") vira resposta da
 * pesquisa pendente — `NpsService.captureForPhone`, com as travas dele
 * (pendente, saída pelo WhatsApp, só o telefone de cobrança, um provedor só).
 *
 * Num módulo à parte, chamado no arranque (`app.js`): o `npsService` e o
 * `platformOwnerBotService` não se importam um ao outro, e nenhum dos dois
 * precisa saber que o outro existe. Ligar duas vezes não registra dois
 * ganchos.
 */
let desfazer = null;

export function wireNpsWhatsappReply() {
  if (desfazer) return desfazer;
  const remover = PlatformOwnerBotService.registerNumericHandler(async ({ text, tenantIds, phone }) => {
    const r = await NpsService.captureForPhone({ tenantIds, phone, text });
    if (!r.captured) return null;
    return { consumed: true, reply: r.reply, intent: 'npsScore' };
  });
  NpsService.whatsappReplyEnabled = true;
  desfazer = () => {
    remover();
    NpsService.whatsappReplyEnabled = false;
    desfazer = null;
  };
  return desfazer;
}

export default wireNpsWhatsappReply;
