#!/usr/bin/env bash
#
# Builds llama.cpp optimized for this VPS's CPU and installs the systemd units.
# Run once on a fresh Hostinger KVM 8, then again to upgrade llama.cpp.
#
#   sudo bash deploy/scripts/install-llamacpp.sh
#
# Idempotent: safe to re-run.

set -Eeuo pipefail

readonly PREFIX=/opt/atozas-ai
readonly SRC_DIR="${PREFIX}/llama.cpp"
readonly SERVICE_USER=atozas-ai
readonly REPO=https://github.com/ggml-org/llama.cpp.git
# Pin a known-good tag. Bump deliberately after re-running the benchmark;
# tracking master has repeatedly shipped regressions in CPU generation speed.
readonly LLAMA_TAG="${LLAMA_TAG:-b4667}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo)."

# ── 1. Report the hardware we are building for ──
log "Host CPU and memory"
lscpu | grep -E 'Model name|^CPU\(s\)|Thread|Core|MHz|Flags' | sed 's/^/    /' || true
printf '    nproc: %s\n' "$(nproc)"
free -h | sed 's/^/    /'
uname -a | sed 's/^/    /'

CORES=$(nproc)
if (( CORES < 4 )); then
  warn "Only ${CORES} cores detected. Lower LLAMA_THREADS and LLM_WORKER_CONCURRENCY accordingly."
fi

# ── 2. Build toolchain ──
log "Installing build dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential cmake git curl ccache libcurl4-openssl-dev pkg-config

# ── 3. Dedicated service account ──
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  log "Creating service user ${SERVICE_USER}"
  # No shell, no home: this account exists only to own the inference process.
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
else
  log "Service user ${SERVICE_USER} already exists"
fi

mkdir -p "${PREFIX}/models/qwen3-4b" "${PREFIX}/models/embeddings" /var/log/atozas
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${PREFIX}"

# ── 4. Fetch source at the pinned tag ──
if [[ -d "${SRC_DIR}/.git" ]]; then
  log "Updating llama.cpp to ${LLAMA_TAG}"
  git -C "${SRC_DIR}" fetch --tags --depth 1 origin "${LLAMA_TAG}"
  git -C "${SRC_DIR}" checkout -f "${LLAMA_TAG}"
else
  log "Cloning llama.cpp at ${LLAMA_TAG}"
  git clone --depth 1 --branch "${LLAMA_TAG}" "${REPO}" "${SRC_DIR}"
fi

# ── 5. Build ──
# -march=native tunes to this exact CPU (AVX2/AVX-512 where present), which is
# worth a substantial throughput gain on CPU-only inference. The binary is
# therefore NOT portable to a different VPS — rebuild after any migration.
log "Building llama.cpp (this takes several minutes)"
cmake -S "${SRC_DIR}" -B "${SRC_DIR}/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLAMA_CURL=ON \
  -DGGML_NATIVE=ON \
  -DGGML_LTO=ON \
  -DBUILD_SHARED_LIBS=OFF

cmake --build "${SRC_DIR}/build" --config Release -j "${CORES}" --target llama-server llama-bench llama-cli

[[ -x "${SRC_DIR}/build/bin/llama-server" ]] || die "Build failed: llama-server not produced."

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${SRC_DIR}"

log "Installed version"
"${SRC_DIR}/build/bin/llama-server" --version 2>&1 | sed 's/^/    /' || true

# ── 6. Verify the flags in our unit files exist in THIS build ──
# llama.cpp renames flags between releases; catching it here beats a service
# that restart-loops after deploy.
log "Verifying required flags are supported"
HELP="$("${SRC_DIR}/build/bin/llama-server" --help 2>&1 || true)"
MISSING=()
for flag in --model --host --port --threads --threads-batch --ctx-size --parallel --cont-batching --cache-prompt --embedding --pooling; do
  grep -q -- "${flag}" <<<"${HELP}" || MISSING+=("${flag}")
done
if (( ${#MISSING[@]} > 0 )); then
  warn "This llama.cpp build does not advertise: ${MISSING[*]}"
  warn "Edit deploy/systemd/*.service before starting, or pin a different LLAMA_TAG."
else
  log "All required flags supported"
fi

# ── 7. Install systemd units ──
log "Installing systemd units"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
install -m 0644 "${REPO_ROOT}/deploy/systemd/atozas-llama.service"       /etc/systemd/system/
install -m 0644 "${REPO_ROOT}/deploy/systemd/atozas-llama-embed.service" /etc/systemd/system/
systemctl daemon-reload

cat <<EOF

$(log 'llama.cpp installed')

Next steps:
  1. Download and verify the models:
       sudo bash ${REPO_ROOT}/deploy/scripts/fetch-models.sh
  2. Start the services:
       sudo systemctl enable --now atozas-llama atozas-llama-embed
  3. Confirm both are healthy:
       curl -s http://127.0.0.1:8081/health
       curl -s http://127.0.0.1:8082/health
  4. Tune threads and parallelism with real numbers:
       bash ${REPO_ROOT}/deploy/scripts/benchmark.sh

EOF
