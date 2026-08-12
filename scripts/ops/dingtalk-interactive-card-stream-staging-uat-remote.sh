#!/usr/bin/env bash
# dingtalk-interactive-card-stream-staging-uat-remote.sh
#
# Remote (deploy-host) half of
# .github/workflows/dingtalk-interactive-card-stream-staging-uat.yml.
# Executes ONE action per invocation against the STAGING stack only.
#
# EXECUTABLE:
#   status  — read-only snapshot (booleans / counts / reason classes / SHA only)
#   prepare — transport Stream credentials via chmod-600 files, derive exactly
#             one active DingTalk integration (nonempty corp_id + >=2 active
#             linked local users), atomically write the four credential/id env
#             keys into docker/app.staging.env while FORCING Stream flag false,
#             validate, and restart backend only if needed
#   on      — recheck prerequisites + LOG_LEVEL info/debug, flip ONLY Stream
#             flag true, restart backend, prove worker_started only (values-free).
#             EXIT/INT/TERM fail-safe is ARMED before Stream ON write; any
#             post-write non-success forces disk flag false + backend recreate
#             and reports rollback result. Disarm only after all on checks +
#             artifact succeed. Signal traps must exit (not return/continue).
#             Does NOT prove SDK connected: interactive-card-stream.ts status
#             'active' / log "worker started" means the worker is running with
#             SDK-owned connection lifecycle; connect() resolves and retries
#             forever. stream_connected stays unknown until real callback UAT
#             (human U12/U13).
#   off     — fail-safe: flip Stream flag false, restart backend, prove worker
#             stopped / not registered
#
# HARD SAFETY RAILS:
#   * Staging compose + metasheet-staging-* containers only; no prod fallback.
#   * Lifecycle flags (alias/pending/deprovision) are NEVER written by this lane.
#   * Stream stays OFF except explicit action=on.
#   * Secrets never appear in shell argv, exported env values, logs, or artifacts.
#   * prepare/on/off require exact deployed 40-char lowercase SHA.
#   * Artifacts: booleans / counts / reason enums / SHA only — no raw IDs/PII.
#   * stream_connected is always unknown in this lane (no connect claim from logs).
#   * U12/U13 remain human-gated (real callback / flag-off UAT); not automated.
#   * Invoked as `bash -o pipefail -c '<script>'`.
set -euo pipefail

log() { echo "[stream-uat] $*"; }
fail() { echo "[stream-uat][error] $*" >&2; exit 1; }

ACTION="${ACTION:?ACTION is required (status|prepare|on|off)}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
STAGING_DEPLOY_PATH="${STAGING_DEPLOY_PATH:-metasheet2-dingtalk-staging}"
DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
OUTPUT_DIR="${OUTPUT_DIR:?OUTPUT_DIR is required}"
RUN_STAMP="${RUN_STAMP:?RUN_STAMP is required (workflow run id marker)}"

# Secret-backed prepare inputs: FILE PATHS only (values never exported/logged).
STREAM_CLIENT_ID_FILE="${STREAM_CLIENT_ID_FILE:-}"
STREAM_CLIENT_SECRET_FILE="${STREAM_CLIENT_SECRET_FILE:-}"
STREAM_TEMPLATE_ID_FILE="${STREAM_TEMPLATE_ID_FILE:-}"

BACKEND_CONTAINER="metasheet-staging-backend"
WEB_CONTAINER="metasheet-staging-web"
POSTGRES_CONTAINER="metasheet-staging-postgres"
REDIS_CONTAINER="metasheet-staging-redis"
STAGING_WEB_HEALTH_URL="http://127.0.0.1:8082/api/health"
STAGING_BACKEND_HEALTH_URL="http://127.0.0.1:18900/health"

FLAG_STREAM="DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED"
KEY_CLIENT_ID="DINGTALK_INTERACTIVE_CARD_CLIENT_ID"
KEY_CLIENT_SECRET="DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET"
KEY_TEMPLATE_ID="DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID"
KEY_STREAM_INTEGRATION_ID="DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID"

FLAG_ALIAS="AUTH_LOGIN_USE_ALIASES"
FLAG_PENDING="DIRECTORY_PENDING_ACTIVATION_ENABLED"
FLAG_DEPROVISION="DIRECTORY_DEPROVISION_ENABLED"

# Ephemeral temp paths cleaned by trap (chmod 600 where secrets live).
EPHEMERAL_PATHS=()
INTEGRATION_ID_FILE=""
PINNED_IMAGE_OWNER=""
PINNED_IMAGE_TAG=""

# action=on fail-safe: when armed, any non-success path (fail/EXIT/INT/TERM) forces
# Stream flag false on disk + backend recreate. Disarm only after full on success.
STREAM_ON_ROLLBACK_ARMED="false"
STREAM_ON_SUCCESS="false"
STREAM_ON_ROLLBACK_DONE="false"
STREAM_ON_ROLLBACK_RESULT=""
TRAP_IN_PROGRESS="false"

cleanup_ephemeral() {
  local p
  set +e
  for p in "${EPHEMERAL_PATHS[@]:-}"; do
    [[ -n "$p" ]] || continue
    if [[ -d "$p" ]]; then
      rm -rf "$p"
    else
      rm -f "$p"
    fi
  done
  set -e
}

stream_on_fail_safe_rollback() {
  # Force disk Stream flag false + recreate backend. Values-free result only.
  # Idempotent; never prints secrets. Safe under set +e (trap context).
  if [[ "$STREAM_ON_ROLLBACK_ARMED" != "true" ]]; then
    return 0
  fi
  if [[ "$STREAM_ON_SUCCESS" == "true" ]]; then
    return 0
  fi
  if [[ "$STREAM_ON_ROLLBACK_DONE" == "true" ]]; then
    return 0
  fi
  STREAM_ON_ROLLBACK_DONE="true"
  set +e
  log "action=on fail-safe rollback: forcing Stream flag false + backend recreate"
  local flag_rc=1 recreate_rc=1
  # Subshell so helper fail()/exit cannot re-enter this trap mid-rollback.
  if ( atomic_set_stream_flag "false" ); then
    flag_rc=0
  fi
  if ( recreate_backend_only ); then
    recreate_rc=0
  fi
  if [[ "$flag_rc" == "0" && "$recreate_rc" == "0" ]]; then
    STREAM_ON_ROLLBACK_RESULT="ok;flag_off_rc=0;recreate_rc=0"
  else
    STREAM_ON_ROLLBACK_RESULT="partial_or_failed;flag_off_rc=${flag_rc};recreate_rc=${recreate_rc}"
  fi
  if [[ -n "${OUTPUT_DIR:-}" && -d "${OUTPUT_DIR:-}" ]]; then
    {
      echo "on_fail_safe_rollback=${STREAM_ON_ROLLBACK_RESULT}"
      echo "stream_enabled_target_after_rollback=false"
    } >> "${OUTPUT_DIR}/summary.txt" 2>/dev/null
  fi
  log "action=on fail-safe rollback result: ${STREAM_ON_ROLLBACK_RESULT}"
  set -e
  return 0
}

arm_stream_on_fail_safe_rollback() {
  # Must be called BEFORE atomic_set_stream_flag true.
  STREAM_ON_ROLLBACK_ARMED="true"
  STREAM_ON_SUCCESS="false"
  STREAM_ON_ROLLBACK_DONE="false"
  STREAM_ON_ROLLBACK_RESULT=""
  log "action=on fail-safe rollback ARMED (EXIT/INT/TERM will force Stream OFF)"
}

disarm_stream_on_fail_safe_rollback() {
  # Only after all on post-write checks + artifacts succeed.
  STREAM_ON_SUCCESS="true"
  STREAM_ON_ROLLBACK_ARMED="false"
  log "action=on fail-safe rollback DISARMED (on checks + artifact succeeded)"
}

# Unified trap: optional on-rollback, then ephemeral cleanup.
# Do NOT register cleanup_ephemeral alone on signal traps — a return-only signal
# handler lets the main script continue after a fatal signal. Every trapped fatal
# signal MUST exit after rollback.
#
# CRITICAL: capture $? as the FIRST statement. Any prior command (including
# `local reason=...`) succeeds and clobbers $? to 0, which would make EXIT re-exit
# skip and turn a failed action_on into a green exit after trap body.
on_script_trap() {
  local saved_rc=$? # FIRST statement only — never put any command above this line
  local reason="${1:-EXIT}"

  if [[ "$TRAP_IN_PROGRESS" == "true" ]]; then
    # Nested re-entry (e.g. exit from within trap): signals still force-exit.
    case "$reason" in
      HUP) exit 129 ;;
      INT) exit 130 ;;
      PIPE) exit 141 ;;
      TERM) exit 143 ;;
      *) return 0 ;;
    esac
  fi
  TRAP_IN_PROGRESS="true"

  set +e
  # Armed action=on window: force Stream OFF + recreate before process ends.
  stream_on_fail_safe_rollback
  cleanup_ephemeral
  set -e

  case "$reason" in
    HUP)
      exit 129
      ;;
    INT)
      # Signal: must exit so action_on cannot continue after partial post-write work.
      exit 130
      ;;
    TERM)
      exit 143
      ;;
    PIPE)
      exit 141
      ;;
    EXIT)
      # Re-exit non-zero so fail() status is preserved after trap body.
      # Without this, trap-last-command success can make the whole script exit 0.
      if [[ "$saved_rc" -ne 0 ]]; then
        exit "$saved_rc"
      fi
      ;;
    *)
      exit 1
      ;;
  esac
}

# Separate trap lines so fatal signals cannot share a return-only cleanup handler.
trap 'on_script_trap EXIT' EXIT
trap 'on_script_trap HUP' HUP
trap 'on_script_trap INT' INT
trap 'on_script_trap TERM' TERM
# A dropped non-PTY SSH channel can kill a writer with SIGPIPE. Silence the broken
# channel before rollback so logging cannot recursively raise PIPE.
trap 'exec >/dev/null 2>&1; on_script_trap PIPE' PIPE

register_ephemeral() {
  local p="$1"
  EPHEMERAL_PATHS+=("$p")
}

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

STAGING_ENV_FILE="${STAGING_DIR}/docker/app.staging.env"
STREAM_UAT_PERSIST_DIR="${HOME}/.metasheet2/stream-uat"
mkdir -p "$STREAM_UAT_PERSIST_DIR"
chmod 700 "$STREAM_UAT_PERSIST_DIR" 2>/dev/null || true

is_truthy() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$v" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

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
  local image_pin image_owner image_tag
  local -a files=(-f "$STAGING_COMPOSE_FILE")
  if [[ -f "$ATTENDANCE_OVERRIDE_FILE" ]]; then
    files+=(-f "$ATTENDANCE_OVERRIDE_FILE")
  fi
  if [[ -f "$LIFECYCLE_OVERRIDE_FILE" ]]; then
    files+=(-f "$LIFECYCLE_OVERRIDE_FILE")
  fi
  if [[ -n "$PINNED_IMAGE_OWNER" && -n "$PINNED_IMAGE_TAG" ]]; then
    image_owner="$PINNED_IMAGE_OWNER"
    image_tag="$PINNED_IMAGE_TAG"
  else
    if ! image_pin="$(resolve_live_backend_image_pin)"; then
      echo "[stream-uat][error] running backend image is not an exact ghcr.io owner/metasheet2-backend:<40-sha> pin; refusing compose" >&2
      return 1
    fi
    read -r image_owner image_tag <<< "$image_pin"
  fi
  (cd "$STAGING_DIR" && IMAGE_OWNER="$image_owner" IMAGE_TAG="$image_tag" APP_ENV_FILE="$STAGING_ENV_FILE" \
    docker compose --project-directory "$STAGING_DIR" --env-file "$STAGING_ENV_FILE" "${files[@]}" "$@")
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

  # Exact proof requires both sources and agreement.
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

require_exact_deployed_sha() {
  local live context="${1:-transition}"
  require_sha
  live="$(resolve_deployed_sha)"
  [[ "$live" =~ ^[0-9a-f]{40}$ ]] \
    || fail "${context}: could not resolve one exact deployed staging SHA (image tag / health commit)"
  [[ "$live" == "$DEPLOY_SHA" ]] \
    || fail "${context}: deployed SHA '${live}' does not match required exact deploy_sha '${DEPLOY_SHA}'"
  log "exact deployed SHA OK: ${live}"
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

env_key_present_in_container() {
  local key="$1" raw
  if ! raw="$(docker exec "$BACKEND_CONTAINER" sh -c '
key="$1"
if printenv "$key" >/dev/null 2>&1; then
  v=$(printenv "$key")
  if [ -n "$(printf "%s" "$v" | tr -d "[:space:]")" ]; then
    printf "yes"
  else
    printf "empty"
  fi
else
  printf "missing"
fi
' sh "$key" 2>/dev/null)"; then
    printf 'unknown'
    return 0
  fi
  if [[ "$raw" == "yes" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

env_key_digest_in_container() {
  # sha256 of trimmed value, or MISSING/EMPTY — never prints the value.
  local key="$1" dig
  dig="$(docker exec "$BACKEND_CONTAINER" sh -c '
key="$1"
if ! printenv "$key" >/dev/null 2>&1; then
  printf "MISSING"
  exit 0
fi
v=$(printenv "$key")
trimmed=$(printf "%s" "$v" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")
if [ -z "$trimmed" ]; then
  printf "EMPTY"
  exit 0
fi
printf "%s" "$trimmed" | sha256sum | awk "{print \$1}"
' sh "$key" 2>/dev/null || true)"
  if [[ -z "$dig" ]]; then
    printf 'UNKNOWN'
  else
    printf '%s' "$dig"
  fi
}

file_digest() {
  local path="$1"
  [[ -f "$path" ]] || { printf 'MISSING'; return 0; }
  # shellcheck disable=SC2002
  local dig
  dig="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$path" | tr -d '\r' | sha256sum | awk '{print $1}')"
  if [[ -z "$dig" ]]; then
    printf 'EMPTY'
  else
    printf '%s' "$dig"
  fi
}

read_env_file_value_digest() {
  local key="$1" file="$2" py_script dig
  [[ -f "$file" ]] || { printf 'MISSING'; return 0; }
  py_script="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.env-digest.XXXXXX")"
  register_ephemeral "$py_script"
  chmod 600 "$py_script"
  cat >"$py_script" <<'PY'
import hashlib, sys
key, path = sys.argv[1], sys.argv[2]
value = None
with open(path, encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.rstrip("\n").rstrip("\r")
        if not line or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() == key:
            value = v.strip()
            if len(value) >= 2 and ((value[0] == value[-1] == '"') or (value[0] == value[-1] == "'")):
                value = value[1:-1]
if value is None:
    print("MISSING")
elif not value.strip():
    print("EMPTY")
else:
    print(hashlib.sha256(value.strip().encode("utf-8")).hexdigest())
PY
  dig="$(python3 "$py_script" "$key" "$file" 2>/dev/null || true)"
  rm -f "$py_script"
  if [[ -z "$dig" ]]; then
    printf 'UNKNOWN'
  else
    printf '%s' "$dig"
  fi
}

# --- LOG_LEVEL classification (values-free) ------------------------------------------
classify_log_level() {
  # Sets LOG_LEVEL_READY and LOG_LEVEL_REASON (info|debug|other|missing|unknown).
  local raw
  if ! raw="$(docker exec "$BACKEND_CONTAINER" sh -c 'printenv LOG_LEVEL 2>/dev/null || true' 2>/dev/null)"; then
    LOG_LEVEL_READY="unknown"
    LOG_LEVEL_REASON="unknown"
    return 0
  fi
  local normalized
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ -z "$normalized" ]]; then
    # core/logger.ts defaults to info when unset/empty.
    LOG_LEVEL_READY="true"
    LOG_LEVEL_REASON="missing"
    return 0
  fi
  case "$normalized" in
    info)
      LOG_LEVEL_READY="true"
      LOG_LEVEL_REASON="info"
      ;;
    debug)
      LOG_LEVEL_READY="true"
      LOG_LEVEL_REASON="debug"
      ;;
    *)
      LOG_LEVEL_READY="false"
      LOG_LEVEL_REASON="other"
      ;;
  esac
}

require_log_level_info_or_debug() {
  classify_log_level
  if [[ "$LOG_LEVEL_READY" == "true" ]]; then
    case "$LOG_LEVEL_REASON" in
      info|debug|missing)
        log "LOG_LEVEL ready (reason=${LOG_LEVEL_REASON})"
        return 0
        ;;
    esac
  fi
  fail "action=on requires LOG_LEVEL info/debug (got ready=${LOG_LEVEL_READY} reason=${LOG_LEVEL_REASON})"
}

# --- lifecycle flags (read only; never written) --------------------------------------
read_lifecycle_all_off() {
  local a p d
  a="$(read_flag_from_container "$FLAG_ALIAS")" || { printf 'unknown'; return 0; }
  p="$(read_flag_from_container "$FLAG_PENDING")" || { printf 'unknown'; return 0; }
  d="$(read_flag_from_container "$FLAG_DEPROVISION")" || { printf 'unknown'; return 0; }
  if [[ "$a" == "false" && "$p" == "false" && "$d" == "false" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

require_lifecycle_flags_off() {
  local context="${1:-transition}" all_off
  all_off="$(read_lifecycle_all_off)"
  [[ "$all_off" == "true" ]] \
    || fail "${context}: lifecycle flags must all be OFF (this lane never enables them); got lifecycle_flags_all_off=${all_off}"
  log "lifecycle flags all OFF OK"
}

# --- directory anchor derivation (values-free counts; id only via secret file) --------
run_directory_anchor_probe() {
  # stdout JSON: {active_corp_anchored_count, linked_users, ready, integration_id?}
  # integration_id is written ONLY when count==1 and linked>=2; callers must not log it.
  # Script is staged via chmod-600 temp file to avoid nested shell/node quoting hazards.
  local script_tmp out
  script_tmp="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.anchor-probe.XXXXXX")"
  register_ephemeral "$script_tmp"
  chmod 600 "$script_tmp"
  cat >"$script_tmp" <<'NODE'
const { Client } = require("pg");
(async () => {
  const unknown = {
    active_corp_anchored_count: "unknown",
    linked_users: "unknown",
    ready: "unknown",
    integration_id: "",
  };
  const emit = (o) => process.stdout.write(JSON.stringify(o));
  const url = process.env.DATABASE_URL;
  if (!url) { emit(unknown); return; }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  try {
    await c.connect();
    const placeholder = [
      "replace-me","changeme","change-me","placeholder","todo","xxx","your-corp-id","example"
    ];
    const r = await c.query(
      `SELECT i.id::text AS id,
              count(DISTINCT u.id)::int AS linked_users
         FROM directory_integrations i
         LEFT JOIN directory_accounts a
           ON a.integration_id = i.id
          AND a.provider = 'dingtalk'
          AND a.is_active = TRUE
         LEFT JOIN directory_account_links l
           ON l.directory_account_id = a.id
          AND l.link_status = 'linked'
          AND l.local_user_id IS NOT NULL
          AND length(trim(l.local_user_id::text)) > 0
         LEFT JOIN users u
           ON u.id = l.local_user_id
          AND u.is_active = TRUE
          AND COALESCE(u.activation_status, 'activated') = 'activated'
        WHERE i.provider = 'dingtalk'
          AND i.status = 'active'
          AND i.corp_id IS NOT NULL
          AND length(trim(i.corp_id)) > 0
          AND lower(trim(i.corp_id)) <> ALL($1::text[])
        GROUP BY i.id
        ORDER BY i.id`,
      [placeholder],
    );
    const rows = r.rows || [];
    if (rows.length === 0) {
      emit({ active_corp_anchored_count: 0, linked_users: 0, ready: "false", integration_id: "" });
      return;
    }
    if (rows.length !== 1) {
      emit({
        active_corp_anchored_count: rows.length,
        linked_users: "unknown",
        ready: "false",
        integration_id: "",
      });
      return;
    }
    const linked = Number(rows[0].linked_users) || 0;
    const ready = linked >= 2;
    emit({
      active_corp_anchored_count: 1,
      linked_users: linked,
      ready: ready ? "true" : "false",
      integration_id: ready ? String(rows[0].id || "") : "",
    });
  } catch {
    emit(unknown);
  } finally {
    try { await c.end(); } catch { /* ignore */ }
  }
})().catch(() => {
  process.stdout.write(JSON.stringify({
    active_corp_anchored_count: "unknown",
    linked_users: "unknown",
    ready: "unknown",
    integration_id: "",
  }));
});
NODE
  out="$(docker exec -i "$BACKEND_CONTAINER" node <"$script_tmp" 2>/dev/null || true)"
  rm -f "$script_tmp"
  if [[ -z "$out" ]]; then
    printf '%s' '{"active_corp_anchored_count":"unknown","linked_users":"unknown","ready":"unknown","integration_id":""}'
  else
    printf '%s' "$out"
  fi
}

parse_probe_field() {
  local json="$1" field="$2"
  printf '%s' "$json" | python3 -c "import json,sys
d=json.load(sys.stdin)
v=d.get(sys.argv[1], '')
print('' if v is None else v)
" "$field"
}

derive_exact_integration_id_file() {
  # Writes integration UUID to chmod-600 temp file when exactly one ready anchor exists.
  # Never prints the id. Sets INTEGRATION_ID_FILE on success.
  # context: prepare|on (values-free fail messages only).
  local context="${1:-prepare}"
  local probe count linked ready id_tmp id_val
  probe="$(run_directory_anchor_probe)"
  count="$(parse_probe_field "$probe" active_corp_anchored_count)"
  linked="$(parse_probe_field "$probe" linked_users)"
  ready="$(parse_probe_field "$probe" ready)"
  id_val="$(parse_probe_field "$probe" integration_id)"

  # Persist values-free counts for artifacts (never the id).
  ANCHOR_COUNT="$count"
  ANCHOR_LINKED_USERS="$linked"
  ANCHOR_READY="$ready"

  if [[ "$count" != "1" ]]; then
    fail "action=${context} requires exactly one active DingTalk integration with nonempty corp_id (got active_corp_anchored_count=${count})"
  fi
  if [[ "$ready" != "true" || -z "$id_val" ]]; then
    fail "action=${context} requires that single anchor to have >=2 active linked local users (linked_users=${linked} ready=${ready})"
  fi
  # UUID shape only — refuse garbage without printing value.
  if [[ ! "$id_val" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    fail "action=${context} derived integration id failed shape check (values not printed)"
  fi
  id_tmp="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.integration-id.XXXXXX")"
  register_ephemeral "$id_tmp"
  umask 077
  printf '%s' "$id_val" > "$id_tmp"
  chmod 600 "$id_tmp"
  INTEGRATION_ID_FILE="$id_tmp"
  # Drop shell copy immediately.
  unset id_val
  log "derived exactly one corp-anchored integration with linked_users=${linked} (id path only; never logged)"
}

require_live_stream_integration_id_matches_derived_anchor() {
  # Load-bearing for action=on: live DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID
  # must equal the uniquely-derived eligible anchor. Digest/file comparison only —
  # never prints the integration id. Presence alone is insufficient (stale/wrong ID).
  local context="${1:-on}" dig_live dig_want
  [[ -n "${INTEGRATION_ID_FILE:-}" && -f "$INTEGRATION_ID_FILE" && -s "$INTEGRATION_ID_FILE" ]] \
    || fail "action=${context} requires derived integration id file before live-id match (never print id)"
  dig_want="$(file_digest "$INTEGRATION_ID_FILE")"
  dig_live="$(env_key_digest_in_container "$KEY_STREAM_INTEGRATION_ID")"
  if [[ "$dig_want" == "MISSING" || "$dig_want" == "EMPTY" || "$dig_want" == "UNKNOWN" ]]; then
    fail "action=${context}: derived integration id digest unusable (class=${dig_want}; values not printed)"
  fi
  if [[ "$dig_live" == "MISSING" || "$dig_live" == "EMPTY" || "$dig_live" == "UNKNOWN" ]]; then
    fail "action=${context}: live ${KEY_STREAM_INTEGRATION_ID} digest unusable (class=${dig_live}; values not printed)"
  fi
  if [[ "$dig_live" != "$dig_want" ]]; then
    fail "action=${context}: live ${KEY_STREAM_INTEGRATION_ID} does not match uniquely-derived eligible anchor (digest mismatch; refuse stale/wrong id; values not printed)"
  fi
  log "live stream integration id matches uniquely-derived anchor (digest equal; values never logged)"
}

# --- env file atomic upsert (secret values from files only) ---------------------------
require_staging_env_file() {
  [[ -f "$STAGING_ENV_FILE" ]] || fail "staging env file missing: ${STAGING_ENV_FILE}"
  [[ -w "$STAGING_ENV_FILE" ]] || fail "staging env file not writable: ${STAGING_ENV_FILE}"
}

atomic_upsert_env_keys_from_files() {
  # Args: pairs of KEY FILE_OR_LITERAL where FILE is a path, or @literal:VALUE for non-secret flags.
  # Stream flag is always written as false for prepare via @literal:false.
  require_staging_env_file
  local tmp py_script out_py
  tmp="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.app.staging.env.XXXXXX")"
  register_ephemeral "$tmp"
  chmod 600 "$tmp"
  py_script="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.upsert-env.XXXXXX")"
  register_ephemeral "$py_script"
  chmod 600 "$py_script"

  cat >"$py_script" <<'PY'
import os, sys

src, dst = sys.argv[1], sys.argv[2]
pairs = sys.argv[3:]
if len(pairs) % 2 != 0:
    raise SystemExit("atomic_upsert: KEY/FILE pairs required")

updates = {}
for i in range(0, len(pairs), 2):
    key = pairs[i]
    spec = pairs[i + 1]
    if not key or "=" in key or any(c.isspace() for c in key):
        raise SystemExit("invalid env key")
    if spec.startswith("@literal:"):
        updates[key] = spec[len("@literal:"):]
    else:
        if not os.path.isfile(spec):
            raise SystemExit("missing secret file for key")
        with open(spec, "rb") as fh:
            raw = fh.read()
        # Exact bytes, strip only trailing newline/CR commonly introduced by secret writers.
        value = raw.decode("utf-8", errors="strict")
        if value.endswith("\r\n"):
            value = value[:-2]
        elif value.endswith("\n") or value.endswith("\r"):
            value = value[:-1]
        if not value.strip():
            raise SystemExit("empty secret file for key")
        # Refuse control characters (never print value).
        if any(ord(ch) < 32 and ch not in "\t" for ch in value) or "\x7f" in value:
            raise SystemExit("control characters in secret file for key")
        updates[key] = value

with open(src, encoding="utf-8", errors="replace") as fh:
    lines = fh.read().splitlines()

seen = set()
out = []
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        out.append(line)
        continue
    k = line.split("=", 1)[0].strip()
    if k in updates:
        out.append(f"{k}={updates[k]}")
        seen.add(k)
    else:
        out.append(line)

for k, v in updates.items():
    if k not in seen:
        out.append(f"{k}={v}")

# Atomic write via same-dir temp already provided as dst; caller mv's into place.
with open(dst, "w", encoding="utf-8") as fh:
    fh.write("\n".join(out))
    fh.write("\n")
os.chmod(dst, 0o600)
print("ok")
PY

  out_py="$(python3 "$py_script" "$STAGING_ENV_FILE" "$tmp" "$@" 2>/dev/null)" \
    || fail "atomic env upsert failed (values not printed)"
  rm -f "$py_script"
  [[ "$out_py" == "ok" ]] || fail "atomic env upsert did not confirm ok"

  # Validate candidate via compose config before replace.
  if ! compose_staging_cmd_with_env_file "$tmp" config >/dev/null 2>&1; then
    fail "candidate staging env failed 'docker compose config' validation; left previous env intact"
  fi

  # Backup previous env (mode 600) then atomic replace.
  local backup
  backup="${STREAM_UAT_PERSIST_DIR}/app.staging.env.backup-${RUN_STAMP}"
  cp -p "$STAGING_ENV_FILE" "$backup"
  chmod 600 "$backup" 2>/dev/null || true
  mv -f "$tmp" "$STAGING_ENV_FILE"
  chmod 600 "$STAGING_ENV_FILE"
  # $tmp path no longer exists after mv; trap rm -f is a no-op for the old path.
  log "staging env keys updated atomically (backup=${backup}; values never logged)"
}

compose_staging_cmd_with_env_file() {
  local env_file="$1"
  shift
  local image_pin image_owner image_tag
  local -a files=(-f "$STAGING_COMPOSE_FILE")
  if [[ -f "$ATTENDANCE_OVERRIDE_FILE" ]]; then
    files+=(-f "$ATTENDANCE_OVERRIDE_FILE")
  fi
  if [[ -f "$LIFECYCLE_OVERRIDE_FILE" ]]; then
    files+=(-f "$LIFECYCLE_OVERRIDE_FILE")
  fi
  if [[ -n "$PINNED_IMAGE_OWNER" && -n "$PINNED_IMAGE_TAG" ]]; then
    image_owner="$PINNED_IMAGE_OWNER"
    image_tag="$PINNED_IMAGE_TAG"
  else
    if ! image_pin="$(resolve_live_backend_image_pin)"; then
      return 1
    fi
    read -r image_owner image_tag <<< "$image_pin"
  fi
  (cd "$STAGING_DIR" && IMAGE_OWNER="$image_owner" IMAGE_TAG="$image_tag" APP_ENV_FILE="$env_file" \
    docker compose --project-directory "$STAGING_DIR" --env-file "$env_file" "${files[@]}" "$@")
}

atomic_set_stream_flag() {
  local desired="$1"  # true|false
  require_staging_env_file
  local tmp
  tmp="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.app.staging.env.flag.XXXXXX")"
  register_ephemeral "$tmp"
  chmod 600 "$tmp"
  local py_script
  py_script="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.set-stream-flag.XXXXXX")"
  register_ephemeral "$py_script"
  chmod 600 "$py_script"
  cat >"$py_script" <<'PY'
import os, sys
src, dst, key, value = sys.argv[1:5]
if value not in ("true", "false"):
    raise SystemExit("stream flag must be true or false")
with open(src, encoding="utf-8", errors="replace") as fh:
    lines = fh.read().splitlines()
seen = False
out = []
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        out.append(line)
        continue
    k = line.split("=", 1)[0].strip()
    if k == key:
        out.append(f"{key}={value}")
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(f"{key}={value}")
with open(dst, "w", encoding="utf-8") as fh:
    fh.write("\n".join(out) + "\n")
os.chmod(dst, 0o600)
PY
  if ! python3 "$py_script" "$STAGING_ENV_FILE" "$tmp" "$FLAG_STREAM" "$desired"; then
    rm -f "$py_script" "$tmp"
    fail "stream flag rewrite failed (values not printed)"
  fi
  rm -f "$py_script"
  if ! compose_staging_cmd_with_env_file "$tmp" config >/dev/null 2>&1; then
    rm -f "$tmp"
    fail "candidate stream-flag env failed compose config validation; left previous env intact"
  fi
  local backup
  backup="${STREAM_UAT_PERSIST_DIR}/app.staging.env.flag-backup-${RUN_STAMP}"
  cp -p "$STAGING_ENV_FILE" "$backup"
  chmod 600 "$backup" 2>/dev/null || true
  mv -f "$tmp" "$STAGING_ENV_FILE"
  chmod 600 "$STAGING_ENV_FILE"
  # $tmp path no longer exists after mv; trap rm -f is a no-op for the old path.
  log "stream flag set to ${desired} atomically (value is enum only)"
}

# --- backend recreate -----------------------------------------------------------------
recreate_backend_only() {
  local pg_id_before redis_id_before pg_id_after redis_id_after
  local i health

  pg_id_before="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")" \
    || { log "staging postgres container not found"; return 1; }
  redis_id_before="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")" \
    || { log "staging redis container not found"; return 1; }

  if ! compose_staging_cmd up -d --no-deps --force-recreate backend 2>&1 \
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

backend_needs_restart_for_prepare() {
  # Compare digests of the four keys + stream flag false in live container vs desired files.
  local live_flag dig_live dig_want
  live_flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  if [[ "$live_flag" != "false" ]]; then
    return 0
  fi
  dig_live="$(env_key_digest_in_container "$KEY_CLIENT_ID")"
  dig_want="$(file_digest "$STREAM_CLIENT_ID_FILE")"
  [[ "$dig_live" == "$dig_want" ]] || return 0
  dig_live="$(env_key_digest_in_container "$KEY_CLIENT_SECRET")"
  dig_want="$(file_digest "$STREAM_CLIENT_SECRET_FILE")"
  [[ "$dig_live" == "$dig_want" ]] || return 0
  dig_live="$(env_key_digest_in_container "$KEY_TEMPLATE_ID")"
  dig_want="$(file_digest "$STREAM_TEMPLATE_ID_FILE")"
  [[ "$dig_live" == "$dig_want" ]] || return 0
  dig_live="$(env_key_digest_in_container "$KEY_STREAM_INTEGRATION_ID")"
  dig_want="$(file_digest "$INTEGRATION_ID_FILE")"
  [[ "$dig_live" == "$dig_want" ]] || return 0
  return 1
}

# --- worker log proofs (values-free message classes only) -----------------------------
# IMPORTANT (interactive-card-stream.ts): log "worker started" / status active means
# the worker process path started with SDK-owned connection lifecycle — NOT that the
# SDK is connected. connect() resolves even on total failure and retries forever.
# This lane may prove worker_started only; stream_connected is always unknown here.
# Real connectivity remains human U12/U13 (callback UAT), never inferred from logs.
WORKER_STARTED_MSG="DingTalk interactive-card Stream worker started"
WORKER_DISABLED_MSG="DingTalk interactive-card Stream worker disabled"
WORKER_FAILED_MSG="DingTalk interactive-card Stream worker failed to start"
WORKER_SHUTDOWN_MSG="DingTalk interactive-card Stream worker shut down"
# Always unknown until real callback UAT (human-gated U12/U13). Never flip from logs.
STREAM_CONNECTED_UNKNOWN="unknown"

probe_worker_state_from_logs() {
  # Returns: started|disabled|failed|unknown — based on recent backend logs.
  # "started" = worker_started only (not connected). Never dumps raw logs; only classifies.
  local logs started disabled failed shutdown
  if ! docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null | grep -qx 'true'; then
    printf 'unknown'
    return 0
  fi
  # Capture into a temp file (mode 600) then classify; never cat to console.
  local tmp
  tmp="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.worker-logs.XXXXXX")"
  register_ephemeral "$tmp"
  chmod 600 "$tmp"
  docker logs --tail 400 "$BACKEND_CONTAINER" >"$tmp" 2>&1 || true
  started=0 disabled=0 failed=0 shutdown=0
  grep -F "$WORKER_STARTED_MSG" "$tmp" >/dev/null 2>&1 && started=1
  grep -F "$WORKER_DISABLED_MSG" "$tmp" >/dev/null 2>&1 && disabled=1
  grep -F "$WORKER_FAILED_MSG" "$tmp" >/dev/null 2>&1 && failed=1
  grep -F "$WORKER_SHUTDOWN_MSG" "$tmp" >/dev/null 2>&1 && shutdown=1
  rm -f "$tmp"
  # Prefer most-recent semantic: if stream flag is false, disabled wins over older started.
  local flag
  flag="$(read_flag_from_container "$FLAG_STREAM" 2>/dev/null || echo unknown)"
  if [[ "$flag" == "true" ]]; then
    if [[ "$failed" == "1" && "$started" != "1" ]]; then
      printf 'failed'
      return 0
    fi
    if [[ "$started" == "1" ]]; then
      printf 'started'
      return 0
    fi
    printf 'unknown'
    return 0
  fi
  if [[ "$flag" == "false" ]]; then
    if [[ "$disabled" == "1" || "$shutdown" == "1" ]]; then
      printf 'disabled'
      return 0
    fi
    # Flag off and no started line in recent window after a restart is "disabled".
    if [[ "$started" != "1" ]]; then
      printf 'disabled'
      return 0
    fi
    # Stale started line with flag false — still report disabled via env authority.
    printf 'disabled'
    return 0
  fi
  printf 'unknown'
}

wait_for_worker_started() {
  # Proves worker_started log class only. Does NOT prove stream_connected.
  local i state
  for ((i = 1; i <= 30; i += 1)); do
    state="$(probe_worker_state_from_logs)"
    if [[ "$state" == "started" ]]; then
      log "worker_started proven (state=started; stream_connected remains unknown) attempt ${i}/30"
      return 0
    fi
    if [[ "$state" == "failed" ]]; then
      fail "worker failed to start (state=failed); refusing action=on success"
    fi
    log "waiting for worker_started only (state=${state}; not a connect proof) attempt ${i}/30"
    sleep 2
  done
  fail "worker_started not proven within timeout (last state=${state:-unknown}; never claims connected)"
}

wait_for_worker_disabled() {
  local i state flag
  for ((i = 1; i <= 30; i += 1)); do
    flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
    state="$(probe_worker_state_from_logs)"
    if [[ "$flag" == "false" && ( "$state" == "disabled" || "$state" == "unknown" ) ]]; then
      # unknown + flag false after restart is acceptable only when started is absent.
      if [[ "$state" == "disabled" ]]; then
        log "worker stopped/not registered proven (state=disabled flag=false) attempt ${i}/30"
        return 0
      fi
    fi
    if [[ "$flag" == "false" && "$state" != "started" && "$state" != "failed" ]]; then
      log "worker not registered (flag=false state=${state}) attempt ${i}/30"
      return 0
    fi
    log "waiting for worker disabled (flag=${flag} state=${state}) attempt ${i}/30"
    sleep 2
  done
  # Fail-safe off: if flag is false in container, accept with warning class in summary.
  flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  if [[ "$flag" == "false" ]]; then
    log "worker flag proven false; log class inconclusive — fail-safe off accepts flag=false"
    return 0
  fi
  fail "worker stop not proven (flag=${flag})"
}

# --- secret file requirements ---------------------------------------------------------
require_prepare_secret_files() {
  local f
  for f in STREAM_CLIENT_ID_FILE STREAM_CLIENT_SECRET_FILE STREAM_TEMPLATE_ID_FILE; do
    local path="${!f:-}"
    [[ -n "$path" ]] || fail "action=prepare requires ${f} (chmod-600 secret file path); never argv/env values"
    [[ -f "$path" ]] || fail "action=prepare secret file missing for ${f}"
    [[ -s "$path" ]] || fail "action=prepare secret file empty for ${f}"
  done
  log "prepare secret files present (paths only; values never logged)"
}

require_stream_prerequisites_for_on() {
  # Credentials present + unique eligible DB anchor + LIVE integration-id equality.
  # Presence alone is insufficient: a stale/wrong STREAM_INTEGRATION_ID must fail.
  # After unique-anchor probe, materialize ID to chmod-600 file and compare digests
  # (file_digest vs env_key_digest_in_container). Never print the ID.
  local cid csec tmpl integ dig_live dig_want
  cid="$(env_key_present_in_container "$KEY_CLIENT_ID")"
  csec="$(env_key_present_in_container "$KEY_CLIENT_SECRET")"
  tmpl="$(env_key_present_in_container "$KEY_TEMPLATE_ID")"
  integ="$(env_key_present_in_container "$KEY_STREAM_INTEGRATION_ID")"
  [[ "$cid" == "true" ]] || fail "action=on requires ${KEY_CLIENT_ID} present in live backend"
  [[ "$csec" == "true" ]] || fail "action=on requires ${KEY_CLIENT_SECRET} present in live backend"
  [[ "$tmpl" == "true" ]] || fail "action=on requires ${KEY_TEMPLATE_ID} present in live backend"
  [[ "$integ" == "true" ]] || fail "action=on requires ${KEY_STREAM_INTEGRATION_ID} present in live backend"

  # Unique anchor probe → secure materialize of exact integration id (path only).
  derive_exact_integration_id_file "on"
  [[ -n "${INTEGRATION_ID_FILE:-}" && -f "$INTEGRATION_ID_FILE" && -s "$INTEGRATION_ID_FILE" ]] \
    || fail "action=on: derived integration id file missing after unique anchor probe (never print id)"

  # LOAD-BEARING live integration-id equality (digest/file only; never print ID).
  dig_want="$(file_digest "$INTEGRATION_ID_FILE")"
  dig_live="$(env_key_digest_in_container "$KEY_STREAM_INTEGRATION_ID")"
  if [[ "$dig_want" == "MISSING" || "$dig_want" == "EMPTY" || "$dig_want" == "UNKNOWN" ]]; then
    fail "action=on: derived integration id digest unusable (class=${dig_want}; values not printed)"
  fi
  if [[ "$dig_live" == "MISSING" || "$dig_live" == "EMPTY" || "$dig_live" == "UNKNOWN" ]]; then
    fail "action=on: live ${KEY_STREAM_INTEGRATION_ID} digest unusable (class=${dig_live}; values not printed)"
  fi
  if [[ "$dig_live" != "$dig_want" ]]; then
    fail "action=on: live ${KEY_STREAM_INTEGRATION_ID} does not match uniquely-derived eligible anchor (digest mismatch; refuse stale/wrong id; values not printed)"
  fi
  # Keep helper available for shared prepare paths / explicit re-check callers.
  require_live_stream_integration_id_matches_derived_anchor "on"
  log "stream prerequisites OK (credentials present; single anchor linked_users=${ANCHOR_LINKED_USERS}; live integration id digest matches derived anchor)"
}

# --- artifact writers -----------------------------------------------------------------
write_status_artifact() {
  local reason="${1:-ok}"
  local live_sha stream_on cid csec tmpl integ lifecycle health worker
  live_sha="$(resolve_deployed_sha)"
  stream_on="$(read_flag_from_container "$FLAG_STREAM" 2>/dev/null || echo unknown)"
  cid="$(env_key_present_in_container "$KEY_CLIENT_ID")"
  csec="$(env_key_present_in_container "$KEY_CLIENT_SECRET")"
  tmpl="$(env_key_present_in_container "$KEY_TEMPLATE_ID")"
  integ="$(env_key_present_in_container "$KEY_STREAM_INTEGRATION_ID")"
  lifecycle="$(read_lifecycle_all_off)"
  health="$(fetch_backend_health_ok)"
  worker="$(probe_worker_state_from_logs)"
  classify_log_level

  local probe count linked ready
  probe="$(run_directory_anchor_probe)"
  count="$(parse_probe_field "$probe" active_corp_anchored_count)"
  linked="$(parse_probe_field "$probe" linked_users)"
  ready="$(parse_probe_field "$probe" ready)"

  local sha_match="unknown"
  if [[ -n "$DEPLOY_SHA" ]]; then
    if [[ "$live_sha" =~ ^[0-9a-f]{40}$ && "$live_sha" == "$DEPLOY_SHA" ]]; then
      sha_match="true"
    elif [[ "$live_sha" == "unknown" || "$live_sha" == "conflict" ]]; then
      sha_match="unknown"
    else
      sha_match="false"
    fi
  fi

  {
    echo "schema=dingtalk-interactive-card-stream-staging-uat-status-v1"
    echo "action=${ACTION}"
    echo "reason=${reason}"
    echo "deployed_sha=${live_sha}"
    echo "deployed_sha_match=${sha_match}"
    echo "backend_health=${health}"
    echo "stream_enabled=${stream_on}"
    echo "client_id_present=${cid}"
    echo "client_secret_present=${csec}"
    echo "template_id_present=${tmpl}"
    echo "stream_integration_id_present=${integ}"
    echo "active_corp_anchored_integration_count=${count}"
    echo "linked_local_users_for_anchor_count=${linked}"
    echo "single_anchor_two_users_ready=${ready}"
    echo "lifecycle_flags_all_off=${lifecycle}"
    echo "log_level_ready=${LOG_LEVEL_READY}"
    echo "log_level_reason=${LOG_LEVEL_REASON}"
    echo "worker_state=${worker}"
    # Never claim connected from startup logs; human U12/U13 only.
    echo "stream_connected=${STREAM_CONNECTED_UNKNOWN}"
  } > "${OUTPUT_DIR}/stream-uat-status.txt"

  {
    echo "schema=dingtalk-interactive-card-stream-staging-uat-status-v1"
    echo "action=${ACTION}"
    echo "reason=${reason}"
    echo "stream_enabled=${stream_on}"
    echo "worker_state=${worker}"
    echo "stream_connected=${STREAM_CONNECTED_UNKNOWN}"
    echo "lifecycle_flags_all_off=${lifecycle}"
    echo "single_anchor_two_users_ready=${ready}"
    echo "backend_health=${health}"
  } > "${OUTPUT_DIR}/summary.txt"

  log "status artifact written (values-free; stream_connected=unknown always in this lane)"
}

# --- actions --------------------------------------------------------------------------
action_status() {
  assert_staging_only
  write_status_artifact "ok"
  log "action=status complete (read-only)"
}

action_prepare() {
  assert_staging_only
  require_compose_v2
  require_exact_deployed_sha "prepare"
  pin_live_backend_image_for_transition
  require_lifecycle_flags_off "prepare"
  require_prepare_secret_files
  require_staging_env_file

  # Configuration is allowed only after action=off has proved the live worker disabled.
  # Writing a false flag is not enough to stop an already-running client if the following
  # backend recreate fails, so prepare must never double as an implicit stop operation.
  local pre_flag
  pre_flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  [[ "$pre_flag" == "false" ]] \
    || fail "action=prepare requires live Stream OFF before credential changes (got stream_enabled=${pre_flag}); run action=off first"
  log "prepare precondition proven: live Stream OFF"

  derive_exact_integration_id_file

  # Atomic write of four credential/id keys + forced Stream flag false.
  atomic_upsert_env_keys_from_files \
    "$KEY_CLIENT_ID" "$STREAM_CLIENT_ID_FILE" \
    "$KEY_CLIENT_SECRET" "$STREAM_CLIENT_SECRET_FILE" \
    "$KEY_TEMPLATE_ID" "$STREAM_TEMPLATE_ID_FILE" \
    "$KEY_STREAM_INTEGRATION_ID" "$INTEGRATION_ID_FILE" \
    "$FLAG_STREAM" "@literal:false"

  # Post-write digests on disk (presence only for summary).
  local disk_flag_dig
  disk_flag_dig="$(read_env_file_value_digest "$FLAG_STREAM" "$STAGING_ENV_FILE")"
  # false literal digest is stable; just require not MISSING/EMPTY
  [[ "$disk_flag_dig" != "MISSING" && "$disk_flag_dig" != "EMPTY" ]] \
    || fail "prepare failed to persist stream flag false"

  local need_restart="false"
  if backend_needs_restart_for_prepare; then
    need_restart="true"
  fi

  if [[ "$need_restart" == "true" ]]; then
    log "prepare: backend restart required (env mismatch or stream not false in live container)"
    if ! recreate_backend_only; then
      fail "prepare: backend restart/health failed after env write"
    fi
    require_exact_deployed_sha "prepare-post-restart"
  else
    log "prepare: backend restart skipped (live container already matches forced-off credentials)"
  fi

  # Prove stream is false live.
  local post_flag
  post_flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  [[ "$post_flag" == "false" ]] || fail "prepare must leave stream flag false (got ${post_flag})"

  # Prove credential presence without values.
  [[ "$(env_key_present_in_container "$KEY_CLIENT_ID")" == "true" ]] || fail "prepare: client_id not present live"
  [[ "$(env_key_present_in_container "$KEY_CLIENT_SECRET")" == "true" ]] || fail "prepare: client_secret not present live"
  [[ "$(env_key_present_in_container "$KEY_TEMPLATE_ID")" == "true" ]] || fail "prepare: template_id not present live"
  [[ "$(env_key_present_in_container "$KEY_STREAM_INTEGRATION_ID")" == "true" ]] || fail "prepare: stream_integration_id not present live"

  write_status_artifact "prepare_ok"
  {
    echo "prepare_forced_stream_off=true"
    echo "backend_restarted=${need_restart}"
    echo "active_corp_anchored_integration_count=${ANCHOR_COUNT}"
    echo "linked_local_users_for_anchor_count=${ANCHOR_LINKED_USERS}"
  } >> "${OUTPUT_DIR}/summary.txt"
  log "action=prepare complete (stream forced OFF)"
}

action_on() {
  assert_staging_only
  require_compose_v2
  require_exact_deployed_sha "on"
  pin_live_backend_image_for_transition
  require_lifecycle_flags_off "on"
  require_log_level_info_or_debug
  require_stream_prerequisites_for_on
  require_staging_env_file

  # --- fail-safe window ----------------------------------------------------------
  # Arm BEFORE Stream ON write. Covers every later failure path:
  #   recreate_backend_only, post-restart exact SHA, live flag true,
  #   wait_for_worker_started, lifecycle post, write_status_artifact/summary,
  #   and INT/TERM signals (trap exits; does not return/continue).
  # Disarm ONLY after all checks + artifact writes succeed.
  arm_stream_on_fail_safe_rollback

  # Flip ONLY the Stream flag true (credentials untouched).
  atomic_set_stream_flag "true"

  # Post-write checks: any failure → fail()/non-zero exit → EXIT trap rollback.
  if ! recreate_backend_only; then
    fail "action=on: backend restart/health failed after Stream ON (fail-safe rollback armed)"
  fi
  require_exact_deployed_sha "on-post-restart"

  # Recreate loads docker/app.staging.env, which may have drifted from the
  # pre-restart container. Re-run the complete gate against the new process.
  require_stream_prerequisites_for_on

  local live_flag
  live_flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  [[ "$live_flag" == "true" ]] || fail "action=on: live stream flag is not true (got ${live_flag}) (fail-safe rollback armed)"

  # worker_started only — not stream_connected (SDK connect resolves + retries forever).
  wait_for_worker_started

  # Lifecycle still off.
  require_lifecycle_flags_off "on-post"

  write_status_artifact "on_ok"
  {
    echo "stream_enabled=true"
    echo "worker_state=started"
    echo "stream_connected=${STREAM_CONNECTED_UNKNOWN}"
    echo "log_level_reason=${LOG_LEVEL_REASON}"
    echo "u12_u13_human_gated=true"
    echo "on_fail_safe_rollback_disarmed=true"
  } >> "${OUTPUT_DIR}/summary.txt"

  # All on checks + artifact writes succeeded — disarm so EXIT does not roll Stream OFF.
  disarm_stream_on_fail_safe_rollback
  log "action=on complete (stream ON; worker_started only; stream_connected=unknown; U12/U13 human-gated)"
}

action_off() {
  # Fail-safe: always attempt to force stream false + restart, even if probes are messy.
  assert_staging_only
  require_compose_v2
  require_exact_deployed_sha "off"
  pin_live_backend_image_for_transition
  require_staging_env_file

  atomic_set_stream_flag "false"

  if ! recreate_backend_only; then
    fail "action=off: backend restart/health failed after forcing stream false (operator must inspect)"
  fi
  require_exact_deployed_sha "off-post-restart"

  local live_flag
  live_flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  [[ "$live_flag" == "false" ]] || fail "action=off: live stream flag is not false (got ${live_flag})"

  wait_for_worker_disabled

  write_status_artifact "off_ok"
  {
    echo "stream_enabled=false"
    echo "worker_state=$(probe_worker_state_from_logs)"
    echo "stream_connected=${STREAM_CONNECTED_UNKNOWN}"
    echo "fail_safe_off=true"
  } >> "${OUTPUT_DIR}/summary.txt"
  log "action=off complete (stream OFF; worker stopped/not registered; stream_connected still unknown)"
}

# --- main -----------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR" 2>/dev/null || true

case "$ACTION" in
  status) action_status ;;
  prepare) action_prepare ;;
  on) action_on ;;
  off) action_off ;;
  *) fail "invalid ACTION='${ACTION}' (expected status|prepare|on|off)" ;;
esac

log "done action=${ACTION}"
