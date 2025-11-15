#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
PORT="${PORT:-8900}"

echo "[otel-smoke] Building telemetry plugin..."
cd "$ROOT_DIR"
pnpm -F @metasheet/plugin-telemetry-otel run build

echo "[otel-smoke] Starting core-backend with FEATURE_OTEL=true (PORT=$PORT) ..."
FEATURE_OTEL=true PORT="$PORT" pnpm -F @metasheet/core-backend dev > "$ROOT_DIR/server-otel.log" 2>&1 &
PID=$!
echo "$PID" > "$ROOT_DIR/core-otel.pid"

trap 'echo "[otel-smoke] Cleaning up..."; kill "$PID" >/dev/null 2>&1 || true; exit 0' INT TERM EXIT

echo "[otel-smoke] Waiting for /health ..."
for i in {1..60}; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" || true)
  if [ "$code" = "200" ]; then
    echo "[otel-smoke] Health OK"
    break
  fi
  sleep 1
done

if [ "${code:-}" != "200" ]; then
  echo "[otel-smoke] ERROR: server not healthy" >&2
  tail -n 120 "$ROOT_DIR/server-otel.log" || true
  exit 1
fi

echo "[otel-smoke] Probing metrics endpoints ..."
M1_CODE=$(curl -s -o /tmp/metrics_plain.txt -w "%{http_code}" "http://localhost:${PORT}/metrics" || true)
M2_CODE=$(curl -s -o /tmp/metrics_otel.txt -w "%{http_code}" "http://localhost:${PORT}/metrics/otel" || true)

M1_PREVIEW=$(head -n 3 /tmp/metrics_plain.txt | tr '\n' ' ' | sed 's/\r//g' || true)
M2_PREVIEW=$(head -n 3 /tmp/metrics_otel.txt | tr '\n' ' ' | sed 's/\r//g' || true)

HAS_HELP1=$(grep -c '^# HELP' /tmp/metrics_plain.txt || true)
HAS_HELP2=$(grep -c '^# HELP' /tmp/metrics_otel.txt || true)

echo "{\n  \"port\": $PORT,\n  \"metrics\": {\n    \"/metrics\": { \"status\": \"$M1_CODE\", \"hasHelp\": $HAS_HELP1, \"preview\": \"$M1_PREVIEW\" },\n    \"/metrics/otel\": { \"status\": \"$M2_CODE\", \"hasHelp\": $HAS_HELP2, \"preview\": \"$M2_PREVIEW\" }\n  }\n}" | sed 's/  \+/  /g'

exit 0

