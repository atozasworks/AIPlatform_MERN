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
# The catalogue is not written out here. It comes from the model registry via
# server/scripts/model-manifest.mjs, so adding a model to the application and
# making it downloadable are the same edit. The manifest carries the expected
# SHA-256 too, read from server/.env by the registry itself.
#
# All chat models live in one directory because llama-server runs in router
# mode and is pointed at a single preset file listing every model.
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly CHAT_DIR="${MODEL_ROOT}/chat"
readonly EMBED_DIR="${MODEL_ROOT}/embeddings"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo)."
command -v curl >/dev/null || die "curl is required."
command -v sha256sum >/dev/null || die "sha256sum is required."
command -v node >/dev/null || die "node is required (the catalogue comes from the model registry)."

# ── Disk space guard ──
# One Q4_K_M 4B chat model (~2.4 GB) plus the Q8_0 embedding model (~0.6 GB).
# The threshold leaves headroom for the .part files a resumed download uses.
AVAIL_KB=$(df -Pk "${MODEL_ROOT%/*}" | awk 'NR==2 {print $4}')
(( AVAIL_KB > 6 * 1024 * 1024 )) || die "Less than 6 GB free on the model volume."

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

# Tab-separated so the loop needs no jq: id, role, file, url, licence, sha256.
while IFS=$'\t' read -r id role file url license expected; do
  [[ -n "${id}" ]] || continue
  if [[ "${role}" == "embedding" ]]; then
    dir="${EMBED_DIR}"
  else
    dir="${CHAT_DIR}"
  fi
  fetch "${id}" "${url}" "${dir}" "${file}" "${expected}" "${license}"
done < <(node "${REPO_ROOT}/server/scripts/model-manifest.mjs" --format tsv)

# Rebuild the router preset so llama-server serves exactly what is on disk.
log 'Generating the llama-server router preset'
node "${REPO_ROOT}/server/scripts/generate-llama-preset.mjs" \
  --models-dir "${CHAT_DIR}" \
  --out "${REPO_ROOT}/deploy/llama/models.ini"

cat <<EOF

$(log 'Models ready')

  Chat models:  ${CHAT_DIR}
  Embedding:    ${EMBED_DIR}
  Router preset: ${REPO_ROOT}/deploy/llama/models.ini

Every model runs entirely on this host. No prompt, conversation or document is
transmitted externally. Licences and the exact egress boundary - including what
live web retrieval does and does not send - are recorded in deploy/MODELS.md.

Start the services:
  sudo systemctl enable --now atozas-llama atozas-llama-embed

EOF
