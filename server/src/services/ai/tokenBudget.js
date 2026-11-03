import { env } from '../../config/env.js';
import { estimateTokens, estimateMessageTokens, truncateToTokens } from '../../utils/tokenizer.js';

/**
 * Token-budgeted conversation assembly.
 *
 * Priority when the context window is tight, highest first:
 *   1. system instructions (never trimmed)
 *   2. retrieved context (already capped by MAX_RETRIEVAL_CONTEXT_TOKENS)
 *   3. the current user turn (never dropped, truncated only as a last resort)
 *   4. recent conversation turns, newest first
 *   5. a compact digest of the older turns that no longer fit
 *
 * Output capacity is reserved up front so a long history can never squeeze the
 * generation budget — the model always has room to finish its answer.
 */

/** Turns dropped history into one short digest line rather than discarding it silently. */
function summarizeDropped(messages, budgetTokens) {
  if (!messages.length || budgetTokens < 40) return null;

  const userTurns = messages.filter((m) => m.role === 'user');
  if (!userTurns.length) return null;

  const topics = [];
  let used = 0;
  for (const turn of userTurns) {
    const gist = truncateToTokens(String(turn.content || '').replace(/\s+/g, ' ').trim(), 24);
    if (!gist) continue;
    const cost = estimateTokens(gist) + 3;
    if (used + cost > budgetTokens - 20) break;
    topics.push(`- ${gist}`);
    used += cost;
  }

  if (!topics.length) return null;

  return {
    role: 'system',
    content: `Earlier in this conversation the user asked about:\n${topics.join('\n')}\n(Full text of those turns has been trimmed to fit the context window.)`,
  };
}

/**
 * Assembles the final message array sent to the model.
 *
 * @param {object} params
 * @param {string} params.systemPrompt
 * @param {Array<{role: string, content: string}>} params.history  Oldest → newest, excluding the current turn
 * @param {{role: string, content: string}} params.currentTurn
 * @param {number} params.maxOutputTokens
 * @param {number} [params.contextWindow]
 * @returns {{ messages: Array, promptTokens: number, droppedCount: number, truncatedInput: boolean }}
 */
export function buildBudgetedMessages({
  systemPrompt,
  history = [],
  currentTurn,
  maxOutputTokens,
  contextWindow = env.ai.llamacpp.contextWindow,
}) {
  const systemMessage = { role: 'system', content: systemPrompt };
  const systemTokens = estimateMessageTokens([systemMessage]);

  // Leave headroom for the chat template's own wrapper tokens.
  const templateReserve = 32;
  const available = contextWindow - maxOutputTokens - systemTokens - templateReserve;

  if (available <= 0) {
    throw new Error(
      `Context window (${contextWindow}) cannot hold the system prompt plus ${maxOutputTokens} output tokens. ` +
        'Lower MAX_OUTPUT_TOKENS_* or raise LLAMACPP_CONTEXT_WINDOW.',
    );
  }

  // The conversation slice is additionally bounded by the operator's setting.
  const historyBudget = Math.min(available, env.limits.maxConversationContextTokens);

  // The current turn is mandatory; truncate it only if it alone exceeds the budget.
  let truncatedInput = false;
  let current = { role: currentTurn.role, content: currentTurn.content };
  const currentCost = estimateMessageTokens([current]);
  const currentCeiling = Math.min(env.limits.maxPromptTokens, historyBudget);

  if (currentCost > currentCeiling) {
    current = { ...current, content: truncateToTokens(current.content, currentCeiling - 8) };
    truncatedInput = true;
  }

  let used = estimateMessageTokens([current]);
  const kept = [];

  // Walk backwards so the most recent, most relevant turns survive.
  let cursor = history.length - 1;
  for (; cursor >= 0; cursor -= 1) {
    const message = history[cursor];
    if (!message?.content) continue;
    const cost = estimateMessageTokens([message]);
    // Reserve a little room for the digest of whatever we drop.
    if (used + cost > historyBudget - 60) break;
    kept.unshift({ role: message.role, content: message.content });
    used += cost;
  }

  const dropped = history.slice(0, cursor + 1).filter((m) => m?.content);
  const digest = summarizeDropped(dropped, historyBudget - used);

  const messages = [systemMessage];
  if (digest) messages.push(digest);
  messages.push(...kept, current);

  return {
    messages,
    promptTokens: estimateMessageTokens(messages),
    droppedCount: dropped.length,
    truncatedInput,
  };
}

export default buildBudgetedMessages;
