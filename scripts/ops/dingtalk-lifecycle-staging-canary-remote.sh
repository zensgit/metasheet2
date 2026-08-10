#!/usr/bin/env bash
# dingtalk-lifecycle-staging-canary-remote.sh
#
# Remote (deploy-host) half of .github/workflows/dingtalk-lifecycle-staging-canary.yml.
# Executes ONE action per invocation against the STAGING stack only.
#
# EXECUTABLE (minimal safe lane):
#   status     — read-only snapshot (values-free closed booleans / SHA / health)
#   preflight  — read-only readiness for a target mode; never applies env flips
#   off        — emergency operational rollback of the THREE lifecycle env gates
#                to OFF (only permitted env write). Atomic previous-override
#                backup + restore on restart/health/mode failure.
#
# NOT EXECUTABLE (fail-closed preflight-only; transition_applied always false):
#   alias / pending / deprovision
#     Env flips alone are NOT a canary. There is no secret-backed real verifier
#     for password-login success/rollback, admit→activate, or sync→deprovision.
#     Presence tokens must not pretend to drive those paths. These actions only
#     emit a preflight assessment and refuse apply.
#
# HARD SAFETY RAILS:
#   * Staging compose + metasheet-staging-* containers only; no prod fallback.
#   * migrations_pending_zero must be exactly "true" for preflight_ok and for
#     action=off (unknown is a fail, never treated as success).
#   * action=off: recreate backend only; prove postgres/redis IDs unchanged;
#     require backend health true after restart; prove exact mode=off; restore
#     previous override and re-recreate on any failure after the write.
#   * multi-on: status/preflight report and fail closed; action=off still clears
#     the exact three flags (does not die in derive_mode before clear).
#   * Artifacts never contain env values, credentials, subject ids, or PII.
#   * Invoked as `bash -o pipefail -c '<script>'`.
set -euo pipefail

log() { echo "[lifecycle-canary] $*"; }
fail() { echo "[lifecycle-canary][error] $*" >&2; exit 1; }

ACTION="${ACTION:?ACTION is required (status|preflight|off|alias|pending|deprovision)}"
TARGET_MODE="${TARGET_MODE:-}"
EXPECTED_CURRENT_MODE="${EXPECTED_CURRENT_MODE:-}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
STAGING_DEPLOY_PATH="${STAGING_DEPLOY_PATH:-metasheet2-dingtalk-staging}"
DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
OUTPUT_DIR="${OUTPUT_DIR:?OUTPUT_DIR is required}"
RUN_STAMP="${RUN_STAMP:?RUN_STAMP is required (workflow run id marker)}"

# Intentionally ignored: not a real verifier path. Kept empty so accidental
# exports cannot be mistaken for canary completion evidence.
# CANARY_SUBJECT_ID / CANARY_INTEGRATION_ID / OWNER_CONFIRM are NOT used.

BACKEND_CONTAINER="metasheet-staging-backend"
WEB_CONTAINER="metasheet-staging-web"
POSTGRES_CONTAINER="metasheet-staging-postgres"
REDIS_CONTAINER="metasheet-staging-redis"
STAGING_WEB_HEALTH_URL="http://127.0.0.1:8082/api/health"
STAGING_BACKEND_HEALTH_URL="http://127.0.0.1:18900/health"
MIGRATE_JS="packages/core-backend/dist/src/db/migrate.js"

FLAG_ALIAS="AUTH_LOGIN_USE_ALIASES"
FLAG_PENDING="DIRECTORY_PENDING_ACTIVATION_ENABLED"
FLAG_DEPROVISION="DIRECTORY_DEPROVISION_ENABLED"

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

ATTENDANCE_PERSIST_DIR="${HOME}/.metasheet2/window-runner"
ATTENDANCE_OVERRIDE_FILE="${ATTENDANCE_PERSIST_DIR}/docker-compose.window-runner.override.yml"

LIFECYCLE_PERSIST_DIR="${HOME}/.metasheet2/lifecycle-canary"
LIFECYCLE_OVERRIDE_FILE="${LIFECYCLE_PERSIST_DIR}/docker-compose.lifecycle-canary.override.yml"
# Previous-override backup used only during action=off for restore-on-failure.
LIFECYCLE_PREV_BACKUP=""
LIFECYCLE_PREV_STATE="absent" # absent | present

is_truthy() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$v" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

# --- staging-only guard (fail closed) -------------------------------------------------
assert_staging_only() {
  [[ -d "$STAGING_DIR" ]] || fail "staging stack directory missing: ${STAGING_DIR} (set STAGING_DEPLOY_PATH); refusing to guess"
  [[ -f "$STAGING_COMPOSE_FILE" ]] || fail "staging compose file missing: ${STAGING_COMPOSE_FILE}; fail closed — this runner never falls back to another compose file"
  grep -q "container_name: ${BACKEND_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "compose file does not define ${BACKEND_CONTAINER}; refusing (wrong file?)"
  grep -q "container_name: ${WEB_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "compose file does not define ${WEB_CONTAINER}; refusing (wrong file?)"
  grep -q "container_name: ${POSTGRES_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "compose file does not define ${POSTGRES_CONTAINER}; refusing (wrong file?)"
  grep -q "container_name: ${REDIS_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "compose file does not define ${REDIS_CONTAINER}; refusing (wrong file?)"
  if grep -qE 'container_name: metasheet-(backend|web|postgres|redis)[[:space:]]*$' "$STAGING_COMPOSE_FILE"; then
    fail "compose file defines PROD-track container names; refusing"
  fi
  if [[ "$STAGING_DIR" == "$PROD_REPO_DIR" ]]; then
    fail "staging stack dir equals the prod-track repo dir (${STAGING_DIR}); refusing"
  fi
  if [[ "$(basename "$STAGING_COMPOSE_FILE")" != "docker-compose.app.staging.yml" ]]; then
    fail "compose basename is not docker-compose.app.staging.yml; refusing production fallback"
  fi
  log "staging-only guard OK: dir=${STAGING_DIR} compose=$(basename "$STAGING_COMPOSE_FILE")"
}

require_compose_v2() {
  if docker compose version >/dev/null 2>&1; then
    return 0
  fi
  fail "docker compose v2 plugin is required"
}

resolve_live_backend_image_pin() {
  local live_image
  live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  if [[ "$live_image" =~ ^ghcr\.io/([A-Za-z0-9._-]+)/metasheet2-backend:([0-9a-f]{40})$ ]]; then
    printf '%s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

compose_staging_cmd() {
  # compose_staging_cmd [override_file_or_empty] <compose args...>
  local override_arg="${1:-}"
  local image_pin image_owner image_tag
  shift || true
  local -a files=(-f "$STAGING_COMPOSE_FILE")
  if [[ -f "$ATTENDANCE_OVERRIDE_FILE" ]]; then
    files+=(-f "$ATTENDANCE_OVERRIDE_FILE")
  fi
  if [[ -n "$override_arg" ]]; then
    files+=(-f "$override_arg")
  elif [[ -f "$LIFECYCLE_OVERRIDE_FILE" ]]; then
    files+=(-f "$LIFECYCLE_OVERRIDE_FILE")
  fi
  if ! image_pin="$(resolve_live_backend_image_pin)"; then
    echo "[lifecycle-canary][error] running backend image is not an exact ghcr.io owner/metasheet2-backend:<40-sha> pin; refusing compose" >&2
    return 1
  fi
  read -r image_owner image_tag <<< "$image_pin"
  (cd "$STAGING_DIR" && IMAGE_OWNER="$image_owner" IMAGE_TAG="$image_tag" docker compose "${files[@]}" "$@")
}

require_sha() {
  [[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || fail "deploy_sha must be the FULL 40-char lowercase commit SHA, got: '${DEPLOY_SHA}'"
}

fetch_health_commit() {
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

fetch_backend_health_ok() {
  local body
  if ! body="$(curl -fsS --max-time 10 "$STAGING_BACKEND_HEALTH_URL" 2>/dev/null)"; then
    printf 'false'
    return 0
  fi
  printf '%s' "$body" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print("true" if d.get("ok") is True or d.get("status")=="ok" else "false")
except Exception:
    print("false")'
}

resolve_deployed_sha() {
  local live_image image_commit="" health_commit=""
  live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  if [[ "$live_image" =~ :([0-9a-f]{40})$ ]]; then
    image_commit="${BASH_REMATCH[1]}"
  fi
  health_commit="$(fetch_health_commit)"

  # Exact proof requires both sources and agreement. Accepting either source alone would turn
  # missing/stale health metadata or an unpinned image tag into a false exact-SHA proof.
  if [[ -n "$image_commit" && "$health_commit" =~ ^[0-9a-f]{40}$ ]]; then
    if [[ "$image_commit" == "$health_commit" ]]; then
      printf '%s' "$image_commit"
    else
      printf 'conflict'
    fi
    return 0
  fi
  printf 'unknown'
}

read_flag_from_container() {
  local key="$1" val
  val="$(docker exec "$BACKEND_CONTAINER" printenv "$key" 2>/dev/null || true)"
  if is_truthy "$val"; then
    printf 'true'
  else
    printf 'false'
  fi
}

# Classify mode. NEVER fails on multi-on — returns mode "multi-on" so action=off
# can still clear. status/preflight fail closed separately after reporting.
classify_mode_from_flags() {
  local alias_on="$1" pending_on="$2" deprov_on="$3"
  local count=0 mode="off"
  if [[ "$alias_on" == "true" ]]; then count=$((count + 1)); mode="alias"; fi
  if [[ "$pending_on" == "true" ]]; then count=$((count + 1)); mode="pending"; fi
  if [[ "$deprov_on" == "true" ]]; then count=$((count + 1)); mode="deprovision"; fi
  if [[ "$count" -gt 1 ]]; then
    printf 'multi-on'
    return 0
  fi
  printf '%s' "$mode"
}

read_live_flags() {
  # stdout: "alias_on pending_on deprov_on mode" — mode may be multi-on
  local a p d m
  a="$(read_flag_from_container "$FLAG_ALIAS")"
  p="$(read_flag_from_container "$FLAG_PENDING")"
  d="$(read_flag_from_container "$FLAG_DEPROVISION")"
  m="$(classify_mode_from_flags "$a" "$p" "$d")"
  printf '%s %s %s %s' "$a" "$p" "$d" "$m"
}

probe_alias_readiness() {
  local out
  if ! docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null | grep -qx 'true'; then
    printf 'false'
    return 0
  fi
  out="$(docker exec "$BACKEND_CONTAINER" node -e '
const { Client } = require("pg");
(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { process.stdout.write("false"); process.exit(0); }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await c.connect();
    const r = await c.query(`
      SELECT count(*)::int AS n
        FROM users u
        JOIN user_login_aliases a ON a.user_id = u.id
        JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = $1
       WHERE u.is_active = TRUE
         AND COALESCE(u.local_password_set, TRUE) = TRUE
         AND COALESCE(u.activation_status, $2) = $2
         AND u.password_hash IS NOT NULL
         AND length(trim(u.password_hash)) > 0
         AND u.password_hash NOT LIKE $3
    `, ["admin", "activated", "unusable:%"]);
    process.stdout.write((r.rows[0]?.n ?? 0) > 0 ? "true" : "false");
  } catch {
    process.stdout.write("false");
  } finally {
    try { await c.end(); } catch { /* ignore */ }
  }
})().catch(() => { process.stdout.write("false"); });
' 2>/dev/null || true)"
  if [[ "$out" == "true" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

# Returns exactly one of: true | false | unknown
# unknown MUST fail preflight and transitions — never treated as success.
probe_migration_pending_zero() {
  if ! docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null | grep -qx 'true'; then
    printf 'unknown'
    return 0
  fi
  local list
  if ! list="$(docker exec "$BACKEND_CONTAINER" node "$MIGRATE_JS" --list < /dev/null 2>/dev/null)"; then
    printf 'unknown'
    return 0
  fi
  if ! printf '%s\n' "$list" | grep -qE '^Pending:'; then
    # list ran but did not emit the expected contract line → probe failed
    printf 'unknown'
    return 0
  fi
  if printf '%s\n' "$list" | grep -q '^Pending: 0$'; then
    printf 'true'
  else
    printf 'false'
  fi
}

require_migrations_pending_zero_true() {
  # Load-bearing for every transition (currently only action=off) and for preflight_ok.
  local v="$1" context="$2"
  if [[ "$v" == "true" ]]; then
    return 0
  fi
  if [[ "$v" == "false" ]]; then
    fail "${context}: migrations_pending_zero must be exactly true (got false — pending migrations; run attendance staging migrate backup/clone-rehearsal first)"
  fi
  fail "${context}: migrations_pending_zero must be exactly true (got '${v}' — probe unknown/failed; refuse, do not treat unknown as success)"
}

validate_mode_name() {
  local m="$1" label="$2"
  case "$m" in
    off|alias|pending|deprovision|multi-on) ;;
    *) fail "${label} must be one of off|alias|pending|deprovision|multi-on, got: '${m}'" ;;
  esac
}

write_status_artifact() {
  local build_sha="$1"
  local alias_on="$2" pending_on="$3" deprov_on="$4" mode="$5"
  local alias_ready="$6" can_enable_alias="$7"
  local migrations_pending_zero="$8" health_ok="$9"
  local preflight_target="${10:-}"
  local preflight_ok="${11:-}"
  local transition_applied="${12:-false}"
  local note="${13:-}"

  # STATUS ARTIFACT CONTRACT: only closed booleans / SHAs / health. Never dump env,
  # credentials, canary subject ids, integration ids, or PII.
  {
    echo "schema=dingtalk-lifecycle-staging-canary-status-v1"
    echo "build_sha=${build_sha}"
    echo "mode=${mode}"
    echo "auth_login_use_aliases=${alias_on}"
    echo "directory_pending_activation_enabled=${pending_on}"
    echo "directory_deprovision_enabled=${deprov_on}"
    echo "alias_admin_password_ready=${alias_ready}"
    echo "alias_can_enable_cutover=${can_enable_alias}"
    echo "migrations_pending_zero=${migrations_pending_zero}"
    echo "backend_health_ok=${health_ok}"
    if [[ -n "$preflight_target" ]]; then
      echo "preflight_target_mode=${preflight_target}"
      echo "preflight_ok=${preflight_ok}"
    fi
    echo "transition_applied=${transition_applied}"
    if [[ -n "$note" ]]; then
      echo "note=${note}"
    fi
  } > "${OUTPUT_DIR}/lifecycle-status.txt"

  local mig_json
  case "$migrations_pending_zero" in
    true) mig_json=true ;;
    false) mig_json=false ;;
    *) mig_json=null ;; # unknown
  esac

  {
    echo "{"
    echo "  \"schema\": \"dingtalk-lifecycle-staging-canary-status-v1\","
    echo "  \"build_sha\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$build_sha"),"
    echo "  \"mode\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$mode"),"
    echo "  \"flags\": {"
    echo "    \"auth_login_use_aliases\": ${alias_on},"
    echo "    \"directory_pending_activation_enabled\": ${pending_on},"
    echo "    \"directory_deprovision_enabled\": ${deprov_on}"
    echo "  },"
    echo "  \"alias_readiness\": {"
    echo "    \"admin_password_alias_ready\": ${alias_ready},"
    echo "    \"can_enable_cutover\": ${can_enable_alias}"
    echo "  },"
    echo "  \"migrations_pending_zero\": ${mig_json},"
    echo "  \"migrations_probe\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$migrations_pending_zero"),"
    echo "  \"backend_health_ok\": ${health_ok},"
    if [[ -n "$preflight_target" ]]; then
      echo "  \"preflight_target_mode\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$preflight_target"),"
      echo "  \"preflight_ok\": ${preflight_ok},"
    fi
    echo "  \"transition_applied\": ${transition_applied}"
    echo "}"
  } > "${OUTPUT_DIR}/lifecycle-status.json"
}

capture_live_snapshot() {
  # Sets globals: SNAP_*. Never fails solely because mode is multi-on.
  if ! docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null | grep -qx 'true'; then
    fail "staging backend container is not running: ${BACKEND_CONTAINER}"
  fi
  read -r SNAP_ALIAS SNAP_PENDING SNAP_DEPROV SNAP_MODE <<< "$(read_live_flags)"
  SNAP_BUILD_SHA="$(resolve_deployed_sha)"
  SNAP_ALIAS_READY="$(probe_alias_readiness)"
  if [[ "$SNAP_ALIAS_READY" == "true" ]]; then
    SNAP_CAN_ENABLE_ALIAS="true"
  else
    SNAP_CAN_ENABLE_ALIAS="false"
  fi
  SNAP_MIGRATIONS_ZERO="$(probe_migration_pending_zero)"
  SNAP_HEALTH_OK="$(fetch_backend_health_ok)"
}

backup_lifecycle_override() {
  mkdir -p "$LIFECYCLE_PERSIST_DIR"
  LIFECYCLE_PREV_BACKUP="$(mktemp "${LIFECYCLE_PERSIST_DIR}/.prev.XXXXXX")"
  if [[ -f "$LIFECYCLE_OVERRIDE_FILE" ]]; then
    cp -p "$LIFECYCLE_OVERRIDE_FILE" "$LIFECYCLE_PREV_BACKUP"
    LIFECYCLE_PREV_STATE="present"
    log "previous lifecycle override backed up for restore-on-failure"
  else
    : > "$LIFECYCLE_PREV_BACKUP"
    LIFECYCLE_PREV_STATE="absent"
    log "no previous lifecycle override (rollback will remove candidate on failure)"
  fi
}

restore_lifecycle_override() {
  # Restore previous override state after a failed transition.
  if [[ "$LIFECYCLE_PREV_STATE" == "present" && -n "$LIFECYCLE_PREV_BACKUP" && -s "$LIFECYCLE_PREV_BACKUP" ]]; then
    cp -p "$LIFECYCLE_PREV_BACKUP" "$LIFECYCLE_OVERRIDE_FILE"
    log "restored previous lifecycle override from backup"
  else
    rm -f "$LIFECYCLE_OVERRIDE_FILE"
    log "removed lifecycle override (previous state was absent)"
  fi
}

cleanup_prev_backup() {
  if [[ -n "$LIFECYCLE_PREV_BACKUP" ]]; then
    rm -f "$LIFECYCLE_PREV_BACKUP"
    LIFECYCLE_PREV_BACKUP=""
  fi
}

write_lifecycle_override() {
  local alias_val="$1" pending_val="$2" deprov_val="$3"
  require_compose_v2
  mkdir -p "$LIFECYCLE_PERSIST_DIR"
  local override_tmp
  override_tmp="$(mktemp "${LIFECYCLE_PERSIST_DIR}/.override.XXXXXX")"
  {
    echo "# Written by dingtalk-lifecycle-staging-canary (run ${RUN_STAMP})."
    echo "# SEPARATE from attendance window-runner override. Atomic rewrite only."
    echo "# OFF is an emergency operational rollback of these env gates only —"
    echo "# it does NOT reintroduce OR-column login fallback as a long-term design"
    echo "# (design lock Rev 4.2 §4.2 / §4.4: after T2b cutover, Auth reads aliases only)."
    echo "# alias/pending/deprovision ON are NOT EXECUTABLE in this lane."
    echo "services:"
    echo "  backend:"
    echo "    environment:"
    echo "      ${FLAG_ALIAS}: \"${alias_val}\""
    echo "      ${FLAG_PENDING}: \"${pending_val}\""
    echo "      ${FLAG_DEPROVISION}: \"${deprov_val}\""
  } > "$override_tmp"

  if ! compose_staging_cmd "$override_tmp" config >/dev/null 2>&1; then
    rm -f "$override_tmp"
    fail "candidate lifecycle override failed 'docker compose config' validation; kept previous override at ${LIFECYCLE_OVERRIDE_FILE}"
  fi
  mv -f "$override_tmp" "$LIFECYCLE_OVERRIDE_FILE"
  log "lifecycle override written (persistent, atomic): ${LIFECYCLE_OVERRIDE_FILE}"
}

# Recreate backend only. Returns 0 only when health is proven true after restart.
# Does NOT call fail() itself so callers can restore previous override first.
recreate_backend_only() {
  local pg_id_before redis_id_before pg_id_after redis_id_after
  local i health

  pg_id_before="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")" \
    || { log "staging postgres container not found"; return 1; }
  redis_id_before="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")" \
    || { log "staging redis container not found"; return 1; }

  if ! compose_staging_cmd "" up -d --no-deps --force-recreate backend 2>&1 \
    | tee "${OUTPUT_DIR}/compose-up-backend.log"; then
    log "compose up backend failed"
    return 1
  fi

  pg_id_after="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)"
  redis_id_after="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER" 2>/dev/null || true)"
  if [[ "$pg_id_before" != "$pg_id_after" ]]; then
    log "staging postgres container was recreated — hard constraint violated"
    return 1
  fi
  if [[ "$redis_id_before" != "$redis_id_after" ]]; then
    log "staging redis container was recreated — hard constraint violated"
    return 1
  fi
  log "postgres/redis untouched (container ids unchanged)"

  # Require health true after restart — do not claim success on loop exit alone.
  for ((i = 1; i <= 30; i += 1)); do
    if docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null | grep -qx 'true'; then
      health="$(fetch_backend_health_ok)"
      if [[ "$health" == "true" ]]; then
        log "backend health true after restart (attempt ${i}/30)"
        return 0
      fi
    fi
    log "waiting for backend health true (attempt ${i}/30)"
    sleep 2
  done
  log "backend health not true after restart — refuse transition success"
  return 1
}

assert_exact_mode_off() {
  local a p d m
  read -r a p d m <<< "$(read_live_flags)"
  if [[ "$a" == "false" && "$p" == "false" && "$d" == "false" && "$m" == "off" ]]; then
    log "exact mode proven after restart: off (all three flags false)"
    return 0
  fi
  log "post-restart mode is '${m}' (alias=${a} pending=${p} deprovision=${d}), expected off with all false"
  return 1
}

assert_exact_sha() {
  require_sha
  local live
  live="$(resolve_deployed_sha)"
  [[ "$live" != "conflict" ]] \
    || fail "deployed staging SHA provenance conflict (image tag and health commit disagree)"
  [[ "$live" =~ ^[0-9a-f]{40}$ ]] \
    || fail "could not resolve one exact deployed staging SHA (image tag / health commit)"
  [[ "$live" == "$DEPLOY_SHA" ]] \
    || fail "deployed SHA '${live}' does not match required exact deploy_sha '${DEPLOY_SHA}'"
  log "exact deployed SHA OK: ${live}"
}

fail_transition_restore() {
  local reason="$1"
  log "transition failure (${reason}); restoring previous lifecycle override and re-recreating backend"
  restore_lifecycle_override
  # Best-effort recreate after restore so live env matches restored override.
  recreate_backend_only || log "restore recreate did not reach health true; operator must inspect staging"
  cleanup_prev_backup
  fail "action=off failed: ${reason} (previous override restored)"
}

# --- actions ---------------------------------------------------------------------------

action_status() {
  capture_live_snapshot
  local note="read-only status"
  local rc=0
  if [[ "$SNAP_MODE" == "multi-on" ]]; then
    note="multi_on_fail_closed"
    rc=1
  fi
  if [[ "$SNAP_BUILD_SHA" == "conflict" ]]; then
    note="${note};build_provenance_conflict"
    rc=1
  elif [[ "$SNAP_BUILD_SHA" == "unknown" ]]; then
    note="${note};build_provenance_unknown"
    rc=1
  fi
  if [[ "$SNAP_MIGRATIONS_ZERO" == "unknown" ]]; then
    note="${note};migrations_probe_unknown"
    # status still reports; do not hard-fail solely on unknown unless multi-on already fails
  fi
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "" "" "false" "$note"
  {
    echo "action=status"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "migrations_pending_zero=${SNAP_MIGRATIONS_ZERO}"
    echo "transition_applied=false"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  if [[ "$rc" -ne 0 ]]; then
    fail "status fail-closed: ${note}"
  fi
  log "status OK mode=${SNAP_MODE}"
}

preflight_for_target() {
  # Sets PREFLIGHT_OK=true|false and PREFLIGHT_NOTE (values-free reason codes only).
  local target="$1"
  PREFLIGHT_OK="true"
  PREFLIGHT_NOTE="ok"
  validate_mode_name "$target" "target_mode"

  # migrations: exactly true required — unknown is a fail (never acceptable success).
  if [[ "$SNAP_MIGRATIONS_ZERO" != "true" ]]; then
    PREFLIGHT_OK="false"
    if [[ "$SNAP_MIGRATIONS_ZERO" == "unknown" ]]; then
      PREFLIGHT_NOTE="migrations_probe_unknown"
    else
      PREFLIGHT_NOTE="migrations_pending"
    fi
    return 0
  fi

  if [[ "$SNAP_MODE" == "multi-on" ]]; then
    PREFLIGHT_OK="false"
    PREFLIGHT_NOTE="multi_on_fail_closed"
    return 0
  fi

  if [[ "$SNAP_BUILD_SHA" == "conflict" || -z "$SNAP_BUILD_SHA" ]]; then
    PREFLIGHT_OK="false"
    if [[ "$SNAP_BUILD_SHA" == "conflict" ]]; then
      PREFLIGHT_NOTE="build_provenance_conflict"
    else
      PREFLIGHT_NOTE="build_provenance_unknown"
    fi
    return 0
  fi

  if [[ -n "$EXPECTED_CURRENT_MODE" ]]; then
    validate_mode_name "$EXPECTED_CURRENT_MODE" "expected_current_mode"
    if [[ "$SNAP_MODE" != "$EXPECTED_CURRENT_MODE" ]]; then
      PREFLIGHT_OK="false"
      PREFLIGHT_NOTE="expected_current_mode_mismatch"
      return 0
    fi
  fi

  if [[ -n "$DEPLOY_SHA" ]]; then
    if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      PREFLIGHT_OK="false"
      PREFLIGHT_NOTE="deploy_sha_invalid"
      return 0
    fi
    if [[ "${SNAP_BUILD_SHA:-}" != "$DEPLOY_SHA" ]]; then
      PREFLIGHT_OK="false"
      PREFLIGHT_NOTE="deploy_sha_mismatch"
      return 0
    fi
  fi

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    PREFLIGHT_OK="false"
    PREFLIGHT_NOTE="backend_unhealthy"
    return 0
  fi

  case "$target" in
    off)
      # Emergency env-gate clear is the only executable write path (handled by action=off).
      ;;
    alias)
      if [[ "$SNAP_MODE" != "off" && "$SNAP_MODE" != "alias" ]]; then
        PREFLIGHT_OK="false"
        PREFLIGHT_NOTE="other_lifecycle_flag_on"
        return 0
      fi
      if [[ "$SNAP_ALIAS_READY" != "true" ]]; then
        PREFLIGHT_OK="false"
        PREFLIGHT_NOTE="alias_cutover_not_ready"
        return 0
      fi
      # Even when stack looks ready: ON is NOT EXECUTABLE (no password-login proof).
      PREFLIGHT_OK="false"
      PREFLIGHT_NOTE="not_executable_no_real_verifier"
      ;;
    pending|deprovision)
      if [[ "$SNAP_MODE" != "off" && "$SNAP_MODE" != "$target" ]]; then
        PREFLIGHT_OK="false"
        PREFLIGHT_NOTE="other_lifecycle_flag_on"
        return 0
      fi
      # ON is NOT EXECUTABLE (no admit/activate or sync/deprovision proof).
      PREFLIGHT_OK="false"
      PREFLIGHT_NOTE="not_executable_no_real_verifier"
      ;;
    multi-on)
      PREFLIGHT_OK="false"
      PREFLIGHT_NOTE="multi_on_fail_closed"
      ;;
  esac
}

action_preflight() {
  local target="${TARGET_MODE:-${EXPECTED_CURRENT_MODE:-}}"
  [[ -n "$target" ]] || fail "preflight requires target_mode (or expected_current_mode as the inspected mode)"
  case "$target" in
    off|alias|pending|deprovision) ;;
    *) fail "preflight target_mode must be off|alias|pending|deprovision, got: '${target}'" ;;
  esac
  capture_live_snapshot
  preflight_for_target "$target"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "$target" "$PREFLIGHT_OK" "false" "$PREFLIGHT_NOTE"
  {
    echo "action=preflight"
    echo "target_mode=${target}"
    echo "mode=${SNAP_MODE}"
    echo "preflight_ok=${PREFLIGHT_OK}"
    echo "migrations_pending_zero=${SNAP_MIGRATIONS_ZERO}"
    echo "note=${PREFLIGHT_NOTE}"
    echo "transition_applied=false"
  } > "${OUTPUT_DIR}/summary.txt"
  if [[ "$PREFLIGHT_OK" != "true" ]]; then
    fail "preflight failed: ${PREFLIGHT_NOTE}"
  fi
  # Ready-looking preflight for alias/pending/deprovision still means NOT EXECUTABLE ON.
  if [[ "$target" == "alias" || "$target" == "pending" || "$target" == "deprovision" ]]; then
    log "preflight assessed target=${target} note=${PREFLIGHT_NOTE} (ON transition NOT EXECUTABLE)"
  else
    log "preflight OK target=${target} note=${PREFLIGHT_NOTE}"
  fi
}

# Fail-closed: alias/pending/deprovision never apply. Preflight assessment only.
action_not_executable_on() {
  local target="$1"
  capture_live_snapshot
  preflight_for_target "$target"
  # Force not-executable note even if stack would look "ready".
  local note="not_executable_no_real_verifier"
  if [[ "$PREFLIGHT_OK" != "true" ]]; then
    note="${PREFLIGHT_NOTE};not_executable_no_real_verifier"
  fi
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "$target" "false" "false" "$note"
  {
    echo "action=${target}"
    echo "mode=${SNAP_MODE}"
    echo "preflight_ok=false"
    echo "note=${note}"
    echo "transition_applied=false"
    echo "executable=false"
  } > "${OUTPUT_DIR}/summary.txt"
  fail "action=${target} is NOT EXECUTABLE: no secret-backed real verifier for canary proof (password-login / admit-activate / sync-deprovision). Env flip alone is refused. Use status|preflight|off only. transition_applied=false"
}

# Sole executable env write: clear the exact three lifecycle flags to false.
action_off() {
  require_sha
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=off (use multi-on when live flags are multi-on)"
  validate_mode_name "$EXPECTED_CURRENT_MODE" "expected_current_mode"

  capture_live_snapshot
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=off"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=off refused: backend_health_ok must be true before transition"
  fi

  # Strict expected-current, including multi-on so operators acknowledge the live mess.
  if [[ "$SNAP_MODE" != "$EXPECTED_CURRENT_MODE" ]]; then
    fail "strict expected-current-mode transition failed: live='${SNAP_MODE}' expected_current_mode='${EXPECTED_CURRENT_MODE}'"
  fi

  # Backup → write OFF → recreate → prove health+mode; restore on any post-write failure.
  backup_lifecycle_override
  write_lifecycle_override "false" "false" "false"

  if ! recreate_backend_only; then
    fail_transition_restore "backend_health_not_true_after_restart"
  fi
  if ! assert_exact_mode_off; then
    fail_transition_restore "post_restart_mode_not_off"
  fi

  cleanup_prev_backup
  capture_live_snapshot
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "off" "true" "true" "emergency_env_gate_off"
  {
    echo "action=off"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=true"
    echo "from_mode=${EXPECTED_CURRENT_MODE}"
    echo "to_mode=off"
    echo "note=emergency_env_gate_off_only"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=off OK (emergency env-gate clear; NOT a design reintroduction of OR-column fallback)"
}

# --- main ------------------------------------------------------------------------------

main() {
  mkdir -p "$OUTPUT_DIR"
  assert_staging_only

  case "$ACTION" in
    status) action_status ;;
    preflight) action_preflight ;;
    off) action_off ;;
    alias) action_not_executable_on alias ;;
    pending) action_not_executable_on pending ;;
    deprovision) action_not_executable_on deprovision ;;
    *) fail "invalid ACTION='${ACTION}' (status|preflight|off|alias|pending|deprovision)" ;;
  esac
}

if [[ "${LIFECYCLE_CANARY_SOURCE_ONLY:-false}" != "true" ]]; then
  main
fi
