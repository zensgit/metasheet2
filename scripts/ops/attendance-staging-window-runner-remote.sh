#!/usr/bin/env bash
# attendance-staging-window-runner-remote.sh
#
# Remote (deploy-host) half of .github/workflows/attendance-staging-window-runner.yml.
# Executes ONE action per invocation against the STAGING stack only:
#   deploy         — pin staging backend+web to a full-SHA image tag, migrate, verify build+auth
#   smoke          — run one of the five window smokes in-container (bundle doc:
#                    docs/development/attendance-staging-window-bundle-20260702.md)
#   status         — read-only snapshot (containers, health, settings, pending migrations)
#   migrate        — backup + clone-rehearsal + apply, per
#                    docs/operations/staging-migration-alignment-runbook.md and
#                    docs/development/staging-migration-alignment-runbook-verification-20260519.md.
#                    Only reachable path from a `do_not_run_full_migrate` decision surfaced by
#                    action=deploy's migration-alignment gate: pg_dump the real staging DB to a
#                    HOST file (never uploaded — business data), clone-restore it into a
#                    throwaway `window_runner_rehearsal` DB inside the SAME postgres container,
#                    run migrate.js against ONLY the rehearsal DB, and require it to fully
#                    succeed (pending=0) before ever touching the real staging DB. The rehearsal
#                    DB is always dropped (trap-guarded), including on failure.
#   residue-sweep  — bundle §7 "Consolidated final residue sweep": every §7 cross-smoke SQL
#                    count (users/user_orgs/records/requests/deliveries, OT-bank money-path,
#                    approval-engine, plus the optional MP-6/HMR-5 blocks), run read-only via
#                    `docker exec metasheet-staging-postgres psql -tA`, against the REAL
#                    staging DB (never a rehearsal DB — this action never writes). Fails iff
#                    any count is nonzero. Also captures env flags + GET
#                    /api/attendance/settings into the same artifact. See action_residue_sweep
#                    below for the per-query §7→SQL substitution notes (the bundle's own
#                    `:otbank_approval_ids` / `:otbank_cycle_ids` / `:mp6_request_ids` /
#                    `:mp6_approval_ids` / `:rd45_smoke_org` / `:hmr5_org` placeholders name
#                    captured-id lists the smoke helpers print to logs but never archive to a
#                    file this script can read back — each is replaced by a
#                    stamp/prefix-anchored equivalent query, documented at its call site).
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

hash_value() {
  # sha256 of a file, tool-portable (GNU sha256sum on the deploy host; shasum fallback).
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    fail "no sha256 tool available (need sha256sum or shasum) to hash ${file}"
  fi
}

ACTION="${ACTION:?ACTION is required (deploy|smoke|status|migrate|residue-sweep)}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
SMOKE_ID="${SMOKE_ID:-}"
SET_WINDOW_ENV="${SET_WINDOW_ENV:-none}"
STAMPS="${STAMPS:-}"
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
# Fixed, clearly-synthetic rehearsal DB name for action=migrate. Lives inside the SAME
# postgres container/server as staging, never on a different host, and is always dropped
# (created fresh each run — never assumed to persist).
REHEARSAL_DB="window_runner_rehearsal"
# Host-side backup dir for action=migrate (HOME is writable; the staging repo dir is not
# — proven by run 29313154282, same reason OVERRIDE_FILE above lives under OUTPUT_DIR).
BACKUP_DIR="${HOME}/window-runner-backups"

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
# The override MUST persist across runs. `docker compose up -d` stamps each container's
# com.docker.compose.project.config_files label with the -f paths it was given, so any later
# `docker compose config` (e.g. the recovery-flag containment check) re-reads THIS file BY PATH.
# When the override lived under the per-run $OUTPUT_DIR (which the workflow rm -rf's on cleanup),
# that label dangled and staging's next-restart config became unverifiable — run 29398270060
# FAIL-CLOSED. It still cannot live under ${STAGING_DIR} (the SSH user has no write there — run
# 29313154282 "Permission denied"), so it lives in a stable, deploy-user-writable directory under
# $HOME that the workflow cleanup never touches. Rewritten atomically on each deploy (temp file +
# `docker compose config` validation + rename); set_window_env=none rewrites it WITHOUT the flags,
# preserving the removal semantic.
RUNNER_PERSIST_DIR="${HOME}/.metasheet2/window-runner"
OVERRIDE_FILE="${RUNNER_PERSIST_DIR}/docker-compose.window-runner.override.yml"

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

resolve_backend_database_url() {
  # stdout: the RUNNING staging backend container's own DATABASE_URL (never hardcoded —
  # read from the container's actual env, sourced from docker/app.staging.env on the host).
  local dsn
  dsn="$(docker exec "$BACKEND_CONTAINER" printenv DATABASE_URL 2>/dev/null || true)"
  [[ -n "$dsn" ]] || fail "could not resolve DATABASE_URL from ${BACKEND_CONTAINER}'s own env"
  printf '%s' "$dsn"
}

resolve_postgres_creds() {
  # stdout: "<POSTGRES_USER> <POSTGRES_DB>" resolved from the RUNNING postgres container's
  # own env (never hardcoded — same docker/app.staging.env source as the backend's DSN).
  local pg_user pg_db
  pg_user="$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_USER 2>/dev/null || true)"
  pg_db="$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_DB 2>/dev/null || true)"
  [[ -n "$pg_user" ]] || fail "could not resolve POSTGRES_USER from ${POSTGRES_CONTAINER}'s own env"
  [[ -n "$pg_db" ]] || fail "could not resolve POSTGRES_DB from ${POSTGRES_CONTAINER}'s own env"
  printf '%s %s' "$pg_user" "$pg_db"
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
  # L6 precedent (tracker 2026-06-21 annual-leave staging closeout, re-proven by run
  # 29314093729): the staging stack's env file can pin a stale METASHEET_BUILD_COMMIT,
  # so /api/health build metadata is NOT a reliable deploy identity on staging. The
  # accepted deploy evidence is the CONTAINER IMAGE TAG. Health must still be
  # RESPONDING (fetch_health_commit returned a body above); identity falls back to
  # docker inspect. Fail closed if neither channel matches.
  local live_image
  live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  if [[ "$live_image" == *":${expected}" ]]; then
    if ! curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" | grep -q '"ok":true'; then
      fail "backend image tag matches ${expected} but /api/health is not ok — not accepting image-tag identity for an unhealthy backend"
    fi
    log "health build.commit is stale (env-pinned; L6 precedent) but backend container image tag matches deploy sha: ${live_image}"
    echo "identity_channel=image-tag health_commit_stale=1 live_image=${live_image}" > "${OUTPUT_DIR}/deploy-identity.txt"
    return 0
  fi
  fail "staging deploy identity failed BOTH channels: /api/health build.commit never matched ${expected} AND backend image is '${live_image:-<none>}'"
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
  # callers capture stdout as the code — informational line goes to stderr
  log "GET /api/attendance/settings -> ${http_code} (${out_file})" >&2
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

  # Persistent override, written ATOMICALLY: candidate → validate → rename. The persistent path
  # (RUNNER_PERSIST_DIR under $HOME) survives the workflow's OUTPUT_DIR cleanup, so the container
  # config_files label it stamps never dangles. set_window_env=none takes the branch that omits
  # the flags, so redeploying with none rewrites the SAME file without them (clears the old flags).
  mkdir -p "$RUNNER_PERSIST_DIR"
  local override_tmp
  override_tmp="$(mktemp "${RUNNER_PERSIST_DIR}/.override.XXXXXX.yml")"
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
  } > "$override_tmp"
  # Validate the candidate renders against the staging compose file BEFORE it goes live — a broken
  # override would otherwise dangle EVERY container's config_files label. On failure, keep the
  # previous known-good override untouched and fail closed.
  if ! docker compose -f "$STAGING_COMPOSE_FILE" -f "$override_tmp" config >/dev/null 2>&1; then
    rm -f "$override_tmp"
    fail "candidate override failed 'docker compose config' validation; kept previous override at ${OVERRIDE_FILE}"
  fi
  # Same-directory rename ⇒ atomic replace; a concurrent reader never sees a partial file.
  mv -f "$override_tmp" "$OVERRIDE_FILE"
  log "override written (persistent, atomic): ${OVERRIDE_FILE} (env mode: ${SET_WINDOW_ENV})"

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

  # The deployed build must BE the SHA the stamps will name (bundle §2). Same dual-channel
  # identity as the deploy verifier: staging /api/health build.commit is env-pinned stale
  # (L6 precedent; proven again by run 29378042837), so fall back to the backend container
  # image tag — but only for a HEALTHY backend (health must answer ok:true).
  local live_commit live_image
  live_commit="$(fetch_health_commit)"
  if [[ "$live_commit" != "$DEPLOY_SHA" ]]; then
    live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
    if [[ "$live_image" == "ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${DEPLOY_SHA}" ]] \
       && curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" | grep -q '"ok":true'; then
      log "smoke identity: health build.commit stale ('${live_commit:-<unreachable>}', env-pinned) but backend image tag matches deploy sha: ${live_image}"
    else
      fail "staging identity failed BOTH channels for smoke: /api/health build.commit='${live_commit:-<unreachable>}' and backend image='${live_image:-<none>}' vs deploy_sha=${DEPLOY_SHA}; refusing to smoke a mismatched build"
    fi
  fi

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
    echo "[window-runner][error] smoke ${SMOKE_ID} exited rc=${smoke_rc} (full log: smoke-${SMOKE_ID}.log)" >&2
    exit "$smoke_rc"
  fi
  log "smoke ${SMOKE_ID} OK (stamp ${stamp})"
}

# residue_check <pg_user> <pg_db> <name> <sql>
#
# Runs ONE read-only §7 count query via `docker exec metasheet-staging-postgres psql -tA`
# (tuples-only, unaligned — a bare integer, nothing else) against the REAL staging DB,
# appends "<name>=<value>" to $RESIDUE_RESULTS_FILE, and prints the value to stdout so the
# caller can decide pass/fail. A query that does not come back as a bare integer (bad SQL,
# connection drop, wrong column) is a hard failure — never silently treated as "0 residue".
residue_check() {
  local pg_user="$1" pg_db="$2" name="$3" sql="$4" value
  value="$(docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$pg_db" -v ON_ERROR_STOP=1 -tA -c "$sql" | tr -d '[:space:]')"
  [[ "$value" =~ ^[0-9]+$ ]] \
    || fail "residue-sweep query '${name}' did not return a bare integer (got '${value}'); sql: ${sql}"
  echo "${name}=${value}" >> "$RESIDUE_RESULTS_FILE"
  # stderr, NOT stdout: callers capture this function's stdout as the numeric count, and a
  # stdout log line contaminates the comparison (run 29395824577: all 29 counts were 0 yet
  # the sweep false-FAILED because the captured value was "log-line\n0").
  log "residue-sweep ${name}=${value}" >&2
  printf '%s' "$value"
}

action_residue_sweep() {
  # Bundle §7 "Consolidated final residue sweep (window close)": every count in that SQL
  # block must be 0. This action runs each one individually (not as one multi-statement
  # script) so a single bad query fails closed with its own name, and so the source-contract
  # self-test (scripts/ops/attendance-window-runner-pipeline.test.mjs) can grep this file for
  # each stamp-prefix family independently.
  #
  # STAMPS is "ae4,rd45,otbank,mp6,hmr5" (bundle §1 order). ae4/rd45/otbank are the three
  # core smokes and are REQUIRED (a window always runs them per bundle §4); mp6/hmr5 are the
  # optional 4th/5th smokes and their fields may be empty ("...,otbankstamp,," or
  # "...,otbankstamp,mp6stamp,") when that smoke did not run this window (bundle §1/§8:
  # "skip cleanly if not run").
  [[ -n "$STAMPS" ]] || fail "STAMPS is required for action=residue-sweep (comma-separated ae4,rd45,otbank,mp6,hmr5 stamps — bundle §7)"
  local ae4_stamp rd45_stamp otbank_stamp mp6_stamp hmr5_stamp sentinel
  IFS=',' read -r ae4_stamp rd45_stamp otbank_stamp mp6_stamp hmr5_stamp sentinel <<< "${STAMPS},__sentinel__"
  [[ -n "$ae4_stamp" && -n "$rd45_stamp" && -n "$otbank_stamp" && "$sentinel" == "__sentinel__" ]] \
    || fail "STAMPS must be exactly 5 comma-separated fields (ae4,rd45,otbank,mp6,hmr5) with ae4/rd45/otbank non-empty, got: '${STAMPS}'"
  [[ "$ae4_stamp" =~ ^ae4-smoke-[A-Za-z0-9-]+$ ]] || fail "ae4 stamp must match ^ae4-smoke-[A-Za-z0-9-]+\$, got: '${ae4_stamp}'"
  [[ "$rd45_stamp" =~ ^rd45-smoke-[A-Za-z0-9-]+$ ]] || fail "rd45 stamp must match ^rd45-smoke-[A-Za-z0-9-]+\$, got: '${rd45_stamp}'"
  [[ "$otbank_stamp" =~ ^otbank-v18-smoke-[A-Za-z0-9-]+$ ]] || fail "otbank stamp must match ^otbank-v18-smoke-[A-Za-z0-9-]+\$, got: '${otbank_stamp}'"
  [[ -z "$mp6_stamp" || "$mp6_stamp" =~ ^mp6-smoke-[A-Za-z0-9-]+$ ]] || fail "mp6 stamp must be empty or match ^mp6-smoke-[A-Za-z0-9-]+\$, got: '${mp6_stamp}'"
  [[ -z "$hmr5_stamp" || "$hmr5_stamp" =~ ^hmr5-smoke-[A-Za-z0-9-]+$ ]] || fail "hmr5 stamp must be empty or match ^hmr5-smoke-[A-Za-z0-9-]+\$, got: '${hmr5_stamp}'"

  local pg_user pg_db
  read -r pg_user pg_db <<< "$(resolve_postgres_creds)"

  # Deterministic per-stamp business-key reconstruction (NOT captured-id substitution — these
  # are simple string templates the OT-bank helper builds directly from STAMP, so recomputing
  # them here is exact, not an approximation):
  #   otbank_rule_name      mirrors `${STAMP}-ot-rule`             (smoke script: overtimeRuleName)
  #   otbank_leave_type_code mirrors `${STAMP}-offset`             (smoke script: leaveTypeCode)
  #   otbank_holiday_name    mirrors `${STAMP} statutory holiday`  (smoke script: holidayName)
  #   otbank_poison_lot_key  mirrors `otbank-v18-smoke:${STAMP}:poison-statutory-lot` (poisonLotKey)
  local otbank_rule_name="${otbank_stamp}-ot-rule"
  local otbank_leave_type_code="${otbank_stamp}-offset"
  local otbank_holiday_name="${otbank_stamp} statutory holiday"
  local otbank_poison_lot_key="otbank-v18-smoke:${otbank_stamp}:poison-statutory-lot"
  # MP-6 and OT-bank v1-8 share the window's org (bundle §5 "Org scope"); the remote script's
  # own action_smoke never overrides ORG_ID for either, so both default to 'default' exactly
  # as their smoke scripts do. If a future window ever runs either under an overridden
  # ORG_ID, this constant must move to a workflow input alongside it.
  local window_org="default"
  local otbank_user_prefix="${otbank_stamp}-"
  local mp6_user_prefix="${mp6_stamp}-"

  local results_file="${OUTPUT_DIR}/residue-sweep.txt"
  RESIDUE_RESULTS_FILE="$results_file"
  {
    echo "# attendance-staging-window-runner residue-sweep — bundle §7 consolidated final residue sweep"
    echo "# generated=$(date -u +%Y-%m-%dT%H:%M:%SZ) deploy_sha=${DEPLOY_SHA:-<not provided>}"
    echo "# window-intended-stamps: ae4=${ae4_stamp} rd45=${rd45_stamp} otbank=${otbank_stamp} mp6=${mp6_stamp:-<not run this window>} hmr5=${hmr5_stamp:-<not run this window>}"
  } > "$results_file"

  local -a nonzero=()
  local v

  # -- synthetic users and memberships, core families (bundle §7 ¶1) ---------------------
  v="$(residue_check "$pg_user" "$pg_db" users \
    "SELECT count(*) FROM users WHERE left(id, 10) = 'ae4-smoke-' OR left(id, 11) = 'rd45-smoke-' OR left(id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("users=${v}")
  v="$(residue_check "$pg_user" "$pg_db" user_orgs \
    "SELECT count(*) FROM user_orgs WHERE left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("user_orgs=${v}")

  # -- attendance business rows by stamped meta/user (bundle §7 ¶2) ----------------------
  v="$(residue_check "$pg_user" "$pg_db" records \
    "SELECT count(*) FROM attendance_records WHERE meta->>'smokeStamp' IN ('${ae4_stamp}', '${rd45_stamp}', '${otbank_stamp}') OR left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("records=${v}")
  v="$(residue_check "$pg_user" "$pg_db" requests \
    "SELECT count(*) FROM attendance_requests WHERE metadata->>'smokeStamp' IN ('${ae4_stamp}', '${rd45_stamp}', '${otbank_stamp}') OR left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("requests=${v}")

  # -- shared deliveries table, per source_type + stamped scoping (bundle §7 ¶3) ---------
  v="$(residue_check "$pg_user" "$pg_db" ae4_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries d JOIN attendance_record_result_edits e ON d.source_id = e.id::text AND e.org_id = d.org_id WHERE d.source_type = 'attendance_result_edit' AND left(e.idempotency_key, length('ae4-smoke:${ae4_stamp}:')) = 'ae4-smoke:${ae4_stamp}:';")"
  [[ "$v" == "0" ]] || nonzero+=("ae4_deliveries=${v}")
  # SUBSTITUTION: bundle §7 uses `org_id = :rd45_smoke_org` (a single captured org id, default
  # "<STAMP>-org", never archived to a file this script can read). RD-4/5's own smoke script
  # (staging-attendance-report-digest-rd45-smoke.mjs) enforces `ORG_ID.startsWith('rd45-smoke-')`
  # for every TRIGGER_MODE=seam run, so every RD-4/5 disposable org — not just this run's
  # default-named one — carries the "rd45-smoke-" prefix (bundle §5 table). Scoping on that
  # PREFIX instead of the one derived org id is strictly broader (also catches an operator
  # ORG_ID override, or a leftover disposable org from an earlier unswept window) while never
  # matching a real org (prefixes are mutually exclusive by construction — bundle §5).
  v="$(residue_check "$pg_user" "$pg_db" rd45_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE source_type = 'attendance_report_digest' AND left(org_id, 11) = 'rd45-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("rd45_deliveries=${v}")
  v="$(residue_check "$pg_user" "$pg_db" stray_deliveries_to_smoke_users \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE left(recipient_user_id, 10) = 'ae4-smoke-' OR left(recipient_user_id, 11) = 'rd45-smoke-' OR left(recipient_user_id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("stray_deliveries_to_smoke_users=${v}")

  # -- OT-bank money-path tables (bundle §7 ¶4) -------------------------------------------
  # SUBSTITUTION: bundle §7 uses `cycle_id = ANY(:otbank_cycle_ids::uuid[])` (captured cycle
  # ids, never archived). The OT-bank smoke script stamps every cycle it creates with
  # `metadata->>'smokeStamp' = STAMP` (same column the sibling `cycles` query below already
  # keys on), so the cycle-id list is reconstructed exactly — not approximated — via a
  # subquery on that same metadata key, scoped to the two smokes that ever write a cycle row
  # (AE-4 SQL-seeds one stamped closed cycle for its 409 guard — bundle §5 "Payroll cycles").
  v="$(residue_check "$pg_user" "$pg_db" settlements \
    "SELECT count(*) FROM attendance_payroll_cycle_settlements WHERE cycle_id IN (SELECT id FROM attendance_payroll_cycles WHERE metadata->>'smokeStamp' IN ('${ae4_stamp}', '${otbank_stamp}'));")"
  [[ "$v" == "0" ]] || nonzero+=("settlements=${v}")
  v="$(residue_check "$pg_user" "$pg_db" cycles \
    "SELECT count(*) FROM attendance_payroll_cycles WHERE metadata->>'smokeStamp' IN ('${ae4_stamp}', '${otbank_stamp}');")"
  [[ "$v" == "0" ]] || nonzero+=("cycles=${v}")
  v="$(residue_check "$pg_user" "$pg_db" lots \
    "SELECT count(*) FROM attendance_leave_balances WHERE left(user_id, 17) = 'otbank-v18-smoke-' OR source_key = '${otbank_poison_lot_key}';")"
  [[ "$v" == "0" ]] || nonzero+=("lots=${v}")
  v="$(residue_check "$pg_user" "$pg_db" fixtures \
    "SELECT count(*) FROM attendance_overtime_rules WHERE name = '${otbank_rule_name}';")"
  [[ "$v" == "0" ]] || nonzero+=("fixtures=${v}")
  v="$(residue_check "$pg_user" "$pg_db" leave_types \
    "SELECT count(*) FROM attendance_leave_types WHERE code = '${otbank_leave_type_code}';")"
  [[ "$v" == "0" ]] || nonzero+=("leave_types=${v}")
  v="$(residue_check "$pg_user" "$pg_db" holidays \
    "SELECT count(*) FROM attendance_holidays WHERE name = '${otbank_holiday_name}';")"
  [[ "$v" == "0" ]] || nonzero+=("holidays=${v}")

  # -- approval-engine rows written by the v1-8 request chain (bundle §7 ¶5) -------------
  # SUBSTITUTION: bundle §7 uses `id = ANY(:otbank_approval_ids::text[])` (captured approval
  # instance ids, never archived). attendance_requests.approval_instance_id (text) links a
  # request to its approval_instances row; every OT-bank v1-8 request is created by a
  # STAMP-prefixed user (USER_PREFIX = `${STAMP}-` in the smoke script), so joining through
  # requests scoped by that prefix reconstructs the exact same approval-instance set the
  # bundle's captured-id list would have named — this is the literal "approval rows joined to
  # requests/users with smoke prefixes" substitution the task calls for.
  v="$(residue_check "$pg_user" "$pg_db" approval_instances \
    "SELECT count(*) FROM approval_instances ai JOIN attendance_requests r ON r.approval_instance_id = ai.id WHERE left(r.user_id, ${#otbank_user_prefix}) = '${otbank_user_prefix}';")"
  [[ "$v" == "0" ]] || nonzero+=("approval_instances=${v}")

  # -- MP-6 makeup-punch (optional 4th smoke) — subject-scoped, family-prefix 'mp6-smoke-'
  # (10 chars). These always run (not gated on mp6_stamp being provided): the prefix is
  # global to the MP-6 family, not this run's stamp, so it also catches leftover rows from
  # an earlier unswept window — a strictly safer sweep than skipping when this window didn't
  # run MP-6 (bundle §7 ¶6).
  v="$(residue_check "$pg_user" "$pg_db" mp6_requests \
    "SELECT count(*) FROM attendance_requests WHERE org_id = '${window_org}' AND left(user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_requests=${v}")
  v="$(residue_check "$pg_user" "$pg_db" mp6_records \
    "SELECT count(*) FROM attendance_records WHERE org_id = '${window_org}' AND left(user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_records=${v}")
  # SUBSTITUTION: bundle §7 uses `meta->>'requestId' = ANY(:mp6_request_ids::text[])`
  # (captured request ids, never archived) — replaced by the same requests-family-prefix join
  # as approval_instances above, scoped to the MP-6 family prefix ('mp6-smoke-', 10 chars)
  # rather than one run's stamp, for the same "catches earlier leftovers too" reason.
  v="$(residue_check "$pg_user" "$pg_db" mp6_events \
    "SELECT count(*) FROM attendance_events e WHERE e.org_id = '${window_org}' AND EXISTS (SELECT 1 FROM attendance_requests r WHERE r.id::text = e.meta->>'requestId' AND r.org_id = e.org_id AND left(r.user_id, 10) = 'mp6-smoke-');")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_events=${v}")
  # SUBSTITUTION: bundle §7 uses `id = ANY(:mp6_approval_ids::text[])` (captured approval
  # instance ids, never archived) — replaced by the requests-family-prefix join, same
  # reasoning as approval_instances above.
  v="$(residue_check "$pg_user" "$pg_db" mp6_approval_instances \
    "SELECT count(*) FROM approval_instances ai JOIN attendance_requests r ON r.approval_instance_id = ai.id WHERE r.org_id = '${window_org}' AND left(r.user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_approval_instances=${v}")
  v="$(residue_check "$pg_user" "$pg_db" mp6_users \
    "SELECT count(*) FROM users WHERE left(id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_users=${v}")
  v="$(residue_check "$pg_user" "$pg_db" mp6_user_orgs \
    "SELECT count(*) FROM user_orgs WHERE left(user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_user_orgs=${v}")
  # MP-6 writes NO deliveries — this must be 0 (never delete/query by source_type alone).
  v="$(residue_check "$pg_user" "$pg_db" mp6_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE org_id = '${window_org}' AND left(recipient_user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_deliveries=${v}")

  # -- HMR-5 manual missed-punch reminder (optional 5th smoke) — disposable-org scoped.
  # SUBSTITUTION: bundle §7 uses `:hmr5_org` (default "<STAMP>-org", a single captured org id)
  # for every org-scoped HMR-5 query. Same reasoning as rd45_deliveries above: HMR-5's own
  # smoke script enforces `ORG_ID.startsWith('hmr5-smoke-')`, so scoping on the "hmr5-smoke-"
  # prefix (11 chars) is a strictly broader, always-safe generalization of the one derived org
  # id — it needs no stamp at all, so (unlike the deliberately-skippable per-runbook PASS
  # stamps) these queries always run, including when HMR-5 did not run this window.
  v="$(residue_check "$pg_user" "$pg_db" hmr5_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE left(org_id, 11) = 'hmr5-smoke-' AND source_type = 'manual_missed_punch_reminder';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_deliveries=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_stray_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE left(recipient_user_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_stray_deliveries=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_requests \
    "SELECT count(*) FROM attendance_requests WHERE left(org_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_requests=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_records \
    "SELECT count(*) FROM attendance_records WHERE left(org_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_records=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_scopes \
    "SELECT count(*) FROM attendance_scheduler_scopes WHERE left(org_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_scopes=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_user_orgs \
    "SELECT count(*) FROM user_orgs WHERE left(org_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_user_orgs=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_user_roles \
    "SELECT count(*) FROM user_roles WHERE left(user_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_user_roles=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_users \
    "SELECT count(*) FROM users WHERE left(id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_users=${v}")

  # -- env flags + settings baseline capture, same artifact (owner ask: confirm the
  # env-switch and settings baseline alongside the residue counts, not in a separate run).
  # A live ATTENDANCE_REPORT_DIGEST_ENABLED=true is a real §3.4 violation (never allowed for
  # the whole window), so it flips the sweep result to FAIL like any other nonzero count —
  # but it must not abort mid-sweep and skip the remaining §7 counts, so capture the outcome
  # instead of letting `set -e` propagate it.
  local env_flags_ok=1
  assert_window_env_flags || env_flags_ok=0
  if [[ "$env_flags_ok" != "1" ]]; then
    nonzero+=("env_flags_violation=1")
  fi
  prepare_container_runner
  local admin_id admin_token
  if admin_id="$(find_admin_user)"; then
    admin_token="$(mint_token "$admin_id" 'admin' 'attendance:read,attendance:admin')"
    capture_settings "$admin_token" "${OUTPUT_DIR}/settings-sweep.json" >/dev/null || true
  else
    echo "no active admin user found; settings snapshot skipped" > "${OUTPUT_DIR}/settings-sweep.json"
  fi

  local result="ok" nonzero_list="none"
  if [[ "${#nonzero[@]}" -gt 0 ]]; then
    result="FAIL"
    nonzero_list="$(IFS=,; echo "${nonzero[*]}")"
  fi

  {
    echo "checks_total=29"
    echo "result=${result}"
    echo "nonzero=${nonzero_list}"
  } >> "$results_file"
  {
    echo "action=residue-sweep"
    echo "deploy_sha=${DEPLOY_SHA:-}"
    echo "stamps=${STAMPS}"
    echo "result=${result}"
    echo "nonzero=${nonzero_list}"
  } > "${OUTPUT_DIR}/summary.txt"

  echo "CONSOLIDATED_RESIDUE_SWEEP result=${result} nonzero=${nonzero_list}"

  if [[ "$result" != "ok" ]]; then
    fail "residue sweep found nonzero residue: ${nonzero_list} (see residue-sweep.txt in the artifact; bundle §7 requires every count to be 0 before window close)"
  fi
  log "residue-sweep OK: all 29 §7 checks are zero"
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

action_migrate_backup() {
  # Step 2 of the runbook-compliant sequence: pg_dump the REAL staging DB to a HOST file
  # (never the staging repo dir — not writable by this SSH user; never uploaded as a CI
  # artifact — it contains business data). Records sha256 + byte size + path only.
  # Here-string (not `< <(...)` process substitution): bash appends a trailing newline
  # when feeding a here-string, so `read` sees a complete line and exits 0 even though
  # resolve_postgres_creds's printf has no trailing \n. With process substitution instead,
  # `read` would hit EOF before a newline and return 1, tripping `set -e`.
  local pg_user pg_db
  read -r pg_user pg_db <<< "$(resolve_postgres_creds)"

  mkdir -p "$BACKUP_DIR"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  MIGRATE_BACKUP_PATH="${BACKUP_DIR}/staging-${ts}-pre-migrate.dump"

  log "backup: pg_dump -Fc -U ${pg_user} ${pg_db} -> ${MIGRATE_BACKUP_PATH}"
  docker exec "$POSTGRES_CONTAINER" pg_dump -Fc -U "$pg_user" "$pg_db" > "$MIGRATE_BACKUP_PATH"
  [[ -s "$MIGRATE_BACKUP_PATH" ]] \
    || fail "backup file is empty: ${MIGRATE_BACKUP_PATH}; refusing to proceed without a working backup (runbook: pg_dump first is non-negotiable)"

  MIGRATE_BACKUP_SHA256="$(hash_value "$MIGRATE_BACKUP_PATH")"
  MIGRATE_BACKUP_BYTES="$(wc -c < "$MIGRATE_BACKUP_PATH" | tr -d '[:space:]')"
  MIGRATE_BACKUP_PG_USER="$pg_user"
  MIGRATE_BACKUP_PG_DB="$pg_db"

  {
    echo "path=${MIGRATE_BACKUP_PATH}"
    echo "sha256=${MIGRATE_BACKUP_SHA256}"
    echo "bytes=${MIGRATE_BACKUP_BYTES}"
    echo "pg_user=${pg_user}"
    echo "pg_db=${pg_db}"
    echo "note=dump stays on the deploy host at the path above; NOT uploaded (business data, public-repo artifacts are world-downloadable); retention is an operator decision"
  } > "${OUTPUT_DIR}/backup-metadata.txt"
  log "backup OK: ${MIGRATE_BACKUP_BYTES} bytes, sha256=${MIGRATE_BACKUP_SHA256} (dump stays on host, not uploaded)"
}

action_migrate_rehearse() {
  # Step 3: clone-rehearsal. Restores the just-taken backup into a throwaway DB inside
  # the SAME postgres container/server, then runs migrate.js against ONLY that DB. The
  # real staging DB is never touched by this function. The rehearsal DB (and the
  # container-local copy of the dump used to restore it) are ALWAYS removed on exit —
  # trap-guarded so an abort mid-rehearsal still cleans up.
  # Globals (NOT locals): the EXIT trap must see these under every bash invocation mode
  # (function locals are not reliably visible to traps under `bash -c`). Review P3, round 6.
  REHEARSAL_PG_USER="$MIGRATE_BACKUP_PG_USER"
  REHEARSAL_CONTAINER_DUMP_PATH="${CONTAINER_RUNNER_DIR}/rehearsal-${RUN_STAMP}.dump"
  local pg_user="$REHEARSAL_PG_USER"
  local container_dump_path="$REHEARSAL_CONTAINER_DUMP_PATH"

  cleanup_rehearsal() {
    # Fixed synthetic name only — this can never name the real staging DB.
    docker exec "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_PG_USER" -d postgres -v ON_ERROR_STOP=0 \
      -c "DROP DATABASE IF EXISTS ${REHEARSAL_DB};" >/dev/null 2>&1 || true
    docker exec "$POSTGRES_CONTAINER" rm -f "$REHEARSAL_CONTAINER_DUMP_PATH" >/dev/null 2>&1 || true
  }

  log "rehearsal: dropping any prior ${REHEARSAL_DB} left by an aborted run"
  cleanup_rehearsal
  trap cleanup_rehearsal EXIT

  log "rehearsal: creating ${REHEARSAL_DB} (clearly-synthetic fixed name; same postgres server as staging)"
  docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE ${REHEARSAL_DB};" 2>&1 | tee "${OUTPUT_DIR}/rehearsal-create-db.log"

  log "rehearsal: copying the backup into the postgres container (pg_restore -j needs a seekable file, not stdin)"
  docker exec "$POSTGRES_CONTAINER" mkdir -p "$CONTAINER_RUNNER_DIR"
  docker cp "$MIGRATE_BACKUP_PATH" "${POSTGRES_CONTAINER}:${container_dump_path}"

  log "rehearsal: restoring into ${REHEARSAL_DB}"
  # The audit-log partitions inherit a row trigger from their partitioned parent
  # (set_retention_period), which lives in the PRE-data section and fires during COPY,
  # querying audit_retention_policies before it is restored (run 29340321213).
  # pg_restore --disable-triggers is only honored in DATA-ONLY restores and is silently
  # inert in a full restore (empirically falsified in run 29347058494). The mechanism
  # that actually holds for a full parallel restore: DB-level
  # session_replication_role=replica (normal triggers do not fire in replica mode; the
  # DB-level GUC binds every -j worker connection). RESET before the rehearsal migrate
  # so migrations run under normal trigger semantics (faithful rehearsal).
  docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE ${REHEARSAL_DB} SET session_replication_role = 'replica';"
  docker exec "$POSTGRES_CONTAINER" pg_restore -j 2 -U "$pg_user" -d "$REHEARSAL_DB" "$container_dump_path" \
    2>&1 | tee "${OUTPUT_DIR}/rehearsal-restore.log"
  docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE ${REHEARSAL_DB} RESET session_replication_role;"

  local backend_dsn rehearsal_dsn
  backend_dsn="$(resolve_backend_database_url)"
  rehearsal_dsn="$(dsn_replace_database "$backend_dsn" "$REHEARSAL_DB")"

  # Channel-independent isolation guard (review P2, round 6): the -e DATABASE_URL override
  # only isolates if migrate.js resolves its DSN from process.env (SECRET_PROVIDER=env).
  # Under file/vault providers the override is SILENTLY IGNORED and the "rehearsal" would
  # migrate the REAL staging DB. Defend independently of that channel: count applied
  # migrations in BOTH DBs via direct psql before and after the rehearsal run, and require
  # the real DB's count to be UNCHANGED and the rehearsal DB's to have ADVANCED.
  count_applied() { # count_applied <db-name>
    docker exec "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_PG_USER" -d "$1" -tA \
      -c "SELECT COALESCE((SELECT count(*) FROM kysely_migration), 0);" 2>/dev/null | tr -d '[:space:]'
  }
  local real_db real_before rehearsal_before real_after rehearsal_after
  real_db="$(dsn_database_name "$backend_dsn")"
  [[ -n "$real_db" && "$real_db" != "$REHEARSAL_DB" ]] \
    || fail "could not resolve the real staging DB name distinct from the rehearsal DB (got '${real_db:-<empty>}')"
  real_before="$(count_applied "$real_db")"
  rehearsal_before="$(count_applied "$REHEARSAL_DB")"
  [[ "$real_before" =~ ^[0-9]+$ && "$rehearsal_before" =~ ^[0-9]+$ ]] \
    || fail "pre-rehearsal applied-migration counts unreadable (real='${real_before}' rehearsal='${rehearsal_before}')"
  log "rehearsal isolation baseline: applied(real ${real_db})=${real_before} applied(${REHEARSAL_DB})=${rehearsal_before}"

  log "rehearsal: running migrate.js against the REHEARSAL DB only (staging DB untouched so far)"
  staging_exec_env "DATABASE_URL=${rehearsal_dsn}" -- node "$MIGRATE_JS" < /dev/null 2>&1 \
    | tee "${OUTPUT_DIR}/rehearsal-migrate-run.log"

  real_after="$(count_applied "$real_db")"
  rehearsal_after="$(count_applied "$REHEARSAL_DB")"
  log "rehearsal isolation check: applied(real ${real_db}) ${real_before}->${real_after}; applied(${REHEARSAL_DB}) ${rehearsal_before}->${rehearsal_after}"
  {
    echo "real_db=${real_db} real_before=${real_before} real_after=${real_after}"
    echo "rehearsal_before=${rehearsal_before} rehearsal_after=${rehearsal_after}"
  } > "${OUTPUT_DIR}/rehearsal-isolation-check.txt"
  [[ "$real_after" == "$real_before" ]] \
    || fail "ISOLATION BREACH: real staging DB applied-migration count changed ${real_before}->${real_after} during the rehearsal run — the DATABASE_URL override was ignored (non-env secret provider?). STOP; restore from ${MIGRATE_BACKUP_PATH} per runbook before ANY further action"
  [[ "$rehearsal_after" -gt "$rehearsal_before" || "$rehearsal_after" -ge "$real_before" ]] \
    || fail "rehearsal DB applied count did not advance (${rehearsal_before}->${rehearsal_after}) — the rehearsal migrate did not actually run against ${REHEARSAL_DB}; refusing to treat rehearsal as green"

  log "rehearsal: confirming pending=0 against the rehearsal DB"
  staging_exec_env "DATABASE_URL=${rehearsal_dsn}" -- node "$MIGRATE_JS" --list < /dev/null 2>&1 \
    | tee "${OUTPUT_DIR}/rehearsal-migrate-list-after.txt"
  grep -q '^Pending: 0$' "${OUTPUT_DIR}/rehearsal-migrate-list-after.txt" \
    || fail "rehearsal migrate run did not leave the rehearsal DB at pending=0 (see rehearsal-migrate-list-after.txt); staging DB was NOT touched, stopping per the runbook"

  log "rehearsal: green — dropping ${REHEARSAL_DB} and the in-container dump copy"
  cleanup_rehearsal
  trap - EXIT
  log "rehearsal OK"
}

action_migrate_apply() {
  # Step 4: only reached if action_migrate_rehearse fully succeeded. Same before/after
  # pending-list discipline as action_deploy's migration step, against the REAL staging DB.
  log "apply: migrate-list BEFORE (real staging DB)"
  staging_exec node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/apply-migrate-list-before.txt"

  log "apply: running migrate.js against the REAL staging DB (rehearsal was green)"
  staging_exec node "$MIGRATE_JS" < /dev/null 2>&1 | tee "${OUTPUT_DIR}/apply-migrate-run.log"

  staging_exec node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/apply-migrate-list-after.txt"
  grep -q '^Pending: 0$' "${OUTPUT_DIR}/apply-migrate-list-after.txt" \
    || fail "staging migrate did not end at pending=0 after apply (see apply-migrate-list-after.txt); restore from ${MIGRATE_BACKUP_PATH} if needed (runbook §Failure modes)"
  log "apply OK: staging migrate ended at pending=0"
}

action_migrate() {
  prepare_container_runner
  action_migrate_backup
  action_migrate_rehearse
  action_migrate_apply

  # Step 5: post-checks.
  curl -fsS --max-time 10 "$STAGING_WEB_HEALTH_URL" > "${OUTPUT_DIR}/health-web.json" \
    || fail "post-apply health check failed: ${STAGING_WEB_HEALTH_URL} unreachable"
  grep -q '"ok":true' "${OUTPUT_DIR}/health-web.json" \
    || fail "post-apply health check did not report ok:true (see health-web.json)"
  auth_round_trip
  snapshot_staging_ps

  {
    echo "action=migrate"
    echo "backup_path=${MIGRATE_BACKUP_PATH}"
    echo "backup_sha256=${MIGRATE_BACKUP_SHA256}"
    echo "backup_bytes=${MIGRATE_BACKUP_BYTES}"
    echo "rehearsal_db=${REHEARSAL_DB}"
    echo "rehearsal_result=ok"
    echo "apply_result=ok"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  log "migrate OK: backup=${MIGRATE_BACKUP_PATH} rehearsal=ok apply=ok"
}

# --- main ------------------------------------------------------------------------------

mkdir -p "$OUTPUT_DIR"
assert_staging_only

case "$ACTION" in
  deploy) action_deploy ;;
  smoke) action_smoke ;;
  status) action_status ;;
  migrate) action_migrate ;;
  residue-sweep) action_residue_sweep ;;
  *) fail "unknown action: ${ACTION} (expected deploy|smoke|status|migrate|residue-sweep)" ;;
esac
