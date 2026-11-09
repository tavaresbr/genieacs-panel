import express from 'express';
import TeiahController from '../controllers/teiahController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { teiahAdminLimiter, teiahExportLimiter } from '../middleware/rateLimit.js';
import { confirmOwnPassword } from '../middleware/confirmPassword.js';

const router = express.Router();

router.get('/config', authenticateToken, requirePermission('teiah.config'), TeiahController.getConfig);
router.put('/config', authenticateToken, requirePermission('teiah.config'), TeiahController.updateConfig);
router.post('/test', authenticateToken, requirePermission('teiah.config'), teiahAdminLimiter, TeiahController.testConnection);
// What the consultations cost, read from the TeiaH history (several pages): the test's budget.
router.get('/consultations/summary', authenticateToken, requirePermission('teiah.config'), teiahAdminLimiter, TeiahController.consultationSummary);

// Admin-only guards over the paid consultations. Whatever changes something
// or spends credits asks for the admin's own password (`confirmOwnPassword`),
// behind the limiter so the password cannot be guessed at speed.
const admin = [authenticateToken, requirePermission('teiah.config')];
router.get('/guards', ...admin, TeiahController.getGuards);
router.put('/guards', ...admin, teiahAdminLimiter, confirmOwnPassword, TeiahController.updateGuards);
router.get('/worsened', ...admin, TeiahController.worsened);
router.get('/reconsult/preview', ...admin, teiahAdminLimiter, TeiahController.reconsultPreview);
router.post('/reconsult/run', ...admin, teiahExportLimiter, confirmOwnPassword, TeiahController.reconsultRun);
router.post('/consultations/export', ...admin, teiahAdminLimiter, confirmOwnPassword, TeiahController.exportSpend);

router.get('/export', authenticateToken, requirePermission('teiah.read'), TeiahController.getExportStatus);
router.get('/export/items', authenticateToken, requirePermission('teiah.read'), TeiahController.listExportItems);
// The preview looks up the open invoices of a few contracts in the SGP, so it
// shares the connection test's budget.
router.get('/export/preview', authenticateToken, requirePermission('teiah.read'), teiahAdminLimiter, TeiahController.previewExport);
// A run reads every cancelled contract's invoices and writes to TeiaH.
router.post('/export/run', authenticateToken, requirePermission('teiah.act'), teiahExportLimiter, TeiahController.runExport);

export default router;
