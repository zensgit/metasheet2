import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'
import { AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENTS } from '../rbac/authorization-input-lock'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'
import { PlatformActorAuthorityLost } from './platform-actor-authority'

export type PermissionExceptionRoot = Readonly<{
  actorId: string
  userId: string
  plan: AuthorizationInputPlan
}>

function invalidRoot(): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500, retryable: false, reason: 'permission_exception_root', message: 'Authorization input plan is invalid',
  })
}

export function assertPermissionExceptionRoot(tx: AuthorizationInputTx, context: PermissionExceptionRoot, revoking: boolean, requireRows: boolean): void {
  const { actorId, userId, plan } = context
  assertAuthorizationInputTx(tx, { client: tx, userId })
  const subjects = [...new Set([actorId, userId])].sort()
  const matches = (ids: Iterable<string> | undefined) => {
    const actual = ids === undefined ? [] : [...ids]
    return actual.length === subjects.length && subjects.every(id => actual.includes(id))
  }
  if (!Object.isFrozen(context) || tx.world !== 'shared' || tx.born.size !== 0 || !Object.isFrozen(plan)
    || !Object.isFrozen(plan.userIds) || !Object.isFrozen(plan.admissionUserIds)
    || !Object.isFrozen(plan.witness) || !Object.isFrozen(plan.witness?.userIds) || !Object.isFrozen(plan.witness?.admissionUserIds)
    || !matches(plan.userIds) || !matches(plan.admissionUserIds)
    || !matches(plan.witness?.userIds) || !matches(plan.witness?.admissionUserIds)
    || !matches(tx.witnessed.admissionUserIds)) invalidRoot()
  if (plan.intent === 'AUTHORIZATION_OPERATION') {
    if (tx.plan.intent !== plan.intent || plan.operation?.actorId !== actorId
      || tx.plan.operation?.actorId !== actorId || tx.plan.operation.clientOperationId !== plan.operation.clientOperationId
      || tx.roleRows.size !== plan.roleIds?.length || !plan.roleIds.every(id => tx.roleRows.get(id) === 'held')) invalidRoot()
  } else if (tx.plan !== plan || plan.intent !== (revoking ? 'REVOKE_DIRECT' : 'GRANT_DIRECT')
    || tx.roleRows.size !== 0 || plan.roleIds?.length !== 0 || !Object.isFrozen(plan.roleIds)
    || Object.keys(plan).length !== 5 || Object.keys(plan.witness ?? {}).length !== 2) invalidRoot()
  if (requireRows && (!matches(tx.locked.keys()) || !matches(tx.witnessed.userIds))) invalidRoot()
}

export async function checkPermissionExceptionAuthority(tx: AuthorizationInputTx, context: PermissionExceptionRoot, revoking: boolean): Promise<void> {
  assertPermissionExceptionRoot(tx, context, revoking, false)
  const actor = tx.locked.get(context.actorId)
  if (!actor || actor.id !== context.actorId || actor.isActive !== true || actor.activationStatus !== 'activated'
    || actor.role === 'disabled' || actor.deletedAt || actor.purgedAt) throw new PlatformActorAuthorityLost()
  if (!tx.witnessed.userIds.has(context.actorId)) invalidRoot()
  // The confirmation operation already imposes its shorter, request-wide deadline.
  const saved = context.plan.intent === 'AUTHORIZATION_OPERATION' ? null : await tx.query(AUTHORIZATION_INPUT_STATEMENTS.readTimeouts)
  if (saved) await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)])
  const membership = await tx.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE", [context.actorId])
  if (saved) await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [
    String(saved.rows[0]?.lock_timeout ?? '0'), String(saved.rows[0]?.statement_timeout ?? '0'),
  ])
  if (membership.rows.length !== 1 || membership.rows[0]?.role_id !== 'admin') throw new PlatformActorAuthorityLost()
  const target = tx.locked.get(context.userId)
  if (!target || target.id !== context.userId) throw new AccessGraphUserUnavailableError('NOT_FOUND')
  if (target.deletedAt || target.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')
  assertPermissionExceptionRoot(tx, context, revoking, true)
}
