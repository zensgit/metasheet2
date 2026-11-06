/**
 * R-69 1b-ii — the LIVE principal check behind the `run_integration_job` port call (ADR
 * adr-automation-pipeline-bridge-20261103 §6.1 ①③, §6.2, §6.4; design baseline v2.3 §10.2.2 ②).
 *
 * Core builds the port's principal context from a committed READ COMMITTED transaction that locks the bound
 * principal's authority rows FOR SHARE in the order automation-live-authority.ts established
 * (user_roles → role_permissions → user_permissions → users → user_orgs), then COMMITS, then calls the port —
 * the locks never span the port call (the accepted revoke-after-commit window, same as the YiDa runtimes).
 *
 * WHAT IS DECIDED HERE (and only here): membership and the automation capability —
 *   - the `users` row exists, is active and passes the authentication gate;
 *   - `user_orgs` has EXACTLY ONE active row for (principalId, binding.tenantId) — the tenant is DERIVED from the
 *     binding by this rule, never read from a header or a request field;
 *   - canManageAutomation: platform admin (an `admin` row in user_roles) or any `workflow:all|write|create|execute`
 *     code — the same rule the rule-create route applies (multitable/access.ts).
 * WHAT IS NOT DECIDED HERE: the job permission itself (PULL ladder or legacy `integration:write/admin`,
 * `requireTableActionAccess`). That stays in the plugin's governed entry — ONE chain, two callers (ADR §2 ③);
 * core only hands it the SAME permission codes the HTTP path would carry.
 *
 * PERMISSION CODES come from the request path's own resolver, `listUserPermissions(userId, runQuery)` on the
 * transaction (rbac/service.ts): `user_permissions ∪ role_permissions ∪ users.permissions`, then the namespace
 * admission filter — so a stock-prep code granted directly (not via a role + the enabled `stock-prep`
 * namespace) is dropped on the port exactly as on HTTP (R-66 ③). NOT the unfiltered union of
 * assertAutomationIntegrationActor, and NOT that function's admin/integration:admin gate (narrower than §6.1 ②).
 *
 * `role` / `roles`: the plugin's `hasPermission` reads `role:${user.role}` and `role:${roles[i]}`; admin is
 * derived from the LOCKED user_roles rows (never users.is_admin), the fallback role is the users row's own.
 *
 * OUTCOMES are closed and values-free: `principal_unauthorized` (definite: inactive / no single membership /
 * no automation capability — never retried) vs `authority_unavailable` (the read itself failed — retryable).
 */
import type { IntegrationRunPrincipalContext, IntegrationRunPrincipalUser } from '../core/integration-run-port'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import { listUserPermissions } from '../rbac/service'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

export type IntegrationRunPrincipalResolution =
  | { ok: true; user: IntegrationRunPrincipalUser }
  | { ok: false; reason: 'principal_unauthorized' | 'authority_unavailable' }

const AUTOMATION_CAPABILITY_CODES: ReadonlySet<string> = new Set(['workflow:all', 'workflow:write', 'workflow:create', 'workflow:execute'])

function codesOf(rows: Array<Record<string, unknown>>, column: string): string[] {
  return rows.flatMap((row) => (typeof row[column] === 'string' && (row[column] as string).trim() ? [(row[column] as string).trim()] : []))
}

/**
 * Resolve the bound principal on `trx` (an OPEN read-committed transaction the caller commits right after).
 * The caller passes a `runQuery` wrapper of the same transaction for the RBAC resolver.
 */
export async function resolveIntegrationRunPrincipalOnTransaction(
  trx: Queryable,
  binding: { principalId: string; tenantId: string },
): Promise<IntegrationRunPrincipalResolution> {
  let roles: Array<Record<string, unknown>>
  let users: Array<Record<string, unknown>>
  let memberships: Array<Record<string, unknown>>
  let permissions: string[]
  try {
    // Lock order (automation-live-authority.ts): user_roles → role_permissions → user_permissions → users → user_orgs.
    roles = (await trx.query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id FOR SHARE', [binding.principalId])).rows
    const roleIds = [...new Set(codesOf(roles, 'role_id'))].sort()
    if (roleIds.length > 0) {
      await trx.query('SELECT role_id, permission_code FROM role_permissions WHERE role_id = ANY($1::text[]) ORDER BY role_id, permission_code FOR SHARE', [roleIds])
    }
    await trx.query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code FOR SHARE', [binding.principalId])
    users = (await trx.query(
      'SELECT id, role, is_active, activation_status, deleted_at, purged_at FROM users WHERE id = $1 FOR SHARE',
      [binding.principalId],
    )).rows
    memberships = (await trx.query(
      'SELECT user_id, org_id, is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2 ORDER BY org_id FOR SHARE',
      [binding.principalId, binding.tenantId],
    )).rows
    // The request path's resolver, on THIS transaction (namespace-admission filtered, uncached).
    permissions = await listUserPermissions(binding.principalId, (sqlText, params) => trx.query(sqlText, params))
  } catch {
    return { ok: false, reason: 'authority_unavailable' }
  }

  const user = users[0]
  const isAdmin = roles.some((row) => row.role_id === 'admin')
  const fallbackRole = typeof user?.role === 'string' ? user.role : null
  const effectiveRole = isAdmin ? 'admin' : fallbackRole
  if (users.length !== 1 || user?.id !== binding.principalId || user.is_active !== true) {
    return { ok: false, reason: 'principal_unauthorized' }
  }
  const gate = evaluateUserAuthenticationGate({
    role: effectiveRole,
    is_active: user.is_active,
    activation_status: typeof user.activation_status === 'string' ? user.activation_status : null,
    deleted_at: user.deleted_at as never,
    purged_at: user.purged_at as never,
  })
  if (gate !== null) return { ok: false, reason: 'principal_unauthorized' }
  if (memberships.length !== 1 || memberships[0]?.user_id !== binding.principalId
    || memberships[0]?.org_id !== binding.tenantId || memberships[0]?.is_active !== true) {
    return { ok: false, reason: 'principal_unauthorized' }
  }
  const codes = [...new Set(permissions.map((code) => String(code).trim()).filter(Boolean))].sort()
  const canManageAutomation = isAdmin || codes.some((code) => AUTOMATION_CAPABILITY_CODES.has(code))
  if (!canManageAutomation) return { ok: false, reason: 'principal_unauthorized' }

  return {
    ok: true,
    user: {
      id: binding.principalId,
      permissions: codes,
      roles: isAdmin ? ['admin'] : [],
      role: effectiveRole,
      tenantId: binding.tenantId,
    },
  }
}

/**
 * The port's principal context for ONE job unit (ADR §6.4): exactly the six request-shaped fields the plugin's
 * governed chain reads. `authenticatedTenantId` and `user.tenantId` are the binding's tenant BY DERIVATION
 * (the membership rule above); `query` / `params` are empty (no request, no header, no tenant steering) so
 * `isTenantlessPlatformAdmin` is false by construction and `collectExplicitTenantIds` is empty; the project
 * number rides in `body.parameters` where the governed chain reads it.
 */
export function buildIntegrationRunPrincipalContext(
  user: IntegrationRunPrincipalUser,
  body: Record<string, unknown>,
): IntegrationRunPrincipalContext {
  const principal: IntegrationRunPrincipalUser = {
    id: user.id,
    permissions: [...user.permissions],
    roles: [...user.roles],
    role: user.role,
    tenantId: user.tenantId,
  }
  return {
    user: principal,
    authUser: principal,
    authenticatedTenantId: user.tenantId,
    query: {},
    params: {},
    body,
  }
}
