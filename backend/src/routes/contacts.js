import express from 'express';
import ContactController from '../controllers/contactController.js';
import { IMPORT_MAX_BYTES } from '../services/contactSheetService.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { sgpAdminLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * The client record behind the Contacts screen. `:key` is the same key the
 * contacts list hands out — a contract, or `c:<id>` for a client with no
 * contract — and every read goes through `tdb`, so a key from another
 * provider finds nothing.
 */
router.post('/', authenticateToken, requirePermission('contacts.edit'), ContactController.create);
// Before `/:key`, or `export` would be read as a key. The whole base in one
// file — admin and owner only, like `tenant.export`.
router.get('/export', authenticateToken, requirePermission('contacts.export'), ContactController.exportSheet);
router.post(
  '/import',
  authenticateToken,
  requirePermission('contacts.import'),
  // The sheet arrives as text; one byte over the limit is a 413 before any row is read.
  express.text({ type: () => true, limit: IMPORT_MAX_BYTES }),
  ContactController.importSheet
);
router.get('/:key', authenticateToken, requirePermission('contacts.read'), ContactController.get);
// Asks the SGP, once per contract: the same limiter as every other SGP read an
// operator can trigger by hand.
router.get(
  '/:key/invoices',
  authenticateToken,
  requirePermission('contacts.read'),
  sgpAdminLimiter,
  ContactController.invoices
);
router.patch('/:key', authenticateToken, requirePermission('contacts.edit'), ContactController.update);

export default router;
