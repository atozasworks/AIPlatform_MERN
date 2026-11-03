/**
 * Token accounting.
 *
 * Exact counts come from `llama-server`'s /tokenize endpoint, which uses the
 * loaded model's own vocabulary. That call costs a round trip, so budgeting
 * paths use the heuristic estimator and reserve the exact count for the final
 * pre-flight check. The heuristic deliberately over-estimates: overshooting the
 * budget truncates history, undershooting overflows the context window.
 */

const CHARS_PER_TOKEN = 3.6;
/** Per-message chat-template overhead (role markers, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Fast, dependency-free estimate for a single string. */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  // CJK characters are close to one token each; Latin text is ~3.6 chars/token.
  const cjk = (s.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / CHARS_PER_TOKEN);
}

/** Estimate for a chat-format message array, including template overhead. */
export function estimateMessageTokens(messages = []) {
  return messages.reduce(
    (sum, m) => sum + MESSAGE_OVERHEAD_TOKENS + estimateTokens(m?.content),
    0,
  );
}

/**
 * Exact token count from llama-server. Falls back to the estimate when the
 * endpoint is unavailable so token accounting never becomes a hard dependency.
 *
 * @param {{ baseUrl: string, apiKey?: string, timeoutMs?: number }} target
 */
export async function countTokensExact(target, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? 5000);
  try {
    const res = await fetch(`${target.baseUrl}/tokenize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({ content: String(text ?? '') }),
      signal: controller.signal,
    });
    if (!res.ok) return estimateTokens(text);
    const body = await res.json();
    return Array.isArray(body?.tokens) ? body.tokens.length : estimateTokens(text);
  } catch {
    return estimateTokens(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Truncates text to approximately `maxTokens`, cutting on a word boundary. */
export function truncateToTokens(text, maxTokens) {
  const s = String(text ?? '');
  if (estimateTokens(s) <= maxTokens) return s;
  const targetChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  const cut = s.slice(0, targetChars);
  const lastBreak = cut.lastIndexOf(' ');
  return (lastBreak > targetChars * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd();
}

export default { estimateTokens, estimateMessageTokens, countTokensExact, truncateToTokens };
