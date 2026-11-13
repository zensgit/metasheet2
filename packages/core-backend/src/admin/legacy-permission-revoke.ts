import {
  AccessGraphUserUnavailableError,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
  type AccessGraphTransactionClient,
} from '../directory/access-graph-mutex'
import {
  assertPlatformActorAuthority,
  lockSharedAccessSubjects,
} from './platform-actor-authority'

export type LegacyPermissionRevokeResult = {
  changed: boolean
}

type PermissionWriteResult = {
  rows: Array<Record<string, unknown>>
  rowCount?: number | null
}

/**
 * Drop every array element whose trimmed text equals `permission`.
 * Nulls and every other non-matching value stay, in order. A non-array,
 * including a JSON string that merely looks like an array, is not a change.
 */
export function removeMatchingLegacyPermission(
  value: unknown,
  permission: string,
): { next: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { next: value, changed: false }
  const target = permission.trim()
  let changed = false
  const next: unknown[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() === target) {
      changed = true
      continue
    }
    next.push(item)
  }
  return { next, changed }
}

function acknowledgedLegacyWrite(result: PermissionWriteResult, userId: string): boolean {
  return result.rowCount === 1
    && result.rows.length === 1
    && String(result.rows[0]?.id ?? '') === userId
}

/**
 * Remove one legacy code from `users.permissions` and nothing else.
 *
 * This writer does not touch roles, so it does not pre-read or FOR SHARE
 * lock them. It locks the actor and target through lockSharedAccessSubjects,
 * then requires the locked actor to be active, activated, not recycled, and
 * to hold a live user_roles admin membership. users.role, is_admin, and a
 * token claim are not authority. The target may be inactive or pending.
 * A missing or recycled target is refused.
 *
 * `to_jsonb(permissions)` is already decoded by the driver. A scalar is left
 * unchanged: inspection never treats it as grants, even when the scalar text
 * is itself an encoded JSON array. JSONB and text[] are written back with the
 * matching cast, and text[] keeps null elements. Any other pg_typeof throws
 * and writes nothing. changed is true only after RETURNING id with rowCount 1.
 * A no-match or a zero-row update does not supersede evidence.
 */
export async function revokeLegacyUserPermission(
  client: AccessGraphTransactionClient,
  options: { actorId: string; userId: string; permission: string },
): Promise<LegacyPermissionRevokeResult> {
  const actorId = options.actorId.trim()
  const userId = options.userId.trim()
  const permission = options.permission.trim()
  if (!actorId || !userId || !permission) {
    throw new Error('legacy permission revoke requires actorId, userId, and permission')
  }

  const subjects = await lockSharedAccessSubjects(client, [actorId, userId])
  const target = subjects.get(userId)
  if (!target) throw new AccessGraphUserUnavailableError('NOT_FOUND')
  if (target.deletedAt || target.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')
  await assertPlatformActorAuthority(client, subjects.get(actorId), {
    requireLiveRbacAdmin: true,
  })

  const inspected = await client.query(
    `SELECT pg_typeof(permissions)::text AS permissions_type,
            to_jsonb(permissions) AS permissions
       FROM users
      WHERE id = $1`,
    [userId],
  )
  const row = inspected.rows[0]
  if (!row) throw new AccessGraphUserUnavailableError('NOT_FOUND')
  const columnType = String(row.permissions_type ?? '')
  if (columnType !== 'jsonb' && columnType !== 'text[]') {
    throw new Error('unsupported users.permissions type')
  }
  const removed = removeMatchingLegacyPermission(row.permissions, permission)
  if (!removed.changed || !Array.isArray(removed.next)) return { changed: false }

  let updated: PermissionWriteResult
  if (columnType === 'jsonb') {
    updated = await client.query(
      `UPDATE users
          SET permissions = $2::jsonb
        WHERE id = $1
          AND pg_typeof(permissions)::text = 'jsonb'
        RETURNING id`,
      [userId, JSON.stringify(removed.next)],
    ) as PermissionWriteResult
  } else {
    if (removed.next.some((item) => item !== null && typeof item !== 'string')) {
      throw new Error('unsupported users.permissions type')
    }
    updated = await client.query(
      `UPDATE users
          SET permissions = $2::text[]
        WHERE id = $1
          AND pg_typeof(permissions)::text = 'text[]'
        RETURNING id`,
      [userId, removed.next],
    ) as PermissionWriteResult
  }
  if (!acknowledgedLegacyWrite(updated, userId)) return { changed: false }

  await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
    userIds: [userId],
    actorId,
    reason: 'superseded by administrator legacy permission revoke',
  })
  return { changed: true }
}
