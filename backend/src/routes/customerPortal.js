import express from 'express';
import CustomerPortalController from '../controllers/customerPortalController.js';
import { authenticatePortalCustomer } from '../middleware/portalAuth.js';

const router = express.Router();

router.post('/login', CustomerPortalController.login);
router.get('/session', authenticatePortalCustomer, CustomerPortalController.session);
router.get('/overview', authenticatePortalCustomer, CustomerPortalController.overview);
router.get('/wifi/:index/password', authenticatePortalCustomer, CustomerPortalController.revealWifiPassword);
router.put('/wifi', authenticatePortalCustomer, CustomerPortalController.updateWifi);
router.get('/billing', authenticatePortalCustomer, CustomerPortalController.billing);
router.post('/billing/trust-unlock', authenticatePortalCustomer, CustomerPortalController.trustUnlock);
router.post('/logout', authenticatePortalCustomer, CustomerPortalController.logout);

export default router;
