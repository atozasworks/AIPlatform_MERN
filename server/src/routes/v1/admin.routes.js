import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import * as adminController from '../../controllers/admin.controller.js';

const router = Router();

// Operational data and controls: authenticated administrators only.
router.use(requireAuth, requireRole('admin'));

router.get('/ai/status', adminController.aiStatus);
router.post('/ai/queue/pause', adminController.pauseGenerationQueue);
router.post('/ai/queue/resume', adminController.resumeGenerationQueue);
router.post('/ai/queue/clean', adminController.cleanQueue);

export default router;
