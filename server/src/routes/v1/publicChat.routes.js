import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { publicChatLimiter } from '../../middleware/rateLimit.js';
import {
  publicRoomStreamSchema,
  ephemeralStreamSchema,
  publicJobSchema,
  publicCancelSchema,
} from '../../validators/publicChat.validator.js';
import * as publicChat from '../../controllers/publicChat.controller.js';

/**
 * Pre-login public/private chat. Intentionally has no requireAuth and does not
 * touch /conversations or authenticated Message/Conversation models.
 */
const router = Router();

router.use(publicChatLimiter);

router.get('/models', publicChat.listModels);
router.get('/profiles', publicChat.listPromptProfiles);

router.get('/room', publicChat.getRoom);
router.get('/room/messages', publicChat.getMessages);
router.post('/room/stream', validate(publicRoomStreamSchema), publicChat.streamPublic);

router.post('/ephemeral/stream', validate(ephemeralStreamSchema), publicChat.streamEphemeral);

router.get('/stream/:jobId', validate(publicJobSchema), publicChat.resumeGuestStream);
router.post('/stream/:jobId/cancel', validate(publicCancelSchema), publicChat.cancelGuestGeneration);

export default router;
