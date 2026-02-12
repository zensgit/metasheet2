#!/usr/bin/env bash
set -euo pipefail

# Verifies that the backend Prometheus endpoint is reachable and contains the
# key Attendance production metrics. Intended to run on the production host,
# where backend is bound to 127.0.0.1:8900 (see docker-compose.app.yml).

METRICS_URL="${METRICS_URL:-http://127.0.0.1:8900/metrics/prom}"
MAX_TIME="${MAX_TIME:-10}"

function die() {
  echo "[attendance-check-metrics] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-check-metrics] $*" >&2
}

if ! command -v curl >/dev/null 2>&1; then
  die "curl is required"
fi

info "Fetching: ${METRICS_URL}"
raw="$(curl -fsS --max-time "$MAX_TIME" "$METRICS_URL")"

# Basic Prometheus sanity.
if ! grep -qE '^# (HELP|TYPE) ' <<<"$raw"; then
  die "Response does not look like Prometheus metrics (missing '# HELP/# TYPE')"
fi

# Attendance hardening metrics (P1) should be present when the attendance plugin is enabled.
required=(
  'attendance_api_errors_total'
  'attendance_rate_limited_total'
  'attendance_operation_requests_total'
  'attendance_operation_latency_seconds'
  'attendance_import_upload_bytes_total'
  'attendance_import_upload_rows_total'
)

missing=0
for name in "${required[@]}"; do
  if ! grep -qE "^${name}([ {])" <<<"$raw"; then
    echo "[attendance-check-metrics] MISSING: ${name}" >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  die "Missing required attendance metrics (see above)."
fi

info "Metrics OK"
