import AuditLog from '../models/AuditLog.js';
import Setting from '../models/Setting.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';
import CustomerService from '../services/customerService.js';
import DeviceService from '../services/deviceService.js';
import GenieAcsEgress, { EGRESS_REFUSED } from '../services/genieacsEgress.js';
import GenieAcsAuthService, { AUTH_TYPES } from '../services/genieacsAuthService.js';
import Tenant from '../models/Tenant.js';
import { suggestGenieAcsUrl } from '../services/genieacsSuggestion.js';
import { currentTenantId } from '../config/tenantContext.js';
import CustomerAccount from '../models/CustomerAccount.js';
import { PLATFORM_MANAGED_SETTING_KEYS, platformManagesCurrentTenant } from '../config/platformManaged.js';
import SubscriptionService from '../services/subscriptionService.js';

/**
 * O prazo da trilha acima do teto do plano é recusado com 422, e não cortado
 * em silêncio: o provedor precisa ver que o número dele não é o que vai valer.
 * `null` quando está dentro do teto, ou quando não há teto.
 */
async function auditRetentionAboveCap(key, value) {
  if (key !== 'auditRetentionDays') return null;
  const { audit } = await SubscriptionService.retentionCaps();
  if (audit === null) return null;
  return Number.parseInt(String(value), 10) > audit ? audit : null;
}

/**
 * A recusa de quando o provedor tenta gravar o que é da plataforma. 403 com um
 * código que a tela reconhece: não é validação errada, é a porta errada — a
 * mudança existe, só que é feita no console.
 */
function platformManagedResponse(req, res) {
  return res.status(403).json(
    createErrorResponse(req.t('settings.platformManaged'), null, 'platform_managed')
  );
}

async function refusesPlatformKey(key) {
  return PLATFORM_MANAGED_SETTING_KEYS.includes(String(key)) && platformManagesCurrentTenant();
}

const ALLOWED_SETTING_KEYS = new Set([
  'appName',
  'genieAcsUrl',
  'autoGenerateCustomerId',
  'customerIdPrefixMode',
  'customerIdCompanyPrefix',
  'customerIdSuffixMode',
  'vpPppoeUsername',
  'vpWanBridge',
  'vpRxPower',
  'vpTemperature',
  'vpActiveDevices',
  'vpSuperAdmin',
  'vpSuperPassword',
  'vpUserAdmin',
  'vpUserPassword',
  // Por quantos dias a trilha de auditoria é guardada. Era uma constante no
  // agendador: um ano para todo mundo, sem tela e sem como saber que existia.
  // Um ISP em disputa precisa de mais, e um que resolveu guardar menos dado
  // pessoal precisa de menos — política de guarda é decisão de quem responde
  // pelos dados, não constante de código.
  'auditRetentionDays'
]);

// Validation runs without a request, so it reports translation keys and the
// controller renders them in the caller's language.
function validateSetting(key, value) {
  if (!ALLOWED_SETTING_KEYS.has(key)) {
    return { errorKey: 'settings.validation.unsupportedKey' };
  }
  const normalized = String(value);
  if (normalized.length > 2048) {
    return { errorKey: 'settings.validation.valueTooLong' };
  }
  if (key === 'autoGenerateCustomerId' && !['true', 'false'].includes(normalized)) {
    return { errorKey: 'settings.validation.autoGeneration' };
  }
  if (key === 'customerIdPrefixMode' && !['default', 'company'].includes(normalized)) {
    return { errorKey: 'settings.validation.prefixMode' };
  }
  if (key === 'customerIdCompanyPrefix' && !/^[A-Za-z]{2,4}$/.test(normalized.trim())) {
    return { errorKey: 'settings.validation.companyPrefix' };
  }
  if (key === 'customerIdSuffixMode' && !['random', 'installation_date'].includes(normalized)) {
    return { errorKey: 'settings.validation.suffixMode' };
  }
  if (key === 'appName' && (normalized.trim().length < 1 || normalized.length > 80)) {
    return { errorKey: 'settings.validation.appName' };
  }
  if (key === 'auditRetentionDays') {
    // Os limites existem pelos dois lados, e por razões opostas: abaixo de 30
    // dias a trilha deixa de responder à pergunta que a justifica ("quem mexeu
    // nisso?", que chega meses depois), e acima de 10 anos ela vira o arquivo
    // de dado pessoal que o prazo existe para evitar.
    const dias = Number.parseInt(normalized, 10);
    if (!Number.isInteger(dias) || String(dias) !== normalized.trim() || dias < 30 || dias > 3650) {
      return { errorKey: 'settings.validation.auditRetentionDays' };
    }
  }
  return { value: normalized };
}

class SettingsController {
  /**
   * `GET /api/settings/genieacs-suggestion` — o endereço de ACS que a
   * plataforma sugere a ESTE provedor, ou nada.
   *
   * Serve o passo 2 do onboarding, onde hoje se digita a NBI do zero. A
   * sugestão sai de `GENIEACS_URL_TEMPLATE` com `{slug}` e `{id}` do provedor em
   * escopo — um endereço por provedor, porque um ACS compartilhado entre dois
   * mostraria a frota de um ao outro (ver `genieacsSuggestion.js`).
   *
   * `settings.write` e não `settings.read`: quem não pode gravar a URL não tem
   * o que fazer com a sugestão dela, e a capacidade que guarda a tela é a que
   * guarda a rota.
   *
   * `null` não é erro — é "este deploy não configurou template", que é o estado
   * de todo install que não hospeda ACS nenhum. A tela se comporta como sempre.
   */
  static async getGenieAcsSuggestion(req, res) {
    try {
      const tenant = await Tenant.findById(currentTenantId());
      return res.json(createResponse(
        req.t('settings.listRetrieved'),
        { suggestion: suggestGenieAcsUrl(tenant) }
      ));
    } catch (error) {
      console.error('GenieACS suggestion error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * A credencial da NBI daquele provedor, sem o segredo.
   *
   * Rota própria e não uma chave em `/api/settings`, por uma razão só: aquela
   * rota devolve `Setting.getAll()` inteiro, então toda chave que entra lá está
   * no fio no mesmo instante. Um segredo cifrado no banco e servido em claro no
   * GET não é segredo — e a redação teria que ser lembrada por quem
   * acrescentasse a próxima chave, que é o tipo de lembrança que falha.
   */
  static async getGenieAcsAuth(req, res) {
    try {
      return res.json(createResponse(
        req.t('settings.listRetrieved'),
        await GenieAcsAuthService.getPublicConfig()
      ));
    } catch (error) {
      console.error('Get GenieACS auth error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  static async updateGenieAcsAuth(req, res) {
    try {
      if (await platformManagesCurrentTenant()) return platformManagedResponse(req, res);
      const authType = req.body?.authType;
      if (authType !== undefined && !AUTH_TYPES.includes(authType)) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.validation.genieAcsAuthType'))
        );
      }
      // `basic` sem usuário é configuração que não autentica ninguém e que a
      // tela não teria como distinguir de "salvou certo": o header sai
      // `Basic OnNlZ3JlZG8=`, com usuário vazio, e o ACS recusa sem dizer por
      // quê. `bearer` não precisa de usuário — o token é a credencial inteira.
      const proximo = {
        ...req.body,
        username: req.body?.username
      };
      const atual = await GenieAcsAuthService.getPublicConfig();
      const tipoFinal = authType ?? atual.authType;
      const usuarioFinal = proximo.username === undefined ? atual.username : String(proximo.username).trim();
      if (tipoFinal === 'basic' && !usuarioFinal) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.validation.genieAcsAuthUsername'))
        );
      }

      const salvo = await GenieAcsAuthService.saveConfig({
        authType,
        username: proximo.username,
        secret: req.body?.secret
      });
      // O segredo não entra na trilha; o que entra é que a credencial mudou,
      // para qual tipo, e se passou a existir uma. É o suficiente para
      // responder "desde quando o ACS parou de aceitar a gente" sem guardar a
      // resposta de quem quiser se passar pelo painel.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.GENIEACS_AUTH_CHANGED,
        subjectType: 'settings',
        subjectId: 'genieacs-auth',
        detail: {
          authType: salvo.authType,
          username: salvo.username,
          secretConfigured: salvo.secretConfigured
        }
      });
      return res.json(createResponse(req.t('settings.updated'), salvo));
    } catch (error) {
      console.error('Update GenieACS auth error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  static async getAllSettings(req, res) {
    try {
      const settings = await Setting.getAll();
      return res.json(
        createResponse(req.t('settings.listRetrieved'), settings)
      );
    } catch (error) {
      console.error('Get all settings error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.listFailed'), error.message)
      );
    }
  }

  static async getSettingByKey(req, res) {
    try {
      const { key } = req.params;
      
      if (!key) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.keyRequired'))
        );
      }
      if (!ALLOWED_SETTING_KEYS.has(key)) {
        return res.status(404).json(createErrorResponse(req.t('settings.notFound')));
      }

      const value = await Setting.getByKey(key);
      
      if (value === null) {
        return res.status(404).json(
          createErrorResponse(req.t('settings.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('settings.retrieved'), { [key]: value })
      );
    } catch (error) {
      console.error('Get setting error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.getFailed'), error.message)
      );
    }
  }

  static async createSetting(req, res) {
    try {
      const { key, value } = req.body;
      
      if (!key || value === undefined || value === null) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.keyValueRequired'))
        );
      }

      if (await refusesPlatformKey(key)) return platformManagedResponse(req, res);

      const validated = validateSetting(String(key), value);
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }

      const teto = await auditRetentionAboveCap(String(key), validated.value);
      if (teto !== null) {
        return res.status(422).json(createErrorResponse(
          req.t('settings.validation.auditRetentionAboveCap', { max: teto }), null, 'retention_above_cap'
        ));
      }

      await Setting.create(key, validated.value);
      return res.json(
        createResponse(req.t('settings.created'), { [key]: validated.value })
      );
    } catch (error) {
      console.error('Create setting error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.createFailed'), error.message)
      );
    }
  }

  static async updateSetting(req, res) {
    try {
      const { key } = req.params;
      const { value } = req.body;
      
      if (!key || value === undefined || value === null) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.keyValueRequired'))
        );
      }

      if (await refusesPlatformKey(key)) return platformManagedResponse(req, res);

      const validated = validateSetting(String(key), value);
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }

      const teto = await auditRetentionAboveCap(String(key), validated.value);
      if (teto !== null) {
        return res.status(422).json(createErrorResponse(
          req.t('settings.validation.auditRetentionAboveCap', { max: teto }), null, 'retention_above_cap'
        ));
      }

      const updated = await Setting.update(key, validated.value);
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('settings.notFound'))
        );
      }

      // Só a URL do ACS, e não toda chave que passa por aqui: a trilha existe
      // para as ações sensíveis, e virar log de toda edição de configuração a
      // encheria de linhas sobre o nome do painel e os caminhos de parâmetro
      // virtual — que é como uma trilha deixa de ser lida. Mudar para onde o
      // painel fala é outra coisa: é para onde vão as credenciais dos
      // assinantes daquele provedor.
      if (key === 'genieAcsUrl') {
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_URL_CHANGED,
          subjectType: 'settings',
          subjectId: key,
          detail: { url: validated.value }
        });
      }

      return res.json(
        createResponse(req.t('settings.updated'), { [key]: validated.value })
      );
    } catch (error) {
      console.error('Update setting error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.updateFailed'), error.message)
      );
    }
  }

  static async syncCustomerIds(req, res) {
    try {
      const enabled = await CustomerService.isAutoGenerationEnabled();
      if (!enabled) {
        return res.json(createResponse(req.t('settings.customerIdSyncDisabled'), {
          enabled: false,
          total: 0,
          existing: 0,
          generated: 0,
          pending: 0
        }));
      }
      const devices = await DeviceService.getCustomerIdentityDevices();
      const deviceIds = devices.map((device) => String(device?._id || '')).filter(Boolean);
      const identityHashes = devices
        .filter((device) => device?._id && device?.softwareId && device?.pppoe)
        .map((device) => CustomerService.identityHash(device.softwareId, device.pppoe));
      const existingRows = await CustomerAccount.getExistingForIdentities(deviceIds, identityHashes);
      const customerIds = await CustomerService.syncDevices(devices, { enabled: true });
      const generated = Math.max(customerIds.size - existingRows.length, 0);
      const preserved = Math.min(existingRows.length, customerIds.size);
      const pending = Math.max(new Set(deviceIds).size - customerIds.size, 0);
      return res.json(createResponse(
        pending
          ? req.t('settings.customerIdSyncedPending', { count: pending })
          : req.t('settings.customerIdSynced'),
        {
          enabled: true,
          total: deviceIds.length,
          existing: preserved,
          generated,
          pending
        }
      ));
    } catch (error) {
      console.error('Customer ID sync error:', error);
      return res.status(502).json(
        createErrorResponse(req.t('settings.customerIdSyncFailed'), translateError(req.t, error))
      );
    }
  }

  static async deleteSetting(req, res) {
    try {
      const { key } = req.params;
      
      if (!key) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.keyRequired'))
        );
      }
      if (!ALLOWED_SETTING_KEYS.has(key)) {
        return res.status(404).json(createErrorResponse(req.t('settings.notFound')));
      }
      if (await refusesPlatformKey(key)) return platformManagedResponse(req, res);

      const deleted = await Setting.delete(key);
      
      if (!deleted) {
        return res.status(404).json(
          createErrorResponse(req.t('settings.notFound'))
        );
      }

      return res.json(
        createResponse(req.t('settings.deleted'))
      );
    } catch (error) {
      console.error('Delete setting error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('settings.deleteFailed'), error.message)
      );
    }
  }

  static async testGenieAcsConnection(req, res) {
    try {
      // Na SaaS o provedor não escolhe para onde o painel fala: testa o
      // endereço que a plataforma gravou, e o corpo do request é ignorado. É
      // o que mantém o botão útil ("o ACS está respondendo?") sem ele virar
      // uma sonda para endereços que o provedor não pode gravar.
      const url = (await platformManagesCurrentTenant())
        ? await DeviceService.getGenieAcsUrl().catch(() => null)
        : req.body?.url;
      const { status, body } = await probeGenieAcs(req.t, url);
      return res.status(status).json(body);
    } catch (error) {
      console.error('Test GenieACS connection error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }
}

/**
 * Pergunta ao GenieACS em `url` se ele responde, com o mesmo guarda de saída
 * de toda outra chamada. Devolve `{ status, body }` em vez de escrever na
 * resposta, porque o console chama isto em nome de um provedor — dentro do
 * `runInTenant` dele, com a credencial dele — e responde pela própria rota.
 */
export async function probeGenieAcs(t, url) {
  const reply = (status, body) => ({ status, body });

  if (!url) {
    return reply(400,
      createErrorResponse(t('settings.urlRequired'))
    );
  }

  let testUrl;
  try {
    testUrl = new URL(String(url).trim());
  } catch {
    return reply(400,
      createErrorResponse(t('settings.urlInvalid'))
    );
  }

  if (!['http:', 'https:'].includes(testUrl.protocol)) {
    return reply(400,
      createErrorResponse(t('settings.urlSchemeUnsupported'))
    );
  }

  if (testUrl.username || testUrl.password) {
    return reply(400,
      createErrorResponse(t('settings.urlCredentialsUnsupported'))
    );
  }

  testUrl.pathname = '/devices';
  testUrl.search = '';
  testUrl.hash = '';
  testUrl.searchParams.set('limit', '1');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    // The URL under test arrives in the request body, so this is the one
    // GenieACS call whose destination is named by the caller rather than by
    // stored settings. It goes through the same guard as every other, or
    // the "test connection" button is a probe for anything our network can
    // reach that the configured URL is not allowed to be.
    // A credencial guardada só acompanha o teste quando o endereço testado
    // é a MESMA origem que está salva.
    //
    // Não é zelo: a URL vem no corpo do request, então mandar a credencial
    // para qualquer endereço faria deste botão um jeito de LER o segredo —
    // aponte para um servidor seu, leia o header. Ele é gravado para nunca
    // mais ser exibido, e um administrador recuperaria assim o que um
    // antecessor configurou. Contra a mesma origem já salva não há o que
    // extrair: o segredo já vai para lá a cada requisição do painel.
    //
    // O efeito colateral é honesto e vale dizer na tela: testar um endereço
    // NOVO vai sem autenticação, e contra uma NBI que exige credencial isso
    // responde 401. É a resposta certa — a configuração daquele endereço
    // ainda não foi salva, então não há credencial dele para usar.
    const salva = await DeviceService.getGenieAcsUrl().catch(() => null);
    const mesmaOrigem = (() => {
      try { return salva ? new URL(salva).origin === testUrl.origin : false; } catch { return false; }
    })();
    const response = await GenieAcsEgress.fetch(testUrl, {
      method: 'GET',
      headers: mesmaOrigem
        ? await GenieAcsAuthService.nbiHeaders()
        : { Accept: 'application/json' },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return reply(502,
        createErrorResponse(
          t('settings.connectionStatus', { status: response.status }),
          t('settings.connectionTestFailed')
        )
      );
    }

    const data = await response.json();

    if (Array.isArray(data)) {
      return reply(200,
        createResponse(t('settings.connectionSuccess'), {
          deviceCount: data.length
        })
      );
    } else {
      return reply(200,
        createResponse(t('settings.connectionUnexpectedFormat'))
      );
    }
  } catch (error) {
    clearTimeout(timeoutId);

    // A refused address is the operator's own misconfiguration, not an
    // upstream outage, so it answers 400 with the reason rather than 502.
    if (error.code === EGRESS_REFUSED) {
      return reply(400,
        createErrorResponse(t('settings.urlEgressRefused'), error.message)
      );
    }

    if (error.name === 'AbortError' || error.type === 'request-timeout') {
      return reply(504,
        createErrorResponse(t('settings.connectionTimeout'))
      );
    }

    if (error.code === 'ECONNREFUSED') {
      return reply(502,
        createErrorResponse(t('settings.connectionRefused'))
      );
    }

    return reply(502,
      createErrorResponse(t('settings.connectionFailed'), error.message)
    );
  }
}

export default SettingsController;
