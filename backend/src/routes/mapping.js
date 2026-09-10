import express from 'express';
import MappingController from '../controllers/mappingController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.get('/nodes', authenticateToken, requirePermission('map.read'), MappingController.getAllNodes);

router.get('/nodes/:nodeId', authenticateToken, requirePermission('map.read'), MappingController.getNodeByNodeId);

router.post('/nodes', authenticateToken, requirePermission('map.write'), MappingController.createNode);

router.put('/nodes/:nodeId', authenticateToken, requirePermission('map.write'), MappingController.updateNode);

router.delete('/nodes/:nodeId', authenticateToken, requirePermission('map.write'), MappingController.deleteNode);

router.get('/edges', authenticateToken, requirePermission('map.read'), MappingController.getAllEdges);

router.get('/edges/:edgeId', authenticateToken, requirePermission('map.read'), MappingController.getEdgeByEdgeId);

router.post('/edges', authenticateToken, requirePermission('map.write'), MappingController.createEdge);

router.put('/edges/:edgeId', authenticateToken, requirePermission('map.write'), MappingController.updateEdge);

router.delete('/edges/:edgeId', authenticateToken, requirePermission('map.write'), MappingController.deleteEdge);

router.post('/sync', authenticateToken, requirePermission('map.write'), MappingController.syncMappingData);

router.delete('/reset', authenticateToken, requirePermission('map.write'), MappingController.resetMappingData);

export default router;