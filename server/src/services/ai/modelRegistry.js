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
 * @typedef {object} ModelRecord
 * @property {string} id             Internal id used by the provider layer.
 * @property {string} name           Upstream model name and version.
 * @property {string} repository     Source repository the weights came from.
 * @property {string} [ggufRepository] Conversion repo, when the GGUF build is
 *                                   published separately from the original weights.
 * @property {string} license        SPDX identifier or licence name.
 * @property {boolean} commercialUse Whether commercial use is permitted.
 * @property {string} file           Expected filename on disk.
 * @property {string} sha256         Expected SHA-256 of the GGUF file.
 * @property {boolean} transmitsDataExternally
 * @property {string} role           'chat' | 'embedding'
 */

/** @type {ModelRecord[]} */
export const MODEL_REGISTRY = [
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
 * Compliance view for the admin endpoint. Flags any model that is being served
 * without a recorded checksum so gaps are visible rather than assumed clean.
 */
export function describeModelCompliance() {
  const active = new Set(
    [
      env.ai.llamacpp.enabled ? env.ai.llamacpp.model : null,
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
