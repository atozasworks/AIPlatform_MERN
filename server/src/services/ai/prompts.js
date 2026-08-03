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
    instructions:
      'Answer only from the provided sources. Cite each supporting source inline as [S1], [S2] using the identifiers given. ' +
      'If the sources do not contain the answer, say so plainly and do not fall back on general knowledge.',
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
    maxTokens,
    sampling: { ...profile.sampling },
  };
}

/** Catalog for the client-side profile selector. */
export function listProfiles() {
  return PROFILE_IDS.map((id) => {
    const p = PROMPT_PROFILES[id];
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      maxOutputTokens: resolveProfile(p.id).maxTokens,
      usesRetrieval: p.retrieval !== false,
    };
  });
}

export default PROMPT_PROFILES;
