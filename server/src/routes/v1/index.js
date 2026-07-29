import { Router } from 'express';
import authRoutes from './auth.routes.js';
import conversationRoutes from './conversation.routes.js';
import aiRoutes from './ai.routes.js';

/**
 * Versioned API router mounted at /api/v1 (§24).
 * Route groups are added here as later phases land (users, files, search, etc.).
 */
const router = Router();

router.get('/', (_req, res) =>
  res.json({ success: true, data: { name: 'AiChat API', version: 'v1' } }),
);

router.use('/auth', authRoutes);
router.use('/conversations', conversationRoutes);
router.use('/ai', aiRoutes);

export default router;
