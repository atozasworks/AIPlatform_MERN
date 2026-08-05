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
| All models permit commercial use | Yes — but two carry conditions, see below |

Two of the five chat models are **not** under a permissive OSI licence, and the
difference is operational, not academic:

- **Gemma 3 4B** — Gemma Terms of Use. Commercial use is permitted, but Google's
  Prohibited Use Policy binds ATOZAS *and* anyone ATOZAS distributes the weights
  to, and the terms must travel with any redistribution.
- **Llama 3.2 3B** — Llama 3.2 Community License. Commercial use is permitted
  only below 700 million monthly active users; above that Meta requires a
  separate licence. Products built on it must carry a "Built with Llama" notice.

Both Qwen3-4B builds (Apache-2.0) and Phi-4-mini (MIT) have no such conditions.
If ATOZAS ever needs to ship weights to a customer or cross the MAU threshold,
the two conditioned models are the ones to re-examine.

The no-external-egress property is enforced in code, not by convention:
`assertSelfHosted()` in `server/src/config/env.js` runs at boot on both the API
and worker processes and refuses to start if any inference URL resolves outside
loopback, an RFC1918 private range, or an explicitly allowlisted host. The
Groq, OpenAI, Anthropic, Gemini, Cohere, OpenRouter and Ollama providers have
been deleted from the codebase entirely — there is no code path to reach them.

## Serving architecture — one router, five chat models

`llama-server` runs in **router mode**: started without `--model`, it reads
`deploy/llama/models.ini` and fronts every chat model on `127.0.0.1:8081`,
spawning a child server per model on demand and evicting the least-recently-used
one once `--models-max` are resident. The `model` field of each OpenAI-format
request selects the target, which is how the model picker in the UI works
without a redeploy.

`--models-max` defaults to **1**. That is a memory decision: each resident Q4 4B
model costs roughly 2.5 GB of weights plus its KV cache, so keeping all five
loaded would need ~13 GB that a 16 GB host does not have to spare alongside
MongoDB, Redis and the Node processes. The cost of the default is that the first
request after switching models pays a model load from disk.

`models.ini` is **generated**, never hand-edited:
`server/scripts/generate-llama-preset.mjs` writes it from `modelRegistry.js`, so
the ids the API resolves and the ids the router serves cannot drift apart. It
skips models whose GGUF is not on disk, and the provider marks anything missing
from the router's `/v1/models` as `weights-missing` so the picker greys it out
instead of failing at generation time.

---

## 1. Chat model — Qwen3-4B-Instruct-2507 (Q4_K_M GGUF)

| Field | Value |
|---|---|
| Model name and version | Qwen3-4B-Instruct-2507 (July 2025 revision) |
| Quantization | Q4_K_M (4-bit, k-quant medium) |
| Original repository | https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507 |
| GGUF repository | https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF |
| Publisher | Alibaba Cloud / Qwen team (GGUF conversion by Unsloth) |
| Licence | Apache-2.0 |
| Commercial use permitted | Yes, without revenue restriction or usage reporting |
| Attribution required | Retain the Apache-2.0 licence notice |
| File on disk | `/opt/atozas-ai/models/chat/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` |
| Verified size | 2382 MB |
| SHA-256 | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |
| Transmits data externally | No — served by the router on `127.0.0.1:8081` |
| Served by | `atozas-llama.service` |

**Why this is the default** (`LLAMACPP_MODEL=qwen3-4b-instruct-2507`). It is the
most recent chat model in the register, and its knowledge cutoff is later than
the original Qwen3-4B below, Phi-4-mini and Llama 3.2. That matters for
questions the retrieval layer does not cover: where no source is fetched, the
answer comes from the weights alone. A host that has not downloaded this GGUF
must point `LLAMACPP_MODEL` at a model it does have, or the default selection
resolves to a model the router cannot serve.

**Repository choice.** Qwen publishes safetensors for this revision, not GGUF.
`Qwen/Qwen3-4B-Instruct-2507-GGUF` **does not exist** — Hugging Face answers a
missing repository with HTTP 401 rather than 404 (so as not to disclose whether
a private repository exists), which reads like a credentials problem and is
easy to misdiagnose. Verify any new repository id against
`https://huggingface.co/api/models/<id>` before relying on it. The Unsloth
conversion is ungated and carries the same Apache-2.0 licence as the original.

**No thinking switch.** Unlike the original Qwen3-4B, the 2507 revision is
instruct-only: Qwen split the hybrid model into separate Instruct and Thinking
releases. It therefore takes no `enable_thinking` template argument, and its
registry entry has no `extraBody`. `LLAMACPP_THINKING` has no effect on it.

---

## 2. Chat model — Qwen3-4B (Q4_K_M GGUF)

| Field | Value |
|---|---|
| Model name and version | Qwen3-4B (official GGUF release) |
| Quantization | Q4_K_M (4-bit, k-quant medium) |
| Source repository | https://huggingface.co/Qwen/Qwen3-4B-GGUF |
| Publisher | Alibaba Cloud / Qwen team |
| Licence | Apache-2.0 |
| Commercial use permitted | Yes, without revenue restriction or usage reporting |
| Attribution required | Retain the Apache-2.0 licence notice |
| File on disk | `/opt/atozas-ai/models/chat/Qwen3-4B-Q4_K_M.gguf` |
| Verified size | 2382 MB |
| SHA-256 | `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5` |
| Transmits data externally | No — served by `llama-server` bound to `127.0.0.1:8081` |
| Served by | `atozas-llama.service` |

**Repository choice.** This is the Qwen team's own GGUF publication, which is
why this entry has no separate `ggufRepository`. The 2507 revision above has
one, because Qwen did not repeat the GGUF publication for it — see section 1.

**Reasoning mode.** Qwen3 can emit chain-of-thought inside `<think>…</think>`.
It is disabled by default (`LLAMACPP_THINKING=false`), which passes
`chat_template_kwargs: { enable_thinking: false }` on every request. That is a
CPU-cost decision: reasoning tokens can triple generation time for a marginal
quality gain at this parameter count. Independently of the flag,
`server/src/utils/sanitizeText.js` filters `<think>` blocks out of the token
stream, so hidden reasoning can never reach a user even if the model emits it.

---

## 3. Chat model — Phi-4-mini-instruct 3.8B (Q4_K_M GGUF)

| Field | Value |
|---|---|
| Model name and version | Phi-4-mini-instruct (3.8B) |
| Quantization | Q4_K_M (4-bit, k-quant medium) |
| Original repository | https://huggingface.co/microsoft/Phi-4-mini-instruct |
| GGUF repository | https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF |
| Publisher | Microsoft |
| Licence | MIT |
| Commercial use permitted | Yes, without revenue restriction or usage reporting |
| Attribution required | Retain the MIT licence notice |
| File on disk | `/opt/atozas-ai/models/chat/Phi-4-mini-instruct-Q4_K_M.gguf` |
| Transmits data externally | No — served by the router on `127.0.0.1:8081` |
| Served by | `atozas-llama.service` |

**Repository choice.** Microsoft publishes safetensors, not GGUF, so the weights
come from the `unsloth` conversion. It is ungated and MIT-licensed, matching the
original. The chat template supports a `system` turn, so no prompt rewriting is
needed.

---

## 4. Chat model — Gemma 3 4B Instruct (Q4_K_M GGUF)

| Field | Value |
|---|---|
| Model name and version | gemma-3-4b-it |
| Quantization | Q4_K_M (4-bit, k-quant medium) |
| Original repository | https://huggingface.co/google/gemma-3-4b-it |
| GGUF repository | https://huggingface.co/unsloth/gemma-3-4b-it-GGUF |
| Publisher | Google DeepMind |
| Licence | **Gemma Terms of Use** (not an OSI licence) |
| Commercial use permitted | Yes, subject to the Prohibited Use Policy |
| Attribution required | Terms must accompany any redistribution; modified weights must be marked as modified |
| File on disk | `/opt/atozas-ai/models/chat/gemma-3-4b-it-Q4_K_M.gguf` |
| Transmits data externally | No — served by the router on `127.0.0.1:8081` |
| Served by | `atozas-llama.service` |

**Licence caution.** The Gemma Terms are more restrictive than Apache-2.0: they
impose downstream use restrictions that bind anyone ATOZAS passes the weights
to. Serving inference to end users is fine; redistributing the GGUF requires
carrying the terms with it.

**System prompt handling.** Gemma 3's chat template defines only `user` and
`model` turns, with no system turn. This was expected to require rewriting the
prompt application-side, but llama.cpp's jinja rendering folds a `system`
message into the first user turn instead of dropping or rejecting it. Verified
against this exact GGUF: a system instruction to prefix replies with a marker
token was obeyed, so the ATOZAS safety and citation rules do reach the model and
no special-casing is needed. Re-check this if the GGUF conversion is ever
swapped for one with a different embedded template.

---

## 5. Chat model — Llama 3.2 3B Instruct (Q4_K_M GGUF)

| Field | Value |
|---|---|
| Model name and version | Llama-3.2-3B-Instruct |
| Quantization | Q4_K_M (4-bit, k-quant medium) |
| Original repository | https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct |
| GGUF repository | https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF |
| Publisher | Meta |
| Licence | **Llama 3.2 Community License** (not an OSI licence) |
| Commercial use permitted | Yes, below 700M monthly active users |
| Attribution required | "Built with Llama" notice; Acceptable Use Policy applies |
| File on disk | `/opt/atozas-ai/models/chat/Llama-3.2-3B-Instruct-Q4_K_M.gguf` |
| Transmits data externally | No — served by the router on `127.0.0.1:8081` |
| Served by | `atozas-llama.service` |

**Licence caution.** The 700M MAU ceiling is the clause to watch. Below it,
commercial use is unrestricted in practice; above it Meta must grant a separate
licence. The "Built with Llama" notice is required on any product that uses the
model, which includes ATOZAS AI while this model is selectable.

**Repository choice.** Meta's own repository is licence-gated and requires an
accepted agreement plus a Hugging Face token to download. The `unsloth`
conversion is ungated and carries the same Llama 3.2 licence, so the obligations
above still apply.

---

## 6. Embedding model — Qwen3-Embedding-0.6B (Q8_0 GGUF)

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

1. Confirm the licence permits commercial use, and verify the repository id
   against `https://huggingface.co/api/models/<id>` — a missing repository
   answers 401, not 404, which is easy to misread as a credentials problem.
2. Add an entry to `MODEL_REGISTRY` in `server/src/services/ai/modelRegistry.js`.
   That is the only code change: the fetch scripts, the router preset and the
   model picker are all generated from the registry.
3. Add the `MODEL_SHA256_*` variable it reads to `server/.env.example`.
4. Run the fetch script (`fetch-models.sh`, or `fetch-models.ps1 -Checksum` on
   Windows) and record the printed SHA-256 in `server/.env` and in the table
   above. Cross-check it against the `lfs.oid` Hugging Face reports for the
   file, which is its SHA-256.
5. Add a section to this document with every field populated, and update the
   model counts in the sections above.
6. Verify `GET /api/v1/admin/ai/status` shows `checksumRecorded: true` for it.

A model without a recorded checksum is reported as non-compliant on the admin
status endpoint rather than being silently accepted.
