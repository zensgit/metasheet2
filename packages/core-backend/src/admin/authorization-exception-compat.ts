import { randomUUID } from 'node:crypto'
import { withAuthorizationInputTransaction } from '../rbac/authorization-input-lock'
import { invalidateUserPerms, listUserPermissions } from '../rbac/service'
import { hasLiveRbacAdmin } from '../rbac/strict-principal'
import { writeAuthorizationException, type AuthorizationExceptionAction } from './authorization-exception-write'

export class LegacyExceptionReasonInvalid extends Error {}

export function readLegacyExceptionReason(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new LegacyExceptionReasonInvalid()
  const reason = value.trim()
  if (!reason || Array.from(reason).length > 255) throw new LegacyExceptionReasonInvalid()
  return reason
}

type CompatibilityAction =
  | Exclude<AuthorizationExceptionAction, { kind: 'template.grant' }>
  | { kind: 'template.apply'; templateId: string; codes: string[] }

/** Old clients do not send a preview or operation ID. They share the locked writer and audit transaction. */
export async function writeLegacyAuthorizationException(input: {
  actorId: string
  userId: string
  action: CompatibilityAction
  reason?: string
}) {
  const { actorId, userId, reason } = input
  const action = input.action
  const revoking = action.kind === 'direct.revoke' || action.kind === 'legacy.revoke'
  const result = await withAuthorizationInputTransaction({
    intent: revoking ? 'REVOKE_DIRECT' : 'GRANT_DIRECT',
    userIds: [userId],
    admissionUserIds: [userId],
    witness: { userIds: [actorId], admissionUserIds: [actorId] },
  }, async (tx) => {
    const client = { query: tx.query }
    const witness = action.kind === 'legacy.revoke'
      ? { expectedLegacy: { value: (await tx.query('SELECT to_jsonb(permissions) AS permissions FROM users WHERE id = $1', [userId])).rows[0]?.permissions } }
      : { expectedDirectCodes: (await tx.query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code LIMIT 1001', [userId])).rows.map(row => String(row.permission_code)) }
    const { changedCodes } = await writeAuthorizationException(client, {
      actorId, userId, actor: tx.locked.get(actorId), target: tx.locked.get(userId),
      action: action.kind === 'template.apply' ? { kind: 'template.grant', codes: action.codes } : action,
      ...witness,
    })
    const profile = action.kind === 'template.apply' ? {
      permissions: await listUserPermissions(userId, tx.query),
      isAdmin: await hasLiveRbacAdmin(tx.query, userId),
    } : null
    if (changedCodes.length > 0) {
      const eventId = randomUUID()
      const storedAction = action.kind === 'template.apply' ? { kind: action.kind, templateId: action.templateId } : action
      const request = { targetUserId: userId, action: storedAction, admissionChanges: [] }
      const impact = {
        sourceChanges: changedCodes.map(code => ({ source: action.kind === 'legacy.revoke' ? 'legacy' : 'direct', id: code, operation: revoking ? 'revoke' : 'assign', changed: true })),
        admissionChanges: [], scopeCleanup: [], effectiveBefore: [], effectiveAfter: [], retainedOtherGrants: [],
        warnings: ['legacy_no_preview'],
      }
      await tx.query(`INSERT INTO authorization_operation_receipts
        (actor_id, client_operation_id, request_digest, expected_version, target_user_id, action, receipt)
        VALUES ($1, $2::uuid, 'legacy', 'legacy', $3, $4::jsonb, $5::jsonb)`,
      [actorId, eventId, userId, JSON.stringify(request), JSON.stringify({ targetUserId: userId, action: storedAction, impact, resultVersion: 'legacy' })])
      await tx.query(`INSERT INTO authorization_operation_audit (actor_id, client_operation_id, reason, reason_origin, impact)
        VALUES ($1, $2::uuid, $3, $4, $5::jsonb)`,
      [actorId, eventId, reason ?? null, reason === undefined ? 'legacy_unprovided' : 'provided', JSON.stringify(impact)])
    }
    return { changed: changedCodes.length > 0, profile }
  })
  if (result.changed) invalidateUserPerms(userId)
  return result
}
