#!/usr/bin/env bash
set -euo pipefail

# Self-test for watcher & watchdog processes.
# Outputs JSON with pid, running (bool), escalation_level (best-effort), uptime_seconds.

WATCH_LOG=${WATCH_LOG:-/tmp/staging_watch.log}
PID_FILE=${PID_FILE:-/tmp/staging_watch.pid}

pid=""
if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
fi

running=false
if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
  running=true
fi

# Derive escalation level by counting key phrases in log
escalation=0
if [[ -f "$WATCH_LOG" ]]; then
  escalation=$(grep -Ec 'Escalation threshold|Final escalation|48h threshold|30h' "$WATCH_LOG" || true)
fi

uptime=0
if $running; then
  start_ts=$(ps -o lstart= -p "$pid" 2>/dev/null || true)
  if [[ -n "$start_ts" ]]; then
    # Convert start time to epoch
    epoch=$(date -j -f "%c" "$start_ts" +%s 2>/dev/null || date -d "$start_ts" +%s 2>/dev/null || echo 0)
    now=$(date +%s)
    uptime=$((now - epoch))
  fi
fi

printf '{"pid":"%s","running":%s,"escalation_events":%s,"uptime_seconds":%s}\n' "$pid" "$running" "$escalation" "$uptime"

