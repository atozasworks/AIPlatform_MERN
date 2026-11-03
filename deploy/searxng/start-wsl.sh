#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/share/atozas-searxng"
LOG="${INSTALL_DIR}/searxng.log"
PIDFILE="${INSTALL_DIR}/searxng.pid"

if [[ -f "${PIDFILE}" ]]; then
  old_pid="$(cat "${PIDFILE}" || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "already running pid=${old_pid}"
    exit 0
  fi
fi

# Match only our managed process, never system PIDs.
if pgrep -f "${INSTALL_DIR}/venv/bin/python -m searx.webapp" >/dev/null 2>&1; then
  echo "already running"
  exit 0
fi

nohup "${INSTALL_DIR}/run.sh" >"${LOG}" 2>&1 &
echo $! >"${PIDFILE}"
echo "started pid=$(cat "${PIDFILE}") log=${LOG}"
