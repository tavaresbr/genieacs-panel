import express from 'express';
import UsersController from '../controllers/usersController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, requirePermission('operators.read'), UsersController.list);
router.post('/', authenticateToken, requirePermission('operators.manage'), UsersController.create);
router.patch('/:id', authenticateToken, requirePermission('operators.manage'), UsersController.update);
router.delete('/:id', authenticateToken, requirePermission('operators.manage'), UsersController.remove);

export default router;
