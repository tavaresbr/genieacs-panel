import Setting from '../models/Setting.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';
import CustomerService from '../services/customerService.js';
import DeviceService from '../services/deviceService.js';
import GenieAcsEgress, { EGRESS_REFUSED } from '../services/genieacsEgress.js';
import GenieAcsAuthService, { AUTH_TYPES } from '../services/genieacsAuthService.js';
import CustomerAccount from '../models/CustomerAccount.js';

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
  'vpUserPassword'
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
  return { value: normalized };
}

class SettingsController {
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

      const validated = validateSetting(String(key), value);
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
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

      const validated = validateSetting(String(key), value);
      if (validated.errorKey) {
        return res.status(400).json(createErrorResponse(req.t(validated.errorKey)));
      }

      const updated = await Setting.update(key, validated.value);
      
      if (!updated) {
        return res.status(404).json(
          createErrorResponse(req.t('settings.notFound'))
        );
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
      const { url } = req.body;
      
      if (!url) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.urlRequired'))
        );
      }
      
      let testUrl;
      try {
        testUrl = new URL(String(url).trim());
      } catch {
        return res.status(400).json(
          createErrorResponse(req.t('settings.urlInvalid'))
        );
      }

      if (!['http:', 'https:'].includes(testUrl.protocol)) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.urlSchemeUnsupported'))
        );
      }

      if (testUrl.username || testUrl.password) {
        return res.status(400).json(
          createErrorResponse(req.t('settings.urlCredentialsUnsupported'))
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
          return res.status(502).json(
            createErrorResponse(
              req.t('settings.connectionStatus', { status: response.status }),
              req.t('settings.connectionTestFailed')
            )
          );
        }
        
        const data = await response.json();
        
        if (Array.isArray(data)) {
          return res.json(
            createResponse(req.t('settings.connectionSuccess'), {
              deviceCount: data.length
            })
          );
        } else {
          return res.json(
            createResponse(req.t('settings.connectionUnexpectedFormat'))
          );
        }
      } catch (error) {
        clearTimeout(timeoutId);
        
        // A refused address is the operator's own misconfiguration, not an
        // upstream outage, so it answers 400 with the reason rather than 502.
        if (error.code === EGRESS_REFUSED) {
          return res.status(400).json(
            createErrorResponse(req.t('settings.urlEgressRefused'), error.message)
          );
        }

        if (error.name === 'AbortError' || error.type === 'request-timeout') {
          return res.status(504).json(
            createErrorResponse(req.t('settings.connectionTimeout'))
          );
        }
        
        if (error.code === 'ECONNREFUSED') {
          return res.status(502).json(
            createErrorResponse(req.t('settings.connectionRefused'))
          );
        }
        
        return res.status(502).json(
          createErrorResponse(req.t('settings.connectionFailed'), error.message)
        );
      }
    } catch (error) {
      console.error('Test GenieACS connection error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }
}

export default SettingsController;
