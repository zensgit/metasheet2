#!/usr/bin/env bash
set -euo pipefail

# Self-healing watchdog for staging watcher.
# Checks if watcher PID exists; if not, restarts it.
# Intended to be run via cron or a simple loop.

ISSUE_ID=${1:-5}
INTERVAL=${INTERVAL:-300} # seconds between checks (default 5m)

restart() {
  echo "[watchdog] restarting watcher for issue $ISSUE_ID" >&2
  POLL_INTERVAL=60 bash scripts/watch-staging-token-and-validate.sh "$ISSUE_ID" >/tmp/staging_watch.log 2>&1 &
  echo $! > /tmp/staging_watch.pid
  echo "[watchdog] new watcher PID $(cat /tmp/staging_watch.pid)" >&2
}

check_once() {
  if [ ! -f /tmp/staging_watch.pid ]; then
    echo "[watchdog] no PID file" >&2; restart; return
  fi
  PID=$(cat /tmp/staging_watch.pid)
  if ! ps -p "$PID" >/dev/null 2>&1; then
    echo "[watchdog] dead PID $PID" >&2; restart; return
  fi
  echo "[watchdog] alive PID $PID" >&2
}

if [ "${RUN_ONCE:-false}" = true ]; then
  check_once
  exit 0
fi

echo "[watchdog] starting loop (interval=$INTERVAL s)" >&2
while true; do
  check_once
  sleep "$INTERVAL"
done

