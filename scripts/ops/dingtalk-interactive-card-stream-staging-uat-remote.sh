#!/usr/bin/env bash
# dingtalk-interactive-card-stream-staging-uat-remote.sh
#
# Remote (deploy-host) half of
# .github/workflows/dingtalk-interactive-card-stream-staging-uat.yml.
# Executes ONE action per invocation against the STAGING stack only.
#
# EXECUTABLE:
#   status  — read-only snapshot (booleans / counts / reason classes / SHA only)
#   observe-baseline — capture values-free per-delivery callback log counts before
#             the human click; writes only a sealed local observer checkpoint
#   observe — require callback/corp-anchor evidence to increase beyond that
#             checkpoint for one validated delivery UUID; never emits raw logs or ids
#   prepare — transport Stream credentials via chmod-600 files, derive exactly
#             one active integration for live DINGTALK_CORP_ID with >=2 active
#             linked local users, atomically write the four credential/id env
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
#   https-on  — provision a pinned Caddy TLS gateway on 443, atomically switch
#               staging public/CORS/OAuth callback URLs, restart, verify
#   https-off — restore the pre-HTTPS env and remove the gateway
#
# HARD SAFETY RAILS:
#   * Staging compose + metasheet-staging-* containers only; no prod fallback.
#   * Lifecycle flags (alias/pending/deprovision) are NEVER written by this lane.
#   * Stream stays OFF except explicit action=on.
#   * Secrets never appear in shell argv, exported env values, logs, or artifacts.
#   * Every non-status action requires exact deployed 40-char lowercase SHA.
#   * Artifacts: booleans / counts / reason enums / SHA only — no raw IDs/PII.
#   * stream_connected is always unknown in this lane (no connect claim from logs).
#   * U12/U13 remain human-gated (real callback / flag-off UAT); not automated.
#   * Invoked as `bash -o pipefail -c '<script>'`.
set -euo pipefail

log() { echo "[stream-uat] $*"; }
fail() { echo "[stream-uat][error] $*" >&2; exit 1; }

ACTION="${ACTION:?ACTION is required (status|observe-baseline|observe|prepare|on|off|https-on|https-off)}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
EXPECTED_DELIVERY_ID="${EXPECTED_DELIVERY_ID:-}"
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

HTTPS_GATEWAY_HOST="metasheet-staging.ddns.net"
HTTPS_GATEWAY_EXPECTED_IP="23.254.236.11"
HTTPS_GATEWAY_ORIGIN="https://${HTTPS_GATEWAY_HOST}"
HTTPS_GATEWAY_CALLBACK="${HTTPS_GATEWAY_ORIGIN}/login/dingtalk/callback"
HTTPS_GATEWAY_CONTAINER="metasheet-staging-https-gateway"
HTTPS_GATEWAY_IMAGE="caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"

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
HTTPS_ON_ROLLBACK_ARMED="false"
HTTPS_ON_SUCCESS="false"
HTTPS_ON_ROLLBACK_DONE="false"
HTTPS_ENV_WRITTEN="false"
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

write_https_env_backup_checksum() {
  [[ -f "$HTTPS_ENV_BACKUP" ]] || return 1
  local digest candidate
  digest="$(sha256sum "$HTTPS_ENV_BACKUP" 2>/dev/null | awk '{print $1}')"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  candidate="${HTTPS_ENV_BACKUP_SHA256}.${RUN_STAMP}.tmp"
  register_ephemeral "$candidate"
  umask 077
  printf '%s\n' "$digest" >"$candidate" || return 1
  chmod 600 "$candidate"
  mv -f "$candidate" "$HTTPS_ENV_BACKUP_SHA256"
  chmod 600 "$HTTPS_ENV_BACKUP_SHA256"
}

validate_legacy_https_env_backup() {
  # Compatibility for the one staging gateway created before checksum sealing
  # existed. Accept only one coherent, non-gateway URL triplet; never print it.
  [[ -f "$HTTPS_ENV_BACKUP" ]] || return 1
  python3 - "$HTTPS_ENV_BACKUP" "$HTTPS_GATEWAY_ORIGIN" "$HTTPS_GATEWAY_CALLBACK" <<'PY'
import sys
from urllib.parse import urlsplit

path, gateway_origin, gateway_callback = sys.argv[1:]
keys = ("PUBLIC_APP_URL", "CORS_ORIGIN", "DINGTALK_REDIRECT_URI")
values = {key: [] for key in keys}

with open(path, encoding="utf-8", errors="strict") as fh:
    for raw in fh:
        line = raw.rstrip("\r\n")
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in values:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key].append(value.strip())

if any(len(values[key]) != 1 for key in keys):
    raise SystemExit(1)

def parsed(value):
    result = urlsplit(value)
    if result.scheme not in ("http", "https") or not result.hostname:
        raise SystemExit(1)
    if result.username or result.password or result.fragment:
        raise SystemExit(1)
    return result

public = parsed(values["PUBLIC_APP_URL"][0])
cors = parsed(values["CORS_ORIGIN"][0])
redirect = parsed(values["DINGTALK_REDIRECT_URI"][0])

def origin(result):
    return f"{result.scheme}://{result.netloc}".rstrip("/")

if origin(public) != origin(cors) or origin(public) != origin(redirect):
    raise SystemExit(1)
if redirect.path.rstrip("/") != "/login/dingtalk/callback":
    raise SystemExit(1)
if values["PUBLIC_APP_URL"][0].rstrip("/") == gateway_origin.rstrip("/"):
    raise SystemExit(1)
if values["DINGTALK_REDIRECT_URI"][0].rstrip("/") == gateway_callback.rstrip("/"):
    raise SystemExit(1)
PY
}

require_https_env_backup_integrity() {
  [[ -f "$HTTPS_ENV_BACKUP" ]] || return 1
  if [[ ! -f "$HTTPS_ENV_BACKUP_SHA256" ]]; then
    validate_legacy_https_env_backup || return 1
    write_https_env_backup_checksum || return 1
    HTTPS_ENV_BACKUP_LEGACY_SEALED="true"
  fi

  local expected actual line_count
  line_count="$(wc -l <"$HTTPS_ENV_BACKUP_SHA256" | tr -d '[:space:]')"
  [[ "$line_count" == "1" ]] || return 1
  expected="$(tr -d '\r\n' <"$HTTPS_ENV_BACKUP_SHA256")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual="$(sha256sum "$HTTPS_ENV_BACKUP" 2>/dev/null | awk '{print $1}')"
  [[ "$actual" =~ ^[0-9a-f]{64}$ && "$actual" == "$expected" ]]
}

restore_https_env_backup() {
  [[ -f "$HTTPS_ENV_BACKUP" ]] || return 1
  require_https_env_backup_integrity || return 1
  local candidate py_script
  candidate="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.https-restore.XXXXXX")"
  register_ephemeral "$candidate"
  py_script="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.https-restore-script.XXXXXX")"
  register_ephemeral "$py_script"
  cat >"$py_script" <<'PY'
import os, sys

current_path, backup_path, candidate_path = sys.argv[1:]
target_keys = ("PUBLIC_APP_URL", "CORS_ORIGIN", "DINGTALK_REDIRECT_URI")

def read_lines(path):
    with open(path, encoding="utf-8", errors="strict") as fh:
        return fh.read().splitlines()

def key_for(line):
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        return None
    return line.split("=", 1)[0].strip()

backup_values = {key: None for key in target_keys}
for line in read_lines(backup_path):
    key = key_for(line)
    if key in backup_values:
        backup_values[key] = line.split("=", 1)[1]

out = []
emitted = set()
for line in read_lines(current_path):
    key = key_for(line)
    if key not in backup_values:
        out.append(line)
        continue
    if key not in emitted and backup_values[key] is not None:
        out.append(f"{key}={backup_values[key]}")
    emitted.add(key)

for key in target_keys:
    if key not in emitted and backup_values[key] is not None:
        out.append(f"{key}={backup_values[key]}")

with open(candidate_path, "w", encoding="utf-8") as fh:
    fh.write("\n".join(out) + "\n")
os.chmod(candidate_path, 0o600)
PY
  python3 "$py_script" "$STAGING_ENV_FILE" "$HTTPS_ENV_BACKUP" "$candidate" \
    || { rm -f "$candidate" "$py_script"; return 1; }
  chmod 600 "$candidate"
  compose_staging_cmd_with_env_file "$candidate" config >/dev/null 2>&1 \
    || { rm -f "$candidate" "$py_script"; return 1; }
  if ! ( atomic_replace_staging_env "$candidate" ); then
    rm -f "$candidate" "$py_script"
    return 1
  fi
  rm -f "$candidate" "$py_script"
}

https_env_file_matches_gateway() {
  local origin_digest callback_digest public_digest cors_digest redirect_digest
  [[ -f "$STAGING_ENV_FILE" ]] || return 2
  origin_digest="$(printf '%s' "$HTTPS_GATEWAY_ORIGIN" | sha256sum | awk '{print $1}')"
  callback_digest="$(printf '%s' "$HTTPS_GATEWAY_CALLBACK" | sha256sum | awk '{print $1}')"
  public_digest="$(read_env_file_value_digest PUBLIC_APP_URL "$STAGING_ENV_FILE")"
  cors_digest="$(read_env_file_value_digest CORS_ORIGIN "$STAGING_ENV_FILE")"
  redirect_digest="$(read_env_file_value_digest DINGTALK_REDIRECT_URI "$STAGING_ENV_FILE")"
  if [[ "$public_digest" == "UNKNOWN" || "$cors_digest" == "UNKNOWN" || "$redirect_digest" == "UNKNOWN" ]]; then
    return 2
  fi
  [[ "$public_digest" == "$origin_digest" \
    && "$cors_digest" == "$origin_digest" \
    && "$redirect_digest" == "$callback_digest" ]]
}

remove_https_gateway_if_present() {
  if ! docker inspect "$HTTPS_GATEWAY_CONTAINER" >/dev/null 2>&1; then
    return 0
  fi
  docker rm -f "$HTTPS_GATEWAY_CONTAINER" >/dev/null 2>&1 || return 1
  ! docker inspect "$HTTPS_GATEWAY_CONTAINER" >/dev/null 2>&1
}

https_on_fail_safe_rollback() {
  if [[ "$HTTPS_ON_ROLLBACK_ARMED" != "true" || "$HTTPS_ON_SUCCESS" == "true" || "$HTTPS_ON_ROLLBACK_DONE" == "true" ]]; then
    return 0
  fi
  HTTPS_ON_ROLLBACK_DONE="true"
  set +e
  local env_rc=0 recreate_rc=0 gateway_rc=0 env_was_switched="false" env_match_rc=1
  https_env_file_matches_gateway
  env_match_rc=$?
  if [[ "$HTTPS_ENV_WRITTEN" == "true" || "$env_match_rc" == "0" ]]; then
    env_was_switched="true"
    ( restore_https_env_backup ) || env_rc=1
    if [[ "$env_rc" == "0" ]]; then
      ( recreate_backend_only ) || recreate_rc=1
    else
      recreate_rc=1
    fi
  elif [[ "$env_match_rc" == "2" ]]; then
    # Unknown is not evidence of "not switched". Preserve both recovery assets.
    env_was_switched="unknown"
    env_rc=1
    recreate_rc=1
  elif [[ -f "$HTTPS_ENV_BACKUP" ]]; then
    # No env write occurred. Keep the snapshot until gateway removal succeeds,
    # so a failed removal never strands an unmanaged container without evidence.
    :
  fi
  if [[ "$env_was_switched" == "false" || ( "$env_rc" == "0" && "$recreate_rc" == "0" ) ]]; then
    remove_https_gateway_if_present || gateway_rc=1
  else
    # Keep the still-required gateway online when env rollback failed.
    gateway_rc=2
  fi
  if [[ "$env_was_switched" == "true" && "$env_rc" == "0" && "$recreate_rc" == "0" && "$gateway_rc" == "0" ]]; then
    rm -f "$HTTPS_ENV_BACKUP" "$HTTPS_ENV_BACKUP_SHA256" || env_rc=1
  fi
  if [[ "$env_was_switched" == "false" && "$gateway_rc" == "0" && -f "$HTTPS_ENV_BACKUP" ]]; then
    rm -f "$HTTPS_ENV_BACKUP" "$HTTPS_ENV_BACKUP_SHA256" || env_rc=1
  fi
  rm -f "${STREAM_UAT_PERSIST_DIR}/app.staging.env.backup-${RUN_STAMP}" >/dev/null 2>&1 || env_rc=1
  {
    echo "https_on_fail_safe_rollback=true"
    echo "https_env_restore_ok=$([[ "$env_rc" == "0" ]] && echo true || echo false)"
    echo "https_backend_restore_ok=$([[ "$recreate_rc" == "0" ]] && echo true || echo false)"
    case "$gateway_rc" in
      0) echo "https_gateway_remove_result=removed_or_absent" ;;
      1) echo "https_gateway_remove_result=failed" ;;
      2) echo "https_gateway_remove_result=skipped_env_not_restored" ;;
    esac
  } >> "${OUTPUT_DIR}/summary.txt" 2>/dev/null
  set -e
}

arm_https_on_fail_safe_rollback() {
  HTTPS_ON_ROLLBACK_ARMED="true"
  HTTPS_ON_SUCCESS="false"
  HTTPS_ON_ROLLBACK_DONE="false"
  HTTPS_ENV_WRITTEN="false"
}

disarm_https_on_fail_safe_rollback() {
  HTTPS_ON_SUCCESS="true"
  HTTPS_ON_ROLLBACK_ARMED="false"
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
  # Armed action=https-on window: restore env + remove TLS gateway.
  https_on_fail_safe_rollback
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
OBSERVE_BASELINE_FILE="${STREAM_UAT_PERSIST_DIR}/callback-observer-baseline"
HTTPS_GATEWAY_PERSIST_DIR="${HOME}/.metasheet2/staging-https-gateway"
HTTPS_ENV_BACKUP="${HTTPS_GATEWAY_PERSIST_DIR}/app.staging.env.before-https"
HTTPS_ENV_BACKUP_SHA256="${HTTPS_ENV_BACKUP}.sha256"
HTTPS_ENV_BACKUP_LEGACY_SEALED="false"

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
  local context="${1:-on}"
  classify_log_level
  if [[ "$LOG_LEVEL_READY" == "true" ]]; then
    case "$LOG_LEVEL_REASON" in
      info|debug|missing)
        log "LOG_LEVEL ready (reason=${LOG_LEVEL_REASON})"
        return 0
        ;;
    esac
  fi
  fail "action=${context} requires LOG_LEVEL info/debug (got ready=${LOG_LEVEL_READY} reason=${LOG_LEVEL_REASON})"
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
  # stdout JSON contains values-free total/configured/eligible counts.
  # integration_id is written ONLY when the configured corp has exactly one
  # eligible anchor (active integration + >=2 active linked local users).
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
    configured_corp_present: "unknown",
    configured_corp_anchor_count: "unknown",
    eligible_anchor_count: "unknown",
    linked_users: "unknown",
    ready: "unknown",
    integration_id: "",
  };
  const emit = (o) => process.stdout.write(JSON.stringify(o));
  const url = process.env.DATABASE_URL;
  const configuredCorpId = String(process.env.DINGTALK_CORP_ID || "").trim();
  if (!url) { emit(unknown); return; }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  try {
    await c.connect();
    const placeholder = [
      "replace-me","changeme","change-me","placeholder","todo","xxx","your-corp-id","example"
    ];
    const r = await c.query(
      `SELECT i.id::text AS id,
              i.corp_id,
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
        GROUP BY i.id, i.corp_id
        ORDER BY i.id`,
      [placeholder],
    );
    const rows = r.rows || [];
    const configuredRows = configuredCorpId
      ? rows.filter((row) => String(row.corp_id || "").trim() === configuredCorpId)
      : [];
    const eligibleRows = configuredRows.filter(
      (row) => (Number(row.linked_users) || 0) >= 2,
    );
    const ready = configuredCorpId.length > 0 && eligibleRows.length === 1;
    const linked = ready ? (Number(eligibleRows[0].linked_users) || 0) : "unknown";
    emit({
      active_corp_anchored_count: rows.length,
      configured_corp_present: configuredCorpId.length > 0 ? "true" : "false",
      configured_corp_anchor_count: configuredCorpId.length > 0 ? configuredRows.length : "unknown",
      eligible_anchor_count: configuredCorpId.length > 0 ? eligibleRows.length : "unknown",
      linked_users: linked,
      ready: ready ? "true" : "false",
      integration_id: ready ? String(eligibleRows[0].id || "") : "",
    });
  } catch {
    emit(unknown);
  } finally {
    try { await c.end(); } catch { /* ignore */ }
  }
})().catch(() => {
  process.stdout.write(JSON.stringify({
    active_corp_anchored_count: "unknown",
    configured_corp_present: "unknown",
    configured_corp_anchor_count: "unknown",
    eligible_anchor_count: "unknown",
    linked_users: "unknown",
    ready: "unknown",
    integration_id: "",
  }));
});
NODE
  out="$(docker exec -i "$BACKEND_CONTAINER" node <"$script_tmp" 2>/dev/null || true)"
  rm -f "$script_tmp"
  if [[ -z "$out" ]]; then
    printf '%s' '{"active_corp_anchored_count":"unknown","configured_corp_present":"unknown","configured_corp_anchor_count":"unknown","eligible_anchor_count":"unknown","linked_users":"unknown","ready":"unknown","integration_id":""}'
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
  local probe count configured_present configured_count eligible_count linked ready id_tmp id_val
  probe="$(run_directory_anchor_probe)"
  count="$(parse_probe_field "$probe" active_corp_anchored_count)"
  configured_present="$(parse_probe_field "$probe" configured_corp_present)"
  configured_count="$(parse_probe_field "$probe" configured_corp_anchor_count)"
  eligible_count="$(parse_probe_field "$probe" eligible_anchor_count)"
  linked="$(parse_probe_field "$probe" linked_users)"
  ready="$(parse_probe_field "$probe" ready)"
  id_val="$(parse_probe_field "$probe" integration_id)"

  # Persist values-free counts for artifacts (never the id).
  ANCHOR_COUNT="$count"
  CONFIGURED_CORP_PRESENT="$configured_present"
  CONFIGURED_CORP_ANCHOR_COUNT="$configured_count"
  ELIGIBLE_ANCHOR_COUNT="$eligible_count"
  ANCHOR_LINKED_USERS="$linked"
  ANCHOR_READY="$ready"

  if [[ "$configured_present" != "true" ]]; then
    fail "action=${context} requires nonempty live DINGTALK_CORP_ID to bind the Stream app to a configured corp (presence=${configured_present})"
  fi
  if [[ "$eligible_count" != "1" ]]; then
    fail "action=${context} requires exactly one eligible integration for configured corp (active_corp_anchored_count=${count} configured_corp_anchor_count=${configured_count} eligible_anchor_count=${eligible_count})"
  fi
  if [[ "$ready" != "true" || -z "$id_val" ]]; then
    fail "action=${context} requires the eligible configured-corp anchor to have >=2 active linked local users (linked_users=${linked} ready=${ready})"
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
  log "derived exactly one eligible configured-corp integration with linked_users=${linked} (id path only; never logged)"
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

atomic_replace_staging_env() {
  local candidate="$1"
  local target_dir target_name target_uid target_gid backend_image privileged_tmp
  target_dir="$(dirname "$STAGING_ENV_FILE")"
  target_name="$(basename "$STAGING_ENV_FILE")"

  if [[ -w "$target_dir" ]]; then
    mv -f "$candidate" "$STAGING_ENV_FILE"
    chmod 600 "$STAGING_ENV_FILE"
    return 0
  fi

  # The staging env can be writable while its root-owned parent directory refuses
  # rename(2). On this rootful staging Docker host, reuse the already-authorized
  # Docker control plane to stage a 0600 file in the target directory, then rename
  # it there atomically. The candidate is mounted read-only and the helper has no
  # network access. Rootless/userns-remapped Docker fails closed here.
  target_uid="$(stat -c '%u' "$STAGING_ENV_FILE")" \
    || fail "cannot resolve staging env owner uid"
  target_gid="$(stat -c '%g' "$STAGING_ENV_FILE")" \
    || fail "cannot resolve staging env owner gid"
  backend_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")" \
    || fail "cannot resolve live backend image for atomic env install"
  [[ -n "$backend_image" ]] || fail "live backend image is empty; refuse env install"
  privileged_tmp=".${target_name}.stream-uat-${RUN_STAMP}.tmp"

  if ! timeout 30s docker run --rm --pull never --network none --entrypoint /bin/sh \
    --mount "type=bind,src=${candidate},dst=/stream-uat-candidate,readonly" \
    --mount "type=bind,src=${target_dir},dst=/stream-uat-target" \
    -e "STREAM_UAT_TARGET_NAME=${target_name}" \
    -e "STREAM_UAT_TARGET_TMP=${privileged_tmp}" \
    -e "STREAM_UAT_TARGET_UID=${target_uid}" \
    -e "STREAM_UAT_TARGET_GID=${target_gid}" \
    "$backend_image" -c '
      set -eu
      umask 077
      cleanup() { rm -f "/stream-uat-target/${STREAM_UAT_TARGET_TMP}"; }
      cleanup_and_exit() { cleanup; exit "$1"; }
      trap cleanup EXIT
      trap "cleanup_and_exit 129" HUP
      trap "cleanup_and_exit 130" INT
      trap "cleanup_and_exit 143" TERM
      cp /stream-uat-candidate "/stream-uat-target/${STREAM_UAT_TARGET_TMP}"
      chown "${STREAM_UAT_TARGET_UID}:${STREAM_UAT_TARGET_GID}" "/stream-uat-target/${STREAM_UAT_TARGET_TMP}"
      chmod 600 "/stream-uat-target/${STREAM_UAT_TARGET_TMP}"
      mv -f "/stream-uat-target/${STREAM_UAT_TARGET_TMP}" "/stream-uat-target/${STREAM_UAT_TARGET_NAME}"
      trap - EXIT HUP INT TERM
    ' >/dev/null; then
    fail "atomic staging env install through network-disabled helper failed; previous env retained"
  fi
  rm -f "$candidate"
  log "staging env atomically installed through network-disabled helper (values never logged)"
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
  atomic_replace_staging_env "$tmp"
  # The helper consumes or removes $tmp; registered cleanup is then a no-op.
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
  atomic_replace_staging_env "$tmp"
  # The helper consumes or removes $tmp; registered cleanup is then a no-op.
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
  log "stream prerequisites OK (credentials present; configured-corp eligible anchor linked_users=${ANCHOR_LINKED_USERS}; live integration id digest matches derived anchor)"
}

# --- artifact writers -----------------------------------------------------------------
probe_tcp_listener() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -H -ltn "sport = :${port}" 2>/dev/null | grep -q .; then
      printf 'true'
    else
      printf 'false'
    fi
    return 0
  fi
  printf 'unknown'
}

docker_publishers_for_port() {
  local port="$1"
  local publishers
  publishers="$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
    | awk -F '|' -v needle=":${port}->" 'index($2, needle) { print $1 }' \
    | sort -u \
    | paste -sd, -)"
  if [[ -z "$publishers" ]]; then
    printf 'none'
    return 0
  fi
  if [[ ! "$publishers" =~ ^[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*$ ]]; then
    printf 'unknown'
    return 0
  fi
  printf '%s' "$publishers"
}

probe_https_gateway_status() {
  HTTPS_PORT_80_LISTENER="$(probe_tcp_listener 80)"
  HTTPS_PORT_443_LISTENER="$(probe_tcp_listener 443)"
  HTTPS_PORT_80_DOCKER_PUBLISHERS="$(docker_publishers_for_port 80)"
  HTTPS_PORT_443_DOCKER_PUBLISHERS="$(docker_publishers_for_port 443)"
  if sudo -n true >/dev/null 2>&1; then
    HTTPS_SUDO_NONINTERACTIVE="true"
  else
    HTTPS_SUDO_NONINTERACTIVE="false"
  fi
  if command -v nginx >/dev/null 2>&1; then HTTPS_HOST_NGINX_PRESENT="true"; else HTTPS_HOST_NGINX_PRESENT="false"; fi
  if command -v caddy >/dev/null 2>&1; then HTTPS_HOST_CADDY_PRESENT="true"; else HTTPS_HOST_CADDY_PRESENT="false"; fi
  if command -v certbot >/dev/null 2>&1; then HTTPS_HOST_CERTBOT_PRESENT="true"; else HTTPS_HOST_CERTBOT_PRESENT="false"; fi
  if docker inspect -f '{{.State.Running}}' "$HTTPS_GATEWAY_CONTAINER" 2>/dev/null | grep -qx true; then
    HTTPS_GATEWAY_CONTAINER_RUNNING="true"
  else
    HTTPS_GATEWAY_CONTAINER_RUNNING="false"
  fi
  if [[ "$(docker inspect -f '{{.Config.Image}}' "$HTTPS_GATEWAY_CONTAINER" 2>/dev/null || true)" == "$HTTPS_GATEWAY_IMAGE" ]]; then
    HTTPS_GATEWAY_IMAGE_MATCH="true"
  else
    HTTPS_GATEWAY_IMAGE_MATCH="false"
  fi
  if [[ -f "$HTTPS_ENV_BACKUP" ]]; then HTTPS_ENV_BACKUP_PRESENT="true"; else HTTPS_ENV_BACKUP_PRESENT="false"; fi
  if curl -fsS --max-time 5 --resolve "${HTTPS_GATEWAY_HOST}:443:127.0.0.1" \
      "${HTTPS_GATEWAY_ORIGIN}/api/health" >/dev/null 2>&1; then
    HTTPS_GATEWAY_HEALTH="true"
  else
    HTTPS_GATEWAY_HEALTH="false"
  fi
  local expected_origin_digest expected_callback_digest
  expected_origin_digest="$(printf '%s' "$HTTPS_GATEWAY_ORIGIN" | sha256sum | awk '{print $1}')"
  expected_callback_digest="$(printf '%s' "$HTTPS_GATEWAY_CALLBACK" | sha256sum | awk '{print $1}')"
  if [[ "$(env_key_digest_in_container PUBLIC_APP_URL)" == "$expected_origin_digest" ]]; then HTTPS_PUBLIC_URL_MATCH="true"; else HTTPS_PUBLIC_URL_MATCH="false"; fi
  if [[ "$(env_key_digest_in_container CORS_ORIGIN)" == "$expected_origin_digest" ]]; then HTTPS_CORS_ORIGIN_MATCH="true"; else HTTPS_CORS_ORIGIN_MATCH="false"; fi
  if [[ "$(env_key_digest_in_container DINGTALK_REDIRECT_URI)" == "$expected_callback_digest" ]]; then HTTPS_DINGTALK_REDIRECT_MATCH="true"; else HTTPS_DINGTALK_REDIRECT_MATCH="false"; fi
}

resolve_staging_web_network() {
  local networks
  mapfile -t networks < <(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$WEB_CONTAINER" 2>/dev/null | sed '/^[[:space:]]*$/d' | sort -u)
  [[ "${#networks[@]}" -eq 1 ]] || fail "staging web must have exactly one Docker network for isolated HTTPS gateway (count=${#networks[@]})"
  [[ "${networks[0]}" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "staging web network name contains unsafe characters"
  printf '%s' "${networks[0]}"
}

write_https_caddyfile() {
  mkdir -p "$HTTPS_GATEWAY_PERSIST_DIR/data" "$HTTPS_GATEWAY_PERSIST_DIR/config"
  chmod 700 "$HTTPS_GATEWAY_PERSIST_DIR" "$HTTPS_GATEWAY_PERSIST_DIR/data" "$HTTPS_GATEWAY_PERSIST_DIR/config"
  local candidate="${HTTPS_GATEWAY_PERSIST_DIR}/.Caddyfile.${RUN_STAMP}.tmp"
  register_ephemeral "$candidate"
  cat >"$candidate" <<EOF
{
  auto_https disable_redirects
}

${HTTPS_GATEWAY_HOST} {
  tls {
    issuer acme {
      disable_http_challenge
    }
  }
  reverse_proxy ${WEB_CONTAINER}:80
}
EOF
  chmod 600 "$candidate"
  docker run --rm --pull never --network none \
    -v "${candidate}:/etc/caddy/Caddyfile:ro" \
    "$HTTPS_GATEWAY_IMAGE" caddy validate --config /etc/caddy/Caddyfile >/dev/null
  mv -f "$candidate" "${HTTPS_GATEWAY_PERSIST_DIR}/Caddyfile"
  chmod 600 "${HTTPS_GATEWAY_PERSIST_DIR}/Caddyfile"
}

wait_for_https_gateway() {
  local i
  for ((i = 1; i <= 45; i += 1)); do
    if curl -fsS --max-time 5 --resolve "${HTTPS_GATEWAY_HOST}:443:127.0.0.1" \
        "${HTTPS_GATEWAY_ORIGIN}/api/health" >/dev/null 2>&1; then
      if echo | openssl s_client -connect 127.0.0.1:443 -servername "$HTTPS_GATEWAY_HOST" 2>/dev/null \
          | openssl x509 -checkend 86400 -noout >/dev/null 2>&1; then
        log "HTTPS gateway health and certificate valid (attempt ${i}/45)"
        return 0
      fi
    fi
    sleep 2
  done
  echo "https_gateway_failure_class=health_or_certificate_timeout" \
    > "${OUTPUT_DIR}/https-gateway-failure.txt"
  return 1
}

require_https_live_env_matches() {
  local origin_digest callback_digest
  origin_digest="$(printf '%s' "$HTTPS_GATEWAY_ORIGIN" | sha256sum | awk '{print $1}')"
  callback_digest="$(printf '%s' "$HTTPS_GATEWAY_CALLBACK" | sha256sum | awk '{print $1}')"
  [[ "$(env_key_digest_in_container PUBLIC_APP_URL)" == "$origin_digest" ]] || fail "live PUBLIC_APP_URL does not match HTTPS gateway"
  [[ "$(env_key_digest_in_container CORS_ORIGIN)" == "$origin_digest" ]] || fail "live CORS_ORIGIN does not match HTTPS gateway"
  [[ "$(env_key_digest_in_container DINGTALK_REDIRECT_URI)" == "$callback_digest" ]] || fail "live DINGTALK_REDIRECT_URI does not match HTTPS callback"
}

require_https_live_env_matches_backup() {
  local key backup_digest live_digest
  for key in PUBLIC_APP_URL CORS_ORIGIN DINGTALK_REDIRECT_URI; do
    backup_digest="$(read_env_file_value_digest "$key" "$HTTPS_ENV_BACKUP")"
    live_digest="$(env_key_digest_in_container "$key")"
    [[ "$backup_digest" == "$live_digest" ]] \
      || fail "live ${key} does not match the pre-HTTPS backup (digest mismatch; values not printed)"
  done
}

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

  local probe count configured_present configured_count eligible_count linked ready
  probe="$(run_directory_anchor_probe)"
  count="$(parse_probe_field "$probe" active_corp_anchored_count)"
  configured_present="$(parse_probe_field "$probe" configured_corp_present)"
  configured_count="$(parse_probe_field "$probe" configured_corp_anchor_count)"
  eligible_count="$(parse_probe_field "$probe" eligible_anchor_count)"
  linked="$(parse_probe_field "$probe" linked_users)"
  ready="$(parse_probe_field "$probe" ready)"
  probe_https_gateway_status

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
    echo "schema=dingtalk-interactive-card-stream-staging-uat-status-v3"
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
    echo "configured_corp_present=${configured_present}"
    echo "configured_corp_anchor_count=${configured_count}"
    echo "eligible_anchor_count=${eligible_count}"
    echo "linked_local_users_for_eligible_anchor_count=${linked}"
    echo "single_configured_corp_eligible_anchor_ready=${ready}"
    echo "lifecycle_flags_all_off=${lifecycle}"
    echo "log_level_ready=${LOG_LEVEL_READY}"
    echo "log_level_reason=${LOG_LEVEL_REASON}"
    echo "worker_state=${worker}"
    # Never claim connected from startup logs; human U12/U13 only.
    echo "stream_connected=${STREAM_CONNECTED_UNKNOWN}"
    echo "https_port_80_listener=${HTTPS_PORT_80_LISTENER}"
    echo "https_port_443_listener=${HTTPS_PORT_443_LISTENER}"
    echo "https_port_80_docker_publishers=${HTTPS_PORT_80_DOCKER_PUBLISHERS}"
    echo "https_port_443_docker_publishers=${HTTPS_PORT_443_DOCKER_PUBLISHERS}"
    echo "https_sudo_noninteractive=${HTTPS_SUDO_NONINTERACTIVE}"
    echo "https_host_nginx_present=${HTTPS_HOST_NGINX_PRESENT}"
    echo "https_host_caddy_present=${HTTPS_HOST_CADDY_PRESENT}"
    echo "https_host_certbot_present=${HTTPS_HOST_CERTBOT_PRESENT}"
    echo "https_gateway_container_running=${HTTPS_GATEWAY_CONTAINER_RUNNING}"
    echo "https_gateway_health=${HTTPS_GATEWAY_HEALTH}"
    echo "https_gateway_image_match=${HTTPS_GATEWAY_IMAGE_MATCH}"
    echo "https_env_backup_present=${HTTPS_ENV_BACKUP_PRESENT}"
    echo "https_public_url_match=${HTTPS_PUBLIC_URL_MATCH}"
    echo "https_cors_origin_match=${HTTPS_CORS_ORIGIN_MATCH}"
    echo "https_dingtalk_redirect_match=${HTTPS_DINGTALK_REDIRECT_MATCH}"
  } > "${OUTPUT_DIR}/stream-uat-status.txt"

  {
    echo "schema=dingtalk-interactive-card-stream-staging-uat-status-v3"
    echo "action=${ACTION}"
    echo "reason=${reason}"
    echo "stream_enabled=${stream_on}"
    echo "worker_state=${worker}"
    echo "stream_connected=${STREAM_CONNECTED_UNKNOWN}"
    echo "lifecycle_flags_all_off=${lifecycle}"
    echo "configured_corp_present=${configured_present}"
    echo "eligible_anchor_count=${eligible_count}"
    echo "single_configured_corp_eligible_anchor_ready=${ready}"
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

observer_delivery_hash() {
  printf '%s' "$EXPECTED_DELIVERY_ID" | sha256sum | awk '{print $1}'
}

read_scoped_callback_counts() {
  local log_file="$1"
  local anchor_count handled_count
  anchor_count="$(grep -F 'DingTalk interactive-card callback corp anchor' "$log_file" | grep -F -c "$EXPECTED_DELIVERY_ID" || true)"
  handled_count="$(grep -F 'DingTalk interactive-card callback handled (' "$log_file" | grep -F -c "$EXPECTED_DELIVERY_ID" || true)"
  printf '%s %s\n' "$anchor_count" "$handled_count"
}

write_observer_baseline_state() {
  local delivery_hash="$1" anchor_count="$2" handled_count="$3"
  local candidate
  [[ "$delivery_hash" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$anchor_count" =~ ^[0-9]+$ && "$handled_count" =~ ^[0-9]+$ ]] || return 1
  candidate="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.callback-observer-baseline.XXXXXX")"
  register_ephemeral "$candidate"
  umask 077
  {
    echo "schema=dingtalk-interactive-card-stream-callback-baseline-v1"
    echo "delivery_id_sha256=${delivery_hash}"
    echo "callback_anchor_log_count=${anchor_count}"
    echo "callback_handled_count=${handled_count}"
  } >"$candidate"
  chmod 600 "$candidate"
  mv -f "$candidate" "$OBSERVE_BASELINE_FILE"
  chmod 600 "$OBSERVE_BASELINE_FILE"
}

read_observer_baseline_state() {
  local expected_hash="$1"
  local schema delivery_hash anchor_count handled_count
  [[ -f "$OBSERVE_BASELINE_FILE" ]] || return 1
  [[ "$(wc -l <"$OBSERVE_BASELINE_FILE" | tr -d '[:space:]')" == "4" ]] || return 1
  [[ "$(grep -F -c 'schema=' "$OBSERVE_BASELINE_FILE" || true)" == "1" ]] || return 1
  [[ "$(grep -F -c 'delivery_id_sha256=' "$OBSERVE_BASELINE_FILE" || true)" == "1" ]] || return 1
  [[ "$(grep -F -c 'callback_anchor_log_count=' "$OBSERVE_BASELINE_FILE" || true)" == "1" ]] || return 1
  [[ "$(grep -F -c 'callback_handled_count=' "$OBSERVE_BASELINE_FILE" || true)" == "1" ]] || return 1
  schema="$(awk -F= '$1 == "schema" { print $2 }' "$OBSERVE_BASELINE_FILE")"
  delivery_hash="$(awk -F= '$1 == "delivery_id_sha256" { print $2 }' "$OBSERVE_BASELINE_FILE")"
  anchor_count="$(awk -F= '$1 == "callback_anchor_log_count" { print $2 }' "$OBSERVE_BASELINE_FILE")"
  handled_count="$(awk -F= '$1 == "callback_handled_count" { print $2 }' "$OBSERVE_BASELINE_FILE")"
  [[ "$schema" == "dingtalk-interactive-card-stream-callback-baseline-v1" ]] || return 1
  [[ "$delivery_hash" == "$expected_hash" ]] || return 1
  [[ "$anchor_count" =~ ^[0-9]+$ && "$handled_count" =~ ^[0-9]+$ ]] || return 1
  printf '%s %s\n' "$anchor_count" "$handled_count"
}

action_observe_baseline() {
  assert_staging_only
  require_exact_deployed_sha "observe-baseline"
  require_lifecycle_flags_off "observe-baseline"
  require_log_level_info_or_debug "observe-baseline"
  [[ "$EXPECTED_DELIVERY_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || fail "action=observe-baseline requires expected_delivery_id as a lowercase UUID"

  local live_flag tmp delivery_hash anchor_count handled_count
  live_flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  [[ "$live_flag" == "true" ]] \
    || fail "action=observe-baseline requires live Stream ON (got stream_enabled=${live_flag})"
  tmp="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.callback-observer.XXXXXX")"
  register_ephemeral "$tmp"
  chmod 600 "$tmp"
  docker logs "$BACKEND_CONTAINER" >"$tmp" 2>&1 \
    || fail "action=observe-baseline could not read current backend container logs"
  read -r anchor_count handled_count < <(read_scoped_callback_counts "$tmp")
  delivery_hash="$(observer_delivery_hash)"
  write_observer_baseline_state "$delivery_hash" "$anchor_count" "$handled_count" \
    || fail "action=observe-baseline could not persist a valid observer checkpoint"
  rm -f "$tmp"
  {
    echo "schema=dingtalk-interactive-card-stream-callback-observer-v2"
    echo "action=observe-baseline"
    echo "reason=baseline_captured"
    echo "stream_enabled=true"
    echo "callback_anchor_log_count=${anchor_count}"
    echo "callback_handled_count=${handled_count}"
  } > "${OUTPUT_DIR}/callback-observer.txt"
  cp "${OUTPUT_DIR}/callback-observer.txt" "${OUTPUT_DIR}/summary.txt"
  log "action=observe-baseline complete; perform exactly one human callback before action=observe"
}

action_observe() {
  assert_staging_only
  require_exact_deployed_sha "observe"
  require_lifecycle_flags_off "observe"
  require_log_level_info_or_debug "observe"
  [[ "$EXPECTED_DELIVERY_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || fail "action=observe requires expected_delivery_id as a lowercase UUID"

  local live_flag
  live_flag="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  [[ "$live_flag" == "true" ]] \
    || fail "action=observe requires live Stream ON (got stream_enabled=${live_flag})"

  local tmp delivery_hash baseline_anchor_count baseline_handled_count
  local anchor_count handled_count anchor_delta handled_delta window_handler_error_count update_failed_count
  local header_present="" body_present="" handled_outcome=""
  tmp="$(mktemp "${STREAM_UAT_PERSIST_DIR}/.callback-observer.XXXXXX")"
  register_ephemeral "$tmp"
  chmod 600 "$tmp"
  docker logs "$BACKEND_CONTAINER" >"$tmp" 2>&1 \
    || fail "action=observe could not read current backend container logs"

  read -r anchor_count handled_count < <(read_scoped_callback_counts "$tmp")
  # The worker's catch log intentionally carries no delivery id. Keep it as a
  # window-level diagnostic; it must never be presented as scoped evidence for
  # EXPECTED_DELIVERY_ID.
  window_handler_error_count="$(grep -F -c 'DingTalk interactive-card callback failed (callback_handler_error)' "$tmp" || true)"
  update_failed_count="$(grep -F 'DingTalk approval-card terminal update failed (card_update_failed:' "$tmp" | grep -F -c "$EXPECTED_DELIVERY_ID" || true)"

  delivery_hash="$(observer_delivery_hash)"
  read -r baseline_anchor_count baseline_handled_count < <(read_observer_baseline_state "$delivery_hash") \
    || fail "action=observe requires a valid same-delivery checkpoint; run observe-baseline immediately before the human click"
  [[ "$anchor_count" -gt "$baseline_anchor_count" ]] \
    || fail "action=observe requires new scoped callback anchor evidence (before=${baseline_anchor_count};after=${anchor_count})"
  [[ "$handled_count" -gt "$baseline_handled_count" ]] \
    || fail "action=observe requires new scoped callback handled evidence (before=${baseline_handled_count};after=${handled_count})"
  anchor_delta=$((anchor_count - baseline_anchor_count))
  handled_delta=$((handled_count - baseline_handled_count))

  if [[ "$anchor_count" -gt 0 ]]; then
    local anchor_line
    anchor_line="$(grep -F 'DingTalk interactive-card callback corp anchor' "$tmp" | grep -F "$EXPECTED_DELIVERY_ID" | tail -n 1)"
    [[ "$anchor_line" == *'headerEventCorpIdPresent=true'* || "$anchor_line" == *'"headerEventCorpIdPresent":true'* ]] \
      && header_present="true"
    [[ "$anchor_line" == *'headerEventCorpIdPresent=false'* || "$anchor_line" == *'"headerEventCorpIdPresent":false'* ]] \
      && header_present="false"
    [[ "$anchor_line" == *'bodyCorpIdPresent=true'* || "$anchor_line" == *'"bodyCorpIdPresent":true'* ]] \
      && body_present="true"
    [[ "$anchor_line" == *'bodyCorpIdPresent=false'* || "$anchor_line" == *'"bodyCorpIdPresent":false'* ]] \
      && body_present="false"
  fi

  if [[ "$handled_count" -gt 0 ]]; then
    local handled_line
    handled_line="$(grep -F 'DingTalk interactive-card callback handled (' "$tmp" | grep -F "$EXPECTED_DELIVERY_ID" | tail -n 1)"
    case "$handled_line" in
      *'(ignored_unsupported_action out_track_id='*) handled_outcome="ignored_unsupported_action" ;;
      *'(delivery_not_found out_track_id='*) handled_outcome="delivery_not_found" ;;
      *'(executed delivery='*) handled_outcome="executed" ;;
      *'(stale delivery='*) handled_outcome="stale" ;;
      *'(operator_unresolved:'*) handled_outcome="operator_unresolved" ;;
      *'(link_secret_unavailable delivery='*) handled_outcome="link_secret_unavailable" ;;
      *'(engine_rejected:'*) handled_outcome="engine_rejected" ;;
      *'(wrapper_not_found delivery='*) handled_outcome="wrapper_not_found" ;;
      *) fail "action=observe observed callback outcome outside closed set (callback_handled_count=${handled_count})" ;;
    esac
  fi

  rm -f "$tmp"
  {
    echo "schema=dingtalk-interactive-card-stream-callback-observer-v2"
    echo "action=observe"
    echo "reason=ok"
    echo "stream_enabled=true"
    echo "callback_anchor_log_count=${anchor_count}"
    echo "callback_anchor_log_count_before=${baseline_anchor_count}"
    echo "callback_anchor_log_count_delta=${anchor_delta}"
    echo "header_event_corp_id_present=${header_present}"
    echo "body_corp_id_present=${body_present}"
    echo "callback_handled_count=${handled_count}"
    echo "callback_handled_count_before=${baseline_handled_count}"
    echo "callback_handled_count_delta=${handled_delta}"
    echo "latest_callback_outcome=${handled_outcome}"
    echo "window_callback_handler_error_count=${window_handler_error_count}"
    echo "card_update_failed_count=${update_failed_count}"
  } > "${OUTPUT_DIR}/callback-observer.txt"
  write_observer_baseline_state "$delivery_hash" "$anchor_count" "$handled_count" \
    || fail "action=observe could not advance the observer checkpoint"
  cp "${OUTPUT_DIR}/callback-observer.txt" "${OUTPUT_DIR}/summary.txt"
  log "action=observe complete (values-free callback classes only)"
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
    echo "configured_corp_present=${CONFIGURED_CORP_PRESENT}"
    echo "configured_corp_anchor_count=${CONFIGURED_CORP_ANCHOR_COUNT}"
    echo "eligible_anchor_count=${ELIGIBLE_ANCHOR_COUNT}"
    echo "linked_local_users_for_eligible_anchor_count=${ANCHOR_LINKED_USERS}"
  } >> "${OUTPUT_DIR}/summary.txt"
  log "action=prepare complete (stream forced OFF)"
}

action_on() {
  assert_staging_only
  require_compose_v2
  require_exact_deployed_sha "on"
  pin_live_backend_image_for_transition
  require_lifecycle_flags_off "on"
  require_log_level_info_or_debug "on"
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

action_https_on() {
  assert_staging_only
  require_compose_v2
  require_exact_deployed_sha "https-on"
  pin_live_backend_image_for_transition
  require_lifecycle_flags_off "https-on"
  require_staging_env_file

  local live_stream
  live_stream="$(read_flag_from_container "$FLAG_STREAM" || echo unknown)"
  [[ "$live_stream" == "false" ]] || fail "action=https-on requires Stream OFF (got ${live_stream})"
  if [[ -e "$HTTPS_ENV_BACKUP" || -e "$HTTPS_ENV_BACKUP_SHA256" ]] \
      && docker inspect "$HTTPS_GATEWAY_CONTAINER" >/dev/null 2>&1; then
    fail "managed HTTPS gateway is already active; use status or https-off"
  fi
  if [[ -e "$HTTPS_ENV_BACKUP" || -e "$HTTPS_ENV_BACKUP_SHA256" ]] \
      || docker inspect "$HTTPS_GATEWAY_CONTAINER" >/dev/null 2>&1; then
    fail "incomplete/unmanaged HTTPS gateway state; inspect backup and pinned container identity before retry"
  fi
  [[ "$(probe_tcp_listener 443)" == "false" ]] || fail "port 443 is already occupied; refuse gateway install"

  local resolved_ip
  resolved_ip="$(getent ahostsv4 "$HTTPS_GATEWAY_HOST" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  [[ "$resolved_ip" == "$HTTPS_GATEWAY_EXPECTED_IP" ]] || fail "HTTPS gateway DNS does not resolve to expected staging IP"
  command -v curl >/dev/null 2>&1 || fail "curl is required for HTTPS verification"
  command -v openssl >/dev/null 2>&1 || fail "openssl is required for certificate verification"

  local web_network
  web_network="$(resolve_staging_web_network)"
  mkdir -p "$HTTPS_GATEWAY_PERSIST_DIR"
  chmod 700 "$HTTPS_GATEWAY_PERSIST_DIR"
  arm_https_on_fail_safe_rollback
  cp -p "$STAGING_ENV_FILE" "$HTTPS_ENV_BACKUP"
  chmod 600 "$HTTPS_ENV_BACKUP"
  write_https_env_backup_checksum || fail "failed to seal pre-HTTPS env backup"

  docker pull "$HTTPS_GATEWAY_IMAGE" >/dev/null
  write_https_caddyfile
  docker run -d \
    --name "$HTTPS_GATEWAY_CONTAINER" \
    --restart unless-stopped \
    --network "$web_network" \
    -p 443:443/tcp \
    -p 443:443/udp \
    -v "${HTTPS_GATEWAY_PERSIST_DIR}/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "${HTTPS_GATEWAY_PERSIST_DIR}/data:/data" \
    -v "${HTTPS_GATEWAY_PERSIST_DIR}/config:/config" \
    "$HTTPS_GATEWAY_IMAGE" >/dev/null

  wait_for_https_gateway || fail "HTTPS gateway did not obtain a valid certificate/health response"

  atomic_upsert_env_keys_from_files \
    PUBLIC_APP_URL "@literal:${HTTPS_GATEWAY_ORIGIN}" \
    CORS_ORIGIN "@literal:${HTTPS_GATEWAY_ORIGIN}" \
    DINGTALK_REDIRECT_URI "@literal:${HTTPS_GATEWAY_CALLBACK}"
  HTTPS_ENV_WRITTEN="true"
  rm -f "${STREAM_UAT_PERSIST_DIR}/app.staging.env.backup-${RUN_STAMP}"

  recreate_backend_only || fail "backend restart failed after HTTPS env switch"
  require_exact_deployed_sha "https-on-post-restart"
  require_https_live_env_matches
  require_lifecycle_flags_off "https-on-post"
  [[ "$(read_flag_from_container "$FLAG_STREAM" || echo unknown)" == "false" ]] || fail "Stream flag changed during HTTPS transition"
  wait_for_https_gateway || fail "HTTPS gateway failed post-restart verification"

  write_status_artifact "https_on_ok"
  {
    echo "https_gateway_enabled=true"
    echo "https_certificate_valid=true"
    echo "https_env_switched=true"
    echo "stream_enabled=false"
    echo "lifecycle_flags_all_off=true"
  } >> "${OUTPUT_DIR}/summary.txt"
  disarm_https_on_fail_safe_rollback
  log "action=https-on complete (HTTPS ready; Stream/lifecycle flags remain OFF)"
}

action_https_off() {
  assert_staging_only
  require_compose_v2
  require_exact_deployed_sha "https-off"
  pin_live_backend_image_for_transition
  require_lifecycle_flags_off "https-off"
  require_staging_env_file
  [[ -f "$HTTPS_ENV_BACKUP" ]] || fail "HTTPS env backup missing; refuse ambiguous rollback"
  require_https_env_backup_integrity || fail "HTTPS env backup integrity check failed; refuse ambiguous rollback"
  [[ "$(read_flag_from_container "$FLAG_STREAM" || echo unknown)" == "false" ]] \
    || fail "action=https-off requires Stream OFF; run action=off first"

  restore_https_env_backup || fail "failed to restore pre-HTTPS staging env"
  recreate_backend_only || fail "backend restart failed after HTTPS env restore"
  require_exact_deployed_sha "https-off-post-restart"
  require_https_live_env_matches_backup
  require_lifecycle_flags_off "https-off-post"
  [[ "$(read_flag_from_container "$FLAG_STREAM" || echo unknown)" == "false" ]] \
    || fail "Stream flag changed during HTTPS rollback"
  remove_https_gateway_if_present || fail "HTTPS gateway removal failed or container still exists"
  rm -f "$HTTPS_ENV_BACKUP" "$HTTPS_ENV_BACKUP_SHA256" \
    || fail "HTTPS rollback verified but backup cleanup failed"
  write_status_artifact "https_off_ok"
  {
    echo "https_gateway_enabled=false"
    echo "https_env_restored=true"
    echo "https_legacy_backup_sealed=${HTTPS_ENV_BACKUP_LEGACY_SEALED}"
    echo "stream_enabled=false"
    echo "lifecycle_flags_all_off=true"
  } >> "${OUTPUT_DIR}/summary.txt"
  log "action=https-off complete (pre-HTTPS env restored; gateway removed)"
}

# --- main -----------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR" 2>/dev/null || true

case "$ACTION" in
  status) action_status ;;
  observe-baseline) action_observe_baseline ;;
  observe) action_observe ;;
  prepare) action_prepare ;;
  on) action_on ;;
  off) action_off ;;
  https-on) action_https_on ;;
  https-off) action_https_off ;;
  *) fail "invalid ACTION='${ACTION}' (expected status|observe-baseline|observe|prepare|on|off|https-on|https-off)" ;;
esac

log "done action=${ACTION}"
