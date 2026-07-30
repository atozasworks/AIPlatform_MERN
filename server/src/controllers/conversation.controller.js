import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import {
  createConversation,
  listConversations,
  getOwnedConversation,
  getMessages,
  updateConversation,
  softDeleteConversation,
  prepareMessageEdit,
} from '../services/conversation.service.js';

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

/** Returns parentMessageId so the client can open a sibling edit branch. */
export const editMessage = asyncHandler(async (req, res) => {
  const prep = await prepareMessageEdit(req.user._id, req.params.id, req.params.messageId);
  return sendSuccess(res, { ...prep, content: req.body.content });
});
