import { getDb } from '../config/database.js';

class DeviceProfile {
  static async getByDeviceId(deviceId) {
    return (await getDb()('device_profiles').where({ device_id: deviceId }).first()) || null;
  }

  static async upsertInstallationDate(deviceId, installationDate, installationTag) {
    const db = getDb();
    const existing = await this.getByDeviceId(deviceId);
    const values = {
      installation_date: installationDate,
      installation_tag: installationTag,
      updated_at: new Date()
    };
    if (existing) {
      await db('device_profiles').where({ device_id: deviceId }).update(values);
    } else {
      await db('device_profiles').insert({
        device_id: deviceId,
        ...values,
        created_at: new Date()
      });
    }
    return this.getByDeviceId(deviceId);
  }
}

export default DeviceProfile;
