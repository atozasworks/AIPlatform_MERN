#!/usr/bin/env bash
#
# Measures real throughput on THIS machine so the systemd unit and
# LLM_WORKER_CONCURRENCY are set from data instead of guesses.
#
#   bash deploy/scripts/benchmark.sh
#
# Sweeps --parallel 1..4 against context 4096 and 8192, reporting for each:
#   - time to first token (what the user experiences as "is it working?")
#   - tokens/second per stream
#   - aggregate tokens/second across concurrent streams
#
# The useful setting is rarely the highest aggregate throughput. Past a point,
# adding parallelism buys a few aggregate tokens/sec while every individual
# user waits noticeably longer. Pick the largest --parallel where single-stream
# speed stays acceptable, then set LLM_WORKER_CONCURRENCY to that value.
#
# Takes 20-40 minutes. Run it on an idle box.

set -Eeuo pipefail

readonly PREFIX=/opt/atozas-ai
readonly BIN="${PREFIX}/llama.cpp/build/bin/llama-server"
readonly MODEL="${PREFIX}/models/qwen3-4b/Qwen3-4B-Q4_K_M.gguf"
readonly PORT=18081
readonly HOST=127.0.0.1
readonly RESULTS="${PWD}/benchmark-results-$(date +%Y%m%d-%H%M%S).txt"

readonly PARALLEL_VALUES=(1 2 3 4)
readonly CTX_VALUES=(4096 8192)
readonly THREADS="${THREADS:-$(nproc)}"
readonly GEN_TOKENS="${GEN_TOKENS:-256}"

readonly PROMPT='Explain in detail how a queue-based request system protects a CPU-only inference server from overload. Cover admission control, worker concurrency, and what the user sees while waiting.'

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -x "${BIN}" ]]    || die "llama-server not found at ${BIN}. Run install-llamacpp.sh first."
[[ -f "${MODEL}" ]]  || die "Model not found at ${MODEL}. Run fetch-models.sh first."
command -v jq >/dev/null || die "jq is required: sudo apt-get install -y jq"
command -v bc >/dev/null || die "bc is required: sudo apt-get install -y bc"

SERVER_PID=""
cleanup() {
  [[ -n "${SERVER_PID}" ]] && kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

{
  echo "ATOZAS AI — llama.cpp benchmark"
  echo "date:    $(date -Is)"
  echo "host:    $(uname -a)"
  echo "cpu:     $(lscpu | awk -F': +' '/Model name/{print $2; exit}')"
  echo "cores:   $(nproc)"
  echo "memory:  $(free -h | awk 'NR==2{print $2" total, "$7" available"}')"
  echo "threads: ${THREADS}"
  echo "gen tokens per request: ${GEN_TOKENS}"
  echo
} | tee "${RESULTS}"

start_server() {
  local ctx="$1" parallel="$2"
  # Context is per-slot in llama.cpp, so total KV cache scales with --parallel.
  local total_ctx=$(( ctx * parallel ))

  "${BIN}" \
    --model "${MODEL}" \
    --host "${HOST}" --port "${PORT}" \
    --threads "${THREADS}" --threads-batch "${THREADS}" \
    --ctx-size "${total_ctx}" \
    --parallel "${parallel}" \
    --cont-batching --cache-prompt \
    --no-webui \
    >/tmp/atozas-bench-server.log 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 120); do
    if curl -sf "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then return 0; fi
    kill -0 "${SERVER_PID}" 2>/dev/null || { cat /tmp/atozas-bench-server.log; die "Server exited during startup"; }
    sleep 1
  done
  die "Server did not become healthy within 120s"
}

stop_server() {
  [[ -n "${SERVER_PID}" ]] || return 0
  kill -INT "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
  SERVER_PID=""
  sleep 2
}

# Streams one completion, printing "<ttft_ms> <total_ms> <tokens>".
# Timing is done in bash rather than awk: reading the clock per line from awk
# via getline is unreliable and was skewing time-to-first-token.
run_one() {
  local start first=0 last=0 tokens=0 now line
  start=$(date +%s%3N)

  local body
  body="$(jq -nc --arg p "${PROMPT}" --argjson n "${GEN_TOKENS}" \
    '{model:"bench",messages:[{role:"user",content:$p}],stream:true,max_tokens:$n,temperature:0.2,top_p:0.9}')"

  while IFS= read -r line; do
    [[ "${line}" == data:* ]] || continue
    [[ "${line}" == *"[DONE]"* ]] && continue
    now=$(date +%s%3N)
    (( first == 0 )) && first=${now}
    last=${now}
    (( tokens++ )) || true
  done < <(curl -sN --max-time 900 -X POST "http://${HOST}:${PORT}/v1/chat/completions" \
             -H 'Content-Type: application/json' -d "${body}")

  printf '%d %d %d' \
    "$(( first ? first - start : 0 ))" \
    "$(( last  ? last  - start : 0 ))" \
    "${tokens}"
}

for ctx in "${CTX_VALUES[@]}"; do
  for parallel in "${PARALLEL_VALUES[@]}"; do
    log "ctx=${ctx} parallel=${parallel} — starting server"
    start_server "${ctx}" "${parallel}"

    # Warm the prompt cache so the measurement reflects steady state.
    run_one >/dev/null 2>&1 || true

    log "ctx=${ctx} parallel=${parallel} — running ${parallel} concurrent request(s)"
    wall_start=$(date +%s%3N)

    tmpdir="$(mktemp -d)"
    for i in $(seq 1 "${parallel}"); do
      ( run_one > "${tmpdir}/${i}" ) &
    done
    wait
    wall_end=$(date +%s%3N)
    wall_ms=$(( wall_end - wall_start ))

    total_tokens=0; ttft_sum=0; dur_sum=0; n=0
    for f in "${tmpdir}"/*; do
      read -r ttft dur toks < "${f}"
      total_tokens=$(( total_tokens + toks ))
      ttft_sum=$(( ttft_sum + ttft ))
      dur_sum=$(( dur_sum + dur ))
      n=$(( n + 1 ))
    done
    rm -rf "${tmpdir}"

    avg_ttft=$(( n ? ttft_sum / n : 0 ))
    avg_dur=$(( n ? dur_sum / n : 0 ))
    per_stream_tps=$(echo "scale=2; ${total_tokens} / ${n} / (${avg_dur} / 1000)" | bc -l 2>/dev/null || echo 0)
    aggregate_tps=$(echo "scale=2; ${total_tokens} / (${wall_ms} / 1000)" | bc -l 2>/dev/null || echo 0)
    rss=$(ps -o rss= -p "${SERVER_PID}" 2>/dev/null | tr -d ' ' || echo 0)

    printf 'ctx=%-5s parallel=%-2s  ttft=%-6sms  per-stream=%-7s tok/s  aggregate=%-7s tok/s  rss=%sMB\n' \
      "${ctx}" "${parallel}" "${avg_ttft}" "${per_stream_tps}" "${aggregate_tps}" "$(( rss / 1024 ))" \
      | tee -a "${RESULTS}"

    stop_server
  done
done

cat <<EOF | tee -a "${RESULTS}"

── How to read this ──
  ttft         Time to first token. Above ~15s users assume the app is broken.
  per-stream   What one user experiences. Below ~5 tok/s reads as painfully slow.
  aggregate    Total platform throughput.

Choose the largest --parallel where per-stream stays acceptable, then:
  1. deploy/systemd/atozas-llama.service  → LLAMA_PARALLEL, LLAMA_THREADS, LLAMA_CTX_SIZE
  2. server/.env                          → LLM_WORKER_CONCURRENCY (must be <= LLAMA_PARALLEL)
  3. sudo systemctl daemon-reload && sudo systemctl restart atozas-llama
  4. pm2 restart atozas-worker --update-env

Results saved to: ${RESULTS}
EOF
