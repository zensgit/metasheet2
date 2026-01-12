#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

KEEP="${KEEP:-5}"
ARCHIVE_DIR="${ARCHIVE_DIR:-docs/archive/verification}"
ARCHIVE_INDEX_FILE="${ARCHIVE_INDEX_FILE:-$ARCHIVE_DIR/index.md}"
INCLUDE_SMOKE_PNG="${INCLUDE_SMOKE_PNG:-false}"
SMOKE_ARCHIVE_DIR="${SMOKE_ARCHIVE_DIR:-artifacts/archive/smoke}"

mkdir -p "$ARCHIVE_DIR"

if [[ ! -f "$ARCHIVE_INDEX_FILE" ]]; then
  cat > "$ARCHIVE_INDEX_FILE" <<'EOF'
# Verification Archive Index

This index is appended by scripts/archive-plm-ui-reports.sh.
EOF
fi

archive_pattern() {
  local pattern="$1"
  local dest_dir="$2"
  local label="$3"

  shopt -s nullglob
  local files=( $pattern )
  shopt -u nullglob

  if (( ${#files[@]} == 0 )); then
    return
  fi

  mapfile -t sorted < <(printf '%s\n' "${files[@]}" | sort -r)
  local keep=("${sorted[@]:0:$KEEP}")
  local archive=("${sorted[@]:$KEEP}")

  if (( ${#archive[@]} == 0 )); then
    return
  fi

  mkdir -p "$dest_dir"

  for file in "${archive[@]}"; do
    mv "$file" "$dest_dir/"
  done

  {
    echo ""
    echo "## $(date '+%Y-%m-%d %H:%M:%S') - ${label}"
    for file in "${archive[@]}"; do
      echo "- $file"
    done
  } >> "$ARCHIVE_INDEX_FILE"
}

archive_pattern "docs/verification-plm-ui-regression-*.md" "$ARCHIVE_DIR" "PLM UI regression reports"
archive_pattern "docs/verification-plm-ui-full-*.md" "$ARCHIVE_DIR" "PLM UI full regression reports"

if [[ "$INCLUDE_SMOKE_PNG" == "true" ]]; then
  archive_pattern "artifacts/smoke/plm-ui-regression-*.png" "$SMOKE_ARCHIVE_DIR" "PLM UI regression screenshots"
fi

echo "Archive complete."
echo "- Reports archived to: $ARCHIVE_DIR"
if [[ "$INCLUDE_SMOKE_PNG" == "true" ]]; then
  echo "- Screenshots archived to: $SMOKE_ARCHIVE_DIR"
fi
echo "- Index: $ARCHIVE_INDEX_FILE"
