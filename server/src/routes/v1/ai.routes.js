import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { listModels, listPromptProfiles, getUsage } from '../../controllers/ai.controller.js';

const router = Router();

// All of these require auth so anonymous callers cannot probe the deployment.
router.get('/models', requireAuth, listModels);
router.get('/profiles', requireAuth, listPromptProfiles);
router.get('/usage', requireAuth, getUsage);

export default router;
