#!/usr/bin/env bash
set -euo pipefail

# Save current Phase 5 validation JSON as baseline
# Usage:
#   scripts/phase5-save-baseline.sh [/path/to/current.json] [baseline_dir]
# Defaults:
#   current.json: /tmp/phase5.json
#   baseline_dir: baseline/

CUR_JSON="${1:-/tmp/phase5.json}"
BASE_DIR="${2:-baseline}"

if [[ ! -f "$CUR_JSON" ]]; then
  echo "[baseline] Current JSON not found: $CUR_JSON" >&2
  exit 1
fi

mkdir -p "$BASE_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
DEST="$BASE_DIR/phase5-baseline-$STAMP.json"
cp -f "$CUR_JSON" "$DEST"
ln -sfn "$(basename "$DEST")" "$BASE_DIR/phase5-baseline.json"

echo "[baseline] Saved baseline: $DEST"
echo "[baseline] Symlink updated: $BASE_DIR/phase5-baseline.json -> $(basename "$DEST")"

