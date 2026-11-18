import { randomUUID } from 'node:crypto'
import { withAuthorizationInputTransaction } from '../rbac/authorization-input-lock'
import { invalidateUserPerms, listUserPermissions } from '../rbac/service'
import { hasLiveRbacAdmin } from '../rbac/strict-principal'
import { AuthorizationExceptionWriteError, writeAuthorizationException, type AuthorizationExceptionAction } from './authorization-exception-write'

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
  if (!actorId || !userId || actorId !== actorId.trim() || userId !== userId.trim()) throw new AuthorizationExceptionWriteError('INVALID_INPUT')
  const action = input.action.kind === 'template.apply'
    ? Object.freeze({ ...input.action, codes: Object.freeze([...input.action.codes]) })
    : Object.freeze({ ...input.action })
  const revoking = action.kind === 'direct.revoke' || action.kind === 'legacy.revoke'
  const subjects = Object.freeze([...new Set([actorId, userId])].sort())
  const plan = Object.freeze({
    intent: revoking ? 'REVOKE_DIRECT' as const : 'GRANT_DIRECT' as const,
    roleIds: Object.freeze([] as string[]),
    userIds: subjects,
    admissionUserIds: subjects,
    witness: Object.freeze({ userIds: subjects, admissionUserIds: subjects }),
  })
  const result = await withAuthorizationInputTransaction(plan, async (tx) => {
    const { changedCodes } = await writeAuthorizationException(tx, Object.freeze({
      actorId, userId, plan,
      action: action.kind === 'template.apply' ? { kind: 'template.grant' as const, codes: action.codes } : action,
    }))
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
