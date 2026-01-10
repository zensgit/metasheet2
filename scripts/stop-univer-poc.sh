#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="${OUTPUT_DIR:-artifacts/univer-poc}"
BACKEND_PID_FILE="${BACKEND_PID_FILE:-$OUTPUT_DIR/backend.pid}"
WEB_PID_FILE="${WEB_PID_FILE:-$OUTPUT_DIR/web.pid}"

stop_pid() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
}

stop_pid "$WEB_PID_FILE"
stop_pid "$BACKEND_PID_FILE"

echo "MetaSheet POC stopped."
