#!/usr/bin/env bash
set -euo pipefail

# Replace staging screenshot placeholders with provided images.
# Supports either 3 explicit file paths or a source directory containing images.
#
# Usage:
#   bash scripts/replace-staging-screenshots.sh <latency.png> <prom.png> <rules.png>
#   bash scripts/replace-staging-screenshots.sh --dir /path/to/images
#
# Destination files (overwritten):
#   docs/sprint2/screenshots/latency-dashboard.png
#   docs/sprint2/screenshots/prom-metrics-panel.png
#   docs/sprint2/screenshots/rule-eval-counters.png

DEST_DIR="docs/sprint2/screenshots"
mkdir -p "$DEST_DIR"

pick_from_dir() {
  local dir="$1"
  # Try best-effort matching by filename tokens
  local lat prom rul
  lat=$(ls -1 "$dir"/* 2>/dev/null | grep -Ei 'latency|dashboard|grafana' | head -n1 || true)
  prom=$(ls -1 "$dir"/* 2>/dev/null | grep -Ei 'prom|metrics' | head -n1 || true)
  rul=$(ls -1 "$dir"/* 2>/dev/null | grep -Ei 'rule|eval|approval' | head -n1 || true)
  echo "$lat|$prom|$rul"
}

validate_img() {
  local f="$1"
  if [[ ! -f "$f" ]]; then echo "❌ File not found: $f" >&2; return 1; fi
  local sz; sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0)
  if [[ "$sz" -lt 4096 ]]; then echo "⚠️  File seems too small (<4KB): $f" >&2; fi
  case "${f,,}" in
    *.png|*.jpg|*.jpeg|*.webp) : ;; 
    *) echo "⚠️  Non-image extension: $f (still copying)" >&2 ;;
  esac
}

copy_image() {
  local src="$1" dest="$2"
  cp -f "$src" "$dest"
  echo "→ $dest (from $(basename "$src"))"
}

main() {
  local lat_src prom_src rul_src

  if [[ ${1:-} == "--dir" ]]; then
    local dir=${2:-}
    if [[ -z "$dir" ]]; then echo "Usage: $0 --dir <folder>" >&2; exit 2; fi
    IFS='|' read -r lat_src prom_src rul_src <<<"$(pick_from_dir "$dir")"
  else
    lat_src=${1:-}; prom_src=${2:-}; rul_src=${3:-}
  fi

  if [[ -z "${lat_src:-}" || -z "${prom_src:-}" || -z "${rul_src:-}" ]]; then
    echo "Usage: $0 <latency.png> <prom.png> <rules.png> | --dir <folder>" >&2
    exit 2
  fi

  echo "[screenshots] Validating sources..."
  validate_img "$lat_src"; validate_img "$prom_src"; validate_img "$rul_src"

  echo "[screenshots] Replacing placeholders..."
  copy_image "$lat_src" "$DEST_DIR/latency-dashboard.png"
  copy_image "$prom_src" "$DEST_DIR/prom-metrics-panel.png"
  copy_image "$rul_src" "$DEST_DIR/rule-eval-counters.png"

  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "[$ts] updated latency-dashboard.png, prom-metrics-panel.png, rule-eval-counters.png" >> "$DEST_DIR/UPDATE_LOG.md"
  echo "[screenshots] Done."
}

main "$@"

