import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/services/rag/chunker.js';
import { estimateTokens } from '../src/utils/tokenizer.js';

test('returns nothing for empty input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('keeps a short document as a single chunk', () => {
  const chunks = chunkText('ATOZAS AI runs entirely on ATOZAS servers.');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
});

test('respects the token budget for every chunk', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${'content '.repeat(40)}`).join('\n\n');
  const chunks = chunkText(long, { maxTokens: 200, overlapTokens: 30 });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    // Overlap can push a chunk slightly past the target; a small margin is fine.
    assert.ok(
      estimateTokens(chunk.text) <= 260,
      `chunk ${chunk.index} is ${estimateTokens(chunk.text)} tokens`,
    );
  }
});

test('attaches the markdown heading trail for citation context', () => {
  const doc = [
    '# Billing',
    '',
    'General billing information for customers.',
    '',
    '## Refunds',
    '',
    'Refunds are issued within seven working days of approval.',
  ].join('\n');

  const chunks = chunkText(doc, { maxTokens: 30, overlapTokens: 0 });
  assert.ok(chunks.some((c) => c.heading.includes('Billing')));
});

test('does not treat a # inside a code fence as a heading', () => {
  const doc = ['Intro text.', '', '```bash', '# this is a shell comment', 'echo hi', '```'].join('\n');
  const chunks = chunkText(doc);
  assert.ok(chunks.every((c) => !c.heading.includes('this is a shell comment')));
});

test('splits a single oversized unpunctuated block', () => {
  const chunks = chunkText('x'.repeat(20000), { maxTokens: 100, overlapTokens: 0 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk.text) <= 160);
  }
});

test('overlaps consecutive chunks so meaning is not cut at the boundary', () => {
  const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} carries meaning.`).join(' ');
  const chunks = chunkText(sentences, { maxTokens: 80, overlapTokens: 25 });

  assert.ok(chunks.length > 2);
  // Some text from the end of chunk 0 should reappear at the start of chunk 1.
  const tailWords = chunks[0].text.split(/\s+/).slice(-6).join(' ');
  assert.ok(chunks[1].text.includes(tailWords.split(' ').at(-1)));
});

test('assigns sequential indices', () => {
  const chunks = chunkText('word '.repeat(4000), { maxTokens: 150 });
  chunks.forEach((chunk, i) => assert.equal(chunk.index, i));
});
