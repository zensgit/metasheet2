#!/usr/bin/env bash
# Phase 5 Production Validate (Minimal, Non-invasive)
# Performs snapshot migration + create + restore and optional plugin reload.
# Outputs concise JSON without invoking test-only routes or synthetic fallback.

set -euo pipefail

VIEW=""
USER="prod-validate"
SERVER="http://localhost:8900"
OUT_FILE="phase5-prod-validation.json"
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

[[ -z "$VIEW" ]] && { echo "[ProdValidate] ERROR: --view required" >&2; exit 1; }
[[ -z "${DATABASE_URL:-}" ]] && { echo "[ProdValidate] ERROR: DATABASE_URL not set" >&2; exit 1; }

echo "[ProdValidate] view=$VIEW server=$SERVER reload_plugin=${RELOAD_PLUGIN:-none}" >&2

root_dir="packages/core-backend/scripts"
snap_json=$(npx tsx "$root_dir/phase5-snapshot-migrate-and-restore.ts" --view "$VIEW" --user "$USER" || true)
snapshot_id=$(echo "$snap_json" | grep -E '"snapshotId"' | sed -E 's/.*"snapshotId": "([^"]+)".*/\1/' || true)

metrics_raw=$(curl -fsS "$SERVER/metrics/prom" || echo "")

# Optional plugin reload
plugin_reload_latency='{"p50":0,"p95":0,"p99":0}'
if [[ -n "$RELOAD_PLUGIN" ]]; then
  TOKEN=""
  if [[ -f scripts/phase5-dev-jwt.sh ]]; then TOKEN=$(bash scripts/phase5-dev-jwt.sh || echo ""); fi
  if [[ "$SAFETY_CONFIRM" == "true" ]]; then
    curl -fsS -X POST "$SERVER/api/admin/safety/confirm" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"action":"plugin.reload","target":"'$RELOAD_PLUGIN'"}' >/dev/null || true
    sleep 0.3
  fi
  curl -fsS -X POST "$SERVER/api/admin/plugins/$RELOAD_PLUGIN/reload" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' >/dev/null || true
  sleep 0.5
  metrics_raw=$(curl -fsS "$SERVER/metrics/prom" || echo "")
fi

get_val() { echo "$metrics_raw" | grep -E "$1" | awk '{print $2}' | head -n1 || echo 0; }

plugin_reload_success=$(get_val 'metasheet_plugin_reload_total.*result="success"')
plugin_reload_failure=$(get_val 'metasheet_plugin_reload_total.*result="failure"')
snapshot_create_success=$(get_val 'metasheet_snapshot_create_total.*success')
snapshot_restore_success=$(get_val 'metasheet_snapshot_restore_total.*success')
snapshot_restore_failure=$(get_val 'metasheet_snapshot_restore_total.*failure')

# Histogram percentile helper
extract_p95() {
  local metric_prefix="$1"; local label_filter="$2"; local lines
  lines=$(echo "$metrics_raw" | grep -E "^${metric_prefix}_bucket\{.*${label_filter}.*le=\"[0-9\.]+\"\}") || true
  [[ -z "$lines" ]] && { echo 0; return; }
  local total_line total
  total_line=$(echo "$metrics_raw" | grep -E "^${metric_prefix}_count\{.*${label_filter}.*\}") || true
  if [[ -n "$total_line" ]]; then total=$(echo "$total_line" | awk '{print $2}') else total=$(echo "$lines" | awk '{print $2}' | tail -n1); fi
  [[ -z "$total" || "$total" == 0 ]] && { echo 0; return; }
  local target; target=$(python - <<PY
import math; print(int(math.ceil(${total}*0.95)))
PY
)
  local cumulative=0 p95=0
  while read -r line; do
    local val bucket
    val=$(echo "$line" | awk '{print $2}')
    bucket=$(echo "$line" | sed -E 's/.*le=\"([0-9\.]+)\".*/\1/')
    cumulative=$val
    if [[ $p95 == 0 && $cumulative -ge $target ]]; then p95=$bucket; fi
  done <<< "$lines"
  echo "${p95:-0}"
}

plugin_p95=0
if [[ -n "$RELOAD_PLUGIN" ]]; then plugin_p95=$(extract_p95 metasheet_plugin_reload_duration_seconds 'plugin_name=\"'$RELOAD_PLUGIN'\"'); fi
create_p95=$(extract_p95 metasheet_snapshot_operation_duration_seconds 'operation="create"')
restore_p95=$(extract_p95 metasheet_snapshot_operation_duration_seconds 'operation="restore"')

cat > "$OUT_FILE" <<JSON
{
  "view": "$VIEW",
  "snapshotId": "$snapshot_id",
  "metrics": {
    "pluginReloadSuccess": $plugin_reload_success,
    "pluginReloadFailure": $plugin_reload_failure,
    "snapshotCreateSuccess": $snapshot_create_success,
    "snapshotRestoreSuccess": $snapshot_restore_success,
    "snapshotRestoreFailure": $snapshot_restore_failure,
    "pluginReloadLatencyP95": $plugin_p95,
    "snapshotCreateLatencyP95": $create_p95,
    "snapshotRestoreLatencyP95": $restore_p95
  },
  "timestamp": "$(date -Iseconds)",
  "server": "$SERVER"
}
JSON

echo "[ProdValidate] Summary written to $OUT_FILE" >&2
