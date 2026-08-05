#!/usr/bin/env bash
#
# Runs SearXNG from source, without Docker.
#
# The supported deployment is docker-compose.yml. This exists for machines where
# Docker is not available — notably Windows development boxes, where SearXNG
# cannot run natively at all: its repository contains a path with a ':' in the
# filename, which NTFS forbids, so the working tree cannot even be checked out.
# Under WSL that restriction disappears, and WSL2's loopback forwarding makes a
# service started here reachable from Windows on 127.0.0.1.
#
# No root required: dependencies install into a virtualenv from prebuilt wheels,
# so no compiler and no apt packages are needed.
#
#   ./run-local.sh            # start in the foreground, Ctrl-C to stop
#   PORT=9999 ./run-local.sh  # override the port
#
# Reads the same settings.yml as the container, so the two paths cannot drift.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SEARXNG_SRC_DIR:-$HOME/.local/share/atozas-searxng}"
SECRET_FILE="$HERE/.secret"
PORT="${PORT:-8888}"

# Under WSL, Windows can only reach a service bound to all interfaces; a native
# Linux host should stay on loopback so the instance is not exposed to the LAN.
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  DEFAULT_BIND='0.0.0.0'
else
  DEFAULT_BIND='127.0.0.1'
fi
BIND="${BIND:-$DEFAULT_BIND}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step 'Fetching SearXNG source'
if [[ -d "$SRC_DIR/.git" ]]; then
  git -C "$SRC_DIR" pull --ff-only --quiet
  echo "    updated $SRC_DIR"
else
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --depth 1 --quiet https://github.com/searxng/searxng.git "$SRC_DIR"
  echo "    cloned into $SRC_DIR"
fi

step 'Preparing virtualenv'
VENV="$SRC_DIR/.venv"
PY="$VENV/bin/python3"
if [[ ! -x "$PY" ]]; then
  # Some distributions ship python3-venv without ensurepip. Creating the venv
  # bare and bootstrapping pip by hand avoids needing root to fix that.
  if python3 -m ensurepip --version >/dev/null 2>&1; then
    python3 -m venv "$VENV"
  else
    echo '    ensurepip unavailable; bootstrapping pip manually'
    python3 -m venv --without-pip "$VENV"
    curl -sSf -o "$SRC_DIR/get-pip.py" https://bootstrap.pypa.io/get-pip.py
    "$PY" "$SRC_DIR/get-pip.py" --quiet
    rm -f "$SRC_DIR/get-pip.py"
  fi
fi

# --only-binary is deliberate: it turns a missing wheel into an immediate, clear
# failure instead of a long compile that dies on a missing system header.
"$PY" -m pip install --quiet --only-binary=:all: -r "$SRC_DIR/requirements.txt"
echo "    $("$PY" --version), dependencies present"

step 'Resolving instance secret'
if [[ ! -f "$SECRET_FILE" ]]; then
  # Persisted rather than regenerated per run: the secret keys Flask's session
  # cookie, and a fresh one on every restart invalidates them needlessly.
  "$PY" -c 'import secrets; print(secrets.token_hex(32))' > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "    generated $SECRET_FILE"
else
  echo "    reusing $SECRET_FILE"
fi

step "Starting SearXNG on $BIND:$PORT"
echo "    settings: $HERE/settings.yml"
echo "    verify:   curl -s 'http://127.0.0.1:$PORT/search?q=test&format=json'"
echo "    a 403 there means 'json' is missing from search.formats"
echo

cd "$SRC_DIR"
# These three override the values in settings.yml, which are written for the
# container. searx/settings_defaults.py maps each to its environment name.
export SEARXNG_SETTINGS_PATH="$HERE/settings.yml"
export SEARXNG_SECRET="$(cat "$SECRET_FILE")"
export SEARXNG_BIND_ADDRESS="$BIND"
export SEARXNG_PORT="$PORT"
exec "$PY" -m searx.webapp
