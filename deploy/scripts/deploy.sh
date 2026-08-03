#!/usr/bin/env bash
#
# Deploys ATOZAS AI to the Hostinger VPS.
#
#   bash deploy/scripts/deploy.sh
#
# Records a release marker first, so rollback.sh can return to the exact commit
# and dependency tree that was running before this deploy.
#
# Assumes install-llamacpp.sh and fetch-models.sh have already been run.

set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RELEASE_DIR=/var/lib/atozas/releases
readonly BACKUP_DIR=/var/lib/atozas/backups
readonly STAMP="$(date +%Y%m%d-%H%M%S)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

cd "${REPO_ROOT}"

command -v pm2 >/dev/null || die "pm2 is not installed: npm i -g pm2"
[[ -f server/.env ]] || die "server/.env is missing. Copy server/.env.example and fill it in."

sudo mkdir -p "${RELEASE_DIR}" "${BACKUP_DIR}" /var/log/atozas
sudo chown -R "$(id -u):$(id -g)" /var/log/atozas

# ── 1. Record the currently-deployed state for rollback ──
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
log "Current commit: ${PREVIOUS_COMMIT}"
echo "${PREVIOUS_COMMIT}" | sudo tee "${RELEASE_DIR}/previous" >/dev/null

# ── 2. Back up the database before any schema-affecting change ──
if command -v mongodump >/dev/null 2>&1; then
  log "Backing up MongoDB"
  MONGO_URI="$(grep -E '^MONGO_URI=' server/.env | cut -d= -f2-)"
  mongodump --uri="${MONGO_URI}" --gzip --archive="${BACKUP_DIR}/mongo-${STAMP}.gz" \
    || warn "mongodump failed; continuing without a database backup"
  # Keep the last 7 archives; older ones are just disk pressure.
  ls -1t "${BACKUP_DIR}"/mongo-*.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
else
  warn "mongodump not installed — skipping database backup"
fi

# ── 3. Pull and install ──
log "Fetching latest code"
git fetch --all --prune
git pull --ff-only

log "Installing server dependencies"
( cd server && npm ci --omit=dev --no-audit --no-fund )

log "Building the frontend"
( cd client && npm ci --no-audit --no-fund && npm run build )

# The API serves the SPA from server/dist.
log "Publishing the built frontend"
rm -rf server/dist
cp -r client/dist server/dist

# ── 4. Verify the inference layer before cutting traffic over ──
log "Checking inference services"
systemctl is-active --quiet atozas-llama || die "atozas-llama is not running. Start it before deploying."
curl -sf --max-time 10 http://127.0.0.1:8081/health >/dev/null \
  || die "llama-server is not healthy on 8081. Aborting deploy."

if ! curl -sf --max-time 10 http://127.0.0.1:8082/health >/dev/null; then
  warn "Embedding server is down — retrieval will run keyword-only until it returns."
fi

# ── 5. Reload the application ──
# Pause the queue first so no job is picked up mid-restart and left orphaned.
log "Pausing the generation queue"
redis-cli -n 0 SET "atozas:deploy:pausing" 1 EX 120 >/dev/null 2>&1 || true

log "Reloading PM2 processes"
if pm2 describe atozas-api >/dev/null 2>&1; then
  # reload = zero-downtime for the cluster-mode API.
  pm2 reload deploy/ecosystem.config.cjs --env production --update-env
else
  pm2 start deploy/ecosystem.config.cjs --env production
fi
pm2 save

# ── 6. Post-deploy verification ──
log "Waiting for the API to report ready"
READY=0
for _ in $(seq 1 30); do
  if curl -sf --max-time 5 http://127.0.0.1:5000/api/health/ready >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2
done

(( READY )) || {
  warn "API did not become ready within 60s. Recent logs:"
  pm2 logs atozas-api --lines 40 --nostream || true
  die "Deploy verification failed. Run deploy/scripts/rollback.sh"
}

# Guard against the failure mode that silently multiplies GPU/CPU load.
WORKERS="$(pm2 jlist | jq -r '[.[] | select(.name=="atozas-worker")] | length')"
(( WORKERS == 1 )) || die "atozas-worker has ${WORKERS} instances — must be exactly 1. Fix ecosystem.config.cjs."

echo "${STAMP} ${PREVIOUS_COMMIT} -> $(git rev-parse HEAD)" | sudo tee -a "${RELEASE_DIR}/history" >/dev/null

log "Running the full health check"
bash "${REPO_ROOT}/deploy/scripts/healthcheck.sh" || warn "Health check reported issues (see above)"

cat <<EOF

$(log 'Deploy complete')

  commit:   $(git rev-parse --short HEAD)
  previous: ${PREVIOUS_COMMIT:0:7}
  rollback: bash ${REPO_ROOT}/deploy/scripts/rollback.sh

EOF
