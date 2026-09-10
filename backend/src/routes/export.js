import express from 'express';
import ExportController from '../controllers/exportController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

/**
 * Administrator only, and administrator OF THIS PROVIDER — which is what
 * `requireRole` means here, since the role it reads is the one on the
 * membership the token names, not the deployment-wide column. A consultant who
 * runs her own ISP and merely operates this one is an administrator there and
 * an operator here, and this route is the whole provider in one file: it is
 * exactly the shape of thing that must answer to where she stands, not to what
 * she is called elsewhere.
 *
 * Mounted in both editions. The self-hosted ISP wants it as a backup it can
 * read; the SaaS tenant is owed it by law and on the day they cancel.
 */
router.get('/', authenticateToken, requireRole(['admin']), ExportController.download);

export default router;
