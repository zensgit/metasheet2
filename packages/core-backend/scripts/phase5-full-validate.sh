#!/usr/bin/env bash
# Phase 5: Full Validation Orchestrator
# Runs snapshot migration + snapshot create/restore + cache simulation + fallback trigger
# Then captures key metrics into a JSON summary for report usage.
#
# Prerequisites:
#   - Server running (PORT=8900 default) with proper env:
#       DATABASE_URL=postgres://... (for snapshot ops)
#       FEATURE_CACHE=true CACHE_IMPL=memory (or redis)
#       ENABLE_FALLBACK_TEST=true (to expose fallback route)
#   - Node.js + tsx installed (for TS scripts)
#
# Usage:
#   export DATABASE_URL=postgres://user:pass@host:5432/db
#   ./packages/core-backend/scripts/phase5-full-validate.sh --view view_123 --user dev-user \
#     --server http://localhost:8900 --output phase5-validation.json

set -euo pipefail

VIEW=""
USER="dev-user"
SERVER="http://localhost:8900"
OUT_FILE="phase5-validation.json"
RELOAD_PLUGIN=""
SAFETY_CONFIRM="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --view) VIEW="$2"; shift 2;;
    --user) USER="$2"; shift 2;;
    --server) SERVER="$2"; shift 2;;
    --output) OUT_FILE="$2"; shift 2;;
    --reload-plugin) RELOAD_PLUGIN="$2"; shift 2;;
    --no-safety-confirm) SAFETY_CONFIRM="false"; shift 1;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[Phase5] ERROR: DATABASE_URL not set" >&2
  exit 1
fi

if [[ -z "$VIEW" ]]; then
  echo "[Phase5] ERROR: --view required" >&2
  exit 1
fi

echo "[Phase5] Starting full validation for view=$VIEW user=$USER server=$SERVER"

root_dir="packages/core-backend/scripts"

# 1. Snapshot migration + create + restore
echo "[Phase5] Step 1: Snapshot migrate + create + restore"
snap_json=$(npx tsx "$root_dir/phase5-snapshot-migrate-and-restore.ts" --view "$VIEW" --user "$USER" || true)
echo "$snap_json" | sed -e 's/^/[Phase5]   /'

# Extract snapshotId if present
snapshot_id=$(echo "$snap_json" | grep -E '"snapshotId"' | sed -E 's/.*"snapshotId": "([^"]+)".*/\1/' || true)

# 2. Cache simulation (best effort)
echo "[Phase5] Step 2: Cache simulation"
SERVER_URL="$SERVER" bash "$root_dir/phase5-cache-simulation.sh" || echo "[Phase5] WARN: cache simulation failed"

# 3. Fallback trigger (requires ENABLE_FALLBACK_TEST=true)
echo "[Phase5] Step 3: Fallback trigger"
SERVER_URL="$SERVER" bash "$root_dir/phase5-fallback-trigger.sh" || echo "[Phase5] WARN: fallback trigger failed"

# 4. Metrics snapshot (initial)
echo "[Phase5] Step 4: Collect metrics (initial)"
metrics_raw=$(curl -fsS "$SERVER/metrics/prom" || echo "")

# Optional plugin reload (SafetyGuard confirm + reload)
if [[ -n "$RELOAD_PLUGIN" ]]; then
  echo "[Phase5] Step 4a: Plugin reload instrumentation for $RELOAD_PLUGIN"
  TOKEN=""
  if [[ -f scripts/phase5-dev-jwt.sh ]]; then TOKEN=$(bash scripts/phase5-dev-jwt.sh || echo ""); fi
  if [[ -z "$TOKEN" ]]; then echo "[Phase5] WARN: JWT token generation failed (scripts/phase5-dev-jwt.sh)"; fi
  if [[ "$SAFETY_CONFIRM" == "true" ]]; then
    CONFIRM_ID=$(curl -fsS -X POST "$SERVER/api/admin/safety/confirm" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"action":"plugin.reload","target":"'$RELOAD_PLUGIN'"}' | sed -E 's/.*"id":"([^"]+)".*/\1/' || true)
    echo "[Phase5] Safety confirm id=$CONFIRM_ID"
    sleep 0.3
  fi
  curl -fsS -X POST "$SERVER/api/admin/plugins/$RELOAD_PLUGIN/reload" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' || echo "[Phase5] WARN: plugin reload request failed"
  sleep 0.5
  metrics_raw=$(curl -fsS "$SERVER/metrics/prom" || echo "")
fi

get_metric() { # first occurrence numeric value
  local name="$1"
  echo "$metrics_raw" | grep -E "^${name}(\{| )" | head -n1 | awk '{print $2}' || echo "0"
}

# Extract histogram percentiles (p50/p95/p99) from *_bucket cumulative counts
extract_histogram_percentiles() {
  local metric_prefix="$1"   # e.g. metasheet_plugin_reload_duration_seconds
  local label_filter="$2"    # e.g. plugin_name="example-plugin"
  local lines
  lines=$(echo "$metrics_raw" | grep -E "^${metric_prefix}_bucket\{.*${label_filter}.*le=\"[0-9\.]+\"\}") || true
  if [[ -z "$lines" ]]; then echo '{"p50":0,"p95":0,"p99":0}'; return; fi
  local count_line total
  count_line=$(echo "$metrics_raw" | grep -E "^${metric_prefix}_count\{.*${label_filter}.*\}") || true
  if [[ -n "$count_line" ]]; then
    total=$(echo "$count_line" | awk '{print $2}')
  else
    total=$(echo "$lines" | awk '{print $2}' | tail -n1)
  fi
  if [[ -z "$total" || "$total" == "0" ]]; then echo '{"p50":0,"p95":0,"p99":0}'; return; fi
  # Compute percentile targets as integer rank (ceil)
  local p50_target p95_target p99_target
  p50_target=$(python - <<PY
import math; total=${total}; print(int(math.ceil(total*0.50)))
PY
)
  p95_target=$(python - <<PY
import math; total=${total}; print(int(math.ceil(total*0.95)))
PY
)
  p99_target=$(python - <<PY
import math; total=${total}; print(int(math.ceil(total*0.99)))
PY
)
  local cumulative=0 p50=0 p95=0 p99=0
  while read -r line; do
    local val bucket
    val=$(echo "$line" | awk '{print $2}')
    bucket=$(echo "$line" | sed -E 's/.*le=\"([0-9\.]+)\".*/\1/')
    cumulative=$val
    if [[ $p50 == 0 && $cumulative -ge $p50_target ]]; then p50=$bucket; fi
    if [[ $p95 == 0 && $cumulative -ge $p95_target ]]; then p95=$bucket; fi
    if [[ $p99 == 0 && $cumulative -ge $p99_target ]]; then p99=$bucket; fi
  done <<< "$lines"
  echo '{"p50":'${p50:-0}',"p95":'${p95:-0}',"p99":'${p99:-0}'}'
}

reload_success=$(echo "$metrics_raw" | grep -E 'metasheet_plugin_reload_total.*result="success"' | awk '{print $2}' | head -n1 || echo "0")
reload_failure=$(echo "$metrics_raw" | grep -E 'metasheet_plugin_reload_total.*result="failure"' | awk '{print $2}' | head -n1 || echo "0")
snapshot_create_success=$(echo "$metrics_raw" | grep -E 'metasheet_snapshot_create_total.*success' | awk '{print $2}' | head -n1 || echo "0")
snapshot_restore_success=$(echo "$metrics_raw" | grep -E 'metasheet_snapshot_restore_total.*success' | awk '{print $2}' | head -n1 || echo "0")
snapshot_restore_failure=$(echo "$metrics_raw" | grep -E 'metasheet_snapshot_restore_total.*failure' | awk '{print $2}' | head -n1 || echo "0")
cache_hits=$(echo "$metrics_raw" | grep -E '^cache_hits_total' | awk '{print $2}' | head -n1 || echo "0")
cache_misses=$(echo "$metrics_raw" | grep -E '^cache_miss_total' | awk '{print $2}' | head -n1 || echo "0")
fallback_total=$(echo "$metrics_raw" | grep -E '^metasheet_fallback_total' | awk '{print $2}' | awk 'NR==1' || echo "0")
fallback_cache_miss=$(echo "$metrics_raw" | grep -E 'metasheet_fallback_total\{.*reason="miss".*\}' | awk '{print $2}' | awk 'NR==1' || echo "0")
fallback_rpc_timeout=$(echo "$metrics_raw" | grep -E 'metasheet_fallback_total\{.*reason="rpc_timeout".*\}' | awk '{print $2}' | awk 'NR==1' || echo "0")
fallback_rpc_error=$(echo "$metrics_raw" | grep -E 'metasheet_fallback_total\{.*reason="rpc_error".*\}' | awk '{print $2}' | awk 'NR==1' || echo "0")
fallback_other=$(python - <<PY
total=int(${fallback_total:-0}); cm=int(${fallback_cache_miss:-0}); to=int(${fallback_rpc_timeout:-0}); er=int(${fallback_rpc_error:-0}); print(max(total-cm-to-er,0))
PY
)
effective_fallback=$fallback_total
if [[ "${COUNT_CACHE_MISS_AS_FALLBACK:-true}" == "false" ]]; then
  effective_fallback=$(python - <<PY
total=int(${fallback_total:-0}); cm=int(${fallback_cache_miss:-0}); print(max(total-cm,0))
PY
)
fi

plugin_latency_json='{"p50":0,"p95":0,"p99":0}'
if [[ -n "$RELOAD_PLUGIN" ]]; then
  plugin_latency_json=$(extract_histogram_percentiles 'metasheet_plugin_reload_duration_seconds' "plugin_name=\"$RELOAD_PLUGIN\"")
fi
snapshot_create_latency_json=$(extract_histogram_percentiles 'metasheet_snapshot_operation_duration_seconds' 'operation="create"')
snapshot_restore_latency_json=$(extract_histogram_percentiles 'metasheet_snapshot_operation_duration_seconds' 'operation="restore"')

# 5. Build JSON summary
echo "[Phase5] Step 5: Write summary $OUT_FILE"
cat > "$OUT_FILE" <<JSON
{
  "view": "$VIEW",
  "user": "$USER",
  "snapshotId": "$snapshot_id",
  "metrics": {
    "pluginReloadSuccess": $reload_success,
    "pluginReloadFailure": $reload_failure,
    "snapshotCreateSuccess": $snapshot_create_success,
    "snapshotRestoreSuccess": $snapshot_restore_success,
    "snapshotRestoreFailure": $snapshot_restore_failure,
    "cacheHits": $cache_hits,
    "cacheMisses": $cache_misses,
    "fallbackTotalRaw": $fallback_total,
    "fallbackCacheMiss": $fallback_cache_miss,
    "fallbackRpcTimeout": $fallback_rpc_timeout,
    "fallbackRpcError": $fallback_rpc_error,
    "fallbackOther": $fallback_other,
    "fallbackEffective": $effective_fallback,
    "pluginReloadLatency": $plugin_latency_json,
    "snapshotCreateLatency": $snapshot_create_latency_json,
    "snapshotRestoreLatency": $snapshot_restore_latency_json
  },
  "timestamp": "$(date -Iseconds)",
  "server": "$SERVER"
}
JSON

echo "[Phase5] Summary written to $OUT_FILE"
echo "[Phase5] Validation complete"
