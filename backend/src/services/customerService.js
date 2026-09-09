import crypto from 'node:crypto';
import CustomerAccount from '../models/CustomerAccount.js';
import SgpLink from '../models/SgpLink.js';
import CustomerPortalPasswordService from './customerPortalPasswordService.js';
import DeviceSwapService from './deviceSwapService.js';
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

  /**
   * The PPPoE login is what identifies a subscriber. The software version is
   * not: a firmware upgrade must never look like a change of customer.
   */
  static isSameSubscriber(account, pppoeUsername) {
    const stored = String(account?.pppoe_username ?? '').trim().toLowerCase();
    const incoming = String(pppoeUsername ?? '').trim().toLowerCase();
    return Boolean(stored) && stored === incoming;
  }

  /**
   * Closes the account of the previous subscriber of an ONT and drops anything
   * bound to that device, so the incoming subscriber starts from a clean slate
   * instead of inheriting a Customer ID, a portal password, saved WiFi
   * credentials and an SGP contract that belong to someone else.
   */
  static async retireAccount(account, incomingPppoe) {
    const previousDeviceId = account.device_id;
    // Retiring is destructive: the subscriber gets a new Customer ID and a new
    // portal password. Log it so a misreported PPPoE login is visible rather
    // than silently re-issuing credentials for a live customer.
    console.warn(
      `Device ${previousDeviceId} now reports PPPoE "${incomingPppoe}" instead of `
      + `"${account.pppoe_username}"; retiring customer account ${account.customer_id}.`
    );
    await CustomerAccount.retire(account.id);
    try {
      await SgpLink.deleteByDeviceId(previousDeviceId);
    } catch (error) {
      console.warn(`Unable to drop the SGP link of a retired account: ${error.message}`);
    }
    return account;
  }

  static async ensureAccount(device) {
    const deviceId = normalizeIdentityValue(device?._id);
    const softwareId = normalizeIdentityValue(device?.softwareId);
    const pppoeUsername = normalizeIdentityValue(device?.pppoe);
    if (!deviceId || !softwareId || !pppoeUsername) return null;

    const identityHash = this.identityHash(softwareId, pppoeUsername);

    const existingByDevice = await CustomerAccount.getByDeviceId(deviceId);
    if (existingByDevice) {
      if (this.isSameSubscriber(existingByDevice, pppoeUsername)) {
        // Same subscriber; refresh the stored identity so a firmware upgrade
        // does not leave the account describing an old software version.
        return this.touchIdentity(existingByDevice, deviceId, softwareId, identityHash);
      }
      // The ONT was re-provisioned for someone else.
      await this.retireAccount(existingByDevice, pppoeUsername);
    }

    const existingByIdentity = await CustomerAccount.getByIdentityHash(identityHash);
    if (existingByIdentity) {
      // A replacement ONT of the same model on the same firmware hashes to the
      // same identity, so this branch — not the PPPoE one below — is where the
      // ordinary swap lands.
      const moved = await CustomerAccount.touch(existingByIdentity.id, deviceId);
      await this.noteSwap(existingByIdentity, deviceId, 'identity_hash');
      return moved;
    }

    // The same subscriber on a replacement ONT: the device ID and the software
    // version both changed, so only the PPPoE login still matches.
    const existingByPppoe = await CustomerAccount.getActiveByPppoe(pppoeUsername);
    if (existingByPppoe) {
      const moved = await this.touchIdentity(existingByPppoe, deviceId, softwareId, identityHash);
      await this.noteSwap(existingByPppoe, deviceId, 'pppoe');
      return moved;
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

  /**
   * Files the replacement of one ONT by another, once the account has already
   * moved onto the new one.
   *
   * After the move, not before: the record is of something that happened, and
   * writing it first would leave a swap on file that the sync then failed to
   * carry out. It also never fails the sync — a device whose account moved but
   * whose swap could not be filed is a missing line in a list, and refusing the
   * whole sync over it would take the panel's device page down with it.
   */
  static async noteSwap(account, deviceId, matchedBy) {
    const previousDeviceId = normalizeIdentityValue(account?.device_id);
    if (!previousDeviceId || previousDeviceId === deviceId) return null;
    try {
      return await DeviceSwapService.record(account, previousDeviceId, deviceId, matchedBy);
    } catch (error) {
      console.warn(`Unable to record a CPE swap for ${previousDeviceId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Moves an account onto a device and refreshes its identity columns. The
   * identity hash is unique, so a collision with another row leaves the stored
   * hash alone rather than failing the sync.
   */
  static async touchIdentity(account, deviceId, softwareId, identityHash) {
    try {
      return await CustomerAccount.touch(account.id, deviceId, {
        software_id: softwareId,
        identity_hash: identityHash
      });
    } catch (error) {
      const duplicate =
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.code === 'ER_DUP_ENTRY' ||
        /unique/i.test(error.message);
      if (!duplicate) throw error;
      return CustomerAccount.touch(account.id, deviceId);
    }
  }

  static async syncDevices(devices, { enabled } = {}) {
    const shouldGenerate = enabled ?? await this.isAutoGenerationEnabled();
    const deviceIds = devices.map((device) => String(device?._id || '')).filter(Boolean);
    let rows = await CustomerAccount.getIdsByDeviceIds(deviceIds);

    if (shouldGenerate) {
      const storedByDeviceId = new Map(rows.map((row) => [row.device_id, row]));
      // A device with no account needs one; a device whose account still names
      // the previous subscriber's PPPoE login needs that account retired before
      // the new subscriber inherits it.
      const pending = devices.filter((device) => {
        if (!device?._id) return false;
        const stored = storedByDeviceId.get(String(device._id));
        if (!stored) return true;
        // A blank or implausibly short login is a reporting gap, not a new
        // subscriber, and must never cost a live customer their credentials.
        const reported = normalizeIdentityValue(device.pppoe);
        if (reported.length < 3) return false;
        return !this.isSameSubscriber(stored, reported);
      });
      // Keep database pressure bounded while avoiding a slow one-by-one sync
      // for larger GenieACS fleets.
      for (let offset = 0; offset < pending.length; offset += 10) {
        await Promise.all(
          pending.slice(offset, offset + 10).map((device) => this.ensureAccount(device))
        );
      }
      if (pending.length > 0) {
        rows = await CustomerAccount.getIdsByDeviceIds(deviceIds);
      }
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
