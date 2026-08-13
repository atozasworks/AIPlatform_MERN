import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { publicChatLimiter } from '../../middleware/rateLimit.js';
import { ensureGuestId } from '../../middleware/guest.js';
import {
  publicRoomStreamSchema,
  ephemeralStreamSchema,
  publicJobSchema,
  publicCancelSchema,
  publicSessionListSchema,
  publicSessionCreateSchema,
  publicSessionIdSchema,
} from '../../validators/publicChat.validator.js';
import * as publicChat from '../../controllers/publicChat.controller.js';

/**
 * Pre-login guest chat. No requireAuth. Sessions are owned by a guest_sid
 * cookie so visitors do not share one global thread.
 */
const router = Router();

router.use(publicChatLimiter);
router.use(ensureGuestId);

router.get('/models', publicChat.listModels);
router.get('/profiles', publicChat.listPromptProfiles);

router.get('/sessions', validate(publicSessionListSchema), publicChat.listSessions);
router.post('/sessions', validate(publicSessionCreateSchema), publicChat.createSession);
router.get('/sessions/:id', validate(publicSessionIdSchema), publicChat.getSession);
router.delete('/sessions/:id', validate(publicSessionIdSchema), publicChat.deleteSession);
router.post(
  '/sessions/:id/stream',
  validate(publicRoomStreamSchema),
  publicChat.streamPublic,
);

router.post('/ephemeral/stream', validate(ephemeralStreamSchema), publicChat.streamEphemeral);

router.get('/stream/:jobId', validate(publicJobSchema), publicChat.resumeGuestStream);
router.post('/stream/:jobId/cancel', validate(publicCancelSchema), publicChat.cancelGuestGeneration);

export default router;
