#!/usr/bin/env bash
set -euo pipefail
# Generate HTTP 500 responses to test success rate burn rate panels & alerts.
# Usage: PORT=8901 scripts/phase5-simulate-http-errors.sh <count=50> <interval_ms=200>

COUNT="${1:-50}"; INTERVAL="${2:-200}"; PORT="${PORT:-8901}"
echo "[simulate] Generating $COUNT error requests against /api/sim-error (must exist)"
for ((i=0;i<COUNT;i++)); do
  curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$PORT/api/sim-error" || true
  sleep $(awk -v ms="$INTERVAL" 'BEGIN{print ms/1000}')
done
echo "[simulate] Done"
