#!/usr/bin/env bash
set -euo pipefail

# Aggregate last N phase5 validation JSON summaries into a weekly markdown trend.
# Usage: scripts/phase5-weekly-trend.sh <directory-with-jsons> <out-md> [limit]
# Example: scripts/phase5-weekly-trend.sh results/nightly claudedocs/PHASE5_WEEKLY_TREND.md 7

SRC_DIR="${1:-results/nightly}"
OUT_MD="${2:-claudedocs/PHASE5_WEEKLY_TREND.md}"
LIMIT="${3:-7}"

command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Source dir not found: $SRC_DIR" >&2
  exit 1
fi

FILES=( $(ls -1t "$SRC_DIR"/phase5-*.json 2>/dev/null | head -n "$LIMIT") )
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No phase5 JSON files in $SRC_DIR" >&2
  exit 1
fi

TMP=$(mktemp)
{
  echo "# Phase 5 Weekly Trend"
  echo "Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo "Source directory: $SRC_DIR"
  echo
  echo "| Date | Passed | Failed | NA | Status | Cache Hit % | HTTP Success % | Create p95 | Restore p95 | Plugin p95 | Redis GET p95 | Redis SET p95 | RedisFail(15m) | Memory MB |"
  echo "|------|--------|--------|----|--------|-------------|---------------|-----------|------------|----------|-------------|-------------|----------------|-----------|"
  for f in "${FILES[@]}"; do
    date_str=$(jq -r '.generated_at // .timestamp // empty' "$f")
    [[ -z "$date_str" ]] && date_str=$(date -r "$f" '+%Y-%m-%d %H:%M')
    pass=$(jq -r '.summary.passed' "$f")
    fail=$(jq -r '.summary.failed' "$f")
    na=$(jq -r '.summary.na' "$f")
    status=$(jq -r '.summary.overall_status' "$f")
    cache_hit=$(jq -r '.counters.cache_hit_rate // empty' "$f")
    http_succ=$(jq -r '.counters.http_success_rate // empty' "$f")
    create_p95=$(jq -r '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p95 // empty' "$f")
    restore_p95=$(jq -r '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p95 // empty' "$f")
    plugin_p95=$(jq -r '.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p95 // empty' "$f")
    redis_get_p95=$(jq -r '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p95 // empty' "$f")
    redis_set_p95=$(jq -r '.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p95 // empty' "$f")
    redis_recent_fail=$(jq -r '.counters.redis_recent_failures // empty' "$f")
    mem=$(jq -r '.counters.memory_rss_mb // empty' "$f")
    echo "| $date_str | $pass | $fail | $na | $status | ${cache_hit:-} | ${http_succ:-} | ${create_p95:-} | ${restore_p95:-} | ${plugin_p95:-} | ${redis_get_p95:-} | ${redis_set_p95:-} | ${redis_recent_fail:-} | ${mem:-} |"
  done
} > "$TMP"

mv "$TMP" "$OUT_MD"
echo "[weekly-trend] Written $OUT_MD with ${#FILES[@]} entries"
