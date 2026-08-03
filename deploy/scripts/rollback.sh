#!/usr/bin/env bash
#
# Rolls the application back to the commit that was running before the last
# deploy, then verifies the stack came back healthy.
#
#   bash deploy/scripts/rollback.sh              # previous release
#   bash deploy/scripts/rollback.sh <commit-sha> # a specific commit
#
# Code and configuration only. Restoring the database is a separate, explicit
# step — an automatic restore would silently discard every conversation created
# since the deploy. The command is printed at the end if you need it.

set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RELEASE_DIR=/var/lib/atozas/releases
readonly BACKUP_DIR=/var/lib/atozas/backups

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

cd "${REPO_ROOT}"

TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  [[ -f "${RELEASE_DIR}/previous" ]] || die "No previous release recorded. Pass a commit SHA explicitly."
  TARGET="$(cat "${RELEASE_DIR}/previous")"
fi

git rev-parse --verify "${TARGET}^{commit}" >/dev/null 2>&1 || die "Unknown commit: ${TARGET}"

CURRENT="$(git rev-parse HEAD)"
[[ "${CURRENT}" == "${TARGET}" ]] && { log "Already at ${TARGET:0:7}. Nothing to do."; exit 0; }

log "Rolling back"
printf '    from: %s\n    to:   %s\n' "${CURRENT:0:7}" "${TARGET:0:7}"

# ── 1. Stop admitting new work ──
# Draining first means users see "temporarily unavailable" rather than having
# an answer cut off mid-sentence.
log "Pausing the generation queue"
if curl -sf --max-time 5 http://127.0.0.1:5000/api/health/live >/dev/null 2>&1; then
  redis-cli DEL "atozas:bull:atozas-llm:meta" >/dev/null 2>&1 || true
fi
pm2 stop atozas-worker 2>/dev/null || warn "Worker was not running"

# ── 2. Restore the code ──
log "Checking out ${TARGET:0:7}"
git checkout --force "${TARGET}"

log "Reinstalling server dependencies at that commit"
( cd server && npm ci --omit=dev --no-audit --no-fund )

log "Rebuilding the frontend"
( cd client && npm ci --no-audit --no-fund && npm run build )
rm -rf server/dist
cp -r client/dist server/dist

# ── 3. Restart ──
log "Restarting processes"
pm2 reload deploy/ecosystem.config.cjs --env production --update-env
pm2 save

# ── 4. Verify ──
log "Waiting for the API to report ready"
READY=0
for _ in $(seq 1 30); do
  if curl -sf --max-time 5 http://127.0.0.1:5000/api/health/ready >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2
done

(( READY )) || {
  warn "API did not come back within 60s. Recent logs:"
  pm2 logs atozas-api --lines 40 --nostream || true
  die "Rollback did not restore a healthy state — manual intervention required."
}

echo "${TARGET}" | sudo tee "${RELEASE_DIR}/current" >/dev/null

bash "${REPO_ROOT}/deploy/scripts/healthcheck.sh" || warn "Health check reported issues"

LATEST_BACKUP="$(ls -1t "${BACKUP_DIR}"/mongo-*.gz 2>/dev/null | head -1 || true)"

cat <<EOF

$(log 'Rollback complete')

  now running: ${TARGET:0:7}

If this rollback also requires reverting a database change, restore manually
after confirming you are willing to lose data written since the backup:

  mongorestore --gzip --archive=${LATEST_BACKUP:-<backup.gz>} --drop

Also verify the inference layer is untouched and healthy:
  systemctl status atozas-llama atozas-llama-embed

EOF
