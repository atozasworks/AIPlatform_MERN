#!/usr/bin/env bash
#
# Downloads the ATOZAS model weights and verifies their checksums.
#
#   sudo bash deploy/scripts/fetch-models.sh
#
# Every model is open-weight and licensed for commercial use. Provenance is
# recorded in deploy/MODELS.md and mirrored in server/src/services/ai/modelRegistry.js.
#
# Checksums: on a first install the expected values may be blank. The script
# then prints the computed SHA-256 so you can record it in server/.env and
# deploy/MODELS.md — after which every later run verifies against it and
# aborts on a mismatch.

set -Eeuo pipefail

readonly MODEL_ROOT=/opt/atozas-ai/models
readonly SERVICE_USER=atozas-ai

# ── Model catalogue ──
# Repository ids and filenames are verified against the Hugging Face API — a
# wrong one fails as an opaque HTTP 401 (HF masks "not found" to avoid
# disclosing private repositories), which is easy to misread as an auth issue.
readonly CHAT_FILE="Qwen3-4B-Q4_K_M.gguf"
readonly CHAT_DIR="${MODEL_ROOT}/qwen3-4b"
readonly CHAT_REPO="Qwen/Qwen3-4B-GGUF"
readonly CHAT_URL="https://huggingface.co/${CHAT_REPO}/resolve/main/${CHAT_FILE}?download=true"
readonly CHAT_LICENSE="Apache-2.0"

# Qwen's own GGUF release. multilingual-e5-small was the original choice, but
# no working GGUF conversion of it exists for current llama.cpp: the builds
# either fail to load ("bert model needs to define token type count"), crash on
# quantized token-type tensors, or load but produce a degenerate embedding
# space. deploy/MODELS.md records the measurements.
readonly EMBED_FILE="Qwen3-Embedding-0.6B-Q8_0.gguf"
readonly EMBED_DIR="${MODEL_ROOT}/embeddings"
readonly EMBED_REPO="Qwen/Qwen3-Embedding-0.6B-GGUF"
readonly EMBED_URL="https://huggingface.co/${EMBED_REPO}/resolve/main/${EMBED_FILE}?download=true"
readonly EMBED_LICENSE="Apache-2.0"

# Expected checksums, sourced from server/.env if present.
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/server/.env"
EXPECTED_CHAT="${MODEL_SHA256_QWEN3_4B:-}"
EXPECTED_EMBED="${MODEL_SHA256_EMBEDDING:-}"
if [[ -f "${ENV_FILE}" ]]; then
  EXPECTED_CHAT="${EXPECTED_CHAT:-$(grep -E '^MODEL_SHA256_QWEN3_4B=' "${ENV_FILE}" | cut -d= -f2- | tr -d '"'"'"' ')}"
  EXPECTED_EMBED="${EXPECTED_EMBED:-$(grep -E '^MODEL_SHA256_EMBEDDING=' "${ENV_FILE}" | cut -d= -f2- | tr -d '"'"'"' ')}"
fi

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo)."
command -v curl >/dev/null || die "curl is required."
command -v sha256sum >/dev/null || die "sha256sum is required."

# ── Disk space guard: the chat model is ~2.5 GB ──
AVAIL_KB=$(df -Pk "${MODEL_ROOT%/*}" | awk 'NR==2 {print $4}')
(( AVAIL_KB > 8 * 1024 * 1024 )) || die "Less than 8 GB free on the model volume."

fetch() {
  local name="$1" url="$2" dir="$3" file="$4" expected="$5" license="$6"
  local path="${dir}/${file}"

  mkdir -p "${dir}"

  if [[ -f "${path}" ]]; then
    log "${name}: already present, verifying"
  else
    log "${name}: downloading (licence: ${license})"
    # --continue-at resumes a partial download; the temp name means an aborted
    # transfer can never be mistaken for a complete model.
    curl -fL --retry 3 --retry-delay 5 --continue-at - \
      -o "${path}.part" "${url}"
    mv "${path}.part" "${path}"
  fi

  log "${name}: computing SHA-256 (takes a moment on a 2.5 GB file)"
  local actual
  actual="$(sha256sum "${path}" | awk '{print $1}')"

  if [[ -z "${expected}" ]]; then
    warn "${name}: no expected checksum recorded."
    warn "  Record this value in server/.env and deploy/MODELS.md:"
    printf '      %s\n' "${actual}"
  elif [[ "${expected}" != "${actual}" ]]; then
    die "${name}: CHECKSUM MISMATCH
    expected: ${expected}
    actual:   ${actual}
  The file is corrupt or has been tampered with. Delete it and re-run."
  else
    log "${name}: checksum verified"
  fi

  chown "${SERVICE_USER}:${SERVICE_USER}" "${path}"
  # Read-only: the inference service must never be able to modify its weights.
  chmod 0440 "${path}"
  printf '    %s (%s)\n' "${path}" "$(du -h "${path}" | cut -f1)"
}

fetch "Qwen3-4B-Q4_K_M"        "${CHAT_URL}"  "${CHAT_DIR}"  "${CHAT_FILE}"  "${EXPECTED_CHAT}"  "${CHAT_LICENSE}"
fetch "Qwen3-Embedding-0.6B"   "${EMBED_URL}" "${EMBED_DIR}" "${EMBED_FILE}" "${EXPECTED_EMBED}" "${EMBED_LICENSE}"

cat <<EOF

$(log 'Models ready')

  Chat:      ${CHAT_DIR}/${CHAT_FILE}        (${CHAT_LICENSE}, commercial use permitted)
  Embedding: ${EMBED_DIR}/${EMBED_FILE}      (${EMBED_LICENSE}, commercial use permitted)

Both run entirely on this host. No data is transmitted externally.

Start the services:
  sudo systemctl enable --now atozas-llama atozas-llama-embed

EOF
