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
#
# NOT EXECUTABLE (fail-closed preflight-only; transition_applied always false):
#   pending / deprovision
#     Env flips alone are NOT a canary. There is no secret-backed real verifier
#     for admit→activate or sync→deprovision. Presence tokens must not pretend
#     to drive those paths.
#
# HARD SAFETY RAILS:
#   * Staging compose + metasheet-staging-* containers only; no prod fallback.
#   * migrations_pending_zero must be exactly "true" for preflight_ok and for
#     action=off / action=alias / action=bootstrap (unknown is a fail, never
#     treated as success).
#   * action=off|alias: recreate backend only; prove postgres/redis IDs unchanged;
#     require backend health true after restart; prove exact mode; restore
#     previous override and re-recreate on any failure after the write.
#   * action=bootstrap: no lifecycle env write; no backend recreate.
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

ACTION="${ACTION:?ACTION is required (status|preflight|off|bootstrap|alias|pending|deprovision)}"
TARGET_MODE="${TARGET_MODE:-}"
EXPECTED_CURRENT_MODE="${EXPECTED_CURRENT_MODE:-}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
STAGING_DEPLOY_PATH="${STAGING_DEPLOY_PATH:-metasheet2-dingtalk-staging}"
DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
OUTPUT_DIR="${OUTPUT_DIR:?OUTPUT_DIR is required}"
RUN_STAMP="${RUN_STAMP:?RUN_STAMP is required (workflow run id marker)}"

# Secret-backed canary inputs: FILE PATHS only (values never exported).
# Workflow materializes chmod-600 identifier/password into the per-run remote dir.
# Alias mints CANARY_ADMIN_JWT_FILE after successful pre-login (never from
# secrets.ATTENDANCE_ADMIN_JWT). Bootstrap does not consume a JWT file.
CANARY_ADMIN_JWT_FILE="${CANARY_ADMIN_JWT_FILE:-}"
CANARY_LOGIN_IDENTIFIER_FILE="${CANARY_LOGIN_IDENTIFIER_FILE:-}"
CANARY_LOGIN_PASSWORD_FILE="${CANARY_LOGIN_PASSWORD_FILE:-}"

# Fixed dedicated lifecycle canary admin ownership markers (values-free constants).
# Create/repair ONLY this (email, id) pair. Any email/id collision that does not
# match BOTH markers fails closed — never mutates an arbitrary existing admin.
CANARY_OWNER_EMAIL="lifecycle-canary@staging.invalid"
CANARY_OWNER_USER_ID="6c1fe000-ca0a-4000-8000-1ec0c1e00001"

# Intentionally ignored: not a real verifier path. Kept empty so accidental
# exports cannot be mistaken for canary completion evidence.
# CANARY_SUBJECT_ID / CANARY_INTEGRATION_ID / OWNER_CONFIRM are NOT used.

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
STAGING_COMPOSE_FILE="$LEGACY_STAGING_COMPOSE_FILE"
if [[ -f "$PERSISTENT_STAGING_COMPOSE_FILE" ]]; then
  STAGING_COMPOSE_FILE="$PERSISTENT_STAGING_COMPOSE_FILE"
fi

LIFECYCLE_PERSIST_DIR="${HOME}/.metasheet2/lifecycle-canary"
LIFECYCLE_OVERRIDE_FILE="${LIFECYCLE_PERSIST_DIR}/docker-compose.lifecycle-canary.override.yml"
# Previous-override backup used during action=off|alias for restore-on-failure
# (alias success path also restores OFF to prove rollback; failure restores first).
LIFECYCLE_PREV_BACKUP=""
LIFECYCLE_PREV_STATE="absent" # absent | present
PINNED_IMAGE_OWNER=""
PINNED_IMAGE_TAG=""
ALIAS_ROLLBACK_ARMED="false"

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
  if [[ -n "$PINNED_IMAGE_OWNER" && -n "$PINNED_IMAGE_TAG" ]]; then
    image_owner="$PINNED_IMAGE_OWNER"
    image_tag="$PINNED_IMAGE_TAG"
  else
    if ! image_pin="$(resolve_live_backend_image_pin)"; then
      echo "[lifecycle-canary][error] running backend image is not an exact ghcr.io owner/metasheet2-backend:<40-sha> pin; refusing compose" >&2
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
    fail "running backend image is not an exact ghcr.io owner/metasheet2-backend:<40-sha> pin; refusing transition"
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
  # Load-bearing for every transition (action=off|alias) and for preflight_ok.
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
# Usage: admin_api_request METHOD PATH
# stdout on transport success: HTTP_CODE\nBODY
admin_api_request() {
  local method="$1" path="$2"
  python3 - "$CANARY_ADMIN_JWT_FILE" "$STAGING_API_BASE_URL" "$method" "$path" <<'PY'
import pathlib
import sys
import urllib.error
import urllib.request

jwt_path, base, method, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    token = pathlib.Path(jwt_path).read_text(encoding="utf-8").strip()
except Exception:
    sys.stderr.write("admin jwt file read failed\n")
    raise SystemExit(2)
if not token:
    sys.stderr.write("admin jwt file empty\n")
    raise SystemExit(2)
url = base.rstrip("/") + path
data = b"{}" if method.upper() == "POST" else None
req = urllib.request.Request(
    url,
    data=data,
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    },
    method=method.upper(),
)
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
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
    echo "# action=alias may write AUTH_LOGIN_USE_ALIASES=true transiently; success"
    echo "# requires/proves OFF; failure restores the compose-validated explicit OFF"
    echo "# rollback baseline (never a stale on-disk prior file). Runtime OFF cannot be"
    echo "# proven if rollback recreate fails. pending/deprovision ON remain NOT EXECUTABLE."
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
  if [[ "$ACTION" == "alias" ]]; then
    # This explicit failure path already attempted runtime restore. Avoid a
    # second EXIT-handler recreate after its backup is cleaned below.
    disarm_alias_exit_rollback_guard
  fi
  cleanup_prev_backup
  fail "action=${ACTION} failed: ${reason} (previous override restored)"
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
  # pending/deprovision remain NOT EXECUTABLE ON even when stack looks ready.
  if [[ "$target" == "pending" || "$target" == "deprovision" ]]; then
    log "preflight assessed target=${target} note=${PREFLIGHT_NOTE} (ON transition NOT EXECUTABLE)"
  else
    log "preflight OK target=${target} note=${PREFLIGHT_NOTE}"
  fi
}

# Fail-closed: pending/deprovision never apply. Preflight assessment only.
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
  fail "action=${target} is NOT EXECUTABLE: no secret-backed real verifier for canary proof (admit-activate / sync-deprovision). Env flip alone is refused. Use status|preflight|off|bootstrap|alias only. transition_applied=false"
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

# --- main ------------------------------------------------------------------------------

main() {
  mkdir -p "$OUTPUT_DIR"
  assert_staging_only

  case "$ACTION" in
    status) action_status ;;
    preflight) action_preflight ;;
    off) action_off ;;
    bootstrap) action_bootstrap ;;
    alias) action_alias ;;
    pending) action_not_executable_on pending ;;
    deprovision) action_not_executable_on deprovision ;;
    *) fail "invalid ACTION='${ACTION}' (status|preflight|off|bootstrap|alias|pending|deprovision)" ;;
  esac
}

if [[ "${LIFECYCLE_CANARY_SOURCE_ONLY:-false}" != "true" ]]; then
  main
fi
