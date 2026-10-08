#!/usr/bin/env bash
set -euo pipefail

required="${ATTENDANCE_TOKEN_RESOLVE_REQUIRED:-false}"
token_expiry="${ATTENDANCE_SMOKE_TOKEN_EXPIRY:-2h}"
smoke_org_id="${ATTENDANCE_SMOKE_ORG_ID:-}"
deploy_path="${DEPLOY_PATH:-metasheet2}"
deploy_compose_file="${DEPLOY_COMPOSE_FILE:-docker-compose.app.yml}"

is_truthy() {
  case "${1:-}" in
    true|TRUE|True|1|yes|YES|Yes|on|ON|On)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_required() {
  is_truthy "${required}"
}

warn_or_fail() {
  local message="$1"
  if is_required; then
    echo "::error::${message}" >&2
    exit 1
  fi
  echo "::warning::${message}" >&2
  exit 0
}

is_compact_jwt() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]
}

shell_quote() {
  printf '%q' "$1"
}

tmp_ssh_key=""
tmp_known_hosts=""

cleanup_tmp_key() {
  if [[ -n "${tmp_ssh_key}" && -f "${tmp_ssh_key}" ]]; then
    rm -f "${tmp_ssh_key}"
  fi
  if [[ -n "${tmp_known_hosts}" && -f "${tmp_known_hosts}" ]]; then
    rm -f "${tmp_known_hosts}"
  fi
}

if [[ -z "${DEPLOY_HOST:-}" || -z "${DEPLOY_USER:-}" || -z "${DEPLOY_SSH_KEY_B64:-}" ]]; then
  warn_or_fail "ATTENDANCE_ADMIN_JWT is invalid and DEPLOY_HOST/DEPLOY_USER/DEPLOY_SSH_KEY_B64 are incomplete for deploy-host token fallback"
fi

if [[ -z "${smoke_org_id}" ]]; then
  warn_or_fail "ATTENDANCE_SMOKE_ORG_ID is required for deploy-host token fallback"
fi

# Host-key pinning (fail-closed): the SSH fallback must verify the deploy-host
# identity, so DEPLOY_KNOWN_HOSTS is required BEFORE any ssh attempt.
if [[ -z "${DEPLOY_KNOWN_HOSTS:-}" ]]; then
  warn_or_fail "DEPLOY_KNOWN_HOSTS is required to pin the deploy-host identity for the Attendance smoke token fallback"
fi

tmp_ssh_key="$(mktemp "${TMPDIR:-/tmp}/attendance-smoke-ssh-key.XXXXXX")"
trap cleanup_tmp_key EXIT
if ! printf '%s' "${DEPLOY_SSH_KEY_B64}" | base64 -d > "${tmp_ssh_key}"; then
  warn_or_fail "failed to decode DEPLOY_SSH_KEY_B64 for Attendance smoke token fallback"
fi
chmod 600 "${tmp_ssh_key}"

tmp_known_hosts="$(mktemp "${TMPDIR:-/tmp}/attendance-smoke-known-hosts.XXXXXX")"
decoded_known_hosts="$(printf '%s' "${DEPLOY_KNOWN_HOSTS}" | base64 -d 2>/dev/null || true)"
if printf '%s' "${decoded_known_hosts}" | grep -Eq 'ssh-ed25519|ssh-rsa|ecdsa-sha2|ssh-dss'; then
  printf '%s\n' "${decoded_known_hosts}" > "${tmp_known_hosts}"
elif printf '%s' "${DEPLOY_KNOWN_HOSTS}" | grep -Eq 'ssh-ed25519|ssh-rsa|ecdsa-sha2|ssh-dss'; then
  printf '%s\n' "${DEPLOY_KNOWN_HOSTS}" > "${tmp_known_hosts}"
else
  warn_or_fail "DEPLOY_KNOWN_HOSTS did not resolve to a recognizable key"
fi

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${tmp_known_hosts}" -o GlobalKnownHostsFile=/dev/null -o IdentitiesOnly=yes -i "${tmp_ssh_key}")
quoted_deploy_path="$(shell_quote "${deploy_path}")"
quoted_compose_file="$(shell_quote "${deploy_compose_file}")"
quoted_token_expiry="$(shell_quote "${token_expiry}")"
quoted_smoke_org_id="$(shell_quote "${smoke_org_id}")"

set +e
token="$(
  ssh "${ssh_opts[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" \
    "DEPLOY_PATH=${quoted_deploy_path} DEPLOY_COMPOSE_FILE=${quoted_compose_file} ATTENDANCE_SMOKE_TOKEN_EXPIRY=${quoted_token_expiry} ATTENDANCE_SMOKE_ORG_ID=${quoted_smoke_org_id} bash -s" \
    2>/dev/null <<'EOF'
set -euo pipefail
if [[ "${DEPLOY_PATH}" == /* ]]; then
  DEPLOY_REPO_PATH="${DEPLOY_PATH}"
elif [[ "${DEPLOY_PATH}" == ~/* ]]; then
  DEPLOY_REPO_PATH="${HOME}/${DEPLOY_PATH#~/}"
else
  DEPLOY_REPO_PATH="${HOME}/${DEPLOY_PATH}"
fi
cd "${DEPLOY_REPO_PATH}"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "docker compose is not available" >&2
  exit 125
fi

"${COMPOSE_CMD[@]}" -f "${DEPLOY_COMPOSE_FILE}" exec -T backend \
  env JWT_EXPIRY="${ATTENDANCE_SMOKE_TOKEN_EXPIRY:-2h}" \
  ATTENDANCE_SMOKE_ORG_ID="${ATTENDANCE_SMOKE_ORG_ID}" \
  node --input-type=module - <<'NODE'
import pg from 'pg'
import { authService } from '/app/packages/core-backend/dist/src/auth/AuthService.js'

const { Client } = pg
const databaseUrl = process.env.DATABASE_URL
const organizationId = process.env.ATTENDANCE_SMOKE_ORG_ID
if (!databaseUrl) {
  console.error('DATABASE_URL missing from backend runtime env')
  process.exit(3)
}
if (!organizationId) {
  console.error('ATTENDANCE_SMOKE_ORG_ID missing from backend runtime env')
  process.exit(3)
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
})

try {
  await client.connect()
  const result = await client.query(`
    SELECT
      u.id,
      u.email,
      u.username,
      u.name,
      u.mobile,
      u.role,
      u.permissions,
      u.is_active,
      u.must_change_password,
      uo.org_id AS tenant_id,
      (ur.user_id IS NOT NULL) AS has_rbac_admin
    FROM users u
    JOIN user_orgs uo
      ON uo.user_id = u.id
     AND uo.org_id = $1
     AND uo.is_active = true
    LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = 'admin'
    WHERE u.is_active = true
      AND COALESCE(u.must_change_password, false) = false
      AND (u.role = 'admin' OR ur.user_id IS NOT NULL)
    ORDER BY
      CASE WHEN ur.user_id IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN u.id = 'admin' THEN 0 ELSE 1 END,
      u.created_at ASC
    LIMIT 1
  `, [organizationId])
  const row = result.rows[0]
  if (!row || row.tenant_id !== organizationId) {
    console.error('No active admin membership found for Attendance smoke token')
    process.exit(4)
  }

  const token = authService.createToken({
    id: String(row.id),
    email: typeof row.email === 'string' ? row.email : '',
    username: row.username ?? null,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : 'Attendance Smoke Admin',
    mobile: row.mobile ?? null,
    role: row.has_rbac_admin ? 'admin' : (typeof row.role === 'string' && row.role.trim() ? row.role : 'admin'),
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    tenantId: organizationId,
    is_active: row.is_active,
    must_change_password: row.must_change_password,
    created_at: new Date(),
    updated_at: new Date(),
  })
  console.log(token)
} finally {
  await client.end().catch(() => {})
}
NODE
EOF
)"
rc=$?
set -e
token="$(printf '%s\n' "${token}" | awk '/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ { found = $0 } END { if (found) print found }')"

if [[ "${rc}" != "0" || -z "${token}" ]]; then
  warn_or_fail "failed to mint temporary Attendance smoke token from deploy host"
fi

if ! is_compact_jwt "${token}"; then
  warn_or_fail "deploy-host Attendance smoke token was not a compact JWT"
fi

echo "[resolve-attendance-smoke-token] token minted from deploy-host backend runtime" >&2
printf '%s' "${token}"
