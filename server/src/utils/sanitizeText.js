/**
 * Output sanitation for locally generated text.
 *
 * Qwen3 emits chain-of-thought inside <think>…</think>. Even with thinking
 * disabled the model occasionally opens a block, so the stream is filtered
 * rather than trusted. Filtering happens on the token stream (not just the
 * final string) so hidden reasoning never reaches the browser at all.
 */

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/**
 * Incremental filter that removes <think> blocks from a token stream.
 *
 * Partial tags are held back until they can be resolved, so a chunk boundary
 * falling inside "<thi" never leaks the tag or drops real text.
 */
export function createThinkFilter() {
  let buffer = '';
  let inside = false;

  /** Longest suffix of `s` that is a proper prefix of `tag`. */
  const danglingPrefixLength = (s, tag) => {
    const max = Math.min(s.length, tag.length - 1);
    for (let len = max; len > 0; len -= 1) {
      if (s.slice(s.length - len) === tag.slice(0, len)) return len;
    }
    return 0;
  };

  return {
    /** @param {string} chunk @returns {string} text safe to emit */
    push(chunk) {
      buffer += chunk;
      let out = '';

      while (buffer) {
        if (inside) {
          const end = buffer.indexOf(CLOSE_TAG);
          if (end === -1) {
            // Keep only what might be the start of the closing tag.
            const keep = danglingPrefixLength(buffer, CLOSE_TAG);
            buffer = keep ? buffer.slice(buffer.length - keep) : '';
            break;
          }
          buffer = buffer.slice(end + CLOSE_TAG.length);
          inside = false;
          continue;
        }

        const start = buffer.indexOf(OPEN_TAG);
        if (start === -1) {
          const keep = danglingPrefixLength(buffer, OPEN_TAG);
          out += keep ? buffer.slice(0, buffer.length - keep) : buffer;
          buffer = keep ? buffer.slice(buffer.length - keep) : '';
          break;
        }

        out += buffer.slice(0, start);
        buffer = buffer.slice(start + OPEN_TAG.length);
        inside = true;
      }

      return out;
    },

    /** Emits any text still held back once the stream ends. */
    flush() {
      if (inside) {
        buffer = '';
        return '';
      }
      const out = buffer;
      buffer = '';
      return out;
    },
  };
}

/** One-shot equivalent of the streaming filter, for non-streaming completions. */
export function stripThinking(text) {
  const filter = createThinkFilter();
  return filter.push(String(text ?? '')) + filter.flush();
}

/**
 * Neutralizes control characters and zero-width joiners that can be used to
 * smuggle instructions past prompt inspection or corrupt the SSE framing.
 */
export function stripControlCharacters(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
}

/**
 * Prepares retrieved document text for inclusion in a prompt.
 *
 * Retrieved content is DATA, never instructions. Sequences that imitate chat
 * roles or delimiters are defanged so a poisoned document cannot escape its
 * block and issue commands to the model.
 */
export function neutralizeRetrievedText(text) {
  return stripControlCharacters(text)
    .replace(/<\|[^|>]*\|>/g, '') // ChatML / Qwen special tokens
    .replace(/<\/?(?:think|system|assistant|user|tool)>/gi, '')
    .replace(/^\s*(system|assistant|user)\s*:/gim, '$1 -')
    .replace(/-{3,}\s*(BEGIN|END)\s+(SYSTEM|INSTRUCTION)/gi, '')
    .trim();
}

export default { createThinkFilter, stripThinking, stripControlCharacters, neutralizeRetrievedText };
