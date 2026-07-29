import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { listModels } from '../../controllers/ai.controller.js';

const router = Router();

// Model catalog for the selector. Requires auth so anonymous users can't probe config.
router.get('/models', requireAuth, listModels);

export default router;
