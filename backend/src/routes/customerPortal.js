import express from 'express';
import CustomerPortalController from '../controllers/customerPortalController.js';
import { authenticatePortalCustomer } from '../middleware/portalAuth.js';
import {
  portalAccountLimiter,
  portalBillingLimiter,
  portalMutationLimiter,
  portalRevealLimiter,
  portalUnlockLimiter
} from '../middleware/rateLimit.js';

const router = express.Router();

// Every authenticated limiter runs after authentication so that it can be keyed
// by customer account instead of by source address, which is shared by the
// whole customer base behind a reverse proxy or Cloudflare Tunnel.
router.post('/login', CustomerPortalController.login);
router.get(
  '/session',
  authenticatePortalCustomer,
  portalAccountLimiter,
  CustomerPortalController.session
);
router.get(
  '/overview',
  authenticatePortalCustomer,
  portalAccountLimiter,
  CustomerPortalController.overview
);
router.get(
  '/wifi/:index/password',
  authenticatePortalCustomer,
  portalAccountLimiter,
  portalRevealLimiter,
  CustomerPortalController.revealWifiPassword
);
router.put(
  '/wifi',
  authenticatePortalCustomer,
  portalAccountLimiter,
  portalMutationLimiter,
  CustomerPortalController.updateWifi
);
router.get(
  '/billing',
  authenticatePortalCustomer,
  portalAccountLimiter,
  portalBillingLimiter,
  CustomerPortalController.billing
);
router.post(
  '/billing/trust-unlock',
  authenticatePortalCustomer,
  portalAccountLimiter,
  portalUnlockLimiter,
  CustomerPortalController.trustUnlock
);
router.post(
  '/logout',
  authenticatePortalCustomer,
  portalAccountLimiter,
  CustomerPortalController.logout
);

export default router;
