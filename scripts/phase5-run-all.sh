#!/usr/bin/env bash
set -euo pipefail

# Phase 5: One-shot population + validation runner
# - Populates cache hit/miss, plugin reload, and fallback metrics
# - Runs full validation and generates the markdown report

API_BASE="${API_BASE:-http://localhost:8900}"
METRICS_URL="${METRICS_URL:-$API_BASE/metrics/prom}"
OUT_JSON="${OUT_JSON:-/tmp/phase5.json}"
OUT_MD="${OUT_MD:-/tmp/phase5.md}"

log() { printf "[Phase5] %s\n" "$*"; }
warn() { printf "[Phase5] WARN: %s\n" "$*" >&2; }

need() {
  local f="$1"; shift || true
  if [[ ! -x "$f" && ! -f "$f" ]]; then
    warn "Missing required script: $f"; return 1
  fi
}

check_backend() {
  local retries=20
  local sleep_s=1
  log "Checking backend metrics at $METRICS_URL"
  for ((i=1;i<=retries;i++)); do
    if curl -sfm 2 "$METRICS_URL" >/dev/null; then
      log "Backend metrics endpoint is reachable."
      return 0
    fi
    sleep "$sleep_s"
  done
  warn "Backend not reachable at $METRICS_URL"
  return 1
}

main() {
  # Preconditions
  check_backend || { warn "Please start backend with: FEATURE_CACHE=true ENABLE_FALLBACK_TEST=true COUNT_CACHE_MISS_AS_FALLBACK=false"; exit 1; }

  # Optional JWT (used by some populate scripts if present)
  if [[ -x scripts/phase5-dev-jwt.sh ]]; then
    export TOKEN="$(bash scripts/phase5-dev-jwt.sh || true)"
    [[ -n "${TOKEN:-}" ]] || warn "JWT generation returned empty token"
  else
    warn "scripts/phase5-dev-jwt.sh not found or not executable; proceeding without Authorization header"
  fi

  # Populate cache metrics (miss→set→hit cycles)
  if need scripts/phase5-populate-cache.sh; then
    log "Populating cache metrics (hits/misses)..."
    bash scripts/phase5-populate-cache.sh || warn "Cache populate script returned non-zero"
  fi

  # HTTP warm-up to ensure http_success_rate has samples
  # Need enough requests to get meaningful success rate (>50 samples recommended)
  log "Warming up HTTP success metrics (50 iterations)..."
  for i in $(seq 1 50); do
    curl -sf "$API_BASE/api/v2/hello" >/dev/null 2>&1 || true
    curl -sf "$API_BASE/api/plugins" >/dev/null 2>&1 || true
    curl -sf "$API_BASE/internal/metrics" >/dev/null 2>&1 || true
    curl -sf "$API_BASE/health" >/dev/null 2>&1 || true
  done
  log "HTTP warm-up complete (200 requests)"

  # Populate plugin reload metrics (SafetyGuard reload loop)
  if [[ -f scripts/phase5-populate-plugin-reload.sh ]]; then
    log "Executing plugin reload population..."
    bash scripts/phase5-populate-plugin-reload.sh || warn "Plugin reload populate returned non-zero"
  else
    warn "scripts/phase5-populate-plugin-reload.sh not found; skipping"
  fi

  # Trigger fallback events via dev route
  if [[ -f scripts/phase5-trigger-fallback.sh ]]; then
    log "Triggering fallback events..."
    SERVER_URL="$API_BASE" bash scripts/phase5-trigger-fallback.sh || warn "Fallback trigger returned non-zero"
  else
    warn "scripts/phase5-trigger-fallback.sh not found; skipping"
  fi

  # Populate snapshot create histogram explicitly
  log "Populating snapshot create histogram..."
  if [[ -z "${TOKEN:-}" ]]; then
    if [[ -x scripts/phase5-dev-jwt.sh ]]; then
      TOKEN="$(bash scripts/phase5-dev-jwt.sh || true)"
    fi
  fi
  SNAP_CREATE_COUNT="${SNAP_CREATE_COUNT:-10}"
  SNAP_SLEEP_SECS="${SNAP_SLEEP_SECS:-0.2}"
  if [[ -n "${TOKEN:-}" ]]; then
    log "snapshot-create attempts: ${SNAP_CREATE_COUNT}"
    for i in $(seq 1 "${SNAP_CREATE_COUNT}"); do
      curl -s -X POST "$API_BASE/api/snapshots" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H 'Content-Type: application/json' \
        -d '{"view_id":"demo-view","name":"phase5-warmup-'"$i"'","description":"phase5-run-all warm-up","snapshot_type":"full","metadata":{"source":"phase5"},"expires_at":null}' >/dev/null || true
      sleep "$SNAP_SLEEP_SECS"
    done
    log "snapshot-create metrics check (create count)"
    curl -s "$METRICS_URL" | grep '^metasheet_snapshot_operation_duration_seconds_count' | grep 'operation="create"' || warn "snapshot-create count not found in metrics scrape"
  else
    warn "JWT token unavailable; skipping snapshot create warm-up"
  fi

  # Optional: snapshot exercise if a helper is available
  if [[ -f scripts/rehearsal-snapshot.sh ]]; then
    log "Running snapshot rehearsal to ensure histogram samples..."
    bash scripts/rehearsal-snapshot.sh || warn "Snapshot rehearsal returned non-zero"
  fi

  # Validate and generate report
  log "Running Phase 5 validation..."
  if [[ -x scripts/phase5-full-validate.sh ]]; then
    scripts/phase5-full-validate.sh "$METRICS_URL" "$OUT_JSON"
  else
    bash scripts/phase5-full-validate.sh "$METRICS_URL" "$OUT_JSON"
  fi

  log "Generating markdown report..."
  if [[ -x scripts/phase5-generate-report.sh ]]; then
    scripts/phase5-generate-report.sh "$OUT_JSON" "$OUT_MD"
  else
    bash scripts/phase5-generate-report.sh "$OUT_JSON" "$OUT_MD"
  fi

  # Print summary (if jq present)
  if command -v jq >/dev/null 2>&1; then
    log "Validation summary:"; jq '.summary' "$OUT_JSON" || true
  fi

  log "Done. Outputs:"
  echo "  JSON: $OUT_JSON"
  echo "  Report: $OUT_MD"

  # Optionally sync into final completion report
  FINAL_DOC="claudedocs/PHASE5_COMPLETION_REPORT_FINAL.md"
  if [[ -f "$FINAL_DOC" ]]; then
    log "Appending results into $FINAL_DOC"
    {
      echo "\n## Run Artifact ($(date '+%Y-%m-%d %H:%M:%S'))\n"
      echo "Source: $OUT_MD\n"
      cat "$OUT_MD"
      echo "\n---\n"
    } >> "$FINAL_DOC" || warn "Failed to write $FINAL_DOC"
  fi
}

main "$@"
