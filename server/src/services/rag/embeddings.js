import { env, assertSelfHosted } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../config/logger.js';

/**
 * Embeddings from a dedicated `llama-server` instance (default 127.0.0.1:8082)
 * running Qwen3-Embedding-0.6B.
 *
 * This is deliberately a *second* process, not the chat instance: sharing one
 * llama-server would make every embedding call contend with user generations
 * for the same slots. It is also a purpose-built retrieval model rather than
 * the chat model — Qwen3-4B's decoder states embed poorly.
 *
 * Retrieval models are asymmetric: the query and the stored passage must be
 * wrapped differently or similarity collapses toward a constant. `embedQuery`
 * and `embedPassages` exist so a caller cannot get that wrong.
 *
 * Vectors are L2-normalized at the boundary, which lets the vector store use a
 * plain dot product for cosine similarity.
 */

const BASE_URL = assertSelfHosted('EMBEDDING_BASE_URL', env.ai.embeddings.baseUrl);

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(env.ai.embeddings.apiKey ? { Authorization: `Bearer ${env.ai.embeddings.apiKey}` } : {}),
  };
}

export function normalize(vector) {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) sumSquares += vector[i] * vector[i];
  const magnitude = Math.sqrt(sumSquares);
  if (!magnitude) return vector.map(() => 0);
  return vector.map((v) => v / magnitude);
}

async function callEmbeddingServer(inputs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ai.embeddings.requestTimeoutMs);

  try {
    const res = await fetch(`${BASE_URL}/v1/embeddings`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: env.ai.embeddings.model, input: inputs }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error?.message) detail = body.error.message;
      } catch {
        // Non-JSON error page; the status code is enough.
      }
      throw new AppError(503, `Embedding service unavailable (${detail})`, {
        code: 'EMBEDDING_UNAVAILABLE',
      });
    }

    const body = await res.json();
    const rows = Array.isArray(body?.data) ? body.data : [];

    // The server may reorder results; `index` is authoritative.
    const ordered = new Array(inputs.length);
    for (const row of rows) {
      const vector = row?.embedding;
      if (!Array.isArray(vector)) continue;
      ordered[row.index ?? rows.indexOf(row)] = normalize(vector);
    }

    if (ordered.some((v) => !v)) {
      throw new AppError(503, 'Embedding service returned an incomplete batch', {
        code: 'EMBEDDING_UNAVAILABLE',
      });
    }

    return ordered;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err.name === 'AbortError') {
      throw new AppError(504, 'Embedding service timed out', { code: 'EMBEDDING_TIMEOUT' });
    }
    throw new AppError(503, `Embedding service unreachable: ${err.message}`, {
      code: 'EMBEDDING_UNAVAILABLE',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Embeds text in batches so a large ingest cannot exhaust the server's slots. */
async function embedBatched(texts) {
  const out = [];
  const size = Math.max(1, env.ai.embeddings.batchSize);
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    // Sequential by design: parallel batches would starve chat generations.
    out.push(...(await callEmbeddingServer(batch)));
  }
  return out;
}

/** Embeds a search query, wrapped in the model's query instruction. */
export async function embedQuery(text) {
  const [vector] = await embedBatched([`${env.ai.embeddings.queryPrefix}${String(text).trim()}`]);
  return vector;
}

/** Embeds document chunks, using the model's passage form. */
export async function embedPassages(texts) {
  if (!texts.length) return [];
  return embedBatched(texts.map((t) => `${env.ai.embeddings.passagePrefix}${String(t).trim()}`));
}

export function isEmbeddingEnabled() {
  return env.ai.embeddings.enabled;
}

export async function checkEmbeddingHealth({ timeoutMs = 3000 } = {}) {
  if (!env.ai.embeddings.enabled) {
    return { ok: false, enabled: false, reason: 'disabled by configuration' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(`${BASE_URL}/health`, { headers: headers(), signal: controller.signal });
    return { ok: res.ok, enabled: true, status: res.status, latencyMs: Date.now() - startedAt };
  } catch (err) {
    logger.debug({ err }, 'Embedding health check failed');
    return { ok: false, enabled: true, latencyMs: Date.now() - startedAt, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export default { embedQuery, embedPassages, normalize, checkEmbeddingHealth };
