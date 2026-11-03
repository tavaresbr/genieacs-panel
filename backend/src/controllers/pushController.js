import PushService, { PUSH_EVENTS, EVENT_PERMISSION, PushError } from '../services/pushService.js';
import { roleHas } from '../config/permissions.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * As notificações push do app do provedor (0130) — "Notificações neste
 * aparelho" em Configurações → Segurança. Toda rota é da PESSOA logada, no
 * provedor da sessão: nenhuma recebe id, e nenhuma alcança aparelho de outra
 * pessoa.
 */

/**
 * Só a sessão própria, num provedor. A personificação é o console olhando o
 * provedor: inscrever ali o navegador de quem opera levaria os avisos do
 * cliente para fora dele. A sessão do console não tem provedor em escopo.
 */
function sessaoPropria(req, res) {
  if (req.user?.impersonation || req.user?.platform) {
    res.status(403).json(createErrorResponse(req.t('push.ownSessionOnly'), null, 'push_own_session_only'));
    return false;
  }
  return true;
}

function falha(req, res, error, chave) {
  if (error instanceof PushError && error.status < 500) {
    return res.status(error.status).json(createErrorResponse(req.t(`push.error.${error.code}`), null, error.code));
  }
  console.error(`push ${chave}:`, error?.message || error);
  return res.status(500).json(createErrorResponse(req.t('push.failed'), null, 'push_failed'));
}

/** Os eventos que esta pessoa pode receber, pelo papel. */
function eventosDe(req) {
  return PUSH_EVENTS.filter((evento) => roleHas(req.user?.role, EVENT_PERMISSION[evento]));
}

class PushController {
  /** `GET /api/push/vapid-public-key` — a chave com que o navegador se inscreve. */
  static async vapidPublicKey(req, res) {
    if (!sessaoPropria(req, res)) return undefined;
    try {
      const { publicKey } = await PushService.vapidKeys();
      res.set('Cache-Control', 'no-store');
      return res.json(createResponse(req.t('push.keyRetrieved'), { publicKey }));
    } catch (error) {
      return falha(req, res, error, 'vapid');
    }
  }

  /** `POST /api/push/subscribe` — `{ subscription: PushSubscription.toJSON() }`. */
  static async subscribe(req, res) {
    if (!sessaoPropria(req, res)) return undefined;
    try {
      await PushService.subscribe({
        userId: req.user.userId,
        subscription: req.body?.subscription,
        userAgent: req.get('user-agent') || null,
        locale: req.locale
      });
      return res.status(201).json(createResponse(req.t('push.subscribed'), {
        devices: await PushService.countDevices(req.user.userId)
      }));
    } catch (error) {
      return falha(req, res, error, 'subscribe');
    }
  }

  /** `POST /api/push/unsubscribe` — `{ endpoint }`; só o aparelho DESTA pessoa. */
  static async unsubscribe(req, res) {
    if (!sessaoPropria(req, res)) return undefined;
    try {
      const { removed } = await PushService.unsubscribe({ userId: req.user.userId, endpoint: req.body?.endpoint });
      return res.json(createResponse(req.t('push.unsubscribed'), {
        removed,
        devices: await PushService.countDevices(req.user.userId)
      }));
    } catch (error) {
      return falha(req, res, error, 'unsubscribe');
    }
  }

  /** `POST /api/push/test` — um aviso para os aparelhos de quem pediu, e só deles. */
  static async test(req, res) {
    if (!sessaoPropria(req, res)) return undefined;
    try {
      const resumo = await PushService.sendTest(req.user.userId);
      if (!resumo.sent) {
        return res.status(409).json(createErrorResponse(req.t('push.testNoDevice'), null, 'push_no_device'));
      }
      return res.json(createResponse(req.t('push.testSent'), { sent: resumo.sent }));
    } catch (error) {
      return falha(req, res, error, 'test');
    }
  }

  /**
   * `GET /api/push/preferences` — as escolhas, os eventos que o papel permite
   * e quantos aparelhos a pessoa tem inscritos. Se ESTE navegador está entre
   * eles quem sabe é o próprio navegador (`pushManager.getSubscription`): o
   * endpoint não viaja na URL, que acaba no log.
   */
  static async getPreferences(req, res) {
    if (!sessaoPropria(req, res)) return undefined;
    try {
      return res.json(createResponse(req.t('push.preferencesRetrieved'), {
        events: await PushService.getPreferences(req.user.userId),
        available: eventosDe(req),
        devices: await PushService.countDevices(req.user.userId)
      }));
    } catch (error) {
      return falha(req, res, error, 'preferences');
    }
  }

  /** `PUT /api/push/preferences` — `{ events: { invoice: true, … } }`. */
  static async savePreferences(req, res) {
    if (!sessaoPropria(req, res)) return undefined;
    try {
      const events = await PushService.savePreferences(req.user.userId, req.body?.events);
      return res.json(createResponse(req.t('push.preferencesSaved'), { events, available: eventosDe(req) }));
    } catch (error) {
      return falha(req, res, error, 'preferences');
    }
  }
}

export default PushController;
