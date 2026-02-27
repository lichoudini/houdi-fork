#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${PROJECT_DIR}/runtime/proxy-telegram.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "No hay PID file. Intento matar proceso por patrón..."
  pkill -f "${PROJECT_DIR}/dist/index.js" >/dev/null 2>&1 || true
  exit 0
fi

PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
if [[ -z "${PID}" ]]; then
  rm -f "${PID_FILE}"
  echo "PID file vacío. Nada para detener."
  exit 0
fi

if kill -0 "${PID}" 2>/dev/null; then
  kill "${PID}" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "${PID}" 2>/dev/null; then
    kill -9 "${PID}" >/dev/null 2>&1 || true
  fi
  echo "Proxy detenido (PID ${PID})."
else
  echo "El PID ${PID} ya no estaba activo."
fi

rm -f "${PID_FILE}"
