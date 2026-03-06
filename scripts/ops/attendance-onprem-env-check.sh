#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
REQUIRE_ATTENDANCE_ONLY="${REQUIRE_ATTENDANCE_ONLY:-1}"

function die() {
  echo "[attendance-onprem-env-check] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-onprem-env-check] $*" >&2
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

[[ -f "$ENV_FILE" ]] || die "Missing env file: ${ENV_FILE}"
if [[ "${REQUIRE_ATTENDANCE_ONLY}" != "0" && "${REQUIRE_ATTENDANCE_ONLY}" != "1" ]]; then
  die "REQUIRE_ATTENDANCE_ONLY must be 0 or 1 (got: ${REQUIRE_ATTENDANCE_ONLY})"
fi

JWT_SECRET="$(get_env_value JWT_SECRET)"
POSTGRES_PASSWORD="$(get_env_value POSTGRES_PASSWORD)"
DATABASE_URL="$(get_env_value DATABASE_URL)"
PRODUCT_MODE="$(get_env_value PRODUCT_MODE)"
REQUIRE_TOKEN="$(get_env_value ATTENDANCE_IMPORT_REQUIRE_TOKEN)"
UPLOAD_DIR="$(get_env_value ATTENDANCE_IMPORT_UPLOAD_DIR)"
CSV_MAX_ROWS="$(get_env_value ATTENDANCE_IMPORT_CSV_MAX_ROWS)"
DEPLOYMENT_MODEL="$(get_env_value DEPLOYMENT_MODEL)"

[[ -n "$JWT_SECRET" ]] || die "JWT_SECRET is missing in ${ENV_FILE}"
[[ "$JWT_SECRET" != "change-me" ]] || die "JWT_SECRET is still 'change-me' in ${ENV_FILE}"

[[ -n "$POSTGRES_PASSWORD" ]] || die "POSTGRES_PASSWORD is missing in ${ENV_FILE}"
[[ "$POSTGRES_PASSWORD" != "change-me" ]] || die "POSTGRES_PASSWORD is still 'change-me' in ${ENV_FILE}"

[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is missing in ${ENV_FILE}"
if [[ "$DATABASE_URL" == *"change-me"* ]]; then
  die "DATABASE_URL still contains 'change-me' in ${ENV_FILE}"
fi

if [[ "${REQUIRE_TOKEN}" != "1" ]]; then
  die "ATTENDANCE_IMPORT_REQUIRE_TOKEN must be 1 for production"
fi

[[ -n "$UPLOAD_DIR" ]] || die "ATTENDANCE_IMPORT_UPLOAD_DIR is missing in ${ENV_FILE}"
if [[ "${UPLOAD_DIR}" != /* ]]; then
  die "ATTENDANCE_IMPORT_UPLOAD_DIR must be an absolute path (got: '${UPLOAD_DIR}')"
fi

[[ -n "$CSV_MAX_ROWS" ]] || die "ATTENDANCE_IMPORT_CSV_MAX_ROWS is missing in ${ENV_FILE}"
if [[ ! "${CSV_MAX_ROWS}" =~ ^[0-9]+$ ]]; then
  die "ATTENDANCE_IMPORT_CSV_MAX_ROWS must be an integer (got: '${CSV_MAX_ROWS}')"
fi
if (( CSV_MAX_ROWS < 1000 )); then
  die "ATTENDANCE_IMPORT_CSV_MAX_ROWS must be >= 1000 (got: ${CSV_MAX_ROWS})"
fi

if [[ "${REQUIRE_ATTENDANCE_ONLY}" == "1" ]]; then
  if [[ -z "${PRODUCT_MODE}" ]]; then
    die "PRODUCT_MODE is missing in ${ENV_FILE}; expected attendance"
  fi
  if [[ "${PRODUCT_MODE}" != "attendance" && "${PRODUCT_MODE}" != "attendance-focused" ]]; then
    die "PRODUCT_MODE='${PRODUCT_MODE}' is not allowed when REQUIRE_ATTENDANCE_ONLY=1 (expected attendance)"
  fi
fi

if [[ -n "${DEPLOYMENT_MODEL}" && "${DEPLOYMENT_MODEL}" != "onprem" && "${DEPLOYMENT_MODEL}" != "hybrid" && "${DEPLOYMENT_MODEL}" != "saas" ]]; then
  die "DEPLOYMENT_MODEL must be one of onprem|hybrid|saas (got: '${DEPLOYMENT_MODEL}')"
fi

info "Env check OK (REQUIRE_ATTENDANCE_ONLY=${REQUIRE_ATTENDANCE_ONLY})"
