import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import * as adminController from '../../controllers/admin.controller.js';

const router = Router();

// ── Unauthenticated admin sign-in ──
// Email + password login for administrators. Rate-limited like the other
// credential endpoints. MUST be declared before the requireAuth guard below.
router.post('/login', authLimiter, adminController.adminLogin);

// Everything past this point: authenticated administrators only.
router.use(requireAuth, requireRole('admin'));

// ── Session ──
router.get('/me', adminController.adminMe);
router.post('/logout', adminController.adminLogout);

// ── Database browsing (read-only, sensitive fields redacted) ──
router.get('/overview', adminController.dbOverview);
router.get('/db/collections', adminController.dbCollections);
router.get('/db/collections/:model', adminController.dbDocuments);
router.get('/db/collections/:model/:id', adminController.dbDocument);

// ── Inference platform operations ──
router.get('/ai/status', adminController.aiStatus);
router.post('/ai/queue/pause', adminController.pauseGenerationQueue);
router.post('/ai/queue/resume', adminController.resumeGenerationQueue);
router.post('/ai/queue/clean', adminController.cleanQueue);

export default router;
