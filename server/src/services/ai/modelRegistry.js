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
 * inside `llama-server` bound to loopback on the ATOZAS VPS. Live web retrieval
 * (`services/web/`) does make outbound requests, but it never sends a prompt or
 * a document to a model it does not control — see deploy/MODELS.md.
 *
 * ATOZAS serves exactly one chat model. There is no model picker: a second
 * resident model would double RAM on a CPU box for no accuracy gain, and every
 * per-model quirk (chat templates, thinking switches, prompt rewriting) is a
 * source of silent behaviour drift. Adding one back means adding an entry here
 * and restoring the picker in the client.
 */

/**
 * @typedef {object} ModelRuntime
 * @property {number} contextWindow    Tokens the prompt budget may use.
 * @property {object} [extraBody]      Fields merged into every request payload.
 * @property {string} label            Short display name shown in the UI.
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
 * Context budget for the chat model. Qwen3-14B is natively 32k-capable, but the
 * ceiling that matters is RAM: the KV cache is allocated up front per slot, so
 * the router's `ctx-size` in deploy/llama/models.ini is what this must agree
 * with. Live web retrieval spends a large share of this on source text, which
 * is why MAX_RETRIEVAL_CONTEXT_TOKENS is budgeted separately.
 */
const CHAT_CONTEXT_WINDOW = 8192;

/** @type {ModelRecord[]} */
export const MODEL_REGISTRY = [
  {
    id: 'qwen3-14b',
    name: 'Qwen3-14B (GGUF, Q4_K_M quantization)',
    // The dense 14B member of the Qwen3 family. Unlike the 2507 instruct
    // refresh, this is the original hybrid release that keeps the thinking
    // switch — which is why the runtime below forces enable_thinking off.
    repository: 'https://huggingface.co/Qwen/Qwen3-14B',
    // Qwen publishes an official GGUF build for this model.
    ggufRepository: 'https://huggingface.co/Qwen/Qwen3-14B-GGUF',
    license: 'Apache-2.0',
    commercialUse: true,
    file: 'Qwen3-14B-Q4_K_M.gguf',
    sha256:
      process.env.MODEL_SHA256_QWEN3_14B ||
      '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0',
    transmitsDataExternally: false,
    role: 'chat',
    runtime: {
      contextWindow: CHAT_CONTEXT_WINDOW,
      // Hybrid model: keep reasoning off on CPU or every answer pays a long,
      // hidden chain-of-thought. Only applied while LLAMACPP_THINKING is false.
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      label: 'Qwen3 14B',
      blurb: 'Recent built-in knowledge, extended by live retrieval.',
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
 * `ggufRepository` wins when present: Qwen publishes safetensors for the 2507
 * revision but no GGUF, so the conversion lives in a separate repository.
 */
export function getModelDownloadUrl(record) {
  const repo = (record.ggufRepository || record.repository).replace(
    /^https:\/\/huggingface\.co\//,
    '',
  );
  return `https://huggingface.co/${repo}/resolve/main/${record.file}?download=true`;
}

/**
 * Chat models in registry order. This is a one-element list by design; it stays
 * a list because the provider, the router preset generator and the fetch
 * scripts all iterate it, and collapsing it to a scalar would spread the
 * single-model assumption across four files instead of documenting it here.
 */
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
