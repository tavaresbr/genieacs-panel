import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import NpsService from '../services/npsService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * A pesquisa de satisfação dos provedores (0123) — ver `npsService`.
 *
 * Duas portas. A pública (`/api/public/nps/lookup` e `/answer`) é a página do
 * link, sem sessão: o token vai no CORPO, nunca no caminho, e token
 * desconhecido responde 404 sem nada — nem se existiu, nem de quem é. A do
 * console (`/api/platform/reports/nps` e `/tenants/:id/nps`) é o relatório e o
 * "Enviar pesquisa", que vai para a trilha da plataforma.
 */

/** Os erros do serviço, em status e código. */
const ERROS = Object.freeze({
  not_found: [404, 'Survey not found'],
  expired: [410, 'This survey has expired'],
  already_answered: [409, 'This survey was already answered and can no longer be changed'],
  invalid_score: [400, 'score must be an integer from 0 to 10']
});

function responderErro(res, codigo) {
  const [status, mensagem] = ERROS[codigo] ?? [400, 'Invalid request'];
  return res.status(status).json(createErrorResponse(mensagem, null, codigo));
}

class NpsController {
  /** `POST /api/public/nps/lookup` — `{ token }`. Só lê; POST para o token não ir ao log. */
  static async lookup(req, res) {
    try {
      const resultado = await NpsService.lookup(req.body?.token);
      if (resultado.error) return responderErro(res, resultado.error);
      return res.json(createResponse('Survey', resultado.view));
    } catch (error) {
      console.error('NPS lookup error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the survey'));
    }
  }

  /** `POST /api/public/nps/answer` — `{ token, score, comment? }`. */
  static async answer(req, res) {
    try {
      const body = req.body ?? {};
      const resultado = await NpsService.answer(body.token, { score: body.score, comment: body.comment });
      if (resultado.error) return responderErro(res, resultado.error);
      return res.json(createResponse('Answer saved', resultado.view));
    } catch (error) {
      console.error('NPS answer error:', error);
      return res.status(500).json(createErrorResponse('Failed to save the answer'));
    }
  }

  /** `GET /api/platform/reports/nps?from=YYYY-MM-DD`. */
  static async report(req, res) {
    try {
      const bruto = req.query?.from;
      let from = null;
      if (bruto !== undefined && bruto !== '') {
        if (typeof bruto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(bruto) || Number.isNaN(Date.parse(`${bruto}T00:00:00Z`))) {
          return res.status(400).json(createErrorResponse('from must be a date (YYYY-MM-DD)', null, 'invalid_from'));
        }
        from = bruto;
      }
      return res.json(createResponse('NPS report retrieved', await NpsService.report({ from })));
    } catch (error) {
      console.error('NPS report error:', error);
      return res.status(500).json(createErrorResponse('Failed to build the NPS report', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/nps` — o "Enviar pesquisa" do console.
   * 404 para quem não existe e para a caixa da plataforma; 409 `recent` com
   * uma manual pendente da última semana; 409 `no_destination` sem e-mail nem
   * telefone; 409 `no_link` sem endereço público; 502 `send_failed`.
   */
  static async sendManual(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json(createErrorResponse('Invalid provider id'));
      const tenant = await Tenant.findById(id);
      if (!tenant || tenant.kind === 'platform') return res.status(404).json(createErrorResponse('Provider not found'));
      const resultado = await NpsService.sendManual(tenant, { userId: req.user?.userId ?? null });
      if (!resultado.sent) {
        const status = resultado.reason === 'send_failed' ? 502 : 409;
        return res.status(status).json(createErrorResponse('The survey was not sent', null, resultado.reason));
      }
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_NPS_SENT,
        tenant,
        detail: { wave: 'manual', surveyId: resultado.id, channels: resultado.channels }
      });
      return res.status(201).json(createResponse('Survey sent', { id: resultado.id, channels: resultado.channels }));
    } catch (error) {
      console.error('NPS manual send error:', error);
      return res.status(500).json(createErrorResponse('Failed to send the survey', error.message));
    }
  }
}

export default NpsController;
