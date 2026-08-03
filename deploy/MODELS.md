# ATOZAS AI — Model provenance and licence register

Every model served by ATOZAS must be recorded here before it is deployed. This
file is the human-readable record; the machine-readable copy lives in
`server/src/services/ai/modelRegistry.js` and is exposed at
`GET /api/v1/admin/ai/status`.

## Compliance summary

| Property | Status |
|---|---|
| All weights self-hosted on ATOZAS infrastructure | Yes |
| Any third-party LLM / embedding / reranking API in use | No |
| Any prompt, document or embedding transmitted externally | No |
| All models permit commercial use | Yes |

The no-external-egress property is enforced in code, not by convention:
`assertSelfHosted()` in `server/src/config/env.js` runs at boot on both the API
and worker processes and refuses to start if any inference URL resolves outside
loopback, an RFC1918 private range, or an explicitly allowlisted host. The
Groq, OpenAI, Anthropic, Gemini, Cohere, OpenRouter and Ollama providers have
been deleted from the codebase entirely — there is no code path to reach them.

---

## 1. Chat model — Qwen3-4B (Q4_K_M GGUF)

| Field | Value |
|---|---|
| Model name and version | Qwen3-4B (official GGUF release) |
| Quantization | Q4_K_M (4-bit, k-quant medium) |
| Source repository | https://huggingface.co/Qwen/Qwen3-4B-GGUF |
| Publisher | Alibaba Cloud / Qwen team |
| Licence | Apache-2.0 |
| Commercial use permitted | Yes, without revenue restriction or usage reporting |
| Attribution required | Retain the Apache-2.0 licence notice |
| File on disk | `/opt/atozas-ai/models/qwen3-4b/Qwen3-4B-Q4_K_M.gguf` |
| Verified size | 2382 MB |
| SHA-256 | `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5` |
| Transmits data externally | No — served by `llama-server` bound to `127.0.0.1:8081` |
| Served by | `atozas-llama.service` |

**Repository choice.** This is the Qwen team's own GGUF publication. An earlier
draft of `fetch-models.sh` pointed at `Qwen/Qwen3-4B-Instruct-2507-GGUF`, which
does not exist; Hugging Face answers a missing repository with HTTP 401 rather
than 404 (so as not to disclose whether a private repository exists), which
reads like a credentials problem and is easy to misdiagnose. Verify any new
repository id against `https://huggingface.co/api/models/<id>` before relying
on it.

**Reasoning mode.** Qwen3 can emit chain-of-thought inside `<think>…</think>`.
It is disabled by default (`LLAMACPP_THINKING=false`), which passes
`chat_template_kwargs: { enable_thinking: false }` on every request. That is a
CPU-cost decision: reasoning tokens can triple generation time for a marginal
quality gain at this parameter count. Independently of the flag,
`server/src/utils/sanitizeText.js` filters `<think>` blocks out of the token
stream, so hidden reasoning can never reach a user even if the model emits it.

---

## 2. Embedding model — Qwen3-Embedding-0.6B (Q8_0 GGUF)

| Field | Value |
|---|---|
| Model name and version | Qwen3-Embedding-0.6B |
| Quantization | Q8_0 |
| Source repository | https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF |
| Publisher | Alibaba Cloud / Qwen team |
| Licence | Apache-2.0 |
| Commercial use permitted | Yes |
| Parameters | 0.6B |
| Embedding dimensions | 1024 |
| Languages | 100+ |
| File on disk | `/opt/atozas-ai/models/embeddings/Qwen3-Embedding-0.6B-Q8_0.gguf` |
| Verified size | 610 MB |
| SHA-256 | `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439` |
| Transmits data externally | No — served by `llama-server` bound to `127.0.0.1:8082` |
| Served by | `atozas-llama-embed.service` |

**Why not multilingual-e5-small.** e5-small was the original choice — smaller,
384 dimensions, MIT. It was abandoned because no GGUF conversion of it works
with current llama.cpp. Three published conversions were tested:

| Conversion | Result |
|---|---|
| `cstr/multilingual-e5-small-GGUF` (fp32, 455 MB) | Fails to load: `bert model needs to define token type count` |
| `milimyname/multilingual-e5-small-Q8_0-GGUF` (126 MB) | Crashes: `binary_op: unsupported types: dst: f32, src0: f32, src1: q8_0` |
| `keisuke-miyako/multilingual-e5-small-gguf-f16` (231 MB) | Loads, but the embedding space is degenerate |

The third case is the dangerous one, because it fails silently. Measured with
the correct `query: ` / `passage: ` prefixes, a password-reset query scored
**0.9246** against the matching passage but **0.9302** against "Quarterly
revenue grew by twelve percent in euros" — the irrelevant passage ranked
*higher*, and the total spread across five unrelated texts was 0.039. Retrieval
built on that would return arbitrary documents while looking healthy.

The same probe against Qwen3-Embedding-0.6B:

| Passage | Cosine vs. "how do I reset my ATOZAS password" |
|---|---|
| "To change your ATOZAS account credentials, go to the security tab." | 0.7944 |
| "Password reset instructions: open Settings then choose Reset password." | 0.5345 |
| "Quarterly revenue grew by twelve percent in euros." | 0.1928 |
| "The mitochondrion is the powerhouse of the cell." | 0.1189 |
| "Bananas are a tropical fruit rich in potassium." | 0.0921 |

Both relevant passages rank above every irrelevant one, with a spread of 0.70.
Cross-lingual similarity between the same question in English and Hindi is
0.9081, which satisfies the multilingual requirement. `RAG_MIN_SCORE=0.45` is
set from this distribution and is **not portable** to another embedding model.

**Why `--pooling last`.** Qwen3-Embedding is a decoder that encodes the sequence
into its final token. Mean pooling over decoder states yields a near-constant
vector — the same failure mode as the broken e5 build. The systemd unit pins
`--pooling last`.

**Why a separate server.** Running embeddings on the Qwen3-4B instance would
make every document import compete with live conversations for the same slots.
This model costs about 610 MB of RAM and two threads.

**Asymmetric wrapping.** The query is wrapped in
`Instruct: ...\nQuery: <text>`; passages are embedded as raw text. Mixing the
two up collapses similarity. `server/src/services/rag/embeddings.js` exposes
`embedQuery()` and `embedPassages()` as separate functions so a call site
cannot get it wrong, and both affixes are environment variables so a future
model swap stays a configuration change.

---

## Adding a new model

1. Confirm the licence permits commercial use and record the exact repository URL.
2. Add an entry to `MODEL_REGISTRY` in `server/src/services/ai/modelRegistry.js`.
3. Add a download entry to `deploy/scripts/fetch-models.sh`.
4. Run the fetch script, record the printed SHA-256 in `server/.env` and in the table above.
5. Add a row to this document with every field populated.
6. Verify `GET /api/v1/admin/ai/status` shows `checksumRecorded: true` for it.

A model without a recorded checksum is reported as non-compliant on the admin
status endpoint rather than being silently accepted.
