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
#                to OFF. Atomic previous-override backup + restore on
#                restart/health/mode failure.
#   bootstrap  — staging-only, manual create/repair of the FIXED dedicated
#                lifecycle canary platform admin (email+UUID ownership markers).
#                Requires full deploy SHA, expected_current_mode=off, exact mode
#                off, health true, migrations_pending_zero true.
#                Idempotent for the owned row; email/id collision not matching
#                BOTH markers fails closed. Proves real password login.
#                NEVER writes lifecycle env flags; never touches arbitrary admins.
#                Requires login identifier/password secret files only (chmod 600).
#   human-bootstrap — staging-only create/repair of a SEPARATE fixed human
#                platform administrator (username staging-owner-admin, name
#                Staging Owner Admin, no email/mobile). Authenticates admin API
#                with the existing fixed canary admin JWT (minted from canary
#                password login). Human password arrives only as chmod-600
#                STAGING_OWNER_ADMIN_PASSWORD_FILE (path only; never logged).
#                Lookup exact-matches username; fail closed on multiple rows or
#                identity/name/admin mismatch. Create via POST /api/admin/users
#                (no email/mobile) or idempotent reset of the owned match only;
#                then required POST reset-password (must_change_password), GET
#                access (admin role/isAdmin), real POST login
#                (passwordChangeRequired + exact username), then required
#                revoke-sessions with canary JWT. Never writes lifecycle env;
#                never restarts. Post-check: exact SHA, health, migrations-zero,
#                all flags OFF. Artifacts are values-free booleans/enums only.
#   alias      — TRANSIENT secret-backed alias cutover canary.
#                Success requires/proves OFF (post-rollback mode+login).
#                Failure restores the OFF override before failing (post-write).
#                Runtime OFF cannot be proven if rollback recreate itself fails
#                (override restored on disk; operator must inspect).
#                Requires full deploy SHA, expected_current_mode=off, and login
#                identifier/password files (chmod 600) only — NO repo-global
#                ATTENDANCE_ADMIN_JWT. Short-lived admin JWT is minted from the
#                canary password login into a chmod-600 per-run remote file after
#                successful pre-login, then used for backfill/cutover-status.
#                Sequence: pre-login (+mint JWT) → backfill (collisions==0) →
#                cutover-status ready → write alias ON → recreate backend only →
#                post-ON login → restore OFF → recreate → post-rollback login.
#                Backfill rows may persist.
#   pending    — TRANSIENT secret-backed pending-admit canary on an EXPLICIT
#                owned directory account subject (file path only; never printed).
#                Requires full deploy SHA, expected_current_mode=off, health true,
#                migrations zero, canary login secrets, and
#                CANARY_DIRECTORY_ACCOUNT_ID_FILE. Temporarily enables only
#                DIRECTORY_PENDING_ACTIVATION_ENABLED, real admin admit, pending
#                state assertions, optional activate path, then unconditional
#                rollback/recreate/prove OFF (success/failure/interrupt).
#                No auto-selection of directory accounts.
#   deprovision — TRANSIENT secret-backed sync→deprovision canary on the SAME
#                explicit owned subject. Never mutates a real/auto-selected
#                account. Apply requires subject + explicit pre-synced sentinel
#                files and confirmation that the DingTalk source employee was
#                disabled externally. The dedicated integration must contain
#                exactly target + active unlinked sentinel, keeping provider
#                fetch nonempty. Temporarily enables only
#                DIRECTORY_DEPROVISION_ENABLED, runs real integration sync,
#                verifies ledger/effects/generation/access denial, then
#                restore/prove OFF. Restore/recovery do not require the sentinel
#                file. Full source rehire/reactivate restore is an EXTERNAL phase
#                (fail-closed note; not claimed by this action).
#                EMPTY_FETCH_ABORT_RECOVERY (confirmation=
#                DINGTALK_EMPTY_FETCH_ABORT_SOURCE_RE_ADDED_CONFIRMED): staging-only
#                fail-closed recovery when the journal is stranded at phase=run_bound
#                after an exact completed sync aborted with empty_directory_fetch and
#                produced no user/membership/grant ledger. Never writes lifecycle env
#                flags. Requires exact journal run, abortedReason match, zero ledger,
#                pre-recovery intact access graph, external source re-add, flags-OFF
#                sync, owned directory account active, and access graph unchanged —
#                then and only then clears the journal.
#                SYNC_FAILURE_BEFORE_DEPROVISION_RECOVERY (confirmation=
#                DINGTALK_SYNC_FAILURE_BEFORE_DEPROVISION_SOURCE_RE_ADDED_CONFIRMED):
#                staging-only fail-closed recovery when the journal is stranded at
#                phase=run_bound after an exact terminal failed sync with zero ledger
#                (e.g. ledger_verify_failed_sync_deprovision_not_applied after the
#                observed idx_directory_accounts_provider_corp_external_key collision).
#                Never writes lifecycle env. Journal binds deprovision_applied=false;
#                run API proves status=failed + exact observed error class (values-free);
#                zero ledger + intact active access graph prove no mutation. External
#                source re-add, flags-OFF sync (deprovisionApplied=false), graph
#                unchanged, final zero-ledger + exact run identity — then clears journal.
#
# HARD SAFETY RAILS:
#   * Staging compose + metasheet-staging-* containers only; no prod fallback.
#   * migrations_pending_zero must be exactly "true" for preflight_ok and for
#     action=off / action=alias / action=bootstrap / action=human-bootstrap /
#     action=pending / action=deprovision (unknown is a fail, never success).
#   * action=off|alias|pending|deprovision: recreate backend only; prove
#     postgres/redis IDs unchanged; require backend health true after restart;
#     prove exact mode; restore previous/OFF override and re-recreate on any
#     failure after the write. EXIT/signal guard armed in ON window.
#   * action=bootstrap|human-bootstrap: no lifecycle env write; no backend recreate.
#   * multi-on: status/preflight report and fail closed; action=off still clears
#     the exact three flags (does not die in derive_mode before clear).
#   * Artifacts never contain env values, credentials, subject ids, or PII —
#     only booleans / counts / reason enums / SHA.
#   * Secrets never appear in shell argv, process listings via export of values,
#     or logs; only chmod-600 file paths are passed.
#   * Invoked as `bash -o pipefail -c '<script>'`.
set -euo pipefail

log() { echo "[lifecycle-canary] $*"; }
fail() { echo "[lifecycle-canary][error] $*" >&2; exit 1; }

ACTION="${ACTION:?ACTION is required (status|preflight|off|bootstrap|human-bootstrap|alias|pending|deprovision)}"
TARGET_MODE="${TARGET_MODE:-}"
EXPECTED_CURRENT_MODE="${EXPECTED_CURRENT_MODE:-}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
BOOTSTRAP_CONFIRMATION="${BOOTSTRAP_CONFIRMATION:-}"
STAGING_DEPLOY_PATH="${STAGING_DEPLOY_PATH:-metasheet2-dingtalk-staging}"
DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
OUTPUT_DIR="${OUTPUT_DIR:?OUTPUT_DIR is required}"
RUN_STAMP="${RUN_STAMP:?RUN_STAMP is required (workflow run id marker)}"

# Secret-backed canary inputs: FILE PATHS only (values never exported).
# Workflow materializes chmod-600 identifier/password into the per-run remote dir.
# Alias/pending/deprovision mint CANARY_ADMIN_JWT_FILE after successful pre-login
# (never from secrets.ATTENDANCE_ADMIN_JWT). Bootstrap does not consume a JWT file.
# human-bootstrap mints JWT from canary login for admin API, and consumes a
# separate STAGING_OWNER_ADMIN_PASSWORD_FILE for the human admin password only.
# pending/deprovision require CANARY_DIRECTORY_ACCOUNT_ID_FILE (explicit owned
# directory account UUID path only — never auto-selected, never printed).
# Deprovision apply additionally requires an explicit pre-synced sentinel UUID.
CANARY_ADMIN_JWT_FILE="${CANARY_ADMIN_JWT_FILE:-}"
CANARY_LOGIN_IDENTIFIER_FILE="${CANARY_LOGIN_IDENTIFIER_FILE:-}"
CANARY_LOGIN_PASSWORD_FILE="${CANARY_LOGIN_PASSWORD_FILE:-}"
STAGING_OWNER_ADMIN_PASSWORD_FILE="${STAGING_OWNER_ADMIN_PASSWORD_FILE:-}"
CANARY_DIRECTORY_ACCOUNT_ID_FILE="${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-}"
CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE="${CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE:-}"

# Fixed dedicated lifecycle canary admin ownership markers (values-free constants).
# Create/repair ONLY this (email, id) pair. Any email/id collision that does not
# match BOTH markers fails closed — never mutates an arbitrary existing admin.
CANARY_OWNER_EMAIL="lifecycle-canary@staging.invalid"
CANARY_OWNER_USER_ID="6c1fe000-ca0a-4000-8000-1ec0c1e00001"

# Fixed SEPARATE human platform administrator identity (values-free constants).
# Username ownership only (no email/mobile). Collision / identity mismatch fails
# closed — never mutates an arbitrary existing admin.
HUMAN_OWNER_USERNAME="staging-owner-admin"
HUMAN_OWNER_NAME="Staging Owner Admin"

# Fixed dedicated DingTalk directory subject ownership markers (values-free).
# pending/deprovision operate ONLY on the secret-backed account id whose live
# directory account name matches SUBJECT_OWNER_NAME. Username is the stable
# local admit identifier (not printed in artifacts). No auto-selection.
SUBJECT_OWNER_NAME="Lifecycle Canary Employee"
SUBJECT_OWNER_USERNAME="lifecycle-canary-employee"
SENTINEL_OWNER_NAME="Lifecycle Canary Employee 2"
DEPROVISION_SOURCE_CONFIRMATION="DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED"
DEPROVISION_RESTORE_CONFIRMATION="DINGTALK_SOURCE_REACTIVATED_CONFIRMED"
# Staging-only recovery for a completed empty_directory_fetch safe abort stranded at
# phase=run_bound with no deprovision ledger. Never writes lifecycle env flags.
DEPROVISION_EMPTY_FETCH_ABORT_RECOVERY_CONFIRMATION="DINGTALK_EMPTY_FETCH_ABORT_SOURCE_RE_ADDED_CONFIRMED"
# Staging-only recovery for a terminal failed sync stranded at phase=run_bound with
# journal deprovision_applied=false and zero ledger (exact observed constraint class).
# Never writes lifecycle env flags.
DEPROVISION_SYNC_FAILURE_BEFORE_DEPROVISION_RECOVERY_CONFIRMATION="DINGTALK_SYNC_FAILURE_BEFORE_DEPROVISION_SOURCE_RE_ADDED_CONFIRMED"
PENDING_SSO_ACTIVATE_CONFIRMATION="PENDING_SSO_ACTIVATE"
# Optional subject password file (path only). When present, deprovision may prove
# pre-login then post-denial with the SAME proven credential. Never invent a wrong
# password as denial evidence.
CANARY_SUBJECT_PASSWORD_FILE="${CANARY_SUBJECT_PASSWORD_FILE:-}"
CANARY_SUBJECT_SYNC_RUN_ID_FILE="${CANARY_SUBJECT_SYNC_RUN_ID_FILE:-}"
CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE="${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE:-}"

# Legacy presence-token names are intentionally NOT env-driven enablers.
# Subject identity is path-only via CANARY_DIRECTORY_ACCOUNT_ID_FILE.

BACKEND_CONTAINER="metasheet-staging-backend"
WEB_CONTAINER="metasheet-staging-web"
POSTGRES_CONTAINER="metasheet-staging-postgres"
REDIS_CONTAINER="metasheet-staging-redis"
STAGING_WEB_HEALTH_URL="http://127.0.0.1:8082/api/health"
STAGING_BACKEND_HEALTH_URL="http://127.0.0.1:18900/health"
STAGING_API_BASE_URL="http://127.0.0.1:8082"
MIGRATE_JS="packages/core-backend/dist/src/db/migrate.js"

FLAG_ALIAS="AUTH_LOGIN_USE_ALIASES"
FLAG_PENDING="DIRECTORY_PENDING_ACTIVATION_ENABLED"
FLAG_DEPROVISION="DIRECTORY_DEPROVISION_ENABLED"

resolve_home_path() {
  local raw="$1"
  if [[ "$raw" == /* ]]; then
    printf '%s' "$raw"
  elif [[ "$raw" == "~/"* ]]; then
    printf '%s' "${HOME}/${raw#"~/"}"
  else
    printf '%s' "${HOME}/${raw}"
  fi
}

STAGING_DIR="$(resolve_home_path "$STAGING_DEPLOY_PATH")"
PROD_REPO_DIR="$(resolve_home_path "$DEPLOY_PATH")"
LEGACY_STAGING_COMPOSE_FILE="${STAGING_DIR}/docker-compose.app.staging.yml"

ATTENDANCE_PERSIST_DIR="${HOME}/.metasheet2/window-runner"
ATTENDANCE_OVERRIDE_FILE="${ATTENDANCE_PERSIST_DIR}/docker-compose.window-runner.override.yml"
PERSISTENT_STAGING_COMPOSE_FILE="${ATTENDANCE_PERSIST_DIR}/docker-compose.app.staging.yml"
ATTENDANCE_DEPLOY_IDENTITY_FILE="${ATTENDANCE_PERSIST_DIR}/deploy-identity.env"
STAGING_COMPOSE_FILE="$LEGACY_STAGING_COMPOSE_FILE"
if [[ -f "$PERSISTENT_STAGING_COMPOSE_FILE" ]]; then
  STAGING_COMPOSE_FILE="$PERSISTENT_STAGING_COMPOSE_FILE"
fi

LIFECYCLE_PERSIST_DIR="${HOME}/.metasheet2/lifecycle-canary"
LIFECYCLE_OVERRIDE_FILE="${LIFECYCLE_PERSIST_DIR}/docker-compose.lifecycle-canary.override.yml"
# Previous-override backup used during action=off|alias|pending|deprovision for
# restore-on-failure (alias/pending/deprovision success paths also restore OFF).
LIFECYCLE_PREV_BACKUP=""
LIFECYCLE_PREV_STATE="absent" # absent | present
PINNED_IMAGE_OWNER=""
PINNED_IMAGE_TAG=""
ALIAS_ROLLBACK_ARMED="false"
# Subject-local ephemeral secret files written under the per-run secrets dir
# (local user id / temp password). Never logged; cleaned with secrets dir.
CANARY_SUBJECT_LOCAL_USER_ID_FILE=""
CANARY_SUBJECT_TEMP_PASSWORD_FILE=""
CANARY_SUBJECT_INTEGRATION_ID_FILE=""
# Host-persisted recovery journal for cross-run restore (mode 600). Keyed by
# fixed SUBJECT_OWNER_USERNAME. Schema v4 state machine (unidirectional):
#   prepared → run_bound → ledger_bound → (clear after successful restore)
# Binds subject_key + local_user_id + integration_id + directory_account_id;
# prepared also reserves exact run UUID; run_bound adds terminal counts;
# ledger_bound adds exact event/effects.
# Survives per-run secret cleanup. Deleted only after successful restore.
CANARY_APPLY_STATE_DIR="${HOME}/.metasheet2/lifecycle-canary/subject-state"
CANARY_APPLY_STATE_FILE="${CANARY_APPLY_STATE_DIR}/${SUBJECT_OWNER_USERNAME}.apply-state.json"
CANARY_SUBJECT_EFFECTS_FILE=""
JOURNAL_PHASE="none"
# Dedicated canary expected effect type set (planner mark_inactive + grant enabled + global clear).
CANARY_EXPECTED_EFFECT_TYPES="grant_changed membership_changed user_changed"

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

read_attendance_deploy_identity_field() {
  local key="$1" value count
  [[ -f "$ATTENDANCE_DEPLOY_IDENTITY_FILE" ]] || return 1
  value="$(sed -n "s/^${key}=//p" "$ATTENDANCE_DEPLOY_IDENTITY_FILE" | head -n 1)"
  count="$(sed -n "s/^${key}=//p" "$ATTENDANCE_DEPLOY_IDENTITY_FILE" | wc -l | tr -d '[:space:]')"
  [[ "$count" == "1" && -n "$value" ]] || return 1
  printf '%s' "$value"
}

resolve_live_backend_image_pin() {
  local live_image image_owner recorded_sha recorded_digest
  live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  if [[ "$live_image" =~ ^ghcr\.io/([A-Za-z0-9._-]+)/metasheet2-backend:([0-9a-f]{40})$ ]]; then
    printf '%s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi
  if [[ "$live_image" =~ ^ghcr\.io/([A-Za-z0-9._-]+)/metasheet2-backend@sha256:[0-9a-f]{64}$ ]]; then
    image_owner="${BASH_REMATCH[1]}"
    recorded_sha="$(read_attendance_deploy_identity_field deploy_sha)" || return 1
    recorded_digest="$(read_attendance_deploy_identity_field backend_digest)" || return 1
    [[ "$recorded_sha" =~ ^[0-9a-f]{40}$ && "$recorded_digest" == "$live_image" ]] || return 1
    [[ -f "$ATTENDANCE_OVERRIDE_FILE" ]] || return 1
    grep -Fqx "    image: ${recorded_digest}" "$ATTENDANCE_OVERRIDE_FILE" || return 1
    printf '%s %s' "$image_owner" "$recorded_sha"
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
  if [[ -n "$PINNED_IMAGE_OWNER" && -n "$PINNED_IMAGE_TAG" ]]; then
    image_owner="$PINNED_IMAGE_OWNER"
    image_tag="$PINNED_IMAGE_TAG"
  else
    if ! image_pin="$(resolve_live_backend_image_pin)"; then
      echo "[lifecycle-canary][error] running backend image lacks an exact full-SHA tag or matching immutable deploy identity; refusing compose" >&2
      return 1
    fi
    read -r image_owner image_tag <<< "$image_pin"
  fi
  (cd "$STAGING_DIR" && IMAGE_OWNER="$image_owner" IMAGE_TAG="$image_tag" \
    docker compose --project-directory "$STAGING_DIR" "${files[@]}" "$@")
}

pin_live_backend_image_for_transition() {
  local image_pin
  if ! image_pin="$(resolve_live_backend_image_pin)"; then
    fail "running backend image lacks an exact full-SHA tag or matching immutable deploy identity; refusing transition"
  fi
  read -r PINNED_IMAGE_OWNER PINNED_IMAGE_TAG <<< "$image_pin"
  [[ "$PINNED_IMAGE_TAG" == "$DEPLOY_SHA" ]] \
    || fail "running backend image tag '${PINNED_IMAGE_TAG}' does not match deploy_sha '${DEPLOY_SHA}'"
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
  local live_image image_commit="" health_commit="" image_pin=""
  live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  if [[ "$live_image" =~ :([0-9a-f]{40})$ ]]; then
    image_commit="${BASH_REMATCH[1]}"
  elif [[ "$live_image" == *@sha256:* ]]; then
    if image_pin="$(resolve_live_backend_image_pin)"; then
      read -r _ image_commit <<< "$image_pin"
      printf '%s' "$image_commit"
    else
      printf 'unknown'
    fi
    return 0
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
  if ! val="$(docker exec "$BACKEND_CONTAINER" sh -c '
key="$1"
if printenv "$key" >/dev/null 2>&1; then
  exec printenv "$key"
fi
printf "__MISSING__"
' sh "$key" 2>/dev/null)"; then
    return 1
  fi
  if [[ "$val" == "__MISSING__" ]]; then
    printf 'false'
    return 0
  fi
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
  a="$(read_flag_from_container "$FLAG_ALIAS")" || return 1
  p="$(read_flag_from_container "$FLAG_PENDING")" || return 1
  d="$(read_flag_from_container "$FLAG_DEPROVISION")" || return 1
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
  # Load-bearing for every transition (action=off|alias) and for
  # action=bootstrap|human-bootstrap and for preflight_ok.
  local v="$1" context="$2"
  if [[ "$v" == "true" ]]; then
    return 0
  fi
  if [[ "$v" == "false" ]]; then
    fail "${context}: migrations_pending_zero must be exactly true (got false — pending migrations; run attendance staging migrate backup/clone-rehearsal first)"
  fi
  fail "${context}: migrations_pending_zero must be exactly true (got '${v}' — probe unknown/failed; refuse, do not treat unknown as success)"
}

require_canary_secret_files() {
  # Login identifier/password paths only — never JWT from secrets.ATTENDANCE_ADMIN_JWT.
  # Paths only — never read values into shell variables that get logged.
  local f context="${1:-alias}"
  for f in \
    CANARY_LOGIN_IDENTIFIER_FILE \
    CANARY_LOGIN_PASSWORD_FILE
  do
    local path="${!f:-}"
    [[ -n "$path" ]] || fail "action=${context} requires ${f} (chmod-600 secret file path); no auto-selection"
    [[ -f "$path" ]] || fail "action=${context} secret file missing for ${f}"
    [[ -s "$path" ]] || fail "action=${context} secret file empty for ${f}"
  done
  log "${context} canary login secret files present (paths only; values never logged)"
}

require_staging_owner_admin_password_file() {
  # Human admin password path only — never export or log the value.
  local path="${STAGING_OWNER_ADMIN_PASSWORD_FILE:-}"
  local context="${1:-human-bootstrap}"
  [[ -n "$path" ]] || fail "action=${context} requires STAGING_OWNER_ADMIN_PASSWORD_FILE (chmod-600 secret file path); no auto-selection"
  [[ -f "$path" ]] || fail "action=${context} secret file missing for STAGING_OWNER_ADMIN_PASSWORD_FILE"
  [[ -s "$path" ]] || fail "action=${context} secret file empty for STAGING_OWNER_ADMIN_PASSWORD_FILE"
  log "${context} staging owner admin password file present (path only; values never logged)"
}

require_canary_directory_account_id_file() {
  # Explicit owned directory account subject path only — never auto-select.
  local path="${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-}"
  local context="${1:-pending}"
  [[ -n "$path" ]] || fail "action=${context} requires CANARY_DIRECTORY_ACCOUNT_ID_FILE (chmod-600 secret file path); no auto-selection"
  [[ -f "$path" ]] || fail "action=${context} secret file missing for CANARY_DIRECTORY_ACCOUNT_ID_FILE"
  [[ -s "$path" ]] || fail "action=${context} secret file empty for CANARY_DIRECTORY_ACCOUNT_ID_FILE"
  # Shape-only check inside python; value never printed.
  local shape
  shape="$(
    python3 - "$path" <<'PY'
import pathlib, re, sys
try:
    raw = pathlib.Path(sys.argv[1]).read_bytes().decode("utf-8").strip()
except Exception:
    print("false|secret_file_read_failed")
    raise SystemExit(0)
if not raw:
    print("false|empty_subject")
    raise SystemExit(0)
if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", raw):
    print("false|subject_not_uuid")
    raise SystemExit(0)
print("true|ok")
PY
  )"
  if [[ "${shape%%|*}" != "true" ]]; then
    fail "action=${context} refused: directory account subject file invalid (${shape#*|}); values never logged"
  fi
  log "${context} directory account subject file present (path only; values never logged; no auto-selection)"
}

require_canary_sentinel_directory_account_id_file() {
  local path="${CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE:-}"
  [[ -n "$path" ]] || fail "action=deprovision apply requires CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE (chmod-600 secret file path); no auto-selection"
  [[ -f "$path" ]] || fail "action=deprovision apply secret file missing for CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE"
  [[ -s "$path" ]] || fail "action=deprovision apply secret file empty for CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE"
  local shape
  shape="$(python3 - "$path" <<'PY'
import pathlib, re, sys
try:
    raw = pathlib.Path(sys.argv[1]).read_bytes().decode("utf-8").strip()
except Exception:
    print("false|secret_file_read_failed")
    raise SystemExit(0)
if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", raw):
    print("false|sentinel_not_uuid")
    raise SystemExit(0)
print("true|ok")
PY
  )"
  [[ "${shape%%|*}" == "true" ]] \
    || fail "action=deprovision apply refused: sentinel file invalid (${shape#*|}); values never logged"
  log "deprovision apply sentinel file present (path only; values never logged; no auto-selection)"
}

# Identifier secret file (app trim) must equal the fixed ownership email marker.
# Values never logged; only ok / reason enums leave python.
assert_canary_identifier_matches_owner() {
  local context="$1"
  local result ok note
  result="$(
    python3 - "$CANARY_LOGIN_IDENTIFIER_FILE" "$CANARY_OWNER_EMAIL" <<'PY'
import pathlib
import sys

ident_path, expected = sys.argv[1], sys.argv[2]
try:
    identifier = pathlib.Path(ident_path).read_bytes().decode("utf-8").strip()
except Exception:
    print("false|secret_file_read_failed")
    raise SystemExit(0)
if not identifier:
    print("false|empty_identifier")
    raise SystemExit(0)
if identifier != expected:
    print("false|identifier_not_fixed_owner")
    raise SystemExit(0)
print("true|ok")
PY
  )"
  ok="${result%%|*}"
  note="${result#*|}"
  if [[ "$ok" == "true" ]]; then
    log "canary identifier matches fixed owner email (${context})"
    return 0
  fi
  fail "action=${context} refused: login identifier must be exact fixed owner email (${note}); values never logged"
}

# Real password login via secret files. Values stay inside python; never argv/export/log.
# Identifier may follow app trim semantics (strip ends). Password is read EXACTLY as
# stored (no CR/LF strip, no transform).
# Usage: prove_canary_password_login CONTEXT [jwt_out_file]
# When jwt_out_file is set and login succeeds, write the short-lived token there
# (chmod 600) for subsequent admin API calls. Never logs token contents.
prove_canary_password_login() {
  local context="$1"
  local jwt_out="${2:-}"
  local result ok note
  result="$(
    python3 - "$CANARY_LOGIN_IDENTIFIER_FILE" "$CANARY_LOGIN_PASSWORD_FILE" "$STAGING_API_BASE_URL" "$jwt_out" <<'PY'
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

ident_path, pass_path, base, jwt_out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    # read_bytes+decode avoids text-mode universal-newline translation.
    # App sanitizeLoginIdentifier trims ends; password must not be transformed.
    identifier = pathlib.Path(ident_path).read_bytes().decode("utf-8").strip()
    password = pathlib.Path(pass_path).read_bytes().decode("utf-8")
except Exception:
    print("false|secret_file_read_failed")
    raise SystemExit(0)
if not identifier or password == "":
    print("false|empty_credentials")
    raise SystemExit(0)
body = json.dumps({"identifier": identifier, "password": password}).encode("utf-8")
req = urllib.request.Request(
    base.rstrip("/") + "/api/auth/login",
    data=body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    print(f"false|http_{int(e.code)}")
    raise SystemExit(0)
except Exception:
    print("false|request_failed")
    raise SystemExit(0)
try:
    data = json.loads(raw)
except Exception:
    print(f"false|http_{code}_bad_json")
    raise SystemExit(0)
token = ""
if isinstance(data, dict) and isinstance(data.get("data"), dict):
    token = data["data"].get("token") or ""
ok = (
    code == 200
    and data.get("success") is True
    and isinstance(token, str)
    and len(token) > 0
)
if not ok:
    print(f"false|http_{code}_login_rejected")
    raise SystemExit(0)
if jwt_out:
    try:
        out = pathlib.Path(jwt_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        # Exact token bytes; no trailing newline added.
        out.write_bytes(token.encode("utf-8"))
        os.chmod(out, 0o600)
    except Exception:
        print("false|jwt_write_failed")
        raise SystemExit(0)
print("true|ok")
PY
  )"
  ok="${result%%|*}"
  note="${result#*|}"
  if [[ "$ok" == "true" ]]; then
    if [[ -n "$jwt_out" ]]; then
      log "password login OK (${context}); short-lived admin JWT written to secret file (path only)"
    else
      log "password login OK (${context})"
    fi
    return 0
  fi
  log "password login FAILED (${context}): ${note}"
  return 1
}

# Mint short-lived admin JWT into a chmod-600 file beside the login password file.
# Never consumes secrets.ATTENDANCE_ADMIN_JWT or any repo-global JWT secret.
mint_canary_admin_jwt_from_password_login() {
  local context="$1"
  local jwt_path
  [[ -n "${CANARY_LOGIN_PASSWORD_FILE:-}" ]] \
    || fail "mint admin JWT requires CANARY_LOGIN_PASSWORD_FILE path"
  jwt_path="$(dirname "$CANARY_LOGIN_PASSWORD_FILE")/admin.jwt"
  if ! prove_canary_password_login "$context" "$jwt_path"; then
    return 1
  fi
  [[ -f "$jwt_path" && -s "$jwt_path" ]] \
    || fail "mint admin JWT: secret file missing/empty after login (${context})"
  CANARY_ADMIN_JWT_FILE="$jwt_path"
  log "CANARY_ADMIN_JWT_FILE set from password login mint (path only; never ATTENDANCE_ADMIN_JWT)"
  return 0
}

# Strong minimum password length for the fixed canary admin (matches on-prem bootstrap floor).
CANARY_BOOTSTRAP_MIN_PASSWORD_LEN=12
BOOTSTRAP_NODE_TMP=""
BOOTSTRAP_FRAMED_TMP=""

cleanup_bootstrap_tmps() {
  if [[ -n "${BOOTSTRAP_NODE_TMP:-}" && -f "${BOOTSTRAP_NODE_TMP}" ]]; then
    rm -f "${BOOTSTRAP_NODE_TMP}"
  fi
  if [[ -n "${BOOTSTRAP_FRAMED_TMP:-}" && -f "${BOOTSTRAP_FRAMED_TMP}" ]]; then
    rm -f "${BOOTSTRAP_FRAMED_TMP}"
  fi
  BOOTSTRAP_NODE_TMP=""
  BOOTSTRAP_FRAMED_TMP=""
}

arm_bootstrap_tmp_cleanup_guard() {
  trap cleanup_bootstrap_tmps EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 141' PIPE
}

disarm_bootstrap_tmp_cleanup_guard() {
  trap - EXIT HUP INT TERM PIPE
}

# Transactional create/repair of the FIXED owned lifecycle canary admin only.
# Collision fail-closed: any users row matching email OR id that does not match
# BOTH ownership markers refuses mutation. Values never logged.
#
# Credential transport: host python reads chmod-600 secret files and streams exact
# bytes over docker exec stdin (uint32be length frames). Container node receives
# ONLY non-secret ownership markers via env. No docker cp of secrets, no persistent
# container secret files — interrupt cannot leave identifier/password under /tmp.
# Node program is non-secret host temp source base64'd into env (not secret files).
# stdout reason enums only via result lines.
bootstrap_lifecycle_canary_admin() {
  local result note node_b64
  BOOTSTRAP_OUTCOME="unset"
  BOOTSTRAP_NODE_TMP=""
  BOOTSTRAP_FRAMED_TMP=""

  arm_bootstrap_tmp_cleanup_guard

  # Non-secret node program on host only (never contains credentials).
  # permissions column omitted (054 TEXT[] default / later jsonb default both work).
  # Repair revokes sessions when schema supports it (user_session_revocations and/or user_sessions).
  BOOTSTRAP_NODE_TMP="$(mktemp "${TMPDIR:-/tmp}/lifecycle-canary-bootstrap-node.XXXXXX")"
  cat >"$BOOTSTRAP_NODE_TMP" <<'NODE'
const { Client } = require("pg");

function fail(code) {
  process.stdout.write("false|" + code);
  process.exit(0);
}

function readExact(n) {
  return new Promise(function (resolve, reject) {
    if (n === 0) {
      resolve(Buffer.alloc(0));
      return;
    }
    var chunks = [];
    var got = 0;
    function onData(c) {
      chunks.push(c);
      got += c.length;
      if (got >= n) {
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stdin.off("error", onErr);
        process.stdin.off("end", onEnd);
        var buf = Buffer.concat(chunks);
        if (buf.length > n) {
          process.stdin.unshift(buf.subarray(n));
        }
        resolve(buf.subarray(0, n));
      }
    }
    function onErr(e) { reject(e); }
    function onEnd() { reject(new Error("short_stdin")); }
    process.stdin.on("data", onData);
    process.stdin.on("error", onErr);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}

function readFrame() {
  return readExact(4).then(function (hdr) {
    var len = hdr.readUInt32BE(0);
    if (len > 1024 * 1024) throw new Error("frame_too_large");
    return readExact(len);
  });
}

(async function () {
  var ownerId = String(process.env.CANARY_BOOTSTRAP_OWNER_ID || "");
  var ownerEmail = String(process.env.CANARY_BOOTSTRAP_OWNER_EMAIL || "");
  var minLen = Number(process.env.CANARY_BOOTSTRAP_MIN_PASSWORD_LEN || "12");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
    fail("owner_id_not_uuid");
    return;
  }
  if (!ownerEmail) {
    fail("owner_email_missing");
    return;
  }
  if (!Number.isInteger(minLen) || minLen < 12) {
    fail("min_password_len_invalid");
    return;
  }

  var identifier;
  var password;
  try {
    var identBuf = await readFrame();
    var passBuf = await readFrame();
    identifier = identBuf.toString("utf8").trim();
    // Password: exact UTF-8 decode of framed bytes (no CR/LF strip).
    password = passBuf.toString("utf8");
  } catch (e) {
    fail("secret_stdin_read_failed");
    return;
  }
  if (!identifier || password === "") {
    fail("empty_credentials");
    return;
  }
  if (identifier !== ownerEmail) {
    fail("identifier_not_fixed_owner");
    return;
  }
  if (password.length < minLen) {
    fail("password_too_short");
    return;
  }

  var bcrypt;
  try {
    bcrypt = require("bcryptjs");
  } catch (e) {
    fail("bcryptjs_unavailable");
    return;
  }
  var roundsRaw = process.env.BCRYPT_SALT_ROUNDS || "12";
  var rounds = Number(roundsRaw);
  if (!Number.isInteger(rounds) || rounds < 12) {
    fail("bcrypt_rounds_invalid");
    return;
  }
  var passwordHash;
  try {
    passwordHash = bcrypt.hashSync(password, rounds);
  } catch (e) {
    fail("password_hash_failed");
    return;
  }

  var url = process.env.DATABASE_URL;
  if (!url) {
    fail("database_url_missing");
    return;
  }
  var c = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await c.connect();
    await c.query("BEGIN");
    // Lock any colliding ownership rows for the duration of the transaction.
    var found = await c.query(
      "SELECT id, email FROM users WHERE id = $1 OR lower(email) = lower($2) FOR UPDATE",
      [ownerId, ownerEmail]
    );
    if (found.rows.length > 1) {
      await c.query("ROLLBACK");
      fail("collision_multiple_rows");
      return;
    }
    if (found.rows.length === 1) {
      var row = found.rows[0];
      var emailOk =
        typeof row.email === "string" && row.email.toLowerCase() === ownerEmail.toLowerCase();
      var idOk = row.id === ownerId;
      if (!emailOk || !idOk) {
        await c.query("ROLLBACK");
        fail("collision_not_owned");
        return;
      }
      // Idempotent repair of the fixed owned row only.
      // Omit permissions: leave existing value (avoids TEXT[] vs jsonb cast issues).
      await c.query(
        "UPDATE users SET password_hash = $1, name = COALESCE(NULLIF(trim(name), ''), $2), role = 'admin', is_admin = TRUE, is_active = TRUE, activation_status = 'activated', local_password_set = TRUE, must_change_password = FALSE, updated_at = NOW() WHERE id = $3 AND lower(email) = lower($4)",
        [passwordHash, "Lifecycle Canary Admin", ownerId, ownerEmail]
      );
      // Password rotation PRIMARY guard (same shape as session-revocation.ts revokeUserSessions):
      // upsert user_session_revocations.revoked_after — JWT verify uses this watermark.
      // user_sessions row revoke is an additional belt only (not sufficient alone).
      // Required when migrations_pending_zero=true; absence must roll back the repair.
      await c.query(
        "INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason) VALUES ($1, NOW(), NOW(), $2, $3) ON CONFLICT (user_id) DO UPDATE SET revoked_after = EXCLUDED.revoked_after, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason",
        [ownerId, ownerId, "lifecycle_canary_bootstrap_password_repair"]
      );
      // Additional belt only — not a substitute for user_session_revocations.
      var sessTable = await c.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_sessions' LIMIT 1"
      );
      if (sessTable.rows.length > 0) {
        await c.query(
          "UPDATE user_sessions SET revoked_at = NOW(), revoked_by = $1, revoke_reason = $2, updated_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
          [ownerId, "lifecycle_canary_bootstrap_password_repair"]
        );
      }
      await c.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT (user_id, role_id) DO NOTHING",
        [ownerId]
      );
      await c.query(
        "INSERT INTO user_permissions (user_id, permission_code) SELECT $1, p.code FROM permissions p WHERE p.code IN ('*:*', 'admin:users', 'admin:roles', 'admin:permissions') ON CONFLICT (user_id, permission_code) DO NOTHING",
        [ownerId]
      );
      await c.query("COMMIT");
      process.stdout.write("true|repaired");
      return;
    }

    // No collision: insert fixed owned row.
    // Omit permissions so both TEXT[] default (054) and jsonb default work.
    await c.query(
      "INSERT INTO users (id, email, name, password_hash, role, is_admin, is_active, activation_status, local_password_set, must_change_password, created_at, updated_at) VALUES ($1, $2, $3, $4, 'admin', TRUE, TRUE, 'activated', TRUE, FALSE, NOW(), NOW())",
      [ownerId, ownerEmail, "Lifecycle Canary Admin", passwordHash]
    );
    // A prior deleted canary row may have left orphaned stateless tokens because
    // the revocation table has no users FK. Advance the watermark on create too.
    await c.query(
      "INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason) VALUES ($1, NOW(), NOW(), $2, $3) ON CONFLICT (user_id) DO UPDATE SET revoked_after = EXCLUDED.revoked_after, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason",
      [ownerId, ownerId, "lifecycle_canary_bootstrap_password_create"]
    );
    await c.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT (user_id, role_id) DO NOTHING",
      [ownerId]
    );
    await c.query(
      "INSERT INTO user_permissions (user_id, permission_code) SELECT $1, p.code FROM permissions p WHERE p.code IN ('*:*', 'admin:users', 'admin:roles', 'admin:permissions') ON CONFLICT (user_id, permission_code) DO NOTHING",
      [ownerId]
    );
    await c.query("COMMIT");
    process.stdout.write("true|created");
  } catch (err) {
    try { await c.query("ROLLBACK"); } catch (e2) { /* ignore */ }
    process.stdout.write("false|txn_failed");
  } finally {
    try { await c.end(); } catch (e3) { /* ignore */ }
  }
})().catch(function () {
  process.stdout.write("false|txn_failed");
});
NODE

  # shellcheck disable=SC2064
  node_b64="$(base64 <"$BOOTSTRAP_NODE_TMP" | tr -d '\n')"
  cleanup_bootstrap_tmps

  # Build framed stdin before entering command substitution. Some staging-host bash
  # versions misparse a heredoc feeding a pipeline nested inside $(...), even though
  # bash -n accepts it. The framed file stays in the per-run chmod-700 secret dir,
  # is chmod-600, and is removed by this function's exit/signal guard plus the
  # workflow's independent remote-directory EXIT cleanup.
  BOOTSTRAP_FRAMED_TMP="$(mktemp "$(dirname "$CANARY_LOGIN_PASSWORD_FILE")/bootstrap.frames.XXXXXX")"
  chmod 600 "$BOOTSTRAP_FRAMED_TMP"
  if ! python3 - "$CANARY_LOGIN_IDENTIFIER_FILE" "$CANARY_LOGIN_PASSWORD_FILE" "$CANARY_BOOTSTRAP_MIN_PASSWORD_LEN" >"$BOOTSTRAP_FRAMED_TMP" <<'PY'
import pathlib
import struct
import sys

ident_path, pass_path, min_len_s = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    min_len = int(min_len_s)
except Exception:
    min_len = 12
try:
    identifier = pathlib.Path(ident_path).read_bytes().decode("utf-8").strip().encode("utf-8")
    # Exact password bytes — no transform.
    password = pathlib.Path(pass_path).read_bytes()
except Exception:
    sys.stderr.write("secret framing input read failed\n")
    raise SystemExit(2)
# Host-side strong minimum: decode for length check only (UTF-8), still stream exact bytes.
try:
    password_text = password.decode("utf-8")
except Exception:
    password_text = ""
if len(password_text) < min_len:
    # Still stream frames so container fails closed with password_too_short (same enum).
    pass
sys.stdout.buffer.write(struct.pack(">I", len(identifier)) + identifier)
sys.stdout.buffer.write(struct.pack(">I", len(password)) + password)
sys.stdout.buffer.flush()
PY
  then
    fail "action=bootstrap: secret framing failed"
  fi

  if ! result="$(docker exec -i \
    -e "CANARY_BOOTSTRAP_OWNER_ID=${CANARY_OWNER_USER_ID}" \
    -e "CANARY_BOOTSTRAP_OWNER_EMAIL=${CANARY_OWNER_EMAIL}" \
    -e "CANARY_BOOTSTRAP_MIN_PASSWORD_LEN=${CANARY_BOOTSTRAP_MIN_PASSWORD_LEN}" \
    -e "CANARY_BOOTSTRAP_NODE_B64=${node_b64}" \
    "$BACKEND_CONTAINER" \
    node -e 'eval(Buffer.from(process.env.CANARY_BOOTSTRAP_NODE_B64||"","base64").toString("utf8"))' \
    <"$BOOTSTRAP_FRAMED_TMP")"; then
    fail "action=bootstrap: container bootstrap transaction runner failed"
  fi
  cleanup_bootstrap_tmps
  disarm_bootstrap_tmp_cleanup_guard

  # Collapse multi-line docker/node noise to the last values-free status line.
  result="$(printf '%s\n' "$result" | tail -n1 | tr -d '\r')"
  local ok="${result%%|*}"
  note="${result#*|}"
  BOOTSTRAP_OUTCOME="$note"
  if [[ "$ok" != "true" ]]; then
    log "bootstrap transaction refused: note=${note}"
    return 1
  fi
  log "bootstrap transaction OK outcome=${note} (fixed owned row only; no container secret files; values never logged)"
  return 0
}

# Admin API via JWT file. Prints values-free result lines; never logs token.
# Usage: admin_api_request METHOD PATH [optional_json_body_file]
# When body file is set, POST/PATCH send exact file bytes (never logged).
# When body file empty and method is POST, send {}.
# stdout on transport success: HTTP_CODE\nBODY
admin_api_request() {
  local method="$1" path="$2" body_file="${3:-}"
  python3 - "$CANARY_ADMIN_JWT_FILE" "$STAGING_API_BASE_URL" "$method" "$path" "$body_file" <<'PY'
import pathlib
import sys
import urllib.error
import urllib.request

jwt_path, base, method, path, body_file = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
except Exception:
    sys.stderr.write("admin jwt file read failed\n")
    raise SystemExit(2)
if not token:
    sys.stderr.write("admin jwt file empty\n")
    raise SystemExit(2)
url = base.rstrip("/") + path
method_u = method.upper()
data = None
headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/json",
}
if body_file:
    try:
        data = pathlib.Path(body_file).read_bytes()
    except Exception:
        sys.stderr.write("admin api body file read failed\n")
        raise SystemExit(2)
    headers["Content-Type"] = "application/json"
elif method_u == "POST":
    data = b"{}"
    headers["Content-Type"] = "application/json"
req = urllib.request.Request(
    url,
    data=data,
    headers=headers,
    method=method_u,
)
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", errors="replace")
    code = int(e.code)
except Exception as e:
    sys.stderr.write(f"admin api request failed: {type(e).__name__}\n")
    raise SystemExit(2)
sys.stdout.write(f"{code}\n{body}")
PY
}

# Staging-only create/repair of the FIXED separate human platform admin via admin API.
# Auth: short-lived canary admin JWT file (minted from canary password login).
# Human password: STAGING_OWNER_ADMIN_PASSWORD_FILE only (exact bytes into API; never logged).
# Sequence (values-free reason enums only on stdout):
#   list → exact username match → create OR safe repair gate → required reset-password
#   → GET access (admin role/isAdmin) → real login (passwordChangeRequired + username)
#   → required revoke-sessions (canary JWT).
# Fail closed: multiple exact matches, identity/name/admin mismatch, missing proofs.
# Sets HUMAN_BOOTSTRAP_OUTCOME to created|repaired|reason enum.
bootstrap_human_platform_admin() {
  local result ok note python_tmp
  HUMAN_BOOTSTRAP_OUTCOME="unset"
  [[ -n "${CANARY_ADMIN_JWT_FILE:-}" && -f "${CANARY_ADMIN_JWT_FILE}" && -s "${CANARY_ADMIN_JWT_FILE}" ]] \
    || fail "action=human-bootstrap requires canary admin JWT file (minted from password login)"
  [[ -n "${STAGING_OWNER_ADMIN_PASSWORD_FILE:-}" && -f "${STAGING_OWNER_ADMIN_PASSWORD_FILE}" && -s "${STAGING_OWNER_ADMIN_PASSWORD_FILE}" ]] \
    || fail "action=human-bootstrap requires STAGING_OWNER_ADMIN_PASSWORD_FILE path"

  # Keep the heredoc outside command substitution. Older deploy-host Bash versions
  # parse Python parentheses inside a nested heredoc as shell syntax. The temporary
  # source contains no credentials; only chmod-600 secret file paths are argv.
  python_tmp="$(mktemp "${TMPDIR:-/tmp}/lifecycle-human-bootstrap.XXXXXX.py")"
  chmod 600 "$python_tmp"
  cat >"$python_tmp" <<'PY'
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

jwt_path, pass_path, base, owner_username, owner_name = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]


def emit(ok, note):
    sys.stdout.write(("true" if ok else "false") + "|" + note)
    raise SystemExit(0)


def read_token():
    try:
        token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    except Exception:
        emit(False, "admin_jwt_read_failed")
    if not token:
        emit(False, "admin_jwt_empty")
    return token


def read_password_bytes():
    try:
        # Exact bytes for transport; no transform/log.
        return pathlib.Path(pass_path).read_bytes()
    except Exception:
        emit(False, "secret_file_read_failed")


def password_text(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except Exception:
        emit(False, "password_not_utf8")


def request(method, path, token, body_obj=None):
    url = base.rstrip("/") + path
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if body_obj is not None:
        data = json.dumps(body_obj).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif method.upper() == "POST":
        data = b"{}"
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            code = int(resp.getcode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        code = int(e.code)
    except Exception:
        return None, None
    try:
        parsed = json.loads(raw) if raw else {}
    except Exception:
        parsed = None
    return code, parsed


def empty_contact(value):
    if value is None:
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    return False


def require_admin_access(user_id, token, phase):
    quoted_id = urllib.parse.quote(user_id, safe="")
    code, payload = request("GET", f"/api/admin/users/{quoted_id}/access", token)
    if code is None:
        emit(False, f"{phase}_access_transport_failed")
    if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
        emit(False, f"{phase}_access_http_{code if code is not None else 'na'}")
    access = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    access_user = access.get("user") if isinstance(access.get("user"), dict) else {}
    roles = access.get("roles") if isinstance(access.get("roles"), list) else []
    if access.get("isAdmin") is not True or not any(str(role) == "admin" for role in roles):
        emit(False, f"{phase}_access_not_admin")
    username = access_user.get("username")
    if not isinstance(username, str) or username.strip().lower() != owner_username.lower():
        emit(False, f"{phase}_access_username_mismatch")
    name = access_user.get("name")
    if not isinstance(name, str) or name != owner_name:
        emit(False, f"{phase}_access_name_mismatch")
    if not empty_contact(access_user.get("email")) or not empty_contact(access_user.get("mobile")):
        emit(False, f"{phase}_access_contact_not_empty")
    if access_user.get("is_active") is not True:
        emit(False, f"{phase}_access_inactive")
    if access_user.get("activationStatus") != "activated":
        emit(False, f"{phase}_access_not_activated")


token = read_token()
password_raw = read_password_bytes()
password = password_text(password_raw)
if password == "":
    emit(False, "empty_password")
if password != password.strip():
    emit(False, "password_outer_whitespace")
if len(password) < 8:
    emit(False, "password_too_short")
if len(password) > 128:
    emit(False, "password_too_long")
if not any(char.islower() for char in password):
    emit(False, "password_missing_lowercase")
if not any(char.isupper() for char in password):
    emit(False, "password_missing_uppercase")
if not any(char.isdigit() for char in password):
    emit(False, "password_missing_digit")
if any(pattern in password.lower() for pattern in ("password", "123456", "qwerty", "abc123", "letmein", "admin")):
    emit(False, "password_weak_pattern")

# 1) Lookup by username query; exact-match only (values never logged).
q = urllib.parse.urlencode({"q": owner_username, "page": "1", "pageSize": "100"})
code, payload = request("GET", f"/api/admin/users?{q}", token)
if code is None:
    emit(False, "list_transport_failed")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit(False, f"list_http_{code if code is not None else 'na'}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
items = data.get("items") if isinstance(data.get("items"), list) else []
exact = []
for item in items:
    if not isinstance(item, dict):
        continue
    uname = item.get("username")
    if isinstance(uname, str) and uname.strip().lower() == owner_username.lower():
        exact.append(item)
if len(exact) > 1:
    emit(False, "collision_multiple_rows")

outcome = "unset"
user_id = ""
if len(exact) == 1:
    row = exact[0]
    user_id = str(row.get("id") or "").strip()
    name = row.get("name")
    if not user_id:
        emit(False, "identity_missing_id")
    if not isinstance(name, str) or name != owner_name:
        emit(False, "identity_name_mismatch")
    if not empty_contact(row.get("email")) or not empty_contact(row.get("mobile")):
        emit(False, "identity_contact_not_empty")
    # Ownership guard before any password mutation. Profile flags are not enough;
    # verify the production RBAC surface used by ensurePlatformAdmin.
    require_admin_access(user_id, token, "pre_reset")
    outcome = "repaired"
else:
    # 2) Create with username/name/admin only; no email/mobile and without the
    # operator password. The server-generated temporary
    # password keeps must_change_password=true even if this process is interrupted
    # before the required reset below. The generated value is never emitted.
    create_body = {
        "username": owner_username,
        "name": owner_name,
        "role": "admin",
        "roleId": "admin",
        "isActive": True,
    }
    code, payload = request("POST", "/api/admin/users", token, create_body)
    if code is None:
        emit(False, "create_transport_failed")
    if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
        emit(False, f"create_http_{code if code is not None else 'na'}")
    created = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    created_user = created.get("user") if isinstance(created.get("user"), dict) else {}
    user_id = str(created_user.get("id") or created.get("userId") or "").strip()
    if not user_id:
        emit(False, "create_missing_user_id")
    created_username = created_user.get("username")
    if not isinstance(created_username, str) or created_username.strip().lower() != owner_username.lower():
        emit(False, "create_username_mismatch")
    if not empty_contact(created_user.get("email")) or not empty_contact(created_user.get("mobile")):
        emit(False, "create_contact_not_empty")
    outcome = "created"

# 3) Required reset-password forces must_change_password (create and repair).
code, payload = request(
    "POST",
    f"/api/admin/users/{urllib.parse.quote(user_id, safe='')}/reset-password",
    token,
    {"password": password},
)
if code is None:
    emit(False, "reset_transport_failed")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit(False, f"reset_http_{code if code is not None else 'na'}")

# 4) Post-write access proof catches create/role drift and protects the claimed result.
require_admin_access(user_id, token, "post_reset")

# 5) Real password login: passwordChangeRequired true + exact username.
login_body = json.dumps({"identifier": owner_username, "password": password}).encode("utf-8")
login_req = urllib.request.Request(
    base.rstrip("/") + "/api/auth/login",
    data=login_body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(login_req, timeout=20) as resp:
        login_raw = resp.read().decode("utf-8", errors="replace")
        login_code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit(False, f"login_http_{int(e.code)}")
except Exception:
    emit(False, "login_request_failed")
try:
    login_data = json.loads(login_raw)
except Exception:
    emit(False, f"login_http_{login_code}_bad_json")
if login_code != 200 or not isinstance(login_data, dict) or login_data.get("success") is not True:
    emit(False, f"login_http_{login_code}_rejected")
login_payload = login_data.get("data") if isinstance(login_data.get("data"), dict) else {}
if login_payload.get("passwordChangeRequired") is not True:
    emit(False, "login_password_change_required_missing")
login_user = login_payload.get("user") if isinstance(login_payload.get("user"), dict) else {}
login_username = login_user.get("username")
if not isinstance(login_username, str) or login_username.strip().lower() != owner_username.lower():
    emit(False, "login_username_mismatch")

# 6) Required revoke-sessions using canary JWT (clean up human login session).
code, payload = request(
    "POST",
    f"/api/admin/users/{urllib.parse.quote(user_id, safe='')}/revoke-sessions",
    token,
    {"reason": "lifecycle_canary_human_bootstrap"},
)
if code is None:
    emit(False, "revoke_transport_failed")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit(False, f"revoke_http_{code if code is not None else 'na'}")
revoke_data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
revoked_after = revoke_data.get("revokedAfter")
if not isinstance(revoked_after, str) or not revoked_after.strip():
    emit(False, "revoke_proof_missing")

emit(True, outcome)
PY
  if ! result="$(python3 "$python_tmp" \
    "$CANARY_ADMIN_JWT_FILE" \
    "$STAGING_OWNER_ADMIN_PASSWORD_FILE" \
    "$STAGING_API_BASE_URL" \
    "$HUMAN_OWNER_USERNAME" \
    "$HUMAN_OWNER_NAME")"; then
    rm -f "$python_tmp"
    HUMAN_BOOTSTRAP_OUTCOME="python_failed"
    log "human-bootstrap refused: note=python_failed"
    return 1
  fi
  rm -f "$python_tmp"
  ok="${result%%|*}"
  note="${result#*|}"
  HUMAN_BOOTSTRAP_OUTCOME="$note"
  if [[ "$ok" != "true" ]]; then
    log "human-bootstrap refused: note=${note}"
    return 1
  fi
  log "human-bootstrap OK outcome=${note} (fixed human admin only; values never logged)"
  return 0
}

# POST /api/admin/login-aliases/backfill — success required; record counts only.
# Requires Python int counts only (reject bool/float/string/missing/negative) and
# collisions==0 before any env write (collisions would lock collided users out
# under alias-only login). Production API returns JS numbers → JSON ints.
# Sets: BACKFILL_OK BACKFILL_INSERTED BACKFILL_COLLISIONS BACKFILL_SKIPPED BACKFILL_NOTE
run_alias_backfill() {
  local raw code body parsed
  BACKFILL_OK="false"
  BACKFILL_INSERTED="0"
  BACKFILL_COLLISIONS="0"
  BACKFILL_SKIPPED="0"
  BACKFILL_NOTE="unset"
  if ! raw="$(admin_api_request POST /api/admin/login-aliases/backfill)"; then
    BACKFILL_NOTE="transport_failed"
    log "alias backfill request failed (transport)"
    return 1
  fi
  code="$(printf '%s\n' "$raw" | head -n1)"
  body="$(printf '%s\n' "$raw" | tail -n +2)"
  if [[ "$code" != "200" ]]; then
    BACKFILL_NOTE="http_${code}"
    log "alias backfill HTTP ${code} (body redacted)"
    return 1
  fi
  # Parse only counts / ok flag — never echo body (may contain unexpected fields).
  # Fail closed: counts must be Python int only (not bool/float/str); collisions==0.
  if ! parsed="$(printf '%s' "$body" | python3 -c 'import json,sys

def nonneg_int(v, name):
    # API emits JSON numbers as Python int. Reject bool (int subclass), float
    # (including 1.0), string (including "1"), missing/None, and negatives.
    if type(v) is not int:
        raise ValueError(name)
    if v < 0:
        raise ValueError(name)
    return v

try:
    d = json.load(sys.stdin)
except Exception:
    print("false|malformed|0|0|0")
    raise SystemExit(0)
if d.get("ok") is not True:
    print("false|not_ok|0|0|0")
    raise SystemExit(0)
data = d.get("data") if isinstance(d.get("data"), dict) else None
if not isinstance(data, dict):
    print("false|malformed|0|0|0")
    raise SystemExit(0)
try:
    # Missing keys → .get None → type is not int → malformed.
    ins = nonneg_int(data.get("inserted"), "inserted")
    col = nonneg_int(data.get("collisions"), "collisions")
    sk = nonneg_int(
        data["skippedEmpty"] if "skippedEmpty" in data else data.get("skipped_empty"),
        "skippedEmpty",
    )
except Exception:
    print("false|malformed|0|0|0")
    raise SystemExit(0)
if col != 0:
    print(f"false|collisions_nonzero|{ins}|{col}|{sk}")
    raise SystemExit(0)
print(f"true|ok|{ins}|{col}|{sk}")
')"; then
    BACKFILL_NOTE="parse_failed"
    log "alias backfill response parse failed"
    return 1
  fi
  BACKFILL_OK="${parsed%%|*}"
  local rest="${parsed#*|}"
  BACKFILL_NOTE="${rest%%|*}"
  rest="${rest#*|}"
  BACKFILL_INSERTED="${rest%%|*}"
  rest="${rest#*|}"
  BACKFILL_COLLISIONS="${rest%%|*}"
  BACKFILL_SKIPPED="${rest#*|}"
  if [[ "$BACKFILL_OK" != "true" ]]; then
    log "alias backfill refused: note=${BACKFILL_NOTE} inserted=${BACKFILL_INSERTED} collisions=${BACKFILL_COLLISIONS} skipped_empty=${BACKFILL_SKIPPED}"
    return 1
  fi
  # Defense in depth: bash-side exact collisions==0 and nonnegative digit counts.
  if [[ ! "$BACKFILL_INSERTED" =~ ^(0|[1-9][0-9]*)$ ]] \
    || [[ ! "$BACKFILL_COLLISIONS" =~ ^(0|[1-9][0-9]*)$ ]] \
    || [[ ! "$BACKFILL_SKIPPED" =~ ^(0|[1-9][0-9]*)$ ]]; then
    BACKFILL_OK="false"
    BACKFILL_NOTE="malformed_counts"
    log "alias backfill refused: non-integer counts"
    return 1
  fi
  if [[ "$BACKFILL_COLLISIONS" != "0" ]]; then
    BACKFILL_OK="false"
    BACKFILL_NOTE="collisions_nonzero"
    log "alias backfill refused: collisions must be 0 (got ${BACKFILL_COLLISIONS}); refuse env write"
    return 1
  fi
  log "alias backfill OK inserted=${BACKFILL_INSERTED} collisions=0 skipped_empty=${BACKFILL_SKIPPED}"
  return 0
}

# GET /api/admin/login-aliases/cutover-status — require ready + canEnableCutover true.
# Sets: CUTOVER_READY CUTOVER_CAN_ENABLE
run_alias_cutover_status() {
  local raw code body parsed
  CUTOVER_READY="false"
  CUTOVER_CAN_ENABLE="false"
  if ! raw="$(admin_api_request GET /api/admin/login-aliases/cutover-status)"; then
    log "alias cutover-status request failed (transport)"
    return 1
  fi
  code="$(printf '%s\n' "$raw" | head -n1)"
  body="$(printf '%s\n' "$raw" | tail -n +2)"
  if [[ "$code" != "200" ]]; then
    log "alias cutover-status HTTP ${code} (body redacted)"
    return 1
  fi
  parsed="$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print("false|false")
    raise SystemExit(0)
data = d.get("data") if isinstance(d.get("data"), dict) else {}
# Prefer nested data; also accept top-level for resilience.
ready = data.get("ready", d.get("ready"))
can = data.get("canEnableCutover", d.get("canEnableCutover"))
print(("true" if ready is True else "false") + "|" + ("true" if can is True else "false"))
')"
  CUTOVER_READY="${parsed%%|*}"
  CUTOVER_CAN_ENABLE="${parsed#*|}"
  if [[ "$CUTOVER_READY" != "true" || "$CUTOVER_CAN_ENABLE" != "true" ]]; then
    log "alias cutover-status not ready (ready=${CUTOVER_READY} canEnableCutover=${CUTOVER_CAN_ENABLE})"
    return 1
  fi
  log "alias cutover-status ready=true canEnableCutover=true"
  return 0
}

# --- pending / deprovision subject helpers (secret-file paths only) --------------------
# All helpers emit values-free reason enums / booleans / counts. Subject ids, integration
# ids, user ids, and temp passwords stay only in chmod-600 files under the per-run
# secrets directory and are never logged or written to artifacts.

_subject_secret_dir() {
  local base="${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-${CANARY_LOGIN_PASSWORD_FILE:-}}"
  [[ -n "$base" ]] || fail "subject secret dir: no secret file base path"
  dirname "$base"
}

# Load GET /api/admin/directory/accounts/:id for the explicit subject file.
# Sets SUBJECT_* booleans/enums only; writes integration/local-user id files when present.
# SUBJECT_NOTE is a reason enum on failure paths.
load_canary_directory_subject() {
  local context="${1:-pending}"
  SUBJECT_OK="false"
  SUBJECT_NOTE="unset"
  SUBJECT_PROVIDER_OK="false"
  SUBJECT_NAME_OK="false"
  SUBJECT_ACTIVE="false"
  SUBJECT_LINK_STATUS="unknown"
  SUBJECT_HAS_LOCAL_USER="false"
  SUBJECT_LOCAL_USERNAME_OK="false"
  SUBJECT_LOCAL_NAME_OK="false"
  CANARY_SUBJECT_INTEGRATION_ID_FILE=""
  CANARY_SUBJECT_LOCAL_USER_ID_FILE=""

  local sec_dir result
  sec_dir="$(_subject_secret_dir)"
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" \
      "$SUBJECT_OWNER_NAME" \
      "$SUBJECT_OWNER_USERNAME" \
      "$sec_dir" <<'PY'
import json, os, pathlib, re, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, acct_path, owner_name, owner_username, sec_dir = sys.argv[1:7]

def emit(parts):
    print("|".join(parts))
    raise SystemExit(0)

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    account_id = pathlib.Path(acct_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit(["false", "secret_file_read_failed", "false", "false", "false", "unknown", "false", "false", "false"])
if not token:
    emit(["false", "admin_jwt_empty", "false", "false", "false", "unknown", "false", "false", "false"])
if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", account_id):
    emit(["false", "subject_not_uuid", "false", "false", "false", "unknown", "false", "false", "false"])

url = base.rstrip("/") + "/api/admin/directory/accounts/" + urllib.parse.quote(account_id, safe="")
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, method="GET")
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit(["false", f"account_http_{int(e.code)}", "false", "false", "false", "unknown", "false", "false", "false"])
except Exception:
    emit(["false", "account_transport_failed", "false", "false", "false", "unknown", "false", "false", "false"])
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit(["false", "account_bad_json", "false", "false", "false", "unknown", "false", "false", "false"])
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit(["false", f"account_http_{code}", "false", "false", "false", "unknown", "false", "false", "false"])
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
account = data.get("account") if isinstance(data.get("account"), dict) else {}
if not account:
    emit(["false", "account_missing", "false", "false", "false", "unknown", "false", "false", "false"])

provider = str(account.get("provider") or "").strip().lower()
name = account.get("name") if isinstance(account.get("name"), str) else ""
is_active = account.get("isActive") is True
link_status = str(account.get("linkStatus") or "unknown")
integration_id = str(account.get("integrationId") or "").strip()
external_user_id = str(account.get("externalUserId") or "").strip()
local_user = account.get("localUser") if isinstance(account.get("localUser"), dict) else None
local_id = str(local_user.get("id") or "").strip() if local_user else ""
local_username = str(local_user.get("username") or "").strip() if local_user else ""
local_name = str(local_user.get("name") or "") if local_user else ""

provider_ok = "true" if provider == "dingtalk" else "false"
name_ok = "true" if name == owner_name else "false"
active = "true" if is_active else "false"
has_local = "true" if local_id else "false"
local_username_ok = "true" if local_username.lower() == owner_username.lower() else "false"
local_name_ok = "true" if local_name == owner_name else "false"

if name_ok != "true":
    emit(["false", "subject_name_not_owned", provider_ok, name_ok, active, link_status, has_local, local_username_ok, local_name_ok])
if provider_ok != "true":
    emit(["false", "subject_provider_not_dingtalk", provider_ok, name_ok, active, link_status, has_local, local_username_ok, local_name_ok])
if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", integration_id):
    emit(["false", "integration_id_missing", provider_ok, name_ok, active, link_status, has_local, local_username_ok, local_name_ok])
if not external_user_id:
    emit(["false", "external_user_id_missing", provider_ok, name_ok, active, link_status, has_local, local_username_ok, local_name_ok])

sec = pathlib.Path(sec_dir)
sec.mkdir(parents=True, exist_ok=True)
integ_path = sec / "subject.integration-id"
integ_path.write_bytes(integration_id.encode("utf-8"))
os.chmod(integ_path, 0o600)
# External user id for values-free subject match against sync/preview samples (never logged).
ext_path = sec / "subject.external-user-id"
ext_path.write_bytes(external_user_id.encode("utf-8"))
os.chmod(ext_path, 0o600)
local_path = ""
if local_id:
    if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", local_id):
        emit(["false", "local_user_id_invalid", provider_ok, name_ok, active, link_status, has_local, local_username_ok, local_name_ok])
    lp = sec / "subject.local-user-id"
    lp.write_bytes(local_id.encode("utf-8"))
    os.chmod(lp, 0o600)
    local_path = str(lp)

# stdout: ok|note|provider_ok|name_ok|active|link|has_local|local_user_ok|local_name_ok|integ_file|local_file
print("|".join([
    "true", "ok", provider_ok, name_ok, active, link_status, has_local,
    local_username_ok, local_name_ok, str(integ_path), local_path,
]))
PY
  )" || {
    SUBJECT_NOTE="python_failed"
    log "load subject failed (python); values never logged"
    return 1
  }

  local ok note rest
  ok="${result%%|*}"
  rest="${result#*|}"
  note="${rest%%|*}"
  rest="${rest#*|}"
  SUBJECT_PROVIDER_OK="${rest%%|*}"
  rest="${rest#*|}"
  SUBJECT_NAME_OK="${rest%%|*}"
  rest="${rest#*|}"
  SUBJECT_ACTIVE="${rest%%|*}"
  rest="${rest#*|}"
  SUBJECT_LINK_STATUS="${rest%%|*}"
  rest="${rest#*|}"
  SUBJECT_HAS_LOCAL_USER="${rest%%|*}"
  rest="${rest#*|}"
  SUBJECT_LOCAL_USERNAME_OK="${rest%%|*}"
  rest="${rest#*|}"
  SUBJECT_LOCAL_NAME_OK="${rest%%|*}"
  rest="${rest#*|}"
  CANARY_SUBJECT_INTEGRATION_ID_FILE="${rest%%|*}"
  CANARY_SUBJECT_LOCAL_USER_ID_FILE="${rest#*|}"
  SUBJECT_NOTE="$note"
  if [[ "$ok" != "true" ]]; then
    SUBJECT_OK="false"
    log "load subject refused (${context}): note=${note} link=${SUBJECT_LINK_STATUS} active=${SUBJECT_ACTIVE}"
    return 1
  fi
  SUBJECT_OK="true"
  log "subject loaded (${context}): owned name/provider ok; link=${SUBJECT_LINK_STATUS} active=${SUBJECT_ACTIVE} has_local=${SUBJECT_HAS_LOCAL_USER} (ids never logged)"
  return 0
}

# POST /api/admin/directory/accounts/:id/admit-user under pending mode.
# Body uses fixed owned username + owned name only (no email/mobile/password).
# enableDingTalkGrant=false is intentional for pending_activation (server also forces
# grant off while DIRECTORY_PENDING_ACTIVATION_ENABLED). DingTalk OAuth grant is
# exercised only in PENDING_SSO_ACTIVATE (mode=sso + enableDingTalkGrant=true).
# Writes local user id file on success. Sets ADMIT_OK / ADMIT_NOTE / ADMIT_ACTIVATION_STATUS.
run_pending_admit() {
  local sec_dir body_file result
  ADMIT_OK="false"
  ADMIT_NOTE="unset"
  ADMIT_ACTIVATION_STATUS="unknown"
  sec_dir="$(_subject_secret_dir)"
  body_file="$(mktemp "${sec_dir}/admit.body.XXXXXX")"
  chmod 600 "$body_file"
  # Fixed owned markers only — no PII from directory account email/mobile.
  python3 - "$body_file" "$SUBJECT_OWNER_NAME" "$SUBJECT_OWNER_USERNAME" <<'PY'
import json, pathlib, sys
path, name, username = sys.argv[1], sys.argv[2], sys.argv[3]
pathlib.Path(path).write_bytes(json.dumps({
    "name": name,
    "username": username,
    # Pending admit: grant must stay false until explicit SSO activate phase.
    "enableDingTalkGrant": False,
}).encode("utf-8"))
PY
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" \
      "$body_file" \
      "$sec_dir" \
      "$SUBJECT_OWNER_NAME" \
      "$SUBJECT_OWNER_USERNAME" <<'PY'
import json, os, pathlib, re, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, acct_path, body_path, sec_dir, owner_name, owner_username = sys.argv[1:8]

def emit(ok, note, activation="unknown"):
    print(f"{ok}|{note}|{activation}")
    raise SystemExit(0)

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    account_id = pathlib.Path(acct_path).read_bytes().decode("utf-8").strip()
    body = pathlib.Path(body_path).read_bytes()
except Exception:
    emit("false", "secret_file_read_failed")
url = base.rstrip("/") + "/api/admin/directory/accounts/" + urllib.parse.quote(account_id, safe="") + "/admit-user"
req = urllib.request.Request(
    url,
    data=body,
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit("false", f"admit_http_{int(e.code)}")
except Exception:
    emit("false", "admit_transport_failed")
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit("false", "admit_bad_json")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"admit_http_{code}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
user = data.get("user") if isinstance(data.get("user"), dict) else {}
activation = str(data.get("activationStatus") or user.get("activationStatus") or "unknown")
user_id = str(user.get("id") or "").strip()
user_name = str(user.get("name") or "")
user_username = str(user.get("username") or "").strip()
if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", user_id):
    emit("false", "admit_missing_user_id", activation)
if user_name != owner_name:
    emit("false", "admit_name_mismatch", activation)
if user_username.lower() != owner_username.lower():
    emit("false", "admit_username_mismatch", activation)
if activation != "pending_activation":
    emit("false", "admit_not_pending_activation", activation)
lp = pathlib.Path(sec_dir) / "subject.local-user-id"
lp.write_bytes(user_id.encode("utf-8"))
os.chmod(lp, 0o600)
emit("true", "admitted", activation)
PY
  )" || {
    rm -f "$body_file"
    ADMIT_NOTE="python_failed"
    return 1
  }
  rm -f "$body_file"
  ADMIT_OK="${result%%|*}"
  local rest="${result#*|}"
  ADMIT_NOTE="${rest%%|*}"
  ADMIT_ACTIVATION_STATUS="${rest#*|}"
  if [[ "$ADMIT_OK" == "true" ]]; then
    CANARY_SUBJECT_LOCAL_USER_ID_FILE="$(_subject_secret_dir)/subject.local-user-id"
    log "pending admit OK activation=${ADMIT_ACTIVATION_STATUS} (ids never logged)"
    return 0
  fi
  log "pending admit refused: note=${ADMIT_NOTE}"
  return 1
}

# Assert local user activation/access state via GET /api/admin/users/:id/access.
# Sets ACCESS_OK ACCESS_IS_ACTIVE ACCESS_ACTIVATION ACCESS_NOTE
# Profile activation_status + is_active only (not membership/grant). is_active MUST be
# JSON boolean exactly equal to expected; missing/null/string/unknown all fail closed.
assert_subject_user_access_state() {
  local expect_activation="$1" expect_active="$2" context="${3:-pending}"
  ACCESS_OK="false"
  ACCESS_IS_ACTIVE="unknown"
  ACCESS_ACTIVATION="unknown"
  ACCESS_NOTE="unset"
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { ACCESS_NOTE="local_user_id_file_missing"; return 1; }
  local result
  result="$(
    python3 - "$CANARY_ADMIN_JWT_FILE" "$STAGING_API_BASE_URL" "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$expect_activation" "$expect_active" <<'PY'
import json, pathlib, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, user_path, exp_act, exp_active = sys.argv[1:6]

def emit(ok, note, is_active="unknown", activation="unknown"):
    print(f"{ok}|{note}|{is_active}|{activation}")
    raise SystemExit(0)

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    user_id = pathlib.Path(user_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit("false", "secret_file_read_failed")
url = base.rstrip("/") + "/api/admin/users/" + urllib.parse.quote(user_id, safe="") + "/access"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, method="GET")
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit("false", f"access_http_{int(e.code)}")
except Exception:
    emit("false", "access_transport_failed")
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit("false", "access_bad_json")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"access_http_{code}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
user = data.get("user") if isinstance(data.get("user"), dict) else {}
if not user:
    emit("false", "access_user_missing")
# Strict: is_active must be JSON boolean on user (prefer snake_case, else camelCase).
# Missing / null / string / number / unknown MUST fail — never coerce.
if "is_active" in user:
    is_active = user["is_active"]
elif "isActive" in user:
    is_active = user["isActive"]
else:
    emit("false", "is_active_missing")
if type(is_active) is not bool:
    emit("false", "is_active_not_boolean", "unknown")
active_s = "true" if is_active is True else "false"
activation = user.get("activationStatus")
if activation is None:
    activation = user.get("activation_status")
if type(activation) is not str or not activation.strip():
    emit("false", "activation_missing_or_not_string", active_s, "unknown")
activation = activation.strip()
if activation != exp_act:
    emit("false", "activation_mismatch", active_s, activation)
if active_s != exp_active:
    emit("false", "is_active_mismatch", active_s, activation)
emit("true", "ok", active_s, activation)
PY
  )" || {
    ACCESS_NOTE="python_failed"
    return 1
  }
  ACCESS_OK="${result%%|*}"
  local rest="${result#*|}"
  ACCESS_NOTE="${rest%%|*}"
  rest="${rest#*|}"
  ACCESS_IS_ACTIVE="${rest%%|*}"
  ACCESS_ACTIVATION="${rest#*|}"
  if [[ "$ACCESS_OK" == "true" ]]; then
    log "subject access state OK (${context}): activation=${ACCESS_ACTIVATION} is_active=${ACCESS_IS_ACTIVE}"
    return 0
  fi
  log "subject access state refused (${context}): note=${ACCESS_NOTE} activation=${ACCESS_ACTIVATION} is_active=${ACCESS_IS_ACTIVE}"
  return 1
}

# Resolve optional subject password path (path only). Prefer explicit
# CANARY_SUBJECT_PASSWORD_FILE, else subject.temp-password under secret dir.
resolve_subject_password_file() {
  if [[ -n "${CANARY_SUBJECT_PASSWORD_FILE:-}" && -s "${CANARY_SUBJECT_PASSWORD_FILE}" ]]; then
    printf '%s' "$CANARY_SUBJECT_PASSWORD_FILE"
    return 0
  fi
  if [[ -n "${CANARY_SUBJECT_TEMP_PASSWORD_FILE:-}" && -s "${CANARY_SUBJECT_TEMP_PASSWORD_FILE}" ]]; then
    printf '%s' "$CANARY_SUBJECT_TEMP_PASSWORD_FILE"
    return 0
  fi
  local candidate
  candidate="$(_subject_secret_dir)/subject.temp-password"
  if [[ -s "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}

# Prove subject password login using SUBJECT_OWNER_USERNAME + password file.
# Never uses a deliberately wrong password as evidence.
prove_subject_password_login() {
  local context="${1:-subject_login}"
  local pass_file="${2:-}"
  SUBJECT_LOGIN_OK="false"
  SUBJECT_LOGIN_NOTE="unset"
  if [[ -z "$pass_file" ]]; then
    pass_file="$(resolve_subject_password_file 2>/dev/null || true)"
  fi
  [[ -n "$pass_file" && -s "$pass_file" ]] \
    || { SUBJECT_LOGIN_NOTE="subject_password_file_missing"; return 1; }
  local result
  result="$(
    python3 - "$STAGING_API_BASE_URL" "$SUBJECT_OWNER_USERNAME" "$pass_file" <<'PY'
import json, pathlib, sys, urllib.error, urllib.request
base, username, pass_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    # Exact subject password bytes (not the canary-admin prove helper line).
    password = pathlib.Path(pass_path).read_bytes().decode("utf-8", errors="strict")
except Exception:
    print("false|secret_file_read_failed")
    raise SystemExit(0)
if password == "":
    print("false|empty_password")
    raise SystemExit(0)
body = json.dumps({"identifier": username, "password": password}).encode("utf-8")
req = urllib.request.Request(
    base.rstrip("/") + "/api/auth/login",
    data=body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    print(f"false|http_{int(e.code)}")
    raise SystemExit(0)
except Exception:
    print("false|request_failed")
    raise SystemExit(0)
try:
    data = json.loads(raw)
except Exception:
    print(f"false|http_{code}_bad_json")
    raise SystemExit(0)
token = ""
if isinstance(data, dict) and isinstance(data.get("data"), dict):
    token = data["data"].get("token") or ""
ok = code == 200 and data.get("success") is True and isinstance(token, str) and len(token) > 0
print("true|ok" if ok else f"false|http_{code}_login_rejected")
PY
  )" || {
    SUBJECT_LOGIN_NOTE="python_failed"
    return 1
  }
  SUBJECT_LOGIN_OK="${result%%|*}"
  SUBJECT_LOGIN_NOTE="${result#*|}"
  if [[ "$SUBJECT_LOGIN_OK" == "true" ]]; then
    CANARY_SUBJECT_TEMP_PASSWORD_FILE="$pass_file"
    log "subject password login OK (${context})"
    return 0
  fi
  log "subject password login FAILED (${context}): ${SUBJECT_LOGIN_NOTE}"
  return 1
}

# Denial proof ONLY with a credential that was just proven to work (same file).
# Authoritative denial evidence: HTTP 401 or 403 + JSON success=false + auth error
# string (e.g. Invalid account or password). Transport errors, 5xx, non-auth 4xx,
# and bad JSON are FAIL — never treated as successful denial.
prove_subject_login_denied_with_proven_password() {
  local context="${1:-deprovision}"
  local pass_file="${2:-${CANARY_SUBJECT_TEMP_PASSWORD_FILE:-}}"
  LOGIN_DENIED_OK="false"
  LOGIN_DENIED_NOTE="unset"
  [[ -n "$pass_file" && -s "$pass_file" ]] \
    || { LOGIN_DENIED_NOTE="proven_password_file_missing"; return 1; }
  # Must not claim denial without a positive proof in this process earlier.
  [[ "${SUBJECT_PASSWORD_PROVEN_OK:-false}" == "true" ]] \
    || { LOGIN_DENIED_NOTE="password_not_proven_before_denial"; return 1; }
  local result
  result="$(
    python3 - "$STAGING_API_BASE_URL" "$SUBJECT_OWNER_USERNAME" "$pass_file" <<'PY'
import json, pathlib, sys, urllib.error, urllib.request
base, username, pass_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    password = pathlib.Path(pass_path).read_bytes().decode("utf-8", errors="strict")
except Exception:
    print("false|secret_file_read_failed")
    raise SystemExit(0)
if password == "":
    print("false|empty_password")
    raise SystemExit(0)
body = json.dumps({"identifier": username, "password": password}).encode("utf-8")
req = urllib.request.Request(
    base.rstrip("/") + "/api/auth/login",
    data=body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="POST",
)
raw = ""
code = 0
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    code = int(e.code)
    try:
        raw = e.read().decode("utf-8", errors="replace")
    except Exception:
        print(f"false|http_{code}_body_unreadable")
        raise SystemExit(0)
except Exception:
    print("false|request_failed")
    raise SystemExit(0)
# Only 401/403 may count as auth denial. 5xx/other 4xx fail closed.
if code not in (401, 403):
    if code == 200:
        # Fall through to JSON parse — must not have a usable token.
        pass
    else:
        print(f"false|http_{code}_not_auth_denial")
        raise SystemExit(0)
try:
    data = json.loads(raw) if raw else None
except Exception:
    print(f"false|http_{code}_bad_json")
    raise SystemExit(0)
if not isinstance(data, dict):
    print(f"false|http_{code}_bad_json")
    raise SystemExit(0)
token = ""
if isinstance(data.get("data"), dict):
    token = data["data"].get("token") or ""
if code == 200 and data.get("success") is True and isinstance(token, str) and len(token) > 0:
    print("false|login_unexpectedly_succeeded")
    raise SystemExit(0)
if code in (401, 403):
    # Authoritative auth error body from production login route closed set only.
    # CSRF/gateway/other 401/403 must not false-green.
    if data.get("success") is not False:
        print(f"false|http_{code}_missing_success_false")
        raise SystemExit(0)
    err = data.get("error")
    if not isinstance(err, str):
        print(f"false|http_{code}_missing_auth_error")
        raise SystemExit(0)
    # Closed set from packages/core-backend/src/routes/auth.ts login failures.
    CLOSED_LOGIN_ERRORS = frozenset({
        "Invalid account or password",
    })
    if err in CLOSED_LOGIN_ERRORS:
        print(f"true|http_{code}_auth_denied")
        raise SystemExit(0)
    print(f"false|http_{code}_auth_error_not_in_closed_set")
    raise SystemExit(0)
print(f"false|http_{code}_not_auth_denial")
PY
  )" || {
    LOGIN_DENIED_NOTE="python_failed"
    return 1
  }
  LOGIN_DENIED_OK="${result%%|*}"
  LOGIN_DENIED_NOTE="${result#*|}"
  if [[ "$LOGIN_DENIED_OK" == "true" ]]; then
    log "subject proven-password login denied OK (${context}): ${LOGIN_DENIED_NOTE}"
    return 0
  fi
  log "subject proven-password login denial failed (${context}): ${LOGIN_DENIED_NOTE}"
  return 1
}

# POST /api/admin/users/:id/activate with mode=sso + enableDingTalkGrant=true.
# This is the DingTalk lifecycle activation path (grant/deny-row surface). Never
# temp_password. Browser OAuth negative/positive remain human NOT_EXECUTED.
run_pending_sso_activate() {
  local sec_dir body_file result
  ACTIVATE_OK="false"
  ACTIVATE_NOTE="unset"
  sec_dir="$(_subject_secret_dir)"
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { ACTIVATE_NOTE="local_user_id_file_missing"; return 1; }
  body_file="$(mktemp "${sec_dir}/activate.sso.body.XXXXXX")"
  chmod 600 "$body_file"
  python3 - "$body_file" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_bytes(json.dumps({
    "mode": "sso",
    "enableDingTalkGrant": True,
}).encode("utf-8"))
PY
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$body_file" \
      "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" <<'PY'
import json, pathlib, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, user_path, body_path, acct_path = sys.argv[1:6]

def emit(ok, note):
    print(f"{ok}|{note}")
    raise SystemExit(0)

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    user_id = pathlib.Path(user_path).read_bytes().decode("utf-8").strip()
    body = pathlib.Path(body_path).read_bytes()
    account_id = pathlib.Path(acct_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit("false", "secret_file_read_failed")
try:
    obj = json.loads(body.decode("utf-8"))
except Exception:
    emit("false", "activate_body_bad_json")
obj["directoryAccountId"] = account_id
body = json.dumps(obj).encode("utf-8")
url = base.rstrip("/") + "/api/admin/users/" + urllib.parse.quote(user_id, safe="") + "/activate"
req = urllib.request.Request(
    url,
    data=body,
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit("false", f"activate_http_{int(e.code)}")
except Exception:
    emit("false", "activate_transport_failed")
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit("false", "activate_bad_json")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"activate_http_{code}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
activation = str(data.get("activationStatus") or "")
if activation != "activated":
    emit("false", "activate_status_not_activated")
emit("true", "sso_activated")
PY
  )" || {
    rm -f "$body_file"
    ACTIVATE_NOTE="python_failed"
    return 1
  }
  rm -f "$body_file"
  ACTIVATE_OK="${result%%|*}"
  ACTIVATE_NOTE="${result#*|}"
  if [[ "$ACTIVATE_OK" == "true" ]]; then
    log "pending SSO activate OK (browser OAuth still NOT_EXECUTED; values never logged)"
    return 0
  fi
  log "pending SSO activate refused: note=${ACTIVATE_NOTE}"
  return 1
}

# POST /api/admin/directory/integrations/:id/sync/preview — collateral radius gate.
# Must run while lifecycle flags are still OFF (no env write yet). Whole-integration
# preview: require exactly one wouldDeactivateAccount, exactly one
# wouldDeactivateLinkedAccount, and the sole sampled deactivation externalUserId
# matches the explicit subject externalUserId (secret-file compare only).
# Sets PREVIEW_OK PREVIEW_NOTE PREVIEW_WOULD_DEACTIVATE PREVIEW_WOULD_DEACTIVATE_LINKED
run_deprovision_sync_preview_subject_gate() {
  PREVIEW_OK="false"
  PREVIEW_NOTE="unset"
  PREVIEW_WOULD_DEACTIVATE="0"
  PREVIEW_WOULD_DEACTIVATE_LINKED="0"
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { PREVIEW_NOTE="integration_id_file_missing"; return 1; }
  local ext_path
  ext_path="$(_subject_secret_dir)/subject.external-user-id"
  [[ -s "$ext_path" ]] || { PREVIEW_NOTE="external_user_id_file_missing"; return 1; }
  local result
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$ext_path" <<'PY'
import json, pathlib, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, integ_path, ext_path = sys.argv[1:5]

def emit(ok, note, would="0", linked="0"):
    print(f"{ok}|{note}|{would}|{linked}")
    raise SystemExit(0)

def nonneg_int(v, name):
    if type(v) is not int or v < 0:
        raise ValueError(name)
    return v

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    integration_id = pathlib.Path(integ_path).read_bytes().decode("utf-8").strip()
    subject_external = pathlib.Path(ext_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit("false", "secret_file_read_failed")
if not subject_external:
    emit("false", "subject_external_empty")
url = (
    base.rstrip("/")
    + "/api/admin/directory/integrations/"
    + urllib.parse.quote(integration_id, safe="")
    + "/sync/preview"
)
req = urllib.request.Request(
    url,
    data=b"{}",
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit("false", f"preview_http_{int(e.code)}")
except Exception:
    emit("false", "preview_transport_failed")
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit("false", "preview_bad_json")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"preview_http_{code}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
preview = data.get("preview") if isinstance(data.get("preview"), dict) else data
if not isinstance(preview, dict):
    emit("false", "preview_missing")
try:
    would = nonneg_int(preview.get("wouldDeactivateAccounts"), "wouldDeactivateAccounts")
    linked = nonneg_int(preview.get("wouldDeactivateLinkedAccounts"), "wouldDeactivateLinkedAccounts")
except Exception:
    emit("false", "preview_counts_malformed")
if would != 1:
    emit("false", "would_deactivate_not_exactly_one", str(would), str(linked))
if linked != 1:
    emit("false", "would_deactivate_linked_not_exactly_one", str(would), str(linked))
samples = preview.get("sampledDeactivations")
if not isinstance(samples, list) or len(samples) != 1:
    emit("false", "sampled_deactivations_not_exactly_one", str(would), str(linked))
sample = samples[0] if isinstance(samples[0], dict) else {}
sample_ext = str(sample.get("externalUserId") or "").strip()
if not sample_ext:
    emit("false", "sampled_external_missing", str(would), str(linked))
# Secret-file compare only — never print either id.
if sample_ext != subject_external:
    emit("false", "sampled_external_not_subject", str(would), str(linked))
if sample.get("linked") is not True:
    emit("false", "sampled_not_linked", str(would), str(linked))
emit("true", "ok", "1", "1")
PY
  )" || {
    PREVIEW_NOTE="python_failed"
    return 1
  }
  PREVIEW_OK="${result%%|*}"
  local rest="${result#*|}"
  PREVIEW_NOTE="${rest%%|*}"
  rest="${rest#*|}"
  PREVIEW_WOULD_DEACTIVATE="${rest%%|*}"
  PREVIEW_WOULD_DEACTIVATE_LINKED="${rest#*|}"
  if [[ "$PREVIEW_OK" == "true" ]]; then
    log "deprovision sync/preview subject gate OK would_deactivate=1 would_deactivate_linked=1 subject_match=true (ids never logged)"
    return 0
  fi
  log "deprovision sync/preview subject gate refused: note=${PREVIEW_NOTE} would_deactivate=${PREVIEW_WOULD_DEACTIVATE} would_deactivate_linked=${PREVIEW_WOULD_DEACTIVATE_LINKED}"
  return 1
}

# POST /api/admin/directory/integrations/:id/sync (sync body {}).
# Captures exact synchronous run.id into a secret file (never printed).
# For deprovision-apply context: requires deprovisionApplied === true.
# Sets SYNC_OK SYNC_NOTE SYNC_DEPROVISION_APPLIED SYNC_USERS_DEACTIVATED
# SYNC_ACCOUNTS_DEACTIVATED SYNC_DEPROVISION_CANDIDATES SYNC_RUN_ID_PRESENT
run_directory_sync_for_subject() {
  local context="${1:-deprovision}"
  local require_deprov_applied="${2:-false}"
  SYNC_OK="false"
  SYNC_NOTE="unset"
  SYNC_DEPROVISION_APPLIED="false"
  SYNC_USERS_DEACTIVATED="0"
  SYNC_ACCOUNTS_DEACTIVATED="0"
  SYNC_DEPROVISION_CANDIDATES="0"
  SYNC_RUN_ID_PRESENT="false"
  CANARY_SUBJECT_SYNC_RUN_ID_FILE=""
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { SYNC_NOTE="integration_id_file_missing"; return 1; }
  local sec_dir result
  sec_dir="$(_subject_secret_dir)"
  result="$(
    python3 - "$CANARY_ADMIN_JWT_FILE" "$STAGING_API_BASE_URL" "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$sec_dir" "$require_deprov_applied" "$CANARY_APPLY_STATE_FILE" "$SUBJECT_OWNER_USERNAME" <<'PY'
import json, os, pathlib, re, sys, time, urllib.error, urllib.parse, urllib.request

jwt_path, base, integ_path, sec_dir, require_applied, state_path, subject_key = sys.argv[1:8]

def emit(ok, note, applied="false", users="0", accounts="0", candidates="0", run_present="false"):
    print(f"{ok}|{note}|{applied}|{users}|{accounts}|{candidates}|{run_present}")
    raise SystemExit(0)

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    integration_id = pathlib.Path(integ_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit("false", "secret_file_read_failed")
integration_base = base.rstrip("/") + "/api/admin/directory/integrations/" + urllib.parse.quote(integration_id, safe="")
url = integration_base + "/sync"
async_apply = require_applied == "true"
reserved_run_id = ""
request_body = b"{}"
if async_apply:
    try:
        state = json.loads(pathlib.Path(state_path).read_bytes().decode("utf-8"))
    except Exception:
        emit("false", "journal_prepared_state_invalid")
    reserved_run_id = str(state.get("sync_run_id") or "").strip() if isinstance(state, dict) else ""
    if (
        not isinstance(state, dict)
        or state.get("schema") != "lifecycle-canary-deprovision-apply-state-v4"
        or state.get("phase") not in {"prepared", "run_bound"}
        or state.get("subject_key") != subject_key
        or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", reserved_run_id)
    ):
        emit("false", "journal_prepared_state_invalid")
    request_body = json.dumps(
        {"async": True, "runId": reserved_run_id},
        separators=(",", ":"),
    ).encode("utf-8")
req = urllib.request.Request(
    url,
    data=request_body,
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit("false", f"sync_http_{int(e.code)}")
except Exception:
    emit("false", "sync_transport_failed")
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit("false", "sync_bad_json")
expected_code = 202 if async_apply else 200
if code != expected_code or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"sync_http_{code}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
run = data.get("run") if isinstance(data.get("run"), dict) else {}
if not run and isinstance(data.get("id"), str):
    run = data
run_id = str(data.get("runId") if async_apply else (run.get("id") or data.get("runId") or "")).strip()
if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", run_id):
    emit("false", "sync_run_id_missing")
if async_apply and run_id != reserved_run_id:
    emit("false", "sync_run_id_mismatch")
# The run UUID was already persisted in phase=prepared before any env write or HTTP
# request. Materialize the same value for exact-run polling and ledger verification.
run_path = pathlib.Path(sec_dir) / "subject.sync-run-id"
run_path.write_bytes(run_id.encode("utf-8"))
os.chmod(run_path, 0o600)

if async_apply:
    # Record only that the reserved run now exists. This is deliberately not named
    # Terminal status and deprovision outcome are still unknown here.
    try:
        state_file = pathlib.Path(state_path)
        state = json.loads(state_file.read_bytes().decode("utf-8"))
        if (
            not isinstance(state, dict)
            or state.get("schema") != "lifecycle-canary-deprovision-apply-state-v4"
            or state.get("phase") not in {"prepared", "run_bound"}
            or state.get("subject_key") != subject_key
            or str(state.get("sync_run_id") or "").strip() != run_id
        ):
            emit("false", "journal_prepared_state_invalid", run_present="true")
        state["phase"] = "run_bound"
        state["sync_users_deactivated"] = None
        state["sync_accounts_deactivated"] = None
        state["sync_deprovision_candidates"] = None
        state["deprovision_applied"] = None
        tmp = pathlib.Path(state_path + ".tmp")
        tmp.write_bytes(json.dumps(state, separators=(",", ":")).encode("utf-8"))
        os.chmod(tmp, 0o600)
        tmp.replace(state_file)
        os.chmod(state_file, 0o600)
    except SystemExit:
        raise
    except Exception:
        emit("false", "journal_run_bind_failed", run_present="true")

    # Poll the exact async run; never use latest/sole-run inference.
    deadline = time.monotonic() + 180
    terminal = None
    while time.monotonic() < deadline:
        run_url = integration_base + "/runs/" + urllib.parse.quote(run_id, safe="")
        poll_req = urllib.request.Request(
            run_url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(poll_req, timeout=30) as poll_resp:
                poll_raw = poll_resp.read().decode("utf-8", errors="replace")
                poll_code = int(poll_resp.getcode())
        except urllib.error.HTTPError as e:
            emit("false", f"sync_poll_http_{int(e.code)}", run_present="true")
        except Exception:
            emit("false", "sync_poll_transport_failed", run_present="true")
        try:
            poll_payload = json.loads(poll_raw) if poll_raw else {}
        except Exception:
            emit("false", "sync_poll_bad_json", run_present="true")
        if poll_code != 200 or not isinstance(poll_payload, dict) or poll_payload.get("ok") is not True:
            emit("false", f"sync_poll_http_{poll_code}", run_present="true")
        poll_data = poll_payload.get("data") if isinstance(poll_payload.get("data"), dict) else {}
        exact_run = poll_data.get("run") if isinstance(poll_data.get("run"), dict) else None
        if exact_run is None or str(exact_run.get("id") or "").strip() != run_id:
            emit("false", "sync_poll_run_mismatch", run_present="true")
        status = str(exact_run.get("status") or "").strip().lower()
        if status in {"completed", "failed"}:
            terminal = exact_run
            break
        if status not in {"pending", "running"}:
            emit("false", "sync_poll_status_invalid", run_present="true")
        time.sleep(2)
    if terminal is None:
        emit("false", "sync_poll_timeout", run_present="true")
    if str(terminal.get("status") or "").strip().lower() != "completed":
        emit("false", "sync_run_failed", run_present="true")
    run = terminal

stats = run.get("stats") if isinstance(run.get("stats"), dict) else {}
if not stats and isinstance(data.get("stats"), dict):
    stats = data["stats"]
applied = stats.get("deprovisionApplied")
applied_s = "true" if applied is True else ("false" if applied is False else "unknown")
users = stats.get("deprovisionUsersDeactivatedCount")
accounts = stats.get("accountsDeactivatedCount")
candidates = stats.get("deprovisionCandidateCount")

def nonneg(v):
    if type(v) is int and v >= 0:
        return str(v)
    return "0"

if require_applied == "true" and applied is not True:
    # run id already on disk; emit run_present=true so caller upgrades journal.
    emit("false", "deprovision_not_applied_on_sync", applied_s, nonneg(users), nonneg(accounts), nonneg(candidates), "true")
if require_applied == "false" and applied is not False:
    emit("false", "deprovision_applied_not_false_on_sync", applied_s, nonneg(users), nonneg(accounts), nonneg(candidates), "true")

# Radius notes for apply: emit false WITH run_present=true so recovery journal can bind.
# Callers must journal phase=run_bound before treating this as terminal.
if require_applied == "true":
    if type(candidates) is not int or candidates != 1:
        emit("false", "sync_candidate_radius_not_one", applied_s, nonneg(users), nonneg(accounts), nonneg(candidates), "true")
    if type(accounts) is not int or accounts != 1:
        emit("false", "sync_accounts_deactivated_not_one", applied_s, nonneg(users), nonneg(accounts), nonneg(candidates), "true")
    if type(users) is not int or users != 1:
        emit("false", "sync_users_deactivated_not_one", applied_s, nonneg(users), nonneg(accounts), nonneg(candidates), "true")

emit("true", "ok", applied_s, nonneg(users), nonneg(accounts), nonneg(candidates), "true")
PY
  )" || {
    SYNC_NOTE="python_failed"
    return 1
  }
  SYNC_OK="${result%%|*}"
  local rest="${result#*|}"
  SYNC_NOTE="${rest%%|*}"
  rest="${rest#*|}"
  SYNC_DEPROVISION_APPLIED="${rest%%|*}"
  rest="${rest#*|}"
  SYNC_USERS_DEACTIVATED="${rest%%|*}"
  rest="${rest#*|}"
  SYNC_ACCOUNTS_DEACTIVATED="${rest%%|*}"
  rest="${rest#*|}"
  SYNC_DEPROVISION_CANDIDATES="${rest%%|*}"
  SYNC_RUN_ID_PRESENT="${rest#*|}"
  # Run id file is recovery anchor even when radius counts fail.
  if [[ "$SYNC_RUN_ID_PRESENT" == "true" ]]; then
    CANARY_SUBJECT_SYNC_RUN_ID_FILE="${sec_dir}/subject.sync-run-id"
  fi
  if [[ "$SYNC_OK" == "true" ]]; then
    log "directory sync OK (${context}): deprovision_applied=${SYNC_DEPROVISION_APPLIED} users_deactivated=${SYNC_USERS_DEACTIVATED} accounts_deactivated=${SYNC_ACCOUNTS_DEACTIVATED} candidates=${SYNC_DEPROVISION_CANDIDATES} run_id_present=${SYNC_RUN_ID_PRESENT}"
    return 0
  fi
  if [[ "$SYNC_RUN_ID_PRESENT" == "true" ]]; then
    log "directory sync radius/apply anomaly (${context}): note=${SYNC_NOTE} run_id_persisted=true (recovery journal required; ids never logged)"
  else
    log "directory sync refused (${context}): note=${SYNC_NOTE}"
  fi
  return 1
}

# GET deprovision events for subject; require applied event whose run_id equals the
# exact synchronous sync run.id captured in CANARY_SUBJECT_SYNC_RUN_ID_FILE.
# Also requires caller already observed deprovisionApplied=true from that sync.
# Writes matching event id to secret file for restore phase.
# Sets LEDGER_OK LEDGER_NOTE LEDGER_EVENT_COUNT LEDGER_EFFECT_COUNT LEDGER_GENERATION_PRESENT LEDGER_RUN_MATCH
verify_deprovision_ledger_for_subject() {
  LEDGER_OK="false"
  LEDGER_NOTE="unset"
  LEDGER_EVENT_COUNT="0"
  LEDGER_EFFECT_COUNT="0"
  LEDGER_GENERATION_PRESENT="false"
  LEDGER_RUN_MATCH="false"
  CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE=""
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { LEDGER_NOTE="local_user_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { LEDGER_NOTE="integration_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_SYNC_RUN_ID_FILE:-}" && -s "${CANARY_SUBJECT_SYNC_RUN_ID_FILE}" ]] \
    || { LEDGER_NOTE="sync_run_id_file_missing"; return 1; }
  [[ "${SYNC_DEPROVISION_APPLIED:-false}" == "true" ]] \
    || { LEDGER_NOTE="sync_deprovision_not_applied"; return 1; }
  local sec_dir result
  sec_dir="$(_subject_secret_dir)"
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$CANARY_SUBJECT_SYNC_RUN_ID_FILE" \
      "$sec_dir" <<'PY'
import json, os, pathlib, re, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, user_path, integ_path, run_path, sec_dir = sys.argv[1:7]

def emit(ok, note, events="0", effects="0", gen="false", run_match="false"):
    print(f"{ok}|{note}|{events}|{effects}|{gen}|{run_match}")
    raise SystemExit(0)

def get_json(token, url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            code = int(resp.getcode())
    except urllib.error.HTTPError as e:
        return int(e.code), None
    except Exception:
        return None, None
    try:
        return code, json.loads(raw) if raw else {}
    except Exception:
        return code, None

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    user_id = pathlib.Path(user_path).read_bytes().decode("utf-8").strip()
    integration_id = pathlib.Path(integ_path).read_bytes().decode("utf-8").strip()
    expected_run_id = pathlib.Path(run_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit("false", "secret_file_read_failed")
if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", expected_run_id):
    emit("false", "expected_run_id_invalid")

q = urllib.parse.urlencode({"userId": user_id, "integrationId": integration_id, "status": "applied", "limit": "50"})
code, payload = get_json(token, base.rstrip("/") + "/api/admin/directory/deprovision/events?" + q)
if code is None:
    emit("false", "events_transport_failed")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"events_http_{code if code is not None else 'na'}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
items = data.get("items") if isinstance(data.get("items"), list) else []
if not items:
    emit("false", "events_empty", "0", "0", "false", "false")

# Load-bearing: select ONLY the event whose run_id equals the exact sync run.
matched = []
for item in items:
    if not isinstance(item, dict):
        continue
    rid = str(item.get("run_id") or item.get("runId") or "").strip()
    if rid == expected_run_id:
        matched.append(item)
if not matched:
    emit("false", "event_run_id_mismatch", str(len(items)), "0", "false", "false")
if len(matched) > 1:
    emit("false", "event_run_id_ambiguous", str(len(matched)), "0", "false", "false")
event = matched[0]
event_id = str(event.get("id") or "").strip()
gen = event.get("access_generation_at_apply")
if gen is None:
    gen = event.get("accessGenerationAtApply")
gen_present = "true" if isinstance(gen, int) or (isinstance(gen, str) and gen.strip().isdigit()) else "false"
if not event_id:
    emit("false", "event_id_missing", "1", "0", gen_present, "true")
# LOAD-BEARING equality: event.run_id must equal expected sync run.id
event_run = str(event.get("run_id") or event.get("runId") or "").strip()
if event_run != expected_run_id:
    emit("false", "event_run_id_mismatch", "1", "0", gen_present, "false")

code2, payload2 = get_json(token, base.rstrip("/") + "/api/admin/directory/deprovision/events/" + urllib.parse.quote(event_id, safe="") + "/effects")
if code2 is None:
    emit("false", "effects_transport_failed", "1", "0", gen_present, "true")
if code2 != 200 or not isinstance(payload2, dict) or payload2.get("ok") is not True:
    emit("false", f"effects_http_{code2 if code2 is not None else 'na'}", "1", "0", gen_present, "true")
data2 = payload2.get("data") if isinstance(payload2.get("data"), dict) else {}
effects = data2.get("items") if isinstance(data2.get("items"), list) else []
# Closed set mirrors packages/core-backend deprovision-ledger/planner effect types.
CLOSED_EFFECT_TYPES = frozenset({"membership_changed", "grant_changed", "user_changed"})
applied_effects = []
seen_ids = set()
for fx in effects:
    if not isinstance(fx, dict):
        emit("false", "effect_not_object", "1", "0", gen_present, "true")
    # status must be exactly "applied" — empty/open/other do not count.
    st = fx.get("status")
    if type(st) is not str or st != "applied":
        emit("false", "effect_status_not_applied", "1", "0", gen_present, "true")
    fx_id = str(fx.get("id") or "").strip()
    fx_type = str(fx.get("effect_type") or fx.get("effectType") or "").strip()
    if not fx_id or not fx_type:
        emit("false", "effect_id_or_type_missing", "1", "0", gen_present, "true")
    if fx_type not in CLOSED_EFFECT_TYPES:
        emit("false", "effect_type_not_closed_set", "1", "0", gen_present, "true")
    if fx_id in seen_ids:
        emit("false", "effect_id_duplicate", "1", "0", gen_present, "true")
    seen_ids.add(fx_id)
    # Strict booleans from ledger — drive access-graph proofs later.
    ba = fx.get("before_active")
    if ba is None:
        ba = fx.get("beforeActive")
    aa = fx.get("after_active")
    if aa is None:
        aa = fx.get("afterActive")
    if type(ba) is not bool or type(aa) is not bool:
        emit("false", "effect_active_flags_not_boolean", "1", "0", gen_present, "true")
    grc = fx.get("grant_row_created")
    if grc is None:
        grc = fx.get("grantRowCreated")
    if grc is None:
        grc = False
    if type(grc) is not bool:
        emit("false", "effect_grant_row_created_not_boolean", "1", "0", gen_present, "true")
    if grc is True and fx_type != "grant_changed":
        emit("false", "effect_grant_row_created_type_invalid", "1", "0", gen_present, "true")
    if grc is True and (ba is not False or aa is not False):
        emit("false", "effect_grant_row_created_flags_invalid", "1", "0", gen_present, "true")
    applied_effects.append({
        "id": fx_id,
        "type": fx_type,
        "before_active": ba,
        "after_active": aa,
        "grant_row_created": grc,
    })
if len(applied_effects) < 1:
    emit("false", "effects_empty", "1", "0", gen_present, "true")
# Dedicated canary: exact effect type set from planner (mark_inactive + grant enabled + global clear).
type_list = [fx["type"] for fx in applied_effects]
type_set = set(type_list)
if type_set != CLOSED_EFFECT_TYPES or len(applied_effects) != 3 or len(type_list) != len(type_set):
    emit("false", "effect_type_set_not_exact_triple", "1", str(len(applied_effects)), gen_present, "true")
# Canary subject established via SSO+grant true → grant_changed flips enabled (not deny-row create).
for fx in applied_effects:
    if fx["type"] == "grant_changed" and fx["grant_row_created"] is True:
        emit("false", "grant_row_created_unexpected_for_canary", "1", str(len(applied_effects)), gen_present, "true")
    if fx["before_active"] is not True or fx["after_active"] is not False:
        emit("false", "effect_before_after_not_active_to_inactive", "1", str(len(applied_effects)), gen_present, "true")
if gen_present != "true":
    emit("false", "generation_missing", "1", str(len(applied_effects)), gen_present, "true")

ev_path = pathlib.Path(sec_dir) / "subject.deprovision-event-id"
ev_path.write_bytes(event_id.encode("utf-8"))
os.chmod(ev_path, 0o600)
fx_path = pathlib.Path(sec_dir) / "subject.deprovision-effects.json"
fx_path.write_bytes(json.dumps({"effects": applied_effects, "effect_count": len(applied_effects)}, separators=(",", ":")).encode("utf-8"))
os.chmod(fx_path, 0o600)
emit("true", "ok", "1", str(len(applied_effects)), gen_present, "true")
PY
  )" || {
    LEDGER_NOTE="python_failed"
    return 1
  }
  LEDGER_OK="${result%%|*}"
  local rest="${result#*|}"
  LEDGER_NOTE="${rest%%|*}"
  rest="${rest#*|}"
  LEDGER_EVENT_COUNT="${rest%%|*}"
  rest="${rest#*|}"
  LEDGER_EFFECT_COUNT="${rest%%|*}"
  rest="${rest#*|}"
  LEDGER_GENERATION_PRESENT="${rest%%|*}"
  LEDGER_RUN_MATCH="${rest#*|}"
  if [[ "$LEDGER_OK" == "true" ]]; then
    CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE="${sec_dir}/subject.deprovision-event-id"
    CANARY_SUBJECT_EFFECTS_FILE="${sec_dir}/subject.deprovision-effects.json"
    log "deprovision ledger OK events=${LEDGER_EVENT_COUNT} effects=${LEDGER_EFFECT_COUNT} generation_present=${LEDGER_GENERATION_PRESENT} run_match=${LEDGER_RUN_MATCH}"
    return 0
  fi
  log "deprovision ledger refused: note=${LEDGER_NOTE}"
  return 1
}

# --- recovery journal state machine (v4): prepared → run_bound → ledger_bound ---
# Host path under ~/.metasheet2 survives per-run secret cleanup. Never logs ids.
# `prepared` already owns the caller-reserved run UUID before env write / HTTP.
# Unidirectional upgrades only; restore accepts ledger_bound or reconciles
# prepared/run_bound via that exact UUID — never a latest/sole-event guess.

_journal_read_phase() {
  JOURNAL_PHASE="none"
  [[ -f "$CANARY_APPLY_STATE_FILE" && -s "$CANARY_APPLY_STATE_FILE" ]] || return 0
  JOURNAL_PHASE="$(
    python3 - "$CANARY_APPLY_STATE_FILE" <<'PY'
import json, pathlib, sys
try:
    st = json.loads(pathlib.Path(sys.argv[1]).read_bytes().decode("utf-8"))
except Exception:
    print("invalid")
    raise SystemExit(0)
print(str(st.get("phase") or "invalid") if isinstance(st, dict) else "invalid")
PY
  )"
}

refuse_existing_deprovision_apply_state() {
  if [[ -f "$CANARY_APPLY_STATE_FILE" && -s "$CANARY_APPLY_STATE_FILE" ]]; then
    fail "action=deprovision apply refused: unrecovered recovery journal exists at host path (restore/reconcile first); no env write; refuse overwrite"
  fi
}

# Create phase=prepared BEFORE env write, including a caller-reserved run UUID.
journal_init_prepared() {
  mkdir -p "$CANARY_APPLY_STATE_DIR"
  chmod 700 "$CANARY_APPLY_STATE_DIR"
  refuse_existing_deprovision_apply_state
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || fail "journal prepared: local user id file missing"
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || fail "journal prepared: integration id file missing"
  [[ -n "${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-}" && -s "${CANARY_DIRECTORY_ACCOUNT_ID_FILE}" ]] \
    || fail "journal prepared: directory account id file missing"
  local sec_dir
  sec_dir="$(_subject_secret_dir)"
  python3 - \
    "$CANARY_APPLY_STATE_FILE" \
    "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
    "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
    "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" \
    "$SUBJECT_OWNER_USERNAME" \
    "$sec_dir" <<'PY'
import json, os, pathlib, re, sys, uuid
out_path, user_path, integ_path, acct_path, subject_key, sec_dir = sys.argv[1:7]
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
if pathlib.Path(out_path).is_file() and pathlib.Path(out_path).stat().st_size > 0:
    raise SystemExit(9)
local_user_id = pathlib.Path(user_path).read_bytes().decode("utf-8").strip()
integration_id = pathlib.Path(integ_path).read_bytes().decode("utf-8").strip()
directory_account_id = pathlib.Path(acct_path).read_bytes().decode("utf-8").strip()
for val in (local_user_id, integration_id, directory_account_id):
    if not uuid_re.fullmatch(val):
        raise SystemExit(2)
run_id = str(uuid.uuid4())
payload = {
    "schema": "lifecycle-canary-deprovision-apply-state-v4",
    "phase": "prepared",
    "subject_key": subject_key,
    "local_user_id": local_user_id,
    "integration_id": integration_id,
    "directory_account_id": directory_account_id,
    "sync_run_id": run_id,
    "sync_users_deactivated": None,
    "sync_accounts_deactivated": None,
    "sync_deprovision_candidates": None,
    "deprovision_applied": None,
    "event_id": None,
    "effect_count": None,
    "effects": None,
}
tmp = pathlib.Path(out_path + ".tmp")
tmp.write_bytes(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
os.chmod(tmp, 0o600)
tmp.replace(pathlib.Path(out_path))
os.chmod(out_path, 0o600)
run_path = pathlib.Path(sec_dir) / "subject.sync-run-id"
run_path.write_bytes(run_id.encode("utf-8"))
os.chmod(run_path, 0o600)
PY
  CANARY_SUBJECT_SYNC_RUN_ID_FILE="${sec_dir}/subject.sync-run-id"
  JOURNAL_PHASE="prepared"
  log "recovery journal phase=prepared (subject + reserved run id bound before env/HTTP; ids never logged)"
}

# Finalize prepared/run_bound → run_bound after the exact async run reaches terminal.
# The async starter may already have set run_bound with null outcome fields; this step
# fills the exact terminal counts without claiming that the deprovision ledger is bound.
journal_upgrade_run_bound() {
  [[ -n "${CANARY_SUBJECT_SYNC_RUN_ID_FILE:-}" && -s "${CANARY_SUBJECT_SYNC_RUN_ID_FILE}" ]] \
    || fail "journal run_bound refused: sync run id file missing"
  python3 - \
    "$CANARY_APPLY_STATE_FILE" \
    "$CANARY_SUBJECT_SYNC_RUN_ID_FILE" \
    "$SUBJECT_OWNER_USERNAME" \
    "${SYNC_USERS_DEACTIVATED:-0}" \
    "${SYNC_ACCOUNTS_DEACTIVATED:-0}" \
    "${SYNC_DEPROVISION_CANDIDATES:-0}" \
    "${SYNC_DEPROVISION_APPLIED:-false}" <<'PY'
import json, os, pathlib, re, sys
(
    state_path, run_path, subject_key,
    users_s, accounts_s, candidates_s, applied_s,
) = sys.argv[1:8]
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
try:
    state = json.loads(pathlib.Path(state_path).read_bytes().decode("utf-8"))
except Exception:
    raise SystemExit(2)
if not isinstance(state, dict) or state.get("schema") != "lifecycle-canary-deprovision-apply-state-v4":
    raise SystemExit(3)
if state.get("subject_key") != subject_key:
    raise SystemExit(4)
if state.get("phase") not in {"prepared", "run_bound"}:
    # Strict monotonicity: prepared/run_bound may become run_bound; never overwrite ledger_bound.
    raise SystemExit(5)
run_id = pathlib.Path(run_path).read_bytes().decode("utf-8").strip()
if not uuid_re.fullmatch(run_id):
    raise SystemExit(6)
if str(state.get("sync_run_id") or "").strip() != run_id:
    raise SystemExit(7)
def as_int(s):
    try:
        v = int(s)
        return v if v >= 0 else None
    except Exception:
        return None
state["phase"] = "run_bound"
state["sync_users_deactivated"] = as_int(users_s)
state["sync_accounts_deactivated"] = as_int(accounts_s)
state["sync_deprovision_candidates"] = as_int(candidates_s)
state["deprovision_applied"] = applied_s == "true"
state["event_id"] = None
state["effect_count"] = None
state["effects"] = None
tmp = pathlib.Path(state_path + ".tmp")
tmp.write_bytes(json.dumps(state, separators=(",", ":")).encode("utf-8"))
os.chmod(tmp, 0o600)
tmp.replace(pathlib.Path(state_path))
os.chmod(state_path, 0o600)
PY
  JOURNAL_PHASE="run_bound"
  log "recovery journal phase=run_bound (exact async run + terminal outcome persisted; ledger/radius may still be abnormal; ids never logged)"
}

# Upgrade run_bound → ledger_bound with exact event + typed effects (atomic).
journal_upgrade_ledger_bound() {
  [[ -n "${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE:-}" && -s "${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE}" ]] \
    || fail "journal ledger_bound refused: event id file missing"
  [[ -n "${CANARY_SUBJECT_EFFECTS_FILE:-}" && -s "${CANARY_SUBJECT_EFFECTS_FILE}" ]] \
    || fail "journal ledger_bound refused: effects file missing"
  [[ -n "${CANARY_SUBJECT_SYNC_RUN_ID_FILE:-}" && -s "${CANARY_SUBJECT_SYNC_RUN_ID_FILE}" ]] \
    || fail "journal ledger_bound refused: run id file missing"
  python3 - \
    "$CANARY_APPLY_STATE_FILE" \
    "$CANARY_SUBJECT_SYNC_RUN_ID_FILE" \
    "$CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE" \
    "$CANARY_SUBJECT_EFFECTS_FILE" \
    "$SUBJECT_OWNER_USERNAME" <<'PY'
import json, os, pathlib, re, sys
state_path, run_path, event_path, fx_path, subject_key = sys.argv[1:6]
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
CLOSED = frozenset({"membership_changed", "grant_changed", "user_changed"})
try:
    state = json.loads(pathlib.Path(state_path).read_bytes().decode("utf-8"))
except Exception:
    raise SystemExit(2)
if not isinstance(state, dict) or state.get("schema") != "lifecycle-canary-deprovision-apply-state-v4":
    raise SystemExit(3)
if state.get("subject_key") != subject_key:
    raise SystemExit(4)
if state.get("phase") not in {"prepared", "run_bound"}:
    raise SystemExit(5)
run_id = pathlib.Path(run_path).read_bytes().decode("utf-8").strip()
event_id = pathlib.Path(event_path).read_bytes().decode("utf-8").strip()
if not uuid_re.fullmatch(run_id) or not uuid_re.fullmatch(event_id):
    raise SystemExit(6)
if str(state.get("sync_run_id") or "").strip() != run_id:
    raise SystemExit(7)
fx = json.loads(pathlib.Path(fx_path).read_bytes().decode("utf-8"))
effects = fx.get("effects") if isinstance(fx, dict) else None
if not isinstance(effects, list) or len(effects) != 3:
    raise SystemExit(8)
seen = set()
types = []
for fx_item in effects:
    if not isinstance(fx_item, dict):
        raise SystemExit(9)
    fid = str(fx_item.get("id") or "").strip()
    ftype = str(fx_item.get("type") or "").strip()
    if not uuid_re.fullmatch(fid) or ftype not in CLOSED:
        raise SystemExit(10)
    if fid in seen:
        raise SystemExit(11)
    seen.add(fid)
    types.append(ftype)
    if type(fx_item.get("before_active")) is not bool or type(fx_item.get("after_active")) is not bool:
        raise SystemExit(12)
    if type(fx_item.get("grant_row_created")) is not bool:
        raise SystemExit(13)
if set(types) != CLOSED or len(types) != 3:
    raise SystemExit(14)
state["phase"] = "ledger_bound"
state["event_id"] = event_id
state["effect_count"] = 3
state["effects"] = effects
tmp = pathlib.Path(state_path + ".tmp")
tmp.write_bytes(json.dumps(state, separators=(",", ":")).encode("utf-8"))
os.chmod(tmp, 0o600)
tmp.replace(pathlib.Path(state_path))
os.chmod(state_path, 0o600)
PY
  JOURNAL_PHASE="ledger_bound"
  log "recovery journal phase=ledger_bound (exact event+effects bound; ids never logged)"
}

# Early-fail before any deprovision write: drop prepared-only journal so re-apply is possible.
journal_clear_if_phase_prepared() {
  _journal_read_phase
  if [[ "$JOURNAL_PHASE" == "prepared" ]]; then
    rm -f "$CANARY_APPLY_STATE_FILE"
    JOURNAL_PHASE="none"
    log "cleared prepared-only recovery journal (no sync run occurred)"
  fi
}

clear_deprovision_apply_state() {
  if [[ -f "$CANARY_APPLY_STATE_FILE" ]]; then
    rm -f "$CANARY_APPLY_STATE_FILE"
    JOURNAL_PHASE="none"
    # Context-neutral: used by rehire restore and empty_fetch abort recovery.
    log "cleared recovery journal"
  fi
}

# Compat name used by older comments/tests: ledger_bound write path is journal_upgrade_ledger_bound.
persist_deprovision_apply_state() {
  journal_upgrade_ledger_bound
}

# Reconcile phase=prepared/run_bound → ledger_bound using ONLY the pre-request
# reserved run id (no sole-event / latest-event discovery). Safe at restore entry
# after a lost HTTP response or runner crash.
reconcile_run_journal_to_ledger_bound() {
  [[ -f "$CANARY_APPLY_STATE_FILE" && -s "$CANARY_APPLY_STATE_FILE" ]] \
    || { LEDGER_NOTE="journal_missing"; return 1; }
  local sec_dir
  sec_dir="$(_subject_secret_dir)"
  # Materialize run id from journal into secret file for ledger verify.
  python3 - \
    "$CANARY_APPLY_STATE_FILE" \
    "$sec_dir" \
    "$SUBJECT_OWNER_USERNAME" \
    "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
    "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
    "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" <<'PY'
import json, os, pathlib, re, sys
(
    state_path, sec_dir, subject_key,
    live_user_path, live_integ_path, live_acct_path,
) = sys.argv[1:7]
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
state = json.loads(pathlib.Path(state_path).read_bytes().decode("utf-8"))
if state.get("schema") != "lifecycle-canary-deprovision-apply-state-v4":
    raise SystemExit(2)
if state.get("subject_key") != subject_key:
    raise SystemExit(3)
if state.get("phase") not in {"prepared", "run_bound"}:
    raise SystemExit(4)
run_id = str(state.get("sync_run_id") or "").strip()
local_user_id = str(state.get("local_user_id") or "").strip()
integration_id = str(state.get("integration_id") or "").strip()
directory_account_id = str(state.get("directory_account_id") or "").strip()
for val in (run_id, local_user_id, integration_id, directory_account_id):
    if not uuid_re.fullmatch(val):
        raise SystemExit(5)
live_user = pathlib.Path(live_user_path).read_bytes().decode("utf-8").strip()
live_integ = pathlib.Path(live_integ_path).read_bytes().decode("utf-8").strip()
live_acct = pathlib.Path(live_acct_path).read_bytes().decode("utf-8").strip()
if live_user != local_user_id or live_integ != integration_id or live_acct != directory_account_id:
    raise SystemExit(6)
sec = pathlib.Path(sec_dir)
sec.mkdir(parents=True, exist_ok=True)
(sec / "subject.sync-run-id").write_bytes(run_id.encode("utf-8"))
os.chmod(sec / "subject.sync-run-id", 0o600)
# Ensure local/integ files match journal for ledger query.
(sec / "subject.local-user-id").write_bytes(local_user_id.encode("utf-8"))
os.chmod(sec / "subject.local-user-id", 0o600)
(sec / "subject.integration-id").write_bytes(integration_id.encode("utf-8"))
os.chmod(sec / "subject.integration-id", 0o600)
PY
  CANARY_SUBJECT_SYNC_RUN_ID_FILE="${sec_dir}/subject.sync-run-id"
  CANARY_SUBJECT_LOCAL_USER_ID_FILE="${sec_dir}/subject.local-user-id"
  CANARY_SUBJECT_INTEGRATION_ID_FILE="${sec_dir}/subject.integration-id"
  SYNC_DEPROVISION_APPLIED="true"
  if ! verify_deprovision_ledger_for_subject; then
    log "reconcile prepared/run_bound→ledger_bound refused: ledger note=${LEDGER_NOTE:-unset} (exact reserved run only; no sole-event guess)"
    return 1
  fi
  if ! journal_upgrade_ledger_bound; then
    log "reconcile prepared/run_bound→ledger_bound refused: journal upgrade failed"
    return 1
  fi
  log "reconcile prepared/run_bound→ledger_bound OK (exact reserved run bound; ids never logged)"
  return 0
}

# Load host journal for empty_directory_fetch safe-abort recovery only.
# Accepts EXACTLY phase=run_bound with deprovision_applied=false and no ledger
# binding. Never upgrades to ledger_bound; never auto-discovers events/runs.
# Leaves journal intact on any refuse (caller must not clear).
load_run_bound_empty_fetch_abort_journal() {
  SAFE_ABORT_JOURNAL_OK="false"
  SAFE_ABORT_JOURNAL_NOTE="unset"
  [[ -f "$CANARY_APPLY_STATE_FILE" && -s "$CANARY_APPLY_STATE_FILE" ]] \
    || { SAFE_ABORT_JOURNAL_NOTE="journal_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { SAFE_ABORT_JOURNAL_NOTE="live_local_user_id_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { SAFE_ABORT_JOURNAL_NOTE="live_integration_id_missing"; return 1; }
  [[ -n "${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-}" && -s "${CANARY_DIRECTORY_ACCOUNT_ID_FILE}" ]] \
    || { SAFE_ABORT_JOURNAL_NOTE="live_directory_account_id_missing"; return 1; }
  local sec_dir
  sec_dir="$(_subject_secret_dir)"
  if ! python3 - \
    "$CANARY_APPLY_STATE_FILE" \
    "$sec_dir" \
    "$SUBJECT_OWNER_USERNAME" \
    "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
    "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
    "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" <<'PY'
import json, os, pathlib, re, sys
(
    state_path, sec_dir, subject_key,
    live_user_path, live_integ_path, live_acct_path,
) = sys.argv[1:7]
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
try:
    state = json.loads(pathlib.Path(state_path).read_bytes().decode("utf-8"))
except Exception:
    raise SystemExit(2)
if not isinstance(state, dict) or state.get("schema") != "lifecycle-canary-deprovision-apply-state-v4":
    raise SystemExit(3)
if state.get("subject_key") != subject_key:
    raise SystemExit(4)
# Exact phase only — prepared must not skip to this recovery; ledger_bound uses restore.
if state.get("phase") != "run_bound":
    raise SystemExit(5)
# Terminal safe-abort outcome from journal_upgrade_run_bound: applied must be false.
if state.get("deprovision_applied") is not False:
    raise SystemExit(6)
# No ledger binding may exist for this recovery path.
if state.get("event_id") not in (None, ""):
    raise SystemExit(7)
if state.get("effect_count") not in (None, 0):
    raise SystemExit(8)
effects = state.get("effects")
if effects is not None and effects != []:
    raise SystemExit(9)
run_id = str(state.get("sync_run_id") or "").strip()
local_user_id = str(state.get("local_user_id") or "").strip()
integration_id = str(state.get("integration_id") or "").strip()
directory_account_id = str(state.get("directory_account_id") or "").strip()
for val in (run_id, local_user_id, integration_id, directory_account_id):
    if not uuid_re.fullmatch(val):
        raise SystemExit(10)
live_user = pathlib.Path(live_user_path).read_bytes().decode("utf-8").strip()
live_integ = pathlib.Path(live_integ_path).read_bytes().decode("utf-8").strip()
live_acct = pathlib.Path(live_acct_path).read_bytes().decode("utf-8").strip()
if live_user != local_user_id or live_integ != integration_id or live_acct != directory_account_id:
    raise SystemExit(11)
sec = pathlib.Path(sec_dir)
sec.mkdir(parents=True, exist_ok=True)
abort_run_path = sec / "subject.safe-abort-sync-run-id"
abort_run_path.write_bytes(run_id.encode("utf-8"))
os.chmod(abort_run_path, 0o600)
(sec / "subject.local-user-id").write_bytes(local_user_id.encode("utf-8"))
os.chmod(sec / "subject.local-user-id", 0o600)
(sec / "subject.integration-id").write_bytes(integration_id.encode("utf-8"))
os.chmod(sec / "subject.integration-id", 0o600)
PY
  then
    SAFE_ABORT_JOURNAL_NOTE="journal_not_run_bound_safe_abort"
    return 1
  fi
  # This immutable pin must survive the recovery sync, which writes its own
  # fresh run id to subject.sync-run-id.
  CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE="${sec_dir}/subject.safe-abort-sync-run-id"
  CANARY_SUBJECT_LOCAL_USER_ID_FILE="${sec_dir}/subject.local-user-id"
  CANARY_SUBJECT_INTEGRATION_ID_FILE="${sec_dir}/subject.integration-id"
  JOURNAL_PHASE="run_bound"
  SAFE_ABORT_JOURNAL_OK="true"
  SAFE_ABORT_JOURNAL_NOTE="ok"
  log "loaded recovery journal phase=run_bound for empty_fetch_abort recovery (exact run bound; no ledger; ids never logged)"
  return 0
}

# Prove the exact journaled sync run is terminal completed with
# deprovisionApplied=false and deprovisionAbortedReason=empty_directory_fetch.
# Binds ONLY CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE (journal run). Never latest-run guess.
prove_exact_run_empty_fetch_safe_abort() {
  SAFE_ABORT_RUN_OK="false"
  SAFE_ABORT_RUN_NOTE="unset"
  [[ -n "${CANARY_ADMIN_JWT_FILE:-}" && -s "${CANARY_ADMIN_JWT_FILE}" ]] \
    || { SAFE_ABORT_RUN_NOTE="admin_jwt_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { SAFE_ABORT_RUN_NOTE="integration_id_file_missing"; return 1; }
  [[ -n "${CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE:-}" && -s "${CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE}" ]] \
    || { SAFE_ABORT_RUN_NOTE="sync_run_id_file_missing"; return 1; }
  local result
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE" <<'PY'
import json, pathlib, re, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, integ_path, run_path = sys.argv[1:5]

def emit(ok, note):
    print(f"{ok}|{note}")
    raise SystemExit(0)

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    integration_id = pathlib.Path(integ_path).read_bytes().decode("utf-8").strip()
    run_id = pathlib.Path(run_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit("false", "secret_file_read_failed")
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
if not uuid_re.fullmatch(integration_id) or not uuid_re.fullmatch(run_id):
    emit("false", "ids_invalid")
url = (
    base.rstrip("/")
    + "/api/admin/directory/integrations/"
    + urllib.parse.quote(integration_id, safe="")
    + "/runs/"
    + urllib.parse.quote(run_id, safe="")
)
req = urllib.request.Request(
    url,
    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    method="GET",
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit("false", f"run_http_{int(e.code)}")
except Exception:
    emit("false", "run_transport_failed")
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit("false", "run_bad_json")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"run_http_{code}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
run = data.get("run") if isinstance(data.get("run"), dict) else None
if run is None and isinstance(data.get("id"), str):
    run = data
if not isinstance(run, dict):
    emit("false", "run_missing")
if str(run.get("id") or "").strip() != run_id:
    emit("false", "run_id_mismatch")
status = str(run.get("status") or "").strip().lower()
if status != "completed":
    emit("false", "run_not_completed")
stats = run.get("stats") if isinstance(run.get("stats"), dict) else {}
applied = stats.get("deprovisionApplied")
if applied is not False:
    emit("false", "deprovision_applied_not_false")
aborted = stats.get("deprovisionAbortedReason")
if aborted is None:
    aborted = stats.get("deprovision_aborted_reason")
if type(aborted) is not str or aborted.strip() != "empty_directory_fetch":
    emit("false", "aborted_reason_not_empty_directory_fetch")
# Belt: user/membership/grant deactivation counts must be zero when aborted.
for key in (
    "deprovisionUsersDeactivatedCount",
    "deprovisionGrantsDisabledCount",
    "deprovisionMembershipDeactivationAttemptedCount",
):
    val = stats.get(key)
    if val is None:
        continue
    if type(val) is not int or val != 0:
        emit("false", "non_zero_user_or_grant_or_membership_effect_count")
emit("true", "ok")
PY
  )" || {
    SAFE_ABORT_RUN_NOTE="python_failed"
    return 1
  }
  SAFE_ABORT_RUN_OK="${result%%|*}"
  SAFE_ABORT_RUN_NOTE="${result#*|}"
  if [[ "$SAFE_ABORT_RUN_OK" == "true" ]]; then
    log "exact run empty_directory_fetch safe abort proven (completed + applied=false + abortedReason match; ids never logged)"
    return 0
  fi
  log "exact run empty_directory_fetch proof refused: note=${SAFE_ABORT_RUN_NOTE}"
  return 1
}

# Load host journal for sync-failure-before-deprovision recovery only.
# Accepts EXACTLY phase=run_bound with deprovision_applied=false and no ledger
# binding (same journal shape as empty_fetch abort, different exact-run proof).
# Pins the immutable failed run id separately from any later recovery sync run.
# Leaves journal intact on any refuse (caller must not clear).
load_run_bound_sync_failure_before_deprovision_journal() {
  FAILED_SYNC_JOURNAL_OK="false"
  FAILED_SYNC_JOURNAL_NOTE="unset"
  [[ -f "$CANARY_APPLY_STATE_FILE" && -s "$CANARY_APPLY_STATE_FILE" ]] \
    || { FAILED_SYNC_JOURNAL_NOTE="journal_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { FAILED_SYNC_JOURNAL_NOTE="live_local_user_id_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { FAILED_SYNC_JOURNAL_NOTE="live_integration_id_missing"; return 1; }
  [[ -n "${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-}" && -s "${CANARY_DIRECTORY_ACCOUNT_ID_FILE}" ]] \
    || { FAILED_SYNC_JOURNAL_NOTE="live_directory_account_id_missing"; return 1; }
  local sec_dir
  sec_dir="$(_subject_secret_dir)"
  if ! python3 - \
    "$CANARY_APPLY_STATE_FILE" \
    "$sec_dir" \
    "$SUBJECT_OWNER_USERNAME" \
    "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
    "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
    "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" <<'PY'
import json, os, pathlib, re, sys
(
    state_path, sec_dir, subject_key,
    live_user_path, live_integ_path, live_acct_path,
) = sys.argv[1:7]
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
try:
    state = json.loads(pathlib.Path(state_path).read_bytes().decode("utf-8"))
except Exception:
    raise SystemExit(2)
if not isinstance(state, dict) or state.get("schema") != "lifecycle-canary-deprovision-apply-state-v4":
    raise SystemExit(3)
if state.get("subject_key") != subject_key:
    raise SystemExit(4)
# Exact phase only — prepared must not skip to this recovery; ledger_bound uses restore.
if state.get("phase") != "run_bound":
    raise SystemExit(5)
# Terminal failed-before-deprovision outcome: applied must be false (never true/null).
if state.get("deprovision_applied") is not False:
    raise SystemExit(6)
# No ledger binding may exist for this recovery path.
if state.get("event_id") not in (None, ""):
    raise SystemExit(7)
if state.get("effect_count") not in (None, 0):
    raise SystemExit(8)
effects = state.get("effects")
if effects is not None and effects != []:
    raise SystemExit(9)
run_id = str(state.get("sync_run_id") or "").strip()
local_user_id = str(state.get("local_user_id") or "").strip()
integration_id = str(state.get("integration_id") or "").strip()
directory_account_id = str(state.get("directory_account_id") or "").strip()
for val in (run_id, local_user_id, integration_id, directory_account_id):
    if not uuid_re.fullmatch(val):
        raise SystemExit(10)
live_user = pathlib.Path(live_user_path).read_bytes().decode("utf-8").strip()
live_integ = pathlib.Path(live_integ_path).read_bytes().decode("utf-8").strip()
live_acct = pathlib.Path(live_acct_path).read_bytes().decode("utf-8").strip()
if live_user != local_user_id or live_integ != integration_id or live_acct != directory_account_id:
    raise SystemExit(11)
sec = pathlib.Path(sec_dir)
sec.mkdir(parents=True, exist_ok=True)
# Immutable failed-run pin must survive the recovery sync, which writes its own
# fresh run id to subject.sync-run-id.
failed_run_path = sec / "subject.failed-sync-run-id"
failed_run_path.write_bytes(run_id.encode("utf-8"))
os.chmod(failed_run_path, 0o600)
(sec / "subject.local-user-id").write_bytes(local_user_id.encode("utf-8"))
os.chmod(sec / "subject.local-user-id", 0o600)
(sec / "subject.integration-id").write_bytes(integration_id.encode("utf-8"))
os.chmod(sec / "subject.integration-id", 0o600)
PY
  then
    FAILED_SYNC_JOURNAL_NOTE="journal_not_run_bound_failed_before_deprovision"
    return 1
  fi
  CANARY_FAILED_SYNC_RUN_ID_FILE="${sec_dir}/subject.failed-sync-run-id"
  CANARY_SUBJECT_LOCAL_USER_ID_FILE="${sec_dir}/subject.local-user-id"
  CANARY_SUBJECT_INTEGRATION_ID_FILE="${sec_dir}/subject.integration-id"
  JOURNAL_PHASE="run_bound"
  FAILED_SYNC_JOURNAL_OK="true"
  FAILED_SYNC_JOURNAL_NOTE="ok"
  log "loaded recovery journal phase=run_bound for sync_failure_before_deprovision recovery (exact failed run bound; no ledger; ids never logged)"
  return 0
}

# Prove the exact journaled sync run is terminal failed with the exact observed
# error class (values-free). Binds ONLY CANARY_FAILED_SYNC_RUN_ID_FILE.
# deprovision_applied=false is journal-bound (load_run_bound_*), not inferred from
# absent/null run stats. Zero ledger + intact access graph prove no mutation.
# Never latest-run guess. Never logs raw errorMessage / ids / secrets.
prove_exact_run_sync_failure_before_deprovision() {
  FAILED_SYNC_RUN_OK="false"
  FAILED_SYNC_RUN_NOTE="unset"
  FAILED_SYNC_ERROR_CLASS=""
  [[ -n "${CANARY_ADMIN_JWT_FILE:-}" && -s "${CANARY_ADMIN_JWT_FILE}" ]] \
    || { FAILED_SYNC_RUN_NOTE="admin_jwt_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { FAILED_SYNC_RUN_NOTE="integration_id_file_missing"; return 1; }
  [[ -n "${CANARY_FAILED_SYNC_RUN_ID_FILE:-}" && -s "${CANARY_FAILED_SYNC_RUN_ID_FILE}" ]] \
    || { FAILED_SYNC_RUN_NOTE="sync_run_id_file_missing"; return 1; }
  local result
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$CANARY_FAILED_SYNC_RUN_ID_FILE" <<'PY'
import json, pathlib, re, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, integ_path, run_path = sys.argv[1:5]

def emit(ok, note, err_class=""):
    print(f"{ok}|{note}|{err_class}")
    raise SystemExit(0)

def classify_error(msg):
    """Accept only exact observed constraint + a duplicate/unique-violation marker.

    Rejects sibling identity indexes, null-corp index, generic provider/external_key
    prose, and 23505 without the exact constraint name. Values-free: never returns msg.
    """
    # Literals live inside classify_error so contract extraction of this function
    # remains load-bearing (constants outside the function are easy to miss).
    exact_constraint = "idx_directory_accounts_provider_corp_external_key"
    exact_signature = (
        'duplicate key value violates unique constraint "'
        + exact_constraint
        + '"'
    )
    exact_error_class = "duplicate_provider_corp_external_key"
    if type(msg) is not str:
        return ""
    m = msg.lower()
    # Exact observed PostgreSQL signature required. A sibling index suffix or a
    # diagnostic that merely mentions this constraint must not qualify.
    if exact_signature not in m:
        return ""
    return exact_error_class

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    integration_id = pathlib.Path(integ_path).read_bytes().decode("utf-8").strip()
    run_id = pathlib.Path(run_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit("false", "secret_file_read_failed")
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
if not uuid_re.fullmatch(integration_id) or not uuid_re.fullmatch(run_id):
    emit("false", "ids_invalid")
url = (
    base.rstrip("/")
    + "/api/admin/directory/integrations/"
    + urllib.parse.quote(integration_id, safe="")
    + "/runs/"
    + urllib.parse.quote(run_id, safe="")
)
req = urllib.request.Request(
    url,
    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    method="GET",
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit("false", f"run_http_{int(e.code)}")
except Exception:
    emit("false", "run_transport_failed")
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit("false", "run_bad_json")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"run_http_{code}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
run = data.get("run") if isinstance(data.get("run"), dict) else None
if run is None and isinstance(data.get("id"), str):
    run = data
if not isinstance(run, dict):
    emit("false", "run_missing")
if str(run.get("id") or "").strip() != run_id:
    emit("false", "run_id_mismatch")
status = str(run.get("status") or "").strip().lower()
if status != "failed":
    emit("false", "run_not_failed")
# Fail closed only when stats explicitly claim deprovision already applied.
# Absent/null/false stats do NOT alone prove deprovision_applied=false — that is
# journal-bound; zero ledger + intact access graph are the no-mutation proofs.
stats = run.get("stats") if isinstance(run.get("stats"), dict) else {}
applied = stats.get("deprovisionApplied")
if applied is True:
    emit("false", "deprovision_applied_true")
# Belt: if effect counters are present they must be zero (still not a substitute
# for journal deprovision_applied=false or Postgres zero-ledger proof).
for key in (
    "deprovisionUsersDeactivatedCount",
    "deprovisionGrantsDisabledCount",
    "deprovisionMembershipDeactivationAttemptedCount",
):
    val = stats.get(key)
    if val is None:
        continue
    if type(val) is not int or val != 0:
        emit("false", "non_zero_user_or_grant_or_membership_effect_count")
# Exact observed error class — values-free. Never print errorMessage.
err_msg = run.get("errorMessage")
if err_msg is None:
    err_msg = run.get("error_message")
err_class = classify_error(err_msg if isinstance(err_msg, str) else "")
if not err_class:
    emit("false", "error_class_not_allowlisted")
emit("true", "ok", err_class)
PY
  )" || {
    FAILED_SYNC_RUN_NOTE="python_failed"
    return 1
  }
  FAILED_SYNC_RUN_OK="${result%%|*}"
  local rest="${result#*|}"
  FAILED_SYNC_RUN_NOTE="${rest%%|*}"
  FAILED_SYNC_ERROR_CLASS="${rest#*|}"
  if [[ "$FAILED_SYNC_RUN_OK" == "true" ]]; then
    log "exact run sync_failure_before_deprovision proven (failed + exact observed error class=${FAILED_SYNC_ERROR_CLASS}; journal binds deprovision_applied=false; ids/raw error never logged)"
    return 0
  fi
  log "exact run sync_failure_before_deprovision proof refused: note=${FAILED_SYNC_RUN_NOTE}"
  return 1
}

# Prove zero deprovision ledger events/effects for the exact journaled run via
# host docker/Postgres — never a paginated admin list / limit / latest inference.
# Scope is exact equality on run_id::uuid + integration_id::uuid + local_user_id +
# directory_account_id with NO status filter. Counts joined
# directory_deprovision_effects for matched event(s). Both counts must be 0.
# Immutable pin only: CANARY_FAILED_SYNC_RUN_ID_FILE (sync-failure recovery) or
# CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE (empty_fetch recovery). Never the recovery
# sync's subject.sync-run-id pin.
prove_zero_deprovision_ledger_for_exact_run() {
  local context="${1:-empty_fetch_abort_recovery}"
  SAFE_ABORT_LEDGER_OK="false"
  SAFE_ABORT_LEDGER_NOTE="unset"
  SAFE_ABORT_LEDGER_EVENT_COUNT="0"
  SAFE_ABORT_LEDGER_EFFECT_COUNT="0"
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { SAFE_ABORT_LEDGER_NOTE="local_user_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { SAFE_ABORT_LEDGER_NOTE="integration_id_file_missing"; return 1; }
  local exact_run_pin=""
  if [[ -n "${CANARY_FAILED_SYNC_RUN_ID_FILE:-}" && -s "${CANARY_FAILED_SYNC_RUN_ID_FILE}" ]]; then
    exact_run_pin="$CANARY_FAILED_SYNC_RUN_ID_FILE"
  elif [[ -n "${CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE:-}" && -s "${CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE}" ]]; then
    exact_run_pin="$CANARY_SAFE_ABORT_SYNC_RUN_ID_FILE"
  else
    SAFE_ABORT_LEDGER_NOTE="sync_run_id_file_missing"
    return 1
  fi
  [[ -n "${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-}" && -s "${CANARY_DIRECTORY_ACCOUNT_ID_FILE}" ]] \
    || { SAFE_ABORT_LEDGER_NOTE="directory_account_id_file_missing"; return 1; }
  local payload_json result
  payload_json="$(
    python3 - \
      "$exact_run_pin" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" <<'PY'
import json, pathlib, re, sys
run_path, integ_path, user_path, acct_path = sys.argv[1:5]
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
vals = []
for path in (run_path, integ_path, user_path, acct_path):
    try:
        raw = pathlib.Path(path).read_bytes().decode("utf-8").strip()
    except Exception:
        raise SystemExit(2)
    if not uuid_re.fullmatch(raw):
        raise SystemExit(3)
    vals.append(raw)
print(json.dumps({
    "run_id": vals[0],
    "integration_id": vals[1],
    "local_user_id": vals[2],
    "directory_account_id": vals[3],
}, separators=(",", ":")))
PY
  )" || { SAFE_ABORT_LEDGER_NOTE="ledger_payload_build_failed"; return 1; }
  if ! result="$(printf '%s' "$payload_json" | docker exec -i \
    "$BACKEND_CONTAINER" \
    node -e '
const { Client } = require("pg");
function emit(ok, note, events, effects) {
  process.stdout.write([ok, note, events, effects].join("|"));
  process.exit(0);
}
(async () => {
  let payload;
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    emit("false", "ledger_payload_invalid", "0", "0");
    return;
  }
  const runId = String(payload.run_id || "").trim();
  const integrationId = String(payload.integration_id || "").trim();
  const localUserId = String(payload.local_user_id || "").trim();
  const directoryAccountId = String(payload.directory_account_id || "").trim();
  const uuid = /^[0-9a-fA-F-]{36}$/;
  if (!uuid.test(runId) || !uuid.test(integrationId) || !uuid.test(localUserId) || !uuid.test(directoryAccountId)) {
    emit("false", "ledger_ids_invalid", "0", "0");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    emit("false", "database_url_missing", "0", "0");
    return;
  }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await c.connect();
    // Exact four-key scope. No status filter. No limit/order/latest inference.
    // run_id::uuid + integration_id::uuid + local_user_id + directory_account_id.
    const r = await c.query(
      `SELECT
         count(DISTINCT e.id)::int AS event_count,
         count(fx.id)::int AS effect_count
       FROM directory_deprovision_events e
       LEFT JOIN directory_deprovision_effects fx
         ON fx.event_id = e.id
      WHERE e.run_id = $1::uuid
        AND e.integration_id = $2::uuid
        AND e.local_user_id = $3
        AND e.directory_account_id = $4::uuid`,
      [runId, integrationId, localUserId, directoryAccountId]
    );
    if (r.rows.length !== 1) {
      emit("false", "ledger_count_row_missing", "0", "0");
      return;
    }
    const eventCount = Number(r.rows[0].event_count);
    const effectCount = Number(r.rows[0].effect_count);
    if (!Number.isInteger(eventCount) || eventCount < 0 || !Number.isInteger(effectCount) || effectCount < 0) {
      emit("false", "ledger_counts_invalid", "0", "0");
      return;
    }
    if (eventCount !== 0) {
      emit("false", "ledger_event_present_for_exact_run", String(eventCount), String(effectCount));
      return;
    }
    if (effectCount !== 0) {
      emit("false", "ledger_effect_present_for_exact_run", String(eventCount), String(effectCount));
      return;
    }
    emit("true", "ok", "0", "0");
  } catch (e) {
    emit("false", "db_query_failed", "0", "0");
  } finally {
    try { await c.end(); } catch (e2) { /* ignore */ }
  }
})().catch(() => emit("false", "db_query_failed", "0", "0"));
')"; then
    SAFE_ABORT_LEDGER_NOTE="docker_exec_failed"
    return 1
  fi
  result="$(printf '%s\n' "$result" | tail -n1 | tr -d '\r')"
  SAFE_ABORT_LEDGER_OK="${result%%|*}"
  local rest="${result#*|}"
  SAFE_ABORT_LEDGER_NOTE="${rest%%|*}"
  rest="${rest#*|}"
  SAFE_ABORT_LEDGER_EVENT_COUNT="${rest%%|*}"
  SAFE_ABORT_LEDGER_EFFECT_COUNT="${rest#*|}"
  if [[ "$SAFE_ABORT_LEDGER_OK" == "true" ]]; then
    log "zero deprovision ledger for exact run proven (${context}): events=0 effects=0 (exact SQL scope; ids never logged)"
    return 0
  fi
  log "zero deprovision ledger proof refused (${context}): note=${SAFE_ABORT_LEDGER_NOTE} events=${SAFE_ABORT_LEDGER_EVENT_COUNT} effects=${SAFE_ABORT_LEDGER_EFFECT_COUNT}"
  return 1
}

# Access-graph intact proof WITHOUT effect ledger (safe-abort path only).
# Requires: user is_active=true, org-scoped active membership >=1, DingTalk grant enabled.
# Sets INTACT_GRAPH_* for pre/post equality checks. Never prints ids.
prove_intact_access_graph_no_ledger() {
  local context="${1:-empty_fetch_abort_recovery}"
  INTACT_GRAPH_OK="false"
  INTACT_GRAPH_NOTE="unset"
  INTACT_GRAPH_USER_ACTIVE="unknown"
  INTACT_GRAPH_MEMBERSHIP_ACTIVE_COUNT="0"
  INTACT_GRAPH_GRANT_STATE="unknown"
  INTACT_GRAPH_SNAPSHOT=""
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { INTACT_GRAPH_NOTE="local_user_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { INTACT_GRAPH_NOTE="integration_id_file_missing"; return 1; }
  local payload_json result
  payload_json="$(
    python3 - \
      "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" <<'PY'
import json, pathlib, sys
u, i = sys.argv[1:3]
print(json.dumps({
    "user_id": pathlib.Path(u).read_bytes().decode("utf-8").strip(),
    "integration_id": pathlib.Path(i).read_bytes().decode("utf-8").strip(),
}, separators=(",", ":")))
PY
  )" || { INTACT_GRAPH_NOTE="graph_payload_build_failed"; return 1; }
  if ! result="$(printf '%s' "$payload_json" | docker exec -i \
    "$BACKEND_CONTAINER" \
    node -e '
const { Client } = require("pg");
function emit(ok, note, userActive, memCount, grantState) {
  process.stdout.write([ok, note, userActive, memCount, grantState].join("|"));
  process.exit(0);
}
(async () => {
  let payload;
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    emit("false", "graph_payload_invalid", "unknown", "0", "unknown");
    return;
  }
  const userId = String(payload.user_id || "").trim();
  const integrationId = String(payload.integration_id || "").trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(userId) || !/^[0-9a-fA-F-]{36}$/.test(integrationId)) {
    emit("false", "graph_ids_invalid", "unknown", "0", "unknown");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    emit("false", "database_url_missing", "unknown", "0", "unknown");
    return;
  }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await c.connect();
    const integ = await c.query(
      "SELECT org_id, status FROM directory_integrations WHERE id = $1 AND provider = $2",
      [integrationId, "dingtalk"]
    );
    if (integ.rows.length !== 1) {
      emit("false", "integration_org_not_unique", "unknown", "0", "unknown");
      return;
    }
    const orgId = String(integ.rows[0].org_id || "").trim();
    const integStatus = String(integ.rows[0].status || "").trim().toLowerCase();
    if (!orgId) {
      emit("false", "integration_org_missing", "unknown", "0", "unknown");
      return;
    }
    if (integStatus !== "active") {
      emit("false", "integration_not_active", "unknown", "0", "unknown");
      return;
    }
    const u = await c.query(
      "SELECT is_active, activation_status FROM users WHERE id = $1",
      [userId]
    );
    if (u.rows.length !== 1) {
      emit("false", "user_row_missing", "unknown", "0", "unknown");
      return;
    }
    const isActive = u.rows[0].is_active;
    if (typeof isActive !== "boolean") {
      emit("false", "user_is_active_not_boolean", "unknown", "0", "unknown");
      return;
    }
    const activation = String(u.rows[0].activation_status || "").trim();
    if (activation !== "activated") {
      emit("false", "user_not_activated", isActive ? "true" : "false", "0", "unknown");
      return;
    }
    if (isActive !== true) {
      emit("false", "user_not_active", "false", "0", "unknown");
      return;
    }
    const m = await c.query(
      "SELECT count(*)::int AS n FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND COALESCE(is_active, TRUE) = TRUE",
      [userId, orgId]
    );
    const memN = Number(m.rows[0]?.n);
    if (!Number.isInteger(memN) || memN < 1) {
      emit("false", "membership_not_active", "true", String(Number.isInteger(memN) ? memN : 0), "unknown");
      return;
    }
    const g = await c.query(
      "SELECT enabled FROM user_external_auth_grants WHERE local_user_id = $1 AND provider = $2 LIMIT 2",
      [userId, "dingtalk"]
    );
    if (g.rows.length !== 1) {
      emit("false", g.rows.length === 0 ? "grant_absent" : "grant_ambiguous", "true", String(memN), "unknown");
      return;
    }
    if (typeof g.rows[0].enabled !== "boolean" || g.rows[0].enabled !== true) {
      emit("false", "grant_not_enabled", "true", String(memN), g.rows[0].enabled === false ? "disabled" : "unknown");
      return;
    }
    emit("true", "ok", "true", String(memN), "enabled");
  } catch (e) {
    emit("false", "db_query_failed", "unknown", "0", "unknown");
  } finally {
    try { await c.end(); } catch (e2) { /* ignore */ }
  }
})().catch(() => emit("false", "db_query_failed", "unknown", "0", "unknown"));
')"; then
    INTACT_GRAPH_NOTE="docker_exec_failed"
    return 1
  fi
  result="$(printf '%s\n' "$result" | tail -n1 | tr -d '\r')"
  INTACT_GRAPH_OK="${result%%|*}"
  local rest="${result#*|}"
  INTACT_GRAPH_NOTE="${rest%%|*}"
  rest="${rest#*|}"
  INTACT_GRAPH_USER_ACTIVE="${rest%%|*}"
  rest="${rest#*|}"
  INTACT_GRAPH_MEMBERSHIP_ACTIVE_COUNT="${rest%%|*}"
  INTACT_GRAPH_GRANT_STATE="${rest#*|}"
  INTACT_GRAPH_SNAPSHOT="${INTACT_GRAPH_USER_ACTIVE}|${INTACT_GRAPH_MEMBERSHIP_ACTIVE_COUNT}|${INTACT_GRAPH_GRANT_STATE}"
  if [[ "$INTACT_GRAPH_OK" == "true" ]]; then
    log "intact access graph OK (${context}): user_active=${INTACT_GRAPH_USER_ACTIVE} membership_active_count=${INTACT_GRAPH_MEMBERSHIP_ACTIVE_COUNT} grant=${INTACT_GRAPH_GRANT_STATE}"
    return 0
  fi
  log "intact access graph refused (${context}): note=${INTACT_GRAPH_NOTE}"
  return 1
}

# Load host journal for restore. Accepts ledger_bound; prepared/run_bound first
# reconcile only the pre-request reserved run UUID. Never auto-discovers events.
load_deprovision_apply_state() {
  [[ -f "$CANARY_APPLY_STATE_FILE" && -s "$CANARY_APPLY_STATE_FILE" ]] \
    || fail "deprovision restore refused: recovery journal missing (run apply phase first); no event auto-discovery"
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || fail "deprovision restore refused: live local user id missing for state rebind"
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || fail "deprovision restore refused: live integration id missing for state rebind"
  [[ -n "${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-}" && -s "${CANARY_DIRECTORY_ACCOUNT_ID_FILE}" ]] \
    || fail "deprovision restore refused: live directory account id missing for state rebind"
  _journal_read_phase
  if [[ "$JOURNAL_PHASE" == "prepared" || "$JOURNAL_PHASE" == "run_bound" ]]; then
    log "recovery journal phase=${JOURNAL_PHASE}; attempting exact reserved-run reconcile to ledger_bound"
    if ! reconcile_run_journal_to_ledger_bound; then
      fail "deprovision restore refused: journal phase=${JOURNAL_PHASE} and exact-run ledger reconcile failed (note=${LEDGER_NOTE:-unset}); recovery_required=true; no latest/sole-event guess"
    fi
  fi
  _journal_read_phase
  if [[ "$JOURNAL_PHASE" != "ledger_bound" ]]; then
    fail "deprovision restore refused: journal phase must reconcile to ledger_bound (got '${JOURNAL_PHASE}'); no auto-discovery"
  fi
  local sec_dir loaded_count
  sec_dir="$(_subject_secret_dir)"
  loaded_count="$(
    python3 - \
      "$CANARY_APPLY_STATE_FILE" \
      "$sec_dir" \
      "$SUBJECT_OWNER_USERNAME" \
      "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" <<'PY'
import json, os, pathlib, re, sys
(
    state_path, sec_dir, subject_key,
    live_user_path, live_integ_path, live_acct_path,
) = sys.argv[1:7]
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
CLOSED = frozenset({"membership_changed", "grant_changed", "user_changed"})
try:
    state = json.loads(pathlib.Path(state_path).read_bytes().decode("utf-8"))
except Exception:
    raise SystemExit(2)
if not isinstance(state, dict) or state.get("schema") != "lifecycle-canary-deprovision-apply-state-v4":
    raise SystemExit(3)
if state.get("subject_key") != subject_key:
    raise SystemExit(4)
if state.get("phase") != "ledger_bound":
    raise SystemExit(15)
run_id = str(state.get("sync_run_id") or "").strip()
event_id = str(state.get("event_id") or "").strip()
local_user_id = str(state.get("local_user_id") or "").strip()
integration_id = str(state.get("integration_id") or "").strip()
directory_account_id = str(state.get("directory_account_id") or "").strip()
effects = state.get("effects")
count = state.get("effect_count")
for val in (run_id, event_id, local_user_id, integration_id, directory_account_id):
    if not uuid_re.fullmatch(val):
        raise SystemExit(5)
if type(count) is not int or count != 3 or not isinstance(effects, list) or len(effects) != count:
    raise SystemExit(6)
live_user = pathlib.Path(live_user_path).read_bytes().decode("utf-8").strip()
live_integ = pathlib.Path(live_integ_path).read_bytes().decode("utf-8").strip()
live_acct = pathlib.Path(live_acct_path).read_bytes().decode("utf-8").strip()
if live_user != local_user_id:
    raise SystemExit(10)
if live_integ != integration_id:
    raise SystemExit(11)
if live_acct != directory_account_id:
    raise SystemExit(12)
seen = set()
types = []
for fx in effects:
    if not isinstance(fx, dict):
        raise SystemExit(7)
    fid = str(fx.get("id") or "").strip()
    ftype = str(fx.get("type") or "").strip()
    if not uuid_re.fullmatch(fid) or ftype not in CLOSED:
        raise SystemExit(8)
    if fid in seen:
        raise SystemExit(9)
    seen.add(fid)
    types.append(ftype)
    if type(fx.get("before_active")) is not bool or type(fx.get("after_active")) is not bool:
        raise SystemExit(13)
    if type(fx.get("grant_row_created")) is not bool:
        raise SystemExit(14)
if set(types) != CLOSED:
    raise SystemExit(16)
sec = pathlib.Path(sec_dir)
sec.mkdir(parents=True, exist_ok=True)
(sec / "subject.sync-run-id").write_bytes(run_id.encode("utf-8"))
(sec / "subject.deprovision-event-id").write_bytes(event_id.encode("utf-8"))
(sec / "subject.deprovision-effects.json").write_bytes(
    json.dumps({"effects": effects, "effect_count": count}, separators=(",", ":")).encode("utf-8")
)
for name in ("subject.sync-run-id", "subject.deprovision-event-id", "subject.deprovision-effects.json"):
    os.chmod(sec / name, 0o600)
print(str(count))
PY
  )" || fail "deprovision restore refused: ledger_bound journal load failed (missing/drift); no event auto-discovery"
  CANARY_SUBJECT_SYNC_RUN_ID_FILE="${sec_dir}/subject.sync-run-id"
  CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE="${sec_dir}/subject.deprovision-event-id"
  CANARY_SUBJECT_EFFECTS_FILE="${sec_dir}/subject.deprovision-effects.json"
  LEDGER_EFFECT_COUNT="$loaded_count"
  JOURNAL_PHASE="ledger_bound"
  log "loaded recovery journal phase=ledger_bound (exact ids+run+event+effects re-verified; no auto-discovery)"
}

# POST rehire restore for EXACT event id from apply state only. No discovery.
# restoredEffectCount must equal persisted effect_count exactly (not merely >0).
run_deprovision_rehire_restore() {
  RESTORE_OK="false"
  RESTORE_NOTE="unset"
  RESTORE_EFFECT_COUNT="0"
  [[ -n "${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE:-}" && -s "${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE}" ]] \
    || { RESTORE_NOTE="event_id_file_missing_no_discovery"; return 1; }
  [[ -n "${CANARY_SUBJECT_EFFECTS_FILE:-}" && -s "${CANARY_SUBJECT_EFFECTS_FILE}" ]] \
    || { RESTORE_NOTE="effects_file_missing"; return 1; }
  local result
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE" \
      "$CANARY_SUBJECT_EFFECTS_FILE" <<'PY'
import json, pathlib, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, event_path, fx_path = sys.argv[1:5]

def emit(ok, note, effects="0"):
    print(f"{ok}|{note}|{effects}")
    raise SystemExit(0)

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    event_id = pathlib.Path(event_path).read_bytes().decode("utf-8").strip()
    fx = json.loads(pathlib.Path(fx_path).read_bytes().decode("utf-8"))
except Exception:
    emit("false", "secret_file_read_failed")
effects = fx.get("effects") if isinstance(fx, dict) else None
expected = fx.get("effect_count") if isinstance(fx, dict) else None
if not isinstance(effects, list) or len(effects) < 1:
    emit("false", "expected_effects_invalid")
if type(expected) is not int or expected != len(effects):
    expected = len(effects)
if expected < 1:
    emit("false", "expected_effect_count_invalid")
url = base.rstrip("/") + "/api/admin/directory/deprovision/events/" + urllib.parse.quote(event_id, safe="") + "/restore"
body = json.dumps({"mode": "rehire"}).encode("utf-8")
req = urllib.request.Request(
    url,
    data=body,
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        code = int(resp.getcode())
except urllib.error.HTTPError as e:
    emit("false", f"restore_http_{int(e.code)}")
except Exception:
    emit("false", "restore_transport_failed")
try:
    payload = json.loads(raw) if raw else {}
except Exception:
    emit("false", "restore_bad_json")
if code != 200 or not isinstance(payload, dict) or payload.get("ok") is not True:
    emit("false", f"restore_http_{code}")
data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
count = data.get("restoredEffectCount")
if type(count) is not int:
    count = data.get("restored_effect_count")
if type(count) is not int:
    emit("false", "restore_effect_count_invalid")
# Load-bearing: exact equality with persisted effect_count (not merely >0).
if count != expected:
    emit("false", "restore_effect_count_mismatch", str(count))
emit("true", "restored", str(count))
PY
  )" || {
    RESTORE_NOTE="python_failed"
    return 1
  }
  RESTORE_OK="${result%%|*}"
  local rest="${result#*|}"
  RESTORE_NOTE="${rest%%|*}"
  RESTORE_EFFECT_COUNT="${rest#*|}"
  if [[ "$RESTORE_OK" == "true" ]]; then
    log "deprovision rehire restore OK effects=${RESTORE_EFFECT_COUNT}"
    return 0
  fi
  log "deprovision rehire restore refused: note=${RESTORE_NOTE}"
  return 1
}

# Read the exact persisted event status from the authoritative table. A paginated
# "latest 100" list is not an identity lookup and can miss an old committed restore,
# causing a second non-idempotent POST.
read_exact_deprovision_event_status() {
  EXACT_EVENT_STATUS="unknown"
  [[ -n "${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE:-}" && -s "${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE}" ]] \
    || return 1
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || return 1
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || return 1
  local payload result
  payload="$(python3 - \
    "$CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE" \
    "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
    "$CANARY_SUBJECT_INTEGRATION_ID_FILE" <<'PY'
import json, pathlib, sys
event_path, user_path, integration_path = sys.argv[1:4]
print(json.dumps({
    "event_id": pathlib.Path(event_path).read_bytes().decode("utf-8").strip(),
    "user_id": pathlib.Path(user_path).read_bytes().decode("utf-8").strip(),
    "integration_id": pathlib.Path(integration_path).read_bytes().decode("utf-8").strip(),
}, separators=(",", ":")))
PY
  )" || return 1
  if ! result="$(printf '%s' "$payload" | docker exec -i "$BACKEND_CONTAINER" node -e '
const { Client } = require("pg");
function emit(status) { process.stdout.write(status); process.exit(0); }
(async () => {
  let p;
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    p = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) { emit("invalid"); return; }
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuid.test(String(p.event_id || "")) || !String(p.user_id || "").trim()
      || !String(p.integration_id || "").trim()) { emit("invalid"); return; }
  if (!process.env.DATABASE_URL) { emit("db_error"); return; }
  const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  try {
    await c.connect();
    const r = await c.query(
      `SELECT status
         FROM directory_deprovision_events
        WHERE id = $1::uuid
          AND local_user_id = $2
          AND integration_id = $3
        LIMIT 2`,
      [p.event_id, p.user_id, p.integration_id]
    );
    if (r.rows.length !== 1) { emit(r.rows.length === 0 ? "missing" : "ambiguous"); return; }
    const status = String(r.rows[0].status || "").trim();
    emit(["applied", "fully_resolved", "superseded"].includes(status) ? status : "invalid_status");
  } catch (e) { emit("db_error"); }
  finally { try { await c.end(); } catch (e2) {} }
})().catch(() => emit("db_error"));
')"; then
    return 1
  fi
  EXACT_EVENT_STATUS="$(printf '%s\n' "$result" | tail -n1 | tr -d '\r')"
  case "$EXACT_EVENT_STATUS" in
    applied|fully_resolved|superseded) return 0 ;;
    *) return 1 ;;
  esac
}

# After restore: exact event must be fully_resolved; live effect id set must equal
# persisted set exactly (length+ids); each type match and status exactly reversed.
# extra / missing / duplicate / non-reversed all fail closed.
verify_deprovision_event_resolved() {
  RESOLVED_OK="false"
  RESOLVED_NOTE="unset"
  [[ -n "${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE:-}" && -s "${CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE}" ]] \
    || { RESOLVED_NOTE="event_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_EFFECTS_FILE:-}" && -s "${CANARY_SUBJECT_EFFECTS_FILE}" ]] \
    || { RESOLVED_NOTE="effects_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { RESOLVED_NOTE="local_user_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { RESOLVED_NOTE="integration_id_file_missing"; return 1; }
  if ! read_exact_deprovision_event_status; then
    RESOLVED_NOTE="event_status_probe_${EXACT_EVENT_STATUS:-unknown}"
    return 1
  fi
  case "$EXACT_EVENT_STATUS" in
    fully_resolved) ;;
    superseded) RESOLVED_NOTE="event_status_superseded"; return 1 ;;
    applied) RESOLVED_NOTE="event_not_fully_resolved"; return 1 ;;
    *) RESOLVED_NOTE="event_status_${EXACT_EVENT_STATUS:-unknown}"; return 1 ;;
  esac
  local result
  result="$(
    python3 - \
      "$CANARY_ADMIN_JWT_FILE" \
      "$STAGING_API_BASE_URL" \
      "$CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE" \
      "$CANARY_SUBJECT_EFFECTS_FILE" \
      "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$EXACT_EVENT_STATUS" <<'PY'
import json, pathlib, sys, urllib.error, urllib.parse, urllib.request

jwt_path, base, event_path, fx_path, user_path, integ_path, exact_status = sys.argv[1:8]

def emit(ok, note):
    print(f"{ok}|{note}")
    raise SystemExit(0)

def get_json(token, url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            code = int(resp.getcode())
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return int(e.code), None
    except Exception:
        return None, None
    try:
        return code, json.loads(raw) if raw else {}
    except Exception:
        return code, None

try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
    event_id = pathlib.Path(event_path).read_bytes().decode("utf-8").strip()
    expected = json.loads(pathlib.Path(fx_path).read_bytes().decode("utf-8"))
    user_id = pathlib.Path(user_path).read_bytes().decode("utf-8").strip()
    integration_id = pathlib.Path(integ_path).read_bytes().decode("utf-8").strip()
except Exception:
    emit("false", "secret_file_read_failed")
expected_effects = expected.get("effects") if isinstance(expected, dict) else None
if not isinstance(expected_effects, list) or len(expected_effects) < 1:
    emit("false", "expected_effects_invalid")
expected_ids = []
seen_exp = set()
for exp in expected_effects:
    if not isinstance(exp, dict):
        emit("false", "expected_effects_invalid")
    eid = str(exp.get("id") or "").strip()
    etype = str(exp.get("type") or "").strip()
    if not eid or not etype:
        emit("false", "expected_effects_invalid")
    if eid in seen_exp:
        emit("false", "expected_effect_id_duplicate")
    seen_exp.add(eid)
    expected_ids.append(eid)

if exact_status != "fully_resolved":
    emit("false", f"event_status_{exact_status or 'missing'}")

# Live effects: exact id-set equality with persisted (no extra/missing/duplicate).
code2, payload2 = get_json(
    token,
    base.rstrip("/") + "/api/admin/directory/deprovision/events/"
    + urllib.parse.quote(event_id, safe="") + "/effects",
)
if code2 != 200 or not isinstance(payload2, dict) or payload2.get("ok") is not True:
    emit("false", f"effects_http_{code2 if code2 is not None else 'na'}")
data2 = payload2.get("data") if isinstance(payload2.get("data"), dict) else {}
effects = data2.get("items") if isinstance(data2.get("items"), list) else []
if not effects:
    emit("false", "effects_empty_after_restore")
by_id = {}
for fx in effects:
    if not isinstance(fx, dict):
        emit("false", "effect_not_object")
    fx_id = str(fx.get("id") or "").strip()
    if not fx_id:
        emit("false", "effect_id_missing")
    if fx_id in by_id:
        emit("false", "effect_id_duplicate_live")
    by_id[fx_id] = fx
# Exact set equality: same length and same ids.
if len(by_id) != len(expected_effects):
    if len(by_id) > len(expected_effects):
        emit("false", "effect_extra_live")
    emit("false", "effect_missing_after_restore")
for exp in expected_effects:
    eid = str(exp.get("id") or "").strip()
    etype = str(exp.get("type") or "").strip()
    if eid not in by_id:
        emit("false", "effect_missing_after_restore")
    live = by_id[eid]
    live_type = str(live.get("effect_type") or live.get("effectType") or "").strip()
    if live_type != etype:
        emit("false", "effect_type_mismatch")
    live_st = live.get("status")
    if type(live_st) is not str or live_st != "reversed":
        emit("false", "effect_not_reversed")
# Any live id not in expected is already caught by length+set equality above.
for live_id in by_id:
    if live_id not in seen_exp:
        emit("false", "effect_extra_live")
emit("true", "fully_resolved_all_reversed")
PY
  )" || {
    RESOLVED_NOTE="python_failed"
    return 1
  }
  RESOLVED_OK="${result%%|*}"
  RESOLVED_NOTE="${result#*|}"
  if [[ "$RESOLVED_OK" == "true" ]]; then
    log "deprovision event fully_resolved + exact effect set reversed OK"
    return 0
  fi
  log "deprovision event resolve check refused: note=${RESOLVED_NOTE}"
  return 1
}

# Idempotent runner-side restore recovery. A previous restore request may have
# committed while its response or the following verification was lost. Probe the
# exact persisted event first: fully_resolved means resume verification without a
# second non-idempotent POST; only the exact applied-state note may call restore.
run_or_resume_deprovision_rehire_restore() {
  RESTORE_RESUMED_FULLY_RESOLVED="false"
  if verify_deprovision_event_resolved; then
    RESTORE_RESUMED_FULLY_RESOLVED="true"
    RESTORE_OK="true"
    RESTORE_NOTE="already_fully_resolved"
    RESTORE_EFFECT_COUNT="${LEDGER_EFFECT_COUNT:-0}"
    log "deprovision restore resume: exact event already fully_resolved; skipping duplicate POST"
    return 0
  fi
  if [[ "${RESOLVED_NOTE:-unset}" != "event_not_fully_resolved" ]]; then
    RESTORE_NOTE="pre_restore_event_probe_${RESOLVED_NOTE:-unset}"
    return 1
  fi
  if ! run_deprovision_rehire_restore; then
    return 1
  fi
  if ! verify_deprovision_event_resolved; then
    RESTORE_NOTE="post_restore_event_probe_${RESOLVED_NOTE:-unset}"
    return 1
  fi
  return 0
}

# Authoritative access-graph proof via read-only SQL in staging backend (DATABASE_URL).
# Never prints user/ids/PII. expect_mode: deprovisioned | restored.
# Effect-metadata driven (membership_changed|grant_changed|user_changed):
#   deprovisioned → current == after_active; restored → current == before_active.
# Membership is org-scoped: resolve unique org_id from exact integration
# (provider=dingtalk, status=active), then
#   WHERE user_id=$1 AND org_id=$2 AND COALESCE(is_active,TRUE)=TRUE.
# Without a corresponding effect, that leg is not required/claimed.
# DB read failure / unknown → fail closed.
prove_access_graph_state() {
  local expect_mode="$1" context="${2:-deprovision}"
  GRAPH_OK="false"
  GRAPH_NOTE="unset"
  GRAPH_USER_ACTIVE="unknown"
  GRAPH_MEMBERSHIP_ACTIVE_COUNT="0"
  GRAPH_GRANT_STATE="unknown"
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { GRAPH_NOTE="local_user_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { GRAPH_NOTE="integration_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_EFFECTS_FILE:-}" && -s "${CANARY_SUBJECT_EFFECTS_FILE}" ]] \
    || { GRAPH_NOTE="effects_file_missing"; return 1; }
  local payload_json result
  payload_json="$(
    python3 - \
      "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$CANARY_SUBJECT_EFFECTS_FILE" \
      "$expect_mode" <<'PY'
import json, pathlib, sys
user_path, integ_path, fx_path, mode = sys.argv[1:5]
user_id = pathlib.Path(user_path).read_bytes().decode("utf-8").strip()
integration_id = pathlib.Path(integ_path).read_bytes().decode("utf-8").strip()
fx = json.loads(pathlib.Path(fx_path).read_bytes().decode("utf-8"))
effects = fx.get("effects") if isinstance(fx, dict) else None
if not isinstance(effects, list) or len(effects) < 1:
    raise SystemExit(2)
print(json.dumps({
    "user_id": user_id,
    "integration_id": integration_id,
    "mode": mode,
    "effects": effects,
}, separators=(",", ":")))
PY
  )" || { GRAPH_NOTE="graph_payload_build_failed"; return 1; }
  if ! result="$(printf '%s' "$payload_json" | docker exec -i \
    "$BACKEND_CONTAINER" \
    node -e '
const { Client } = require("pg");
function emit(ok, note, userActive, memCount, grantState) {
  process.stdout.write([ok, note, userActive, memCount, grantState].join("|"));
  process.exit(0);
}
(async () => {
  let payload;
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    emit("false", "graph_payload_invalid", "unknown", "0", "unknown");
    return;
  }
  const mode = String(payload.mode || "");
  const userId = String(payload.user_id || "").trim();
  const integrationId = String(payload.integration_id || "").trim();
  const effects = Array.isArray(payload.effects) ? payload.effects : null;
  if (!/^[0-9a-fA-F-]{36}$/.test(userId) || !/^[0-9a-fA-F-]{36}$/.test(integrationId)) {
    emit("false", "graph_ids_invalid", "unknown", "0", "unknown");
    return;
  }
  if (!effects || effects.length < 1) {
    emit("false", "graph_effects_invalid", "unknown", "0", "unknown");
    return;
  }
  if (mode !== "deprovisioned" && mode !== "restored") {
    emit("false", "expect_mode_invalid", "unknown", "0", "unknown");
    return;
  }
  const CLOSED = new Set(["membership_changed", "grant_changed", "user_changed"]);
  const seen = new Set();
  for (const fx of effects) {
    if (!fx || typeof fx !== "object") {
      emit("false", "graph_effects_invalid", "unknown", "0", "unknown");
      return;
    }
    const id = String(fx.id || "").trim();
    const type = String(fx.type || "").trim();
    if (!/^[0-9a-fA-F-]{36}$/.test(id) || !CLOSED.has(type)) {
      emit("false", "graph_effect_type_invalid", "unknown", "0", "unknown");
      return;
    }
    if (seen.has(id)) {
      emit("false", "graph_effect_id_duplicate", "unknown", "0", "unknown");
      return;
    }
    seen.add(id);
    if (typeof fx.before_active !== "boolean" || typeof fx.after_active !== "boolean") {
      emit("false", "graph_effect_flags_invalid", "unknown", "0", "unknown");
      return;
    }
    if (typeof fx.grant_row_created !== "boolean") {
      emit("false", "graph_effect_flags_invalid", "unknown", "0", "unknown");
      return;
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    emit("false", "database_url_missing", "unknown", "0", "unknown");
    return;
  }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await c.connect();
    // Exact integration → unique org (provider=dingtalk, prefer active).
    const integ = await c.query(
      "SELECT org_id, status FROM directory_integrations WHERE id = $1 AND provider = $2",
      [integrationId, "dingtalk"]
    );
    if (integ.rows.length !== 1) {
      emit("false", "integration_org_not_unique", "unknown", "0", "unknown");
      return;
    }
    const orgId = String(integ.rows[0].org_id || "").trim();
    const integStatus = String(integ.rows[0].status || "").trim().toLowerCase();
    if (!orgId) {
      emit("false", "integration_org_missing", "unknown", "0", "unknown");
      return;
    }
    if (integStatus !== "active") {
      emit("false", "integration_not_active", "unknown", "0", "unknown");
      return;
    }
    const u = await c.query(
      "SELECT is_active FROM users WHERE id = $1",
      [userId]
    );
    if (u.rows.length !== 1) {
      emit("false", "user_row_missing", "unknown", "0", "unknown");
      return;
    }
    const isActive = u.rows[0].is_active;
    if (typeof isActive !== "boolean") {
      emit("false", "user_is_active_not_boolean", "unknown", "0", "unknown");
      return;
    }
    // Org-scoped membership only — other-org active memberships must not green this.
    const m = await c.query(
      "SELECT count(*)::int AS n FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND COALESCE(is_active, TRUE) = TRUE",
      [userId, orgId]
    );
    const memN = Number(m.rows[0]?.n);
    if (!Number.isInteger(memN) || memN < 0) {
      emit("false", "membership_count_invalid", isActive ? "true" : "false", "0", "unknown");
      return;
    }
    const memActive = memN > 0;
    const g = await c.query(
      "SELECT enabled FROM user_external_auth_grants WHERE local_user_id = $1 AND provider = $2 LIMIT 2",
      [userId, "dingtalk"]
    );
    let grantState = "absent";
    if (g.rows.length > 1) {
      emit("false", "grant_ambiguous", isActive ? "true" : "false", String(memN), "unknown");
      return;
    }
    if (g.rows.length === 1) {
      if (typeof g.rows[0].enabled !== "boolean") {
        emit("false", "grant_enabled_not_boolean", isActive ? "true" : "false", String(memN), "unknown");
        return;
      }
      grantState = g.rows[0].enabled === true ? "enabled" : "disabled";
    }
    // Effect-driven proofs only — no free-floating leg requirements.
    for (const fx of effects) {
      const expected = mode === "deprovisioned" ? fx.after_active : fx.before_active;
      if (fx.type === "user_changed") {
        if (isActive !== expected) {
          emit("false", mode === "deprovisioned" ? "user_active_not_after" : "user_active_not_before",
            isActive ? "true" : "false", String(memN), grantState);
          return;
        }
      } else if (fx.type === "membership_changed") {
        if (memActive !== expected) {
          emit("false", mode === "deprovisioned" ? "membership_active_not_after" : "membership_active_not_before",
            isActive ? "true" : "false", String(memN), grantState);
          return;
        }
      } else if (fx.type === "grant_changed") {
        if (fx.grant_row_created === true) {
          if (mode === "deprovisioned") {
            // after: deny-row exists and is disabled
            if (g.rows.length !== 1 || g.rows[0].enabled !== false) {
              emit("false", "grant_row_created_not_after", isActive ? "true" : "false", String(memN), grantState);
              return;
            }
          } else {
            // restore of creation: row must be ABSENT
            if (g.rows.length !== 0) {
              emit("false", "grant_row_created_not_absent", isActive ? "true" : "false", String(memN), grantState);
              return;
            }
          }
        } else {
          const enabled = g.rows.length === 1 && g.rows[0].enabled === true;
          if (enabled !== expected) {
            emit("false", mode === "deprovisioned" ? "grant_enabled_not_after" : "grant_enabled_not_before",
              isActive ? "true" : "false", String(memN), grantState);
            return;
          }
        }
      } else {
        emit("false", "graph_effect_type_invalid", "unknown", "0", "unknown");
        return;
      }
    }
    emit("true", "ok", isActive ? "true" : "false", String(memN), grantState);
  } catch (e) {
    emit("false", "db_query_failed", "unknown", "0", "unknown");
  } finally {
    try { await c.end(); } catch (e2) { /* ignore */ }
  }
})().catch(() => emit("false", "db_query_failed", "unknown", "0", "unknown"));
')"; then
    GRAPH_NOTE="docker_exec_failed"
    return 1
  fi
  result="$(printf '%s\n' "$result" | tail -n1 | tr -d '\r')"
  GRAPH_OK="${result%%|*}"
  local rest="${result#*|}"
  GRAPH_NOTE="${rest%%|*}"
  rest="${rest#*|}"
  GRAPH_USER_ACTIVE="${rest%%|*}"
  rest="${rest#*|}"
  GRAPH_MEMBERSHIP_ACTIVE_COUNT="${rest%%|*}"
  GRAPH_GRANT_STATE="${rest#*|}"
  if [[ "$GRAPH_OK" == "true" ]]; then
    log "access graph OK (${context}): mode=${expect_mode} user_active=${GRAPH_USER_ACTIVE} membership_active_count=${GRAPH_MEMBERSHIP_ACTIVE_COUNT} grant=${GRAPH_GRANT_STATE}"
    return 0
  fi
  log "access graph refused (${context}): note=${GRAPH_NOTE}"
  return 1
}

# Read-only dedicated-subject precondition BEFORE any deprovision env write.
# Mirrors production planner inputs for mark_inactive + globally clear + grant enabled:
# exact integration (dingtalk active) org, linked account/user, target-org membership
# active, user active, no other active+linked siblings, DingTalk grant enabled,
# policy=mark_inactive. Additionally requires a scheduler/admission/group-disabled
# integration containing exactly the target and one explicit active, unlinked sentinel
# across active/inactive rows, so provider fetch remains nonempty without widening the
# one-subject journal. Expected effects: membership_changed+grant_changed+user_changed.
# other-org membership is ignored for candidacy (org-scoped membership only).
prove_dedicated_subject_deprovision_precondition() {
  PRECOND_OK="false"
  PRECOND_NOTE="unset"
  [[ -n "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" && -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]] \
    || { PRECOND_NOTE="local_user_id_file_missing"; return 1; }
  [[ -n "${CANARY_SUBJECT_INTEGRATION_ID_FILE:-}" && -s "${CANARY_SUBJECT_INTEGRATION_ID_FILE}" ]] \
    || { PRECOND_NOTE="integration_id_file_missing"; return 1; }
  [[ -n "${CANARY_DIRECTORY_ACCOUNT_ID_FILE:-}" && -s "${CANARY_DIRECTORY_ACCOUNT_ID_FILE}" ]] \
    || { PRECOND_NOTE="directory_account_id_file_missing"; return 1; }
  [[ -n "${CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE:-}" && -s "${CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE}" ]] \
    || { PRECOND_NOTE="sentinel_directory_account_id_file_missing"; return 1; }
  local payload_json result
  payload_json="$(
    python3 - \
      "$CANARY_SUBJECT_LOCAL_USER_ID_FILE" \
      "$CANARY_SUBJECT_INTEGRATION_ID_FILE" \
      "$CANARY_DIRECTORY_ACCOUNT_ID_FILE" \
      "$CANARY_SENTINEL_DIRECTORY_ACCOUNT_ID_FILE" \
      "$SENTINEL_OWNER_NAME" <<'PY'
import json, pathlib, sys
u, i, a, s, sentinel_name = sys.argv[1:6]
print(json.dumps({
    "user_id": pathlib.Path(u).read_bytes().decode("utf-8").strip(),
    "integration_id": pathlib.Path(i).read_bytes().decode("utf-8").strip(),
    "directory_account_id": pathlib.Path(a).read_bytes().decode("utf-8").strip(),
    "sentinel_directory_account_id": pathlib.Path(s).read_bytes().decode("utf-8").strip(),
    "sentinel_owner_name": sentinel_name,
}, separators=(",", ":")))
PY
  )" || { PRECOND_NOTE="precond_payload_failed"; return 1; }
  if ! result="$(printf '%s' "$payload_json" | docker exec -i \
    "$BACKEND_CONTAINER" \
    node -e '
const { Client } = require("pg");
function emit(ok, note) {
  process.stdout.write(ok + "|" + note);
  process.exit(0);
}
(async () => {
  let p;
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    p = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    emit("false", "precond_payload_invalid");
    return;
  }
  const userId = String(p.user_id || "").trim();
  const integrationId = String(p.integration_id || "").trim();
  const accountId = String(p.directory_account_id || "").trim();
  const sentinelId = String(p.sentinel_directory_account_id || "").trim();
  const sentinelOwnerName = String(p.sentinel_owner_name || "");
  const uuid = /^[0-9a-fA-F-]{36}$/;
  if (!uuid.test(userId) || !uuid.test(integrationId) || !uuid.test(accountId) || !uuid.test(sentinelId)) {
    emit("false", "precond_ids_invalid");
    return;
  }
  if (accountId.toLowerCase() === sentinelId.toLowerCase()) {
    emit("false", "target_sentinel_ids_not_distinct");
    return;
  }
  if (!sentinelOwnerName) {
    emit("false", "sentinel_owner_name_missing");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    emit("false", "database_url_missing");
    return;
  }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await c.connect();
    const integ = await c.query(
      "SELECT org_id, status, default_deprovision_policy, sync_enabled, schedule_cron, config FROM directory_integrations WHERE id = $1 AND provider = $2",
      [integrationId, "dingtalk"]
    );
    if (integ.rows.length !== 1) {
      emit("false", "integration_not_unique");
      return;
    }
    const orgId = String(integ.rows[0].org_id || "").trim();
    const status = String(integ.rows[0].status || "").trim().toLowerCase();
    const policy = String(integ.rows[0].default_deprovision_policy || "").trim();
    if (!orgId) {
      emit("false", "integration_org_missing");
      return;
    }
    if (status !== "active") {
      emit("false", "integration_not_active");
      return;
    }
    if (policy !== "mark_inactive") {
      emit("false", "policy_not_mark_inactive");
      return;
    }
    if (integ.rows[0].sync_enabled !== false || String(integ.rows[0].schedule_cron || "").trim() !== "") {
      emit("false", "integration_not_manual_only");
      return;
    }
    let config = integ.rows[0].config;
    if (typeof config === "string") {
      try { config = JSON.parse(config); } catch (e) { config = null; }
    }
    if (!config || typeof config !== "object"
        || String(config.admissionMode || "manual_only") !== "manual_only"
        || String(config.memberGroupSyncMode || "disabled") !== "disabled") {
      emit("false", "integration_automation_not_disabled");
      return;
    }
    // Closed set across ALL rows: owned target + explicit sentinel only. A stale or
    // inactive third row could be revived by the provider walk outside this journal.
    const radius = await c.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE id = $2)::int AS target_n,
              count(*) FILTER (WHERE id = $3)::int AS sentinel_n
         FROM directory_accounts
        WHERE integration_id = $1`,
      [integrationId, accountId, sentinelId]
    );
    if (Number(radius.rows[0]?.n) !== 2
        || Number(radius.rows[0]?.target_n) !== 1
        || Number(radius.rows[0]?.sentinel_n) !== 1) {
      emit("false", "integration_not_exact_target_and_sentinel");
      return;
    }
    const sentinel = await c.query(
      `SELECT s.provider, s.corp_id, s.name, s.is_active, s.integration_id,
              t.corp_id AS target_corp_id,
              EXISTS (
                SELECT 1 FROM directory_account_links l
                 WHERE l.directory_account_id = s.id
                   AND l.link_status = '\''linked'\''
              ) AS has_linked_user
         FROM directory_accounts s
         JOIN directory_accounts t ON t.id = $2
        WHERE s.id = $1`,
      [sentinelId, accountId]
    );
    const s = sentinel.rows[0];
    if (!s || String(s.provider || "").toLowerCase() !== "dingtalk") {
      emit("false", "sentinel_provider_not_dingtalk");
      return;
    }
    const sentinelCorp = String(s.corp_id || "").trim();
    const targetCorp = String(s.target_corp_id || "").trim();
    if (String(s.integration_id || "").toLowerCase() !== integrationId.toLowerCase()
        || !sentinelCorp || !targetCorp || sentinelCorp !== targetCorp) {
      emit("false", "sentinel_not_same_integration_corp");
      return;
    }
    if (s.is_active !== true) {
      emit("false", "sentinel_not_active");
      return;
    }
    if (String(s.name || "") !== sentinelOwnerName) {
      emit("false", "sentinel_name_not_owned");
      return;
    }
    if (s.has_linked_user === true) {
      emit("false", "sentinel_must_be_unlinked");
      return;
    }
    // Exact linked account/user for this integration.
    const link = await c.query(
      `SELECT 1
         FROM directory_account_links l
         JOIN directory_accounts a ON a.id = l.directory_account_id
        WHERE l.directory_account_id = $1
          AND l.local_user_id = $2
          AND l.link_status = '\''linked'\''
          AND a.integration_id = $3
          AND a.is_active = TRUE
        LIMIT 1`,
      [accountId, userId, integrationId]
    );
    if (link.rows.length !== 1) {
      emit("false", "account_not_linked_active");
      return;
    }
    const u = await c.query("SELECT is_active FROM users WHERE id = $1", [userId]);
    if (u.rows.length !== 1 || u.rows[0].is_active !== true) {
      emit("false", "user_not_active");
      return;
    }
    // Target-org membership active (other-org membership does not satisfy this).
    const mem = await c.query(
      "SELECT count(*)::int AS n FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND COALESCE(is_active, TRUE) = TRUE",
      [userId, orgId]
    );
    if (Number(mem.rows[0]?.n) < 1) {
      emit("false", "target_org_membership_not_active");
      return;
    }
    // Global clear: no other active+linked sibling directory accounts.
    const sib = await c.query(
      `SELECT count(*)::int AS n
         FROM directory_account_links l
         JOIN directory_accounts a ON a.id = l.directory_account_id
        WHERE l.local_user_id = $1
          AND l.link_status = '\''linked'\''
          AND a.is_active = TRUE
          AND a.id <> $2`,
      [userId, accountId]
    );
    if (Number(sib.rows[0]?.n) !== 0) {
      emit("false", "not_globally_clear");
      return;
    }
    const g = await c.query(
      "SELECT enabled FROM user_external_auth_grants WHERE local_user_id = $1 AND provider = $2 LIMIT 2",
      [userId, "dingtalk"]
    );
    if (g.rows.length !== 1 || g.rows[0].enabled !== true) {
      emit("false", "dingtalk_grant_not_enabled");
      return;
    }
    // Planner expectation locked for this dedicated canary.
    emit("true", "ok_expected_effects_membership_grant_user");
  } catch (e) {
    emit("false", "db_query_failed");
  } finally {
    try { await c.end(); } catch (e2) { /* ignore */ }
  }
})().catch(() => emit("false", "db_query_failed"));
')"; then
    PRECOND_NOTE="docker_exec_failed"
    return 1
  fi
  result="$(printf '%s\n' "$result" | tail -n1 | tr -d '\r')"
  PRECOND_OK="${result%%|*}"
  PRECOND_NOTE="${result#*|}"
  if [[ "$PRECOND_OK" == "true" ]]; then
    log "dedicated subject precondition OK (exact target+active unlinked sentinel, manual integration, planner mark_inactive, global_clear, grant_enabled; expected effects membership+grant+user; ids never logged)"
    return 0
  fi
  log "dedicated subject precondition refused: note=${PRECOND_NOTE}"
  return 1
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
  local live_flags
  if ! docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null | grep -qx 'true'; then
    fail "staging backend container is not running: ${BACKEND_CONTAINER}"
  fi
  if ! live_flags="$(read_live_flags)"; then
    fail "failed to read lifecycle flags from the running staging backend"
  fi
  read -r SNAP_ALIAS SNAP_PENDING SNAP_DEPROV SNAP_MODE <<< "$live_flags"
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
  # action=off only: restore-on-failure returns to whatever was on disk before the write.
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

# action=alias only: never trust on-disk prior file as rollback target.
# Runtime may be off while a stale unapplied override still has alias=true; restoring
# that file after the canary would re-enable alias on recreate. Instead: write a
# compose-validated explicit OFF (all three flags false) to disk and snapshot it as
# the sole restore baseline used by restore_lifecycle_override / fail_transition_restore.
establish_alias_off_rollback_baseline() {
  log "establishing alias rollback baseline: explicit OFF (compose-validated; ignore stale on-disk)"
  write_lifecycle_override "false" "false" "false"
  mkdir -p "$LIFECYCLE_PERSIST_DIR"
  LIFECYCLE_PREV_BACKUP="$(mktemp "${LIFECYCLE_PERSIST_DIR}/.alias-off-baseline.XXXXXX")"
  cp -p "$LIFECYCLE_OVERRIDE_FILE" "$LIFECYCLE_PREV_BACKUP"
  LIFECYCLE_PREV_STATE="present"
  # Sanity: baseline file must encode all three flags false (defense in depth).
  if ! grep -qE "${FLAG_ALIAS}:[[:space:]]*\"false\"" "$LIFECYCLE_PREV_BACKUP" \
    || ! grep -qE "${FLAG_PENDING}:[[:space:]]*\"false\"" "$LIFECYCLE_PREV_BACKUP" \
    || ! grep -qE "${FLAG_DEPROVISION}:[[:space:]]*\"false\"" "$LIFECYCLE_PREV_BACKUP"; then
    cleanup_prev_backup
    fail "alias OFF rollback baseline missing explicit false flags after write"
  fi
  if grep -qE "${FLAG_ALIAS}:[[:space:]]*\"true\"" "$LIFECYCLE_PREV_BACKUP"; then
    cleanup_prev_backup
    fail "alias OFF rollback baseline must not contain AUTH_LOGIN_USE_ALIASES true"
  fi
  log "alias rollback baseline ready: explicit OFF on disk + backup (stale prior file discarded)"
}

restore_lifecycle_override() {
  # Restore rollback baseline after a failed transition (or alias success path OFF return).
  if [[ "$LIFECYCLE_PREV_STATE" == "present" && -n "$LIFECYCLE_PREV_BACKUP" && -s "$LIFECYCLE_PREV_BACKUP" ]]; then
    cp -p "$LIFECYCLE_PREV_BACKUP" "$LIFECYCLE_OVERRIDE_FILE" || return 1
    log "restored lifecycle override from rollback baseline backup" || true
  else
    rm -f "$LIFECYCLE_OVERRIDE_FILE" || return 1
    log "removed lifecycle override (previous state was absent)" || true
  fi
  return 0
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
    echo "# action=alias|pending|deprovision may write one flag true transiently; success"
    echo "# requires/proves OFF; failure restores the compose-validated explicit OFF"
    echo "# rollback baseline (never a stale on-disk prior file). Runtime OFF cannot be"
    echo "# proven if rollback recreate fails."
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

assert_exact_mode_alias() {
  local a p d m
  read -r a p d m <<< "$(read_live_flags)"
  if [[ "$a" == "true" && "$p" == "false" && "$d" == "false" && "$m" == "alias" ]]; then
    log "exact mode proven after restart: alias (only AUTH_LOGIN_USE_ALIASES true)"
    return 0
  fi
  log "post-restart mode is '${m}' (alias=${a} pending=${p} deprovision=${d}), expected alias with only alias true"
  return 1
}

assert_exact_mode_pending() {
  local a p d m
  read -r a p d m <<< "$(read_live_flags)"
  if [[ "$a" == "false" && "$p" == "true" && "$d" == "false" && "$m" == "pending" ]]; then
    log "exact mode proven after restart: pending (only DIRECTORY_PENDING_ACTIVATION_ENABLED true)"
    return 0
  fi
  log "post-restart mode is '${m}' (alias=${a} pending=${p} deprovision=${d}), expected pending with only pending true"
  return 1
}

assert_exact_mode_deprovision() {
  local a p d m
  read -r a p d m <<< "$(read_live_flags)"
  if [[ "$a" == "false" && "$p" == "false" && "$d" == "true" && "$m" == "deprovision" ]]; then
    log "exact mode proven after restart: deprovision (only DIRECTORY_DEPROVISION_ENABLED true)"
    return 0
  fi
  log "post-restart mode is '${m}' (alias=${a} pending=${p} deprovision=${d}), expected deprovision with only deprovision true"
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

alias_exit_rollback_guard() {
  local original_rc=$?
  local restored="false" recreated="false" proved_off="false"
  local emergency_log="${OUTPUT_DIR}/alias-emergency-rollback.log"

  # Prevent recursion while the guard performs best-effort recovery.
  trap - EXIT HUP INT TERM PIPE
  if [[ "$ALIAS_ROLLBACK_ARMED" != "true" ]]; then
    exit "$original_rc"
  fi
  ALIAS_ROLLBACK_ARMED="false"
  [[ "$original_rc" -ne 0 ]] || original_rc=1

  set +e
  # Keep all recovery output off the SSH stdout/stderr pipe. A broken transport
  # may be the reason this guard fired; logging to that pipe must not block OFF.
  {
    log "alias rollback guard fired; restoring explicit OFF baseline before exit"
    if restore_lifecycle_override; then
      restored="true"
      if recreate_backend_only; then
        recreated="true"
        if [[ "$(resolve_deployed_sha)" == "$DEPLOY_SHA" ]] \
          && assert_exact_mode_off \
          && [[ "$(fetch_backend_health_ok)" == "true" ]]; then
          proved_off="true"
        fi
      fi
    fi
    cleanup_prev_backup

    if [[ "$restored" == "true" && "$recreated" == "true" && "$proved_off" == "true" ]]; then
      log "alias rollback guard proved runtime OFF after interrupted/failed canary"
    else
      echo "[lifecycle-canary][error] alias rollback guard could not prove runtime OFF (restored=${restored} recreated=${recreated} proved_off=${proved_off}); operator must inspect staging" >&2
    fi
  } >> "$emergency_log" 2>&1
  exit "$original_rc"
}

arm_alias_exit_rollback_guard() {
  ALIAS_ROLLBACK_ARMED="true"
  trap alias_exit_rollback_guard EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 141' PIPE
}

disarm_alias_exit_rollback_guard() {
  ALIAS_ROLLBACK_ARMED="false"
  trap - EXIT HUP INT TERM PIPE
}

fail_transition_restore() {
  local reason="$1"
  log "transition failure (${reason}); restoring previous lifecycle override and re-recreating backend"
  restore_lifecycle_override
  # Best-effort recreate after restore so live env matches restored override.
  recreate_backend_only || log "restore recreate did not reach health true; operator must inspect staging"
  if [[ "$ACTION" == "alias" || "$ACTION" == "pending" || "$ACTION" == "deprovision" ]]; then
    # This explicit failure path already attempted runtime restore. Avoid a
    # second EXIT-handler recreate after its backup is cleaned below.
    disarm_alias_exit_rollback_guard
  fi
  cleanup_prev_backup
  fail "action=${ACTION} failed: ${reason} (previous override restored)"
}

# Deprovision apply failure AFTER a real sync write: restore three flags OFF,
# keep host recovery journal (never clear), emit values-free recovery markers.
fail_deprovision_apply_keep_journal() {
  local reason="$1"
  _journal_read_phase
  local phase="${JOURNAL_PHASE:-unknown}"
  local exact_run="false"
  if [[ -f "$CANARY_APPLY_STATE_FILE" && -s "$CANARY_APPLY_STATE_FILE" ]]; then
    if [[ "$phase" == "prepared" || "$phase" == "run_bound" || "$phase" == "ledger_bound" ]]; then
      exact_run="true"
    fi
  fi
  log "deprovision apply failure (${reason}); restoring flags OFF; retaining recovery journal phase=${phase} exact_run_persisted=${exact_run} (ids never logged)"
  restore_lifecycle_override
  recreate_backend_only || log "restore recreate did not reach health true; operator must inspect staging"
  # Prove OFF before disarming the EXIT guard. If the first restore/recreate did not
  # converge, keep both the guard and its backup alive: `fail` below will trigger one
  # final restore/recreate attempt instead of knowingly exiting with deprovision ON.
  # The recovery journal is independent and remains retained either way.
  local flags_off="false"
  if assert_exact_mode_off 2>/dev/null; then
    flags_off="true"
    disarm_alias_exit_rollback_guard
    cleanup_prev_backup
  else
    log "flags OFF not proven after keep-journal failure path; EXIT rollback guard remains armed for a final retry"
  fi
  capture_live_snapshot 2>/dev/null || true
  {
    echo "action=deprovision"
    echo "phase=apply"
    echo "mode=${SNAP_MODE:-unknown}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=true"
    echo "recovery_required=true"
    echo "exact_run_persisted=${exact_run}"
    echo "journal_retained=true"
    echo "journal_phase=${phase}"
    echo "rolled_back_flags_off=${flags_off}"
    echo "apply_completed=false"
    echo "end_to_end_restore_claimed=false"
    echo "note=deprovision_apply_failed_recovery_journal_retained_${reason}"
  } > "${OUTPUT_DIR}/summary.txt" 2>/dev/null || true
  fail "action=deprovision apply failed: ${reason} (flags restore attempted; recovery journal retained phase=${phase}; recovery_required=true)"
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

  if [[ "$SNAP_BUILD_SHA" == "conflict" || ! "$SNAP_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
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
      # Emergency env-gate clear (handled by action=off).
      ;;
    alias)
      # Stack readiness only. action=alias additionally requires secret files +
      # real password-login / backfill / cutover-status proofs before any write.
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
      ;;
    pending|deprovision)
      # Stack readiness only. action=pending|deprovision additionally require the
      # explicit secret-backed directory account subject (no auto-selection) and
      # real admin API proofs before any write.
      if [[ "$SNAP_MODE" != "off" && "$SNAP_MODE" != "$target" ]]; then
        PREFLIGHT_OK="false"
        PREFLIGHT_NOTE="other_lifecycle_flag_on"
        return 0
      fi
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
  log "preflight OK target=${target} note=${PREFLIGHT_NOTE}"
}

# Staging-only create/repair of the fixed dedicated lifecycle canary admin.
# Never writes lifecycle env flags. Never mutates an arbitrary existing admin.
# Idempotent for the (email, id) owned row; collision fail-closed otherwise.
action_bootstrap() {
  local note="bootstrap_canary_admin"
  local login_ok="false"
  BOOTSTRAP_OUTCOME="unset"

  require_sha
  require_canary_secret_files "bootstrap"
  assert_canary_identifier_matches_owner "bootstrap"
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=bootstrap"
  [[ "$EXPECTED_CURRENT_MODE" == "off" ]] \
    || fail "action=bootstrap requires expected_current_mode=off (got '${EXPECTED_CURRENT_MODE}'); refuse auto-selection"

  capture_live_snapshot
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=bootstrap"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=bootstrap refused: backend_health_ok must be true before account mutation"
  fi
  if [[ "$SNAP_MODE" != "off" ]]; then
    fail "action=bootstrap refused: live mode must be off (live='${SNAP_MODE}')"
  fi
  if [[ "$SNAP_MODE" != "$EXPECTED_CURRENT_MODE" ]]; then
    fail "strict expected-current-mode transition failed: live='${SNAP_MODE}' expected_current_mode='${EXPECTED_CURRENT_MODE}'"
  fi

  # No lifecycle env write path exists below — collision/txn only touches fixed owned row.
  if ! bootstrap_lifecycle_canary_admin; then
    fail "action=bootstrap refused: fixed-owner create/repair failed (note=${BOOTSTRAP_OUTCOME:-unset}); no env write performed"
  fi

  # JWT iat is second-granularity while revoked_after is timestamptz. Both create
  # and repair advance the watermark, so cross the next token second before proof.
  sleep 1.1

  if prove_canary_password_login "bootstrap"; then
    login_ok="true"
  else
    fail "action=bootstrap refused: password login proof failed after create/repair (note=${BOOTSTRAP_OUTCOME:-unset})"
  fi

  # Re-prove stack posture after account mutation: mode still off, health true, SHA unchanged.
  capture_live_snapshot
  if [[ "$SNAP_MODE" != "off" ]]; then
    fail "action=bootstrap refused: post-bootstrap live mode must remain off (live='${SNAP_MODE}'); no lifecycle env write expected"
  fi
  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=bootstrap refused: post-bootstrap backend_health_ok must remain true"
  fi
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=bootstrap post-check"
  if [[ "${SNAP_BUILD_SHA:-}" != "$DEPLOY_SHA" ]]; then
    fail "action=bootstrap refused: post-bootstrap SHA '${SNAP_BUILD_SHA:-}' must match deploy_sha '${DEPLOY_SHA}'"
  fi
  assert_exact_sha

  note="bootstrap_canary_admin_${BOOTSTRAP_OUTCOME}"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "" "" "false" "$note"
  {
    echo "action=bootstrap"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=false"
    echo "bootstrap_outcome=${BOOTSTRAP_OUTCOME}"
    echo "login_ok=${login_ok}"
    echo "lifecycle_env_write=false"
    echo "post_bootstrap_mode_off=true"
    echo "post_bootstrap_health_ok=true"
    echo "post_bootstrap_sha_match=true"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=bootstrap OK outcome=${BOOTSTRAP_OUTCOME} login_ok=${login_ok} (no lifecycle env write; mode/health/SHA reasserted)"
}

# Sole executable env write: clear the exact three lifecycle flags to false.
action_off() {
  require_sha
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=off (use multi-on when live flags are multi-on)"
  validate_mode_name "$EXPECTED_CURRENT_MODE" "expected_current_mode"

  capture_live_snapshot
  assert_exact_sha
  # A failed force-recreate may leave no backend container to inspect. Keep the
  # already-proven pin for both the forward recreate and any rollback recreate.
  pin_live_backend_image_for_transition
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
  if [[ "$(resolve_deployed_sha)" != "$DEPLOY_SHA" ]]; then
    fail_transition_restore "post_restart_sha_mismatch"
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

# Transient secret-backed alias cutover canary.
# Success requires/proves OFF (mode+post-rollback login). Failure restores the
# compose-validated explicit OFF rollback baseline before failing (never a stale
# on-disk prior file). Persistent override is left explicitly OFF. Runtime OFF
# cannot be proven if rollback recreate fails (OFF baseline restored on disk;
# operator must inspect). Backfill rows may persist.
# Admin JWT is minted from the canary password login into a chmod-600 per-run
# remote file after successful pre-login — never secrets.ATTENDANCE_ADMIN_JWT.
action_alias() {
  local pre_login_ok="false"
  local post_on_login_ok="false"
  local post_rollback_login_ok="false"
  local rolled_back_to_off="false"
  local alias_on_applied="false"
  local admin_jwt_minted="false"
  local note="alias_cutover_canary"

  require_sha
  require_canary_secret_files "alias"
  assert_canary_identifier_matches_owner "alias"
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=alias"
  [[ "$EXPECTED_CURRENT_MODE" == "off" ]] \
    || fail "action=alias requires expected_current_mode=off (got '${EXPECTED_CURRENT_MODE}'); refuse auto-selection"

  capture_live_snapshot
  assert_exact_sha
  pin_live_backend_image_for_transition
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=alias"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=alias refused: backend_health_ok must be true before any env write"
  fi
  if [[ "$SNAP_MODE" != "off" ]]; then
    fail "action=alias refused: live mode must be off before cutover (live='${SNAP_MODE}')"
  fi
  if [[ "$SNAP_MODE" != "$EXPECTED_CURRENT_MODE" ]]; then
    fail "strict expected-current-mode transition failed: live='${SNAP_MODE}' expected_current_mode='${EXPECTED_CURRENT_MODE}'"
  fi

  # 1) Pre-write real password login (OR-column path while mode=off) AND mint
  #    short-lived admin JWT into a chmod-600 per-run secret file for admin APIs.
  #    Never read/overwrite secrets.ATTENDANCE_ADMIN_JWT.
  if mint_canary_admin_jwt_from_password_login "pre_on"; then
    pre_login_ok="true"
    admin_jwt_minted="true"
  else
    fail "action=alias refused: pre-ON password login / JWT mint failed (no env write performed)"
  fi
  [[ -n "${CANARY_ADMIN_JWT_FILE:-}" && -s "${CANARY_ADMIN_JWT_FILE}" ]] \
    || fail "action=alias refused: admin JWT file missing after mint (no env write performed)"

  # 2) T2a backfill + T2b readiness via minted admin JWT file (no env write yet).
  if ! run_alias_backfill; then
    fail "action=alias refused: login-aliases backfill failed (no env write performed)"
  fi
  if ! run_alias_cutover_status; then
    fail "action=alias refused: cutover-status not ready/canEnableCutover (no env write performed)"
  fi

  # 3) Explicit OFF rollback baseline (not stale on-disk) → write alias ON → recreate
  #    → prove SHA/mode/health + post-ON login. fail_transition_restore always restores
  #    that OFF baseline (never an arbitrary prior file).
  establish_alias_off_rollback_baseline
  # Arm before the persistent ON write. Any unhandled exit, SSH/HUP, cancellation,
  # or signal in the ON window restores/recreates/proves the explicit OFF baseline.
  arm_alias_exit_rollback_guard
  write_lifecycle_override "true" "false" "false"
  alias_on_applied="true"

  if ! recreate_backend_only; then
    fail_transition_restore "backend_health_not_true_after_restart"
  fi
  if [[ "$(resolve_deployed_sha)" != "$DEPLOY_SHA" ]]; then
    fail_transition_restore "post_restart_sha_mismatch"
  fi
  if ! assert_exact_mode_alias; then
    fail_transition_restore "post_restart_mode_not_alias"
  fi
  if prove_canary_password_login "post_on"; then
    post_on_login_ok="true"
  else
    fail_transition_restore "post_on_password_login_failed"
  fi

  # 4) Success path: restore explicit OFF baseline, re-recreate, prove OFF + login.
  # If rollback recreate fails, runtime OFF cannot be proven (OFF baseline on disk).
  log "alias ON proven; restoring explicit OFF rollback baseline (success requires/proves OFF; canary must not leave alias enabled)"
  restore_lifecycle_override
  if ! recreate_backend_only; then
    fail "action=alias: ON proven but rollback recreate failed — runtime OFF cannot be proven (explicit OFF baseline restored on disk; operator must inspect staging)"
  fi
  if [[ "$(resolve_deployed_sha)" != "$DEPLOY_SHA" ]]; then
    fail "action=alias: rollback SHA mismatch after restore — runtime OFF not fully proven (operator must inspect staging)"
  fi
  if ! assert_exact_mode_off; then
    fail "action=alias: rollback did not prove exact mode=off (operator must inspect staging)"
  fi
  if [[ "$(fetch_backend_health_ok)" != "true" ]]; then
    fail "action=alias: rollback backend health not true — runtime OFF not fully proven (operator must inspect staging)"
  fi
  if prove_canary_password_login "post_rollback"; then
    post_rollback_login_ok="true"
  else
    fail "action=alias: post-rollback password login failed after mode=off proof (operator must inspect credentials/stack)"
  fi
  rolled_back_to_off="true"
  disarm_alias_exit_rollback_guard
  cleanup_prev_backup

  capture_live_snapshot
  note="alias_cutover_canary_success_proved_off"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "alias" "true" "true" "$note"
  {
    echo "action=alias"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=true"
    echo "from_mode=off"
    echo "to_mode=off"
    echo "alias_on_applied=${alias_on_applied}"
    echo "pre_login_ok=${pre_login_ok}"
    echo "admin_jwt_minted=${admin_jwt_minted}"
    echo "post_on_login_ok=${post_on_login_ok}"
    echo "post_rollback_login_ok=${post_rollback_login_ok}"
    echo "rolled_back_to_off=${rolled_back_to_off}"
    echo "backfill_ok=${BACKFILL_OK:-false}"
    echo "backfill_inserted=${BACKFILL_INSERTED:-0}"
    echo "backfill_collisions=${BACKFILL_COLLISIONS:-0}"
    echo "backfill_skipped_empty=${BACKFILL_SKIPPED:-0}"
    echo "cutover_ready=${CUTOVER_READY:-false}"
    echo "cutover_can_enable=${CUTOVER_CAN_ENABLE:-false}"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=alias OK (transient ON proven; success proved OFF; backfill may persist)"
}

# Staging-only create/repair of the FIXED separate human platform administrator.
# Authenticates admin API with the fixed lifecycle canary admin (password login → JWT).
# Human password is STAGING_OWNER_ADMIN_PASSWORD_FILE only. Never writes lifecycle env;
# never restarts. Collision / identity mismatch fail closed.
action_human_bootstrap() {
  local note="human_bootstrap_admin"
  local human_ok="false"
  HUMAN_BOOTSTRAP_OUTCOME="unset"

  require_sha
  require_canary_secret_files "human-bootstrap"
  assert_canary_identifier_matches_owner "human-bootstrap"
  require_staging_owner_admin_password_file "human-bootstrap"
  [[ "$BOOTSTRAP_CONFIRMATION" == "CREATE_STAGING_HUMAN_ADMIN" ]] \
    || fail "action=human-bootstrap requires BOOTSTRAP_CONFIRMATION=CREATE_STAGING_HUMAN_ADMIN"
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=human-bootstrap"
  [[ "$EXPECTED_CURRENT_MODE" == "off" ]] \
    || fail "action=human-bootstrap requires expected_current_mode=off (got '${EXPECTED_CURRENT_MODE}'); refuse auto-selection"

  capture_live_snapshot
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=human-bootstrap"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=human-bootstrap refused: backend_health_ok must be true before account mutation"
  fi
  if [[ "$SNAP_MODE" != "off" ]]; then
    fail "action=human-bootstrap refused: live mode must be off (live='${SNAP_MODE}')"
  fi
  if [[ "$SNAP_MODE" != "$EXPECTED_CURRENT_MODE" ]]; then
    fail "strict expected-current-mode transition failed: live='${SNAP_MODE}' expected_current_mode='${EXPECTED_CURRENT_MODE}'"
  fi

  # Mint short-lived canary admin JWT for admin API (never ATTENDANCE_ADMIN_JWT).
  if ! mint_canary_admin_jwt_from_password_login "human-bootstrap"; then
    fail "action=human-bootstrap refused: canary password login / JWT mint failed (no human mutation performed)"
  fi
  [[ -n "${CANARY_ADMIN_JWT_FILE:-}" && -s "${CANARY_ADMIN_JWT_FILE}" ]] \
    || fail "action=human-bootstrap refused: admin JWT file missing after mint (no human mutation performed)"

  # No lifecycle env write path exists below — create/repair only the fixed human identity.
  if ! bootstrap_human_platform_admin; then
    fail "action=human-bootstrap refused: fixed human create/repair failed (note=${HUMAN_BOOTSTRAP_OUTCOME:-unset}); no env write performed"
  fi
  human_ok="true"

  # Re-prove stack posture after account mutation: mode still off, health true, SHA unchanged,
  # migrations zero, all three lifecycle flags OFF. No restart expected.
  capture_live_snapshot
  if [[ "$SNAP_MODE" != "off" ]]; then
    fail "action=human-bootstrap refused: post-human-bootstrap live mode must remain off (live='${SNAP_MODE}'); no lifecycle env write expected"
  fi
  if [[ "$SNAP_ALIAS" != "false" || "$SNAP_PENDING" != "false" || "$SNAP_DEPROV" != "false" ]]; then
    fail "action=human-bootstrap refused: post-human-bootstrap all lifecycle flags must remain OFF"
  fi
  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=human-bootstrap refused: post-human-bootstrap backend_health_ok must remain true"
  fi
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=human-bootstrap post-check"
  if [[ "${SNAP_BUILD_SHA:-}" != "$DEPLOY_SHA" ]]; then
    fail "action=human-bootstrap refused: post-human-bootstrap SHA '${SNAP_BUILD_SHA:-}' must match deploy_sha '${DEPLOY_SHA}'"
  fi
  assert_exact_sha

  note="human_bootstrap_admin_${HUMAN_BOOTSTRAP_OUTCOME}"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "" "" "false" "$note"
  {
    echo "action=human-bootstrap"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=false"
    echo "human_bootstrap_outcome=${HUMAN_BOOTSTRAP_OUTCOME}"
    echo "human_bootstrap_ok=${human_ok}"
    echo "lifecycle_env_write=false"
    echo "backend_recreate=false"
    echo "post_human_bootstrap_mode_off=true"
    echo "post_human_bootstrap_flags_off=true"
    echo "post_human_bootstrap_health_ok=true"
    echo "post_human_bootstrap_migrations_zero=true"
    echo "post_human_bootstrap_sha_match=true"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=human-bootstrap OK outcome=${HUMAN_BOOTSTRAP_OUTCOME} (no lifecycle env write; mode/health/SHA/migrations reasserted)"
}

# Transient secret-backed pending ADMIT canary (phase: admit-only by default).
# Does NOT auto-activate via temp_password. DingTalk OAuth negative/positive
# checkpoints are manual NOT_EXECUTED (never claimed true by a wrong-password probe).
# Optional phase: BOOTSTRAP_CONFIRMATION=PENDING_SSO_ACTIVATE runs SSO activate only
# (no lifecycle env write); browser OAuth still NOT_EXECUTED.
# Success for admit phase requires/proves flags OFF. No auto-selection.
action_pending() {
  local pre_login_ok="false"
  local admin_jwt_minted="false"
  local pending_on_applied="false"
  local admit_ok="false"
  local pending_state_ok="false"
  local rolled_back_to_off="false"
  local sso_activate_ok="false"
  local phase="admit"
  local note="pending_admit_canary"
  # Honest checkpoints — never true unless real evidence exists.
  local oauth_negative_checkpoint="NOT_EXECUTED"
  local oauth_positive_checkpoint="NOT_EXECUTED"
  local password_login_denied_checkpoint="NOT_EXECUTED"
  local activate_executed="false"

  require_sha
  require_canary_secret_files "pending"
  assert_canary_identifier_matches_owner "pending"
  require_canary_directory_account_id_file "pending"
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=pending"
  [[ "$EXPECTED_CURRENT_MODE" == "off" ]] \
    || fail "action=pending requires expected_current_mode=off (got '${EXPECTED_CURRENT_MODE}'); refuse auto-selection"

  if [[ -n "${BOOTSTRAP_CONFIRMATION:-}" && "$BOOTSTRAP_CONFIRMATION" != "$PENDING_SSO_ACTIVATE_CONFIRMATION" && "$BOOTSTRAP_CONFIRMATION" != "PENDING_ADMIT" ]]; then
    fail "action=pending: bootstrap_confirmation must be empty|PENDING_ADMIT|PENDING_SSO_ACTIVATE (got confirmation set; values never log secrets)"
  fi
  if [[ "${BOOTSTRAP_CONFIRMATION:-}" == "$PENDING_SSO_ACTIVATE_CONFIRMATION" ]]; then
    phase="sso_activate"
  fi

  capture_live_snapshot
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=pending"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=pending refused: backend_health_ok must be true before mutation"
  fi
  if [[ "$SNAP_MODE" != "off" ]]; then
    fail "action=pending refused: live mode must be off (live='${SNAP_MODE}')"
  fi

  if mint_canary_admin_jwt_from_password_login "pending_pre"; then
    pre_login_ok="true"
    admin_jwt_minted="true"
  else
    fail "action=pending refused: canary password login / JWT mint failed (no mutation performed)"
  fi
  [[ -n "${CANARY_ADMIN_JWT_FILE:-}" && -s "${CANARY_ADMIN_JWT_FILE}" ]] \
    || fail "action=pending refused: admin JWT file missing after mint"

  if [[ "$phase" == "sso_activate" ]]; then
    # --- SSO activate phase: no lifecycle env write; browser OAuth remains NOT_EXECUTED ---
    if ! load_canary_directory_subject "pending_sso_pre"; then
      fail "action=pending sso_activate refused: subject load failed (note=${SUBJECT_NOTE:-unset}); no auto-selection"
    fi
    if [[ "$SUBJECT_LINK_STATUS" != "linked" || "$SUBJECT_HAS_LOCAL_USER" != "true" \
      || "$SUBJECT_LOCAL_USERNAME_OK" != "true" || "$SUBJECT_LOCAL_NAME_OK" != "true" ]]; then
      fail "action=pending sso_activate refused: subject must be owned linked pending user; no auto-selection"
    fi
    if ! assert_subject_user_access_state "pending_activation" "false" "sso_pre"; then
      fail "action=pending sso_activate refused: user must be pending_activation (note=${ACCESS_NOTE:-unset})"
    fi
    if ! run_pending_sso_activate; then
      fail "action=pending sso_activate refused: ${ACTIVATE_NOTE:-unset}"
    fi
    sso_activate_ok="true"
    activate_executed="true"
    if ! assert_subject_user_access_state "activated" "true" "sso_post"; then
      fail "action=pending sso_activate refused: post-activate access state failed (note=${ACCESS_NOTE:-unset})"
    fi
    # Browser DingTalk OAuth login is human-only; never claim true here.
    oauth_negative_checkpoint="NOT_EXECUTED"
    oauth_positive_checkpoint="NOT_EXECUTED"
    password_login_denied_checkpoint="NOT_EXECUTED"
    capture_live_snapshot
    if [[ "$SNAP_MODE" != "off" || "$SNAP_ALIAS" != "false" || "$SNAP_PENDING" != "false" || "$SNAP_DEPROV" != "false" ]]; then
      fail "action=pending sso_activate refused: lifecycle flags must remain OFF (no env write expected)"
    fi
    note="pending_sso_activate_flags_off_oauth_not_executed"
    write_status_artifact \
      "${SNAP_BUILD_SHA:-unknown}" \
      "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
      "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
      "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
      "pending" "true" "false" "$note"
    {
      echo "action=pending"
      echo "phase=sso_activate"
      echo "mode=${SNAP_MODE}"
      echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
      echo "transition_applied=false"
      echo "lifecycle_env_write=false"
      echo "pre_login_ok=${pre_login_ok}"
      echo "admin_jwt_minted=${admin_jwt_minted}"
      echo "subject_owned=true"
      echo "subject_auto_selected=false"
      echo "sso_activate_ok=${sso_activate_ok}"
      echo "activate_executed=${activate_executed}"
      echo "oauth_negative_checkpoint=${oauth_negative_checkpoint}"
      echo "oauth_positive_checkpoint=${oauth_positive_checkpoint}"
      echo "password_login_denied_checkpoint=${password_login_denied_checkpoint}"
      echo "password_login_denied_ok=false"
      echo "note=${note}"
    } > "${OUTPUT_DIR}/summary.txt"
    log "action=pending SSO activate OK (flags OFF; browser OAuth NOT_EXECUTED)"
    return 0
  fi

  # --- Admit phase: temporary pending-only flag, real admit, authoritative pending state ---
  pin_live_backend_image_for_transition
  if ! load_canary_directory_subject "pending_pre"; then
    fail "action=pending refused: explicit subject load failed (note=${SUBJECT_NOTE:-unset}); no env write; no auto-selection"
  fi
  if [[ "$SUBJECT_ACTIVE" != "true" ]]; then
    fail "action=pending refused: subject directory account must be active before admit (note=subject_inactive)"
  fi
  if [[ "$SUBJECT_LINK_STATUS" == "linked" ]]; then
    if [[ "$SUBJECT_HAS_LOCAL_USER" != "true" || "$SUBJECT_LOCAL_USERNAME_OK" != "true" || "$SUBJECT_LOCAL_NAME_OK" != "true" ]]; then
      fail "action=pending refused: linked subject is not the owned canary employee (collision_not_owned); no auto-selection"
    fi
  elif [[ "$SUBJECT_LINK_STATUS" != "unmatched" && "$SUBJECT_LINK_STATUS" != "pending" ]]; then
    fail "action=pending refused: subject link_status='${SUBJECT_LINK_STATUS}' is not admit-eligible"
  fi

  establish_alias_off_rollback_baseline
  arm_alias_exit_rollback_guard
  write_lifecycle_override "false" "true" "false"
  pending_on_applied="true"

  if ! recreate_backend_only; then
    fail_transition_restore "backend_health_not_true_after_restart"
  fi
  if [[ "$(resolve_deployed_sha)" != "$DEPLOY_SHA" ]]; then
    fail_transition_restore "post_restart_sha_mismatch"
  fi
  if ! assert_exact_mode_pending; then
    fail_transition_restore "post_restart_mode_not_pending"
  fi

  if ! load_canary_directory_subject "pending_on"; then
    fail_transition_restore "subject_reload_failed_${SUBJECT_NOTE:-unset}"
  fi

  if [[ "$SUBJECT_LINK_STATUS" == "linked" && "$SUBJECT_HAS_LOCAL_USER" == "true" ]]; then
    if ! assert_subject_user_access_state "pending_activation" "false" "pre_existing_pending"; then
      if [[ "$ACCESS_ACTIVATION" == "activated" && "$ACCESS_IS_ACTIVE" == "true" ]]; then
        fail_transition_restore "subject_already_activated_use_sso_or_deprovision"
      fi
      fail_transition_restore "pre_existing_pending_state_failed_${ACCESS_NOTE:-unset}"
    fi
    admit_ok="true"
    ADMIT_NOTE="pre_existing_owned_pending"
    ADMIT_ACTIVATION_STATUS="pending_activation"
  else
    if ! run_pending_admit; then
      fail_transition_restore "admit_failed_${ADMIT_NOTE:-unset}"
    fi
    admit_ok="true"
  fi

  # Authoritative pending state via admin access API — not a wrong-password login probe.
  if ! assert_subject_user_access_state "pending_activation" "false" "post_admit"; then
    fail_transition_restore "pending_state_assert_failed_${ACCESS_NOTE:-unset}"
  fi
  pending_state_ok="true"
  # Pending users have unusable passwords; OAuth blocked/allowed is human-only.
  password_login_denied_checkpoint="NOT_EXECUTED"
  oauth_negative_checkpoint="NOT_EXECUTED"
  oauth_positive_checkpoint="NOT_EXECUTED"
  activate_executed="false"

  log "pending admit proven; restoring explicit OFF rollback baseline (success requires/proves OFF; canary must not leave pending enabled)"
  restore_lifecycle_override
  if ! recreate_backend_only; then
    fail "action=pending: admit proven but rollback recreate failed — runtime OFF cannot be proven (explicit OFF baseline restored on disk; operator must inspect staging)"
  fi
  if [[ "$(resolve_deployed_sha)" != "$DEPLOY_SHA" ]]; then
    fail "action=pending: rollback SHA mismatch after restore — runtime OFF not fully proven (operator must inspect staging)"
  fi
  if ! assert_exact_mode_off; then
    fail "action=pending: rollback did not prove exact mode=off (operator must inspect staging)"
  fi
  if [[ "$(fetch_backend_health_ok)" != "true" ]]; then
    fail "action=pending: rollback backend health not true — runtime OFF not fully proven (operator must inspect staging)"
  fi
  rolled_back_to_off="true"
  disarm_alias_exit_rollback_guard
  cleanup_prev_backup

  capture_live_snapshot
  note="pending_admit_proved_off_oauth_not_executed"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "pending" "true" "true" "$note"
  {
    echo "action=pending"
    echo "phase=admit"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=true"
    echo "from_mode=off"
    echo "to_mode=off"
    echo "pending_on_applied=${pending_on_applied}"
    echo "pre_login_ok=${pre_login_ok}"
    echo "admin_jwt_minted=${admin_jwt_minted}"
    echo "subject_owned=true"
    echo "subject_auto_selected=false"
    echo "admit_ok=${admit_ok}"
    echo "admit_note=${ADMIT_NOTE:-unset}"
    echo "pending_state_ok=${pending_state_ok}"
    echo "activate_executed=${activate_executed}"
    echo "oauth_negative_checkpoint=${oauth_negative_checkpoint}"
    echo "oauth_positive_checkpoint=${oauth_positive_checkpoint}"
    echo "password_login_denied_checkpoint=${password_login_denied_checkpoint}"
    echo "password_login_denied_ok=false"
    echo "rolled_back_to_off=${rolled_back_to_off}"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=pending admit OK (transient pending ON proven; admit verified; flags OFF; OAuth/activate NOT_EXECUTED)"
}

# Deprovision apply phase
# (confirmation=DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED):
#   temporary deprovision-only flag → real sync → exact run.id ledger bind → access denial
#   → flags OFF. Does NOT restore access. Not an end-to-end rollback canary.
# Deprovision restore phase (confirmation=DINGTALK_SOURCE_REACTIVATED_CONFIRMED):
#   flags stay OFF → sync after external source re-enable → rehire restore exact event
#   → prove event/effects resolved + access restored.
# Deprovision empty_fetch_abort recovery
# (confirmation=DINGTALK_EMPTY_FETCH_ABORT_SOURCE_RE_ADDED_CONFIRMED):
#   staging-only, flags stay OFF forever. Recovers a journal stranded at
#   phase=run_bound after completed empty_directory_fetch abort with zero ledger.
#   Clears journal only after proving directory account reactivated + access graph
#   unchanged. Never writes lifecycle env flags.
# Deprovision sync_failure_before_deprovision recovery
# (confirmation=DINGTALK_SYNC_FAILURE_BEFORE_DEPROVISION_SOURCE_RE_ADDED_CONFIRMED):
#   staging-only, flags stay OFF forever. Recovers a journal stranded at
#   phase=run_bound (journal deprovision_applied=false, zero ledger) after terminal
#   failed sync whose error class is the exact observed constraint
#   idx_directory_accounts_provider_corp_external_key. Run API proves failed + class;
#   zero ledger + intact graph prove no mutation. Clears journal only after those
#   proofs + exact run identity recheck. Never writes lifecycle env; never claims
#   end-to-end restore.
action_deprovision() {
  local phase="apply"
  if [[ "${BOOTSTRAP_CONFIRMATION:-}" == "$DEPROVISION_RESTORE_CONFIRMATION" ]]; then
    phase="restore"
  elif [[ "${BOOTSTRAP_CONFIRMATION:-}" == "$DEPROVISION_EMPTY_FETCH_ABORT_RECOVERY_CONFIRMATION" ]]; then
    phase="empty_fetch_abort_recovery"
  elif [[ "${BOOTSTRAP_CONFIRMATION:-}" == "$DEPROVISION_SYNC_FAILURE_BEFORE_DEPROVISION_RECOVERY_CONFIRMATION" ]]; then
    phase="sync_failure_before_deprovision_recovery"
  elif [[ "${BOOTSTRAP_CONFIRMATION:-}" == "$DEPROVISION_SOURCE_CONFIRMATION" ]]; then
    phase="apply"
  else
    fail "action=deprovision requires bootstrap_confirmation=${DEPROVISION_SOURCE_CONFIRMATION}|${DEPROVISION_RESTORE_CONFIRMATION}|${DEPROVISION_EMPTY_FETCH_ABORT_RECOVERY_CONFIRMATION}|${DEPROVISION_SYNC_FAILURE_BEFORE_DEPROVISION_RECOVERY_CONFIRMATION}"
  fi

  if [[ "$phase" == "restore" ]]; then
    action_deprovision_restore
    return $?
  fi
  if [[ "$phase" == "empty_fetch_abort_recovery" ]]; then
    action_deprovision_empty_fetch_abort_recovery
    return $?
  fi
  if [[ "$phase" == "sync_failure_before_deprovision_recovery" ]]; then
    action_deprovision_sync_failure_before_deprovision_recovery
    return $?
  fi
  action_deprovision_apply
}

action_deprovision_apply() {
  local pre_login_ok="false"
  local admin_jwt_minted="false"
  local deprovision_on_applied="false"
  local source_inactive_after_sync="false"
  local sync_ok="false"
  local ledger_ok="false"
  local access_denied_ok="false"
  local login_denied_ok="false"
  local login_denied_checkpoint="NOT_EXECUTED"
  local subject_password_pre_ok="false"
  local rolled_back_flags_off="false"
  local note="deprovision_apply_phase"
  SUBJECT_PASSWORD_PROVEN_OK="false"

  require_sha
  require_canary_secret_files "deprovision"
  assert_canary_identifier_matches_owner "deprovision"
  require_canary_directory_account_id_file "deprovision"
  require_canary_sentinel_directory_account_id_file
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=deprovision"
  [[ "$EXPECTED_CURRENT_MODE" == "off" ]] \
    || fail "action=deprovision requires expected_current_mode=off (got '${EXPECTED_CURRENT_MODE}'); refuse auto-selection"

  capture_live_snapshot
  assert_exact_sha
  pin_live_backend_image_for_transition
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=deprovision"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=deprovision apply refused: backend_health_ok must be true before any env write"
  fi
  if [[ "$SNAP_MODE" != "off" ]]; then
    fail "action=deprovision apply refused: live mode must be off (live='${SNAP_MODE}')"
  fi

  if mint_canary_admin_jwt_from_password_login "deprovision_apply_pre"; then
    pre_login_ok="true"
    admin_jwt_minted="true"
  else
    fail "action=deprovision apply refused: canary login / JWT mint failed (no env write)"
  fi

  if ! load_canary_directory_subject "deprovision_apply_pre"; then
    fail "action=deprovision apply refused: subject load failed (note=${SUBJECT_NOTE:-unset}); no auto-selection"
  fi
  if [[ "$SUBJECT_LINK_STATUS" != "linked" || "$SUBJECT_HAS_LOCAL_USER" != "true" ]]; then
    fail "action=deprovision apply refused: subject must be linked owned local user; no auto-selection"
  fi
  if [[ "$SUBJECT_LOCAL_USERNAME_OK" != "true" || "$SUBJECT_LOCAL_NAME_OK" != "true" ]]; then
    fail "action=deprovision apply refused: linked local user is not owned canary employee; no auto-selection"
  fi
  if [[ "$SUBJECT_ACTIVE" != "true" ]]; then
    fail "action=deprovision apply refused: account already inactive — need this-run active→inactive transition"
  fi
  if ! assert_subject_user_access_state "activated" "true" "deprovision_apply_pre"; then
    fail "action=deprovision apply refused: local user must be activated+active (note=${ACCESS_NOTE:-unset})"
  fi

  # Optional proven-password checkpoint (never wrong-password).
  local pass_file=""
  if pass_file="$(resolve_subject_password_file 2>/dev/null)"; then
    if prove_subject_password_login "deprovision_pre" "$pass_file"; then
      subject_password_pre_ok="true"
      SUBJECT_PASSWORD_PROVEN_OK="true"
    else
      fail "action=deprovision apply refused: subject password file present but pre-deprovision login failed (note=${SUBJECT_LOGIN_NOTE:-unset})"
    fi
  else
    login_denied_checkpoint="NOT_EXECUTED"
    login_denied_ok="false"
  fi

  # Collateral radius: whole-integration sync/preview BEFORE any deprovision env write.
  # Require sole would-deactivate (linked) sample matches explicit subject externalUserId.
  if ! run_deprovision_sync_preview_subject_gate; then
    fail "action=deprovision apply refused: sync/preview subject gate failed (note=${PREVIEW_NOTE:-unset}); no env write performed; no auto-selection"
  fi

  # Read-only planner precondition (exact triple effects) before env write.
  if ! prove_dedicated_subject_deprovision_precondition; then
    fail "action=deprovision apply refused: dedicated subject precondition failed (note=${PRECOND_NOTE:-unset}); no env write"
  fi

  # Fail closed: unrecovered prior journal must not be overwritten.
  refuse_existing_deprovision_apply_state
  # Create recovery journal phase=prepared BEFORE env write (ids only).
  journal_init_prepared

  establish_alias_off_rollback_baseline
  arm_alias_exit_rollback_guard
  write_lifecycle_override "false" "false" "true"
  deprovision_on_applied="true"

  if ! recreate_backend_only; then
    journal_clear_if_phase_prepared
    fail_transition_restore "backend_health_not_true_after_restart"
  fi
  if [[ "$(resolve_deployed_sha)" != "$DEPLOY_SHA" ]]; then
    journal_clear_if_phase_prepared
    fail_transition_restore "post_restart_sha_mismatch"
  fi
  if ! assert_exact_mode_deprovision; then
    journal_clear_if_phase_prepared
    fail_transition_restore "post_restart_mode_not_deprovision"
  fi

  # Sync may return radius anomaly; run id is still written first for recovery.
  local sync_rc=0
  run_directory_sync_for_subject "deprovision_apply" "true" || sync_rc=$?
  if [[ "$SYNC_RUN_ID_PRESENT" != "true" || -z "${CANARY_SUBJECT_SYNC_RUN_ID_FILE:-}" || ! -s "${CANARY_SUBJECT_SYNC_RUN_ID_FILE}" ]]; then
    # The reserved UUID was persisted before this POST. A transport failure may mean
    # the server accepted and applied the run while the 202 was lost; deleting the
    # prepared journal here would strand access changes with no recovery anchor.
    fail_deprovision_apply_keep_journal "sync_start_or_response_failed_${SYNC_NOTE:-unset}"
  fi
  # ALWAYS upgrade journal to run_bound once the exact run reaches terminal
  # (counts may be abnormal and ledger is not yet claimed).
  if ! journal_upgrade_run_bound; then
    fail_deprovision_apply_keep_journal "journal_upgrade_run_bound_failed"
  fi

  # Bind ledger (exact run → unique event + exact triple effects) BEFORE radius/graph gates.
  if ! verify_deprovision_ledger_for_subject; then
    # Keep phase=run_bound; restore flags; recovery_required (exact run persisted).
    fail_deprovision_apply_keep_journal "ledger_verify_failed_${LEDGER_NOTE:-unset}"
  fi
  [[ "$LEDGER_RUN_MATCH" == "true" ]] \
    || fail_deprovision_apply_keep_journal "ledger_run_id_not_matched"
  # Atomic upgrade run_bound → ledger_bound (compat alias persist_deprovision_apply_state).
  if ! persist_deprovision_apply_state; then
    fail_deprovision_apply_keep_journal "journal_upgrade_ledger_bound_failed"
  fi
  ledger_ok="true"

  # NOW post-sync TOCTOU radius: success requires exact 1/1/1. Failure keeps ledger_bound journal.
  if [[ "$sync_rc" -ne 0 || "$SYNC_OK" != "true" ]]; then
    fail_deprovision_apply_keep_journal "sync_radius_or_apply_anomaly_${SYNC_NOTE:-unset}"
  fi
  [[ "$SYNC_DEPROVISION_APPLIED" == "true" ]] \
    || fail_deprovision_apply_keep_journal "deprovision_not_applied_on_sync"
  [[ "${SYNC_DEPROVISION_CANDIDATES}" == "1" ]] \
    || fail_deprovision_apply_keep_journal "sync_candidate_radius_not_one"
  [[ "${SYNC_ACCOUNTS_DEACTIVATED}" == "1" ]] \
    || fail_deprovision_apply_keep_journal "sync_accounts_deactivated_not_one"
  [[ "${SYNC_USERS_DEACTIVATED}" == "1" ]] \
    || fail_deprovision_apply_keep_journal "sync_users_deactivated_not_one"
  sync_ok="true"

  if ! load_canary_directory_subject "deprovision_post_sync"; then
    fail_deprovision_apply_keep_journal "subject_reload_failed_${SUBJECT_NOTE:-unset}"
  fi
  if [[ "$SUBJECT_ACTIVE" != "false" ]]; then
    fail_deprovision_apply_keep_journal "source_still_active_after_sync_external_gate"
  fi
  source_inactive_after_sync="true"

  if ! assert_subject_user_access_state "activated" "false" "post_deprovision"; then
    fail_deprovision_apply_keep_journal "access_not_denied_${ACCESS_NOTE:-unset}"
  fi
  access_denied_ok="true"

  if ! prove_access_graph_state "deprovisioned" "post_deprovision"; then
    fail_deprovision_apply_keep_journal "access_graph_not_deprovisioned_${GRAPH_NOTE:-unset}"
  fi

  if [[ "$SUBJECT_PASSWORD_PROVEN_OK" == "true" ]]; then
    if ! prove_subject_login_denied_with_proven_password "deprovision_apply"; then
      fail_deprovision_apply_keep_journal "login_not_denied_after_deprovision_${LOGIN_DENIED_NOTE:-unset}"
    fi
    login_denied_ok="true"
    login_denied_checkpoint="proven_password_denied"
  else
    login_denied_ok="false"
    login_denied_checkpoint="NOT_EXECUTED"
  fi

  # Flags OFF only — access remains disabled. Journal phase=ledger_bound retained for restore.
  # NOTE: preview+sync radius checks are NOT an atomic scope lock; real deprovision
  # may only target a dedicated isolated enterprise/integration — never a shared
  # integration that holds real employees.
  log "deprovision apply proven; restoring explicit OFF flags (access remains disabled; journal ledger_bound retained; restore phase required)"
  restore_lifecycle_override
  if ! recreate_backend_only; then
    fail "action=deprovision apply: rollback recreate failed — runtime OFF cannot be proven (operator must inspect staging; journal retained)"
  fi
  if [[ "$(resolve_deployed_sha)" != "$DEPLOY_SHA" ]]; then
    fail "action=deprovision apply: rollback SHA mismatch (operator must inspect staging; journal retained)"
  fi
  if ! assert_exact_mode_off; then
    fail "action=deprovision apply: rollback did not prove exact mode=off (journal retained)"
  fi
  if [[ "$(fetch_backend_health_ok)" != "true" ]]; then
    fail "action=deprovision apply: rollback backend health not true (journal retained)"
  fi
  rolled_back_flags_off="true"
  disarm_alias_exit_rollback_guard
  cleanup_prev_backup

  capture_live_snapshot
  note="deprovision_apply_flags_off_access_disabled_restore_phase_required"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "deprovision" "true" "true" "$note"
  {
    echo "action=deprovision"
    echo "phase=apply"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=true"
    echo "from_mode=off"
    echo "to_mode=off"
    echo "deprovision_on_applied=${deprovision_on_applied}"
    echo "pre_login_ok=${pre_login_ok}"
    echo "admin_jwt_minted=${admin_jwt_minted}"
    echo "subject_owned=true"
    echo "subject_auto_selected=false"
    echo "sentinel_owned=true"
    echo "sentinel_auto_selected=false"
    echo "integration_exact_target_and_sentinel=true"
    echo "source_disable_confirmation=true"
    echo "preview_subject_gate_ok=true"
    echo "preview_would_deactivate=${PREVIEW_WOULD_DEACTIVATE:-0}"
    echo "preview_would_deactivate_linked=${PREVIEW_WOULD_DEACTIVATE_LINKED:-0}"
    echo "preview_subject_match=true"
    echo "sync_radius_not_atomic_lock=true"
    echo "source_inactive_after_sync=${source_inactive_after_sync}"
    echo "sync_ok=${sync_ok}"
    echo "sync_deprovision_applied=${SYNC_DEPROVISION_APPLIED:-false}"
    echo "sync_run_id_present=${SYNC_RUN_ID_PRESENT:-false}"
    echo "sync_users_deactivated=${SYNC_USERS_DEACTIVATED:-0}"
    echo "sync_accounts_deactivated=${SYNC_ACCOUNTS_DEACTIVATED:-0}"
    echo "sync_deprovision_candidates=${SYNC_DEPROVISION_CANDIDATES:-0}"
    echo "ledger_ok=${ledger_ok}"
    echo "ledger_run_match=${LEDGER_RUN_MATCH:-false}"
    echo "ledger_event_count=${LEDGER_EVENT_COUNT:-0}"
    echo "ledger_effect_count=${LEDGER_EFFECT_COUNT:-0}"
    echo "ledger_generation_present=${LEDGER_GENERATION_PRESENT:-false}"
    echo "journal_phase=ledger_bound"
    echo "journal_retained=true"
    echo "exact_run_persisted=true"
    echo "recovery_required=false"
    echo "apply_completed=true"
    echo "apply_state_persisted=true"
    echo "access_denied_ok=${access_denied_ok}"
    echo "access_graph_user_active=${GRAPH_USER_ACTIVE:-unknown}"
    echo "access_graph_membership_active_count=${GRAPH_MEMBERSHIP_ACTIVE_COUNT:-0}"
    echo "access_graph_grant_state=${GRAPH_GRANT_STATE:-unknown}"
    echo "subject_password_pre_ok=${subject_password_pre_ok}"
    echo "login_denied_checkpoint=${login_denied_checkpoint}"
    echo "login_denied_ok=${login_denied_ok}"
    echo "rolled_back_flags_off=${rolled_back_flags_off}"
    echo "access_restored=false"
    echo "canary_access_rollback_complete=false"
    echo "server_side_access_graph_restore_proven=false"
    echo "end_to_end_restore_claimed=false"
    echo "restore_phase_required=true"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=deprovision apply OK (flags OFF; access disabled; journal ledger_bound retained; restore phase required)"
}

action_deprovision_restore() {
  local pre_login_ok="false"
  local admin_jwt_minted="false"
  local source_active_after_sync="false"
  local sync_ok="false"
  local restore_ok="false"
  local resolved_ok="false"
  local access_restored_ok="false"
  local graph_restored_ok="false"
  local login_restored_ok="false"
  local login_restored_checkpoint="NOT_EXECUTED"
  local oauth_negative_checkpoint="NOT_EXECUTED"
  local oauth_positive_checkpoint="NOT_EXECUTED"
  local flags_remain_off="false"
  local note="deprovision_restore_phase"
  SUBJECT_PASSWORD_PROVEN_OK="false"

  require_sha
  require_canary_secret_files "deprovision"
  assert_canary_identifier_matches_owner "deprovision"
  require_canary_directory_account_id_file "deprovision"
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=deprovision restore"
  [[ "$EXPECTED_CURRENT_MODE" == "off" ]] \
    || fail "action=deprovision restore requires expected_current_mode=off"

  capture_live_snapshot
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=deprovision restore"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=deprovision restore refused: backend_health_ok must be true"
  fi
  if [[ "$SNAP_MODE" != "off" || "$SNAP_ALIAS" != "false" || "$SNAP_PENDING" != "false" || "$SNAP_DEPROV" != "false" ]]; then
    fail "action=deprovision restore refused: all lifecycle flags must be OFF before restore (live mode='${SNAP_MODE}')"
  fi

  if mint_canary_admin_jwt_from_password_login "deprovision_restore_pre"; then
    pre_login_ok="true"
    admin_jwt_minted="true"
  else
    fail "action=deprovision restore refused: canary login / JWT mint failed"
  fi

  if ! load_canary_directory_subject "deprovision_restore_pre"; then
    fail "action=deprovision restore refused: subject load failed (note=${SUBJECT_NOTE:-unset}); no auto-selection"
  fi
  if [[ "$SUBJECT_LOCAL_USERNAME_OK" != "true" || "$SUBJECT_LOCAL_NAME_OK" != "true" ]]; then
    fail "action=deprovision restore refused: subject is not owned canary employee; no auto-selection"
  fi

  # Exact apply correlation from host persistent state — NEVER discover events by scan.
  if ! load_deprovision_apply_state; then
    fail "action=deprovision restore refused: apply state load failed (missing/drift); no event auto-discovery"
  fi

  # External source reactivated → sync so local account becomes active again (no deprovision flag).
  if ! run_directory_sync_for_subject "deprovision_restore" "false"; then
    fail "action=deprovision restore refused: sync failed (note=${SYNC_NOTE:-unset})"
  fi
  sync_ok="true"

  if ! load_canary_directory_subject "deprovision_restore_post_sync"; then
    fail "action=deprovision restore refused: subject reload failed (note=${SUBJECT_NOTE:-unset})"
  fi
  if [[ "$SUBJECT_ACTIVE" != "true" ]]; then
    fail "action=deprovision restore refused: subject source not active after sync (external re-enable gate)"
  fi
  source_active_after_sync="true"

  if ! run_or_resume_deprovision_rehire_restore; then
    fail "action=deprovision restore refused: rehire restore/resume failed (note=${RESTORE_NOTE:-unset})"
  fi
  restore_ok="true"
  resolved_ok="true"

  if ! assert_subject_user_access_state "activated" "true" "post_restore"; then
    fail "action=deprovision restore refused: profile access not restored (note=${ACCESS_NOTE:-unset})"
  fi
  access_restored_ok="true"

  if ! prove_access_graph_state "restored" "post_restore"; then
    fail "action=deprovision restore refused: access graph not restored (note=${GRAPH_NOTE:-unset})"
  fi
  graph_restored_ok="true"

  local pass_file=""
  if pass_file="$(resolve_subject_password_file 2>/dev/null)"; then
    if prove_subject_password_login "deprovision_restore" "$pass_file"; then
      login_restored_ok="true"
      login_restored_checkpoint="proven_password_ok"
    else
      fail "action=deprovision restore refused: subject password login failed after restore (note=${SUBJECT_LOGIN_NOTE:-unset})"
    fi
  else
    login_restored_ok="false"
    login_restored_checkpoint="NOT_EXECUTED"
  fi
  # Human DingTalk OAuth positive/negative remain manual.
  oauth_negative_checkpoint="NOT_EXECUTED"
  oauth_positive_checkpoint="NOT_EXECUTED"

  capture_live_snapshot
  if [[ "$SNAP_MODE" != "off" || "$SNAP_ALIAS" != "false" || "$SNAP_PENDING" != "false" || "$SNAP_DEPROV" != "false" ]]; then
    fail "action=deprovision restore refused: lifecycle flags must remain OFF after restore"
  fi
  flags_remain_off="true"
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=deprovision restore post-check"
  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=deprovision restore refused: backend_health_ok must remain true"
  fi

  clear_deprovision_apply_state

  note="deprovision_restore_server_side_access_graph_proven_flags_off"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "deprovision" "true" "false" "$note"
  {
    echo "action=deprovision"
    echo "phase=restore"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=false"
    echo "lifecycle_env_write=false"
    echo "pre_login_ok=${pre_login_ok}"
    echo "admin_jwt_minted=${admin_jwt_minted}"
    echo "subject_owned=true"
    echo "subject_auto_selected=false"
    echo "source_reactivate_confirmation=true"
    echo "source_active_after_sync=${source_active_after_sync}"
    echo "sync_ok=${sync_ok}"
    echo "restore_ok=${restore_ok}"
    echo "restore_resumed_fully_resolved=${RESTORE_RESUMED_FULLY_RESOLVED:-false}"
    echo "restore_effect_count=${RESTORE_EFFECT_COUNT:-0}"
    echo "event_fully_resolved_ok=${resolved_ok}"
    echo "access_restored_ok=${access_restored_ok}"
    echo "access_graph_restored_ok=${graph_restored_ok}"
    echo "access_graph_user_active=${GRAPH_USER_ACTIVE:-unknown}"
    echo "access_graph_membership_active_count=${GRAPH_MEMBERSHIP_ACTIVE_COUNT:-0}"
    echo "access_graph_grant_state=${GRAPH_GRANT_STATE:-unknown}"
    echo "login_restored_checkpoint=${login_restored_checkpoint}"
    echo "login_restored_ok=${login_restored_ok}"
    echo "oauth_negative_checkpoint=${oauth_negative_checkpoint}"
    echo "oauth_positive_checkpoint=${oauth_positive_checkpoint}"
    echo "flags_remain_off=${flags_remain_off}"
    echo "server_side_access_graph_restore_proven=true"
    echo "canary_access_rollback_complete=true"
    # OAuth human checkpoints not executed → must not claim full end-to-end.
    echo "end_to_end_restore_claimed=false"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=deprovision restore OK (server-side access graph proven; OAuth NOT_EXECUTED; end_to_end_restore_claimed=false; flags OFF)"
}

# Staging-only recovery for journal phase=run_bound after empty_directory_fetch safe abort.
# Never writes lifecycle env flags. Never calls rehire restore. Clears journal only after
# final post-sync proofs (directory account active + access graph unchanged + flags OFF).
action_deprovision_empty_fetch_abort_recovery() {
  local pre_login_ok="false"
  local admin_jwt_minted="false"
  local journal_ok="false"
  local exact_run_ok="false"
  local zero_ledger_ok="false"
  local zero_ledger_final_ok="false"
  local pre_graph_ok="false"
  local source_active_after_sync="false"
  local sync_ok="false"
  local post_graph_ok="false"
  local graph_unchanged_ok="false"
  local flags_remain_off="false"
  local journal_cleared="false"
  local pre_graph_snapshot=""
  local post_graph_snapshot=""
  local note="empty_fetch_abort_recovery_phase"

  require_sha
  require_canary_secret_files "deprovision"
  assert_canary_identifier_matches_owner "deprovision"
  require_canary_directory_account_id_file "deprovision"
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=deprovision empty_fetch_abort_recovery"
  [[ "$EXPECTED_CURRENT_MODE" == "off" ]] \
    || fail "action=deprovision empty_fetch_abort_recovery requires expected_current_mode=off"

  capture_live_snapshot
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=deprovision empty_fetch_abort_recovery"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: backend_health_ok must be true (journal left intact)"
  fi
  # Any lifecycle flag ON refuses recovery and leaves the journal intact.
  if [[ "$SNAP_MODE" != "off" || "$SNAP_ALIAS" != "false" || "$SNAP_PENDING" != "false" || "$SNAP_DEPROV" != "false" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: all lifecycle flags must be OFF (live mode='${SNAP_MODE}'); journal left intact"
  fi

  if mint_canary_admin_jwt_from_password_login "empty_fetch_abort_recovery_pre"; then
    pre_login_ok="true"
    admin_jwt_minted="true"
  else
    fail "action=deprovision empty_fetch_abort_recovery refused: canary login / JWT mint failed (journal left intact)"
  fi

  if ! load_canary_directory_subject "empty_fetch_abort_recovery_pre"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: subject load failed (note=${SUBJECT_NOTE:-unset}); journal left intact; no auto-selection"
  fi
  if [[ "$SUBJECT_LOCAL_USERNAME_OK" != "true" || "$SUBJECT_LOCAL_NAME_OK" != "true" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: subject is not owned canary employee; journal left intact; no auto-selection"
  fi
  if [[ "$SUBJECT_HAS_LOCAL_USER" != "true" || -z "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" || ! -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: owned local user required; journal left intact"
  fi

  # Exact journal bind: phase=run_bound, deprovision_applied=false, no ledger fields.
  if ! load_run_bound_empty_fetch_abort_journal; then
    fail "action=deprovision empty_fetch_abort_recovery refused: journal not eligible run_bound safe abort (note=${SAFE_ABORT_JOURNAL_NOTE:-unset}); journal left intact"
  fi
  journal_ok="true"

  # Exact terminal run: completed + applied=false + abortedReason=empty_directory_fetch.
  if ! prove_exact_run_empty_fetch_safe_abort; then
    fail "action=deprovision empty_fetch_abort_recovery refused: exact run not empty_directory_fetch safe abort (note=${SAFE_ABORT_RUN_NOTE:-unset}); journal left intact"
  fi
  exact_run_ok="true"

  # Zero user/membership/grant ledger for that exact run only (exact SQL; no list/limit).
  if ! prove_zero_deprovision_ledger_for_exact_run "empty_fetch_abort_recovery_pre"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: ledger not empty for exact run (note=${SAFE_ABORT_LEDGER_NOTE:-unset}); journal left intact"
  fi
  zero_ledger_ok="true"

  # Pre-recovery access graph must still be activated + active membership + enabled grant.
  if ! assert_subject_user_access_state "activated" "true" "empty_fetch_abort_recovery_pre"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: pre-recovery access not activated+active (note=${ACCESS_NOTE:-unset}); journal left intact"
  fi
  if ! prove_intact_access_graph_no_ledger "empty_fetch_abort_recovery_pre"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: pre-recovery access graph not intact (note=${INTACT_GRAPH_NOTE:-unset}); journal left intact"
  fi
  pre_graph_ok="true"
  pre_graph_snapshot="${INTACT_GRAPH_SNAPSHOT}"

  # External source re-add is operator-confirmed via bootstrap_confirmation.
  # Flags stay OFF: sync under require_deprov_applied=false only.
  if ! run_directory_sync_for_subject "empty_fetch_abort_recovery" "false"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: flags-OFF sync failed (note=${SYNC_NOTE:-unset}); journal left intact"
  fi
  if [[ "$SYNC_DEPROVISION_APPLIED" != "false" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: flags-OFF sync did not prove deprovisionApplied=false; journal left intact"
  fi
  sync_ok="true"

  if ! load_canary_directory_subject "empty_fetch_abort_recovery_post_sync"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: subject reload failed (note=${SUBJECT_NOTE:-unset}); journal left intact"
  fi
  if [[ "$SUBJECT_ACTIVE" != "true" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: owned directory account not active after sync (external re-add gate); journal left intact"
  fi
  source_active_after_sync="true"

  if ! assert_subject_user_access_state "activated" "true" "empty_fetch_abort_recovery_post"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: post-sync access not activated+active (note=${ACCESS_NOTE:-unset}); journal left intact"
  fi
  if ! prove_intact_access_graph_no_ledger "empty_fetch_abort_recovery_post"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: post-sync access graph not intact (note=${INTACT_GRAPH_NOTE:-unset}); journal left intact"
  fi
  post_graph_ok="true"
  post_graph_snapshot="${INTACT_GRAPH_SNAPSHOT}"
  if [[ -z "$pre_graph_snapshot" || "$post_graph_snapshot" != "$pre_graph_snapshot" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: access graph drift after flags-OFF sync (pre!=post); journal left intact"
  fi
  graph_unchanged_ok="true"

  capture_live_snapshot
  if [[ "$SNAP_MODE" != "off" || "$SNAP_ALIAS" != "false" || "$SNAP_PENDING" != "false" || "$SNAP_DEPROV" != "false" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: lifecycle flags must remain OFF after recovery sync; journal left intact"
  fi
  flags_remain_off="true"
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=deprovision empty_fetch_abort_recovery post-check"
  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=deprovision empty_fetch_abort_recovery refused: backend_health_ok must remain true; journal left intact"
  fi

  # FINAL proof gate: re-prove exact no-ledger AFTER flags-OFF sync + graph/flag checks
  # and IMMEDIATELY before clear, so a concurrent/delayed exact event cannot appear
  # between the first zero-ledger proof and journal clear.
  # Load-bearing order — contract MUTATION removes this recheck / moves clear earlier and must turn red.
  if ! prove_zero_deprovision_ledger_for_exact_run "empty_fetch_abort_recovery_final_pre_clear"; then
    fail "action=deprovision empty_fetch_abort_recovery refused: final pre-clear zero-ledger recheck failed (note=${SAFE_ABORT_LEDGER_NOTE:-unset}); journal left intact"
  fi
  zero_ledger_final_ok="true"
  clear_deprovision_apply_state
  journal_cleared="true"

  note="empty_fetch_abort_recovery_directory_reactivated_access_graph_unchanged_journal_cleared"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "deprovision" "true" "false" "$note"
  {
    echo "action=deprovision"
    echo "phase=empty_fetch_abort_recovery"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=false"
    echo "lifecycle_env_write=false"
    echo "pre_login_ok=${pre_login_ok}"
    echo "admin_jwt_minted=${admin_jwt_minted}"
    echo "subject_owned=true"
    echo "subject_auto_selected=false"
    echo "source_re_add_confirmation=true"
    echo "journal_ok=${journal_ok}"
    echo "journal_phase_required=run_bound"
    echo "exact_run_ok=${exact_run_ok}"
    echo "aborted_reason_required=empty_directory_fetch"
    echo "deprovision_applied_required=false"
    echo "zero_ledger_ok=${zero_ledger_ok}"
    echo "zero_ledger_final_ok=${zero_ledger_final_ok}"
    echo "zero_ledger_event_count=${SAFE_ABORT_LEDGER_EVENT_COUNT:-0}"
    echo "zero_ledger_effect_count=${SAFE_ABORT_LEDGER_EFFECT_COUNT:-0}"
    echo "pre_graph_ok=${pre_graph_ok}"
    echo "sync_ok=${sync_ok}"
    echo "source_active_after_sync=${source_active_after_sync}"
    echo "post_graph_ok=${post_graph_ok}"
    echo "graph_unchanged_ok=${graph_unchanged_ok}"
    echo "access_graph_user_active=${INTACT_GRAPH_USER_ACTIVE:-unknown}"
    echo "access_graph_membership_active_count=${INTACT_GRAPH_MEMBERSHIP_ACTIVE_COUNT:-0}"
    echo "access_graph_grant_state=${INTACT_GRAPH_GRANT_STATE:-unknown}"
    echo "flags_remain_off=${flags_remain_off}"
    echo "journal_cleared=${journal_cleared}"
    echo "server_side_access_graph_mutation_proven=false"
    echo "access_graph_unchanged_proven=true"
    echo "safe_abort_source_recovery_complete=true"
    echo "canary_access_rollback_complete=false"
    echo "end_to_end_restore_claimed=false"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=deprovision empty_fetch_abort_recovery OK (flags OFF; directory reactivated; access graph unchanged; journal cleared; no lifecycle env write)"
}

# Staging-only recovery for journal phase=run_bound after terminal failed sync with
# journal deprovision_applied=false, zero ledger, and exact observed error class
# idx_directory_accounts_provider_corp_external_key. Never writes lifecycle env.
# Never calls rehire restore. Clears journal only after final post-sync proofs +
# final zero-ledger recheck + exact failed-run identity recheck.
action_deprovision_sync_failure_before_deprovision_recovery() {
  local pre_login_ok="false"
  local admin_jwt_minted="false"
  local journal_ok="false"
  local exact_run_ok="false"
  local exact_run_final_ok="false"
  local zero_ledger_ok="false"
  local zero_ledger_final_ok="false"
  local pre_graph_ok="false"
  local source_active_after_sync="false"
  local sync_ok="false"
  local post_graph_ok="false"
  local graph_unchanged_ok="false"
  local flags_remain_off="false"
  local journal_cleared="false"
  local pre_graph_snapshot=""
  local post_graph_snapshot=""
  local note="sync_failure_before_deprovision_recovery_phase"

  require_sha
  require_canary_secret_files "deprovision"
  assert_canary_identifier_matches_owner "deprovision"
  require_canary_directory_account_id_file "deprovision"
  [[ -n "$EXPECTED_CURRENT_MODE" ]] || fail "expected_current_mode is required for action=deprovision sync_failure_before_deprovision_recovery"
  [[ "$EXPECTED_CURRENT_MODE" == "off" ]] \
    || fail "action=deprovision sync_failure_before_deprovision_recovery requires expected_current_mode=off"

  capture_live_snapshot
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=deprovision sync_failure_before_deprovision_recovery"

  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: backend_health_ok must be true (journal left intact)"
  fi
  # Any lifecycle flag ON refuses recovery and leaves the journal intact.
  if [[ "$SNAP_MODE" != "off" || "$SNAP_ALIAS" != "false" || "$SNAP_PENDING" != "false" || "$SNAP_DEPROV" != "false" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: all lifecycle flags must be OFF (live mode='${SNAP_MODE}'); journal left intact"
  fi

  if mint_canary_admin_jwt_from_password_login "sync_failure_before_deprovision_recovery_pre"; then
    pre_login_ok="true"
    admin_jwt_minted="true"
  else
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: canary login / JWT mint failed (journal left intact)"
  fi

  if ! load_canary_directory_subject "sync_failure_before_deprovision_recovery_pre"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: subject load failed (note=${SUBJECT_NOTE:-unset}); journal left intact; no auto-selection"
  fi
  if [[ "$SUBJECT_LOCAL_USERNAME_OK" != "true" || "$SUBJECT_LOCAL_NAME_OK" != "true" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: subject is not owned canary employee; journal left intact; no auto-selection"
  fi
  if [[ "$SUBJECT_HAS_LOCAL_USER" != "true" || -z "${CANARY_SUBJECT_LOCAL_USER_ID_FILE:-}" || ! -s "${CANARY_SUBJECT_LOCAL_USER_ID_FILE}" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: owned local user required; journal left intact"
  fi

  # Journal-bound proof: phase=run_bound, deprovision_applied=false, no ledger fields.
  # Immutable pin → CANARY_FAILED_SYNC_RUN_ID_FILE (survives recovery sync run id).
  # deprovision_applied=false is proven here — not by absent run stats.
  if ! load_run_bound_sync_failure_before_deprovision_journal; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: journal not eligible run_bound failed-before-deprovision (note=${FAILED_SYNC_JOURNAL_NOTE:-unset}); journal left intact"
  fi
  journal_ok="true"

  # Run API proof: status=failed + exact observed error class only (values-free).
  # Does not alone prove deprovision_applied=false (that is journal-bound above).
  if ! prove_exact_run_sync_failure_before_deprovision; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: exact run not failed with observed error class (note=${FAILED_SYNC_RUN_NOTE:-unset}); journal left intact"
  fi
  exact_run_ok="true"

  # No-mutation proof: zero user/membership/grant ledger for that exact failed run
  # only (exact SQL; no list/limit). Complements journal deprovision_applied=false.
  if ! prove_zero_deprovision_ledger_for_exact_run "sync_failure_before_deprovision_recovery_pre"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: ledger not empty for exact run (note=${SAFE_ABORT_LEDGER_NOTE:-unset}); journal left intact"
  fi
  zero_ledger_ok="true"

  # No-mutation proof: access graph still activated + active membership + enabled grant.
  if ! assert_subject_user_access_state "activated" "true" "sync_failure_before_deprovision_recovery_pre"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: pre-recovery access not activated+active (note=${ACCESS_NOTE:-unset}); journal left intact"
  fi
  if ! prove_intact_access_graph_no_ledger "sync_failure_before_deprovision_recovery_pre"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: pre-recovery access graph not intact (note=${INTACT_GRAPH_NOTE:-unset}); journal left intact"
  fi
  pre_graph_ok="true"
  pre_graph_snapshot="${INTACT_GRAPH_SNAPSHOT}"

  # External source re-add is operator-confirmed via bootstrap_confirmation.
  # Flags stay OFF: sync under require_deprov_applied=false only.
  if ! run_directory_sync_for_subject "sync_failure_before_deprovision_recovery" "false"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: flags-OFF sync failed (note=${SYNC_NOTE:-unset}); journal left intact"
  fi
  if [[ "$SYNC_DEPROVISION_APPLIED" != "false" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: flags-OFF sync did not prove deprovisionApplied=false; journal left intact"
  fi
  sync_ok="true"

  if ! load_canary_directory_subject "sync_failure_before_deprovision_recovery_post_sync"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: subject reload failed (note=${SUBJECT_NOTE:-unset}); journal left intact"
  fi
  if [[ "$SUBJECT_ACTIVE" != "true" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: owned directory account not active after sync (external re-add gate); journal left intact"
  fi
  source_active_after_sync="true"

  if ! assert_subject_user_access_state "activated" "true" "sync_failure_before_deprovision_recovery_post"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: post-sync access not activated+active (note=${ACCESS_NOTE:-unset}); journal left intact"
  fi
  if ! prove_intact_access_graph_no_ledger "sync_failure_before_deprovision_recovery_post"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: post-sync access graph not intact (note=${INTACT_GRAPH_NOTE:-unset}); journal left intact"
  fi
  post_graph_ok="true"
  post_graph_snapshot="${INTACT_GRAPH_SNAPSHOT}"
  if [[ -z "$pre_graph_snapshot" || "$post_graph_snapshot" != "$pre_graph_snapshot" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: access graph drift after flags-OFF sync (pre!=post); journal left intact"
  fi
  graph_unchanged_ok="true"

  capture_live_snapshot
  if [[ "$SNAP_MODE" != "off" || "$SNAP_ALIAS" != "false" || "$SNAP_PENDING" != "false" || "$SNAP_DEPROV" != "false" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: lifecycle flags must remain OFF after recovery sync; journal left intact"
  fi
  flags_remain_off="true"
  assert_exact_sha
  require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=deprovision sync_failure_before_deprovision_recovery post-check"
  if [[ "$SNAP_HEALTH_OK" != "true" ]]; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: backend_health_ok must remain true; journal left intact"
  fi

  # FINAL proof gate: re-prove exact no-ledger AND exact failed-run identity AFTER
  # flags-OFF sync + graph/flag checks and IMMEDIATELY before clear.
  # Load-bearing order — contract MUTATION removes this recheck / moves clear earlier and must turn red.
  # Immutable pin is CANARY_FAILED_SYNC_RUN_ID_FILE, never the recovery subject.sync-run-id pin.
  if ! prove_zero_deprovision_ledger_for_exact_run "sync_failure_before_deprovision_recovery_final_pre_clear"; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: final pre-clear zero-ledger recheck failed (note=${SAFE_ABORT_LEDGER_NOTE:-unset}); journal left intact"
  fi
  zero_ledger_final_ok="true"
  if ! prove_exact_run_sync_failure_before_deprovision; then
    fail "action=deprovision sync_failure_before_deprovision_recovery refused: final pre-clear exact failed-run identity recheck failed (note=${FAILED_SYNC_RUN_NOTE:-unset}); journal left intact"
  fi
  exact_run_final_ok="true"
  clear_deprovision_apply_state
  journal_cleared="true"

  note="sync_failure_before_deprovision_recovery_source_restored_access_graph_unchanged_journal_cleared"
  write_status_artifact \
    "${SNAP_BUILD_SHA:-unknown}" \
    "$SNAP_ALIAS" "$SNAP_PENDING" "$SNAP_DEPROV" "$SNAP_MODE" \
    "$SNAP_ALIAS_READY" "$SNAP_CAN_ENABLE_ALIAS" \
    "$SNAP_MIGRATIONS_ZERO" "$SNAP_HEALTH_OK" \
    "deprovision" "true" "false" "$note"
  {
    echo "action=deprovision"
    echo "phase=sync_failure_before_deprovision_recovery"
    echo "mode=${SNAP_MODE}"
    echo "build_sha=${SNAP_BUILD_SHA:-unknown}"
    echo "transition_applied=false"
    echo "lifecycle_env_write=false"
    echo "pre_login_ok=${pre_login_ok}"
    echo "admin_jwt_minted=${admin_jwt_minted}"
    echo "subject_owned=true"
    echo "subject_auto_selected=false"
    echo "source_re_add_confirmation=true"
    echo "journal_ok=${journal_ok}"
    echo "journal_phase_required=run_bound"
    echo "journal_deprovision_applied_required=false"
    echo "exact_run_ok=${exact_run_ok}"
    echo "exact_run_final_ok=${exact_run_final_ok}"
    echo "run_status_required=failed"
    echo "error_class_required=duplicate_provider_corp_external_key"
    echo "error_constraint_required=idx_directory_accounts_provider_corp_external_key"
    echo "error_class_observed=${FAILED_SYNC_ERROR_CLASS:-unknown}"
    echo "zero_ledger_ok=${zero_ledger_ok}"
    echo "zero_ledger_final_ok=${zero_ledger_final_ok}"
    echo "zero_ledger_event_count=${SAFE_ABORT_LEDGER_EVENT_COUNT:-0}"
    echo "zero_ledger_effect_count=${SAFE_ABORT_LEDGER_EFFECT_COUNT:-0}"
    echo "pre_graph_ok=${pre_graph_ok}"
    echo "sync_ok=${sync_ok}"
    echo "source_active_after_sync=${source_active_after_sync}"
    echo "post_graph_ok=${post_graph_ok}"
    echo "graph_unchanged_ok=${graph_unchanged_ok}"
    echo "access_graph_user_active=${INTACT_GRAPH_USER_ACTIVE:-unknown}"
    echo "access_graph_membership_active_count=${INTACT_GRAPH_MEMBERSHIP_ACTIVE_COUNT:-0}"
    echo "access_graph_grant_state=${INTACT_GRAPH_GRANT_STATE:-unknown}"
    echo "flags_remain_off=${flags_remain_off}"
    echo "journal_cleared=${journal_cleared}"
    echo "server_side_access_graph_mutation_proven=false"
    echo "access_graph_unchanged_proven=true"
    echo "no_mutation_proven_by_zero_ledger_and_access_graph=true"
    echo "sync_failure_before_deprovision_source_recovery_complete=true"
    echo "canary_access_rollback_complete=false"
    echo "end_to_end_restore_claimed=false"
    echo "note=${note}"
  } > "${OUTPUT_DIR}/summary.txt"
  log "action=deprovision sync_failure_before_deprovision_recovery OK (flags OFF; source restored; access graph unchanged; journal cleared; no lifecycle env write; end_to_end_restore_claimed=false)"
}

# --- main ------------------------------------------------------------------------------

main() {
  mkdir -p "$OUTPUT_DIR"
  assert_staging_only

  case "$ACTION" in
    status) action_status ;;
    preflight) action_preflight ;;
    off) action_off ;;
    bootstrap) action_bootstrap ;;
    human-bootstrap) action_human_bootstrap ;;
    alias) action_alias ;;
    pending) action_pending ;;
    deprovision) action_deprovision ;;
    *) fail "invalid ACTION='${ACTION}' (status|preflight|off|bootstrap|human-bootstrap|alias|pending|deprovision)" ;;
  esac
}

if [[ "${LIFECYCLE_CANARY_SOURCE_ONLY:-false}" != "true" ]]; then
  main
fi
