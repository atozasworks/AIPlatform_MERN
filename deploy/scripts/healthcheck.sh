#!/usr/bin/env bash
#
# End-to-end health check for the ATOZAS AI stack.
#
#   bash deploy/scripts/healthcheck.sh          # human-readable
#   bash deploy/scripts/healthcheck.sh --quiet  # exit code only, for cron
#
# Exit codes:  0 healthy   1 degraded (non-critical)   2 critical failure
#
# Suitable for a cron watchdog:
#   */5 * * * * /bin/bash /path/to/deploy/scripts/healthcheck.sh --quiet || \
#     systemctl restart atozas-llama

set -uo pipefail

readonly API=http://127.0.0.1:5000
readonly LLAMA=http://127.0.0.1:8081
readonly EMBED=http://127.0.0.1:8082

# Used to cross-check what the servers actually serve against what the
# application was configured to expect.
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/server/.env"
readonly ENV_FILE

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

STATUS=0
say()  { (( QUIET )) || printf '%s\n' "$*"; }
ok()   { say "  [ OK ]   $*"; }
warn() { say "  [WARN]   $*"; (( STATUS < 1 )) && STATUS=1; return 0; }
bad()  { say "  [FAIL]   $*"; STATUS=2; return 0; }

say "ATOZAS AI health check — $(date -Is)"
say

# ── 1. Inference engines ──
say "Inference"
if curl -sf --max-time 5 "${LLAMA}/health" >/dev/null 2>&1; then
  props="$(curl -sf --max-time 5 "${LLAMA}/props" 2>/dev/null || echo '{}')"
  slots="$(printf '%s' "${props}" | jq -r '.total_slots // "?"' 2>/dev/null || echo '?')"
  slot_ctx="$(printf '%s' "${props}" | jq -r '.default_generation_settings.n_ctx // 0' 2>/dev/null || echo 0)"
  ok "llama-server (chat) responding on 8081, slots=${slots}, ctx/slot=${slot_ctx}"

  # --ctx-size is the TOTAL context divided across slots, so a unit that passes
  # the per-conversation window instead of window x parallel silently halves it.
  # The token budgeter sizes prompts against LLAMACPP_CONTEXT_WINDOW, so a
  # mismatch truncates long conversations with no error anywhere.
  want_ctx="$(grep -E '^LLAMACPP_CONTEXT_WINDOW=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' || true)"
  if [[ -n "${want_ctx}" && "${slot_ctx}" != '0' ]] && (( slot_ctx < want_ctx )); then
    warn "ctx/slot ${slot_ctx} < LLAMACPP_CONTEXT_WINDOW ${want_ctx}: raise LLAMA_CTX_SIZE to (window x parallel)"
  fi
else
  bad "llama-server (chat) NOT responding on 8081"
fi

if curl -sf --max-time 5 "${EMBED}/health" >/dev/null 2>&1; then
  # A model that loads is not necessarily the right model. Embed one probe
  # string and check the width against the configured dimension: a mismatch
  # means every vector already in MongoDB is incomparable to new ones, which
  # produces silently wrong retrieval rather than an error.
  want_dims="$(grep -E '^EMBEDDING_DIMENSIONS=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' || true)"
  got_dims="$(curl -sf --max-time 20 "${EMBED}/v1/embeddings" \
    -H 'Content-Type: application/json' \
    -d '{"input":"healthcheck probe"}' 2>/dev/null \
    | jq -r '.data[0].embedding | length' 2>/dev/null || echo 0)"

  if [[ "${got_dims}" == '0' ]]; then
    warn "embedding server answered /health but returned no vector — retrieval will be keyword-only"
  elif [[ -n "${want_dims}" && "${got_dims}" != "${want_dims}" ]]; then
    bad "embedding dimension mismatch: server returns ${got_dims}, EMBEDDING_DIMENSIONS is ${want_dims}"
  else
    ok "llama-server (embeddings) responding on 8082, dims=${got_dims}"
  fi
else
  # Retrieval degrades to keyword-only rather than failing chat entirely.
  warn "embedding server NOT responding on 8082 — retrieval will be keyword-only"
fi

# ── 2. Data services ──
say
say "Data services"
if redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then
  ok "Redis responding"
else
  bad "Redis NOT responding — the queue cannot function"
fi

if mongosh --quiet --eval 'db.adminCommand("ping").ok' 2>/dev/null | grep -q 1; then
  ok "MongoDB responding"
elif mongo --quiet --eval 'db.adminCommand("ping").ok' 2>/dev/null | grep -q 1; then
  ok "MongoDB responding (legacy shell)"
else
  bad "MongoDB NOT responding"
fi

# ── 3. Application ──
say
say "Application"
if curl -sf --max-time 5 "${API}/api/health/live" >/dev/null 2>&1; then
  ok "API process alive"
else
  bad "API NOT alive on 5000"
fi

READY_JSON="$(curl -s --max-time 10 "${API}/api/health/ready" 2>/dev/null || echo '{}')"
if jq -e '.data.ready == true' <<<"${READY_JSON}" >/dev/null 2>&1; then
  ok "API reports ready"
else
  warn "API reports NOT ready"
  (( QUIET )) || jq -r '.data.checks // {} | to_entries[] | "           \(.key): \(.value.ok)"' <<<"${READY_JSON}" 2>/dev/null
fi

# Queue depth is the leading indicator of overload: it climbs long before CPU
# saturation shows up in load average.
WAITING="$(jq -r '.data.queue.waiting // 0' <<<"${READY_JSON}" 2>/dev/null || echo 0)"
PAUSED="$(jq -r '.data.queue.paused // false' <<<"${READY_JSON}" 2>/dev/null || echo false)"
BREAKER="$(jq -r '.data.breaker.state // "unknown"' <<<"${READY_JSON}" 2>/dev/null || echo unknown)"

if [[ "${PAUSED}" == "true" ]]; then
  warn "Generation queue is PAUSED"
elif (( WAITING > 50 )); then
  warn "Queue backlog is high: ${WAITING} waiting"
else
  ok "Queue depth ${WAITING}"
fi

[[ "${BREAKER}" == "open" ]] && warn "Circuit breaker is OPEN — inference is failing" || ok "Circuit breaker: ${BREAKER}"

# ── 4. PM2 ──
say
say "Processes"
if command -v pm2 >/dev/null 2>&1; then
  for app in atozas-api atozas-worker; do
    state="$(pm2 jlist 2>/dev/null | jq -r --arg n "${app}" '.[] | select(.name==$n) | .pm2_env.status' | head -1)"
    [[ "${state}" == "online" ]] && ok "${app}: online" || bad "${app}: ${state:-missing}"
  done

  # Cluster mode on the worker multiplies concurrent generations — always wrong.
  workers="$(pm2 jlist 2>/dev/null | jq -r '[.[] | select(.name=="atozas-worker")] | length')"
  (( workers > 1 )) && bad "atozas-worker has ${workers} instances — MUST be exactly 1 (fork mode)" \
                    || ok "atozas-worker instance count correct"
else
  warn "pm2 not on PATH"
fi

# ── 5. Host resources ──
say
say "Host"
MEM_PCT=$(free | awk 'NR==2 {printf "%.0f", $3/$2*100}')
SWAP_USED=$(free -m | awk 'NR==3 {print $3}')
DISK_PCT=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')
LOAD=$(awk '{print $1}' /proc/loadavg)
CORES=$(nproc)
LOAD_PER_CORE=$(echo "${LOAD} ${CORES}" | awk '{printf "%.2f", $1/$2}')

(( MEM_PCT > 90 )) && warn "Memory ${MEM_PCT}% used" || ok "Memory ${MEM_PCT}% used"
# Swap is fatal for inference latency: a swapped KV cache turns tokens/sec into
# seconds/token. Any sustained swap use warrants attention.
(( SWAP_USED > 256 )) && warn "Swap in use: ${SWAP_USED} MB — inference will be very slow" \
                      || ok "Swap ${SWAP_USED} MB"
(( DISK_PCT > 85 )) && warn "Disk ${DISK_PCT}% full" || ok "Disk ${DISK_PCT}% used"
awk -v l="${LOAD_PER_CORE}" 'BEGIN{exit !(l>1.5)}' && warn "Load per core ${LOAD_PER_CORE}" \
                                                  || ok "Load per core ${LOAD_PER_CORE}"

say
case ${STATUS} in
  0) say "Result: HEALTHY" ;;
  1) say "Result: DEGRADED" ;;
  2) say "Result: CRITICAL" ;;
esac

exit ${STATUS}
