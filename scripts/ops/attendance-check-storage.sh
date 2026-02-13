#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.app.yml}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"

MAX_FS_USED_PCT="${MAX_FS_USED_PCT:-90}"
MAX_UPLOAD_DIR_GB="${MAX_UPLOAD_DIR_GB:-10}"
MAX_OLDEST_FILE_DAYS="${MAX_OLDEST_FILE_DAYS:-14}"

function die() {
  echo "[attendance-storage] ERROR: $*" >&2
  exit 1
}

function warn() {
  echo "[attendance-storage] WARN: $*" >&2
}

function info() {
  echo "[attendance-storage] $*" >&2
}

function get_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo ""
    return 0
  fi
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  echo "${line#${key}=}"
}

function strip_quotes() {
  local value="$1"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    echo "${value:1:${#value}-2}"
    return 0
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    echo "${value:1:${#value}-2}"
    return 0
  fi
  echo "$value"
}

function is_integer() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

if ! is_integer "$MAX_FS_USED_PCT"; then
  die "MAX_FS_USED_PCT must be an integer (got: '${MAX_FS_USED_PCT}')"
fi
if ! is_integer "$MAX_UPLOAD_DIR_GB"; then
  die "MAX_UPLOAD_DIR_GB must be an integer (got: '${MAX_UPLOAD_DIR_GB}')"
fi
if ! is_integer "$MAX_OLDEST_FILE_DAYS"; then
  die "MAX_OLDEST_FILE_DAYS must be an integer (got: '${MAX_OLDEST_FILE_DAYS}')"
fi

[[ -f "$COMPOSE_FILE" ]] || die "Compose file not found: ${COMPOSE_FILE}"
[[ -f "$ENV_FILE" ]] || die "Env file not found: ${ENV_FILE}"

UPLOAD_DIR="$(get_env_value ATTENDANCE_IMPORT_UPLOAD_DIR)"
UPLOAD_DIR="$(strip_quotes "${UPLOAD_DIR:-}")"
if [[ -z "$UPLOAD_DIR" ]]; then
  UPLOAD_DIR="/app/uploads/attendance-import"
  warn "ATTENDANCE_IMPORT_UPLOAD_DIR missing in ${ENV_FILE}; using default: ${UPLOAD_DIR}"
fi

info "Repo root: ${ROOT_DIR}"
info "Compose:   ${COMPOSE_FILE}"
info "Env file:  ${ENV_FILE}"
info "Upload dir (container): ${UPLOAD_DIR}"
info "Thresholds: max_fs_used_pct=${MAX_FS_USED_PCT} max_upload_dir_gb=${MAX_UPLOAD_DIR_GB} max_oldest_file_days=${MAX_OLDEST_FILE_DAYS}"

volume_line="$(
  grep -E "^[[:space:]]*-[[:space:]]*[^#]*:[[:space:]]*${UPLOAD_DIR}([[:space:]]|$|:)" "$COMPOSE_FILE" \
    | head -n 1 \
    || true
)"
[[ -n "$volume_line" ]] || die "Volume mount for upload dir not found in compose (expected a line like '- <SOURCE>:${UPLOAD_DIR}')"

volume_spec="$(echo "$volume_line" | sed -E 's/^[[:space:]]*-[[:space:]]*//')"
volume_spec="$(strip_quotes "$volume_spec")"
volume_src="${volume_spec%%:*}"
[[ -n "$volume_src" ]] || die "Failed to parse volume source from: ${volume_spec}"

info "Volume spec: ${volume_spec}"
info "Volume src:  ${volume_src}"

compose_dir="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"
mountpoint=""
is_named_volume="false"

if [[ "$volume_src" == /* || "$volume_src" == ./* || "$volume_src" == ../* || "$volume_src" == *"/"* || "$volume_src" == "~/"* ]]; then
  # Bind mount path.
  bind_path="$volume_src"
  if [[ "$bind_path" == "~/"* ]]; then
    bind_path="${HOME}/${bind_path#~/}"
  fi
  if [[ "$bind_path" != /* ]]; then
    bind_path="${compose_dir}/${bind_path}"
  fi
  if command -v realpath >/dev/null 2>&1; then
    bind_path="$(realpath "$bind_path" 2>/dev/null || echo "$bind_path")"
  fi
  mountpoint="$bind_path"
else
  # Named docker volume.
  is_named_volume="true"
  resolved_volume_name="$volume_src"
  inspect_err_1=""
  inspect_err_2=""
  if ! mountpoint="$(docker volume inspect "$volume_src" --format '{{.Mountpoint}}' 2>&1)"; then
    inspect_err_1="$mountpoint"
    mountpoint=""
  fi

  # Compose usually prefixes named volumes with the project name unless `volumes.<key>.name`
  # is explicitly set. Fall back to "<project>_<key>" to locate the actual docker volume.
  prefixed_name=""
  if [[ -z "$mountpoint" ]]; then
    project_name="${COMPOSE_PROJECT_NAME:-$(basename "$compose_dir")}"
    prefixed_name="${project_name}_${volume_src}"
    if ! mountpoint="$(docker volume inspect "$prefixed_name" --format '{{.Mountpoint}}' 2>&1)"; then
      inspect_err_2="$mountpoint"
      mountpoint=""
    else
      resolved_volume_name="$prefixed_name"
      info "Resolved compose-prefixed volume: ${prefixed_name}"
    fi
  fi

  if [[ -z "$mountpoint" ]]; then
    err="$(echo "${inspect_err_2:-$inspect_err_1}" | tr -d '\r' | head -n 1)"
    if [[ -n "$prefixed_name" ]]; then
      die "docker volume inspect failed for '${volume_src}' (also tried '${prefixed_name}'): ${err}"
    fi
    die "docker volume inspect failed for '${volume_src}': ${err}"
  fi
fi

[[ -n "$mountpoint" ]] || die "Failed to resolve host mountpoint for: ${volume_src}"

use_backend_exec="false"
target_path="$mountpoint"

if [[ "$is_named_volume" == "true" ]] && [[ ! -d "$mountpoint" ]]; then
  warn "Resolved mountpoint is not accessible as a directory: ${mountpoint} (falling back to docker compose exec into backend)"
  use_backend_exec="true"
  target_path="$UPLOAD_DIR"
fi

if [[ "$use_backend_exec" == "true" ]]; then
  info "Stats source: docker compose exec backend (${target_path})"
  info "Resolved volume name: ${resolved_volume_name:-${volume_src}}"
else
  [[ -d "$mountpoint" ]] || die "Resolved mountpoint is not a directory: ${mountpoint}"
  info "Stats source: host path (${target_path})"
fi

function run_cmd() {
  local cmd="$1"
  if [[ "$use_backend_exec" == "true" ]]; then
    # Important: redirect stdin so docker compose exec can't consume the rest of this bash script
    # when the caller runs it via "ssh ... bash -s" (stdin carries the remaining script).
    docker compose -f "$COMPOSE_FILE" exec -T backend sh -lc "$cmd" < /dev/null
  else
    bash -c "$cmd"
  fi
}

df_line="$(run_cmd "df -P \"${target_path}\" | tail -n 1" || true)"
[[ -n "$df_line" ]] || die "df failed for path: ${target_path}"
df_used_pct="$(echo "$df_line" | awk '{print $5}' | tr -d '%' || true)"
[[ -n "$df_used_pct" ]] || die "Failed to parse df used percent from: ${df_line}"
if ! is_integer "$df_used_pct"; then
  die "Parsed df used percent is not an integer: '${df_used_pct}' (line: ${df_line})"
fi

upload_bytes=""
if run_cmd "du -sb \"${target_path}\" >/dev/null 2>&1"; then
  upload_bytes="$(run_cmd "du -sb \"${target_path}\" 2>/dev/null | cut -f1 | tr -d ' '" || true)"
elif run_cmd "du -sk \"${target_path}\" >/dev/null 2>&1"; then
  kb="$(run_cmd "du -sk \"${target_path}\" 2>/dev/null | cut -f1 | tr -d ' '" || true)"
  [[ -n "$kb" ]] || die "du -sk returned empty output for: ${target_path}"
  upload_bytes="$((kb * 1024))"
else
  die "du is not available or unsupported (cannot compute upload dir size)"
fi
[[ -n "$upload_bytes" ]] || die "Failed to compute upload bytes for: ${target_path}"
if ! is_integer "$upload_bytes"; then
  die "Computed upload bytes is not an integer: '${upload_bytes}'"
fi

file_count="$(run_cmd "find \"${target_path}\" -type f 2>/dev/null | wc -l | tr -d ' '" || true)"
[[ -n "$file_count" ]] || die "Failed to compute file count under: ${target_path}"
if ! is_integer "$file_count"; then
  die "Computed file count is not an integer: '${file_count}'"
fi

oldest_days=0
if (( file_count > 0 )); then
  oldest_epoch=""
  if run_cmd "find \"${target_path}\" -maxdepth 0 -printf ''" >/dev/null 2>&1; then
    oldest_epoch="$(run_cmd "find \"${target_path}\" -type f -printf '%T@\\n' 2>/dev/null | sort -n | head -n 1" || true)"
  elif run_cmd "command -v stat >/dev/null 2>&1"; then
    oldest_epoch="$(run_cmd "find \"${target_path}\" -type f -exec stat -c %Y {} + 2>/dev/null | sort -n | head -n 1" || true)"
  fi
  [[ -n "$oldest_epoch" ]] || die "Failed to compute oldest file mtime under: ${target_path}"

  oldest_sec="${oldest_epoch%%.*}"
  now_sec="$(date +%s)"
  if ! is_integer "$oldest_sec"; then
    die "Oldest mtime is not an integer epoch: '${oldest_epoch}'"
  fi
  if ! is_integer "$now_sec"; then
    die "date +%s returned non-integer: '${now_sec}'"
  fi
  age_sec=$((now_sec - oldest_sec))
  if (( age_sec < 0 )); then
    age_sec=0
  fi
  oldest_days=$((age_sec / 86400))
fi

max_upload_bytes=$((MAX_UPLOAD_DIR_GB * 1024 * 1024 * 1024))
upload_gb=$((upload_bytes / 1024 / 1024 / 1024))

info "df_used_pct=${df_used_pct}"
info "upload_bytes=${upload_bytes} upload_gb=${upload_gb}"
info "file_count=${file_count} oldest_file_days=${oldest_days}"

errors=0
if (( df_used_pct >= MAX_FS_USED_PCT )); then
  echo "[attendance-storage] ERROR: filesystem usage too high: used_pct=${df_used_pct} >= max_fs_used_pct=${MAX_FS_USED_PCT}" >&2
  errors=$((errors + 1))
fi
if (( upload_bytes >= max_upload_bytes )); then
  echo "[attendance-storage] ERROR: upload dir too large: bytes=${upload_bytes} >= max_bytes=${max_upload_bytes} (max_upload_dir_gb=${MAX_UPLOAD_DIR_GB})" >&2
  errors=$((errors + 1))
fi
if (( file_count > 0 )) && (( oldest_days >= MAX_OLDEST_FILE_DAYS )); then
  echo "[attendance-storage] ERROR: oldest file too old: oldest_days=${oldest_days} >= max_oldest_file_days=${MAX_OLDEST_FILE_DAYS}" >&2
  errors=$((errors + 1))
fi

if (( errors > 0 )); then
  exit 1
fi

info "Storage OK"
