#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_NAME="${ADMIN_NAME:-Administrator}"
API_BASE="${API_BASE:-}" # optional, for login self-check
VERIFY_LOGIN="${VERIFY_LOGIN:-1}"
BCRYPT_SALT_ROUNDS="${BCRYPT_SALT_ROUNDS:-12}"

function die() {
  echo "[attendance-onprem-bootstrap-admin] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-onprem-bootstrap-admin] $*" >&2
}

function require_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "Missing required command: ${name}"
}

function load_env_file() {
  set +u
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  set -u
}

[[ -f "$ENV_FILE" ]] || die "ENV_FILE not found: ${ENV_FILE}"
[[ -n "$ADMIN_EMAIL" ]] || die "ADMIN_EMAIL is required"
[[ -n "$ADMIN_PASSWORD" ]] || die "ADMIN_PASSWORD is required"

if [[ "${#ADMIN_PASSWORD}" -lt 12 ]]; then
  die "ADMIN_PASSWORD must be at least 12 characters for production"
fi

if [[ ! "$BCRYPT_SALT_ROUNDS" =~ ^[0-9]+$ ]]; then
  die "BCRYPT_SALT_ROUNDS must be numeric (got: ${BCRYPT_SALT_ROUNDS})"
fi
if (( BCRYPT_SALT_ROUNDS < 10 )); then
  die "BCRYPT_SALT_ROUNDS should be >= 10 (got: ${BCRYPT_SALT_ROUNDS})"
fi

require_cmd node
require_cmd psql

load_env_file

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL missing in ${ENV_FILE}"

if [[ -z "${JWT_SECRET:-}" || "$JWT_SECRET" == "change-me" ]]; then
  die "JWT_SECRET missing/invalid in ${ENV_FILE}"
fi

if [[ -z "${ATTENDANCE_IMPORT_REQUIRE_TOKEN:-}" || "${ATTENDANCE_IMPORT_REQUIRE_TOKEN}" != "1" ]]; then
  die "ATTENDANCE_IMPORT_REQUIRE_TOKEN must be 1 in ${ENV_FILE}"
fi

generated_user_id="$(node -e "console.log(require('crypto').randomUUID())")"
password_hash="$(
  node -e '
    const bcrypt = require("bcryptjs");
    const rounds = Number(process.argv[1]);
    const password = process.argv[2];
    process.stdout.write(bcrypt.hashSync(password, rounds));
  ' "$BCRYPT_SALT_ROUNDS" "$ADMIN_PASSWORD"
)"

if [[ -z "$password_hash" ]]; then
  die "Failed to generate bcrypt password hash"
fi

info "Upserting admin user: ${ADMIN_EMAIL}"
admin_user_id="$(
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -X -A -t \
    -v v_user_id="$generated_user_id" \
    -v v_email="$ADMIN_EMAIL" \
    -v v_name="$ADMIN_NAME" \
    -v v_password_hash="$password_hash" <<'SQL'
WITH upserted AS (
  INSERT INTO users (id, email, name, password_hash, role, permissions, is_admin, is_active, created_at, updated_at)
  VALUES (
    :'v_user_id',
    :'v_email',
    :'v_name',
    :'v_password_hash',
    'admin',
    '[]'::jsonb,
    true,
    true,
    NOW(),
    NOW()
  )
  ON CONFLICT (email) DO UPDATE
  SET
    name = EXCLUDED.name,
    password_hash = EXCLUDED.password_hash,
    role = 'admin',
    is_admin = true,
    is_active = true,
    updated_at = NOW()
  RETURNING id
)
SELECT id FROM upserted LIMIT 1;
SQL
)"

admin_user_id="$(echo "$admin_user_id" | tr -d '[:space:]')"
[[ -n "$admin_user_id" ]] || die "Failed to resolve admin user id"

info "Ensuring role/permission grants for user_id=${admin_user_id}"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -X \
  -v v_user_id="$admin_user_id" <<'SQL'
INSERT INTO user_roles (user_id, role_id)
VALUES (:'v_user_id', 'admin')
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO user_permissions (user_id, permission_code)
SELECT :'v_user_id', p.code
FROM permissions p
WHERE p.code IN (
  'attendance:read',
  'attendance:write',
  'attendance:approve',
  'attendance:admin',
  'permissions:read',
  'permissions:write',
  'roles:read',
  'roles:write'
)
ON CONFLICT (user_id, permission_code) DO NOTHING;
SQL

if [[ "$VERIFY_LOGIN" == "1" ]]; then
  [[ -n "$API_BASE" ]] || die "VERIFY_LOGIN=1 requires API_BASE (example: http://127.0.0.1/api)"
  api="${API_BASE%/}"
  info "Verifying admin login via ${api}/auth/login"
  login_code="$(
    curl -sS -o /tmp/attendance-admin-login-check.json -w '%{http_code}' \
      -X POST "${api}/auth/login" \
      -H 'Content-Type: application/json' \
      --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" || true
  )"
  if [[ "$login_code" != "200" ]]; then
    if [[ -f /tmp/attendance-admin-login-check.json ]]; then
      body="$(cat /tmp/attendance-admin-login-check.json)"
    else
      body=""
    fi
    die "Admin login verification failed (HTTP ${login_code}) ${body:0:240}"
  fi
fi

info "Admin bootstrap OK (email=${ADMIN_EMAIL}, user_id=${admin_user_id})"
