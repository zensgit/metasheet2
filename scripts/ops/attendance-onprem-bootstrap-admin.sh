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

login_response_file=""
admin_session_token=""
if [[ "$VERIFY_LOGIN" == "1" ]]; then
  [[ -n "$API_BASE" ]] || die "VERIFY_LOGIN=1 requires API_BASE (example: http://127.0.0.1/api)"
  api="${API_BASE%/}"
  login_response_file="$(mktemp)"
  trap 'rm -f "$login_response_file"' EXIT
  info "Verifying admin login via ${api}/auth/login"
  login_code="$(
    curl -sS -o "$login_response_file" -w '%{http_code}' \
      -X POST "${api}/auth/login" \
      -H 'Content-Type: application/json' \
      --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" || true
  )"
  if [[ "$login_code" != "200" ]]; then
    if [[ -f "$login_response_file" ]]; then
      body="$(cat "$login_response_file")"
    else
      body=""
    fi
    die "Admin login verification failed (HTTP ${login_code}) ${body:0:240}"
  fi
  admin_session_token="$(
    node -e '
      const fs = require("fs");
      let parsed = {};
      try { parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
      const token = parsed?.data?.token || parsed?.token || "";
      process.stdout.write(String(token));
    ' "$login_response_file" || true
  )"
fi

# ---------------------------------------------------------------------------------------------
# Fresh-install local org bootstrap (W1-6; owner ruling 2026-10-10 「W1-6 按此形状实现」).
#
# Only when user_orgs AND directory_integrations are both empty (no org data at all), the
# logged-in bootstrap admin calls the EXISTING route POST /api/admin/directory/local/accounts
# with its own user id. That route's existing code creates the deployment's local org anchor
# (getOrCreateLocalIntegration) and the admin's active org membership; this script writes NO
# anchor/membership SQL of its own -- every psql statement below is a read-only count.
#
# Upgrade / directory-already-configured installs (either table has rows) are left untouched.
# Re-running is a no-op because the first successful run makes both tables non-empty.
#
# Fail-closed: any error exits non-zero with a values-free message. NOTE: the route commits the
# anchor before the membership transaction, so a failure inside that transaction can leave an
# anchor without a membership. This script does not roll that back. It is DETECTED twice, by
# read-only counts only: right after the call (postcondition) and on any later run (an anchor
# with no directory accounts, links, departments or memberships at all). Both exit non-zero and
# say to finish it by calling the same route manually; neither writes anything.
# The PowerShell twin (multitable-onprem-bootstrap-admin.ps1) carries the same step, SQL and
# messages; scripts/ops/attendance-onprem-bootstrap-admin-local-org.test.mjs pins them.
# ---------------------------------------------------------------------------------------------
LOCAL_ORG_LOG_PREFIX="Local org bootstrap"

function local_org_die() {
  die "${LOCAL_ORG_LOG_PREFIX}: $*"
}

function local_org_info() {
  info "${LOCAL_ORG_LOG_PREFIX}: $*"
}

function local_org_read_counts() {
  local sql="$1"
  local description="$2"
  local_org_info "$description"
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -X -A -t \
    -v v_user_id="$admin_user_id" <<<"$sql" | tr -d '[:space:]'
}

LOCAL_ORG_EMPTINESS_SQL="SELECT (SELECT count(*) FROM user_orgs) || ':' || (SELECT count(*) FROM directory_integrations);"
LOCAL_ORG_LEFTOVER_ANCHOR_SQL="SELECT (SELECT count(*) FROM directory_integrations WHERE provider = 'local' AND org_id = 'default' AND status = 'active') || ':' || (SELECT count(*) FROM directory_accounts) || ':' || (SELECT count(*) FROM directory_account_links) || ':' || (SELECT count(*) FROM directory_departments);"
LOCAL_ORG_POSTCONDITION_SQL="SELECT (SELECT count(*) FROM directory_integrations WHERE provider = 'local' AND org_id = 'default' AND status = 'active') || ':' || (SELECT count(*) FROM user_orgs WHERE user_id = :'v_user_id' AND is_active = TRUE) || ':' || (SELECT count(*) FROM user_orgs WHERE user_id = :'v_user_id' AND is_active = TRUE AND org_id = 'default');"
LOCAL_ORG_ROUTE_PATH="/admin/directory/local/accounts"

if [[ "$VERIFY_LOGIN" != "1" ]]; then
  local_org_info "skipped: it needs a logged-in admin session (VERIFY_LOGIN=1 with a running backend); nothing was written"
else
  emptiness_counts="$(local_org_read_counts "$LOCAL_ORG_EMPTINESS_SQL" "read-only emptiness check")" \
    || local_org_die "the read-only emptiness check failed; nothing was written"
  if [[ ! "$emptiness_counts" =~ ^[0-9]+:[0-9]+$ ]]; then
    local_org_die "the read-only emptiness check returned an unexpected shape; nothing was written"
  fi

  if [[ "$emptiness_counts" == "0:1" ]]; then
    # No membership anywhere and exactly one directory integration: recognise a bare local anchor (and
    # nothing else) instead of calling it an upgrade. The server now creates the anchor inside the same
    # transaction as the account / link / membership, so it can only be the leftover of an earlier
    # server version (an interrupted run or a failed local-directory call). Stays blocking (non-zero).
    leftover_counts="$(local_org_read_counts "$LOCAL_ORG_LEFTOVER_ANCHOR_SQL" "read-only leftover-anchor check")" \
      || local_org_die "the read-only leftover-anchor check failed; nothing was written"
    if [[ ! "$leftover_counts" =~ ^[0-9]+:[0-9]+:[0-9]+:[0-9]+$ ]]; then
      local_org_die "the read-only leftover-anchor check returned an unexpected shape; nothing was written"
    fi
    if [[ "$leftover_counts" == "1:0:0:0" ]]; then
      local_org_die "found a bare local org anchor (a local org anchor with no directory account, department or org membership; an interrupted run or a failed local-directory call on an earlier server version can leave one); nothing was written -- on a fresh install, complete it by calling POST /api/admin/directory/local/accounts for the admin manually; on an existing deployment, re-run with VERIFY_LOGIN=0 to skip this step"
    fi
  fi

  if [[ "$emptiness_counts" != "0:0" ]]; then
    local_org_info "skipped: org membership or directory data already exists (upgrade or directory already configured); nothing was written"
  else
    [[ -n "$admin_session_token" ]] || local_org_die "the admin login response carried no session token; nothing was written"
    [[ "$admin_session_token" =~ ^[A-Za-z0-9._~+/=-]+$ ]] \
      || local_org_die "the admin login response carried a session token of an unexpected shape; nothing was written"

    local_org_info "no org membership and no directory integration found (fresh install); creating the local org anchor and the admin membership via POST ${api}${LOCAL_ORG_ROUTE_PATH}"
    local_org_body="$(
      node -e 'process.stdout.write(JSON.stringify({ localUserId: process.argv[1] }))' "$admin_user_id"
    )" || local_org_die "could not build the request body; nothing was written"
    local_org_response_file="$(mktemp)"
    # The bearer header goes through curl's stdin config (-K -), not argv, so it never shows in ps.
    local_org_code="$(
      printf 'header = "Authorization: Bearer %s"\n' "$admin_session_token" \
        | curl -sS -K - --max-time 30 -o "$local_org_response_file" -w '%{http_code}' \
          -X POST "${api}${LOCAL_ORG_ROUTE_PATH}" \
          -H 'Content-Type: application/json' \
          --data "$local_org_body" || true
    )"
    rm -f "$local_org_response_file"
    # No HTTP response at all (connection refused / timeout) is reported as HTTP 000 by both twins.
    [[ "$local_org_code" =~ ^[1-9][0-9][0-9]$ ]] || local_org_code="000"

    postcondition_counts="$(local_org_read_counts "$LOCAL_ORG_POSTCONDITION_SQL" "read-only postcondition check")" \
      || local_org_die "the route returned HTTP ${local_org_code} and the read-only postcondition check failed; the org state is UNKNOWN -- inspect it before re-running"
    if [[ ! "$postcondition_counts" =~ ^[0-9]+:[0-9]+:[0-9]+$ ]]; then
      local_org_die "the route returned HTTP ${local_org_code} and the read-only postcondition check returned an unexpected shape; the org state is UNKNOWN -- inspect it before re-running"
    fi
    IFS=':' read -r post_anchors post_admin_memberships post_admin_default <<<"$postcondition_counts"

    if [[ "$postcondition_counts" == "1:1:1" ]]; then
      if [[ "$local_org_code" == "200" ]]; then
        local_org_info "OK: local org anchor and admin membership created (one active anchor, exactly one active membership)"
      else
        local_org_info "the route returned HTTP ${local_org_code}, but the local org anchor and the admin membership are already complete (one active anchor, exactly one active membership; another run may have created them); nothing else was written"
      fi
    elif [[ "$postcondition_counts" == "0:0:0" ]]; then
      local_org_die "the route returned HTTP ${local_org_code}; no anchor and no membership were written (safe to re-run)"
    elif (( post_anchors >= 1 && post_admin_memberships == 0 )); then
      local_org_die "the route returned HTTP ${local_org_code} and left a PARTIAL state (anchors=${post_anchors}, admin memberships=0); a re-run will not repair it -- complete it by calling POST /api/admin/directory/local/accounts for the admin manually"
    else
      local_org_die "the route returned HTTP ${local_org_code} and left an unexpected org state (anchors=${post_anchors}, admin memberships=${post_admin_memberships}, in default=${post_admin_default}); inspect it before re-running"
    fi
  fi
fi

info "Admin bootstrap OK (email=${ADMIN_EMAIL}, user_id=${admin_user_id})"
