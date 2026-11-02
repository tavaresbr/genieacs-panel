import PlatformAudit from '../models/PlatformAudit.js';
import StatusService, { StatusError } from '../services/statusService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * A página de status (0127) — ver `statusService`.
 *
 * Duas portas. A pública (`GET /api/public/status`) é a página `/status`, sem
 * sessão, guardada por 30 s e sem nada de dentro. A do console
 * (`/api/platform/status...`) lê as verificações com o detalhe, abre, muda e
 * encerra incidentes e manutenções — e cada gesto vai para a trilha da
 * plataforma.
 */

const MENSAGENS = Object.freeze({
  not_found: 'Incident not found',
  already_resolved: 'This incident is already resolved',
  nothing_to_change: 'Nothing to change',
  invalid_kind: 'kind must be incident or maintenance',
  invalid_title: 'title must have 3 to 160 characters',
  invalid_message: 'message must have 1 to 2000 characters',
  invalid_components: 'components must list panel, payments, whatsapp or genieacs',
  invalid_impact: 'impact must be none, minor, major or critical',
  invalid_status: 'status is not valid for this kind of incident',
  invalid_notify: 'notifyProviders must be a boolean',
  invalid_window: 'a maintenance needs startsAt and an endsAt after it, in the future',
  invalid_startsAt: 'startsAt must be a date, not in the future',
  invalid_endsAt: 'endsAt must be a date'
});

function responderErro(res, error, fallback) {
  if (error instanceof StatusError) {
    return res.status(error.status).json(createErrorResponse(MENSAGENS[error.code] ?? 'Invalid request', null, error.code));
  }
  console.error(`${fallback}:`, error);
  return res.status(500).json(createErrorResponse(fallback));
}

class StatusController {
  /** `GET /api/public/status` — a página pública. */
  static async publicStatus(req, res) {
    try {
      res.set('Cache-Control', 'public, max-age=30');
      return res.json(createResponse('Status', await StatusService.publicView()));
    } catch (error) {
      // Nem a mensagem do erro: a página pública não diz nada de dentro.
      console.error('Public status error:', error);
      return res.status(503).json(createErrorResponse('Status unavailable', null, 'unavailable'));
    }
  }

  /** `GET /api/platform/status` — as verificações com o detalhe e os incidentes recentes. */
  static async overview(req, res) {
    try {
      return res.json(createResponse('Status', await StatusService.consoleView()));
    } catch (error) {
      return responderErro(res, error, 'Failed to read the status');
    }
  }

  /** `POST /api/platform/status/checks` — roda as verificações agora, fora da volta do agendador. */
  static async runChecks(req, res) {
    try {
      await StatusService.runChecks();
      return res.json(createResponse('Checks ran', await StatusService.consoleView()));
    } catch (error) {
      return responderErro(res, error, 'Failed to run the checks');
    }
  }

  /** `POST /api/platform/status/incidents` — abre um incidente ou agenda uma manutenção. */
  static async create(req, res) {
    try {
      const incident = await StatusService.createIncident(req.body ?? {}, { userId: req.user?.userId ?? null });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.STATUS_INCIDENT_CREATED,
        detail: {
          incidentId: incident.id, kind: incident.kind, impact: incident.impact, status: incident.status,
          components: incident.components, notifyProviders: incident.notifyProviders, title: incident.title
        }
      });
      return res.status(201).json(createResponse('Incident created', { incident }));
    } catch (error) {
      return responderErro(res, error, 'Failed to create the incident');
    }
  }

  /** `PATCH /api/platform/status/incidents/:id` — título, componentes, impacto, janela, aviso. */
  static async update(req, res) {
    try {
      const { incident, changed } = await StatusService.updateIncident(req.params.id, req.body ?? {});
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.STATUS_INCIDENT_UPDATED,
        detail: {
          incidentId: incident.id, changed, impact: incident.impact, components: incident.components,
          notifyProviders: incident.notifyProviders
        }
      });
      return res.json(createResponse('Incident updated', { incident }));
    } catch (error) {
      return responderErro(res, error, 'Failed to update the incident');
    }
  }

  /** `POST /api/platform/status/incidents/:id/updates` — `{ status, message }`; `resolved` encerra. */
  static async postUpdate(req, res) {
    try {
      const { incident, resolved, previousStatus } = await StatusService.postUpdate(
        req.params.id, req.body ?? {}, { userId: req.user?.userId ?? null }
      );
      await PlatformAudit.fromRequest(req, {
        action: resolved ? PlatformAudit.ACTIONS.STATUS_INCIDENT_RESOLVED : PlatformAudit.ACTIONS.STATUS_INCIDENT_POSTED,
        detail: { incidentId: incident.id, kind: incident.kind, from: previousStatus, to: incident.status }
      });
      return res.status(201).json(createResponse('Update posted', { incident }));
    } catch (error) {
      return responderErro(res, error, 'Failed to post the update');
    }
  }
}

export default StatusController;
