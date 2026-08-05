import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFreshness, buildSearchQuery } from '../src/services/web/freshness.js';

/**
 * The router decides whether a question gets live web sources.
 *
 * Its bias is asymmetric and these tests encode that: a needless search costs a
 * few seconds, while a missed one produces a confidently stale answer. So the
 * recall cases below are the important ones, and the "does not search" cases only
 * assert on questions where retrieval genuinely cannot help.
 */

const CURRENT_YEAR = new Date().getFullYear();

test('routes explicit recency questions to the web', () => {
  const questions = [
    'what is the latest version of node.js',
    'what happened today in the markets',
    'who is the current prime minister of japan',
    'has react 20 been released yet',
    'any news about the postal strike',
    'what is the price of a tesla model 3 right now',
  ];

  for (const question of questions) {
    const verdict = assessFreshness(question);
    assert.equal(verdict.needsWeb, true, `should search: ${question}`);
    assert.ok(verdict.confidence > 0.5, `should be confident: ${question}`);
  }
});

test('routes volatile topics to the web even without a time word', () => {
  for (const question of [
    'is there a cve for openssl in the current branch',
    'what is the corporation tax rate for small companies',
    'who won the champions league final',
  ]) {
    assert.equal(assessFreshness(question).needsWeb, true, `should search: ${question}`);
  }
});

test('does not search timeless conceptual questions', () => {
  for (const question of [
    'explain the difference between tcp and udp',
    'how does a hash table work',
    'why is quicksort faster than bubble sort in practice',
    'write a python function that reverses a linked list',
    'translate this paragraph into german',
    'summarise the text I pasted above',
  ]) {
    assert.equal(assessFreshness(question).needsWeb, false, `should not search: ${question}`);
  }
});

test('does not search settled historical questions', () => {
  for (const question of [
    'who invented the telephone',
    'what caused the 1929 stock market crash',
    'give me the history of interest rates in britain',
  ]) {
    const verdict = assessFreshness(question);
    assert.equal(verdict.needsWeb, false, `should not search: ${question}`);
  }
});

test('a past year settles an otherwise volatile question', () => {
  // "stock" is a volatile keyword, but a question pinned to 1929 is history.
  const verdict = assessFreshness('what caused the 1929 stock market crash');
  assert.equal(verdict.needsWeb, false);
  assert.equal(verdict.reason, 'historical');
});

test('a past year alongside a present-tense cue stays a live question', () => {
  // A comparison against now needs current data for half of the answer.
  assert.equal(assessFreshness('how do stock prices in 2019 compare to now').needsWeb, true);
});

test('a four-digit quantity is not mistaken for a year', () => {
  // 1500 is a price here. Reading it as a date would suppress the search.
  assert.equal(assessFreshness('what is the current price of a 1500 watt heater').needsWeb, true);
});

test('a volatile keyword inside a historical question does not trigger a search', () => {
  // "history of" plus "interest rate" — the historical signal has to win, or
  // every question about the past of a volatile topic would hit the network.
  const verdict = assessFreshness('the history of interest rate policy');
  assert.equal(verdict.needsWeb, false);
  assert.equal(verdict.reason, 'historical');
});

test('a current or future year overrides the conceptual patterns', () => {
  // Phrased as "how does X work", which is normally conceptual, but the answer
  // changes yearly, so the year has to win.
  const verdict = assessFreshness(`how does the ${CURRENT_YEAR} tax band work`);
  assert.equal(verdict.needsWeb, true);
  assert.ok(verdict.matched.some((m) => m.startsWith('year:')));
});

test('ignores trivially short input', () => {
  assert.equal(assessFreshness('hi').needsWeb, false);
  assert.equal(assessFreshness('').reason, 'too_short');
  assert.equal(assessFreshness(null).needsWeb, false);
});

test('does not match keywords inside unrelated longer words', () => {
  // 'patch' inside 'dispatch' and 'eol' inside 'geological' would both route
  // ordinary questions to a web search if matching were substring-based.
  assert.equal(assessFreshness('how do I dispatch an action in redux').needsWeb, false);
  assert.equal(assessFreshness('explain geological stratification').needsWeb, false);
});

test('flags news-like questions so the news category is added', () => {
  assert.equal(assessFreshness('what are the headlines today').newsBiased, true);
  assert.equal(assessFreshness('what is the latest version of postgres').newsBiased, false);
});

test('reports an unknown case as no_signal rather than guessing', () => {
  const verdict = assessFreshness('tell me about the flerbulous widget standard');
  assert.equal(verdict.needsWeb, false);
  assert.equal(verdict.reason, 'no_signal');
});

test('search query strips conversational filler', () => {
  const query = buildSearchQuery('Hey, could you tell me what the latest node version is?', {
    matched: [],
  });
  assert.ok(!query.toLowerCase().startsWith('hey'));
  assert.ok(!query.includes('?'));
});

test('search query appends the year for recency questions only', () => {
  const recency = assessFreshness('what is the latest inflation figure');
  assert.ok(buildSearchQuery('what is the latest inflation figure', recency).includes(String(CURRENT_YEAR)));

  // Already carries a year: appending a second one would confuse the engines.
  const explicit = assessFreshness(`inflation figures for ${CURRENT_YEAR}`);
  const query = buildSearchQuery(`inflation figures for ${CURRENT_YEAR}`, explicit);
  assert.equal(query.match(new RegExp(String(CURRENT_YEAR), 'g'))?.length, 1);
});

test('search query is length-capped so a pasted essay cannot become the query', () => {
  const query = buildSearchQuery('a'.repeat(5000), { matched: [] });
  assert.ok(query.length <= 305);
});
