#!/usr/bin/env bash
set -euo pipefail

output_env="${K3_WISE_TOKEN_OUTPUT_ENV:-K3_WISE_SMOKE_TOKEN}"
required="${K3_WISE_TOKEN_RESOLVE_REQUIRED:-false}"
secret_token="${METASHEET_K3WISE_SMOKE_TOKEN_SECRET:-${METASHEET_K3WISE_SMOKE_TOKEN:-}}"
tenant_id="${METASHEET_TENANT_ID:-${TENANT_ID:-}}"
token_expiry="${K3_WISE_SMOKE_TOKEN_EXPIRY:-2h}"
deploy_path="${DEPLOY_PATH:-metasheet2}"
deploy_compose_file="${DEPLOY_COMPOSE_FILE:-docker-compose.app.yml}"

is_required() {
  case "${required}" in
    true|TRUE|True|1|yes|YES|Yes)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
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

write_token() {
  local token="$1"
  local source="$2"
  if [[ -z "${token}" ]]; then
    return 1
  fi
  echo "::add-mask::${token}"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    {
      echo "${output_env}<<EOF"
      echo "${token}"
      echo "EOF"
    } >> "${GITHUB_ENV}"
    echo "K3 WISE smoke token resolved from ${source}"
  else
    echo "K3 WISE smoke token resolved from ${source}; GITHUB_ENV is not set, token was not printed"
  fi
}

shell_quote() {
  printf '%q' "$1"
}

if [[ -n "${secret_token}" ]]; then
  write_token "${secret_token}" "METASHEET_K3WISE_SMOKE_TOKEN"
  exit 0
fi

if [[ -z "${tenant_id}" ]]; then
  warn_or_fail "METASHEET_K3WISE_SMOKE_TOKEN is not set and METASHEET_TENANT_ID is empty; deploy-host token fallback needs an explicit tenant scope"
fi

if [[ -z "${DEPLOY_HOST:-}" || -z "${DEPLOY_USER:-}" || -z "${DEPLOY_SSH_KEY_B64:-}" ]]; then
  warn_or_fail "METASHEET_K3WISE_SMOKE_TOKEN is not set and DEPLOY_HOST/DEPLOY_USER/DEPLOY_SSH_KEY_B64 are incomplete"
fi

mkdir -p ~/.ssh
if ! printf '%s' "${DEPLOY_SSH_KEY_B64}" | base64 -d > ~/.ssh/deploy_key; then
  warn_or_fail "failed to decode DEPLOY_SSH_KEY_B64 for K3 WISE smoke token fallback"
fi
chmod 600 ~/.ssh/deploy_key

ssh_opts="-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i ~/.ssh/deploy_key"
quoted_deploy_path="$(shell_quote "${deploy_path}")"
quoted_compose_file="$(shell_quote "${deploy_compose_file}")"
quoted_tenant_id="$(shell_quote "${tenant_id}")"
quoted_token_expiry="$(shell_quote "${token_expiry}")"

set +e
token="$(
  ssh ${ssh_opts} "${DEPLOY_USER}@${DEPLOY_HOST}" \
    "DEPLOY_PATH=${quoted_deploy_path} DEPLOY_COMPOSE_FILE=${quoted_compose_file} K3_WISE_SMOKE_TENANT_ID=${quoted_tenant_id} K3_WISE_SMOKE_TOKEN_EXPIRY=${quoted_token_expiry} bash -s" <<'EOF'
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
  env K3_WISE_SMOKE_TENANT_ID="${K3_WISE_SMOKE_TENANT_ID}" \
  JWT_EXPIRY="${K3_WISE_SMOKE_TOKEN_EXPIRY:-2h}" \
  node --input-type=module - <<'NODE' \
  | awk '/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ { token = $0 } END { if (token) print token }'
import pg from 'pg'
import { authService } from '/app/packages/core-backend/dist/src/auth/AuthService.js'

const tenantId = String(process.env.K3_WISE_SMOKE_TENANT_ID || '').trim()
if (!tenantId) {
  console.error('K3_WISE_SMOKE_TENANT_ID missing')
  process.exit(2)
}

const { Client } = pg
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL missing from backend runtime env')
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
      (ur.user_id IS NOT NULL) AS has_rbac_admin
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = 'admin'
    WHERE COALESCE(u.is_active, true) = true
      AND COALESCE(u.must_change_password, false) = false
      AND (u.role = 'admin' OR ur.user_id IS NOT NULL)
    ORDER BY
      CASE WHEN ur.user_id IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN u.id = 'admin' THEN 0 ELSE 1 END,
      u.created_at ASC
    LIMIT 1
  `)
  const row = result.rows[0]
  if (!row) {
    console.error('No active admin user found for K3 WISE smoke token')
    process.exit(4)
  }

  const token = authService.createToken({
    id: String(row.id),
    email: typeof row.email === 'string' ? row.email : '',
    username: row.username ?? null,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : 'K3 WISE Smoke Admin',
    mobile: row.mobile ?? null,
    role: row.has_rbac_admin ? 'admin' : (typeof row.role === 'string' && row.role.trim() ? row.role : 'admin'),
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    tenantId,
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

if [[ "${rc}" != "0" || -z "${token}" ]]; then
  warn_or_fail "failed to mint temporary K3 WISE smoke token from deploy host"
fi

write_token "${token}" "deploy-host backend runtime"
