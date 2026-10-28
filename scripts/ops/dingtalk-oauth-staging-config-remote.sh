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
STAGING_ENV_FILE=""
LEGACY_COMPOSE_FILE="${STAGING_DIR}/docker-compose.app.staging.yml"
ATTENDANCE_DIR="${HOME}/.metasheet2/window-runner"
PERSISTENT_COMPOSE_FILE="${ATTENDANCE_DIR}/docker-compose.app.staging.yml"
ATTENDANCE_OVERRIDE_FILE="${ATTENDANCE_DIR}/docker-compose.window-runner.override.yml"
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
  [[ -d "$STAGING_DIR" && -f "$STAGING_COMPOSE_FILE" ]] \
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
  local image image_sha="" http_sha
  image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  [[ "$image" =~ :([0-9a-f]{40})$ ]] && image_sha="${BASH_REMATCH[1]}"
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
    echo "stream_flag_off=$(if is_true "$(container_value DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED)"; then printf false; else printf true; fi)"
    echo "client_id_matches=$(value_matches DINGTALK_CLIENT_ID "$EXPECTED_CLIENT_ID")"
    echo "client_secret_present=$(secret_present DINGTALK_CLIENT_SECRET)"
    echo "corp_id_matches=$(value_matches DINGTALK_CORP_ID "$EXPECTED_CORP_ID")"
    echo "redirect_uri_matches=$(value_matches DINGTALK_REDIRECT_URI "$EXPECTED_REDIRECT_URI")"
    echo "public_app_url_matches=$(value_matches PUBLIC_APP_URL "$EXPECTED_APP_URL")"
    echo "cors_origin_matches=$(value_matches CORS_ORIGIN "$EXPECTED_APP_URL")"
  } > "${OUTPUT_DIR}/status.txt"
  cp "${OUTPUT_DIR}/status.txt" "${OUTPUT_DIR}/summary.txt"
}

resolve_image_pin() {
  local image
  image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  [[ "$image" =~ ^ghcr\.io/([A-Za-z0-9._-]+)/metasheet2-backend:([0-9a-f]{40})$ ]] \
    || fail "backend image is not pinned to a full SHA"
  printf '%s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
}

# Resolve the running container's Compose inputs instead of guessing an env path.
ACTIVE_COMPOSE_ARGS=()
ACTIVE_COMPOSE_JSON=""
ACTIVE_RENDERED_JSON=""

compose_current() {
  local owner tag pin
  pin="$(resolve_image_pin)"; read -r owner tag <<< "$pin"
  (cd "$STAGING_DIR" && unset APP_ENV_FILE && IMAGE_OWNER="$owner" IMAGE_TAG="$tag" \
    docker compose "${ACTIVE_COMPOSE_ARGS[@]}" "$@")
}

# Interpolated config output doubles literal dollars for Compose round-tripping.
# Decode that representation once before comparing it with actual container bytes.
compose_json() {
  compose_current config --format json "$@" \
    | python3 -c 'import sys; sys.stdout.write(sys.stdin.read().replace("$$", "$"))'
}

# Compose 2.x discards env_file even with --no-env-resolution unless interpolation
# is disabled. Recover its source paths with a temporary label probe: Compose itself
# still performs interpolation using the original project's inputs.
recover_compose_sources() {
  local raw="$1" rendered="$2" unresolved probe mapping resolved
  unresolved="$(mktemp "${PERSIST_DIR}/.compose-unresolved.XXXXXX")"
  probe="$(mktemp "${PERSIST_DIR}/.compose-probe.XXXXXX")"
  mapping="$(mktemp "${PERSIST_DIR}/.compose-mapping.XXXXXX")"
  resolved="$(mktemp "${PERSIST_DIR}/.compose-probed.XXXXXX")"
  cleanup_files+=("$unresolved" "$probe" "$mapping" "$resolved")
  compose_current config --no-interpolate --no-env-resolution --no-path-resolution --format json \
    > "$unresolved" 2>/dev/null || return 1
  python3 - "$unresolved" "$probe" "$mapping" <<'PY'
import json, sys
source, probe, mapping = sys.argv[1:]
services = {}
entries = []
for name, service in json.load(open(source))["services"].items():
    for field in ("env_file", "label_file"):
        for entry in service.get(field, []) or []:
            value = dict(entry) if isinstance(entry, dict) else {"path": entry}
            if not isinstance(value.get("path"), str):
                raise SystemExit(1)
            key = "io.metasheet.oauth-source-" + str(len(entries))
            services.setdefault(name, {"labels": {}})["labels"][key] = value["path"]
            entries.append({"service": name, "field": field, "entry": value, "key": key})
if not entries:
    raise SystemExit(1)
with open(probe, "w") as fh:
    json.dump({"services": services}, fh)
with open(mapping, "w") as fh:
    json.dump(entries, fh)
PY
  (ACTIVE_COMPOSE_ARGS=("${ACTIVE_COMPOSE_ARGS[@]}" -f "$probe"); compose_json) \
    > "$resolved" 2>/dev/null || return 1
  python3 - "$rendered" "$resolved" "$mapping" "$raw" "$STAGING_DIR" <<'PY'
import json, os, sys
baseline, probed, mapping, destination, directory = sys.argv[1:]
model = json.load(open(baseline))
probe = json.load(open(probed))
entries = json.load(open(mapping))
for service in model["services"].values():
    service.pop("env_file", None)
    service.pop("label_file", None)
for item in entries:
    value = item["entry"]
    path = probe["services"][item["service"]]["labels"][item["key"]]
    if not isinstance(path, str):
        raise SystemExit(1)
    if path.startswith("~/"):
        path = os.path.expanduser(path)
    value["path"] = os.path.abspath(os.path.join(directory, path))
    model["services"][item["service"]].setdefault(item["field"], []).append(value)
with open(destination, "w") as fh:
    json.dump(model, fh)
PY
}

resolve_active_env() {
  local working_dir project files env_files file raw live image_env
  working_dir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$BACKEND_CONTAINER")"
  project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$BACKEND_CONTAINER")"
  files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$BACKEND_CONTAINER")"
  env_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.environment_file" }}' "$BACKEND_CONTAINER")"
  [[ -d "$working_dir" && "$(cd "$working_dir" && pwd -P)" == "$(cd "$STAGING_DIR" && pwd -P)" ]] \
    || fail "active Compose working directory does not match staging"
  [[ -n "$project" && "$project" != "<no value>" && -n "$files" && "$files" != "<no value>" ]] \
    || fail "active Compose labels are missing"
  ACTIVE_COMPOSE_ARGS=(--project-directory "$STAGING_DIR" --project-name "$project")
  local -a paths=()
  IFS=',' read -r -a paths <<< "$files"
  for file in "${paths[@]}"; do
    [[ "$file" == /* && -f "$file" ]] || fail "active Compose file is unavailable"
    ACTIVE_COMPOSE_ARGS+=(-f "$file")
  done
  if [[ -n "$env_files" && "$env_files" != "<no value>" ]]; then
    IFS=',' read -r -a paths <<< "$env_files"
    for file in "${paths[@]}"; do
      [[ "$file" == /* && -f "$file" ]] || fail "active Compose interpolation env is unavailable"
      ACTIVE_COMPOSE_ARGS+=(--env-file "$file")
    done
  fi
  raw="$(mktemp "${PERSIST_DIR}/.compose-source.XXXXXX")"
  ACTIVE_COMPOSE_JSON="$raw"; cleanup_files+=("$raw")
  ACTIVE_RENDERED_JSON="$(mktemp "${PERSIST_DIR}/.compose-rendered.XXXXXX")"
  live="$(mktemp "${PERSIST_DIR}/.live-env.XXXXXX")"
  image_env="$(mktemp "${PERSIST_DIR}/.image-env.XXXXXX")"
  cleanup_files+=("$ACTIVE_RENDERED_JSON" "$live" "$image_env")
  compose_json --no-env-resolution > "$raw" 2>/dev/null \
    || fail "cannot resolve active Compose env source"
  compose_json > "$ACTIVE_RENDERED_JSON" 2>/dev/null \
    || fail "cannot render active Compose environment"
  if ! python3 - "$raw" <<'PY'
import json, sys
raise SystemExit(0 if "env_file" in json.load(open(sys.argv[1]))["services"]["backend"] else 1)
PY
  then
    recover_compose_sources "$raw" "$ACTIVE_RENDERED_JSON" 2>/dev/null \
      || fail "cannot recover active Compose source metadata"
  fi
  docker inspect -f '{{json .Config.Env}}' "$BACKEND_CONTAINER" > "$live"
  docker image inspect -f '{{json .Config.Env}}' "$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")" > "$image_env"
  STAGING_ENV_FILE="$(python3 - "$raw" "$ACTIVE_RENDERED_JSON" "$live" "$image_env" 2>/dev/null <<'PY'
import json, os, sys
raw, rendered, live, image = (json.load(open(p)) for p in sys.argv[1:])
backend = raw["services"]["backend"]
if backend.get("container_name") != "metasheet-staging-backend":
    raise SystemExit(1)
sources = backend.get("env_file", [])
if len(sources) != 1:
    raise SystemExit(1)
source = sources[0].get("path") if isinstance(sources[0], dict) else sources[0]
if not isinstance(source, str) or not os.path.isabs(source) or not os.path.isfile(source) or os.path.islink(source) or "\n" in source:
    raise SystemExit(1)
for service in raw["services"].values():
    for label_file in service.get("label_file", []):
        path = label_file.get("path") if isinstance(label_file, dict) else label_file
        if isinstance(path, str) and os.path.isfile(path) and os.path.samefile(path, source):
            raise SystemExit(1)
def env(items):
    return dict(item.split("=", 1) for item in (items or []))
expected = env(image)
for key, value in rendered["services"]["backend"].get("environment", {}).items():
    if value is None:
        expected.pop(key, None)
    else:
        expected[key] = str(value)
if expected != env(live):
    raise SystemExit(1)
print(source)
PY
  )" || fail "active env source is ambiguous or differs from running configuration"
}

compose_with_env() {
  local env_file="$1"; shift
  if [[ "$env_file" == "$STAGING_ENV_FILE" ]]; then
    compose_current "$@"
    return
  fi
  # Substitute every env_file consumer; reject effects outside backend environment.
  [[ $# == 1 && "$1" == config ]] || fail "candidate Compose operation is not validation"
  local model rendered
  model="$(mktemp "${PERSIST_DIR}/.candidate-compose.XXXXXX")"
  rendered="$(mktemp "${PERSIST_DIR}/.candidate-rendered.XXXXXX")"
  cleanup_files+=("$model" "$rendered")
  python3 - "$ACTIVE_COMPOSE_JSON" "$model" "$env_file" "$STAGING_ENV_FILE" <<'PY'
import json, os, sys
source, destination, candidate, active = sys.argv[1:]
model = json.load(open(source))
with open(destination, "w") as fh:
    fh.write("services:\n")
    for name, service in model["services"].items():
        entries = service.get("env_file", [])
        replaced = []
        changed = False
        for entry in entries:
            value = dict(entry) if isinstance(entry, dict) else {"path": entry}
            path = value.get("path")
            if isinstance(path, str) and os.path.isfile(path) and os.path.samefile(path, active):
                value["path"] = candidate
                changed = True
            replaced.append(value)
        if changed:
            fh.write("  " + json.dumps(name) + ":\n    env_file: !override " + json.dumps(replaced) + "\n")

PY
  local -a candidate_args=("${ACTIVE_COMPOSE_ARGS[@]}")
  local i explicit_env=false
  for ((i=1; i<${#candidate_args[@]}; i+=1)); do
    if [[ "${candidate_args[i-1]}" == --env-file ]]; then
      explicit_env=true
      [[ ! "${candidate_args[i]}" -ef "$STAGING_ENV_FILE" ]] || candidate_args[i]="$env_file"
    fi
  done
  if [[ "$explicit_env" == false && "$STAGING_ENV_FILE" -ef "${STAGING_DIR}/.env" ]]; then
    candidate_args+=(--env-file "$env_file")
  fi
  (ACTIVE_COMPOSE_ARGS=("${candidate_args[@]}" -f "$model"); compose_json) \
    > "$rendered" 2>/dev/null || return 1
  python3 - "$ACTIVE_RENDERED_JSON" "$rendered" "$OAUTH_CLIENT_ID_FILE" "$OAUTH_CLIENT_SECRET_FILE" \
    "$EXPECTED_CORP_ID" "$EXPECTED_REDIRECT_URI" "$EXPECTED_APP_URL" <<'PY'
import json, sys
before, after, cid, secret, corp, redirect, app = sys.argv[1:]
expected = json.load(open(before))
expected["services"]["backend"].setdefault("environment", {}).update({
    "DINGTALK_CLIENT_ID": open(cid).read().rstrip("\r\n"),
    "DINGTALK_CLIENT_SECRET": open(secret).read().rstrip("\r\n"),
    "DINGTALK_CORP_ID": corp, "DINGTALK_REDIRECT_URI": redirect,
    "PUBLIC_APP_URL": app, "CORS_ORIGIN": app,
    "AUTH_LOGIN_USE_ALIASES": "false", "DIRECTORY_PENDING_ACTIVATION_ENABLED": "false",
    "DIRECTORY_DEPROVISION_ENABLED": "false", "DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED": "false",
})
actual = json.load(open(after))
if actual != expected:
    raise SystemExit("candidate changes unrelated configuration or target values are overridden")
PY
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
 "DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED": "false",
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
  ! is_true "$(container_value DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED)" || fail "Stream must be OFF"
  require_secret_file "$OAUTH_CLIENT_ID_FILE" client_id
  require_secret_file "$OAUTH_CLIENT_SECRET_FILE" client_secret
  [[ "$(<"$OAUTH_CLIENT_ID_FILE")" == "$EXPECTED_CLIENT_ID" ]] || fail "client_id is not MetaSheetCanary"

  umask 077
  mkdir -p "$PERSIST_DIR"; chmod 700 "$PERSIST_DIR"
  resolve_active_env
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
    || is_true "$(container_value DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED)" \
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
