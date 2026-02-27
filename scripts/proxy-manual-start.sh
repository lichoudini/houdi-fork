#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${PROJECT_DIR}/runtime/proxy-telegram.pid"
LOG_FILE="${PROJECT_DIR}/runtime/proxy-telegram.log"

mkdir -p "${PROJECT_DIR}/runtime"

if [[ -f "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "Proxy ya está corriendo con PID ${OLD_PID}."
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

echo "[manual-start] Compilando..."
(cd "${PROJECT_DIR}" && npm run build >/dev/null)

echo "[manual-start] Iniciando bot en background..."
nohup "${PROJECT_DIR}/scripts/start-houdi-agent.sh" >>"${LOG_FILE}" 2>&1 &
NEW_PID="$!"
echo "${NEW_PID}" >"${PID_FILE}"

sleep 1
if ! kill -0 "${NEW_PID}" 2>/dev/null; then
  echo "No pude iniciar el proxy. Revisá log: ${LOG_FILE}" >&2
  exit 1
fi

echo "Proxy iniciado (PID ${NEW_PID})."
echo "Log: ${LOG_FILE}"
tail -n 12 "${LOG_FILE}" || true
