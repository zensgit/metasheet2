#!/usr/bin/env bash
set -euo pipefail
umask 077

# Local-only runner. A dedicated migrated fixture database and test admin are prerequisites.
API_BASE=${API_BASE:-http://127.0.0.1:8900}
METRICS_URL=${METRICS_URL:-${API_BASE}/metrics/prom}
FEATURE_CACHE=${FEATURE_CACHE:-true}
ENABLE_FALLBACK_TEST=${ENABLE_FALLBACK_TEST:-true}
COUNT_CACHE_MISS_AS_FALLBACK=${COUNT_CACHE_MISS_AS_FALLBACK:-false}
export API_BASE METRICS_URL FEATURE_CACHE ENABLE_FALLBACK_TEST COUNT_CACHE_MISS_AS_FALLBACK
fail() { echo "[CI] $1" >&2; exit 1; }
for command in curl jq node pnpm lsof ps; do command -v "$command" >/dev/null || fail 'Missing required command'; done
[[ "$API_BASE" == http://127.0.0.1:8900 && "$METRICS_URL" == "$API_BASE/metrics/prom" ]] || fail 'Local endpoint contract required'
[[ -n "${TOKEN:-}" ]] || fail 'Dedicated test admin token required'
export TOKEN
node scripts/ops/phase5-snapshot-fixture.mjs --check

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/phase5-run.XXXXXX")
ARTIFACT_JSON=${ARTIFACT_JSON:-$RUN_DIR/phase5.json}
ARTIFACT_MD=${ARTIFACT_MD:-$RUN_DIR/phase5.md}
SERVER_LOG=${SERVER_LOG:-$RUN_DIR/server.log}
artifact_path() {
  local directory
  directory=$(cd -- "$(dirname -- "$1")" 2>/dev/null && pwd -P) || fail 'Artifact directory unavailable'
  printf '%s/%s' "$directory" "$(basename -- "$1")"
}
ARTIFACT_JSON=$(artifact_path "$ARTIFACT_JSON")
ARTIFACT_MD=$(artifact_path "$ARTIFACT_MD")
SERVER_LOG=$(artifact_path "$SERVER_LOG")
[[ "$ARTIFACT_JSON" != "$ARTIFACT_MD" && "$ARTIFACT_JSON" != "$SERVER_LOG" && "$ARTIFACT_MD" != "$SERVER_LOG" ]] || fail 'Artifact destinations must be distinct'
for file in "$ARTIFACT_JSON" "$ARTIFACT_MD" "$SERVER_LOG"; do
  [[ ! -e "$file" && ! -L "$file" ]] || fail 'Artifact destination already exists'
done
BACKEND_PID=''
SNAPSHOT_PID=''
PASSED=false
cleanup() {
  local status=$?
  trap - EXIT
  trap 'status=130' INT
  trap 'status=143' TERM
  if [[ -n "$SNAPSHOT_PID" ]]; then
    kill -TERM "$SNAPSHOT_PID" 2>/dev/null || true
    for ((wait_try=0; wait_try<400; wait_try++)); do
      kill -0 "$SNAPSHOT_PID" 2>/dev/null || break
      /bin/sleep 0.05
    done
    if kill -0 "$SNAPSHOT_PID" 2>/dev/null; then
      echo '[CI] Fixture cleanup timeout' >&2
      kill -KILL "$SNAPSHOT_PID" 2>/dev/null || true
      status=1
    fi
    wait "$SNAPSHOT_PID" 2>/dev/null || true
  fi
  if [[ -n "$BACKEND_PID" ]]; then
    kill -TERM -- "-$BACKEND_PID" 2>/dev/null || true
    for ((wait_try=0; wait_try<100; wait_try++)); do
      kill -0 -- "-$BACKEND_PID" 2>/dev/null || break
      /bin/sleep 0.05
    done
    kill -KILL -- "-$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  rm -f "$RUN_DIR/response"
  if [[ "$status" == 0 && "$PASSED" == true ]]; then
    echo '[CI] Completed with PASS'
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Never adopt or terminate an existing listener. Job control isolates children.
node --input-type=module -e 'import net from "node:net";const s=net.createServer();s.once("error",()=>process.exit(1));s.listen(8900,"127.0.0.1",()=>s.close());' || fail 'Local backend port occupied'
set -m
NODE_ENV=development ALLOW_UNSAFE_ADMIN=false PORT=8900 pnpm --filter @metasheet/core-backend dev >"$SERVER_LOG" 2>&1 &
BACKEND_PID=$!
request() {
  local expected=$1
  shift
  local status
  kill -0 "$BACKEND_PID" 2>/dev/null || fail 'Owned backend exited'
  status=$(curl -sS --connect-timeout 3 --max-time 15 -o "$RUN_DIR/response" -w '%{http_code}' "$@" 2>/dev/null) || fail 'HTTP transport failed'
  [[ "$status" == "$expected" ]] || fail 'Unexpected HTTP status'
}
json_success() {
  request 200 "$@"
  jq -e '.success == true' "$RUN_DIR/response" >/dev/null 2>&1 || fail 'Operation failed'
}

echo '[CI] Waiting for owned backend'
HEALTH_MAX_TRIES=${HEALTH_MAX_TRIES:-180}
HEALTH_DELAY_SECS=${HEALTH_DELAY_SECS:-1}
[[ "$HEALTH_MAX_TRIES" =~ ^[1-9][0-9]*$ && "$HEALTH_DELAY_SECS" =~ ^[0-9]+$ ]] || fail 'Invalid health limits'
ready=false
for ((try=0; try<HEALTH_MAX_TRIES; try++)); do
  kill -0 "$BACKEND_PID" 2>/dev/null || fail 'Owned backend exited'
  if health_status=$(curl -sS --connect-timeout 3 --max-time 5 -o "$RUN_DIR/response" -w '%{http_code}' "$METRICS_URL" 2>/dev/null) && [[ "$health_status" == 200 ]]; then ready=true; break; fi
  sleep "$HEALTH_DELAY_SECS"
done
[[ "$ready" == true ]] || fail 'Backend health failed'
# A watcher may survive a failed bind. Prove that the actual listener belongs
# to the launcher group before sending any population writes.
listener=$(lsof -nP -iTCP:8900 -sTCP:LISTEN -t 2>/dev/null) || fail 'Backend listener ownership unavailable'
[[ "$listener" =~ ^[1-9][0-9]*$ ]] || fail 'Backend listener ownership ambiguous'
listener_group=$(ps -o pgid= -p "$listener" 2>/dev/null) || fail 'Backend listener ownership unavailable'
listener_group=${listener_group//[[:space:]]/}
[[ "$listener_group" == "$BACKEND_PID" ]] || fail 'Backend listener is not owned'
request 200 "$API_BASE/internal/cache"
jq -e '.enabled == true' "$RUN_DIR/response" >/dev/null 2>&1 || fail 'Cache disabled'

echo '[CI] Populating required samples'
for name in HTTP_WARM_ITERS CACHE_WARM_COUNT RELOAD_COUNT SNAPSHOT_COUNT; do
  value=${!name:-}
  [[ -z "$value" || "$value" =~ ^[1-9][0-9]*$ ]] || fail 'Invalid population count'
done
for ((i=0; i<${HTTP_WARM_ITERS:-75}; i++)); do
  json_success -X POST "$API_BASE/api/cache-test/simulate"
  # Generic routes are optional HTTP traffic only.
  curl -fsS --connect-timeout 3 --max-time 5 "$API_BASE/api/version" >/dev/null 2>&1 || true
  curl -fsS --connect-timeout 3 --max-time 5 "$API_BASE/api/plugins" >/dev/null 2>&1 || true
done
for ((i=0; i<${CACHE_WARM_COUNT:-200}; i++)); do
  json_success -X POST "$API_BASE/api/cache-test/warm?count=100"
done
for ((i=0; i<${RELOAD_COUNT:-12}; i++)); do
  reload_url="$API_BASE/api/admin/plugins/example-plugin/reload"
  request 403 -H "Authorization: Bearer $TOKEN" -X POST "$reload_url"
  jq -e '.code == "SAFETY_CHECK_REQUIRED" and (.confirmation.token | type == "string" and length > 0)' "$RUN_DIR/response" >/dev/null 2>&1 || fail 'Reload safety challenge required'
  reload_token=$(jq -r '.confirmation.token' "$RUN_DIR/response")
  confirmation=$(jq -cn --arg token "$reload_token" '{token:$token,acknowledged:true}')
  json_success -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$API_BASE/api/admin/safety/confirm" -d "$confirmation"
  json_success -H "Authorization: Bearer $TOKEN" -H "X-Safety-Token: $reload_token" -X POST "$reload_url"
  jq -e '.pluginId == "example-plugin" and .runtime.status == "active"' "$RUN_DIR/response" >/dev/null 2>&1 || fail 'Reload activation failed'
done
# http_error deliberately returns 500; an unrelated 500 cannot satisfy this.
request 500 -X POST "$API_BASE/internal/test/fallback" -H 'Content-Type: application/json' -d '{"mode":"http_error"}'
jq -e '.ok == false and .error == "simulated http error"' "$RUN_DIR/response" >/dev/null 2>&1 || fail 'Fallback trigger failed'
request 200 -X POST "$API_BASE/internal/test/fallback" -H 'Content-Type: application/json' -d '{"mode":"cache_miss"}'
jq -e '.ok == true and .note == "simulated cache miss (raw only)"' "$RUN_DIR/response" >/dev/null 2>&1 || fail 'Fallback trigger failed'
bash scripts/phase5-populate-snapshots.sh &
SNAPSHOT_PID=$!
wait "$SNAPSHOT_PID"
SNAPSHOT_PID=''
request 200 "$METRICS_URL"
for metric in '^cache_hits_total' '^cache_miss_total' '^metasheet_plugin_reload_duration_seconds_' '^metasheet_snapshot_operation_duration_seconds_'; do
  grep -q "$metric" "$RUN_DIR/response" || fail 'Required metrics missing'
done
echo '[CI] Running validation'
if scripts/phase5-full-validate.sh "$METRICS_URL" "$ARTIFACT_JSON" >"$RUN_DIR/validation.log" 2>&1; then
  :
else
  status=$?
  echo '[CI] Validation failed' >&2
  exit "$status"
fi
[[ -s "$ARTIFACT_JSON" ]] || fail 'Validation artifact missing'
jq -e '.summary.overall_status == "pass" and .summary.failed == 0 and .summary.na == 0 and (.summary.passed | type == "number" and floor == . and . > 0)' "$ARTIFACT_JSON" >/dev/null 2>&1 || fail 'Validation did not pass'
if scripts/phase5-generate-report.sh "$ARTIFACT_JSON" "$ARTIFACT_MD" >"$RUN_DIR/report.log" 2>&1; then
  :
else
  status=$?
  echo '[CI] Report failed' >&2
  exit "$status"
fi
[[ -s "$ARTIFACT_MD" ]] || fail 'Report artifact missing'
PASSED=true
