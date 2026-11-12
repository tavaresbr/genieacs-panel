import CustomerAccount from '../models/CustomerAccount.js';
import CustomerService from '../services/customerService.js';
import CustomerPortalPasswordService from '../services/customerPortalPasswordService.js';
import CustomerWifiCredentialService from '../services/customerWifiCredentialService.js';
import DeviceService from '../services/deviceService.js';
import SgpService, { SgpError } from '../services/sgpService.js';
import {
  PORTAL_COOKIE_NAME,
  portalClearCookieOptions,
  portalCookieOptions,
  signPortalSession
} from '../middleware/portalAuth.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';
import Setting from '../models/Setting.js';
import Tenant from '../models/Tenant.js';
import { currentTenantId } from '../config/tenantContext.js';
import { readDateFormat } from '../utils/dateFormat.js';
import AccountLockout from '../models/AccountLockout.js';
import AuditLog from '../models/AuditLog.js';
import { notifyWifiChanged } from '../services/portalWifiNoticeService.js';
import { newPasswordProblem } from '../utils/passwordPolicy.js';

/**
 * Uma linha na trilha do provedor sobre o que o ASSINANTE fez no portal. O
 * autor é o ID do cliente, com `actor_kind: 'system'` (não é operador). Nunca
 * grava senha nem SSID: só índice da rede e se a senha mudou. Não lança.
 */
function auditPortal(req, action, detail, customer = req.customer) {
  return AuditLog.record({
    action,
    actorKind: 'system',
    actorUsername: customer?.customer_id ?? null,
    subjectType: 'customer_account',
    subjectId: customer?.id ?? null,
    detail,
    ip: req.ip ?? null
  });
}

// Entries are only worth keeping for their 30 second lifetime, so the map is
// swept whenever it grows past this many customers instead of retaining one
// entry for every account that has ever signed in.
const OVERVIEW_CACHE_SWEEP_AT = 500;

/**
 * As redes Wi-Fi que o assinante pode ver e editar no portal. A configuração
 * `portalWifiIndexes` ("1,5") é do provedor; vazia, vale tudo o que o ONT
 * reportar (o comportamento de sempre). Existe para o provedor esconder redes
 * que não são do cliente: convidado, IPTV, gerência.
 */
async function allowedWifiIndexes() {
  const raw = String(await Setting.getByKey('portalWifiIndexes') ?? '').trim();
  if (!raw) return null;
  const indexes = raw.split(',').map((item) => Number(item.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 8);
  return indexes.length > 0 ? new Set(indexes) : null;
}

class CustomerPortalController {
  static overviewCache = new Map();

  static rememberOverview(cacheKey, data, ttlMs = 30_000) {
    const cache = CustomerPortalController.overviewCache;
    if (cache.size >= OVERVIEW_CACHE_SWEEP_AT) {
      const now = Date.now();
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      // Still full of live entries: drop the oldest, which Map iterates first.
      while (cache.size >= OVERVIEW_CACHE_SWEEP_AT) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
    }
    cache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
  }

  static async login(req, res) {
    try {
      const customerId = CustomerService.normalizeCustomerId(req.body?.customerId);
      const password = String(req.body?.password ?? '').trim().toUpperCase();
      if (!customerId || !/^[A-Z0-9]{6,32}$/.test(password)) {
        return res.status(401).json(createErrorResponse(req.t('portal.invalidCredentials'), null, 'invalid_credentials'));
      }

      // A trava por CONTA, a mesma do painel e do portal do afiliado. O limitador
      // por endereço não segura quem distribui os palpites; este conta pelo alvo.
      // O sujeito é o mesmo para ID que existe e que não existe (anti-enumeração)
      // e leva o provedor, porque o mesmo ID pode existir em dois.
      const tentativa = await AccountLockout.attempt(
        AccountLockout.forIdentifier(`portal:${currentTenantId()}:${customerId}`)
      );
      if (!tentativa.allowed) {
        if (tentativa.justLocked) {
          await AuditLog.record({
            action: AuditLog.ACTIONS.PORTAL_CUSTOMER_LOCKED,
            actorKind: 'system',
            actorUsername: customerId,
            subjectType: 'customer_account',
            detail: { via: 'portal_login', lockedUntil: new Date(tentativa.lockedUntil).toISOString() },
            ip: req.ip ?? null
          });
        }
        // O mesmo custo de uma conferência, para a resposta não revelar a trava.
        await CustomerPortalPasswordService.rejectUnknownAccount(password);
        return AccountLockout.lockedResponse(req, res, tentativa);
      }

      const account = await CustomerAccount.getByCustomerId(customerId);
      if (!account) {
        await CustomerPortalPasswordService.rejectUnknownAccount(password);
        await AccountLockout.failure(tentativa);
        return res.status(401).json(createErrorResponse(req.t('portal.invalidCredentials'), null, 'invalid_credentials'));
      }
      if (!(await CustomerPortalPasswordService.verify(account, password))) {
        const falha = await AccountLockout.failure(tentativa);
        if (falha.justLocked) {
          await AuditLog.record({
            action: AuditLog.ACTIONS.PORTAL_CUSTOMER_LOCKED,
            actorKind: 'system',
            actorUsername: customerId,
            subjectType: 'customer_account',
            subjectId: account.id,
            detail: { via: 'portal_login', lockedUntil: new Date(falha.lockedUntil).toISOString() },
            ip: req.ip ?? null
          });
        }
        return res.status(401).json(createErrorResponse(req.t('portal.invalidCredentials'), null, 'invalid_credentials'));
      }

      await AccountLockout.clear(tentativa.subject);
      res.cookie(PORTAL_COOKIE_NAME, signPortalSession(account), portalCookieOptions(req));
      return res.json(createResponse(req.t('portal.loginSuccess'), {
        customerId: account.customer_id
      }, 'login_ok'));
    } catch (error) {
      console.error('Customer portal login error:', error);
      return res.status(500).json(createErrorResponse(req.t('portal.loginFailed'), null, 'login_failed'));
    }
  }

  /**
   * "Fale com seu provedor": o contato que o provedor escolheu mostrar.
   *
   * Desligado (o padrão), só `{ enabled: false }` — nem o nome sai. Ligado,
   * cada campo é montado aqui, um a um, a partir de `PORTAL_CONTACT_COLUMNS`:
   * o que não está nessa lista (CNPJ, inscrição, gateway) não tem caminho
   * para esta resposta. Os campos das configurações valem sobre o cadastro.
   */
  static async provider(req, res) {
    try {
      const enabled = String(await Setting.getByKey('portalShowProviderContact') ?? '') === 'true';
      if (!enabled) {
        return res.json(createResponse(req.t('portal.providerReady'), { enabled: false }, 'provider_ok'));
      }
      const [row, phone, whatsapp, email] = await Promise.all([
        Tenant.findPortalContactById(currentTenantId()),
        Setting.getByKey('portalContactPhone'),
        Setting.getByKey('portalContactWhatsapp'),
        Setting.getByKey('portalContactEmail')
      ]);
      const text = (value) => String(value ?? '').trim() || null;
      const street = [text(row?.billing_address_line), text(row?.billing_address_number)].filter(Boolean).join(', ');
      const cityState = [text(row?.billing_city), text(row?.billing_state)].filter(Boolean).join(' - ');
      const address = [street, text(row?.billing_address_extra), text(row?.billing_district), cityState, text(row?.billing_postal_code)]
        .filter(Boolean)
        .join(' · ') || null;
      return res.json(createResponse(req.t('portal.providerReady'), {
        enabled: true,
        name: text(row?.name),
        phone: text(phone) ?? text(row?.billing_phone),
        whatsapp: text(whatsapp),
        email: text(email) ?? text(row?.billing_email),
        address
      }, 'provider_ok'));
    } catch (error) {
      console.error('Customer portal provider contact error:', error);
      return res.status(500).json(createErrorResponse(req.t('portal.providerUnavailable'), null, 'provider_unavailable'));
    }
  }

  static async session(req, res) {
    return res.json(createResponse(req.t('portal.sessionActive'), {
      customerId: req.customer.customer_id,
      // O portal escreve as datas como o painel do provedor.
      dateFormat: await readDateFormat().catch(() => 'auto')
    }, 'session_active'));
  }

  static async overview(req, res) {
    try {
      const cacheKey = String(req.customer.id);
      const cached = CustomerPortalController.overviewCache.get(cacheKey);
      const deviceData = cached && cached.expiresAt > Date.now()
        ? cached.data
        : await DeviceService.getCustomerPortalOverview(req.customer.device_id);
      if (!cached || cached.expiresAt <= Date.now()) {
        // Cache only non-secret GenieACS data. Decrypted passwords are loaded
        // per authenticated request and never retained in process memory.
        CustomerPortalController.rememberOverview(cacheKey, deviceData);
      }
      const savedCredentials = await CustomerWifiCredentialService.getSavedPasswordStatus(
        req.customer.id
      );
      const allowed = await allowedWifiIndexes();
      const data = {
        ...deviceData,
        wifi: deviceData.wifi.filter((network) => !allowed || allowed.has(Number(network.index))).map((network) => ({
          ...network,
          hasSavedPassword: Boolean(
            savedCredentials.get(Number(network.index))?.hasPassword
          )
        }))
      };
      return res.json(createResponse(req.t('portal.overviewReady'), {
        customerId: req.customer.customer_id,
        ...data
      }, 'overview_ok'));
    } catch (error) {
      console.error('Customer portal overview error:', error);
      if (error.translationKey === 'device.notFound') {
        return res.status(404).json(createErrorResponse(
          req.t('portal.ontNotRegistered'), null, 'device_not_found'
        ));
      }
      return res.status(502).json(createErrorResponse(
        req.t('portal.overviewUnavailable'), null, 'overview_unavailable'
      ));
    }
  }

  static async updateWifi(req, res) {
    try {
      const wifiIndex = Number(req.body?.index);
      const ssid = String(req.body?.ssid ?? '').normalize('NFC').trim();
      const password = req.body?.password === undefined
        ? ''
        : String(req.body.password);

      if (!Number.isInteger(wifiIndex) || wifiIndex < 1 || wifiIndex > 8) {
        return res.status(400).json(createErrorResponse(req.t('portal.wifiNetworkInvalid'), null, 'invalid_wifi_index'));
      }
      if (!ssid || ssid.length > 32 || /[\u0000-\u001f\u007f]/.test(ssid)) {
        return res.status(400).json(createErrorResponse(
          req.t('portal.wifiSsidInvalid'), null, 'invalid_ssid'
        ));
      }
      if (password && !/^[\x20-\x7e]{8,63}$/.test(password)) {
        return res.status(400).json(createErrorResponse(
          req.t('portal.wifiPasswordInvalid'), null, 'invalid_wifi_password'
        ));
      }

      const allowed = await allowedWifiIndexes();
      if (allowed && !allowed.has(wifiIndex)) {
        return res.status(404).json(createErrorResponse(
          req.t('portal.wifiNotReported'), null, 'wifi_network_not_found'
        ));
      }

      // The device target is resolved only from the authenticated account.
      // Never accept a device ID supplied by the browser.
      const current = await DeviceService.getCustomerPortalOverview(
        req.customer.device_id
      );
      const network = current.wifi.find((entry) => Number(entry.index) === wifiIndex);
      if (!network) {
        return res.status(404).json(createErrorResponse(
          req.t('portal.wifiNotReported'), null, 'wifi_network_not_found'
        ));
      }

      await DeviceService.updateWifiConfig(req.customer.device_id, wifiIndex, {
        ssid,
        password
      });
      await CustomerWifiCredentialService.save(
        req.customer.id,
        wifiIndex,
        ssid,
        password
      );
      CustomerPortalController.overviewCache.delete(String(req.customer.id));
      DeviceService.invalidateDashboard();
      await auditPortal(req, AuditLog.ACTIONS.PORTAL_CUSTOMER_WIFI_UPDATED, {
        index: wifiIndex,
        passwordChanged: Boolean(password)
      });
      // Sem `await`: o WhatsApp não atrasa a resposta, e a função nunca lança.
      void notifyWifiChanged({ accountId: req.customer.id, deviceId: req.customer.device_id });

      return res.json(createResponse(
        req.t('portal.wifiUpdateQueued'),
        { index: wifiIndex, ssid },
        'wifi_updated'
      ));
    } catch (error) {
      console.error('Customer portal WiFi update error:', error);
      if (error.translationKey === 'device.notFound') {
        return res.status(404).json(createErrorResponse(req.t('portal.ontNotFound'), null, 'device_not_found'));
      }
      if (error.translationKey) {
        return res.status(400).json(createErrorResponse(translateError(req.t, error), null, 'wifi_rejected'));
      }
      return res.status(502).json(createErrorResponse(
        req.t('portal.wifiUpdateFailed'), null, 'wifi_update_failed'
      ));
    }
  }

  /**
   * `POST /api/customer/wifi/:index/password` com `{ password }`: a senha do
   * portal, de novo. Ver a senha da rede em claro é o ato mais sensível do
   * portal, e a sessão de 30 minutos sozinha não basta (cookie roubado, PC
   * compartilhado). A conferência passa pela mesma trava por conta do login.
   */
  static async revealWifiPassword(req, res) {
    try {
      const wifiIndex = Number(req.params?.index);
      if (!Number.isInteger(wifiIndex) || wifiIndex < 1 || wifiIndex > 8) {
        return res.status(400).json(createErrorResponse(req.t('portal.wifiNetworkInvalid'), null, 'invalid_wifi_index'));
      }
      const typed = String(req.body?.password ?? '').trim().toUpperCase();
      const tentativa = await AccountLockout.attempt(
        AccountLockout.forIdentifier(`portal:${currentTenantId()}:${req.customer.customer_id}`)
      );
      if (!tentativa.allowed) {
        await CustomerPortalPasswordService.rejectUnknownAccount(typed);
        return AccountLockout.lockedResponse(req, res, tentativa);
      }
      if (!/^[A-Z0-9]{6,32}$/.test(typed) || !(await CustomerPortalPasswordService.verify(req.customer, typed))) {
        await AccountLockout.failure(tentativa);
        return res.status(401).json(createErrorResponse(req.t('portal.reauthRequired'), null, 'reauth_required'));
      }
      await AccountLockout.clear(tentativa.subject);

      const password = await CustomerWifiCredentialService.reveal(
        req.customer.id,
        wifiIndex
      );
      if (!password) {
        return res.status(404).json(createErrorResponse(
          req.t('portal.wifiPasswordNotSaved'), null, 'wifi_password_not_saved'
        ));
      }
      await auditPortal(req, AuditLog.ACTIONS.PORTAL_CUSTOMER_WIFI_REVEALED, { index: wifiIndex });
      return res.json(createResponse(req.t('portal.wifiPasswordReady'), { password }, 'wifi_password_ok'));
    } catch (error) {
      console.error('Customer portal WiFi password reveal error:', error);
      return res.status(500).json(createErrorResponse(
        req.t('portal.wifiPasswordRevealFailed'), null, 'wifi_password_unavailable'
      ));
    }
  }

  static async billing(req, res) {
    try {
      const config = await SgpService.getConfig();
      if (!SgpService.isReady(config) || !config.portalBilling) {
        return res.status(404).json({
          ...createErrorResponse(req.t('portal.billingUnavailable')),
          code: 'billing_disabled'
        });
      }

      // The contract is resolved from the authenticated account only; the
      // browser never chooses which SGP contract is read.
      const { link } = await SgpService.resolveDeviceContract(req.customer.device_id, {
        refresh: req.query?.refresh === '1'
      });
      const { invoices } = await SgpService.listInvoices({
        contract: link.contract,
        onlyOpen: true
      });

      return res.json(createResponse(req.t('portal.invoicesReady'), {
        contract: SgpService.portalLink(link),
        invoices,
        trustUnlockAvailable: config.portalUnlock === true,
        generatedAt: new Date().toISOString()
      }));
    } catch (error) {
      if (error instanceof SgpError) {
        return res.status(error.status === 409 ? 404 : error.status).json({
          ...createErrorResponse(translateError(req.t, error), null, 'wifi_rejected'),
          code: error.code
        });
      }
      console.error('Customer portal billing error:', error);
      return res.status(502).json(createErrorResponse(
        req.t('portal.billingFailed')
      ));
    }
  }

  static async trustUnlock(req, res) {
    try {
      const config = await SgpService.getConfig();
      if (!SgpService.isReady(config) || !config.portalUnlock) {
        return res.status(404).json({
          ...createErrorResponse(req.t('portal.unlockUnavailable')),
          code: 'unlock_disabled'
        });
      }

      const { link } = await SgpService.resolveDeviceContract(req.customer.device_id);
      const result = await SgpService.requestTrustUnlock({ contract: link.contract });
      await auditPortal(req, AuditLog.ACTIONS.PORTAL_CUSTOMER_TRUST_UNLOCK, {});
      return res.json(createResponse(result.message));
    } catch (error) {
      if (error instanceof SgpError) {
        return res.status(error.status === 409 ? 404 : error.status).json({
          ...createErrorResponse(translateError(req.t, error), null, 'wifi_rejected'),
          code: error.code
        });
      }
      console.error('Customer portal trust unlock error:', error);
      return res.status(502).json(createErrorResponse(
        req.t('portal.unlockFailed')
      ));
    }
  }

  /**
   * `POST /api/customer/password` com `{ currentPassword, newPassword }`.
   *
   * A senha nova segue o formato que o login aceita (letras e números, sem
   * diferença de caixa), com o mínimo de 10 e a lista de senhas comuns do
   * painel. A atual é conferida na mesma trava por conta do login. Trocar a
   * senha encerra as outras sessões (a impressão do hash muda); a deste
   * aparelho recebe um cookie novo.
   */
  static async changePassword(req, res) {
    try {
      const current = String(req.body?.currentPassword ?? '').trim().toUpperCase();
      const next = String(req.body?.newPassword ?? '').trim().toUpperCase();
      const tentativa = await AccountLockout.attempt(
        AccountLockout.forIdentifier(`portal:${currentTenantId()}:${req.customer.customer_id}`)
      );
      if (!tentativa.allowed) {
        await CustomerPortalPasswordService.rejectUnknownAccount(current);
        return AccountLockout.lockedResponse(req, res, tentativa);
      }
      if (!/^[A-Z0-9]{6,32}$/.test(current) || !(await CustomerPortalPasswordService.verify(req.customer, current))) {
        await AccountLockout.failure(tentativa);
        return res.status(401).json(createErrorResponse(req.t('portal.reauthRequired'), null, 'reauth_required'));
      }
      await AccountLockout.clear(tentativa.subject);

      if (!/^[A-Z0-9]{10,32}$/.test(next)) {
        return res.status(400).json(createErrorResponse(req.t('portal.newPasswordFormat'), null, 'invalid_new_password'));
      }
      if (newPasswordProblem(next, { username: req.customer.customer_id })) {
        return res.status(400).json(createErrorResponse(req.t('portal.newPasswordWeak'), null, 'weak_new_password'));
      }
      if (next === current) {
        return res.status(400).json(createErrorResponse(req.t('portal.newPasswordSame'), null, 'same_password'));
      }

      await CustomerPortalPasswordService.setChosen(req.customer.id, next);
      const fresh = await CustomerAccount.getById(req.customer.id);
      res.cookie(PORTAL_COOKIE_NAME, signPortalSession(fresh), portalCookieOptions(req));
      await auditPortal(req, AuditLog.ACTIONS.PORTAL_CUSTOMER_PASSWORD_CHANGED, {});
      return res.json(createResponse(req.t('portal.passwordChanged'), null, 'password_changed'));
    } catch (error) {
      console.error('Customer portal password change error:', error);
      return res.status(500).json(createErrorResponse(req.t('portal.passwordChangeFailed'), null, 'password_change_failed'));
    }
  }

  static async logout(req, res) {
    // Encerra também o cookie que alguém tenha copiado: sobe a versão da sessão.
    await CustomerAccount.bumpSession(req.customer.id).catch((error) => {
      console.error('Customer portal logout bump failed:', error.message);
    });
    res.clearCookie(PORTAL_COOKIE_NAME, portalClearCookieOptions(req));
    return res.json(createResponse(req.t('portal.sessionEnded'), null, 'logout_ok'));
  }
}

export default CustomerPortalController;
