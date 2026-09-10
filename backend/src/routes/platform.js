import express from 'express';
import PlatformController from '../controllers/platformController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * The SaaS control plane.
 *
 * Every route here is guarded twice over, and the two guards answer different
 * questions. `authenticateToken` asks who is signed in and at which provider;
 * `requirePlatformAdmin` asks whether that person is on the platform roster at
 * all — a plane ABOVE any provider, because minting a provider and reaching
 * between providers is precisely what a provider's own administrator must not
 * be able to do, however senior they are inside their own ISP.
 *
 * `platform_admins` is created empty and no migration promotes anybody, so on a
 * deployment where nobody has been granted the role these routes exist and
 * refuse everyone. That is the safe side of failing.
 *
 * There is no DELETE for a provider. See the controller for why.
 */
const router = express.Router();

router.get('/tenants', authenticateToken, requirePlatformAdmin, PlatformController.listTenants);
router.post('/tenants', authenticateToken, requirePlatformAdmin, PlatformController.create);
router.patch('/tenants/:id', authenticateToken, requirePlatformAdmin, PlatformController.setStatus);

export default router;
