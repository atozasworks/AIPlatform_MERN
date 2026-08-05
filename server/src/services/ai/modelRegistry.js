import { env } from '../../config/env.js';

/**
 * Provenance register for every model ATOZAS runs.
 *
 * Compliance requirement: before a model is served, its origin, licence,
 * commercial-use permission, checksum and egress behaviour must be recorded and
 * auditable. `/api/v1/admin/ai/status` surfaces this table, and
 * `deploy/scripts/fetch-models.sh` verifies the checksums at download time.
 *
 * `transmitsDataExternally` is false for every entry by design: all weights run
 * inside `llama-server` bound to loopback on the ATOZAS VPS.
 */

/**
 * @typedef {object} ModelRuntime
 * @property {number} contextWindow    Tokens the prompt budget may use.
 * @property {object} [extraBody]      Fields merged into every request payload.
 * @property {string} label            Short display name for the model picker.
 * @property {string} blurb            One-line "what is this good at" hint.
 */

/**
 * @typedef {object} ModelRecord
 * @property {string} id             Internal id used by the provider layer.
 * @property {string} name           Upstream model name and version.
 * @property {string} repository     Source repository the weights came from.
 * @property {string} [ggufRepository] Conversion repo, when the GGUF build is
 *                                   published separately from the original weights.
 * @property {string} license        SPDX identifier or licence name.
 * @property {boolean} commercialUse Whether commercial use is permitted.
 * @property {string} [licenseNotes] Obligations that survive redistribution.
 * @property {string} file           Expected filename on disk.
 * @property {string} sha256         Expected SHA-256 of the GGUF file.
 * @property {boolean} transmitsDataExternally
 * @property {string} role           'chat' | 'embedding'
 * @property {ModelRuntime} [runtime] Serving behaviour; chat models only.
 */

/**
 * Context budget per chat model. Every model here is natively 128k-capable
 * except Qwen3's 32k, but the ceiling that matters is RAM: the KV cache is
 * allocated up front per slot, so the router's per-model `ctx-size` in
 * deploy/llama/models.ini is what this must agree with.
 */
const CHAT_CONTEXT_WINDOW = 8192;

/** @type {ModelRecord[]} */
export const MODEL_REGISTRY = [
  {
    id: 'qwen3-4b-instruct-2507',
    name: 'Qwen3-4B-Instruct-2507 (GGUF, Q4_K_M quantization)',
    // The July 2025 refresh of Qwen3-4B: instruct-only (no thinking mode) with
    // a later knowledge cutoff than the original release below.
    repository: 'https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507',
    // Qwen publishes safetensors for this revision, not GGUF. Note that
    // Qwen/Qwen3-4B-Instruct-2507-GGUF does not exist — see deploy/MODELS.md.
    ggufRepository: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF',
    license: 'Apache-2.0',
    commercialUse: true,
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sha256: process.env.MODEL_SHA256_QWEN3_4B_2507 || '',
    transmitsDataExternally: false,
    role: 'chat',
    runtime: {
      contextWindow: CHAT_CONTEXT_WINDOW,
      // No extraBody: this revision dropped the hybrid thinking mode, so
      // enable_thinking is not a template argument it accepts.
      label: 'Qwen3 4B Instruct 2507',
      blurb: 'Newest here. Broadest recent knowledge; best general default.',
    },
  },
  {
    id: 'qwen3-4b-instruct',
    name: 'Qwen3-4B (GGUF, Q4_K_M quantization)',
    // Official Qwen release. Qwen3-4B is instruction-tuned with a switchable
    // reasoning mode; ATOZAS runs it with thinking disabled.
    repository: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF',
    license: 'Apache-2.0',
    commercialUse: true,
    file: 'Qwen3-4B-Q4_K_M.gguf',
    // Verified by deploy/scripts/fetch-models.sh against MODEL_SHA256_QWEN3_4B.
    sha256: process.env.MODEL_SHA256_QWEN3_4B || '',
    transmitsDataExternally: false,
    role: 'chat',
    runtime: {
      contextWindow: CHAT_CONTEXT_WINDOW,
      // Qwen3 exposes reasoning as a template flag; CPU deployments keep it off.
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      label: 'Qwen3 4B',
      blurb: 'Original Qwen3 release. Strongest multilingual coverage here.',
    },
  },
  {
    id: 'phi-4-mini-instruct',
    name: 'Phi-4-mini-instruct 3.8B (GGUF, Q4_K_M quantization)',
    repository: 'https://huggingface.co/microsoft/Phi-4-mini-instruct',
    ggufRepository: 'https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF',
    license: 'MIT',
    commercialUse: true,
    file: 'Phi-4-mini-instruct-Q4_K_M.gguf',
    sha256: process.env.MODEL_SHA256_PHI4_MINI || '',
    transmitsDataExternally: false,
    role: 'chat',
    runtime: {
      contextWindow: CHAT_CONTEXT_WINDOW,
      label: 'Phi-4 mini 3.8B',
      blurb: 'Microsoft reasoning-tuned small model. Good at maths and logic.',
    },
  },
  {
    id: 'gemma-3-4b-it',
    name: 'Gemma 3 4B Instruct (GGUF, Q4_K_M quantization)',
    repository: 'https://huggingface.co/google/gemma-3-4b-it',
    ggufRepository: 'https://huggingface.co/unsloth/gemma-3-4b-it-GGUF',
    license: 'Gemma Terms of Use',
    // Permitted, but not an OSI licence: Google's Prohibited Use Policy binds
    // downstream users and must travel with any redistribution of the weights.
    commercialUse: true,
    licenseNotes:
      'Gemma Terms of Use + Prohibited Use Policy apply. Redistribution must carry the terms ' +
      'and state that the weights are modified if they have been.',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    sha256: process.env.MODEL_SHA256_GEMMA3_4B || '',
    transmitsDataExternally: false,
    role: 'chat',
    runtime: {
      contextWindow: CHAT_CONTEXT_WINDOW,
      // Gemma 3's own template has no system turn, but llama.cpp's jinja
      // rendering folds a system message into the first user turn rather than
      // dropping it. Verified against this GGUF: the system prompt reaches the
      // model, so no application-side rewriting is needed.
      label: 'Gemma 3 4B',
      blurb: 'Google instruction model. Strong at summarising and rewriting.',
    },
  },
  {
    id: 'llama-3.2-3b-instruct',
    name: 'Llama 3.2 3B Instruct (GGUF, Q4_K_M quantization)',
    repository: 'https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct',
    ggufRepository: 'https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF',
    license: 'Llama 3.2 Community License',
    // Commercial use is permitted below Meta's 700M monthly-active-user
    // threshold; above it a separate licence from Meta is required.
    commercialUse: true,
    licenseNotes:
      'Llama 3.2 Community License. Requires a "Built with Llama" notice and the ' +
      'Acceptable Use Policy; a separate Meta licence is needed above 700M MAU.',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sha256: process.env.MODEL_SHA256_LLAMA32_3B || '',
    transmitsDataExternally: false,
    role: 'chat',
    runtime: {
      contextWindow: CHAT_CONTEXT_WINDOW,
      label: 'Llama 3.2 3B',
      blurb: 'Smallest and fastest here. Best when latency matters most.',
    },
  },
  {
    id: 'qwen3-embedding-0.6b',
    name: 'Qwen3-Embedding-0.6B (GGUF, Q8_0 quantization)',
    // Official Qwen GGUF publication. multilingual-e5-small was the original
    // choice, but every available GGUF conversion of it is broken against
    // current llama.cpp — see deploy/MODELS.md for the evidence.
    repository: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF',
    license: 'Apache-2.0',
    commercialUse: true,
    file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    sha256: process.env.MODEL_SHA256_EMBEDDING || '',
    transmitsDataExternally: false,
    role: 'embedding',
  },
];

export function getModelRecord(id) {
  return MODEL_REGISTRY.find((m) => m.id === id) || null;
}

/**
 * Direct download URL for a record's GGUF.
 *
 * `ggufRepository` wins when present: for Qwen3-4B-Instruct-2507, Phi-4,
 * Gemma 3 and Llama 3.2 the original repository holds safetensors (and for the
 * last two is licence-gated), while the GGUF conversion lives in a separate,
 * ungated repository.
 */
export function getModelDownloadUrl(record) {
  const repo = (record.ggufRepository || record.repository).replace(
    /^https:\/\/huggingface\.co\//,
    '',
  );
  return `https://huggingface.co/${repo}/resolve/main/${record.file}?download=true`;
}

/** Chat models in registry order; the first is the fallback default. */
export function listChatModelIds() {
  return MODEL_REGISTRY.filter((m) => m.role === 'chat').map((m) => m.id);
}

/**
 * Chat models this deployment serves: LLAMACPP_MODELS when set, otherwise the
 * whole registry. Unknown ids are dropped rather than passed to the router,
 * which would fail later as an opaque 404 from llama-server.
 */
export function resolveEnabledChatModelIds() {
  const configured = env.ai.llamacpp.models;
  if (!configured.length) return listChatModelIds();

  const known = new Set(listChatModelIds());
  return configured.filter((id) => known.has(id));
}

/**
 * Compliance view for the admin endpoint. Flags any model that is being served
 * without a recorded checksum so gaps are visible rather than assumed clean.
 */
export function describeModelCompliance() {
  const active = new Set(
    [
      ...(env.ai.llamacpp.enabled ? resolveEnabledChatModelIds() : []),
      env.ai.embeddings.enabled ? env.ai.embeddings.model : null,
      env.ai.gpu.enabled ? env.ai.gpu.model : null,
    ].filter(Boolean),
  );

  return MODEL_REGISTRY.map((m) => ({
    ...m,
    active: active.has(m.id),
    checksumRecorded: Boolean(m.sha256),
  }));
}

export default MODEL_REGISTRY;
