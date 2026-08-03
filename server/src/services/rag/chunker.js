import { env } from '../../config/env.js';
import { estimateTokens } from '../../utils/tokenizer.js';
import { stripControlCharacters } from '../../utils/sanitizeText.js';

/**
 * Structure-aware chunking.
 *
 * Splitting on a fixed character count cuts sentences in half and destroys the
 * heading context a citation needs to be meaningful. This splitter walks
 * Markdown headings first, then paragraphs, then sentences, and only falls back
 * to a hard character cut for pathological input (minified text, no whitespace).
 *
 * Each chunk keeps the heading trail it came from, so a citation can show
 * "Billing › Refunds" rather than an anonymous fragment.
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** Splits text into blocks, tracking the heading trail above each block. */
function toBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  const trail = [];
  let buffer = [];
  let inFence = false;

  const flush = () => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (body) blocks.push({ text: body, heading: trail.filter(Boolean).join(' › ') });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }

    // Headings inside a fenced code block are content, not structure.
    const heading = !inFence && HEADING_RE.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      trail.length = level - 1;
      trail[level - 1] = heading[2];
      continue;
    }

    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }

    buffer.push(line);
  }

  flush();
  return blocks;
}

/** Sentence split that respects common abbreviations and decimal numbers. */
function toSentences(text) {
  const parts = text.split(/(?<=[.!?。！？])\s+(?=[A-Z\u00C0-\u024F\u0400-\u04FF\u0900-\u097F\u4E00-\u9FFF])/);
  return parts.length > 1 ? parts : text.split(/(?<=\n)/);
}

/** Last `overlapTokens` worth of text, used to bridge consecutive chunks. */
function tailForOverlap(text, overlapTokens) {
  if (overlapTokens <= 0) return '';
  const sentences = toSentences(text);
  const kept = [];
  let used = 0;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(sentences[i]);
    if (used + cost > overlapTokens) break;
    kept.unshift(sentences[i]);
    used += cost;
  }
  return kept.join(' ').trim();
}

/** Hard split for a single block that exceeds the chunk budget on its own. */
function splitOversized(block, maxTokens) {
  const pieces = [];
  let current = '';

  for (const sentence of toSentences(block)) {
    const candidate = current ? `${current} ${sentence}` : sentence;

    if (estimateTokens(candidate) <= maxTokens) {
      current = candidate;
      continue;
    }

    if (current) pieces.push(current);

    // A single sentence larger than the budget (minified/unpunctuated text).
    if (estimateTokens(sentence) > maxTokens) {
      const charBudget = Math.floor(maxTokens * 3.6);
      for (let i = 0; i < sentence.length; i += charBudget) {
        pieces.push(sentence.slice(i, i + charBudget));
      }
      current = '';
    } else {
      current = sentence;
    }
  }

  if (current) pieces.push(current);
  return pieces;
}

/**
 * @param {string} text
 * @param {{ maxTokens?: number, overlapTokens?: number }} [options]
 * @returns {Array<{ index: number, text: string, heading: string, tokenCount: number }>}
 */
export function chunkText(text, options = {}) {
  const maxTokens = options.maxTokens ?? env.rag.chunkTokens;
  const overlapTokens = options.overlapTokens ?? env.rag.chunkOverlapTokens;

  const clean = stripControlCharacters(text).replace(/\n{3,}/g, '\n\n');
  if (!clean.trim()) return [];

  const chunks = [];
  let current = '';
  let currentHeading = '';

  const push = () => {
    const body = current.trim();
    if (!body) return;
    chunks.push({
      index: chunks.length,
      text: body,
      heading: currentHeading,
      tokenCount: estimateTokens(body),
    });
  };

  for (const block of toBlocks(clean)) {
    const pieces =
      estimateTokens(block.text) > maxTokens ? splitOversized(block.text, maxTokens) : [block.text];

    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;

      if (estimateTokens(candidate) <= maxTokens) {
        current = candidate;
        currentHeading = currentHeading || block.heading;
        continue;
      }

      push();
      const overlap = tailForOverlap(current, overlapTokens);
      current = overlap ? `${overlap}\n\n${piece}` : piece;
      currentHeading = block.heading;
    }
  }

  push();
  return chunks;
}

export default chunkText;
