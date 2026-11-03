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
| Any prompt, conversation or uploaded document transmitted externally | No |
| Any outbound network traffic at all | Yes, when live web retrieval is enabled — see below |
| All models permit commercial use | Yes, unconditionally (Apache-2.0) |

ATOZAS serves **one** chat model, `Qwen3-4B-Instruct-2507`, plus one embedding
model. Both are Apache-2.0, so there are no redistribution conditions, no
acceptable-use policy binding downstream users, and no user-count threshold to
watch. The Gemma 3, Llama 3.2 and Phi-4-mini entries that previously appeared
here were removed along with the model picker; if any is ever reinstated, its
licence conditions must be re-recorded in this file first.

### What is guaranteed, and what is not

Two separate properties are at stake, and conflating them would misrepresent the
system. They are enforced by different code and configured independently.

**No prompt reaches a third-party model.** This is absolute and enforced at boot.
`assertSelfHosted()` in `server/src/config/env.js` runs on both the API and the
worker process and refuses to start if any inference or embedding URL resolves
outside loopback, an RFC1918 private range, or an explicitly allowlisted host.
The Groq, OpenAI, Anthropic, Gemini, Cohere, OpenRouter and Ollama providers were
deleted from the codebase — there is no code path to reach them. Generation and
embedding happen on this host, always.

**Live web retrieval does make outbound requests.** It is off by default
(`WEB_RETRIEVAL_ENABLED=false`). When an operator enables it, two kinds of
traffic leave the host:

1. A short **search query** derived from the user's question, sent to a SearXNG
   instance ATOZAS runs. `env.js` refuses to boot if `SEARXNG_BASE_URL` is not
   loopback or private, so the query cannot be sent to a public instance. What
   SearXNG then forwards to upstream engines is governed by
   `deploy/searxng/settings.yml`.
2. HTTP GETs to the **public pages** the search returned, to extract article text.

What never leaves, in either case: the system prompt, the conversation history,
the user's identity, and any uploaded document or its embeddings. The question is
reduced to a search phrase; nothing else is transmitted.

Auditing it: `GET /api/v1/admin/ai/status` reports the full `webRetrieval`
configuration, including whether a domain allowlist is in force, and the
`web_retrievals` counter records how many requests used the tier.

`WEB_ALLOWED_DOMAINS` is the control that matters for a regulated deployment.
Left empty, retrieval may quote any public host. Populated, it is an exclusive
allowlist — official documentation, government sources, a chosen news set — which
bounds what the model can end up citing.

## Serving architecture — one router, one chat model

`llama-server` runs in **router mode**: started without `--model`, it reads
`deploy/llama/models.ini` and fronts the chat model on `127.0.0.1:8081`, spawning
a child server on demand. Router mode is retained despite there being one model
because it keeps `models.ini` generated from the registry and makes adding a
second model a configuration change rather than a code change.

`--models-max` is **1**, which is now simply a statement of fact rather than a
memory trade-off: one resident Q4 4B model costs roughly 2.5 GB of weights plus
its KV cache, comfortably within a 16 GB host alongside MongoDB, Redis, SearXNG
and the Node processes.

There is **no model picker**. That is deliberate: a second resident model would
double RAM for no accuracy gain on a CPU box, and every per-model quirk (chat
templates, thinking switches, prompt rewriting) is a source of behaviour drift
that is invisible until an answer is subtly wrong. The client shows the model as
a label, not a control.

`models.ini` is **generated**, never hand-edited:
`server/scripts/generate-llama-preset.mjs` writes it from `modelRegistry.js`, so
the id the API resolves and the id the router serves cannot drift apart. It skips
models whose GGUF is not on disk, and the provider marks anything missing from
the router's `/v1/models` as `weights-missing` rather than failing at generation
time.

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

**Why this model** (`LLAMACPP_MODEL=qwen3-4b-instruct-2507`). It has the latest
knowledge cutoff of the small open-weight models evaluated, and Apache-2.0
imposes no conditions on commercial use or redistribution. The cutoff matters
because it is the floor on answer quality: where retrieval fetches nothing, the
answer comes from the weights alone.

**The cutoff is still a cutoff.** No amount of choosing a newer model fixes
staleness — it only moves the date. That is what the live retrieval tier below
exists for, and why the system prompt states today's date and requires the model
to flag anything it cannot confirm from a source.

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

Independently of that, `server/src/utils/sanitizeText.js` filters `<think>`
blocks out of the token stream, so hidden reasoning cannot reach a user even if a
future model emits it.

**Decommissioned models.** Qwen3-4B (original), Phi-4-mini-instruct 3.8B, Gemma 3
4B Instruct and Llama 3.2 3B Instruct were previously served here and were removed
when the model picker was retired. Two of them carried non-OSI licence conditions
(Gemma's Prohibited Use Policy, Meta's 700M-MAU ceiling and "Built with Llama"
notice) which no longer apply to ATOZAS. Reinstating any of them requires
re-recording those obligations in this file first.

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

**Not used for web reranking, by measurement.** The obvious design was to score
fetched web passages with this same model. It was benchmarked on the ATOZAS CPU
box and is not viable at query time:

| Passages embedded | Wall time |
|---|---|
| 1 | 5.3 s |
| 8 | 44.7 s |
| 16 | timeout at 60 s |

That is ~5.5 s per passage, so reranking even four would exceed the entire
20-second retrieval budget before the model emits a token. (An earlier
measurement suggested 15x better throughput; it was invalid, because repeated
passage text let llama.cpp serve most of it from the prompt cache.) Document
ingest absorbs this cost happily since it runs asynchronously on the queue —
query-time reranking cannot.

Web passages are therefore ranked **lexically**, BM25-style, in microseconds
(`server/src/services/web/rerank.js`). The quality loss is narrower than it
looks: the semantic match already happened when the search engine ranked the page
for the query, so what remains is a within-document choice between paragraphs of
one article, which term overlap handles well. `WEB_RERANK_MODE=embedding`
restores the embedding path for deployments with a GPU or a dedicated embedding
host, where the table above does not apply.

`WEB_MIN_SCORE` is a separate threshold from `RAG_MIN_SCORE` — web text is
noisier and search has already filtered for relevance — and its default tracks
`WEB_RERANK_MODE`, since lexical coverage (0.15) and cosine similarity (0.45)
are unrelated scales. Leave it unset unless you have calibrated your own corpus.

---

## 3. Live web retrieval — no model, but part of the answer

Retrieval is not a model, so it has no licence or checksum row. It is recorded
here because it changes what an answer is based on, and because it is the only
outbound network path in the system.

| Component | Choice | Licence |
|---|---|---|
| Metasearch | SearXNG, self-hosted (`deploy/searxng/`) | AGPL-3.0 |
| Article extraction | `@mozilla/readability` over `jsdom` | Apache-2.0 / MIT |
| Reranking | Lexical BM25, in-process (see section 2) | — |
| Caching | Redis, already deployed | BSD-3-Clause |

Every component is open source and self-hosted. No search API key, no per-query
billing, no vendor query log.

**Why Readability rather than Trafilatura or Playwright.** Trafilatura extracts
more accurately from hostile markup, but it is a Python process: adding a Python
runtime and an IPC boundary to a Node deployment costs more operational surface
than the accuracy gain is worth. Playwright would additionally run a headless
Chromium per fetch, competing with `llama-server` for the cores that generate
tokens. The accepted consequence is that **no JavaScript is executed**, so a page
that renders its content client-side yields nothing and is skipped. Most
authoritative sources for the questions this serves — documentation, government
pages, news articles — are server-rendered.

**Why nothing is persisted.** Web passages live only in a short-TTL Redis fetch
cache. They are never written into the `Document` / `DocumentChunk` corpus,
because that corpus is user-owned, access-scoped and assumed curated; mixing
transient scraped text into it would invalidate the meaning of every existing
similarity threshold and require an eviction job to stop it growing without
bound.

**Why the freshness router is not a model call.** Asking the 4B model "does this
need current information?" before every message would roughly double generation
cost on a CPU box, for a judgement that keyword evidence gets right most of the
time, and would be non-deterministic — the same question could route differently
on consecutive turns. `server/src/services/web/freshness.js` is a deterministic
classifier instead, biased toward searching: a needless search wastes seconds,
while a missed one produces a confidently stale answer.

**Security boundary.** Search results are attacker-influenceable — anyone can
publish a page that ranks — so `server/src/services/web/egressGuard.js` treats
every URL as hostile. http/https only, default ports only, no credentials in the
URL, and every hostname resolved with all answers required to be globally
routable. Redirects are followed manually and re-vetted per hop, because a public
URL is free to redirect to a private one. Without this, retrieval would be a
server-side request forgery primitive pointed at MongoDB (27017), Redis (6379),
llama-server (8081) and the cloud metadata service (169.254.169.254).

**Prompt injection.** Fetched text is untrusted and is handled exactly as
uploaded documents are: control-stripped, token-capped, fenced inside a
`<<<SOURCES` block, and preceded by a rule stating that instructions appearing
inside a source must be treated as quoted content. `citations.js` then discards
any citation label the model did not actually receive, so a page cannot fabricate
a reference.

**Dates.** Every web citation carries `retrievedAt` — when ATOZAS read the page —
and `publishedAt` where the page declares one. Only the first is something ATOZAS
can vouch for; the second is the publisher's own claim. Both are shown in the UI,
stored on the message so an old answer keeps the dates it was actually based on,
and stated in the prompt so the model can say when a fact was true.

---

## Adding a new model

Adding a second chat model also means restoring a picker in the client, which was
removed deliberately (see "Serving architecture"). Consider whether the accuracy
gain justifies the RAM and the per-model behaviour drift first.

1. Confirm the licence permits commercial use, and verify the repository id
   against `https://huggingface.co/api/models/<id>` — a missing repository
   answers 401, not 404, which is easy to misread as a credentials problem.
2. Add an entry to `MODEL_REGISTRY` in `server/src/services/ai/modelRegistry.js`.
   That is the only server change: the fetch scripts and the router preset are
   both generated from the registry.
3. Add the `MODEL_SHA256_*` variable it reads to `server/.env.example`.
4. Run the fetch script (`fetch-models.sh`, or `fetch-models.ps1 -Checksum` on
   Windows) and record the printed SHA-256 in `server/.env` and in the table
   above. Cross-check it against the `lfs.oid` Hugging Face reports for the
   file, which is its SHA-256.
5. Add a section to this document with every field populated, including any
   licence obligations that bind downstream users.
6. Raise `LLAMACPP_MODELS_MAX` only if the host has RAM for a second resident
   model — roughly 2.5 GB of weights plus KV cache each.
7. Verify `GET /api/v1/admin/ai/status` shows `checksumRecorded: true` for it.

A model without a recorded checksum is reported as non-compliant on the admin
status endpoint rather than being silently accepted.
