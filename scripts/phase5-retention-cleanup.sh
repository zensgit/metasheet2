#!/usr/bin/env bash
set -euo pipefail
# Cleanup old nightly JSON artifacts beyond retention window.
# Usage: scripts/phase5-retention-cleanup.sh <nightly_dir> <retain_days=45>

DIR="${1:-results/nightly}"; RETAIN_DAYS="${2:-45}"
[[ -d "$DIR" ]] || { echo "Nightly dir not found: $DIR" >&2; exit 0; }

cutoff_epoch=$(date -u +%s)
cutoff_epoch=$(( cutoff_epoch - RETAIN_DAYS*24*3600 ))
removed=0
while IFS= read -r f; do
  ts=$(stat -f %m "$f" 2>/dev/null || echo 0)
  if (( ts < cutoff_epoch )); then
    rm -f "$f" && ((removed++))
  fi
done < <(find "$DIR" -maxdepth 1 -name 'phase5-*.json' -type f)

echo "[retention] Removed $removed files older than $RETAIN_DAYS days from $DIR"
