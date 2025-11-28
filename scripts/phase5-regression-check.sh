#!/usr/bin/env bash
set -euo pipefail

# Compare a new validation JSON against a saved baseline JSON
# Usage:
#   scripts/phase5-regression-check.sh <baseline.json> <current.json>
#
# Signals regression if certain deltas exceed thresholds (tunable via env):
#   LATENCY_INCREASE_PCT=20   # p95/p99 increase >20%
#   RATE_DROP_PCT=5           # success/cache hit drop >5%
#   MEMORY_INCREASE_PCT=25    # memory RSS increase >25%

BASELINE_INPUT="${1:-}"
CURRENT="${2:-}"

# Dual baseline support (memory vs redis)
impl=${CACHE_IMPL:-memory}
if [[ -z "$BASELINE_INPUT" ]]; then echo "Baseline path required" >&2; exit 2; fi
if [[ -d "$BASELINE_INPUT" ]]; then
  # If directory provided, resolve baseline file by impl naming convention
  if [[ -f "$BASELINE_INPUT/phase5-baseline-${impl}.json" ]]; then
    BASELINE="$BASELINE_INPUT/phase5-baseline-${impl}.json"
  else
    BASELINE="$BASELINE_INPUT/phase5-baseline.json"
  fi
else
  BASELINE="$BASELINE_INPUT"
fi
CURRENT="$CURRENT"

LATENCY_INCREASE_PCT=${LATENCY_INCREASE_PCT:-20}
RATE_DROP_PCT=${RATE_DROP_PCT:-5}
MEMORY_INCREASE_PCT=${MEMORY_INCREASE_PCT:-25}

# Absolute thresholds (seconds) for Redis operations
REDIS_GET_P95_MAX=${REDIS_GET_P95_MAX:-0.05}
REDIS_GET_P99_MAX=${REDIS_GET_P99_MAX:-0.10}
REDIS_SET_P95_MAX=${REDIS_SET_P95_MAX:-0.05}
REDIS_SET_P99_MAX=${REDIS_SET_P99_MAX:-0.10}

if [[ -z "$BASELINE" || -z "$CURRENT" ]]; then
  echo "Usage: $0 <baseline.json> <current.json>" >&2
  exit 2
fi
for f in "$BASELINE" "$CURRENT"; do
  [[ -f "$f" ]] || { echo "Missing file: $f" >&2; exit 2; }
done

have_jq=1; command -v jq >/dev/null 2>&1 || have_jq=0
if [[ $have_jq -eq 0 ]]; then
  echo "jq is required" >&2
  exit 2
fi

read_metric() {
  local file="$1" key="$2"; shift 2 || true
  jq -r "$key // empty" "$file"
}

regress=0
report()
{
  echo "[regression] $*"
}

percent_increase() {
  local from="$1" to="$2"
  if [[ "$from" == "0" ]]; then echo 0; return; fi
  awk -v f="$from" -v t="$to" 'BEGIN{ printf("%.2f", ((t-f)/f)*100) }'
}

percent_drop() {
  local from="$1" to="$2"
  if [[ "$from" == "0" ]]; then echo 0; return; fi
  awk -v f="$from" -v t="$to" 'BEGIN{ printf("%.2f", ((f-t)/f)*100) }'
}

compare_latency_abs() {
  local label="$1" path="$2" max="$3"
  local v
  v=$(read_metric "$CURRENT" "$path")
  if [[ -z "$v" ]]; then return; fi
  # numeric compare using awk
  if awk -v x="$v" -v th="$max" 'BEGIN{exit !(x>th)}'; then
    report "❌ ${label} absolute threshold: ${v}s > ${max}s"
    regress=1
  else
    report "✅ ${label} within threshold: ${v}s ≤ ${max}s"
  fi
}

compare_latency() {
  local label="$1" path="$2"
  local b c inc
  b=$(read_metric "$BASELINE" "$path")
  c=$(read_metric "$CURRENT" "$path")
  if [[ -z "$b" || -z "$c" ]]; then return; fi
  inc=$(percent_increase "$b" "$c")
  if awk -v x="$inc" -v th="$LATENCY_INCREASE_PCT" 'BEGIN{exit !(x>th)}'; then
    report "❌ ${label} regression: baseline=${b}s current=${c}s (+${inc}%) > ${LATENCY_INCREASE_PCT}%"
    regress=1
  else
    report "✅ ${label} OK: baseline=${b}s current=${c}s (+${inc}%)"
  fi
}

compare_rate_drop() {
  local label="$1" path="$2" unit="$3"
  local b c drop
  b=$(read_metric "$BASELINE" "$path")
  c=$(read_metric "$CURRENT" "$path")
  if [[ -z "$b" || -z "$c" ]]; then return; fi
  drop=$(percent_drop "$b" "$c")
  if awk -v x="$drop" -v th="$RATE_DROP_PCT" 'BEGIN{exit !(x>th)}'; then
    report "❌ ${label} regression: baseline=${b}${unit} current=${c}${unit} (-${drop}pp) > ${RATE_DROP_PCT}pp"
    regress=1
  else
    report "✅ ${label} OK: baseline=${b}${unit} current=${c}${unit} (-${drop}pp)"
  fi
}

compare_memory() {
  local b c inc
  b=$(read_metric "$BASELINE" '.counters.memory_rss_mb')
  c=$(read_metric "$CURRENT" '.counters.memory_rss_mb')
  if [[ -z "$b" || -z "$c" ]]; then return; fi
  inc=$(percent_increase "$b" "$c")
  if awk -v x="$inc" -v th="$MEMORY_INCREASE_PCT" 'BEGIN{exit !(x>th)}'; then
    report "❌ memory_rss regression: baseline=${b}MB current=${c}MB (+${inc}%) > ${MEMORY_INCREASE_PCT}%"
    regress=1
  else
    report "✅ memory_rss OK: baseline=${b}MB current=${c}MB (+${inc}%)"
  fi
}

echo "[regression] Comparing current vs baseline (impl=$impl file=$(basename "$BASELINE"))"

# Latencies
compare_latency "plugin_reload_p95" '.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p95'
compare_latency "plugin_reload_p99" '.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p99'
compare_latency "snapshot_create_p95" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p95'
compare_latency "snapshot_create_p99" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p99'
compare_latency "snapshot_restore_p95" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p95'
compare_latency "snapshot_restore_p99" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p99'
compare_latency "redis_get_p95" '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p95'
compare_latency "redis_get_p99" '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p99'
compare_latency "redis_set_p95" '.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p95'
compare_latency "redis_set_p99" '.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p99'

# Absolute Redis latency checks (if present in current JSON)
compare_latency_abs "redis_get_p95_abs" '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p95' "$REDIS_GET_P95_MAX"
compare_latency_abs "redis_get_p99_abs" '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p99' "$REDIS_GET_P99_MAX"
compare_latency_abs "redis_set_p95_abs" '.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p95' "$REDIS_SET_P95_MAX"
compare_latency_abs "redis_set_p99_abs" '.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p99' "$REDIS_SET_P99_MAX"

# Rates
compare_rate_drop "http_success_rate" '.counters.http_success_rate' '%'
compare_rate_drop "cache_hit_rate" '.counters.cache_hit_rate' '%'
if [[ -n "$(read_metric "$CURRENT" '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p95')" ]]; then
  recent_fail=$(read_metric "$CURRENT" '.counters.redis_recent_failures // empty')
  if [[ -n "$recent_fail" && "$recent_fail" != "0" ]]; then
    report "❌ redis_recent_failures >0 in window: $recent_fail"; regress=1
  else
    report "✅ redis_recent_failures OK: $recent_fail";
  fi
fi

# Memory
compare_memory

if [[ $regress -eq 1 ]]; then
  echo "[regression] RESULT: FAIL"; exit 1
else
  echo "[regression] RESULT: PASS"; exit 0
fi
