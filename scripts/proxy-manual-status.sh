#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${PROJECT_DIR}/runtime/proxy-telegram.pid"
LOG_FILE="${PROJECT_DIR}/runtime/proxy-telegram.log"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "Estado: detenido (sin PID file)"
  exit 0
fi

PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
if [[ -z "${PID}" ]]; then
  echo "Estado: detenido (PID file vacío)"
  exit 0
fi

if kill -0 "${PID}" 2>/dev/null; then
  echo "Estado: activo (PID ${PID})"
  echo "Log: ${LOG_FILE}"
  tail -n 12 "${LOG_FILE}" || true
  exit 0
fi

echo "Estado: caído (PID ${PID} no existe)"
exit 1
