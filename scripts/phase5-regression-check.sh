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

BASELINE="${1:-}"
CURRENT="${2:-}"

LATENCY_INCREASE_PCT=${LATENCY_INCREASE_PCT:-20}
RATE_DROP_PCT=${RATE_DROP_PCT:-5}
MEMORY_INCREASE_PCT=${MEMORY_INCREASE_PCT:-25}

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

echo "[regression] Comparing current vs baseline"

# Latencies
compare_latency "plugin_reload_p95" '.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p95'
compare_latency "plugin_reload_p99" '.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p99'
compare_latency "snapshot_create_p95" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p95'
compare_latency "snapshot_create_p99" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p99'
compare_latency "snapshot_restore_p95" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p95'
compare_latency "snapshot_restore_p99" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p99'

# Rates
compare_rate_drop "http_success_rate" '.counters.http_success_rate' '%'
compare_rate_drop "cache_hit_rate" '.counters.cache_hit_rate' '%'

# Memory
compare_memory

if [[ $regress -eq 1 ]]; then
  echo "[regression] RESULT: FAIL"; exit 1
else
  echo "[regression] RESULT: PASS"; exit 0
fi

