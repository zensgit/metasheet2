#!/usr/bin/env bash
# Phase 5 CI Validation Script
# Lightweight assertions over metrics endpoint to guard regressions.
# Fails (exit 1) if core success metrics absent or latency SLO violated.

set -euo pipefail

SERVER="${1:-http://localhost:8900}"
echo "[CI] Metrics validation against $SERVER"

metrics_raw=$(curl -fsS "$SERVER/metrics/prom" || { echo "[CI] ERROR: cannot fetch metrics" >&2; exit 1; })

get_counter() { # label-filtered counter sum (first match)
  local pattern="$1"; echo "$metrics_raw" | grep -E "$pattern" | awk '{print $2}' | awk 'NR==1' || echo 0;
}

failures=()
warnings=()

plugin_reload_success=$(get_counter '^metasheet_plugin_reload_total\{.*result="success"')
snapshot_restore_success=$(get_counter '^metasheet_snapshot_restore_total\{.*result="success"')
cache_hits=$(get_counter '^cache_hits_total')
cache_miss=$(get_counter '^cache_miss_total')

# Percentile extraction helper
extract_p95() {
  local metric_prefix="$1"; local label_filter="$2";
  local lines; lines=$(echo "$metrics_raw" | grep -E "^${metric_prefix}_bucket\{.*${label_filter}.*le=\"[0-9\.]+\"\}") || true
  if [[ -z "$lines" ]]; then echo 0; return; fi
  local total_line; total_line=$(echo "$metrics_raw" | grep -E "^${metric_prefix}_count\{.*${label_filter}.*\}") || true
  local total
  if [[ -n "$total_line" ]]; then total=$(echo "$total_line" | awk '{print $2}') else total=$(echo "$lines" | awk '{print $2}' | tail -n1); fi
  if [[ -z "$total" || "$total" == 0 ]]; then echo 0; return; fi
  local target; target=$(python - <<PY
import math; print(int(math.ceil(${total}*0.95)))
PY
)
  local cumulative=0
  local p95=0
  while read -r line; do
    local val bucket
    val=$(echo "$line" | awk '{print $2}')
    bucket=$(echo "$line" | sed -E 's/.*le=\"([0-9\.]+)\".*/\1/')
    cumulative=$val
    if [[ $p95 == 0 && $cumulative -ge $target ]]; then p95=$bucket; fi
  done <<< "$lines"
  echo "${p95:-0}"
}

plugin_p95=$(extract_p95 metasheet_plugin_reload_duration_seconds 'plugin_name=')
restore_p95=$(extract_p95 metasheet_snapshot_operation_duration_seconds 'operation="restore"')

# Assertions
[[ $plugin_reload_success -ge 1 ]] || failures+=("plugin_reload_success<1")
[[ $snapshot_restore_success -ge 1 ]] || failures+=("snapshot_restore_success<1")

if [[ -n "${FEATURE_CACHE:-}" && "${FEATURE_CACHE}" == "true" ]]; then
  local_cache_total=$((cache_hits + cache_miss))
  [[ $local_cache_total -gt 0 ]] || failures+=("cache_activity=0")
else
  warnings+=("cache_disabled")
fi

if [[ $plugin_p95 != 0 && $(echo "$plugin_p95 > 5" | bc) -eq 1 ]]; then failures+=("plugin_reload_p95>${plugin_p95}s>"); fi
if [[ $restore_p95 != 0 && $(echo "$restore_p95 > 10" | bc) -eq 1 ]]; then failures+=("snapshot_restore_p95>${restore_p95}s"); fi

echo "[CI] plugin_reload_success=$plugin_reload_success snapshot_restore_success=$snapshot_restore_success cache_hits=$cache_hits cache_miss=$cache_miss plugin_p95=$plugin_p95 restore_p95=$restore_p95"

if (( ${#warnings[@]} )); then echo "[CI] WARNINGS: ${warnings[*]}"; fi
if (( ${#failures[@]} )); then echo "[CI] FAILURES: ${failures[*]}" >&2; exit 1; fi
echo "[CI] Validation passed"

