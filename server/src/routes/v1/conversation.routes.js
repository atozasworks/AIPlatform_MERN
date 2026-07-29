import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  createConversationSchema,
  updateConversationSchema,
  conversationIdSchema,
  listConversationsSchema,
} from '../../validators/conversation.validator.js';
import { chatStreamSchema } from '../../validators/ai.validator.js';
import * as conversationController from '../../controllers/conversation.controller.js';
import { streamChat } from '../../controllers/ai.controller.js';

const router = Router();

router.use(requireAuth);

router.post('/', validate(createConversationSchema), conversationController.create);
router.get('/', validate(listConversationsSchema), conversationController.list);
router.get('/:id', validate(conversationIdSchema), conversationController.getOne);
router.get('/:id/messages', validate(conversationIdSchema), conversationController.messages);
router.patch('/:id', validate(updateConversationSchema), conversationController.update);
router.delete('/:id', validate(conversationIdSchema), conversationController.remove);

// Streaming chat lives under the conversation it belongs to.
router.post('/:id/stream', validate(chatStreamSchema), streamChat);

export default router;
