#!/usr/bin/env bash
set -euo pipefail

WORKDIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
DEST="$WORKDIR/docs/sprint2/fallback-evidence"
mkdir -p "$DEST"
cp -a "$WORKDIR/docs/sprint2/evidence" "$DEST/" 2>/dev/null || true
cp -a "$WORKDIR/docs/sprint2/performance" "$DEST/" 2>/dev/null || true
echo "Collected fallback evidence into $DEST"
