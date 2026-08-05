import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import { scoreByLexicalOverlap, tokenize } from '../src/services/web/rerank.js';

/**
 * Lexical reranking picks which paragraph of a fetched page goes in front of the
 * model. Embedding-based reranking measured ~5.5 s per passage on CPU, which is
 * more than the whole retrieval budget — see rerank.js.
 *
 * The property that matters: the passage that answers the question outranks the
 * page's boilerplate, and the score stays interpretable enough that WEB_MIN_SCORE
 * means something.
 */

const p = (text) => ({ text });

test('ranks the answering passage above page boilerplate', () => {
  const query = 'what is the latest stable Node.js release version';
  const passages = [
    p('Subscribe to our newsletter. Follow us on social media. Read our privacy policy and cookie notice.'),
    p('The latest stable Node.js release is version 26.5.1, published on 29 July 2026 as the current LTS line.'),
    p('This website uses cookies to improve your browsing experience across all pages of the site.'),
  ];

  const scores = scoreByLexicalOverlap(query, passages);
  assert.ok(scores[1] > scores[0], 'answer should beat newsletter chrome');
  assert.ok(scores[1] > scores[2], 'answer should beat cookie notice');
});

test('scores stay within [0, 1)', () => {
  const passages = [
    p('node release version stable latest'.repeat(40)),
    p('unrelated text about gardening and tomatoes'),
  ];

  for (const score of scoreByLexicalOverlap('latest stable node release version', passages)) {
    assert.ok(score >= 0, `score ${score} below 0`);
    assert.ok(score < 1, `score ${score} at or above 1`);
  }
});

test('keeps version numbers and years, which carry the answer', () => {
  // A tokenizer that dropped digits would be blind to exactly the tokens that
  // make a time-sensitive answer correct.
  const terms = tokenize('Node.js 26.5.1 released in 2026');
  assert.ok(terms.includes('26.5.1'), `expected version token, got ${terms.join(',')}`);
  assert.ok(terms.includes('2026'), `expected year token, got ${terms.join(',')}`);
});

test('drops stopwords so they cannot dominate a short query', () => {
  const terms = tokenize('what is the price of it');
  assert.deepEqual(terms, ['price']);
});

test('a passage matching an exact version string outranks a vague one', () => {
  const query = 'is node 26.5.1 the current release';
  const passages = [
    p('Node.js has many releases over the years and the project follows a predictable schedule.'),
    p('Node.js 26.5.1 is the current release, superseding the previous line.'),
  ];

  const scores = scoreByLexicalOverlap(query, passages);
  assert.ok(scores[1] > scores[0]);
});

test('length normalization favours the focused passage', () => {
  // Both mention the term once. The shorter one is the better citation, because
  // it is about the thing rather than merely containing it.
  const query = 'refund eligibility window';
  const focused = p('Refund eligibility window: fourteen days from purchase.');
  const buried = p(`${'Unrelated corporate history filler sentence. '.repeat(60)} Refund eligibility window applies.`);

  const [focusedScore, buriedScore] = scoreByLexicalOverlap(query, [focused, buried]);
  assert.ok(focusedScore > buriedScore);
});

test('a term present in every passage discriminates nothing', () => {
  // IDF must not go negative, which would reward a passage for omitting a query
  // term. With "node" everywhere, "26.5.1" has to be what separates them.
  const passages = [
    p('node is a runtime'),
    p('node powers servers'),
    p('node 26.5.1 is the current release'),
  ];

  const scores = scoreByLexicalOverlap('node 26.5.1', passages);
  assert.ok(scores.every((s) => s >= 0));
  assert.ok(scores[2] > scores[0] && scores[2] > scores[1]);
});

test('an irrelevant passage scores near zero', () => {
  const [score] = scoreByLexicalOverlap('current corporation tax rate', [
    p('The mitochondrion is the powerhouse of the cell and produces adenosine triphosphate.'),
  ]);

  assert.ok(score < 0.2, `expected a low score, got ${score}`);
});

test('handles degenerate input without throwing', () => {
  assert.deepEqual(scoreByLexicalOverlap('', [p('some text')]), [0]);
  assert.deepEqual(scoreByLexicalOverlap('a query', []), []);
  // A query of nothing but stopwords has no terms to score against.
  assert.deepEqual(scoreByLexicalOverlap('is it the', [p('some text')]), [0]);
  assert.deepEqual(scoreByLexicalOverlap('query', [p('')]), [0]);
});

test('the default threshold separates relevant passages from irrelevant pages', () => {
  // Guards the calibration in env.js. Lexical coverage scores top out well below
  // 1, so the embedding mode's 0.45 cosine threshold rejected everything —
  // including correct passages. This asserts the gap the 0.15 default sits in.
  const threshold = env.web.minScore;

  // Candidates must be chunker-sized and of comparable length to each other, as
  // they are in production. A short answer among much shorter filler is scored
  // against a tiny average length, and length normalization then penalizes the
  // answer for being the longest passage in the set.
  const filler = Array.from({ length: 10 }, (_, i) =>
    p(
      `Section ${i} of the site archive. Navigation, related links and listings of ` +
        'previous posts appear here, alongside the newsletter signup form, the ' +
        'social media follow buttons, the terms of service summary and the cookie ' +
        'consent notice that applies across every page of this documentation site. ' +
        'Contributors are listed in the repository along with the governance charter.',
    ),
  );

  const answering = p(
    'Version 22.0.0 is the current Node.js release, published 2024-04-24. Changes in ' +
      'this release include require() of ESM graphs, a WebSocket client enabled by ' +
      'default, watch mode stability and an update to the V8 engine. The release will ' +
      'enter long-term support in October, at which point it becomes the recommended ' +
      'stable line for production deployments seeking the latest supported version.',
  );

  const onTopicScores = scoreByLexicalOverlap(
    'What is the latest stable Node.js release and what changed in it?',
    [answering, ...filler],
  );
  assert.ok(
    onTopicScores[0] > threshold,
    `answering passage scored ${onTopicScores[0].toFixed(3)}, not above threshold ${threshold}`,
  );

  const offTopicScores = scoreByLexicalOverlap(
    'What is the current corporation tax rate in Ireland?',
    [answering, ...filler],
  );
  assert.ok(
    Math.max(...offTopicScores) < threshold,
    `an unrelated question scored ${Math.max(...offTopicScores).toFixed(3)}, above threshold ${threshold}`,
  );
});

test('scoring a realistic candidate set is effectively free', () => {
  // The whole reason this exists instead of embedding reranking. 40 passages is
  // WEB_MAX_RERANK_PASSAGES; embedding them measured at over three minutes.
  const passages = Array.from({ length: 40 }, (_, i) =>
    p(`Passage ${i} discussing release notes, version numbers and assorted details. `.repeat(12)),
  );

  const startedAt = Date.now();
  scoreByLexicalOverlap('latest release version notes', passages);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 250, `expected well under 250ms, took ${elapsed}ms`);
});
