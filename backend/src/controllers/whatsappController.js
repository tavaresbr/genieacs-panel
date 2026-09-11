import WhatsAppConfigService, { WaError } from '../services/whatsappConfigService.js';
import EvolutionInstanceService from '../services/evolutionInstanceService.js';
import WaHealthService from '../services/waHealthService.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

export function handleError(req, res, error, fallbackKey) {
  if (error instanceof WaError) {
    // The code lets the UI tell "the integration is off" from "the server
    // refused" without dumping the Evolution response at the operator.
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class WhatsAppController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.configLoaded'),
        await WhatsAppConfigService.getPublicConfig()
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configLoadFailed');
    }
  }

  static async updateConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await WhatsAppConfigService.saveConfig({
        enabled: body.enabled,
        allowedHosts: body.allowedHosts,
        webhookBaseUrl: body.webhookBaseUrl,
        rejectCallMessage: body.rejectCallMessage,
        portalPublicUrl: body.portalPublicUrl,
        rateLimitPerMin: body.rateLimitPerMin,
        mediaRetentionDays: body.mediaRetentionDays,
        messageRetentionDays: body.messageRetentionDays,
        managedUrl: body.managedUrl,
        // An absent key keeps the stored one; "" clears it.
        managedAdminKey: body.managedAdminKey === undefined ? undefined : body.managedAdminKey
      });
      return res.json(createResponse(req.t('whatsapp.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.configSaveFailed');
    }
  }

  static async listAccounts(req, res) {
    try {
      const rows = await WhatsAppAccount.getAll();
      return res.json(createResponse(
        req.t('whatsapp.accountsLoaded', { count: rows.length }),
        rows.map((row) => WhatsAppConfigService.publicAccount(row))
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountsLoadFailed');
    }
  }

  static async createAccount(req, res) {
    try {
      const body = req.body ?? {};
      const { account, qr, pending } = await EvolutionInstanceService.createAccount({
        // Both are ignored in managed mode, where the panel owns the server and
        // the operator never sees its address or its key.
        baseUrl: body.baseUrl,
        adminKey: body.adminKey,
        label: body.label,
        purpose: body.purpose
      });
      return res.status(201).json(createResponse(req.t('whatsapp.accountConnecting'), {
        account: WhatsAppConfigService.publicAccount(account),
        qr,
        pending
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async getQr(req, res) {
    try {
      const { account, qr, pending } = await EvolutionInstanceService.refreshQr(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.qrReady'), {
        account: WhatsAppConfigService.publicAccount(account),
        qr,
        pending
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async getStatus(req, res) {
    try {
      const { account, state } = await EvolutionInstanceService.checkStatus(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.statusChecked'), {
        account: WhatsAppConfigService.publicAccount(account),
        // What the server said, which is not always what was stored: a
        // `disconnected` on a number still pairing is reported and not written.
        state
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async restartAccount(req, res) {
    try {
      const { account } = await EvolutionInstanceService.restart(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.accountConnecting'), {
        account: WhatsAppConfigService.publicAccount(account)
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * O que o servidor Evolution diz que o webhook desta conta é.
   *
   * Leitura, e é por isso que exige só `whatsapp.read`: quem está de plantão
   * olhando por que nada chega não devia precisar da permissão que cria e
   * apaga número para descobrir a causa.
   */
  static async checkWebhook(req, res) {
    try {
      const resultado = await EvolutionInstanceService.inspectWebhook(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.webhookChecked'), {
        account: WhatsAppConfigService.publicAccount(resultado.account),
        verdict: resultado.verdict,
        supported: resultado.supported,
        serverUrl: resultado.serverUrl
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /** Reescreve o webhook no servidor, e confere lendo de volta. */
  static async reapplyWebhook(req, res) {
    try {
      const resultado = await EvolutionInstanceService.reapplyWebhook(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.webhookReapplied'), {
        account: WhatsAppConfigService.publicAccount(resultado.account),
        verdict: resultado.verdict,
        supported: resultado.supported,
        serverUrl: resultado.serverUrl
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * A volta: o painel se chama pela porta da frente.
   *
   * `whatsapp.config` e não `whatsapp.read`, ao contrário da conferência: esta
   * FAZ o painel emitir uma requisição para um endereço escolhido por quem
   * administra. É a mesma permissão que já decide para qual servidor Evolution
   * o painel fala.
   */
  static async probeWebhook(req, res) {
    try {
      const resultado = await EvolutionInstanceService.probeWebhook(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.webhookProbed'), {
        account: WhatsAppConfigService.publicAccount(resultado.account),
        verdict: resultado.verdict,
        status: resultado.status
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async disconnectAccount(req, res) {
    try {
      const { account } = await EvolutionInstanceService.disconnect(req.params?.id);
      return res.json(createResponse(req.t('whatsapp.disconnected'), {
        account: WhatsAppConfigService.publicAccount(account)
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async deleteAccount(req, res) {
    try {
      const result = await EvolutionInstanceService.remove(req.params?.id, {
        adminKey: req.body?.adminKey
      });
      // Success even when the server refused: the row is gone either way, and
      // `serverError` is how the operator learns an instance was left running.
      return res.json(createResponse(req.t('whatsapp.accountDeleted'), result));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  static async updateAccount(req, res) {
    try {
      const body = req.body ?? {};
      const account = await EvolutionInstanceService.updateAccount(req.params?.id, {
        label: body.label,
        purpose: body.purpose,
        isDefault: body.isDefault
      });
      return res.json(createResponse(req.t('whatsapp.accountUpdated'), {
        account: WhatsAppConfigService.publicAccount(account)
      }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }

  /**
   * "Is this working?" — the whole integration in one payload.
   *
   * Shaped exactly as `docs/whatsapp-api-contract.md` freezes it, and returned
   * whole or not at all: a strip that renders half the truth is worse than one
   * that says it could not read, because a missing queue reads as an empty one.
   */
  static async getHealth(req, res) {
    try {
      return res.json(createResponse(
        req.t('whatsapp.healthLoaded'),
        await WaHealthService.read()
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.healthLoadFailed');
    }
  }

  static async checkNumbers(req, res) {
    try {
      const results = await EvolutionInstanceService.checkNumbers(req.body?.numbers);
      return res.json(createResponse(
        req.t('whatsapp.numbersChecked', { count: results.length }),
        results
      ));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.accountActionFailed');
    }
  }
}

export default WhatsAppController;
