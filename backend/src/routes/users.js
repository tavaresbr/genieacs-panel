import express from 'express';
import UsersController from '../controllers/usersController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, requireRole(['admin']), UsersController.list);
router.post('/', authenticateToken, requireRole(['admin']), UsersController.create);
router.patch('/:id', authenticateToken, requireRole(['admin']), UsersController.update);
router.delete('/:id', authenticateToken, requireRole(['admin']), UsersController.remove);

export default router;
