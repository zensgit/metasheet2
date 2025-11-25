#!/bin/bash
# Phase 5 archive helper: freeze a completed observation directory.
#
# Usage:
#   ./scripts/phase5-archive.sh results/phase5-20251124-085111
#   ARCHIVE_READONLY=true ./scripts/phase5-archive.sh <dir>
#
set -euo pipefail

SRC_DIR="${1:-}"
if [ -z "$SRC_DIR" ]; then
  echo "Source directory required"; exit 1
fi
if [ ! -d "$SRC_DIR" ]; then
  echo "Directory not found: $SRC_DIR"; exit 1
fi

if [[ ! "$SRC_DIR" =~ phase5- ]]; then
  echo "Warning: directory name does not look like phase5-*" >&2
fi

DATE_TAG=$(date +%Y%m%d-%H%M%S)
DEST="final-artifacts/phase5-prod-$DATE_TAG"
mkdir -p "$DEST"

echo "Archiving $SRC_DIR -> $DEST"
rsync -a "$SRC_DIR/" "$DEST/" >/dev/null 2>&1 || cp -R "$SRC_DIR/." "$DEST/"

pushd "$DEST" >/dev/null
sha256sum * > checksums.txt 2>/dev/null || shasum -a 256 * > checksums.txt 2>/dev/null || echo "sha256 unavailable" > checksums.txt
TOTAL_FILES=$(find . -type f | wc -l | tr -d ' ')
SAMPLES=$(grep -v '^timestamp' metrics.csv 2>/dev/null | wc -l | tr -d ' ' || echo 0)
cat > archive-metadata.json << EOF
{
  "source": "$SRC_DIR",
  "archived_at": "$(date -Iseconds)",
  "samples": $SAMPLES,
  "total_files": $TOTAL_FILES,
  "checksums_file": "checksums.txt"
}
EOF
popd >/dev/null

if [ "${ARCHIVE_READONLY:-false}" = "true" ]; then
  chmod -R a-w "$DEST" || echo "Readonly chmod failed"
fi

echo "Archive complete: $DEST"
echo "Metadata: $DEST/archive-metadata.json"
echo "Checksums: $DEST/checksums.txt"
exit 0
