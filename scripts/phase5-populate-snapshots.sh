#!/usr/bin/env bash
set -euo pipefail

# Populate snapshot histograms by exercising create and restore APIs

API_BASE="${API_BASE:-http://localhost:8900}"
METRICS_URL="${METRICS_URL:-$API_BASE/metrics/prom}"

log() { printf "[snapshot] %s\n" "$*"; }
warn() { printf "[snapshot] WARN: %s\n" "$*" >&2; }
err() { printf "[snapshot] ERROR: %s\n" "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing required command: $1"; exit 1; }
}

main() {
  require curl
  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not found; falling back to regex parsing"
  fi

  # Acquire token if not provided
  if [[ -z "${TOKEN:-}" ]]; then
    if [[ -x scripts/phase5-dev-jwt.sh ]]; then
      TOKEN="$(bash scripts/phase5-dev-jwt.sh || true)"
    fi
  fi

  AUTH_HEADER=()
  if [[ -n "${TOKEN:-}" ]]; then
    AUTH_HEADER=(-H "Authorization: Bearer $TOKEN")
  else
    warn "No TOKEN provided; routes protected by RBAC may fail"
  fi

  # Create snapshot
  ts=$(date +%s)
  create_body=$(cat <<JSON
{
  "view_id": "v-phase5",
  "name": "phase5-populate-$ts",
  "description": "populate histograms",
  "snapshot_type": "manual"
}
JSON
)

  log "Creating snapshot..."
  create_res=$(curl -sf -X POST "$API_BASE/api/snapshots" \
    -H "Content-Type: application/json" \
    "${AUTH_HEADER[@]}" \
    --data "$create_body" || true)

  snapshot_id=""
  if command -v jq >/dev/null 2>&1; then
    snapshot_id=$(printf '%s' "$create_res" | jq -r '.data.id // empty' 2>/dev/null || true)
  else
    snapshot_id=$(printf '%s' "$create_res" | sed -n 's/.*"id"\s*:\s*"\([^"]\+\)".*/\1/p' | head -1)
  fi

  if [[ -z "$snapshot_id" ]]; then
    warn "Failed to extract snapshot id; response: ${create_res:0:120}..."
  else
    log "Created snapshot id=$snapshot_id"
  fi

  # Restore snapshot (if id available)
  if [[ -n "$snapshot_id" ]]; then
    restore_body='{"restore_type":"full"}'
    log "Restoring snapshot $snapshot_id..."
    curl -sf -X POST "$API_BASE/api/snapshots/$snapshot_id/restore" \
      -H "Content-Type: application/json" \
      "${AUTH_HEADER[@]}" \
      --data "$restore_body" >/dev/null || warn "restore request failed"
  fi

  # Probe metrics
  if curl -sf "$METRICS_URL" >/dev/null; then
    log "Checking snapshot histogram samples..."
    curl -sf "$METRICS_URL" | grep -E '^metasheet_snapshot_operation_duration_seconds_.*|^metasheet_snapshot_(create|restore)_total' | sed -e 's/^/[metrics] /'
  else
    warn "Metrics endpoint not reachable at $METRICS_URL"
  fi
}

main "$@"

