import MessengerPage from '../models/MessengerPage.js';
import { issueConfirmationCode } from '../utils/messenger/messengerSignedRequest.js';

/**
 * Os dois avisos que a Meta manda sobre o usuário que fez o login do Facebook
 * (quem conectou a Página), ambos com `user_id` e sem sessão:
 *
 * - **Desautorização**: a pessoa removeu o app da conta dela. A Meta já
 *   invalidou os tokens, então as Páginas que ela conectou passam a "requer
 *   atenção" com o motivo — o histórico do provedor fica intacto.
 * - **Exclusão de dados**: apagamos o que guardamos DELA — o token de cada
 *   Página que ela conectou e o id dela no app. A Página fica sem token (e sem
 *   assinatura de webhook, que a Meta já cortou) até alguém reconectar. As
 *   conversas pertencem ao provedor e aos clientes dele (pedido de titular vai
 *   pelo provedor, controlador desses dados), não ao usuário do Facebook.
 *
 * Só quem conectou pelo login do Facebook é achado: a Página colada à mão não
 * guarda o id de ninguém.
 */
class MessengerFacebookNoticeService {
  static async deauthorize(facebookUserId) {
    const pages = await MessengerPage.updateByFacebookUser(facebookUserId, {
      status: 'error',
      webhook_error: 'facebook_deauthorized'
    });
    return { pages };
  }

  static async eraseUser(facebookUserId, appSecret) {
    const pages = await MessengerPage.updateByFacebookUser(facebookUserId, {
      page_token: null,
      facebook_user_id: null,
      subscribed_at: null,
      status: 'error',
      webhook_error: 'facebook_data_deleted'
    });
    return { pages, confirmationCode: issueConfirmationCode(appSecret) };
  }
}

export default MessengerFacebookNoticeService;
