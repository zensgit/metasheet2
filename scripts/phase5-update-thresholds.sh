#!/usr/bin/env bash
set -euo pipefail

# Update Phase 5 thresholds file using SLO suggestions JSON.
# Dry-run by default; use --apply to write changes.
# Usage:
#   scripts/phase5-update-thresholds.sh <suggestions.json> <thresholds.json> [--apply] [--backup]
# Behavior:
#   - Reads existing thresholds file.
#   - For each latency or percentage metric suggestion present, proposes new threshold based on multiplier logic.
#   - Outputs markdown diff summary to stdout.

SUGGESTIONS="${1:-}"; TARGET="${2:-}"; MODE="${3:-dry}"; BACKUP="${4:-}";
[[ -f "$SUGGESTIONS" ]] || { echo "Suggestions file not found: $SUGGESTIONS" >&2; exit 2; }
[[ -f "$TARGET" ]] || { echo "Thresholds file not found: $TARGET" >&2; exit 2; }

have_jq=1; command -v jq >/dev/null 2>&1 || have_jq=0
if [[ $have_jq -eq 0 ]]; then echo "jq required" >&2; exit 2; fi

echo "# Phase 5 Threshold Update (Mode: ${MODE})"
echo "Suggestions: $SUGGESTIONS"
echo "Current thresholds: $TARGET"

# Load suggestions keys (expected schema produced by scripts/phase5-slo-tighten-suggestions.sh)
plugin_p95=$(jq -r '.plugin_reload.p95_suggest // empty' "$SUGGESTIONS")
plugin_p99=$(jq -r '.plugin_reload.p99_suggest // empty' "$SUGGESTIONS")
snap_create_p95=$(jq -r '.snapshot_create.p95_suggest // empty' "$SUGGESTIONS")
snap_create_p99=$(jq -r '.snapshot_create.p99_suggest // empty' "$SUGGESTIONS")
snap_restore_p95=$(jq -r '.snapshot_restore.p95_suggest // empty' "$SUGGESTIONS")
snap_restore_p99=$(jq -r '.snapshot_restore.p99_suggest // empty' "$SUGGESTIONS")
http_success=$(jq -r '.http_success.rate_suggest // empty' "$SUGGESTIONS")
cache_hit=$(jq -r '.cache_hit.rate_suggest // empty' "$SUGGESTIONS")

multiplier_latency=${MULTIPLIER_LATENCY:-1.15}
floor_success=${FLOOR_SUCCESS_RATE:-98.0}
floor_cache=${FLOOR_CACHE_HIT_RATE:-80.0}

tmpfile=$(mktemp)
cp "$TARGET" "$tmpfile"

update_latency() {
  local metric_key="$1" new_source="$2"
  local jq_path=".thresholds[] | select(.metric==\"${metric_key}\").threshold"
  if [[ -n "$new_source" && "$new_source" != "null" ]]; then
    local proposed
    proposed=$(awk -v v="$new_source" -v m="$multiplier_latency" 'BEGIN{printf("%.4f", v*m)}')
    local current
    current=$(jq -r "$jq_path" "$tmpfile" 2>/dev/null || echo '')
    if [[ -n "$current" && "$current" != "null" ]]; then
      echo "- ${metric_key}: baseline=${new_source}s → proposed=${proposed}s (current=${current}s)"
      if [[ "$MODE" == "--apply" ]]; then
        jq "(.thresholds[] | select(.metric==\"${metric_key}\").threshold) |= ${proposed}" "$tmpfile" > "$tmpfile.new" && mv "$tmpfile.new" "$tmpfile"
      fi
    fi
  fi
}

update_rate_floor() {
  local metric_key="$1" new_rate="$2" floor="$3"
  local jq_path=".thresholds[] | select(.metric==\"${metric_key}\").threshold"
  if [[ -n "$new_rate" && "$new_rate" != "null" ]]; then
    local proposed
    # For success/hit rates we propose min(floor, new_rate*0.995) to tighten modestly
    proposed=$(awk -v v="$new_rate" -v f="$floor" 'BEGIN{t=v*0.995; if(t<f) t=f; printf("%.2f", t)}')
    local current
    current=$(jq -r "$jq_path" "$tmpfile" 2>/dev/null || echo '')
    if [[ -n "$current" && "$current" != "null" ]]; then
      echo "- ${metric_key}: observed=${new_rate}% → proposed floor=${proposed}% (current=${current}%)"
      if [[ "$MODE" == "--apply" ]]; then
        jq "(.thresholds[] | select(.metric==\"${metric_key}\").threshold) |= ${proposed}" "$tmpfile" > "$tmpfile.new" && mv "$tmpfile.new" "$tmpfile"
      fi
    fi
  fi
}

echo "## Proposed Changes"
update_latency plugin_reload_latency_p95 "$plugin_p95"
update_latency plugin_reload_latency_p99 "$plugin_p99"
update_latency snapshot_create_latency_p95 "$snap_create_p95"
update_latency snapshot_create_latency_p99 "$snap_create_p99"
update_latency snapshot_restore_latency_p95 "$snap_restore_p95"
update_latency snapshot_restore_latency_p99 "$snap_restore_p99"
update_rate_floor http_success_rate "$http_success" "$floor_success"
update_rate_floor cache_hit_rate "$cache_hit" "$floor_cache"

if [[ "$MODE" == "--apply" ]]; then
  if [[ -n "$BACKUP" ]]; then cp "$TARGET" "$TARGET.bak"; fi
  mv "$tmpfile" "$TARGET"
  echo "\n[apply] Threshold file updated: $TARGET"
else
  rm -f "$tmpfile"
  echo "\n[dry-run] No changes written. Use --apply to persist."
fi

