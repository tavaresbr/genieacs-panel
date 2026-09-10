import DeviceService from '../services/deviceService.js';
import DeviceHistoryService from '../services/deviceHistoryService.js';
import CustomerService from '../services/customerService.js';
import CustomerPortalPasswordService from '../services/customerPortalPasswordService.js';
import CustomerAccount from '../models/CustomerAccount.js';
import DeviceProfile from '../models/DeviceProfile.js';
import DeviceSwap, { publicSwap } from '../models/DeviceSwap.js';
import AuditLog, { AUDIT_ACTIONS } from '../models/AuditLog.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

class DeviceController {
  static async getDashboard(req, res) {
    try {
      const dashboard = await DeviceService.getDashboardData(req.query.refresh === '1');
      return res.json(createResponse(req.t('device.dashboardRetrieved'), dashboard));
    } catch (error) {
      console.error('Get dashboard error:', error);
      return res.status(502).json(
        createErrorResponse(req.t('device.dashboardFailed'), error.message)
      );
    }
  }

  /** The telemetry series for one ONT, for the chart on its page. */
  static async getHistory(req, res) {
    try {
      const deviceId = String(req.params?.deviceId ?? '').trim();
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('device.history.deviceIdRequired')));
      }
      const to = req.query?.to ? Date.parse(String(req.query.to)) : Date.now();
      const from = req.query?.from
        ? Date.parse(String(req.query.from))
        : to - 24 * 3600_000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        return res.status(400).json(createErrorResponse(req.t('device.history.rangeInvalid')));
      }
      // A year is already 8760 hourly points, four times what the read returns.
      // Refusing beyond it keeps a mistyped date from scanning the whole table.
      if (to - from > 366 * 24 * 3600_000) {
        return res.status(400).json(createErrorResponse(req.t('device.history.rangeInvalid')));
      }
      const history = await DeviceHistoryService.readRange(deviceId, { from, to });
      return res.json(createResponse(req.t('device.history.retrieved'), history));
    } catch (error) {
      console.error('Get device history error:', error);
      return res.status(502).json(
        createErrorResponse(req.t('device.history.failed'), error.message)
      );
    }
  }

  /**
   * The ONT replacements the operator has not looked at yet.
   *
   * Open ones rather than all of them: the panel raises this as a banner, and a
   * list that keeps every swap ever recorded stops being something anyone
   * reads. The full record stays on each device's page.
   */
  static async getSwaps(req, res) {
    try {
      const rows = await DeviceSwap.listOpen(req.query?.limit);
      return res.json(createResponse(req.t('device.swaps.retrieved'), {
        swaps: rows.map(publicSwap),
        open: rows.length
      }));
    } catch (error) {
      console.error('List device swaps error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.swaps.failed'), error.message)
      );
    }
  }

  /** Every replacement one ONT took part in, at either end of it. */
  static async getDeviceSwaps(req, res) {
    try {
      const deviceId = String(req.params?.deviceId ?? '').trim();
      if (!deviceId) {
        return res.status(400).json(createErrorResponse(req.t('device.history.deviceIdRequired')));
      }
      const rows = await DeviceSwap.listForDevice(deviceId, req.query?.limit);
      return res.json(createResponse(req.t('device.swaps.retrieved'), {
        swaps: rows.map(publicSwap)
      }));
    } catch (error) {
      console.error('Get device swaps error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.swaps.failed'), error.message)
      );
    }
  }

  static async acknowledgeSwap(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse(req.t('device.swaps.notFound')));
      }
      const existing = await DeviceSwap.getById(id);
      if (!existing) {
        return res.status(404).json(createErrorResponse(req.t('device.swaps.notFound')));
      }
      const swap = await DeviceSwap.acknowledge(id, req.user?.id ?? null);
      return res.json(createResponse(req.t('device.swaps.acknowledged'), publicSwap(swap)));
    } catch (error) {
      console.error('Acknowledge device swap error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.swaps.failed'), error.message)
      );
    }
  }

  static async getFaults(req, res) {
    try {
      const faults = await DeviceService.getFaults(req.query.limit);
      void DeviceService.mergeDashboardFaults(faults);
      return res.json(createResponse(req.t('device.faultsRetrieved'), faults));
    } catch (error) {
      console.error('Get faults error:', error);
      return res.status(502).json(
        createErrorResponse(req.t('device.faultsFailed'), error.message)
      );
    }
  }

  static async deleteFault(req, res) {
    try {
      await DeviceService.deleteFault(req.params.faultId);
      DeviceService.invalidateDashboard();
      return res.json(createResponse(req.t('device.faultCleared')));
    } catch (error) {
      console.error('Delete fault error:', error);
      const validationError = error.message === 'Invalid fault ID';
      return res.status(validationError ? 400 : 502).json(
        createErrorResponse(req.t('device.faultClearFailed'), error.message)
      );
    }
  }

  static async getDevices(req, res) {
    try {
      const { devices, page, pageSize, total, totalPages } =
        await DeviceService.getDevicesPage(req.query);
      // Customer accounts are written on demand, so decoration is deliberately
      // limited to the page being returned instead of the whole fleet.
      const decoratedDevices = await CustomerService.decorateDevices(devices);
      return res.json(
        createResponse(req.t('device.listRetrieved'), {
          devices: decoratedDevices,
          page,
          pageSize,
          total,
          totalPages
        })
      );
    } catch (error) {
      console.error('Get devices error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.listFailed'), error.message)
      );
    }
  }

  static async getDeviceDetail(req, res) {
    try {
      const { deviceId } = req.params;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse(req.t('device.idRequired'))
        );
      }

      const deviceDetail = await DeviceService.getDetailDevice(deviceId);
      const profile = await DeviceProfile.getByDeviceId(deviceId);
      const reportedPppoe = deviceDetail.virtualParameters?.pppoeUsername?.value;
      let account = await CustomerAccount.getByDeviceId(deviceId);
      // This page is where staff read the Customer ID and portal password
      // before handing them over, so the account bound to the ONT is
      // revalidated here: an ONT now serving a different PPPoE login must not
      // present the previous subscriber's credentials.
      const staleSubscriber = Boolean(
        account
        && String(reportedPppoe ?? '').trim().length >= 3
        && !CustomerService.isSameSubscriber(account, reportedPppoe)
      );
      if ((!account || staleSubscriber) && await CustomerService.isAutoGenerationEnabled()) {
        account = await CustomerService.ensureAccount({
          _id: deviceId,
          softwareId: deviceDetail.deviceInfo?.softwareVersion,
          pppoe: reportedPppoe
        }) || (staleSubscriber ? null : account);
      }
      return res.json(
        createResponse(req.t('device.detailRetrieved'), {
          ...deviceDetail,
          customer: {
            customerId: account?.customer_id || null,
            installationDate: profile?.installation_date || null,
            generated: Boolean(account),
            portalPasswordSet: Boolean(account?.password_hash),
            portalPasswordUpdatedAt: account?.password_updated_at || null
          }
        })
      );
    } catch (error) {
      console.error('Get device detail error:', error);
      
      if (error.translationKey === 'device.notFound') {
        return res.status(404).json(
          createErrorResponse(req.t('device.notFound'), error.message)
        );
      }
      
      return res.status(500).json(
        createErrorResponse(req.t('device.detailFailed'), error.message)
      );
    }
  }

  /**
   * Portal passwords are independent of the Customer ID, so staff need a way to
   * read the current one back and to rotate it. Both are admin-only.
   */
  static async getPortalPassword(req, res) {
    try {
      const account = await CustomerAccount.getByDeviceId(req.params.deviceId);
      if (!account) {
        return res.status(404).json(
          createErrorResponse(req.t('device.noCustomerAccount'))
        );
      }
      const password = CustomerPortalPasswordService.reveal(account);
      if (!password) {
        return res.status(404).json(createErrorResponse(
          'No readable portal password is stored. Generate a new one.'
        ));
      }
      // Awaited, not fired and forgotten: the line has to be in the table
      // before the password leaves the building, or a crash between the two
      // hands out a secret nobody can prove was handed out. `record` swallows
      // its own failures, so awaiting it cannot cost the operator the answer to
      // a request that has already succeeded — see AuditLog.record for why a
      // full disk must not become a 500 here.
      //
      // The password itself is not passed. `customerId` is what identifies the
      // account to a human reading the log, and it is already the account's
      // public name in this response.
      await AuditLog.recordFromRequest(req, {
        action: AUDIT_ACTIONS.PORTAL_PASSWORD_REVEALED,
        targetType: 'customer_account',
        targetId: account.customer_id,
        metadata: { deviceId: req.params.deviceId }
      });
      return res.json(createResponse(req.t('device.portalPasswordRetrieved'), {
        customerId: account.customer_id,
        password,
        updatedAt: account.password_updated_at || null
      }));
    } catch (error) {
      console.error('Get portal password error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.portalPasswordReadFailed'), error.message)
      );
    }
  }

  static async resetPortalPassword(req, res) {
    try {
      const account = await CustomerAccount.getByDeviceId(req.params.deviceId);
      if (!account) {
        return res.status(404).json(
          createErrorResponse(req.t('device.noCustomerAccount'))
        );
      }
      const password = await CustomerPortalPasswordService.reset(account.id);
      // A reset is a reveal with the old password thrown away: whoever called
      // this now holds working credentials for a subscriber's portal, and the
      // subscriber's own password has stopped working without them asking. The
      // new password is not recorded for the same reason the revealed one is
      // not — see AuditLog — and its failure is swallowed there because the
      // subscriber's password has already been replaced by the time we get
      // here. Failing the request would tell the operator to try again, which
      // would rotate it a second time.
      await AuditLog.recordFromRequest(req, {
        action: AUDIT_ACTIONS.PORTAL_PASSWORD_RESET,
        targetType: 'customer_account',
        targetId: account.customer_id,
        metadata: { deviceId: req.params.deviceId }
      });
      return res.json(createResponse(req.t('device.portalPasswordRegenerated'), {
        customerId: account.customer_id,
        password
      }));
    } catch (error) {
      console.error('Reset portal password error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.portalPasswordResetFailed'), error.message)
      );
    }
  }

  static async deleteDevice(req, res) {
    try {
      const { deviceId } = req.params;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse(req.t('device.idRequired'))
        );
      }

      await DeviceService.deleteDevice(deviceId);
      return res.json(
        createResponse(req.t('device.deleted'), { deviceId })
      );
    } catch (error) {
      console.error('Delete device error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.deleteFailed'), error.message)
      );
    }
  }

  static async rebootDevice(req, res) {
    try {
      const { deviceId } = req.body;
      
      if (!deviceId) {
        return res.status(400).json(
          createErrorResponse(req.t('device.idRequired'))
        );
      }

      const result = await DeviceService.rebootDevice(deviceId);
      return res.json(
        createResponse(req.t('device.rebootStarted'), { 
          deviceId, 
          taskResponse: result 
        })
      );
    } catch (error) {
      console.error('Reboot device error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('device.rebootFailed'), error.message)
      );
    }
  }

  static async summonDevice(req, res) {
    const { deviceId, parameters = [] } = req.body;

    if (!deviceId) {
      return res.status(400).json(
        createErrorResponse(req.t('device.idRequired'))
      );
    }

    try {
      const data = await DeviceService.summonDevice(deviceId, parameters);
      return res.json(
        createResponse(req.t('device.summonQueued'), data)
      );
    } catch (error) {
      console.error('Error summoning device:', error.message);
      return res.status(500).json(
        createErrorResponse(req.t('device.summonFailed'), error.message)
      );
    }
  }

  static async updateWanConfig(req, res) {
    const { id } = req.params;
    const { wanIndex, formData } = req.body;
    
    if (!wanIndex || !formData) {
      return res.status(400).json({ success: false, message: req.t('device.wanFieldsRequired') });
    }

    try {
      const result = await DeviceService.updateWanConfig(id, wanIndex, formData);
      return res.json(createResponse(req.t(result.messageKey, result.messageVars), result));
    } catch (error) {
      console.error(`Error in updateWanConfig for ${id}:`, error);
      const validationError = /^(Invalid|VLAN ID|PPP |WAN |No editable|Only PPPoE|Vendor not found)/.test(error.message);
      res.status(validationError ? 400 : 500).json(
        createErrorResponse(req.t('device.wanUpdateFailed'), error.message)
      );
    }
  }

  static async addWanConnection(req, res) {
    const { id } = req.params;
    const { containerPath, type } = req.body || {};
    if (!containerPath || !type) {
      return res.status(400).json(createErrorResponse(req.t('device.wanContainerRequired')));
    }
    try {
      const result = await DeviceService.addWanConnection(id, String(containerPath), String(type));
      DeviceService.invalidateDashboard();
      return res.json(createResponse(req.t(result.messageKey, result.messageVars), result));
    } catch (error) {
      console.error(`Error adding WAN connection for ${id}:`, error);
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error))
        );
      }
      const validationError = /^Invalid WAN/.test(error.message);
      return res.status(validationError ? 400 : 502).json(
        createErrorResponse(req.t('device.wanAddFailed'), error.message)
      );
    }
  }

  static async updateInstallationDate(req, res) {
    const { id } = req.params;
    const installationDate = CustomerService.normalizeInstallationDate(req.body?.installationDate);
    if (!installationDate) {
      return res.status(400).json(createErrorResponse(req.t('device.installationDateFormat')));
    }
    try {
      const detail = await DeviceService.getDetailDevice(id);
      const previous = await DeviceProfile.getByDeviceId(id);
      const installationTag = await DeviceService.syncInstallationTag(
        id,
        installationDate,
        previous?.installation_tag || null
      );
      const profile = await DeviceProfile.upsertInstallationDate(id, installationDate, installationTag);
      let account = await CustomerAccount.getByDeviceId(id);
      if (!account && await CustomerService.isAutoGenerationEnabled()) {
        account = await CustomerService.ensureAccount({
          _id: id,
          softwareId: detail.deviceInfo?.softwareVersion,
          pppoe: detail.virtualParameters?.pppoeUsername?.value
        });
      }
      return res.json(createResponse(req.t('device.installationDateSaved'), {
        installationDate: profile.installation_date,
        installationTag,
        customerId: account?.customer_id || null
      }));
    } catch (error) {
      console.error(`Error saving installation date for ${id}:`, error);
      const status = error.translationKey === 'device.notFound' ? 404 : 502;
      return res.status(status).json(
        createErrorResponse(req.t('device.installationDateFailed'), error.message)
      );
    }
  }

  static async updateCredentials(req, res) {
    const { id } = req.params;
    const { type, password } = req.body;

    if (!type || !password) {
      return res.status(400).json({ success: false, message: req.t('device.credentialFieldsRequired') });
    }

    try {
      const result = await DeviceService.updateCredentials(id, type, password);
      res.json({ success: true, data: result, message: req.t(result.messageKey, result.messageVars) });
    } catch (error) {
      console.error(`Error in updateCredentials for ${id}:`, error);
      const validationError = /^(Invalid credential|Password must|VirtualParameter path)/.test(error.message);
      res.status(validationError ? 400 : 500).json(
        createErrorResponse(req.t('device.credentialUpdateFailed'), error.message)
      );
    }
  }

  static async updateWifiConfig(req, res) {
    const { id } = req.params;
    const { index, formData } = req.body || {};
    if (index === undefined || !formData) {
      return res.status(400).json(createErrorResponse(req.t('device.wifiFieldsRequired')));
    }
    try {
      const result = await DeviceService.updateWifiConfig(id, index, formData);
      DeviceService.invalidateDashboard();
      return res.json(createResponse(req.t(result.messageKey, result.messageVars), result));
    } catch (error) {
      console.error(`Error in updateWifiConfig for ${id}:`, error);
      if (error.translationKey) {
        return res.status(error.status || 400).json(
          createErrorResponse(translateError(req.t, error))
        );
      }
      return res.status(500).json(
        createErrorResponse(req.t('device.wifiUpdateFailed'), error.message)
      );
    }
  }
}

export default DeviceController;
