import express from 'express';
import { IS_SAAS } from '../config/edition.js';
import AuthController from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/setup-status', AuthController.getSetupStatus);

router.post('/setup', AuthController.setupAdmin);
// Um provedor novo se cadastrando sozinho. Só existe na edição SaaS — montado
// atrás de `IS_SAAS` para que, na self-hosted, a rota responda 404 e não 403:
// um 403 diria que há um cadastro para encontrar.
if (IS_SAAS) router.post('/signup', AuthController.signup);

router.post('/login', AuthController.login);

router.get('/user', authenticateToken, AuthController.getCurrentUser);

router.post('/logout', authenticateToken, AuthController.logout);

router.post('/refresh', AuthController.refreshToken);

router.post('/change-password', authenticateToken, AuthController.changePassword);

router.post('/change-username', authenticateToken, AuthController.changeUsername);

export default router;