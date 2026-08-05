#!/usr/bin/env bash
# Install a loopback-only SearXNG for local ATOZAS development when Docker
# is not available. Mirrors the settings used by docker-compose.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${HOME}/.local/share/atozas-searxng"
SRC_DIR="${INSTALL_DIR}/src"
VENV_DIR="${INSTALL_DIR}/venv"
SETTINGS_DIR="${INSTALL_DIR}/etc"
SETTINGS_PATH="${SETTINGS_DIR}/settings.yml"
SECRET_PATH="${SETTINGS_DIR}/secret"
export PATH="${HOME}/.local/bin:${PATH}"

echo "==> Install dir: ${INSTALL_DIR}"
mkdir -p "${SRC_DIR}" "${SETTINGS_DIR}"

if ! command -v uv >/dev/null 2>&1; then
  echo "==> Installing uv (managed Python, no sudo)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

# Distro python3-venv often needs sudo; uv's CPython does not.
if [[ ! -x "${HOME}/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12" ]]; then
  echo "==> Installing CPython 3.12 via uv"
  uv python install 3.12
fi
PYTHON_BIN="$(uv python find 3.12)"

if [[ ! -d "${SRC_DIR}/.git" ]]; then
  echo "==> Cloning SearXNG"
  git clone --depth 1 "https://github.com/searxng/searxng.git" "${SRC_DIR}"
else
  echo "==> Updating SearXNG"
  git -C "${SRC_DIR}" pull --ff-only || true
fi

if [[ ! -f "${VENV_DIR}/bin/activate" ]]; then
  echo "==> Creating venv with ${PYTHON_BIN}"
  # Remove a half-created venv left by a previous ensurepip failure.
  rm -rf "${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

echo "==> Installing Python dependencies"
python -m pip install -U pip setuptools wheel
python -m pip install -U pyyaml msgspec typing-extensions pybind11
python -m pip install --use-pep517 --no-build-isolation -e "${SRC_DIR}"

if [[ ! -f "${SECRET_PATH}" ]]; then
  python - <<'PY' > "${SECRET_PATH}"
import secrets
print(secrets.token_hex(32))
PY
fi
SECRET="$(tr -d '\n' < "${SECRET_PATH}")"

echo "==> Writing settings.yml"
# Start from the repo's ATOZAS settings, then pin bind/port/secret for local use.
cp "${ROOT}/settings.yml" "${SETTINGS_PATH}"
python - <<PY
from pathlib import Path
path = Path("${SETTINGS_PATH}")
text = path.read_text(encoding="utf-8")
# Ensure secret and loopback bind for the non-Docker run.
replacements = {
    "secret_key: 'change-me-see-dotenv'": "secret_key: '${SECRET}'",
    "bind_address: '0.0.0.0'": "bind_address: '127.0.0.1'",
    "port: 8080": "port: 8888",
}
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f"settings.yml missing expected line: {old}")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("settings ready")
PY

cat > "${INSTALL_DIR}/run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "${VENV_DIR}/bin/activate"
export SEARXNG_SETTINGS_PATH="${SETTINGS_PATH}"
cd "${SRC_DIR}"
exec python -m searx.webapp
EOF
chmod +x "${INSTALL_DIR}/run.sh"

echo "==> Done. Start with: ${INSTALL_DIR}/run.sh"
echo "    JSON search: http://127.0.0.1:8888/search?q=test&format=json"
