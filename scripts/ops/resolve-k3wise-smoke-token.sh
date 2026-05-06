#!/usr/bin/env bash
set -euo pipefail

output_env="${K3_WISE_TOKEN_OUTPUT_ENV:-K3_WISE_SMOKE_TOKEN}"
required="${K3_WISE_TOKEN_RESOLVE_REQUIRED:-false}"
secret_token="${METASHEET_K3WISE_SMOKE_TOKEN_SECRET:-${METASHEET_K3WISE_SMOKE_TOKEN:-}}"
tenant_id="${METASHEET_TENANT_ID:-${TENANT_ID:-}}"
token_expiry="${K3_WISE_SMOKE_TOKEN_EXPIRY:-2h}"
auto_discover_tenant="${K3_WISE_TOKEN_AUTO_DISCOVER_TENANT:-false}"
deploy_path="${DEPLOY_PATH:-metasheet2}"
deploy_compose_file="${DEPLOY_COMPOSE_FILE:-docker-compose.app.yml}"

is_truthy() {
  case "$1" in
    true|TRUE|True|1|yes|YES|Yes)
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

write_resolved_tenant() {
  local resolved_tenant_id="$1"
  local source="$2"
  if [[ -z "${resolved_tenant_id}" ]]; then
    return 0
  fi
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "K3_WISE_SMOKE_TENANT_ID=${resolved_tenant_id}" >> "${GITHUB_ENV}"
    echo "K3 WISE smoke tenant scope resolved from ${source}: ${resolved_tenant_id}"
  else
    echo "K3 WISE smoke tenant scope resolved from ${source}: ${resolved_tenant_id}; GITHUB_ENV is not set"
  fi
}

shell_quote() {
  printf '%q' "$1"
}

cleanup_tmp_key() {
  if [[ -n "${tmp_ssh_key:-}" && -f "${tmp_ssh_key}" ]]; then
    rm -f "${tmp_ssh_key}"
  fi
}

if [[ -n "${secret_token}" ]]; then
  write_resolved_tenant "${tenant_id}" "METASHEET_TENANT_ID"
  write_token "${secret_token}" "METASHEET_K3WISE_SMOKE_TOKEN"
  exit 0
fi

if [[ -z "${tenant_id}" ]] && ! is_truthy "${auto_discover_tenant}"; then
  warn_or_fail "METASHEET_K3WISE_SMOKE_TOKEN is not set and METASHEET_TENANT_ID is empty; deploy-host token fallback needs an explicit tenant scope (or K3_WISE_TOKEN_AUTO_DISCOVER_TENANT=true for singleton integration tenant auto-discovery)"
fi

if [[ -z "${DEPLOY_HOST:-}" || -z "${DEPLOY_USER:-}" || -z "${DEPLOY_SSH_KEY_B64:-}" ]]; then
  if [[ -z "${tenant_id}" ]]; then
    warn_or_fail "METASHEET_K3WISE_SMOKE_TOKEN is not set and METASHEET_TENANT_ID is empty; deploy-host token fallback needs an explicit tenant scope or deploy SSH inputs for singleton tenant auto-discovery"
  fi
  warn_or_fail "METASHEET_K3WISE_SMOKE_TOKEN is not set and DEPLOY_HOST/DEPLOY_USER/DEPLOY_SSH_KEY_B64 are incomplete"
fi

tmp_ssh_key="$(mktemp "${TMPDIR:-/tmp}/k3wise-smoke-ssh-key.XXXXXX")"
trap cleanup_tmp_key EXIT
if ! printf '%s' "${DEPLOY_SSH_KEY_B64}" | base64 -d > "${tmp_ssh_key}"; then
  warn_or_fail "failed to decode DEPLOY_SSH_KEY_B64 for K3 WISE smoke token fallback"
fi
chmod 600 "${tmp_ssh_key}"

ssh_opts="-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i ${tmp_ssh_key}"
quoted_deploy_path="$(shell_quote "${deploy_path}")"
quoted_compose_file="$(shell_quote "${deploy_compose_file}")"
quoted_tenant_id="$(shell_quote "${tenant_id}")"
quoted_token_expiry="$(shell_quote "${token_expiry}")"
quoted_auto_discover_tenant="$(shell_quote "${auto_discover_tenant}")"

set +e
token="$(
  ssh ${ssh_opts} "${DEPLOY_USER}@${DEPLOY_HOST}" \
    "DEPLOY_PATH=${quoted_deploy_path} DEPLOY_COMPOSE_FILE=${quoted_compose_file} K3_WISE_SMOKE_TENANT_ID=${quoted_tenant_id} K3_WISE_SMOKE_TOKEN_EXPIRY=${quoted_token_expiry} K3_WISE_SMOKE_TENANT_AUTO_DISCOVER=${quoted_auto_discover_tenant} bash -s" <<'EOF'
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
  K3_WISE_SMOKE_TENANT_AUTO_DISCOVER="${K3_WISE_SMOKE_TENANT_AUTO_DISCOVER:-false}" \
  JWT_EXPIRY="${K3_WISE_SMOKE_TOKEN_EXPIRY:-2h}" \
  node --input-type=module - <<'NODE'
import pg from 'pg'
import { authService } from '/app/packages/core-backend/dist/src/auth/AuthService.js'

const configuredTenantId = String(process.env.K3_WISE_SMOKE_TENANT_ID || '').trim()
const autoDiscoverTenant = /^(true|1|yes)$/i.test(String(process.env.K3_WISE_SMOKE_TENANT_AUTO_DISCOVER || 'false').trim())

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

async function tableExists(client, tableName) {
  const result = await client.query('SELECT to_regclass($1) AS table_name', [tableName])
  return Boolean(result.rows[0]?.table_name)
}

async function collectTenantIds(client, tableName, extraWhere = '') {
  if (!await tableExists(client, tableName)) return []
  const result = await client.query(`
    SELECT DISTINCT btrim(tenant_id) AS tenant_id
    FROM ${tableName}
    WHERE tenant_id IS NOT NULL
      AND btrim(tenant_id) <> ''
      ${extraWhere}
    ORDER BY tenant_id ASC
  `)
  return result.rows
    .map((row) => typeof row.tenant_id === 'string' ? row.tenant_id.trim() : '')
    .filter(Boolean)
}

async function inferSingletonTenantId(client) {
  const ids = new Set()
  for (const tenantId of [
    ...await collectTenantIds(client, 'integration_external_systems'),
    ...await collectTenantIds(client, 'integration_pipelines'),
    ...await collectTenantIds(client, 'integration_runs'),
    ...await collectTenantIds(client, 'integration_dead_letters'),
    ...await collectTenantIds(client, 'platform_app_instances', "AND plugin_id = 'plugin-integration-core'"),
  ]) {
    ids.add(tenantId)
  }

  if (ids.size === 1) return Array.from(ids)[0]
  if (ids.size > 1) {
    console.error(`K3 WISE smoke tenant auto-discovery found multiple tenant scopes: ${Array.from(ids).join(', ')}`)
    process.exit(5)
  }
  return ''
}

try {
  await client.connect()
  const tenantId = configuredTenantId || (autoDiscoverTenant ? await inferSingletonTenantId(client) : '')
  if (!tenantId) {
    console.error('K3_WISE_SMOKE_TENANT_ID missing and singleton tenant auto-discovery found no integration tenant scope')
    process.exit(2)
  }

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
  console.log(`K3_WISE_SMOKE_TENANT_ID=${tenantId}`)
  console.log(token)
} finally {
  await client.end().catch(() => {})
}
NODE
EOF
)"
rc=$?
set -e
resolved_tenant_id="$(printf '%s\n' "${token}" | awk -F= '/^K3_WISE_SMOKE_TENANT_ID=/ { value = $0; sub(/^K3_WISE_SMOKE_TENANT_ID=/, "", value); tenant = value } END { if (tenant) print tenant }')"
token="$(printf '%s\n' "${token}" | awk '/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ { found = $0 } END { if (found) print found }')"

if [[ "${rc}" != "0" || -z "${token}" ]]; then
  warn_or_fail "failed to mint temporary K3 WISE smoke token from deploy host"
fi

write_resolved_tenant "${resolved_tenant_id:-${tenant_id}}" "deploy-host backend runtime"
write_token "${token}" "deploy-host backend runtime"
