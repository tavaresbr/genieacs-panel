import Addon, { ADDON_KINDS, ADDON_LIMIT_RESOURCES, normalizeAddonCode } from '../models/Addon.js';
import PlatformAudit from '../models/PlatformAudit.js';
import Tenant from '../models/Tenant.js';
import AddonService, { presentAddon } from '../services/addonService.js';
import { TranslatableError, translateError } from '../i18n/index.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { recordBoth } from './platformBillingController.js';

/**
 * Os add-ons pagos no console (0127): o catálogo (criar, listar com o uso,
 * mudar, apagar o que nunca foi contratado) e os add-ons de UM provedor — dar
 * de graça e revogar, os dois com motivo e nas duas trilhas.
 *
 * O que NÃO muda depois de criado: código, tipo, recurso e o teto que soma.
 * São o que a fatura e o direito de quem já contratou nomeiam; um add-on
 * diferente é um add-on novo. O preço muda — e vale da PRÓXIMA fatura de
 * cada um em diante (a que já saiu fica como está); o reajuste com aviso
 * (0122) é só dos planos.
 */

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const FEATURE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
/** Um teto de bom senso para o preço: R$ 100.000,00. */
const PRICE_MAX_CENTS = 10_000_000;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const recusa = (res, message, code = null, status = 400) => res.status(status).json(createErrorResponse(message, null, code));

/** Centavos ≥ 0, ou nulo quando `nullable` e vazio, ou erro. */
function parseCents(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > PRICE_MAX_CENTS) return { ok: false };
  return { ok: true, value: n };
}

const textoOuNulo = (value, max) => {
  const texto = String(value ?? '').trim();
  return texto ? texto.slice(0, max) : null;
};

async function tenantOr404(req, res) {
  const id = parseId(req.params?.id);
  if (!id) {
    res.status(400).json(createErrorResponse('Invalid provider id'));
    return null;
  }
  const tenant = await Tenant.findById(id);
  if (!tenant || tenant.kind === 'platform') {
    res.status(404).json(createErrorResponse('Provider not found'));
    return null;
  }
  return tenant;
}

/** Os campos que mudam, lidos do corpo — comuns à criação e à edição. */
function lerMutaveis(body, patch) {
  if (body.name !== undefined) {
    const nome = textoOuNulo(body.name, 64);
    if (!nome) return 'name is required';
    patch.name = nome;
  }
  if (body.description !== undefined) patch.description = textoOuNulo(body.description, 500);
  if (body.priceCents !== undefined) {
    const preco = parseCents(body.priceCents);
    if (!preco.ok) return 'priceCents must be a non-negative integer of cents';
    patch.price_cents = preco.value;
  }
  if (body.priceYearlyCents !== undefined) {
    const anual = parseCents(body.priceYearlyCents, { nullable: true });
    if (!anual.ok) return 'priceYearlyCents must be a non-negative integer of cents, or null';
    patch.price_yearly_cents = anual.value;
  }
  for (const [campo, coluna] of [['gated', 'gated'], ['trialAccess', 'trial_access'], ['active', 'active'], ['public', 'public']]) {
    if (body[campo] === undefined) continue;
    if (typeof body[campo] !== 'boolean') return `${campo} must be true or false`;
    patch[coluna] = body[campo];
  }
  if (body.sort !== undefined) {
    const ordem = Number(body.sort);
    if (!Number.isInteger(ordem) || Math.abs(ordem) > 100_000) return 'sort must be an integer';
    patch.sort = ordem;
  }
  return null;
}

class PlatformAddonsController {
  /**
   * `GET /api/platform/addons` — o catálogo, com quantos provedores têm cada
   * um ativo e, no de recurso, quantos PERDERIAM o acesso com a porta ligada
   * (`gateImpactCount`, o aviso do console antes de ligar `gated`).
   */
  static async list(req, res) {
    try {
      const [addons, uso] = await Promise.all([Addon.list(), Addon.activeUsage()]);
      const impacto = await Addon.gateImpact(addons);
      return res.json(createResponse('Add-ons retrieved', {
        addons: addons.map((addon) => ({
          ...presentAddon(addon),
          activeCount: uso.get(Number(addon.id)) ?? 0,
          gateImpactCount: impacto.has(Number(addon.id)) ? impacto.get(Number(addon.id)) : null
        }))
      }));
    } catch (error) {
      console.error('List add-ons (console) error:', error);
      return res.status(500).json(createErrorResponse('Failed to list add-ons', error.message));
    }
  }

  /**
   * `POST /api/platform/addons` — `{ code, name, description?, priceCents,
   * priceYearlyCents?, kind, feature? | limitResource + limitAmount, gated?,
   * trialAccess?, active?, public?, sort? }`.
   */
  static async create(req, res) {
    try {
      const body = req.body ?? {};
      const code = normalizeAddonCode(body.code);
      if (!CODE_PATTERN.test(code)) return recusa(res, 'code must be 2 to 32 lowercase letters, digits, hyphens or underscores');
      if (!ADDON_KINDS.includes(body.kind)) return recusa(res, `kind must be one of: ${ADDON_KINDS.join(', ')}`);
      const linha = { code, kind: body.kind, currency: 'BRL' };
      if (body.name === undefined) return recusa(res, 'name is required');
      if (body.priceCents === undefined) return recusa(res, 'priceCents is required');
      const erro = lerMutaveis(body, linha);
      if (erro) return recusa(res, erro);
      if (body.kind === 'feature') {
        const feature = String(body.feature ?? '').trim().toLowerCase();
        if (!FEATURE_PATTERN.test(feature)) return recusa(res, 'feature is required for a feature add-on (e.g. whatsapp, ai)');
        linha.feature = feature;
      } else {
        if (!ADDON_LIMIT_RESOURCES.includes(body.limitResource)) {
          return recusa(res, `limitResource must be one of: ${ADDON_LIMIT_RESOURCES.join(', ')}`);
        }
        const quanto = Number(body.limitAmount);
        if (!Number.isInteger(quanto) || quanto < 1 || quanto > 1_000_000) return recusa(res, 'limitAmount must be a positive integer');
        linha.limit_resource = body.limitResource;
        linha.limit_amount = quanto;
        // Um add-on de limite não fecha recurso nenhum.
        linha.gated = false;
      }
      if (await Addon.findByCode(code)) return recusa(res, 'Add-on code already taken', 'addon_code_taken', 409);
      const addon = await Addon.create(linha);
      AddonService.invalidateCatalog();
      const apresentado = presentAddon(addon);
      await PlatformAudit.fromRequest(req, { action: PlatformAudit.ACTIONS.ADDON_CREATED, detail: apresentado });
      return res.status(201).json(createResponse('Add-on created', { addon: apresentado }));
    } catch (error) {
      console.error('Create add-on error:', error);
      return res.status(500).json(createErrorResponse('Failed to create the add-on', error.message));
    }
  }

  /** `PATCH /api/platform/addons/:id` — preço, textos, `gated`, `trialAccess`, `active`, `public`, `sort`. */
  static async update(req, res) {
    try {
      const id = parseId(req.params?.id);
      if (!id) return recusa(res, 'Invalid add-on id');
      const addon = await Addon.findById(id);
      if (!addon) return recusa(res, 'Add-on not found', null, 404);
      const body = req.body ?? {};
      const imutaveis = ['code', 'kind', 'feature', 'limitResource', 'limitAmount'].filter((k) => body[k] !== undefined);
      if (imutaveis.length) {
        return recusa(res, `These fields cannot change after creation: ${imutaveis.join(', ')}`, 'addon_immutable');
      }
      const patch = {};
      const erro = lerMutaveis(body, patch);
      if (erro) return recusa(res, erro);
      if (addon.kind === 'limit' && patch.gated) return recusa(res, 'A limit add-on cannot gate a feature');
      if (!Object.keys(patch).length) return recusa(res, 'Nothing to update');
      const depois = await Addon.update(id, patch);
      AddonService.invalidateCatalog();
      const apresentado = presentAddon(depois);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.ADDON_UPDATED,
        detail: { id, code: addon.code, before: presentAddon(addon), after: apresentado }
      });
      return res.json(createResponse('Add-on updated', { addon: apresentado }));
    } catch (error) {
      console.error('Update add-on error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the add-on', error.message));
    }
  }

  /** `DELETE /api/platform/addons/:id` — só o que nunca foi contratado (409 `addon_in_use`: desative). */
  static async remove(req, res) {
    try {
      const id = parseId(req.params?.id);
      if (!id) return recusa(res, 'Invalid add-on id');
      const addon = await Addon.findById(id);
      if (!addon) return recusa(res, 'Add-on not found', null, 404);
      if (!(await Addon.deleteIfUnused(id))) {
        return recusa(res, 'This add-on was already contracted; deactivate it instead', 'addon_in_use', 409);
      }
      AddonService.invalidateCatalog();
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.ADDON_DELETED, detail: { id, code: addon.code }
      });
      return res.json(createResponse('Add-on deleted', { id }));
    } catch (error) {
      console.error('Delete add-on error:', error);
      return res.status(500).json(createErrorResponse('Failed to delete the add-on', error.message));
    }
  }

  /** `GET /api/platform/tenants/:id/addons` — os add-ons de um provedor e o catálogo. */
  static async forTenant(req, res) {
    try {
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      return res.json(createResponse('Provider add-ons retrieved', await AddonService.presentForConsole(tenant.id)));
    } catch (error) {
      console.error('Provider add-ons (console) error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the provider add-ons', error.message));
    }
  }

  /** `POST /api/platform/tenants/:id/addons` — `{ code, reason }`: dá o add-on de graça. */
  static async grant(req, res) {
    return PlatformAddonsController.gesto(req, res, 'grant');
  }

  /** `POST /api/platform/tenants/:id/addons/:code/revoke` — `{ reason }`: tira na hora, sem estorno. */
  static async revoke(req, res) {
    return PlatformAddonsController.gesto(req, res, 'revoke');
  }

  static async gesto(req, res, qual) {
    try {
      const reason = String(req.body?.reason ?? '').trim().slice(0, 255);
      if (!reason) return res.status(400).json(createErrorResponse('A reason is required', null, 'reason_required'));
      const code = qual === 'grant' ? req.body?.code : req.params?.code;
      if (!code || typeof code !== 'string') return recusa(res, 'code is required');
      const tenant = await tenantOr404(req, res);
      if (!tenant) return undefined;
      let resultado;
      try {
        resultado = qual === 'grant'
          ? await AddonService.grant({ tenantId: tenant.id, code, reason, actorUserId: req.user?.userId ?? null })
          : await AddonService.revoke({ tenantId: tenant.id, code, reason, actorUserId: req.user?.userId ?? null });
      } catch (error) {
        if (error instanceof TranslatableError) {
          return res.status(error.status || 400).json(createErrorResponse(translateError(req.t, error), error.detail ?? null, error.code));
        }
        throw error;
      }
      if (!resultado.already) {
        await recordBoth(req, tenant, {
          platformAction: PlatformAudit.ACTIONS.TENANT_ADDON_CHANGED,
          detail: {
            action: qual === 'grant' ? 'granted' : 'revoked',
            addon: resultado.addon.code,
            reason,
            ...(resultado.charge && resultado.charge !== 'none' ? { openCharge: resultado.charge } : {})
          }
        });
      }
      return res.status(qual === 'grant' && !resultado.already ? 201 : 200).json(createResponse(
        qual === 'grant' ? 'Add-on granted' : 'Add-on revoked',
        await AddonService.presentForConsole(tenant.id)
      ));
    } catch (error) {
      console.error(`Add-on ${qual} error:`, error);
      return res.status(500).json(createErrorResponse('Failed to change the provider add-on', error.message));
    }
  }
}

export default PlatformAddonsController;
