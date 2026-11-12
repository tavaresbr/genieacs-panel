import WaAiKnowledgeService from '../services/waAiKnowledgeService.js';
import WaAiService from '../services/waAiService.js';
import { aiError } from './whatsappController.js';
import AuditLog from '../models/AuditLog.js';
import { WaError } from '../services/whatsappConfigService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

function handleError(req, res, error) {
  if (error instanceof WaError) {
    return res.status(error.status).json({ ...createErrorResponse(translateError(req.t, error), error.details || error.code), code: error.code });
  }
  console.error(`[wa] base de conhecimento: ${error?.code || error?.message}`);
  return res.status(500).json(createErrorResponse(req.t('whatsapp.aiKnowledge.saveFailed')));
}

const auditar = (req, op, item) => AuditLog.fromRequest(req, {
  action: AuditLog.ACTIONS.WHATSAPP_AI_KNOWLEDGE_CHANGED,
  subjectType: 'ai_knowledge',
  subjectId: item?.id != null ? String(item.id) : null,
  detail: { op, kind: item?.kind ?? null, title: item?.title ?? null, active: item?.active ?? null }
});

class WhatsAppAiKnowledgeController {
  static async list(req, res) {
    try {
      const itens = await WaAiKnowledgeService.list();
      return res.json(createResponse(req.t('whatsapp.aiKnowledge.loaded', { count: itens.length }), itens));
    } catch (error) { return handleError(req, res, error); }
  }

  /** `POST /api/whatsapp/ai-knowledge/ai-draft` — a IA escreve (ou melhora) a resposta; nada é gravado. */
  static async draft(req, res) {
    try {
      const body = req.body ?? {};
      const resultado = await WaAiService.draftKnowledge({ kind: body.kind, title: body.title, triggers: body.triggers, current: body.current });
      // Só que a IA foi usada, e para qual tipo; o texto nunca vai para a Trilha.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_AI_KNOWLEDGE_CHANGED,
        subjectType: 'ai_knowledge',
        subjectId: null,
        detail: { op: 'ai_draft', kind: String(body.kind ?? '').slice(0, 16), improved: Boolean(String(body.current ?? '').trim()) }
      });
      return res.json(createResponse(req.t('whatsapp.ai.improveOk'), resultado));
    } catch (error) {
      return aiError(req, res, error);
    }
  }

  static async create(req, res) {
    try {
      const item = await WaAiKnowledgeService.create(req.body);
      await auditar(req, 'create', item);
      return res.status(201).json(createResponse(req.t('whatsapp.aiKnowledge.created'), item));
    } catch (error) { return handleError(req, res, error); }
  }

  static async update(req, res) {
    try {
      const item = await WaAiKnowledgeService.update(Number(req.params.id), req.body);
      await auditar(req, 'update', item);
      return res.json(createResponse(req.t('whatsapp.aiKnowledge.updated'), item));
    } catch (error) { return handleError(req, res, error); }
  }

  static async remove(req, res) {
    try {
      await WaAiKnowledgeService.remove(Number(req.params.id));
      await auditar(req, 'delete', { id: req.params.id });
      return res.json(createResponse(req.t('whatsapp.aiKnowledge.deleted'), null));
    } catch (error) { return handleError(req, res, error); }
  }
}

export default WhatsAppAiKnowledgeController;
