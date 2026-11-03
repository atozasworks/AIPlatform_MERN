import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  createConversationSchema,
  updateConversationSchema,
  conversationIdSchema,
  listConversationsSchema,
  editMessageSchema,
  messageIdSchema,
} from '../../validators/conversation.validator.js';
import {
  chatStreamSchema,
  streamJobSchema,
  cancelJobSchema,
} from '../../validators/ai.validator.js';
import * as conversationController from '../../controllers/conversation.controller.js';
import { streamChat, resumeStream, cancelGeneration } from '../../controllers/ai.controller.js';

const router = Router();

router.use(requireAuth);

router.post('/', validate(createConversationSchema), conversationController.create);
router.get('/', validate(listConversationsSchema), conversationController.list);
router.get('/:id', validate(conversationIdSchema), conversationController.getOne);
router.get('/:id/messages', validate(conversationIdSchema), conversationController.messages);
router.post(
  '/:id/messages/:messageId/edit',
  validate(editMessageSchema),
  conversationController.editMessage,
);
// Mark a single message private: links a unique code + emails it as a receipt.
router.post(
  '/:id/messages/:messageId/private',
  validate(messageIdSchema),
  conversationController.makeMessagePrivate,
);
router.patch('/:id', validate(updateConversationSchema), conversationController.update);
router.post('/:id/share', validate(conversationIdSchema), conversationController.share);
router.delete('/:id/share', validate(conversationIdSchema), conversationController.unshare);
router.delete('/:id', validate(conversationIdSchema), conversationController.remove);

// Streaming chat lives under the conversation it belongs to.
router.post('/:id/stream', validate(chatStreamSchema), streamChat);
// Re-attach after a refresh or dropped connection, replaying from `lastSeq`.
router.get('/:id/stream/:jobId', validate(streamJobSchema), resumeStream);
// Stop Generation.
router.post('/:id/stream/:jobId/cancel', validate(cancelJobSchema), cancelGeneration);

export default router;
