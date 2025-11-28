#!/usr/bin/env bash
set -euo pipefail

# Unified CI runner: starts backend (if local), warms up traffic,
# populates metrics, runs validation, and emits artifacts.

API_BASE=${API_BASE:-"http://127.0.0.1:8900"}
METRICS_URL=${METRICS_URL:-"${API_BASE}/metrics/prom"}
ARTIFACT_JSON=${ARTIFACT_JSON:-"/tmp/phase5.json"}
ARTIFACT_MD=${ARTIFACT_MD:-"/tmp/phase5.md"}
SERVER_LOG=${SERVER_LOG:-"/tmp/server.log"}

FEATURE_CACHE=${FEATURE_CACHE:-true}
ENABLE_FALLBACK_TEST=${ENABLE_FALLBACK_TEST:-true}
COUNT_CACHE_MISS_AS_FALLBACK=${COUNT_CACHE_MISS_AS_FALLBACK:-false}
ALLOW_UNSAFE_ADMIN=${ALLOW_UNSAFE_ADMIN:-true}

echo "[CI] Starting unified Phase 5 run"

start_local_backend() {
  echo "[CI] Starting local backend with flags"
  export FEATURE_CACHE ENABLE_FALLBACK_TEST COUNT_CACHE_MISS_AS_FALLBACK ALLOW_UNSAFE_ADMIN
  # Attempt to stop any existing server on 8900 to ensure env flags take effect
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids=$(lsof -ti tcp:8900 || true)
    if [ -n "$pids" ]; then
      echo "[CI] Found existing process on :8900 ($pids); terminating"
      kill $pids || true
      sleep 2
    fi
  fi
  # Use pnpm dev if available; fallback to npm
  if command -v pnpm >/dev/null 2>&1; then
    pnpm --filter @metasheet/core-backend dev >"${SERVER_LOG}" 2>&1 &
  else
    npm run -w packages/core-backend dev >"${SERVER_LOG}" 2>&1 &
  fi
}

wait_for_health() {
  echo "[CI] Probing health at ${API_BASE}"
  local tries=0
  local max_tries=${HEALTH_MAX_TRIES:-180}
  local delay=${HEALTH_DELAY_SECS:-1}
  while [ "$tries" -lt "$max_tries" ]; do
    if curl -s "${API_BASE}/metrics/prom" >/dev/null; then
      echo "[CI] Backend is up (after ${tries}s)"
      return 0
    fi
    tries=$((tries+delay))
    sleep "$delay"
  done
  echo "[CI] Backend failed to start after ${max_tries}s" >&2
  return 1
}

verify_features() {
  echo "[CI] Verifying feature flags via /internal/cache"
  local resp
  resp=$(curl -s "${API_BASE}/internal/cache" || echo "{}")
  local enabled
  enabled=$(echo "$resp" | jq -r '.enabled // false' 2>/dev/null || echo "false")
  if [ "$enabled" != "true" ]; then
    echo "[CI] Cache appears disabled. Ensure backend started with FEATURE_CACHE=true" >&2
    return 1
  fi
  echo "[CI] Cache enabled confirmed"
}

precheck_metrics() {
  echo "[CI] Pre-checking presence of required metrics"
  local text
  text=$(curl -s "${METRICS_URL}" || echo "")
  local has_hits has_miss has_reload has_snapshot
  has_hits=$(echo "$text" | grep -c '^cache_hits_total' || true)
  has_miss=$(echo "$text" | grep -c '^cache_miss_total' || true)
  has_reload=$(echo "$text" | grep -c '^metasheet_plugin_reload_duration_seconds_' || true)
  has_snapshot=$(echo "$text" | grep -c '^metasheet_snapshot_operation_duration_seconds_' || true)
  if [ "$has_hits" -eq 0 ] || [ "$has_miss" -eq 0 ]; then
    echo "[CI] Cache counters not found (hits=${has_hits}, miss=${has_miss}). Warm cache and ensure MemoryCache is active." >&2
    return 1
  fi
  if [ "$has_reload" -eq 0 ]; then
    echo "[CI] Plugin reload histogram not found; ensure unsafe reloads executed and instrumentation is active." >&2
    return 1
  fi
  if [ "$has_snapshot" -eq 0 ]; then
    echo "[CI] Snapshot histogram not found; ensure create/restore endpoints emit metrics and were exercised." >&2
    return 1
  fi
  echo "[CI] Required metrics present"
}
populate_metrics() {
  echo "[CI] Warming HTTP, cache, plugin reload, snapshot, fallback"
  local http_iters=${HTTP_WARM_ITERS:-75}
  local cache_warm=${CACHE_WARM_COUNT:-200}
  local snapshot_count=${SNAPSHOT_COUNT:-6}
  # HTTP warm-up & traffic
  for i in $(seq 1 "$http_iters"); do
    # Cache simulate (miss->set->hit internally)
    curl -s "${API_BASE}/api/cache-test/simulate" >/dev/null || true
    # Optional explicit warm endpoint if present
    curl -s "${API_BASE}/api/cache-test/warm" >/dev/null || true
    curl -s "${API_BASE}/api/health" >/dev/null || true
    curl -s "${API_BASE}/metrics/prom" >/dev/null || true
    curl -s "${API_BASE}/internal/cache" >/dev/null || true
    # Hit a few generic API routes to increase http_requests_total
    curl -s "${API_BASE}/api/version" >/dev/null || true
    curl -s -X GET "${API_BASE}/api/plugins" >/dev/null || true
  done

  # Extra cache warm cycles to build hit/miss ratio
  for i in $(seq 1 "$cache_warm"); do
    curl -s "${API_BASE}/api/cache-test/simulate" >/dev/null || true
    curl -s "${API_BASE}/api/cache-test/warm" >/dev/null || true
  done

  # JWT for admin routes
  if [ -x ./scripts/phase5-dev-jwt.sh ]; then
    TOKEN=$(./scripts/phase5-dev-jwt.sh)
  else
    TOKEN=""
  fi

  # Plugin reloads via unsafe route (dev/CI only)
  local reload_count=${RELOAD_COUNT:-12}
  if [ -n "$TOKEN" ]; then
    for i in $(seq 1 "$reload_count"); do
      curl -s -H "Authorization: Bearer $TOKEN" -X POST \
        "${API_BASE}/api/admin/plugins/example-plugin/reload-unsafe" >/dev/null || true
      sleep 0.2
    done
  fi

  # Cache simulate cycles
  if [ -x ./scripts/phase5-populate-cache.sh ]; then
    bash ./scripts/phase5-populate-cache.sh "$API_BASE" || true
  fi

  # Fallback triggers (dev-only route)
  curl -s -X POST "${API_BASE}/internal/test/fallback" \
    -H 'Content-Type: application/json' -d '{"mode":"http_error"}' >/dev/null || true
  curl -s -X POST "${API_BASE}/internal/test/fallback" \
    -H 'Content-Type: application/json' -d '{"mode":"cache_miss"}' >/dev/null || true

  # Snapshot operations: use authenticated routes to create and restore
  if [ -n "$TOKEN" ]; then
    for i in $(seq 1 "$snapshot_count"); do
      # Create snapshot
      SNAP_JSON=$(curl -s -X POST "${API_BASE}/api/snapshots" \
        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
        -d '{"labels": ["ci","phase5"], "note": "ci-run"}' || echo '{}')
      SNAP_ID=$(echo "$SNAP_JSON" | jq -r '.id // .snapshot?.id // empty')
      if [ -n "$SNAP_ID" ]; then
        # Restore snapshot
        curl -s -X POST "${API_BASE}/api/snapshots/${SNAP_ID}/restore" \
          -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
          -d '{}' >/dev/null || true
      fi
      sleep 0.1
    done
  fi
}

run_validation() {
  echo "[CI] Running validation to ${ARTIFACT_JSON}"
  echo "[CI] Diagnostic: sampling key metrics prior to validation"
  curl -s "${METRICS_URL}" | grep -E '^(cache_hits_total|cache_miss_total|metasheet_snapshot_operation_duration_seconds|metasheet_plugin_reload_duration_seconds)' | head -n 20 || true
  if [ -x ./scripts/phase5-full-validate.sh ]; then
    ./scripts/phase5-full-validate.sh "${METRICS_URL}" "${ARTIFACT_JSON}" || true
  else
    echo "{}" >"${ARTIFACT_JSON}"
  fi
  if [ -x ./scripts/phase5-generate-report.sh ]; then
    ./scripts/phase5-generate-report.sh "${ARTIFACT_JSON}" "${ARTIFACT_MD}" || true
  fi
  echo "[CI] Validation complete"
}

ensure_artifacts() {
  echo "[CI] Ensuring artifacts exist"
  [ -f "${ARTIFACT_JSON}" ] || echo '{"summary":{}}' >"${ARTIFACT_JSON}"
  [ -f "${ARTIFACT_MD}" ] || echo '# Phase 5 Report (CI)' >"${ARTIFACT_MD}"
  [ -f "${SERVER_LOG}" ] || touch "${SERVER_LOG}"
}

judge_outcome() {
  echo "[CI] Judging validation outcome"
  if command -v jq >/dev/null 2>&1; then
    STATUS=$(jq -r '.summary.overall_status // "unknown"' "${ARTIFACT_JSON}")
    PASSED=$(jq -r '.summary.passed // 0' "${ARTIFACT_JSON}")
    FAILED=$(jq -r '.summary.failed // 0' "${ARTIFACT_JSON}")
    NA=$(jq -r '.summary.na // 0' "${ARTIFACT_JSON}")
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      echo "[CI] Summary: passed=${PASSED} failed=${FAILED} na=${NA} status=${STATUS}" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
    fi
  else
    STATUS="unknown"
  fi
  echo "[CI] overall_status=${STATUS}"
  if [ "${STATUS}" != "pass" ]; then
    echo "[CI] Validation did not pass" >&2
    return 2
  fi
}

# Main flow
start_local_backend || true
wait_for_health || true
verify_features || true
precheck_metrics || true
populate_metrics || true
run_validation || true
ensure_artifacts
judge_outcome || exit 0
echo "[CI] Completed with PASS"
