import {
  lockUsersForAccessGraphWrite,
  type AccessGraphTransactionClient,
  type LockedAccessGraphUser,
} from '../directory/access-graph-mutex'
import { lockNamespaceAdmissionWrites } from '../rbac/namespace-admission'

const PLATFORM_ADMIN_ROLE_ID = 'admin'

/**
 * The locked actor is no longer a platform administrator.
 * A token claim is not authority: this is raised only from the database row and `user_roles`.
 */
export class PlatformActorAuthorityLost extends Error {
  readonly code = 'FORBIDDEN'
  constructor() {
    super('Admin access required')
    this.name = 'PlatformActorAuthorityLost'
  }
}

function sortedAccessIds(ids: Array<string | null | undefined>): string[] {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))).sort()
}

/**
 * Admission locks, then user-row locks, both in sorted id order.
 * Call only after any role-row lock. Do not lock users before roles.
 */
export async function lockSharedAccessSubjects(
  client: AccessGraphTransactionClient,
  ids: Array<string | null | undefined>,
): Promise<Map<string, LockedAccessGraphUser>> {
  const sorted = sortedAccessIds(ids)
  for (const id of sorted) await lockNamespaceAdmissionWrites(client, id)
  return lockUsersForAccessGraphWrite(client, sorted)
}

/**
 * Default platform authority is `users.role = 'admin'` or the RBAC `admin` role.
 * Attendance, admin-user, and scope callers keep that default.
 * `requireLiveRbacAdmin` is the permission-management contract: a live `user_roles`
 * admin membership on this locked row. `users.role`, `is_admin`, and token claims
 * are not enough. The caller must already hold `actor`'s row lock.
 */
export async function assertPlatformActorAuthority(
  client: AccessGraphTransactionClient,
  actor: LockedAccessGraphUser | undefined,
  options?: { requireLiveRbacAdmin?: boolean },
): Promise<void> {
  if (!actor || actor.deletedAt || actor.purgedAt || actor.isActive !== true || actor.activationStatus !== 'activated') {
    throw new PlatformActorAuthorityLost()
  }
  const roles = await client.query(
    `SELECT role_id
     FROM user_roles
     WHERE user_id = $1
     ORDER BY role_id ASC`,
    [actor.id],
  )
  const roleIds = roles.rows
    .map((row) => row.role_id)
    .filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0)
  const hasLiveRbacAdmin = roleIds.includes(PLATFORM_ADMIN_ROLE_ID)
  if (options?.requireLiveRbacAdmin === true) {
    if (!hasLiveRbacAdmin) throw new PlatformActorAuthorityLost()
    return
  }
  if (actor.role !== 'admin' && !hasLiveRbacAdmin) {
    throw new PlatformActorAuthorityLost()
  }
}
