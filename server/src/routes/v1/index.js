import { Router } from 'express';
import authRoutes from './auth.routes.js';
import conversationRoutes from './conversation.routes.js';
import aiRoutes from './ai.routes.js';
import ragRoutes from './rag.routes.js';
import adminRoutes from './admin.routes.js';

/**
 * Versioned API router mounted at /api/v1 (§24).
 */
const router = Router();

router.get('/', (_req, res) =>
  res.json({ success: true, data: { name: 'ATOZAS AI API', version: 'v1' } }),
);

router.use('/auth', authRoutes);
router.use('/conversations', conversationRoutes);
router.use('/ai', aiRoutes);
router.use('/rag', ragRoutes);
router.use('/admin', adminRoutes);

export default router;
