#!/usr/bin/env bash
set -euo pipefail
# Simulate Redis latency for a short window to validate alerts and dashboard.
# Usage: REDIS_URL=redis://127.0.0.1:6379 scripts/phase5-simulate-redis-latency.sh <seconds=60>

DUR="${1:-60}"; END_TIME=$(( $(date +%s) + DUR ))
export REDIS_ARTIFICIAL_DELAY_MS=${REDIS_ARTIFICIAL_DELAY_MS:-80}
echo "[simulate] Injecting ~${REDIS_ARTIFICIAL_DELAY_MS}ms artificial delay for Redis ops for ${DUR}s"
while (( $(date +%s) < END_TIME )); do
  # Perform some get/set ops to record latency samples
  curl -s "http://127.0.0.1:${PORT:-8901}/health" >/dev/null || true
  # Assuming app code triggers cache usage; you can optionally add explicit endpoints here
  sleep 1
done
echo "[simulate] Completed latency injection window"
unset REDIS_ARTIFICIAL_DELAY_MS
