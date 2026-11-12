import express from 'express';
import UsersController from '../controllers/usersController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { operatorCreateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

router.get('/', authenticateToken, requirePermission('operators.read'), UsersController.list);
// Limitado: o 409 de e-mail em uso responde se um endereço tem conta em algum
// provedor da plataforma — ver `operatorCreateLimiter`.
router.post('/', operatorCreateLimiter, authenticateToken, requirePermission('operators.manage'), UsersController.create);
// O cadastro (CPF, endereço, contato, trabalho). Sem `requirePermission`: a
// própria pessoa edita o seu; quem administra edita o dos outros. A regra está
// no controlador (`profileTarget`), porque depende de QUEM é o alvo.
router.get('/:id/profile', authenticateToken, UsersController.getProfile);
router.patch('/:id/profile', authenticateToken, UsersController.updateProfile);
// A foto: JSON com a imagem em data URL (já reduzida no navegador). Mesma regra do cadastro.
router.put('/:id/avatar', authenticateToken, UsersController.setAvatar);
router.delete('/:id/avatar', authenticateToken, UsersController.removeAvatar);
router.patch('/:id', authenticateToken, requirePermission('operators.manage'), UsersController.update);
router.delete('/:id', authenticateToken, requirePermission('operators.manage'), UsersController.remove);
// Desliga o 2FA de quem perdeu o celular e os códigos. As regras (dono, outro
// provedor, plataforma) estão no controlador.
router.post('/:id/mfa-reset', authenticateToken, requirePermission('operators.manage'), UsersController.resetMfa);

export default router;
