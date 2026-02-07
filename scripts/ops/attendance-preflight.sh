#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.app.yml}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"

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

function get_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo ""
    return 0
  fi
  # Don't "source" the env file because values can contain '#' and other characters.
  # We treat it as a simple KEY=VALUE file (no spaces around '=').
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | sed -E "s/^${key}=//"
}

info "Repo root: ${ROOT_DIR}"
info "Compose:   ${COMPOSE_FILE}"
info "Env file:  ${ENV_FILE}"

[[ -f "$COMPOSE_FILE" ]] || die "Compose file not found: ${COMPOSE_FILE}"
[[ -f "$ENV_FILE" ]] || die "Missing env file: ${ENV_FILE} (copy docker/app.env.example -> docker/app.env and fill secrets)"

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

[[ -n "$JWT_SECRET" ]] || die "JWT_SECRET is missing in ${ENV_FILE}"
[[ "$JWT_SECRET" != "change-me" ]] || die "JWT_SECRET is still 'change-me' in ${ENV_FILE}"

[[ -n "$POSTGRES_PASSWORD" ]] || die "POSTGRES_PASSWORD is missing in ${ENV_FILE}"
[[ "$POSTGRES_PASSWORD" != "change-me" ]] || die "POSTGRES_PASSWORD is still 'change-me' in ${ENV_FILE}"

[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is missing in ${ENV_FILE}"
if [[ "$DATABASE_URL" == *"change-me"* ]]; then
  die "DATABASE_URL still contains 'change-me' in ${ENV_FILE}"
fi

if [[ "${REQUIRE_TOKEN}" != "1" ]]; then
  die "ATTENDANCE_IMPORT_REQUIRE_TOKEN must be set to '1' in ${ENV_FILE} for production import safety."
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

