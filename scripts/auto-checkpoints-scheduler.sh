#!/usr/bin/env bash
set -euo pipefail

# Auto scheduler for Sprint 2 checkpoints and smoke test
# - 12:00, 18:00, 22:00 -> run 48h checkpoint and save log
# - 21:50 -> run local smoke and save JSON
#
# Stop: kill "$(cat /tmp/sprint2_checkpoint_sched.pid)"; rm -f /tmp/sprint2_checkpoint_sched.pid

CHECKPOINT_SCRIPT="scripts/48h-checkpoint.sh"
SMOKE_SCRIPT="scripts/staging-latency-smoke.sh"
CHECKPOINT_DIR="docs/sprint2/checkpoints"
PERF_DIR="docs/sprint2/performance"
PID_FILE="/tmp/sprint2_checkpoint_sched.pid"
LOG_FILE="/tmp/sprint2_checkpoint_sched.log"

# Times in HH:MM (24h) local time; override by env if needed
TIME_CHECKPOINT_1=${TIME_CHECKPOINT_1:-"12:00"}
TIME_CHECKPOINT_2=${TIME_CHECKPOINT_2:-"18:00"}
TIME_CHECKPOINT_3=${TIME_CHECKPOINT_3:-"22:00"}
TIME_SMOKE=${TIME_SMOKE:-"21:50"}

mkdir -p "$CHECKPOINT_DIR" "$PERF_DIR"

echo "[Scheduler] Starting with times: $TIME_CHECKPOINT_1, $TIME_CHECKPOINT_2, $TIME_CHECKPOINT_3; smoke at $TIME_SMOKE" >&2

run_checkpoint() {
  ts=$(date +%H%M)
  echo "[Scheduler] Running checkpoint at $(date '+%F %T')" >&2
  if command -v bash >/dev/null 2>&1; then
    bash "$CHECKPOINT_SCRIPT" | tee "$CHECKPOINT_DIR/48h-$ts.log" >/dev/null
  else
    echo "[WARN] bash not found" | tee "$CHECKPOINT_DIR/48h-$ts.log" >/dev/null
  fi
}

gen_local_admin_jwt() {
  # Try to read JWT_SECRET from local .env; fallback to dev-secret-key
  local env_secret
  env_secret=$(grep -E '^JWT_SECRET=' packages/core-backend/.env 2>/dev/null | sed 's/^JWT_SECRET=//') || true
  [ -z "$env_secret" ] && env_secret="dev-secret-key"
  if command -v node >/dev/null 2>&1; then
    node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:'auto-scheduler',roles:['admin']}, process.argv[1], {expiresIn:'1h'}))" "$env_secret"
  else
    echo ""  # no node -> return empty
  fi
}

run_smoke() {
  echo "[Scheduler] Running smoke at $(date '+%F %T')" >&2
  local token
  token=$(gen_local_admin_jwt)
  if [ -z "$token" ]; then
    echo "[Scheduler] Skip smoke: node not available for JWT generation" >&2
    return 0
  fi
  local out="${PERF_DIR}/smoke-$(date +%H%M).json"
  SMOKE_JSON_OUT="$out" bash "$SMOKE_SCRIPT" "$token" "http://localhost:8900" >/dev/null || true
  echo "[Scheduler] Smoke saved: $out" >&2
}

# Prevent duplicate schedulers
if [ -f "$PID_FILE" ] && ps -p "$(cat "$PID_FILE" 2>/dev/null || echo 0)" >/dev/null 2>&1; then
  echo "[Scheduler] Already running with PID $(cat "$PID_FILE")" >&2
  exit 0
fi

echo $$ > "$PID_FILE"

last_fired=""
while true; do
  now=$(date +%H:%M)
  key="$now"
  if [ "$now" = "$TIME_SMOKE" ]; then
    if [ "$last_fired" != "smoke-$now" ]; then
      run_smoke
      last_fired="smoke-$now"
    fi
    sleep 65; continue
  fi
  if [ "$now" = "$TIME_CHECKPOINT_1" ] || [ "$now" = "$TIME_CHECKPOINT_2" ] || [ "$now" = "$TIME_CHECKPOINT_3" ]; then
    if [ "$last_fired" != "cp-$now" ]; then
      run_checkpoint
      last_fired="cp-$now"
    fi
    sleep 65; continue
  fi
  sleep 10
done

