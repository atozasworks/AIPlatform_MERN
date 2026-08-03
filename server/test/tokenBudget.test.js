import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBudgetedMessages } from '../src/services/ai/tokenBudget.js';
import { estimateMessageTokens } from '../src/utils/tokenizer.js';

const systemPrompt = 'You are ATOZAS AI. Answer accurately.';

function history(turns) {
  return Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${i}: ${'context '.repeat(60)}`,
  }));
}

test('keeps everything when it fits the window', () => {
  const result = buildBudgetedMessages({
    systemPrompt,
    history: history(4),
    currentTurn: { role: 'user', content: 'What is the refund policy?' },
    maxOutputTokens: 800,
    contextWindow: 8192,
  });

  assert.equal(result.droppedCount, 0);
  assert.equal(result.truncatedInput, false);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages.at(-1).content, 'What is the refund policy?');
});

test('drops the oldest turns and keeps the most recent when over budget', () => {
  const turns = history(80);
  const result = buildBudgetedMessages({
    systemPrompt,
    history: turns,
    currentTurn: { role: 'user', content: 'Latest question' },
    maxOutputTokens: 800,
    contextWindow: 8192,
  });

  assert.ok(result.droppedCount > 0, 'expected older turns to be dropped');
  // The final turn before the current one must survive.
  assert.ok(result.messages.some((m) => m.content === turns.at(-1).content));
  // The very first turn must not.
  assert.ok(!result.messages.some((m) => m.content === turns[0].content));
});

test('never lets the prompt eat the reserved output capacity', () => {
  const contextWindow = 8192;
  const maxOutputTokens = 1500;

  const result = buildBudgetedMessages({
    systemPrompt,
    history: history(200),
    currentTurn: { role: 'user', content: 'Explain everything in detail' },
    maxOutputTokens,
    contextWindow,
  });

  assert.ok(
    result.promptTokens + maxOutputTokens < contextWindow,
    `prompt ${result.promptTokens} + output ${maxOutputTokens} must stay under ${contextWindow}`,
  );
});

test('always preserves the system prompt and the current turn', () => {
  const result = buildBudgetedMessages({
    systemPrompt,
    history: history(300),
    currentTurn: { role: 'user', content: 'Critical question' },
    maxOutputTokens: 800,
    contextWindow: 4096,
  });

  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, systemPrompt);
  assert.equal(result.messages.at(-1).content, 'Critical question');
});

test('summarizes dropped turns instead of discarding them silently', () => {
  const result = buildBudgetedMessages({
    systemPrompt,
    history: history(120),
    currentTurn: { role: 'user', content: 'Next' },
    maxOutputTokens: 800,
    contextWindow: 8192,
  });

  const digest = result.messages.find(
    (m) => m.role === 'system' && m.content.includes('Earlier in this conversation'),
  );
  assert.ok(digest, 'expected a digest of the trimmed turns');
});

test('truncates a single oversized prompt rather than rejecting it', () => {
  const result = buildBudgetedMessages({
    systemPrompt,
    history: [],
    currentTurn: { role: 'user', content: 'word '.repeat(20000) },
    maxOutputTokens: 800,
    contextWindow: 8192,
  });

  assert.equal(result.truncatedInput, true);
  assert.ok(estimateMessageTokens([result.messages.at(-1)]) < 8192);
});

test('throws when output reservation cannot fit the window at all', () => {
  assert.throws(
    () =>
      buildBudgetedMessages({
        systemPrompt,
        history: [],
        currentTurn: { role: 'user', content: 'hi' },
        maxOutputTokens: 5000,
        contextWindow: 4096,
      }),
    /cannot hold the system prompt/,
  );
});
