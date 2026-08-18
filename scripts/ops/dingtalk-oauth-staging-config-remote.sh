#!/usr/bin/env bash
# Staging-only OAuth configuration for the dedicated MetaSheetCanary DingTalk app.
set -euo pipefail

log() { echo "[dingtalk-oauth-config] $*"; }
fail() { echo "[dingtalk-oauth-config][error] $*" >&2; exit 1; }

ACTION="${ACTION:?ACTION is required (status|prepare)}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
EXPECTED_CURRENT_MODE="${EXPECTED_CURRENT_MODE:-}"
CONFIRMATION="${CONFIRMATION:-}"
OUTPUT_DIR="${OUTPUT_DIR:?OUTPUT_DIR is required}"
RUN_STAMP="${RUN_STAMP:?RUN_STAMP is required}"
STAGING_DEPLOY_PATH="${STAGING_DEPLOY_PATH:-metasheet2-dingtalk-staging}"
DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
OAUTH_CLIENT_ID_FILE="${OAUTH_CLIENT_ID_FILE:-}"
OAUTH_CLIENT_SECRET_FILE="${OAUTH_CLIENT_SECRET_FILE:-}"

EXPECTED_CLIENT_ID="dingn9htcox9lc12rxmc"
EXPECTED_CORP_ID="dingd1f07b3ff4c8042cbc961a6cb783455b"
EXPECTED_APP_URL="https://metasheet-staging.ddns.net"
EXPECTED_REDIRECT_URI="${EXPECTED_APP_URL}/login/dingtalk/callback"
PREPARE_CONFIRMATION="CONFIGURE_METASHEETCANARY_OAUTH"

BACKEND_CONTAINER="metasheet-staging-backend"
WEB_CONTAINER="metasheet-staging-web"
POSTGRES_CONTAINER="metasheet-staging-postgres"
REDIS_CONTAINER="metasheet-staging-redis"
HEALTH_URL="http://127.0.0.1:18900/health"
FLAG_ALIAS="AUTH_LOGIN_USE_ALIASES"
FLAG_PENDING="DIRECTORY_PENDING_ACTIVATION_ENABLED"
FLAG_DEPROVISION="DIRECTORY_DEPROVISION_ENABLED"

resolve_home_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    ~/*) printf '%s' "${HOME}/${1#\~/}" ;;
    *) printf '%s' "${HOME}/$1" ;;
  esac
}

STAGING_DIR="$(resolve_home_path "$STAGING_DEPLOY_PATH")"
PROD_REPO_DIR="$(resolve_home_path "$DEPLOY_PATH")"
STAGING_ENV_FILE="${STAGING_DIR}/docker/app.staging.env"
LEGACY_COMPOSE_FILE="${STAGING_DIR}/docker-compose.app.staging.yml"
ATTENDANCE_DIR="${HOME}/.metasheet2/window-runner"
PERSISTENT_COMPOSE_FILE="${ATTENDANCE_DIR}/docker-compose.app.staging.yml"
ATTENDANCE_OVERRIDE_FILE="${ATTENDANCE_DIR}/docker-compose.window-runner.override.yml"
ATTENDANCE_DEPLOY_IDENTITY_FILE="${ATTENDANCE_DIR}/deploy-identity.env"
LIFECYCLE_OVERRIDE_FILE="${HOME}/.metasheet2/lifecycle-canary/docker-compose.lifecycle-canary.override.yml"
PERSIST_DIR="${HOME}/.metasheet2/dingtalk-oauth-config"
STAGING_COMPOSE_FILE="$LEGACY_COMPOSE_FILE"
[[ -f "$PERSISTENT_COMPOSE_FILE" ]] && STAGING_COMPOSE_FILE="$PERSISTENT_COMPOSE_FILE"

cleanup_files=()
cleanup() {
  local path
  for path in "${cleanup_files[@]:-}"; do rm -f "$path"; done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

assert_staging_only() {
  [[ -d "$STAGING_DIR" && -f "$STAGING_COMPOSE_FILE" && -f "$STAGING_ENV_FILE" ]] \
    || fail "staging stack/env is missing; refusing to guess"
  [[ "$STAGING_DIR" != "$PROD_REPO_DIR" ]] || fail "staging path equals production path"
  grep -q "container_name: ${BACKEND_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "staging backend container is not declared"
  grep -q "container_name: ${WEB_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "staging web container is not declared"
  grep -q "container_name: ${POSTGRES_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "staging postgres container is not declared"
  grep -q "container_name: ${REDIS_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "staging redis container is not declared"
}

is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

container_value() {
  docker exec "$BACKEND_CONTAINER" sh -c 'printenv "$1" 2>/dev/null || true' sh "$1" 2>/dev/null || true
}

value_matches() {
  [[ "$(container_value "$1")" == "$2" ]] && printf true || printf false
}

secret_present() {
  [[ -n "$(container_value "$1")" ]] && printf true || printf false
}

container_secret_matches_file() {
  local key="$1" expected_file="$2" live_value live_digest expected_digest
  # Command substitution removes printenv's trailing newline. Hash the exact env
  # value bytes, matching the newline-free chmod-600 secret file.
  live_value="$(container_value "$key")"
  live_digest="$(printf '%s' "$live_value" | sha256sum | awk '{print $1}')"
  expected_digest="$(sha256sum "$expected_file" | awk '{print $1}')"
  [[ -n "$live_value" && "$live_digest" == "$expected_digest" ]]
}

lifecycle_all_off() {
  local key value
  for key in "$FLAG_ALIAS" "$FLAG_PENDING" "$FLAG_DEPROVISION"; do
    value="$(container_value "$key")"
    if is_true "$value"; then printf false; return; fi
  done
  printf true
}

backend_health() {
  local body
  body="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || true)"
  printf '%s' "$body" | python3 -c 'import json,sys
try:
 d=json.load(sys.stdin); print("true" if d.get("ok") is True or d.get("status")=="ok" else "false")
except Exception: print("false")'
}

health_commit() {
  curl -fsS --max-time 10 "http://127.0.0.1:8082/api/health" 2>/dev/null \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("build",{}).get("commit",""))
except Exception: print("")' || true
}

deployed_sha() {
  local image image_sha="" http_sha image_pin=""
  image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  [[ "$image" =~ :([0-9a-f]{40})$ ]] && image_sha="${BASH_REMATCH[1]}"
  if [[ "$image" == *@sha256:* ]]; then
    if image_pin="$(resolve_live_backend_image_pin)"; then
      read -r _ image_sha <<< "$image_pin"
      printf '%s' "$image_sha"
    else
      printf unknown
    fi
    return 0
  fi
  http_sha="$(health_commit)"
  if [[ "$image_sha" =~ ^[0-9a-f]{40}$ && "$http_sha" == "$image_sha" ]]; then
    printf '%s' "$image_sha"
  elif [[ -n "$image_sha" && -n "$http_sha" ]]; then
    printf conflict
  else
    printf unknown
  fi
}

write_status() {
  local reason="$1" live_sha sha_match=false
  live_sha="$(deployed_sha)"
  [[ -n "$DEPLOY_SHA" && "$live_sha" == "$DEPLOY_SHA" ]] && sha_match=true
  {
    echo "schema=dingtalk-oauth-staging-config-v1"
    echo "action=${ACTION}"
    echo "reason=${reason}"
    echo "deployed_sha=${live_sha}"
    echo "deployed_sha_match=${sha_match}"
    echo "backend_health=$(backend_health)"
    echo "lifecycle_flags_all_off=$(lifecycle_all_off)"
    echo "client_id_matches=$(value_matches DINGTALK_CLIENT_ID "$EXPECTED_CLIENT_ID")"
    echo "client_secret_present=$(secret_present DINGTALK_CLIENT_SECRET)"
    echo "corp_id_matches=$(value_matches DINGTALK_CORP_ID "$EXPECTED_CORP_ID")"
    echo "redirect_uri_matches=$(value_matches DINGTALK_REDIRECT_URI "$EXPECTED_REDIRECT_URI")"
    echo "public_app_url_matches=$(value_matches PUBLIC_APP_URL "$EXPECTED_APP_URL")"
    echo "cors_origin_matches=$(value_matches CORS_ORIGIN "$EXPECTED_APP_URL")"
  } > "${OUTPUT_DIR}/status.txt"
  cp "${OUTPUT_DIR}/status.txt" "${OUTPUT_DIR}/summary.txt"
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
  local image image_owner recorded_sha recorded_digest
  image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  if [[ "$image" =~ ^ghcr\.io/([A-Za-z0-9._-]+)/metasheet2-backend:([0-9a-f]{40})$ ]]; then
    printf '%s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi
  if [[ "$image" =~ ^ghcr\.io/([A-Za-z0-9._-]+)/metasheet2-backend@sha256:[0-9a-f]{64}$ ]]; then
    image_owner="${BASH_REMATCH[1]}"
    recorded_sha="$(read_attendance_deploy_identity_field deploy_sha)" || return 1
    recorded_digest="$(read_attendance_deploy_identity_field backend_digest)" || return 1
    [[ "$recorded_sha" =~ ^[0-9a-f]{40}$ && "$recorded_digest" == "$image" ]] || return 1
    [[ -f "$ATTENDANCE_OVERRIDE_FILE" ]] || return 1
    grep -Fqx "    image: ${recorded_digest}" "$ATTENDANCE_OVERRIDE_FILE" || return 1
    printf '%s %s' "$image_owner" "$recorded_sha"
    return 0
  fi
  return 1
}

resolve_image_pin() {
  resolve_live_backend_image_pin \
    || fail "backend image lacks an exact full-SHA tag or matching immutable deploy identity"
}

compose_with_env() {
  local env_file="$1"; shift
  local owner tag pin
  pin="$(resolve_image_pin)"; read -r owner tag <<< "$pin"
  local -a files=(-f "$STAGING_COMPOSE_FILE")
  [[ -f "$ATTENDANCE_OVERRIDE_FILE" ]] && files+=(-f "$ATTENDANCE_OVERRIDE_FILE")
  [[ -f "$LIFECYCLE_OVERRIDE_FILE" ]] && files+=(-f "$LIFECYCLE_OVERRIDE_FILE")
  (cd "$STAGING_DIR" && IMAGE_OWNER="$owner" IMAGE_TAG="$tag" APP_ENV_FILE="$env_file" \
    docker compose --project-directory "$STAGING_DIR" --env-file "$env_file" "${files[@]}" "$@")
}

atomic_install_env() {
  local candidate="$1" target_dir target_name uid gid image tmp_name
  target_dir="$(dirname "$STAGING_ENV_FILE")"; target_name="$(basename "$STAGING_ENV_FILE")"
  uid="$(stat -c '%u' "$STAGING_ENV_FILE")"; gid="$(stat -c '%g' "$STAGING_ENV_FILE")"
  image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")"
  tmp_name=".${target_name}.oauth-${RUN_STAMP}.tmp"
  timeout 30s docker run --rm --pull never --network none --entrypoint /bin/sh \
    --mount "type=bind,src=${candidate},dst=/candidate,readonly" \
    --mount "type=bind,src=${target_dir},dst=/target" \
    -e TARGET_NAME="$target_name" -e TMP_NAME="$tmp_name" -e TARGET_UID="$uid" -e TARGET_GID="$gid" \
    "$image" -c 'set -eu; umask 077; trap '\''rm -f "/target/${TMP_NAME}"'\'' EXIT; cp /candidate "/target/${TMP_NAME}"; chown "${TARGET_UID}:${TARGET_GID}" "/target/${TMP_NAME}"; chmod 600 "/target/${TMP_NAME}"; mv -f "/target/${TMP_NAME}" "/target/${TARGET_NAME}"; trap - EXIT' >/dev/null \
    || fail "atomic env install failed; previous env retained"
  rm -f "$candidate"
}

build_candidate() {
  local destination="$1"
  python3 - "$STAGING_ENV_FILE" "$destination" "$OAUTH_CLIENT_ID_FILE" "$OAUTH_CLIENT_SECRET_FILE" <<'PY'
import os, sys
src, dst, cid_path, secret_path = sys.argv[1:]
def read(path):
    with open(path, encoding="utf-8") as fh:
        value=fh.read().rstrip("\r\n")
    if not value or any(ord(c)<32 for c in value): raise SystemExit("invalid secret file")
    return value
updates={
 "DINGTALK_CLIENT_ID": read(cid_path), "DINGTALK_CLIENT_SECRET": read(secret_path),
 "DINGTALK_CORP_ID": "dingd1f07b3ff4c8042cbc961a6cb783455b",
 "DINGTALK_REDIRECT_URI": "https://metasheet-staging.ddns.net/login/dingtalk/callback",
 "PUBLIC_APP_URL": "https://metasheet-staging.ddns.net", "CORS_ORIGIN": "https://metasheet-staging.ddns.net",
 "AUTH_LOGIN_USE_ALIASES": "false", "DIRECTORY_PENDING_ACTIVATION_ENABLED": "false",
 "DIRECTORY_DEPROVISION_ENABLED": "false",
}
lines=open(src, encoding="utf-8", errors="replace").read().splitlines(); out=[]; seen=set()
for line in lines:
    key=line.split("=",1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else ""
    if key in updates: out.append(f"{key}={updates[key]}"); seen.add(key)
    else: out.append(line)
for key,value in updates.items():
    if key not in seen: out.append(f"{key}={value}")
with open(dst,"w",encoding="utf-8") as fh: fh.write("\n".join(out)+"\n")
os.chmod(dst,0o600)
PY
}

restart_backend() {
  local pg_before redis_before web_before pg_after redis_after web_after i
  pg_before="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")"
  redis_before="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")"
  web_before="$(docker inspect -f '{{.Id}}' "$WEB_CONTAINER")"
  compose_with_env "$STAGING_ENV_FILE" up -d --no-deps --force-recreate backend \
    > "${OUTPUT_DIR}/compose-up-backend.log" 2>&1 || return 1
  pg_after="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)"
  redis_after="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER" 2>/dev/null || true)"
  web_after="$(docker inspect -f '{{.Id}}' "$WEB_CONTAINER" 2>/dev/null || true)"
  [[ "$pg_before" == "$pg_after" && "$redis_before" == "$redis_after" && "$web_before" == "$web_after" ]] || return 1
  for ((i=1; i<=30; i+=1)); do
    [[ "$(backend_health)" == true ]] && return 0
    sleep 2
  done
  return 1
}

require_secret_file() {
  [[ -f "$1" && ! -L "$1" && -s "$1" ]] || fail "$2 secret file is missing"
  [[ "$(stat -c '%a' "$1")" == 600 ]] || fail "$2 secret file must have mode 600"
}

action_prepare() {
  [[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "prepare requires a full deploy SHA"
  [[ "$EXPECTED_CURRENT_MODE" == off ]] || fail "prepare requires expected_current_mode=off"
  [[ "$CONFIRMATION" == "$PREPARE_CONFIRMATION" ]] || fail "prepare confirmation mismatch"
  [[ "$(deployed_sha)" == "$DEPLOY_SHA" ]] || fail "deployed SHA does not match"
  [[ "$(lifecycle_all_off)" == true ]] || fail "all lifecycle flags must be OFF"
  [[ "$(backend_health)" == true ]] || fail "backend is not healthy"
  require_secret_file "$OAUTH_CLIENT_ID_FILE" client_id
  require_secret_file "$OAUTH_CLIENT_SECRET_FILE" client_secret
  [[ "$(<"$OAUTH_CLIENT_ID_FILE")" == "$EXPECTED_CLIENT_ID" ]] || fail "client_id is not MetaSheetCanary"

  mkdir -p "$PERSIST_DIR"; chmod 700 "$PERSIST_DIR"
  local candidate backup
  candidate="$(mktemp "${PERSIST_DIR}/.app.staging.env.XXXXXX")"; cleanup_files+=("$candidate")
  backup="${PERSIST_DIR}/app.staging.env.backup-${RUN_STAMP}"
  build_candidate "$candidate"
  compose_with_env "$candidate" config >/dev/null 2>&1 || fail "candidate env failed compose validation"
  cp -p "$STAGING_ENV_FILE" "$backup"; chmod 600 "$backup"
  atomic_install_env "$candidate"

  if ! restart_backend \
    || [[ "$(deployed_sha)" != "$DEPLOY_SHA" ]] \
    || [[ "$(lifecycle_all_off)" != true ]] \
    || [[ "$(backend_health)" != true ]] \
    || [[ "$(value_matches DINGTALK_CLIENT_ID "$EXPECTED_CLIENT_ID")" != true ]] \
    || ! container_secret_matches_file DINGTALK_CLIENT_SECRET "$OAUTH_CLIENT_SECRET_FILE" \
    || [[ "$(value_matches DINGTALK_CORP_ID "$EXPECTED_CORP_ID")" != true ]] \
    || [[ "$(value_matches DINGTALK_REDIRECT_URI "$EXPECTED_REDIRECT_URI")" != true ]] \
    || [[ "$(value_matches PUBLIC_APP_URL "$EXPECTED_APP_URL")" != true ]] \
    || [[ "$(value_matches CORS_ORIGIN "$EXPECTED_APP_URL")" != true ]]; then
    log "post-write verification failed; restoring previous env"
    local rollback
    rollback="$(mktemp "${PERSIST_DIR}/.rollback.XXXXXX")"; cleanup_files+=("$rollback")
    cp "$backup" "$rollback"; chmod 600 "$rollback"; atomic_install_env "$rollback"
    if restart_backend; then
      write_status rollback_restored
      fail "prepare failed; previous env and healthy backend were restored"
    fi
    write_status rollback_backend_unhealthy
    fail "prepare failed; previous env was restored on disk but backend health was not recovered"
  fi
  write_status configured
  log "MetaSheetCanary OAuth configured; lifecycle flags remain OFF"
}

mkdir -p "$OUTPUT_DIR"
assert_staging_only
case "$ACTION" in
  status) write_status ok ;;
  prepare) action_prepare ;;
  *) fail "invalid action: ${ACTION}" ;;
esac
