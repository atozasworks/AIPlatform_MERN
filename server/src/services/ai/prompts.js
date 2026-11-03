import { env } from '../../config/env.js';

/**
 * Prompt profiles.
 *
 * Each profile fixes the sampling parameters and the behavioural addendum for a
 * class of task. `balanced` is the default; `detailed` is the only profile
 * allowed to use the higher output-token ceiling. Output caps are clamped
 * against env limits in `resolveProfile()` so a profile can never exceed the
 * operator's configured maximum.
 */

const FACTUAL_SAMPLING = {
  temperature: 0.2,
  topP: 0.9,
  repeatPenalty: 1.1,
};

/** @type {Record<string, object>} */
export const PROMPT_PROFILES = {
  fast: {
    id: 'fast',
    label: 'Fast',
    description: 'Short, direct answers. Lowest CPU cost per request.',
    sampling: { temperature: 0.2, topP: 0.9, repeatPenalty: 1.1 },
    maxOutputTokens: 350,
    retrieval: false,
    instructions:
      'Answer in as few words as the question allows. Skip preamble, restatement and closing summaries.',
  },

  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Default profile: clear, practical answers at moderate length.',
    sampling: FACTUAL_SAMPLING,
    maxOutputTokens: null, // resolves to MAX_OUTPUT_TOKENS_NORMAL
    retrieval: true,
    instructions:
      'Give a clear, practical answer. Lead with the direct response, then add only the supporting detail that changes what the reader would do.',
  },

  detailed: {
    id: 'detailed',
    label: 'Detailed',
    description: 'Long-form explanation. Uses the extended output budget.',
    sampling: { temperature: 0.3, topP: 0.9, repeatPenalty: 1.1 },
    maxOutputTokens: null, // resolves to MAX_OUTPUT_TOKENS_DETAILED
    detailed: true,
    retrieval: true,
    instructions:
      'Explain thoroughly: cover the reasoning, the trade-offs and the edge cases. Use headings or ordered steps when they aid comprehension.',
  },

  'rag-grounded': {
    id: 'rag-grounded',
    label: 'Grounded (documents)',
    description: 'Answers strictly from retrieved ATOZAS sources, with citations.',
    sampling: { temperature: 0.1, topP: 0.9, repeatPenalty: 1.05 },
    maxOutputTokens: null,
    retrieval: true,
    requireRetrieval: true,
    // Deliberately no web: this profile's contract is "only ATOZAS's own
    // indexed material", and quietly widening that to the open internet would
    // break the guarantee the operator selected it for.
    web: false,
    instructions:
      'Answer only from the provided sources. Cite each supporting source inline as [S1], [S2] using the identifiers given. ' +
      'If the sources do not contain the answer, say so plainly and do not fall back on general knowledge.',
  },

  current: {
    id: 'current',
    label: 'Current (live web)',
    description: 'Always searches the web first. For news, prices and today’s facts.',
    sampling: { temperature: 0.15, topP: 0.9, repeatPenalty: 1.05 },
    maxOutputTokens: null,
    retrieval: true,
    web: true,
    // Skips the freshness router. The user picking this profile *is* the signal
    // that the question needs current information, and it is a better signal
    // than any keyword heuristic.
    forceWeb: true,
    instructions:
      'Answer from the live sources supplied, citing each one inline as [S1], [S2]. State the date each fact refers to, ' +
      'and name the publisher when the claim is contested or attributed. If the sources do not answer the question, ' +
      'say what they do establish and what remains unverified rather than filling the gap from memory.',
  },

  coding: {
    id: 'coding',
    label: 'Coding',
    description: 'Code generation and debugging.',
    sampling: { temperature: 0.15, topP: 0.95, repeatPenalty: 1.05 },
    maxOutputTokens: null,
    retrieval: true,
    instructions:
      'Return complete, runnable code in fenced blocks with the language tag. State the language and any assumed dependency versions. ' +
      'Never emit placeholders, pseudocode or TODO comments. If a requirement is ambiguous, pick the most conventional interpretation and say which you chose.',
  },

  summarization: {
    id: 'summarization',
    label: 'Summarization',
    description: 'Condenses supplied text without adding new claims.',
    sampling: { temperature: 0.2, topP: 0.9, repeatPenalty: 1.15 },
    maxOutputTokens: null,
    retrieval: true,
    // No web, or the profile contradicts itself: fetched articles would arrive in
    // the prompt as sources for a task whose one rule is to add no new claims.
    web: false,
    instructions:
      'Summarize only what the supplied text states. Introduce no facts, figures or conclusions that are not present in the source. Preserve the original language of the text.',
  },

  translation: {
    id: 'translation',
    label: 'Translation',
    description: 'Translation preserving meaning, tone and formatting.',
    sampling: { temperature: 0.1, topP: 0.9, repeatPenalty: 1.0 },
    maxOutputTokens: null,
    retrieval: false,
    instructions:
      'Translate faithfully, preserving meaning, register and formatting (lists, code, markup stay intact). ' +
      'Output only the translation. Where a term has no direct equivalent, keep the original in parentheses after the rendering.',
  },
};

export const PROFILE_IDS = Object.keys(PROMPT_PROFILES);

export function isValidProfile(id) {
  return Object.hasOwn(PROMPT_PROFILES, String(id));
}

/**
 * Resolves a profile id into concrete generation settings, clamping the output
 * budget to the operator's configured ceiling.
 *
 * @param {string} [id]
 * @param {{ maxTokens?: number }} [overrides]
 */
export function resolveProfile(id, overrides = {}) {
  const profile = PROMPT_PROFILES[id] || PROMPT_PROFILES[env.ai.defaultProfile] || PROMPT_PROFILES.balanced;

  const ceiling = profile.detailed
    ? env.limits.maxOutputTokensDetailed
    : env.limits.maxOutputTokensNormal;

  const requested = overrides.maxTokens ?? profile.maxOutputTokens ?? ceiling;
  const maxTokens = Math.max(1, Math.min(requested, ceiling));

  return {
    id: profile.id,
    label: profile.label,
    instructions: profile.instructions,
    retrieval: profile.retrieval !== false,
    requireRetrieval: Boolean(profile.requireRetrieval),
    /**
     * Whether the live web tier may run. Defaults to on wherever retrieval is
     * on, because the common case — a user asking a time-sensitive question in
     * the default profile — is exactly the one that needs it. Profiles opt out
     * explicitly (`web: false`), and the freshness router still decides per
     * question, so "allowed" is not "always".
     */
    web: profile.web ?? profile.retrieval !== false,
    forceWeb: Boolean(profile.forceWeb),
    maxTokens,
    sampling: { ...profile.sampling },
  };
}

/**
 * Catalog for the client-side profile selector.
 *
 * Profiles whose entire purpose is live retrieval are withheld when the web tier
 * is disabled. Offering "Current (live web) — always searches the web first" on a
 * deployment that cannot search would promise freshness it can only answer from
 * training data, which is the specific failure this tier exists to prevent. The
 * profile still resolves if requested directly, degrading to a plain grounded
 * answer with the staleness caveat.
 */
export function listProfiles() {
  return PROFILE_IDS.filter((id) => env.web.enabled || !PROMPT_PROFILES[id].forceWeb).map((id) => {
    const p = PROMPT_PROFILES[id];
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      maxOutputTokens: resolveProfile(p.id).maxTokens,
      usesRetrieval: p.retrieval !== false,
      // Lets the client mark which profiles can reach the internet, so the
      // choice is informed rather than implicit.
      usesWeb: resolveProfile(p.id).web && env.web.enabled,
    };
  });
}

export default PROMPT_PROFILES;
