import express from 'express';
import PushController from '../controllers/pushController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// As notificações push do app do provedor (0130). Toda rota é da pessoa
// logada e do provedor da sessão — nenhuma recebe id. Sem `requirePermission`
// de propósito: qualquer papel pode ter aparelho; o que cada um RECEBE é
// filtrado pela capacidade do evento (`EVENT_PERMISSION` em pushService).
router.get('/vapid-public-key', authenticateToken, PushController.vapidPublicKey);
router.post('/subscribe', authenticateToken, PushController.subscribe);
router.post('/unsubscribe', authenticateToken, PushController.unsubscribe);
router.post('/test', authenticateToken, PushController.test);
router.get('/preferences', authenticateToken, PushController.getPreferences);
router.put('/preferences', authenticateToken, PushController.savePreferences);

export default router;
