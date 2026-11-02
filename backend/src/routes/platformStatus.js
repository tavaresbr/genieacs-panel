import express from 'express';
import StatusController from '../controllers/statusController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * A página de status (0127), vista do console: as verificações com o detalhe,
 * os incidentes e as manutenções. A página pública mora em `routes/public.js`.
 */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/status', ...guard, StatusController.overview);
router.post('/status/checks', ...guard, StatusController.runChecks);
router.post('/status/incidents', ...guard, StatusController.create);
router.patch('/status/incidents/:id', ...guard, StatusController.update);
router.post('/status/incidents/:id/updates', ...guard, StatusController.postUpdate);

export default router;
