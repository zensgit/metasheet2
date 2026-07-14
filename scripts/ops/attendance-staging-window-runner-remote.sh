#!/usr/bin/env bash
# attendance-staging-window-runner-remote.sh
#
# Remote (deploy-host) half of .github/workflows/attendance-staging-window-runner.yml.
# Executes ONE action per invocation against the STAGING stack only:
#   deploy — pin staging backend+web to a full-SHA image tag, migrate, verify build+auth
#   smoke  — run one of the five window smokes in-container (bundle doc:
#            docs/development/attendance-staging-window-bundle-20260702.md)
#   status — read-only snapshot (containers, health, settings, pending migrations)
#
# HARD SAFETY RAILS:
#   * Operates exclusively on the staging compose file docker-compose.app.staging.yml
#     and the metasheet-staging-{backend,web,postgres,redis} containers. Fails closed
#     if the staging compose file is absent or does not define the staging containers.
#   * NEVER runs compose against the prod-track stack, and NEVER recreates staging
#     postgres/redis (deploy uses `up -d --no-deps backend web` and asserts the
#     postgres/redis container ids are unchanged afterwards).
#   * Invoked by the workflow as `bash -o pipefail -c '<script>'`; this file also sets
#     pipefail itself so pipelines inside it stay strict when run directly.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=attendance-window-runner-pipeline.lib.sh
source "${HERE}/attendance-window-runner-pipeline.lib.sh"

log() { echo "[window-runner] $*"; }
fail() { echo "[window-runner][error] $*" >&2; exit 1; }

ACTION="${ACTION:?ACTION is required (deploy|smoke|status)}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
SMOKE_ID="${SMOKE_ID:-}"
SET_WINDOW_ENV="${SET_WINDOW_ENV:-none}"
STAGING_DEPLOY_PATH="${STAGING_DEPLOY_PATH:-metasheet2-dingtalk-staging}"
DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
SKIP_HOST_SYNC="${SKIP_HOST_SYNC:-false}"
OUTPUT_DIR="${OUTPUT_DIR:?OUTPUT_DIR is required}"
IMAGE_OWNER="${IMAGE_OWNER:-zensgit}"
RUN_STAMP="${RUN_STAMP:?RUN_STAMP is required (workflow run id marker)}"

BACKEND_CONTAINER="metasheet-staging-backend"
WEB_CONTAINER="metasheet-staging-web"
POSTGRES_CONTAINER="metasheet-staging-postgres"
REDIS_CONTAINER="metasheet-staging-redis"
CONTAINER_RUNNER_DIR="/tmp/window-runner"
STAGING_WEB_HEALTH_URL="http://127.0.0.1:8082/api/health"
STAGING_BACKEND_HEALTH_URL="http://127.0.0.1:18900/health"
IN_CONTAINER_BASE_URL="http://127.0.0.1:8900"
MIGRATE_JS="packages/core-backend/dist/src/db/migrate.js"

resolve_home_path() {
  local raw="$1"
  if [[ "$raw" == /* ]]; then
    printf '%s' "$raw"
  elif [[ "$raw" == ~/* ]]; then
    printf '%s' "${HOME}/${raw#~/}"
  else
    printf '%s' "${HOME}/${raw}"
  fi
}

STAGING_DIR="$(resolve_home_path "$STAGING_DEPLOY_PATH")"
PROD_REPO_DIR="$(resolve_home_path "$DEPLOY_PATH")"
STAGING_COMPOSE_FILE="${STAGING_DIR}/docker-compose.app.staging.yml"
OVERRIDE_FILE="${STAGING_DIR}/docker-compose.window-runner.override.yml"

# --- staging-only guard (fail closed) -------------------------------------------------
assert_staging_only() {
  [[ -d "$STAGING_DIR" ]] || fail "staging stack directory missing: ${STAGING_DIR} (set STAGING_DEPLOY_PATH); refusing to guess"
  [[ -f "$STAGING_COMPOSE_FILE" ]] || fail "staging compose file missing: ${STAGING_COMPOSE_FILE}; fail closed — this runner never falls back to another compose file"
  grep -q "container_name: ${BACKEND_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "compose file does not define ${BACKEND_CONTAINER}; refusing (wrong file?)"
  grep -q "container_name: ${WEB_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "compose file does not define ${WEB_CONTAINER}; refusing (wrong file?)"
  if grep -qE 'container_name: metasheet-(backend|web|postgres|redis)[[:space:]]*$' "$STAGING_COMPOSE_FILE"; then
    fail "compose file defines PROD-track container names; refusing"
  fi
  if [[ "$STAGING_DIR" == "$PROD_REPO_DIR" ]]; then
    fail "staging stack dir equals the prod-track repo dir (${STAGING_DIR}); refusing"
  fi
  log "staging-only guard OK: dir=${STAGING_DIR} compose=$(basename "$STAGING_COMPOSE_FILE")"
}

require_compose_v2() {
  if docker compose version >/dev/null 2>&1; then
    return 0
  fi
  fail "docker compose v2 plugin is required (legacy docker-compose v1 breaks up -d against existing containers; see docs/development/staging-deploy-d88ad587b-20260426.md)"
}

compose_staging() {
  # The ONLY compose entry point in this script: staging compose file + runner override.
  (cd "$STAGING_DIR" && docker compose -f "$STAGING_COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@")
}

staging_exec() {
  # The ONLY docker-exec entry point: pinned staging backend container name.
  docker exec "$BACKEND_CONTAINER" "$@"
}

staging_exec_env() {
  # docker exec with -e pairs: staging_exec_env "A=1" "B=2" -- cmd...
  local -a env_flags=()
  while [[ "$#" -gt 0 && "$1" != "--" ]]; do
    env_flags+=(-e "$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift
  docker exec "${env_flags[@]}" "$BACKEND_CONTAINER" "$@"
}

require_sha() {
  [[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || fail "deploy_sha must be the FULL 40-char lowercase commit SHA (GHCR tags are full-SHA; a 9-char prefix fails with manifest unknown — 2026-04-26 postmortem), got: '${DEPLOY_SHA}'"
}

fetch_health_commit() {
  # stdout: build.commit from the staging web port (/api/health), empty on failure.
  local body
  if ! body="$(curl -fsS --max-time 10 "$STAGING_WEB_HEALTH_URL" 2>/dev/null)"; then
    printf ''
    return 0
  fi
  printf '%s' "$body" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("build", {}).get("commit", ""))
except Exception:
    print("")'
}

wait_for_health_commit() {
  local expected="$1" attempts="${2:-30}" delay="${3:-4}" i commit
  for ((i = 1; i <= attempts; i += 1)); do
    commit="$(fetch_health_commit)"
    if [[ "$commit" == "$expected" ]]; then
      log "health build.commit matches deploy sha (attempt ${i}/${attempts})"
      return 0
    fi
    log "waiting for health build.commit==${expected} (attempt ${i}/${attempts}, got '${commit:-<unreachable>}')"
    sleep "$delay"
  done
  curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" > "${OUTPUT_DIR}/health-last.json" 2>&1 || true
  fail "staging /api/health build.commit never matched ${expected}"
}

prepare_container_runner() {
  staging_exec mkdir -p "${CONTAINER_RUNNER_DIR}/scripts/ops"
  # Bare ESM imports (e.g. `import('pg')`) resolve node_modules upward from the script
  # location; a symlink makes /tmp/window-runner scripts resolve the image's node_modules.
  staging_exec ln -sfn /app/node_modules "${CONTAINER_RUNNER_DIR}/node_modules"
  docker cp "${HERE}/attendance-window-runner-mint-token.mjs" \
    "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/scripts/ops/attendance-window-runner-mint-token.mjs"
}

find_admin_user() {
  staging_exec node "${CONTAINER_RUNNER_DIR}/scripts/ops/attendance-window-runner-mint-token.mjs" --find-admin
}

mint_token() {
  # mint_token <user_id> <roles_csv> <perms_csv>; token printed to stdout (never logged).
  local user_id="$1" roles="$2" perms="$3"
  [[ "$user_id" =~ ^[A-Za-z0-9._@-]+$ ]] || fail "refusing to mint token for unsafe user id: ${user_id}"
  staging_exec node "${CONTAINER_RUNNER_DIR}/scripts/ops/attendance-window-runner-mint-token.mjs" \
    --mint --user-id "$user_id" --roles "$roles" --perms "$perms"
}

capture_settings() {
  # capture_settings <token> <out_file>; records HTTP code alongside the body.
  local token="$1" out_file="$2" http_code
  http_code="$(curl -sS --max-time 15 -o "$out_file" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" -H 'x-org-id: default' \
    'http://127.0.0.1:8082/api/attendance/settings?orgId=default' || echo '000')"
  echo "$http_code" > "${out_file}.http_code"
  log "GET /api/attendance/settings -> ${http_code} (${out_file})"
  printf '%s' "$http_code"
}

assert_window_env_flags() {
  # The digest gate must stay unset/false for the whole window (bundle §3.4); the two
  # rd-window flags must be live when requested. Verified in the RUNNING container env.
  staging_exec node -e '
const mode = process.argv[1]
const digest = process.env.ATTENDANCE_REPORT_DIGEST_ENABLED
if (digest === "true") {
  console.error("FAIL: ATTENDANCE_REPORT_DIGEST_ENABLED=true in the staging backend — the window plan requires it UNSET for the whole window (bundle §3.4)")
  process.exit(1)
}
const sched = process.env.ATTENDANCE_SCHEDULER_ENABLED
const worker = process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED
if (mode === "rd-window") {
  if (sched !== "true" || worker !== "true") {
    console.error(`FAIL: rd-window requested but scheduler=${sched} worker=${worker} in the running container`)
    process.exit(1)
  }
} else if (sched === "true" || worker === "true") {
  console.warn(`WARN: set_window_env=none but scheduler=${sched} worker=${worker} are on (likely set in the host env file; this runner only manages its own override)`)
}
console.log(`env-flags ok: mode=${mode} scheduler=${sched||"<unset>"} worker=${worker||"<unset>"} digest=${digest||"<unset>"}`)
' "$SET_WINDOW_ENV" | tee "${OUTPUT_DIR}/env-flags.txt"
}

snapshot_staging_ps() {
  docker ps --filter 'name=metasheet-staging-' \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' > "${OUTPUT_DIR}/docker-ps-staging.txt"
}

host_sync_prod_repo() {
  # Same discipline as attendance-remote-log-snapshot-prod.yml: the smoke scripts are
  # docker-cp'd from the host-synced repo (main), decoupled from the deployed image SHA.
  [[ -d "$PROD_REPO_DIR" ]] || fail "host repo missing: ${PROD_REPO_DIR} (DEPLOY_PATH)"
  if [[ "$SKIP_HOST_SYNC" == "true" ]]; then
    log "host-sync skipped (skip_host_sync=true)"
    return 0
  fi
  if git -C "$PROD_REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$PROD_REPO_DIR" fetch origin main
    git -C "$PROD_REPO_DIR" checkout main
    git -C "$PROD_REPO_DIR" pull --ff-only origin main
    log "host-sync ok: $(git -C "$PROD_REPO_DIR" rev-parse HEAD)"
  else
    log "host-sync: ${PROD_REPO_DIR} is not a git repo; continuing with existing files"
  fi
}

auth_round_trip() {
  # Bundle §3: staging-realm token must authenticate. Mint in-container (staging
  # JWT_SECRET), then require /api/auth/me == 200 AND /api/attendance/settings == 200.
  local admin_id admin_token me_code settings_code
  admin_id="$(find_admin_user)"
  log "auth round-trip subject: ${admin_id}"
  admin_token="$(mint_token "$admin_id" 'admin' 'attendance:read,attendance:write,attendance:admin,attendance:approve')"
  me_code="$(curl -sS --max-time 15 -o "${OUTPUT_DIR}/auth-me.json" -w '%{http_code}' \
    -H "Authorization: Bearer ${admin_token}" 'http://127.0.0.1:8082/api/auth/me' || echo '000')"
  echo "$me_code" > "${OUTPUT_DIR}/auth-me.http_code"
  [[ "$me_code" == "200" ]] || fail "auth round-trip failed: GET /api/auth/me -> ${me_code} (401 = wrong-realm token / missing admin user; do not debug the route — see bundle §3)"
  settings_code="$(capture_settings "$admin_token" "${OUTPUT_DIR}/settings-postdeploy.json")"
  [[ "$settings_code" == "200" ]] || fail "auth round-trip failed: GET /api/attendance/settings -> ${settings_code} (503 = schema gap: STOP per bundle §3)"
  log "auth round-trip OK (me=200, settings=200)"
}

# --- actions ---------------------------------------------------------------------------

action_deploy() {
  require_sha
  require_compose_v2

  local backend_image="ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${DEPLOY_SHA}"
  local web_image="ghcr.io/${IMAGE_OWNER}/metasheet2-web:${DEPLOY_SHA}"

  local pg_id_before redis_id_before
  pg_id_before="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")" \
    || fail "staging postgres container not found: ${POSTGRES_CONTAINER}"
  redis_id_before="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")" \
    || fail "staging redis container not found: ${REDIS_CONTAINER}"

  if [[ -f "$OVERRIDE_FILE" ]]; then
    cp "$OVERRIDE_FILE" "${OVERRIDE_FILE}.bak-$(date +%Y%m%d%H%M%S)"
  fi
  {
    echo "# Written by attendance-staging-window-runner (run ${RUN_STAMP}). Pins the staging"
    echo "# backend/web images to one full-SHA tag; env flips happen ONLY here, together with"
    echo "# the deploy (bundle §3.4). Redeploying with set_window_env=none removes the flags."
    echo "services:"
    echo "  backend:"
    echo "    image: ${backend_image}"
    if [[ "$SET_WINDOW_ENV" == "rd-window" ]]; then
      echo "    environment:"
      echo "      ATTENDANCE_SCHEDULER_ENABLED: \"true\""
      echo "      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: \"true\""
    fi
    echo "  web:"
    echo "    image: ${web_image}"
  } > "$OVERRIDE_FILE"
  cp "$OVERRIDE_FILE" "${OUTPUT_DIR}/window-runner-override.yml"
  log "override written: ${OVERRIDE_FILE} (env mode: ${SET_WINDOW_ENV})"

  compose_staging pull backend web 2>&1 | tee "${OUTPUT_DIR}/compose-pull.log"
  # NEVER recreate postgres/redis: only backend+web, --no-deps.
  compose_staging up -d --no-deps backend web 2>&1 | tee "${OUTPUT_DIR}/compose-up.log"

  local pg_id_after redis_id_after
  pg_id_after="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")"
  redis_id_after="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")"
  [[ "$pg_id_before" == "$pg_id_after" ]] || fail "staging postgres container was recreated — hard constraint violated"
  [[ "$redis_id_before" == "$redis_id_after" ]] || fail "staging redis container was recreated — hard constraint violated"
  log "postgres/redis untouched (container ids unchanged)"

  local running_backend_image
  running_backend_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")"
  [[ "$running_backend_image" == "$backend_image" ]] \
    || fail "backend container image is ${running_backend_image}, expected ${backend_image}"

  wait_for_health_commit "$DEPLOY_SHA"
  curl -fsS --max-time 10 "$STAGING_WEB_HEALTH_URL" > "${OUTPUT_DIR}/health-web.json"
  curl -fsS --max-time 10 "$STAGING_BACKEND_HEALTH_URL" > "${OUTPUT_DIR}/health-backend.json" || true

  assert_window_env_flags

  # Migration discipline (bundle §3.2): list BEFORE, classify read-only, migrate, list
  # AFTER (must end pending=0). The alignment report runs in-container from the deployed
  # image's own /app/scripts copy so its file scan matches the deployed migration set.
  prepare_container_runner
  staging_exec node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/migrate-list-before.txt"
  docker cp "${OUTPUT_DIR}/migrate-list-before.txt" "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/migrate-list-before.txt"
  staging_exec node /app/scripts/ops/staging-migration-alignment-report.mjs \
    --migrate-list-file "${CONTAINER_RUNNER_DIR}/migrate-list-before.txt" \
    --out-dir "${CONTAINER_RUNNER_DIR}/migration-report" < /dev/null 2>&1 \
    | tee "${OUTPUT_DIR}/migration-alignment-stdout.txt"
  docker cp "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/migration-report" "${OUTPUT_DIR}/migration-report" || true
  if grep -q 'decision=do_not_run_full_migrate' "${OUTPUT_DIR}/migration-alignment-stdout.txt"; then
    fail "migration alignment report says do_not_run_full_migrate — STOP per bundle §3.2; follow docs/development/staging-migration-alignment-runbook-verification-20260519.md"
  fi

  staging_exec node "$MIGRATE_JS" < /dev/null 2>&1 | tee "${OUTPUT_DIR}/migrate-run.log"
  staging_exec node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/migrate-list-after.txt"
  grep -q '^Pending: 0$' "${OUTPUT_DIR}/migrate-list-after.txt" \
    || fail "migrations did not end at pending=0 (see migrate-list-after.txt)"

  auth_round_trip
  snapshot_staging_ps

  {
    echo "action=deploy"
    echo "deploy_sha=${DEPLOY_SHA}"
    echo "set_window_env=${SET_WINDOW_ENV}"
    echo "backend_image=${backend_image}"
    echo "web_image=${web_image}"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  log "deploy OK: ${DEPLOY_SHA}"
}

action_smoke() {
  [[ -n "$DEPLOY_SHA" ]] || fail "deploy_sha is REQUIRED for action=smoke (every stamp must name the exact deployed SHA — precedent-window lesson)"
  require_sha
  [[ -n "$SMOKE_ID" ]] || fail "smoke input is required for action=smoke"

  local smoke_script stamp_prefix
  local -a extra_env=() extra_tokens=()
  case "$SMOKE_ID" in
    ae4)
      smoke_script="staging-attendance-ae4-result-edit-smoke.mjs"
      stamp_prefix="ae4-smoke"
      extra_tokens=("NON_ADMIN_TOKEN:reader:user:attendance:read")
      ;;
    rd45)
      smoke_script="staging-attendance-report-digest-rd45-smoke.mjs"
      stamp_prefix="rd45-smoke"
      extra_env=("PLUGIN_INDEX_PATH=/app/plugins/plugin-attendance/index.cjs")
      ;;
    otbank-v18)
      smoke_script="staging-attendance-overtime-bank-v18-smoke.mjs"
      stamp_prefix="otbank-v18-smoke"
      extra_tokens=(
        "CASE1_TOKEN:case1:user:attendance:read,attendance:write"
        "CASE2_TOKEN:case2:user:attendance:read,attendance:write"
        "CASE3_TOKEN:case3:user:attendance:read,attendance:write"
        "MUSTPAY_TOKEN:mustpay:user:attendance:read,attendance:write"
        "DORMANT_TOKEN:dormant:user:attendance:read,attendance:write"
      )
      ;;
    mp6)
      smoke_script="staging-attendance-makeup-punch-mp6-smoke.mjs"
      stamp_prefix="mp6-smoke"
      extra_tokens=("SUBJECT_TOKEN:subject:user:attendance:read,attendance:write")
      ;;
    hmr5)
      smoke_script="staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs"
      stamp_prefix="hmr5-smoke"
      extra_tokens=("SCOPED_TOKEN:scoped:user:attendance:read,attendance:write")
      ;;
    *)
      fail "unknown smoke id: ${SMOKE_ID}"
      ;;
  esac
  local stamp="${stamp_prefix}-${RUN_STAMP}"

  host_sync_prod_repo
  local smoke_src="${PROD_REPO_DIR}/scripts/ops/${smoke_script}"
  [[ -f "$smoke_src" ]] || fail "smoke script missing in host-synced repo: ${smoke_src}"

  # The deployed build must BE the SHA the stamps will name (bundle §2).
  local live_commit
  live_commit="$(fetch_health_commit)"
  [[ "$live_commit" == "$DEPLOY_SHA" ]] \
    || fail "staging /api/health build.commit is '${live_commit:-<unreachable>}' but deploy_sha=${DEPLOY_SHA}; refusing to smoke a mismatched build"

  prepare_container_runner
  local admin_id admin_token
  admin_id="$(find_admin_user)"
  admin_token="$(mint_token "$admin_id" 'admin' 'attendance:read,attendance:write,attendance:admin,attendance:approve')"
  log "smoke admin subject: ${admin_id}; stamp: ${stamp}"

  # Window-level settings-restore evidence (bundle §5): settings BEFORE and AFTER.
  capture_settings "$admin_token" "${OUTPUT_DIR}/settings-before.json" >/dev/null

  docker cp "$smoke_src" "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/scripts/ops/${smoke_script}"

  local -a run_env=(
    "BASE_URL=${IN_CONTAINER_BASE_URL}"
    "DEPLOY_SHA=${DEPLOY_SHA}"
    "STAMP=${stamp}"
    "ADMIN_TOKEN=${admin_token}"
  )
  local spec env_name suffix roles perms
  for spec in "${extra_tokens[@]:-}"; do
    [[ -n "$spec" ]] || continue
    env_name="${spec%%:*}"
    suffix="$(printf '%s' "$spec" | cut -d: -f2)"
    roles="$(printf '%s' "$spec" | cut -d: -f3)"
    perms="$(printf '%s' "$spec" | cut -d: -f4-)"
    run_env+=("${env_name}=$(mint_token "${stamp}-${suffix}" "$roles" "$perms")")
  done
  for spec in "${extra_env[@]:-}"; do
    [[ -n "$spec" ]] || continue
    run_env+=("$spec")
  done

  # DATABASE_URL intentionally NOT passed: the container's own env already carries the
  # staging DB URL, which is exactly the API↔DB coherence the helpers assert.
  local -a pipe_status
  set +e
  staging_exec_env "${run_env[@]}" -- node "${CONTAINER_RUNNER_DIR}/scripts/ops/${smoke_script}" \
    < /dev/null 2>&1 | tee "${OUTPUT_DIR}/smoke-${SMOKE_ID}.log"
  pipe_status=("${PIPESTATUS[@]}")
  set -e
  local smoke_rc="${pipe_status[0]}"
  if [[ "${pipe_status[1]}" != "0" ]]; then
    fail "tee failed writing the smoke log (rc=${pipe_status[1]})"
  fi

  capture_settings "$admin_token" "${OUTPUT_DIR}/settings-after.json" >/dev/null

  # Filtered backend log slice for the artifact — zero matches is a normal outcome;
  # a failing `docker logs` must still fail this step (filtered_pipe contract, proven
  # by scripts/ops/attendance-window-runner-pipeline.test.mjs).
  filtered_pipe "${OUTPUT_DIR}/backend-log-slice.log" \
    'attendance|digest|delivery|reminder|overtime|makeup' \
    -- docker logs --since 30m "$BACKEND_CONTAINER"

  snapshot_staging_ps
  {
    echo "action=smoke"
    echo "smoke=${SMOKE_ID}"
    echo "deploy_sha=${DEPLOY_SHA}"
    echo "stamp=${stamp}"
    echo "smoke_rc=${smoke_rc}"
  } > "${OUTPUT_DIR}/summary.txt"

  if [[ "$smoke_rc" != "0" ]]; then
    fail "smoke ${SMOKE_ID} exited rc=${smoke_rc} (full log: smoke-${SMOKE_ID}.log)"
  fi
  log "smoke ${SMOKE_ID} OK (stamp ${stamp})"
}

action_status() {
  snapshot_staging_ps
  curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" > "${OUTPUT_DIR}/health-web.json" 2>&1 \
    || echo "unreachable" > "${OUTPUT_DIR}/health-web.json"
  curl -sS --max-time 10 "$STAGING_BACKEND_HEALTH_URL" > "${OUTPUT_DIR}/health-backend.json" 2>&1 \
    || echo "unreachable" > "${OUTPUT_DIR}/health-backend.json"
  local live_commit
  live_commit="$(fetch_health_commit)"
  log "live build.commit: ${live_commit:-<unreachable>}"

  local status_rc=0
  if docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null | grep -qx 'true'; then
    prepare_container_runner
    staging_exec node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/migrate-list.txt" || status_rc=1
    assert_window_env_flags || status_rc=1
    local admin_id admin_token
    if admin_id="$(find_admin_user)"; then
      admin_token="$(mint_token "$admin_id" 'admin' 'attendance:read,attendance:admin')"
      capture_settings "$admin_token" "${OUTPUT_DIR}/settings-current.json" >/dev/null || status_rc=1
    else
      echo "no active admin user found; settings snapshot skipped" > "${OUTPUT_DIR}/settings-current.json"
    fi
  else
    log "backend container not running; container-side snapshots skipped"
    status_rc=1
  fi

  {
    echo "action=status"
    echo "live_commit=${live_commit:-unreachable}"
    echo "status_rc=${status_rc}"
  } > "${OUTPUT_DIR}/summary.txt"
  return "$status_rc"
}

# --- main ------------------------------------------------------------------------------

mkdir -p "$OUTPUT_DIR"
assert_staging_only

case "$ACTION" in
  deploy) action_deploy ;;
  smoke) action_smoke ;;
  status) action_status ;;
  *) fail "unknown action: ${ACTION} (expected deploy|smoke|status)" ;;
esac
