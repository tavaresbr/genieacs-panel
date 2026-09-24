import Tenant from '../models/Tenant.js';
import Setting from '../models/Setting.js';
import AuditLog from '../models/AuditLog.js';
import PlatformAudit from '../models/PlatformAudit.js';
import GenieAcsAuthService, { AUTH_TYPES } from '../services/genieacsAuthService.js';
import { suggestGenieAcsUrl } from '../services/genieacsSuggestion.js';
import { runInTenant } from '../config/tenantContext.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { probeGenieAcs } from './settingsController.js';
import { VIRTUAL_PARAMETER_KEYS } from '../config/platformManaged.js';

/**
 * O GenieACS de um provedor, configurado do console.
 *
 * Na SaaS quem hospeda o ACS é a plataforma, então é ela quem diz para onde o
 * painel de cada provedor fala e com que credencial — o provedor vê o status
 * e testa a conexão, mas não grava (ver `config/platformManaged.js`). Os dados
 * continuam onde sempre estiveram, POR PROVEDOR: `settings.genieAcsUrl` e o
 * `app_state` da credencial daquele tenant. O console só escreve lá de fora,
 * dentro do `runInTenant` do alvo, que é o mesmo caminho das outras ações do
 * plano de controle sobre um provedor.
 *
 * Mensagens em inglês e sem tradução, como o resto do console.
 */

async function loadTarget(req, res) {
  const id = Number(req.params?.id);
  if (!Number.isInteger(id) || id <= 0) {
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

/** `''` apaga; qualquer outra coisa tem que ser um endereço HTTP(S) sem credencial. */
function urlProblem(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.length > 2048) return 'URL is too long';
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'URL is not valid';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'URL must be http or https';
  if (url.username || url.password) return 'URL must not carry credentials';
  return null;
}

/**
 * `{ vpRxPower: 'VirtualParameters.X', … }` lido do corpo, ou o erro. Só as
 * chaves conhecidas; vazio é permitido (os dois campos opcionais da tela).
 */
function readVirtualParameters(raw) {
  if (raw === undefined) return { value: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'virtualParameters must be an object' };
  }
  const value = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!VIRTUAL_PARAMETER_KEYS.includes(key)) return { error: `Unknown virtual parameter: ${key}` };
    const text = String(v ?? '').trim();
    if (text.length > 255) return { error: `${key} is too long` };
    value[key] = text;
  }
  return { value };
}

async function snapshot(tenant) {
  return runInTenant(tenant.id, async () => ({
    virtualParameters: Object.fromEntries(await Promise.all(
      VIRTUAL_PARAMETER_KEYS.map(async (key) => [key, (await Setting.getByKey(key)) ?? ''])
    )),
    url: (await Setting.getByKey('genieAcsUrl')) || '',
    auth: await GenieAcsAuthService.getPublicConfig(),
    suggestion: suggestGenieAcsUrl(tenant)
  }));
}

class PlatformGenieAcsController {
  /** `GET /api/platform/tenants/:id/genieacs` — endereço, credencial sem segredo, sugestão. */
  static async get(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      return res.json(createResponse('GenieACS configuration retrieved', await snapshot(tenant)));
    } catch (error) {
      console.error('Platform GenieACS read error:', error);
      return res.status(500).json(createErrorResponse('Internal server error', error.message));
    }
  }

  /**
   * `PUT /api/platform/tenants/:id/genieacs` — `{ url?, authType?, username?, secret?, virtualParameters? }`.
   *
   * Campo ausente mantém o que está lá, e `secret` segue a regra da tela do
   * provedor: `undefined` mantém, `''` apaga.
   */
  static async update(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;

      const corpo = req.body ?? {};
      const mandouUrl = corpo.url !== undefined;
      if (mandouUrl) {
        const problem = urlProblem(corpo.url);
        if (problem) return res.status(400).json(createErrorResponse(problem));
      }
      if (corpo.authType !== undefined && !AUTH_TYPES.includes(corpo.authType)) {
        return res.status(400).json(createErrorResponse(`authType must be one of ${AUTH_TYPES.join(', ')}`));
      }
      const mandouAuth = ['authType', 'username', 'secret'].some((k) => corpo[k] !== undefined);
      const vps = readVirtualParameters(corpo.virtualParameters);
      if (vps.error) return res.status(400).json(createErrorResponse(vps.error));

      const antes = await snapshot(tenant);
      const tipoFinal = corpo.authType ?? antes.auth.authType;
      const usuarioFinal = corpo.username === undefined ? antes.auth.username : String(corpo.username).trim();
      if (mandouAuth && tipoFinal === 'basic' && !usuarioFinal) {
        return res.status(400).json(createErrorResponse('Basic authentication needs a username'));
      }

      const urlNova = mandouUrl ? String(corpo.url).trim() : antes.url;
      const mudouUrl = mandouUrl && urlNova !== antes.url;
      const vpsMudados = vps.value
        ? Object.entries(vps.value).filter(([key, v]) => v !== antes.virtualParameters[key])
        : [];

      await runInTenant(tenant.id, async () => {
        if (mudouUrl) await Setting.upsert('genieAcsUrl', urlNova);
        for (const [key, v] of vpsMudados) await Setting.upsert(key, v);
        if (mandouAuth) {
          await GenieAcsAuthService.saveConfig({
            authType: corpo.authType,
            username: corpo.username,
            secret: corpo.secret
          });
        }
      });
      const depois = await snapshot(tenant);

      if (!mudouUrl && !mandouAuth && vpsMudados.length === 0) {
        return res.json(createResponse('GenieACS configuration unchanged', depois));
      }

      // O segredo não entra em trilha nenhuma — o que entra é que a credencial
      // mudou, para qual tipo e se passou a existir uma, a mesma regra da tela
      // do provedor.
      const detail = {};
      if (mudouUrl) detail.url = { from: antes.url || null, to: urlNova || null };
      if (vpsMudados.length) {
        detail.virtualParameters = Object.fromEntries(
          vpsMudados.map(([key, v]) => [key, { from: antes.virtualParameters[key] || null, to: v || null }])
        );
      }
      if (mandouAuth) {
        detail.auth = {
          authType: depois.auth.authType,
          username: depois.auth.username,
          secretConfigured: depois.auth.secretConfigured
        };
      }
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_GENIEACS_CHANGED,
        tenant,
        detail
      });
      // E na trilha DELE: quem vai perguntar "por que o painel parou de achar
      // as ONTs" é o provedor, e ele não lê a nossa.
      if (mudouUrl) {
        await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_URL_CHANGED,
          actorKind: 'platform',
          subjectType: 'settings',
          subjectId: 'genieAcsUrl',
          detail: { url: urlNova }
        }));
      }
      if (mandouAuth) {
        await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_AUTH_CHANGED,
          actorKind: 'platform',
          subjectType: 'settings',
          subjectId: 'genieacs-auth',
          detail: detail.auth
        }));
      }

      return res.json(createResponse('GenieACS configuration updated', depois));
    } catch (error) {
      console.error('Platform GenieACS update error:', error);
      return res.status(500).json(createErrorResponse('Internal server error', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/genieacs/test` — `{ url? }`, o gravado quando ausente.
   *
   * O mesmo teste da tela do provedor, rodando no escopo dele: a credencial
   * guardada só acompanha quando o endereço testado é a origem já salva.
   */
  static async test(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      const { status, body } = await runInTenant(tenant.id, async () => {
        const url = req.body?.url ?? (await Setting.getByKey('genieAcsUrl'));
        return probeGenieAcs(req.t, url);
      });
      return res.status(status).json(body);
    } catch (error) {
      console.error('Platform GenieACS test error:', error);
      return res.status(500).json(createErrorResponse('Internal server error', error.message));
    }
  }
}

export default PlatformGenieAcsController;
