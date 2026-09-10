import express from 'express';
import AuthController from '../controllers/authController.js';
import { requirePermission, authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/setup-status', AuthController.getSetupStatus);

router.post('/setup', AuthController.setupAdmin);

router.post('/login', AuthController.login);

router.get('/user', authenticateToken, AuthController.getCurrentUser);

router.post('/logout', authenticateToken, AuthController.logout);

router.post('/refresh', AuthController.refreshToken);

router.post('/change-password', authenticateToken, AuthController.changePassword);

router.post('/change-username', authenticateToken, AuthController.changeUsername);

// O e-mail de login da própria pessoa: é por aqui que quem já usa o painel
// migra. `authenticateToken` e nada mais — é autoatendimento, e prendê-lo atrás
// de uma capacidade de administração deixaria de fora justamente quem precisa
// (um `tech` sem e-mail não conseguiria cadastrar o seu, e o login por e-mail
// nunca poderia ser exigido).
router.post('/email', authenticateToken, AuthController.changeEmail);

// Quantas contas ainda estão sem e-mail — o número que diz se dá para virar
// `LOGIN_REQUIRES_EMAIL` sem trancar ninguém do lado de fora.
router.get('/email-readiness', authenticateToken, requirePermission('operators.read'), AuthController.emailReadiness);

export default router;