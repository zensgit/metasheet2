#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.app.yml}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"

MAX_FILE_AGE_DAYS="${MAX_FILE_AGE_DAYS:-14}"
DELETE="${DELETE:-false}"
CONFIRM_DELETE="${CONFIRM_DELETE:-false}"
MAX_DELETE_FILES="${MAX_DELETE_FILES:-5000}"
MAX_DELETE_GB="${MAX_DELETE_GB:-5}"

function die() {
  echo "[attendance-clean-uploads] ERROR: $*" >&2
  exit 1
}

function warn() {
  echo "[attendance-clean-uploads] WARN: $*" >&2
}

function info() {
  echo "[attendance-clean-uploads] $*" >&2
}

function is_integer() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
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

if ! is_integer "$MAX_FILE_AGE_DAYS"; then
  die "MAX_FILE_AGE_DAYS must be an integer (got: '${MAX_FILE_AGE_DAYS}')"
fi
if (( MAX_FILE_AGE_DAYS < 1 )); then
  die "MAX_FILE_AGE_DAYS must be >= 1 (got: '${MAX_FILE_AGE_DAYS}')"
fi
if ! is_integer "$MAX_DELETE_FILES"; then
  die "MAX_DELETE_FILES must be an integer (got: '${MAX_DELETE_FILES}')"
fi
if (( MAX_DELETE_FILES < 1 )); then
  die "MAX_DELETE_FILES must be >= 1 (got: '${MAX_DELETE_FILES}')"
fi
if ! is_integer "$MAX_DELETE_GB"; then
  die "MAX_DELETE_GB must be an integer (got: '${MAX_DELETE_GB}')"
fi
if (( MAX_DELETE_GB < 1 )); then
  die "MAX_DELETE_GB must be >= 1 (got: '${MAX_DELETE_GB}')"
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
info "Params: max_file_age_days=${MAX_FILE_AGE_DAYS} delete=${DELETE} confirm_delete=${CONFIRM_DELETE} max_delete_files=${MAX_DELETE_FILES} max_delete_gb=${MAX_DELETE_GB}"

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
  if ! mountpoint="$(docker volume inspect "$volume_src" --format '{{.Mountpoint}}' 2>/dev/null)"; then
    mountpoint=""
  fi

  if [[ -z "$mountpoint" ]]; then
    project_name="${COMPOSE_PROJECT_NAME:-$(basename "$compose_dir")}"
    prefixed_name="${project_name}_${volume_src}"
    if mountpoint="$(docker volume inspect "$prefixed_name" --format '{{.Mountpoint}}' 2>/dev/null)"; then
      resolved_volume_name="$prefixed_name"
      info "Resolved compose-prefixed volume: ${prefixed_name}"
    else
      mountpoint=""
    fi
  fi

  if [[ -z "$mountpoint" ]]; then
    die "docker volume inspect failed for '${volume_src}' (ensure deploy user has docker permission)"
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
  info "Cleanup target: docker compose exec backend (${target_path})"
  info "Resolved volume name: ${resolved_volume_name:-${volume_src}}"
else
  [[ -d "$mountpoint" ]] || die "Resolved mountpoint is not a directory: ${mountpoint}"
  info "Cleanup target: host path (${target_path})"
fi

function run_cmd() {
  local cmd="$1"
  if [[ "$use_backend_exec" == "true" ]]; then
    local tmp_err out rc
    tmp_err="$(mktemp 2>/dev/null || echo "/tmp/attendance-clean-uploads-err-$$")"
    out=""
    set +e
    out="$(docker compose -f "$COMPOSE_FILE" exec -T backend sh -lc "$cmd" < /dev/null 2>"$tmp_err")"
    rc=$?
    set -e
    if [[ "$rc" != "0" ]]; then
      if [[ -f "$tmp_err" ]]; then
        tail -n 80 "$tmp_err" >&2 || true
        rm -f "$tmp_err" || true
      fi
      return "$rc"
    fi
    rm -f "$tmp_err" || true
    echo "$out"
  else
    bash -c "$cmd"
  fi
}

# Find files with age >= MAX_FILE_AGE_DAYS.
# GNU find: "-mtime +13" means strictly > 13 days, i.e. >= 14 days.
mtime_threshold=$((MAX_FILE_AGE_DAYS - 1))
find_expr="find \"${target_path}\" -type f -mtime +${mtime_threshold} -print"

stale_list="$(run_cmd "$find_expr" || true)"
stale_count="$(printf '%s\n' "${stale_list}" | sed '/^$/d' | wc -l | tr -d '[:space:]' || true)"
if ! is_integer "$stale_count"; then
  die "Failed to compute stale_count"
fi

info "stale_count=${stale_count} (age >= ${MAX_FILE_AGE_DAYS} days)"

if (( stale_count == 0 )); then
  info "No stale files to clean."
  exit 0
fi

info "Stale file sample (first 50):"
printf '%s\n' "${stale_list}" | sed -n '1,50p' >&2

if [[ "${DELETE}" != "true" ]]; then
  info "Dry-run only. To delete, set DELETE=true CONFIRM_DELETE=true"
  exit 0
fi
if [[ "${CONFIRM_DELETE}" != "true" ]]; then
  die "Refusing to delete without CONFIRM_DELETE=true"
fi

size_kb_cmd="find \"${target_path}\" -type f -mtime +${mtime_threshold} -exec du -k {} + 2>/dev/null | awk '{s+=$1} END {print s+0}'"
stale_kb_total="$(run_cmd "$size_kb_cmd" | tail -n 1 | tr -d '[:space:]' || true)"
if ! is_integer "$stale_kb_total"; then
  die "Failed to compute stale_kb_total"
fi
stale_gb_ceil=$(( (stale_kb_total + 1024*1024 - 1) / (1024*1024) ))
info "stale_kb_total=${stale_kb_total} (~${stale_gb_ceil} GiB)"

if (( stale_count > MAX_DELETE_FILES )); then
  die "Refusing to delete: stale_count=${stale_count} exceeds MAX_DELETE_FILES=${MAX_DELETE_FILES} (raise MAX_DELETE_FILES explicitly to override)"
fi
if (( stale_gb_ceil > MAX_DELETE_GB )); then
  die "Refusing to delete: estimated size (~${stale_gb_ceil} GiB) exceeds MAX_DELETE_GB=${MAX_DELETE_GB} (raise MAX_DELETE_GB explicitly to override)"
fi

delete_cmd="find \"${target_path}\" -type f -mtime +${mtime_threshold} -print -delete"
info "Deleting stale files (age >= ${MAX_FILE_AGE_DAYS} days)..."
run_cmd "$delete_cmd" >/dev/null || die "Delete command failed"

info "Delete completed."
