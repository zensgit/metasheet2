#!/usr/bin/env bash
set -euo pipefail
# Auto-rotate baseline after sustained PASS streak.
# Usage: scripts/phase5-baseline-auto-rotate.sh <nightly_dir> <baseline_symlink> <min_pass_days=14>

NIGHTLY_DIR="${1:-results/nightly}"; BASELINK="${2:-baseline/phase5-baseline.json}"; MIN_DAYS="${3:-14}"

[[ -d "$NIGHTLY_DIR" ]] || { echo "Nightly dir not found: $NIGHTLY_DIR" >&2; exit 0; }

files=( $(ls "$NIGHTLY_DIR"/phase5-*.json 2>/dev/null | sort) )
(( ${#files[@]} == 0 )) && { echo "No nightly JSON files"; exit 0; }

pass_streak=0
for (( i=${#files[@]}-1; i>=0; i-- )); do
  f="${files[$i]}"
  status=$(jq -r '.summary.overall_status // "na"' "$f" 2>/dev/null || echo na)
  if [[ "$status" == "pass" || "$status" == "PASS" ]]; then
    ((pass_streak++))
  else
    break
  fi
done

if (( pass_streak >= MIN_DAYS )); then
  ts=$(date -u '+%Y%m%d-%H%M%S')
  new_base="baseline/phase5-baseline-$ts.json"
  cp "${files[-1]}" "$new_base"
  ln -sfn "$new_base" "$BASELINK"
  echo "Rotated baseline to $new_base (streak=$pass_streak)"
  echo "baseline_rotated=true" >> "${GITHUB_OUTPUT:-/dev/null}" 2>/dev/null || true
else
  echo "PASS streak $pass_streak < $MIN_DAYS; no rotation" 
fi
