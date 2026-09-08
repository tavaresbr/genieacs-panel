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

// Entries are only worth keeping for their 30 second lifetime, so the map is
// swept whenever it grows past this many customers instead of retaining one
// entry for every account that has ever signed in.
const OVERVIEW_CACHE_SWEEP_AT = 500;

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

      const account = await CustomerAccount.getByCustomerId(customerId);
      if (!account) {
        await CustomerPortalPasswordService.rejectUnknownAccount(password);
        return res.status(401).json(createErrorResponse(req.t('portal.invalidCredentials'), null, 'invalid_credentials'));
      }
      if (!(await CustomerPortalPasswordService.verify(account, password))) {
        return res.status(401).json(createErrorResponse(req.t('portal.invalidCredentials'), null, 'invalid_credentials'));
      }

      res.cookie(PORTAL_COOKIE_NAME, signPortalSession(account), portalCookieOptions(req));
      return res.json(createResponse(req.t('portal.loginSuccess'), {
        customerId: account.customer_id
      }, 'login_ok'));
    } catch (error) {
      console.error('Customer portal login error:', error);
      return res.status(500).json(createErrorResponse(req.t('portal.loginFailed'), null, 'login_failed'));
    }
  }

  static async session(req, res) {
    return res.json(createResponse(req.t('portal.sessionActive'), {
      customerId: req.customer.customer_id
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
      const data = {
        ...deviceData,
        wifi: deviceData.wifi.map((network) => ({
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
      const ssid = String(req.body?.ssid ?? '').trim();
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
      DeviceService.dashboardCache.expiresAt = 0;

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

  static async revealWifiPassword(req, res) {
    try {
      const wifiIndex = Number(req.params?.index);
      if (!Number.isInteger(wifiIndex) || wifiIndex < 1 || wifiIndex > 8) {
        return res.status(400).json(createErrorResponse(req.t('portal.wifiNetworkInvalid'), null, 'invalid_wifi_index'));
      }
      const password = await CustomerWifiCredentialService.reveal(
        req.customer.id,
        wifiIndex
      );
      if (!password) {
        return res.status(404).json(createErrorResponse(
          req.t('portal.wifiPasswordNotSaved'), null, 'wifi_password_not_saved'
        ));
      }
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

  static async logout(req, res) {
    res.clearCookie(PORTAL_COOKIE_NAME, portalClearCookieOptions(req));
    return res.json(createResponse(req.t('portal.sessionEnded'), null, 'logout_ok'));
  }
}

export default CustomerPortalController;
