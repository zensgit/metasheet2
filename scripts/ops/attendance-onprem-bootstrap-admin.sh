#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_NAME="${ADMIN_NAME:-Administrator}"
API_BASE="${API_BASE:-}" # optional, for login self-check
VERIFY_LOGIN="${VERIFY_LOGIN:-1}"
ENV_OVERRIDE_BCRYPT_SALT_ROUNDS="${BCRYPT_SALT_ROUNDS:-}"

function die() {
  echo "[attendance-onprem-bootstrap-admin] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-onprem-bootstrap-admin] $*" >&2
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
  [[ -n "$rounds" ]] || die "BCRYPT_SALT_ROUNDS must be set in ${ENV_FILE} or environment"
  if [[ ! "$rounds" =~ ^[0-9]+$ ]]; then
    die "BCRYPT_SALT_ROUNDS must be numeric (got: ${rounds})"
  fi
  if (( rounds < 12 )); then
    die "BCRYPT_SALT_ROUNDS must be >= 12 for production (got: ${rounds})"
  fi
}

# Encryption-at-rest master key/salt for packages/core-backend/src/security/encrypted-secrets.ts.
# These must be present and must not equal the built-in insecure default sentinels, otherwise
# any secret encrypted with the fallback key is trivially decryptable. We deliberately never
# echo the configured value back to the operator (values-free diagnostics).
#
# THE NORMALIZATION BELOW IS A VALIDATION VIEW ONLY: it decides accept/reject. It never rewrites
# the env file and never changes the bytes the runtime derives a key from (owner review F5,
# 2026-09-16 -- preflight and runtime must not disagree about the SAME material, and the fix for
# that disagreement must not touch key derivation).
#
# Two views exist because the callers hold two different things:
#   env-file  RAW line text straight out of get_env_value, never re-parsed by a shell. Quotes, a
#             trailing '#' comment, '$VAR' and blanks after '=' still mean whatever `source` /
#             `docker compose --env-file` would make of them, so this view must REJECT any
#             expression whose runtime value it cannot know. It deliberately does not eval or
#             source the (untrusted) env file to resolve them -- rejecting is the safe answer.
#   sourced   the value AFTER `source`, i.e. already the runtime effective value. Expressions are
#             gone and '$' / '#' are ordinary characters of a real operator secret here, so this
#             view only normalizes whitespace and a surrounding quote pair before the empty and
#             sentinel compares. Rejecting expressions here would fail-closed on a legitimate key.
#
# This function is byte-identical in attendance-onprem-env-check.sh, attendance-preflight.sh and
# attendance-onprem-bootstrap-admin.sh; the three copies are pinned against drift by
# scripts/ops/attendance-onprem-encryption-material-contracts.test.mjs.
function require_encryption_material() {
  local var_name="$1"
  local raw="$2"
  local default_sentinel="$3"
  local view="${4:-}"
  local hint="Generate one with: openssl rand -hex 32"

  case "$view" in
    env-file|sourced) ;;
    *)
      die "internal error: require_encryption_material needs an explicit view (env-file|sourced) for ${var_name}"
      ;;
  esac

  # A CRLF-saved env file leaves a trailing \r on every value and `source` keeps it, so strip it
  # in both views before anything else.
  raw="${raw%$'\r'}"
  local value="$raw"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  [[ -n "$value" ]] || die "${var_name} is missing (empty) in ${ENV_FILE}. ${hint}"

  local mark="${value:0:1}"
  if [[ "$view" == "env-file" ]]; then
    # 'KEY=   value' assigns an EMPTY value -- the blanks terminate the assignment word -- so the
    # text visible here is not what the runtime gets.
    if [[ "$raw" == [[:space:]]* ]]; then
      die "${var_name} in ${ENV_FILE} has blanks between '=' and the value, which assigns an empty value at runtime. Put the value directly after '='. ${hint}"
    fi

    if [[ "$mark" == '"' || "$mark" == "'" ]]; then
      if (( ${#value} < 2 )) || [[ "${value: -1}" != "$mark" ]] || [[ "${value:1:-1}" == *"$mark"* ]]; then
        die "${var_name} in ${ENV_FILE} uses an unsupported env expression (unbalanced or embedded quote). Write a plain unquoted literal value. ${hint}"
      fi
      value="${value:1:-1}"
    else
      if [[ "$value" == *'"'* || "$value" == *"'"* ]]; then
        die "${var_name} in ${ENV_FILE} uses an unsupported env expression (a quote inside an unquoted value). Write a plain unquoted literal value. ${hint}"
      fi
      if [[ "$value" == *[[:space:]]#* ]]; then
        die "${var_name} in ${ENV_FILE} uses an unsupported env expression (trailing '#' comment); source keeps only the text before it, so the preflight would be judging a different value than the runtime. Write a plain unquoted literal value. ${hint}"
      fi
    fi

    # Single quotes are literal under both `source` and compose; everything else expands at load
    # time, and resolving that here would mean executing an untrusted file.
    if [[ "$mark" != "'" ]] && { [[ "$value" == *'$'* ]] || [[ "$value" == *'`'* ]] || [[ "$value" == *'\'* ]]; }; then
      die "${var_name} in ${ENV_FILE} uses an unsupported env expression (variable expansion, command substitution or a backslash escape). Write a plain unquoted literal value. ${hint}"
    fi
  else
    if (( ${#value} >= 2 )) && [[ "$mark" == '"' || "$mark" == "'" ]] && [[ "${value: -1}" == "$mark" ]]; then
      value="${value:1:-1}"
    fi
  fi

  # Re-trim AFTER de-quoting. Without this, '"   "' reads as non-empty and a sentinel padded
  # inside its quotes reads as "not the default", while the runtime value is empty/default.
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  [[ -n "$value" ]] || die "${var_name} is missing (empty) in ${ENV_FILE}. ${hint}"
  if [[ "$value" == "$default_sentinel" ]]; then
    die "${var_name} uses the insecure built-in default value in ${ENV_FILE}. ${hint}"
  fi
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

require_cmd node
require_cmd psql

load_env_file

if [[ -n "${ENV_OVERRIDE_BCRYPT_SALT_ROUNDS}" ]]; then
  BCRYPT_SALT_ROUNDS="${ENV_OVERRIDE_BCRYPT_SALT_ROUNDS}"
else
  BCRYPT_SALT_ROUNDS="${BCRYPT_SALT_ROUNDS:-12}"
fi

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL missing in ${ENV_FILE}"

require_strong_jwt_secret "${JWT_SECRET:-}"
require_bcrypt_salt_rounds "$BCRYPT_SALT_ROUNDS"
require_encryption_material "ENCRYPTION_KEY" "${ENCRYPTION_KEY:-}" "default-key-change-in-production" "sourced"
require_encryption_material "ENCRYPTION_SALT" "${ENCRYPTION_SALT:-}" "default-salt-change-in-production" "sourced"

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
