import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile, listProfiles } from '../src/services/ai/prompts.js';
import { env } from '../src/config/env.js';

/**
 * A profile decides whether a question may reach the open internet. These tests
 * pin the contracts a user relies on when picking one, since the profile label is
 * the only promise they ever see.
 */

test('retrieval profiles may use the web by default', () => {
  // The common case is a time-sensitive question asked in the default profile.
  // Requiring an explicit opt-in would leave that case answering from memory.
  assert.equal(resolveProfile('balanced').web, true);
  assert.equal(resolveProfile('detailed').web, true);
});

test('a profile with retrieval off cannot reach the web', () => {
  assert.equal(resolveProfile('fast').web, false);
  assert.equal(resolveProfile('translation').web, false);
});

test('grounded-documents never widens to the open internet', () => {
  // The operator picks this profile for the guarantee that answers come only
  // from ATOZAS's own indexed material.
  const profile = resolveProfile('rag-grounded');
  assert.equal(profile.web, false);
  assert.equal(profile.requireRetrieval, true);
});

test('summarization never adds web sources to a no-new-claims task', () => {
  assert.equal(resolveProfile('summarization').web, false);
});

test('the current profile forces retrieval instead of consulting the router', () => {
  // Choosing it is a stronger signal than any keyword heuristic.
  const profile = resolveProfile('current');
  assert.equal(profile.web, true);
  assert.equal(profile.forceWeb, true);
});

test('no other profile bypasses the freshness router', () => {
  for (const { id } of listProfiles()) {
    if (id === 'current') continue;
    assert.equal(resolveProfile(id).forceWeb, false, `${id} should not force web retrieval`);
  }
});

test('an unknown profile id falls back rather than throwing', () => {
  const profile = resolveProfile('no-such-profile');
  assert.ok(profile.id);
  assert.ok(profile.maxTokens > 0);
});

test('the catalog hides web-only profiles when the tier is disabled', () => {
  // Offering "always searches the web first" on a deployment that cannot search
  // promises freshness it would silently answer from training data.
  const ids = listProfiles().map((p) => p.id);
  assert.equal(ids.includes('current'), env.web.enabled);
});

test('the catalog only advertises web access when the tier is enabled', () => {
  for (const profile of listProfiles()) {
    if (profile.usesWeb) {
      assert.ok(env.web.enabled, `${profile.id} advertises web access while the tier is disabled`);
    }
  }
});

test('every advertised profile resolves and is clamped to the output ceiling', () => {
  for (const advertised of listProfiles()) {
    const resolved = resolveProfile(advertised.id);
    assert.equal(resolved.id, advertised.id);
    assert.equal(resolved.maxTokens, advertised.maxOutputTokens);
    assert.ok(resolved.maxTokens <= env.limits.maxOutputTokensDetailed);
  }
});

test('a caller cannot raise the output budget above the operator ceiling', () => {
  const resolved = resolveProfile('balanced', { maxTokens: 1_000_000 });
  assert.ok(resolved.maxTokens <= env.limits.maxOutputTokensNormal);
});
