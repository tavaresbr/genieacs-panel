import crypto from 'node:crypto';
import CustomerAccount from '../models/CustomerAccount.js';
import CustomerPortalPasswordService from './customerPortalPasswordService.js';
import DeviceProfile from '../models/DeviceProfile.js';
import Setting from '../models/Setting.js';
import { TranslatableError } from '../i18n/index.js';

const CUSTOMER_ID_PATTERN = /^[A-Z]{2,4}-[A-Z0-9]{7}-[A-Z0-9]{6}$/;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_GENERATION_SETTINGS = Object.freeze({
  prefixMode: 'default',
  companyPrefix: 'CSG',
  suffixMode: 'random'
});

function randomString(alphabet, length) {
  let result = '';
  while (result.length < length) {
    const bytes = crypto.randomBytes(length - result.length);
    for (const byte of bytes) {
      const limit = 256 - (256 % alphabet.length);
      if (byte < limit) result += alphabet[byte % alphabet.length];
      if (result.length === length) break;
    }
  }
  return result;
}

function normalizeIdentityValue(value) {
  return String(value ?? '').trim();
}

class CustomerService {
  static isEnabledValue(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  static async isAutoGenerationEnabled() {
    return this.isEnabledValue(await Setting.getByKey('autoGenerateCustomerId'));
  }

  static identityHash(softwareId, pppoeUsername) {
    return crypto
      .createHash('sha256')
      .update(`${normalizeIdentityValue(softwareId)}\0${normalizeIdentityValue(pppoeUsername)}`)
      .digest('hex');
  }

  static normalizeInstallationDate(value) {
    const normalized = String(value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
    const parsed = new Date(`${normalized}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
      return null;
    }
    return normalized;
  }

  static installationDateSuffix(value) {
    const date = this.normalizeInstallationDate(value);
    return date ? `${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}` : null;
  }

  static normalizeGenerationSettings(settings = {}) {
    const prefixMode = settings.prefixMode === 'company' ? 'company' : 'default';
    const companyPrefix = String(settings.companyPrefix || 'CSG').trim().toUpperCase();
    const suffixMode = settings.suffixMode === 'installation_date' ? 'installation_date' : 'random';
    return {
      prefixMode,
      companyPrefix: /^[A-Z]{2,4}$/.test(companyPrefix) ? companyPrefix : 'CSG',
      suffixMode
    };
  }

  static async getGenerationSettings() {
    const [prefixMode, companyPrefix, suffixMode] = await Promise.all([
      Setting.getByKey('customerIdPrefixMode'),
      Setting.getByKey('customerIdCompanyPrefix'),
      Setting.getByKey('customerIdSuffixMode')
    ]);
    return this.normalizeGenerationSettings({ prefixMode, companyPrefix, suffixMode });
  }

  static generateCustomerId(settings = DEFAULT_GENERATION_SETTINGS, installationDate = null) {
    const config = this.normalizeGenerationSettings(settings);
    const prefix = config.prefixMode === 'company' ? config.companyPrefix : 'CSG';
    const suffix = config.suffixMode === 'installation_date'
      ? this.installationDateSuffix(installationDate)
      : randomString(ID_ALPHABET, 6);
    if (!suffix) return null;
    return `${prefix}-${randomString(ID_ALPHABET, 7)}-${suffix}`;
  }

  static normalizeCustomerId(value) {
    const customerId = String(value ?? '').trim().toUpperCase();
    return CUSTOMER_ID_PATTERN.test(customerId) ? customerId : null;
  }

  static async ensureAccount(device) {
    const deviceId = normalizeIdentityValue(device?._id);
    const softwareId = normalizeIdentityValue(device?.softwareId);
    const pppoeUsername = normalizeIdentityValue(device?.pppoe);
    if (!deviceId || !softwareId || !pppoeUsername) return null;

    const existingByDevice = await CustomerAccount.getByDeviceId(deviceId);
    if (existingByDevice) {
      return CustomerAccount.touch(existingByDevice.id, deviceId);
    }

    const identityHash = this.identityHash(softwareId, pppoeUsername);
    const existingByIdentity = await CustomerAccount.getByIdentityHash(identityHash);
    if (existingByIdentity) {
      return CustomerAccount.touch(existingByIdentity.id, deviceId);
    }

    const generationSettings = await this.getGenerationSettings();
    const profile = generationSettings.suffixMode === 'installation_date'
      ? await DeviceProfile.getByDeviceId(deviceId)
      : null;
    const customerId = this.generateCustomerId(generationSettings, profile?.installation_date);
    if (!customerId) return null;

    // Every account gets its own portal password. The Customer ID identifies
    // the account; it must never be usable as the credential for it.
    const { record: passwordRecord } = await CustomerPortalPasswordService.createRecord();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await CustomerAccount.create({
          customer_id: attempt === 0
            ? customerId
            : this.generateCustomerId(generationSettings, profile?.installation_date),
          device_id: deviceId,
          identity_hash: identityHash,
          software_id: softwareId,
          pppoe_username: pppoeUsername,
          active: true,
          ...passwordRecord,
          last_seen_at: new Date()
        });
      } catch (error) {
        const duplicate =
          error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          error.code === 'ER_DUP_ENTRY' ||
          /unique/i.test(error.message);
        if (!duplicate) throw error;

        const concurrent = await CustomerAccount.getByDeviceId(deviceId)
          || await CustomerAccount.getByIdentityHash(identityHash);
        if (concurrent) return concurrent;
      }
    }
    throw new TranslatableError('settings.customerIdAllocationFailed');
  }

  static async syncDevices(devices, { enabled } = {}) {
    const shouldGenerate = enabled ?? await this.isAutoGenerationEnabled();
    const deviceIds = devices.map((device) => String(device?._id || '')).filter(Boolean);
    let rows = await CustomerAccount.getIdsByDeviceIds(deviceIds);

    if (shouldGenerate && rows.length < deviceIds.length) {
      const existingDeviceIds = new Set(rows.map((row) => row.device_id));
      const missing = devices.filter((device) => (
        device?._id && !existingDeviceIds.has(String(device._id))
      ));
      // Keep database pressure bounded while avoiding a slow one-by-one sync
      // for larger GenieACS fleets.
      for (let offset = 0; offset < missing.length; offset += 10) {
        await Promise.all(
          missing.slice(offset, offset + 10).map((device) => this.ensureAccount(device))
        );
      }
      rows = await CustomerAccount.getIdsByDeviceIds(deviceIds);
    }

    return new Map(rows.map((row) => [row.device_id, row.customer_id]));
  }

  static async decorateDevices(devices) {
    const customerIds = await this.syncDevices(devices);
    return devices.map((device) => ({
      ...device,
      customerId: customerIds.get(String(device._id)) || null
    }));
  }
}

export default CustomerService;
