import PlatformAudit from '../models/PlatformAudit.js';
import { PlatformProfileError, readProfile, saveProfile } from '../services/platformProfileService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * Configurações do console: os dados da empresa que vende o SaaS, que a
 * página pública e os avisos da equipe usam. Ver `platformProfileService`.
 */
class PlatformSettingsController {
  static async getProfile(req, res) {
    try {
      return res.json(createResponse('Profile retrieved', await readProfile()));
    } catch (error) {
      console.error('Read platform profile error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the profile', error.message));
    }
  }

  static async updateProfile(req, res) {
    try {
      const changed = await saveProfile(req.body ?? {});
      if (changed.length) {
        await PlatformAudit.fromRequest(req, {
          action: PlatformAudit.ACTIONS.PLATFORM_PROFILE_CHANGED,
          detail: { fields: changed }
        });
      }
      return res.json(createResponse('Profile saved', { ...(await readProfile()), changed }));
    } catch (error) {
      if (error instanceof PlatformProfileError) {
        return res.status(error.status).json({ ...createErrorResponse(error.message), field: error.field });
      }
      console.error('Save platform profile error:', error);
      return res.status(500).json(createErrorResponse('Failed to save the profile', error.message));
    }
  }
}

export default PlatformSettingsController;
