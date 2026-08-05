# SearXNG — search backend for ATOZAS live web retrieval

ATOZAS runs one chat model, `Qwen3-4B-Instruct-2507`, whose weights are frozen at
its training cutoff. Anything that changes after that — software versions, prices,
laws, officeholders, today's news — cannot be answered honestly from the weights
alone. This container is the search half of the retrieval tier that fixes that.

## Setup

### Option A — Docker (preferred on the VPS)

```bash
cd deploy/searxng
cp .env.example .env
openssl rand -hex 32          # paste into SEARXNG_SECRET
docker compose up -d
curl -s 'http://127.0.0.1:8888/search?q=test&format=json' | head -c 200
```

### Option B — WSL without Docker (Windows development)

Docker Desktop is not required for local work. From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\scripts\dev-searxng.ps1
```

That installs SearXNG into the default WSL distro under
`~/.local/share/atozas-searxng` (via `uv`'s managed Python 3.12, no sudo) and
binds it to `127.0.0.1:8888`. WSL must use `networkingMode=mirrored` — the same
mode `dev-redis.ps1` already requires — so Windows Node can reach the port.

That last `curl` / JSON probe is the one that matters. If it returns HTTP 403,
`json` is missing from `search.formats` in `settings.yml` — the SearXNG default
is HTML only, and a 403 here reads like an authentication problem rather than a
format one. It is the most common first-run failure.

Then in `server/.env`:

```ini
WEB_RETRIEVAL_ENABLED=true
SEARXNG_BASE_URL=http://127.0.0.1:8888
```

Restart the API **and** the worker. Both load `env.js`, and only the worker
performs retrieval.

## Why self-hosted

SearXNG sees every user question in cleartext. `server/src/config/env.js` refuses
to boot if `SEARXNG_BASE_URL` is not loopback or a private address, so ATOZAS
cannot be pointed at a public instance by accident — that would hand every query
to an operator ATOZAS does not control, which is the exact leak the rest of the
egress policy exists to prevent.

The same reasoning rules out Google, Bing and Brave search APIs: each needs an
account, bills per query, and logs queries against that account. SearXNG
aggregates those engines' results without a key, a bill, or an identity.

## Operational notes

**Not exposed publicly.** The port binds to `127.0.0.1` and Nginx does not proxy
it. It is infrastructure for the worker, not a service for users.

**The limiter is off.** SearXNG's rate limiter exists to protect public instances
from scrapers. This instance has one client, already rate-limited per user
upstream, so the limiter would only generate spurious 429s during normal use.

**Engine choice.** Only engines returning extractable article text are enabled;
image, video and social engines are disabled because ATOZAS extracts prose and
cannot cite a video. Upstream engines occasionally block or rate-limit a
self-hosted instance — that is why several are enabled, and why a search failure
degrades to a model-knowledge answer rather than an error.

**Resource caps.** Pinned to 1 CPU and 512 MB so a burst of searches cannot take
cores away from `llama-server`, which needs them to generate tokens.

## Verifying the whole path

With both services up, ask a question with a temporal cue — "what is the latest
stable Node.js release" — and check that the answer carries a `Sources (includes
live web)` block with retrieval timestamps. `GET /api/v1/admin/ai/status` reports
the same state under `webRetrieval`, including whether the domain allowlist is
in force.
