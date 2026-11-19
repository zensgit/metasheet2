import { filterEnabledDelegationNamespaces } from './delegated-scope-activation'
import { isUserWithinDelegatedScope as checkDelegatedAudience } from './authorization-operation-audience'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import { query } from '../db/pg'
import type {
  AccessGraphTransactionClient,
  LockedAccessGraphUser,
} from '../directory/access-graph-mutex'
import { deriveDelegatedAdminNamespace } from '../rbac/namespace-admission'

export class DelegationAuthorityRefusal extends Error {
  constructor(public readonly code: 'ROLE_DELEGATION_FORBIDDEN' | 'ROLE_DELEGATION_SCOPE_REQUIRED' | 'ROLE_DELEGATION_USER_OUT_OF_SCOPE') {
    super(code === 'ROLE_DELEGATION_FORBIDDEN'
      ? 'Namespace is outside your delegated admin scope'
      : code === 'ROLE_DELEGATION_SCOPE_REQUIRED'
        ? 'No delegated department or member-group scope is configured for your plugin admin role'
        : 'User is outside your delegated department or member-group scope')
    this.name = 'DelegationAuthorityRefusal'
  }
}

type RoleIdExecutor = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ role_id?: string | null }> }>
}

export async function fetchUserRoleIds(userId: string, executor?: RoleIdExecutor): Promise<string[]> {
  const sql = `SELECT role_id
     FROM user_roles
     WHERE user_id = $1
     ORDER BY role_id ASC`
  const result = executor
    ? await executor.query(sql, [userId])
    : await query<{ role_id: string }>(sql, [userId])
  return result.rows.map((row) => row.role_id).filter((roleId): roleId is string => Boolean(roleId))
}

export function deriveDelegableNamespaces(roleIds: string[]): string[] {
  return Array.from(new Set(
    roleIds
      .map((roleId) => deriveDelegatedAdminNamespace(roleId))
      .filter((namespace): namespace is string => Boolean(namespace)),
  )).sort()
}

export async function isUserWithinDelegatedScope(
  adminUserId: string,
  namespaces: string[],
  userId: string,
  runQuery: AccessGraphTransactionClient['query'] = query,
): Promise<boolean> {
  return checkDelegatedAudience(adminUserId, namespaces, userId, runQuery)
}

export async function recheckDelegatedAuthority(
  client: AccessGraphTransactionClient,
  actorId: string,
  userId: string,
  requestedNamespaces: string[],
  actor: LockedAccessGraphUser | undefined,
): Promise<string[]> {
  if (!actor || evaluateUserAuthenticationGate({
    role: actor.role,
    is_active: actor.isActive,
    activation_status: actor.activationStatus,
    deleted_at: actor.deletedAt,
    purged_at: actor.purgedAt,
  })) {
    throw new DelegationAuthorityRefusal('ROLE_DELEGATION_FORBIDDEN')
  }
  const namespaces = await filterEnabledDelegationNamespaces(
    client.query, actorId, deriveDelegableNamespaces(await fetchUserRoleIds(actorId, client as unknown as RoleIdExecutor)),
  )
  const matching = requestedNamespaces.filter((namespace) => namespaces.includes(namespace))
  if (matching.length === 0) throw new DelegationAuthorityRefusal('ROLE_DELEGATION_FORBIDDEN')
  const audience = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM delegated_role_admin_scopes WHERE admin_user_id = $1 AND namespace = ANY($2::text[])
       UNION ALL
       SELECT 1 FROM delegated_role_admin_member_groups WHERE admin_user_id = $1 AND namespace = ANY($2::text[])
     ) AS configured`,
    [actorId, namespaces],
  )
  if (audience.rows[0]?.configured !== true) throw new DelegationAuthorityRefusal('ROLE_DELEGATION_SCOPE_REQUIRED')
  if (!await isUserWithinDelegatedScope(actorId, matching, userId, client.query)) {
    throw new DelegationAuthorityRefusal('ROLE_DELEGATION_USER_OUT_OF_SCOPE')
  }
  return namespaces
}
