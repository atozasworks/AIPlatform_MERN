import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, stripInvalidCitations } from '../src/services/rag/citations.js';

/**
 * The guarantee under test: a citation shown to a user always maps to a chunk
 * that was actually retrieved. The model is treated as untrusted throughout.
 */

const sources = [
  {
    label: 'S1',
    chunkId: 'c1',
    documentId: 'd1',
    documentTitle: 'Refund Policy',
    heading: 'Eligibility',
    sourceUri: 'https://atozasai.com/policy',
    sourceType: 'policy',
    chunkIndex: 0,
    score: 0.91,
  },
  {
    label: 'S2',
    chunkId: 'c2',
    documentId: 'd2',
    documentTitle: 'Billing Guide',
    heading: '',
    sourceUri: '',
    sourceType: 'documentation',
    chunkIndex: 3,
    score: 0.84,
  },
];

test('extracts citations that map to supplied sources', () => {
  const { citations, invalidLabels } = extractCitations(
    'Refunds are processed in 7 days [S1]. Billing runs monthly [S2].',
    sources,
  );

  assert.equal(citations.length, 2);
  assert.deepEqual(citations.map((c) => c.label), ['S1', 'S2']);
  assert.equal(invalidLabels.length, 0);
  assert.equal(citations[0].title, 'Refund Policy');
});

test('rejects a citation the model invented', () => {
  const { citations, invalidLabels } = extractCitations(
    'This is documented [S1] and also here [S7].',
    sources,
  );

  assert.deepEqual(citations.map((c) => c.label), ['S1']);
  assert.deepEqual(invalidLabels, ['S7']);
});

test('returns no citations when nothing was retrieved', () => {
  const { citations, invalidLabels } = extractCitations('Per the docs [S1].', []);
  assert.equal(citations.length, 0);
  assert.deepEqual(invalidLabels, ['S1']);
});

test('deduplicates repeated references, preserving first-mention order', () => {
  const { citations } = extractCitations('[S2] then [S1] then [S2] again.', sources);
  assert.deepEqual(citations.map((c) => c.label), ['S2', 'S1']);
});

test('removes invalid markers from the visible answer', () => {
  const cleaned = stripInvalidCitations('Valid [S1] and bogus [S9] here.', ['S9']);
  assert.ok(!cleaned.includes('[S9]'));
  assert.ok(cleaned.includes('[S1]'));
});

test('leaves the answer untouched when every citation is valid', () => {
  const text = 'All good [S1].';
  assert.equal(stripInvalidCitations(text, []), text);
});
