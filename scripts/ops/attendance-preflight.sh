#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.app.yml}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
NGINX_CONF="${NGINX_CONF:-${ROOT_DIR}/docker/nginx.conf}"

function die() {
  echo "[attendance-preflight] ERROR: $*" >&2
  exit 1
}

function warn() {
  echo "[attendance-preflight] WARN: $*" >&2
}

function info() {
  echo "[attendance-preflight] $*" >&2
}

function require_strong_jwt_secret() {
  local secret="$1"
  [[ -n "$secret" ]] || die "JWT_SECRET is missing in ${ENV_FILE}"
  case "$secret" in
    change-me|change-me-in-production|test|dev-secret|dev-secret-key|fallback-development-secret-change-in-production|your-secret-key-here|your-dev-secret-key-here)
      die "JWT_SECRET uses an insecure placeholder/default value in ${ENV_FILE}"
      ;;
  esac
  if (( ${#secret} < 32 )); then
    die "JWT_SECRET must be at least 32 characters in ${ENV_FILE}"
  fi
}

function require_bcrypt_salt_rounds() {
  local rounds="$1"
  [[ -n "$rounds" ]] || die "BCRYPT_SALT_ROUNDS is missing in ${ENV_FILE}"
  if [[ ! "$rounds" =~ ^[0-9]+$ ]]; then
    die "BCRYPT_SALT_ROUNDS must be an integer (got: '${rounds}')."
  fi
  if (( rounds < 12 )); then
    die "BCRYPT_SALT_ROUNDS must be >= 12 in ${ENV_FILE} (got: ${rounds})."
  fi
}

function get_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo ""
    return 0
  fi
  # Don't "source" the env file because values can contain '#' and other characters.
  # We treat it as a simple KEY=VALUE file (no spaces around '=').
  #
  # IMPORTANT: keys may be absent; that must not hard-fail preflight before we can
  # emit a helpful error/warn. We therefore avoid `pipefail` propagation here.
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  echo "${line#${key}=}"
}

info "Repo root: ${ROOT_DIR}"
info "Compose:   ${COMPOSE_FILE}"
info "Env file:  ${ENV_FILE}"
info "Nginx:     ${NGINX_CONF}"

[[ -f "$COMPOSE_FILE" ]] || die "Compose file not found: ${COMPOSE_FILE}"
[[ -f "$ENV_FILE" ]] || die "Missing env file: ${ENV_FILE} (copy docker/app.env.example -> docker/app.env and fill secrets)"
[[ -f "$NGINX_CONF" ]] || die "Missing nginx config: ${NGINX_CONF} (docker-compose.app.yml mounts it into the web container)"

# Prevent accidental DB exposure in production compose.
if grep -qE '"5432:5432"|5432:5432' "$COMPOSE_FILE"; then
  die "docker-compose.app.yml exposes Postgres port 5432. Remove it for production (use docker-compose.app.debug.yml for localhost-only debug)."
fi
if grep -qE '"6379:6379"|6379:6379' "$COMPOSE_FILE"; then
  die "docker-compose.app.yml exposes Redis port 6379. Remove it for production (use docker-compose.app.debug.yml for localhost-only debug)."
fi

JWT_SECRET="$(get_env_value JWT_SECRET)"
POSTGRES_PASSWORD="$(get_env_value POSTGRES_PASSWORD)"
DATABASE_URL="$(get_env_value DATABASE_URL)"
NODE_ENV="$(get_env_value NODE_ENV)"
PRODUCT_MODE="$(get_env_value PRODUCT_MODE)"
REQUIRE_TOKEN="$(get_env_value ATTENDANCE_IMPORT_REQUIRE_TOKEN)"
UPLOAD_DIR="$(get_env_value ATTENDANCE_IMPORT_UPLOAD_DIR)"
CSV_MAX_ROWS="$(get_env_value ATTENDANCE_IMPORT_CSV_MAX_ROWS)"
PREFLIGHT_MAX_CSV_ROWS="${ATTENDANCE_PREFLIGHT_MAX_CSV_ROWS:-100000}"
BCRYPT_SALT_ROUNDS="$(get_env_value BCRYPT_SALT_ROUNDS)"

require_strong_jwt_secret "$JWT_SECRET"
require_bcrypt_salt_rounds "$BCRYPT_SALT_ROUNDS"

[[ -n "$POSTGRES_PASSWORD" ]] || die "POSTGRES_PASSWORD is missing in ${ENV_FILE}"
[[ "$POSTGRES_PASSWORD" != "change-me" ]] || die "POSTGRES_PASSWORD is still 'change-me' in ${ENV_FILE}"

[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is missing in ${ENV_FILE}"
if [[ "$DATABASE_URL" == *"change-me"* ]]; then
  die "DATABASE_URL still contains 'change-me' in ${ENV_FILE}"
fi

if [[ "${REQUIRE_TOKEN}" != "1" ]]; then
  die "ATTENDANCE_IMPORT_REQUIRE_TOKEN must be set to '1' in ${ENV_FILE} for production import safety."
fi

if [[ ! "${PREFLIGHT_MAX_CSV_ROWS}" =~ ^[0-9]+$ ]]; then
  die "ATTENDANCE_PREFLIGHT_MAX_CSV_ROWS must be an integer when set (got: '${PREFLIGHT_MAX_CSV_ROWS}')."
fi
if (( PREFLIGHT_MAX_CSV_ROWS < 1000 )); then
  die "ATTENDANCE_PREFLIGHT_MAX_CSV_ROWS must be >= 1000 (got: ${PREFLIGHT_MAX_CSV_ROWS})."
fi

if [[ -z "${CSV_MAX_ROWS}" ]]; then
  die "ATTENDANCE_IMPORT_CSV_MAX_ROWS is missing in ${ENV_FILE}. Set a production-safe cap (recommended: 100000)."
fi
if [[ ! "${CSV_MAX_ROWS}" =~ ^[0-9]+$ ]]; then
  die "ATTENDANCE_IMPORT_CSV_MAX_ROWS must be an integer (got: '${CSV_MAX_ROWS}')."
fi
if (( CSV_MAX_ROWS < 1000 )); then
  die "ATTENDANCE_IMPORT_CSV_MAX_ROWS must be >= 1000 (got: ${CSV_MAX_ROWS})."
fi
if (( CSV_MAX_ROWS > PREFLIGHT_MAX_CSV_ROWS )); then
  die "ATTENDANCE_IMPORT_CSV_MAX_ROWS=${CSV_MAX_ROWS} exceeds safe preflight bound ${PREFLIGHT_MAX_CSV_ROWS}. Lower ATTENDANCE_IMPORT_CSV_MAX_ROWS or explicitly override ATTENDANCE_PREFLIGHT_MAX_CSV_ROWS after capacity validation."
fi

# CSV upload channel requires a persistent upload directory and a larger nginx body size for the upload route.
#
# This preflight enforces that the env var points at an absolute path and that the production compose mounts
# the same path for the backend container. Without it, uploads may be written to the container filesystem
# and disappear on restart, and/or large imports may fail with 413 from the reverse proxy.
if [[ -z "$UPLOAD_DIR" ]]; then
  die "ATTENDANCE_IMPORT_UPLOAD_DIR is missing in ${ENV_FILE}. Recommended: ATTENDANCE_IMPORT_UPLOAD_DIR=/app/uploads/attendance-import (must match docker-compose.app.yml volume mount)."
fi
if [[ "${UPLOAD_DIR}" != /* ]]; then
  die "ATTENDANCE_IMPORT_UPLOAD_DIR must be an absolute path (got: '${UPLOAD_DIR}'). Recommended: /app/uploads/attendance-import"
fi
if ! grep -qE ":[[:space:]]*${UPLOAD_DIR}([[:space:]]|$)" "$COMPOSE_FILE"; then
  die "docker-compose volume mount for ATTENDANCE_IMPORT_UPLOAD_DIR not found. Expected backend volumes to include ':${UPLOAD_DIR}'."
fi

if ! grep -qE "^[[:space:]]*location[[:space:]]+/api/attendance/import/upload[[:space:]]*\\{" "$NGINX_CONF"; then
  die "nginx upload location missing in ${NGINX_CONF}: expected 'location /api/attendance/import/upload { ... }' with a larger client_max_body_size."
fi
upload_body_size="$(
  awk '
    BEGIN { inside=0; level=0; size="" }
    {
      if ($0 ~ /^[[:space:]]*location[[:space:]]+\/api\/attendance\/import\/upload[[:space:]]*\{/) {
        inside=1
        level=0
        size=""
      }
      if (inside) {
        # Count braces to find the end of the location block.
        open_count=gsub(/\{/, "{")
        close_count=gsub(/\}/, "}")
        level += open_count - close_count

        if ($0 ~ /client_max_body_size[[:space:]]+[0-9]+[kKmMgG][[:space:]]*;/) {
          tmp=$0
          sub(/.*client_max_body_size[[:space:]]+/, "", tmp)
          if (match(tmp, /^[0-9]+[kKmMgG]/)) {
            size = substr(tmp, RSTART, RLENGTH)
          }
        }
        if (level <= 0) {
          print size
          exit
        }
      }
    }
  ' "$NGINX_CONF"
)"
if [[ -z "$upload_body_size" ]]; then
  die "nginx upload location is missing client_max_body_size. Add e.g. 'client_max_body_size 120m;' inside 'location /api/attendance/import/upload'."
fi

upload_body_num="${upload_body_size%[kKmMgG]}"
upload_body_unit="${upload_body_size##*[0-9]}"
upload_body_num="${upload_body_num:-0}"
upload_body_unit="$(echo "$upload_body_unit" | tr '[:upper:]' '[:lower:]')"

if [[ "$upload_body_unit" == "k" ]]; then
  die "nginx upload client_max_body_size too small: ${upload_body_size} (expected >= 120m for extreme-scale CSV upload)."
elif [[ "$upload_body_unit" == "m" ]]; then
  if (( upload_body_num < 120 )); then
    die "nginx upload client_max_body_size too small: ${upload_body_size} (expected >= 120m)."
  fi
elif [[ "$upload_body_unit" == "g" ]]; then
  : # Always >= 120m.
else
  warn "nginx upload client_max_body_size uses an unknown unit: ${upload_body_size}. Ensure it is >= 120m."
fi

if [[ -z "$NODE_ENV" ]]; then
  warn "NODE_ENV is missing (recommended: production)"
elif [[ "$NODE_ENV" != "production" ]]; then
  warn "NODE_ENV is '${NODE_ENV}' (recommended: production)"
fi

if [[ -z "$PRODUCT_MODE" ]]; then
  warn "PRODUCT_MODE is not set. If you sell Attendance as a standalone product, set PRODUCT_MODE=attendance."
elif [[ "$PRODUCT_MODE" != "attendance" && "$PRODUCT_MODE" != "platform" && "$PRODUCT_MODE" != "attendance-focused" ]]; then
  warn "PRODUCT_MODE is '${PRODUCT_MODE}' (expected: platform|attendance)"
fi

info "Preflight OK"
