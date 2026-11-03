import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import {
  createConversation,
  listConversations,
  getOwnedConversation,
  getMessages,
  updateConversation,
  softDeleteConversation,
  enableConversationShare,
  disableConversationShare,
  prepareMessageEdit,
  setMessagePrivate,
} from '../services/conversation.service.js';
import { sendPrivateCodeEmail } from '../services/email.service.js';
import { logger } from '../config/logger.js';

export const create = asyncHandler(async (req, res) => {
  const convo = await createConversation(req.user._id, req.body);
  return sendSuccess(res, { conversation: convo.toJSON() }, { status: 201 });
});

export const list = asyncHandler(async (req, res) => {
  const result = await listConversations(req.user._id, req.query);
  return sendSuccess(res, { conversations: result.items }, {
    meta: { nextCursor: result.nextCursor, hasMore: result.hasMore },
  });
});

export const getOne = asyncHandler(async (req, res) => {
  const convo = await getOwnedConversation(req.user._id, req.params.id);
  return sendSuccess(res, { conversation: convo.toJSON() });
});

export const messages = asyncHandler(async (req, res) => {
  const msgs = await getMessages(req.user._id, req.params.id);
  return sendSuccess(res, { messages: msgs });
});

export const update = asyncHandler(async (req, res) => {
  const convo = await updateConversation(req.user._id, req.params.id, req.body);
  return sendSuccess(res, { conversation: convo.toJSON() });
});

export const remove = asyncHandler(async (req, res) => {
  await softDeleteConversation(req.user._id, req.params.id);
  return sendSuccess(res, { ok: true });
});

/** POST /conversations/:id/share — create (or reuse) a read-only share link. */
export const share = asyncHandler(async (req, res) => {
  const convo = await enableConversationShare(req.user._id, req.params.id);
  return sendSuccess(res, {
    conversation: convo.toJSON(),
    shareToken: convo.shareToken,
  });
});

/** DELETE /conversations/:id/share — revoke the share link. */
export const unshare = asyncHandler(async (req, res) => {
  const convo = await disableConversationShare(req.user._id, req.params.id);
  return sendSuccess(res, { conversation: convo.toJSON() });
});

/** Returns parentMessageId so the client can open a sibling edit branch. */
export const editMessage = asyncHandler(async (req, res) => {
  const prep = await prepareMessageEdit(req.user._id, req.params.id, req.params.messageId);
  return sendSuccess(res, { ...prep, content: req.body.content });
});

/**
 * Marks a message private, links a unique code to it, and emails the code to
 * the authenticated user as a reference/receipt. The email is best-effort: a
 * delivery failure does not fail the request (the code is already saved).
 */
export const makeMessagePrivate = asyncHandler(async (req, res) => {
  const message = await setMessagePrivate(req.user._id, req.params.id, req.params.messageId);

  let emailDelivered = false;
  try {
    const result = await sendPrivateCodeEmail(req.user.email, {
      code: message.privateCode,
      conversationId: String(message.conversation),
      messageId: String(message._id),
      preview: (message.content || '').slice(0, 140),
    });
    emailDelivered = Boolean(result?.delivered);
    if (emailDelivered && !message.privateCodeSentAt) {
      message.privateCodeSentAt = new Date();
      await message.save();
    }
  } catch (err) {
    logger.error({ err, messageId: String(message._id) }, 'Failed to email private message code');
  }

  return sendSuccess(res, { message: message.toJSON(), emailDelivered });
});
