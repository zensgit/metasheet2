import { AccessGraphUserUnavailableError, supersedeDeprovisionEvidenceForAccessGraphWrite } from '../directory/access-graph-mutex'
import type { AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { assertPermissionExceptionRoot, type PermissionExceptionRoot } from './direct-permission-authority'

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

/** Caller already holds the actor and target locks and has checked authority. */
export async function revokeLockedLegacyUserPermission(
  tx: AuthorizationInputTx,
  options: PermissionExceptionRoot & { permission: string; expected: { value: unknown } },
): Promise<LegacyPermissionRevokeResult> {
  const { actorId, userId, permission, expected } = options
  assertPermissionExceptionRoot(tx, options, true, true)
  const inspected = await tx.query(
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
  if (JSON.stringify(row.permissions) !== JSON.stringify(expected.value)) {
    throw new Error('AUTHORIZATION_EXCEPTION_STALE')
  }
  const removed = removeMatchingLegacyPermission(row.permissions, permission)
  if (!removed.changed || !Array.isArray(removed.next)) return { changed: false }

  let updated: PermissionWriteResult
  if (columnType === 'jsonb') {
    assertPermissionExceptionRoot(tx, options, true, true)
    updated = await tx.query(
      `UPDATE users
          SET permissions = $2::jsonb
        WHERE id = $1
          AND pg_typeof(permissions)::text = 'jsonb'
          AND to_jsonb(permissions) IS NOT DISTINCT FROM $3::jsonb
        RETURNING id`,
      [userId, JSON.stringify(removed.next), JSON.stringify(row.permissions)],
    ) as PermissionWriteResult
  } else {
    if (removed.next.some((item) => item !== null && typeof item !== 'string')) {
      throw new Error('unsupported users.permissions type')
    }
    assertPermissionExceptionRoot(tx, options, true, true)
    updated = await tx.query(
      `UPDATE users
          SET permissions = $2::text[]
        WHERE id = $1
          AND pg_typeof(permissions)::text = 'text[]'
          AND to_jsonb(permissions) IS NOT DISTINCT FROM $3::jsonb
        RETURNING id`,
      [userId, removed.next, JSON.stringify(row.permissions)],
    ) as PermissionWriteResult
  }
  if (!acknowledgedLegacyWrite(updated, userId)) {
    throw new Error('AUTHORIZATION_EXCEPTION_WRITE_NOT_ACKNOWLEDGED')
  }

  assertPermissionExceptionRoot(tx, options, true, true)
  await supersedeDeprovisionEvidenceForAccessGraphWrite(tx, {
    userIds: [userId],
    actorId,
    reason: 'superseded by administrator legacy permission revoke',
  })
  return { changed: true }
}
