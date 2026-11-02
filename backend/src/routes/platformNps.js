import express from 'express';
import NpsController from '../controllers/npsController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * A pesquisa de satisfação dos provedores (0123), vista do console: o
 * relatório da seção "Satisfação" e o "Enviar pesquisa". A página pública do
 * link mora em `routes/public.js`.
 */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/reports/nps', ...guard, NpsController.report);
router.post('/tenants/:id/nps', ...guard, NpsController.sendManual);

export default router;
