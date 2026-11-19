import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  withAuthorizationInputTransaction,
} from '../rbac/authorization-input-lock'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { unassignUserRoles } from '../rbac/role-assignment'
import type { RoleAssignmentResult } from '../rbac/role-assignment'
import { disableNamespaceAdmissionsWithoutRoles, listRoleNamespaces } from '../rbac/namespace-admission'
import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'
import { assertPlatformActorAuthority, PlatformActorAuthorityLost } from './platform-actor-authority'
import { isLastSignInPlatformAdmin } from './user-recycle'
import { syncLegacyAdminProfile } from './legacy-admin-profile'

type PlatformRoleUnassignInput = Readonly<{ actorId: string; userId: string; roleId: string }>
type PlatformRoleUnassignContext = PlatformRoleUnassignInput & Readonly<{ action: 'platform-role-unassign'; plan: AuthorizationInputPlan }>
type PlatformRoleUnassignResult = Readonly<{ blocked: true } | { blocked: false; membership: RoleAssignmentResult; disabledNamespaces: string[] }>

function invalidContext(): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500, retryable: false, reason: 'platform_role_unassign_context', message: 'Platform role unassignment transaction context is invalid',
  })
}

function assertContext(tx: AuthorizationInputTx, context: PlatformRoleUnassignContext): void {
  assertAuthorizationInputTx(tx, { client: tx, userId: context.userId })
  const subjects = [...new Set([context.actorId, context.userId])].sort()
  const matches = (ids: readonly string[] | undefined) => ids?.length === subjects.length && subjects.every((id, index) => ids[index] === id)
  const roleState = tx.roleRows.get(context.roleId)
  if (tx.plan !== context.plan || context.action !== 'platform-role-unassign'
    || tx.plan.intent !== 'REVOKE_ROLE' || tx.world !== 'shared'
    || !Object.isFrozen(context) || !Object.isFrozen(context.plan)
    || !Object.isFrozen(context.plan.roleIds) || !Object.isFrozen(context.plan.userIds)
    || !Object.isFrozen(context.plan.admissionUserIds) || !Object.isFrozen(context.plan.witness)
    || !Object.isFrozen(context.plan.witness?.userIds) || !Object.isFrozen(context.plan.witness?.admissionUserIds)
    || context.plan.roleIds?.length !== 1 || context.plan.roleIds[0] !== context.roleId
    || context.plan.platformAdminInvariant !== (context.roleId === 'admin' ? true : undefined)
    || !matches(context.plan.userIds) || !matches(context.plan.admissionUserIds)
    || !matches(context.plan.witness?.userIds) || !matches(context.plan.witness?.admissionUserIds)
    || tx.roleRows.size !== 1 || (roleState !== 'held' && roleState !== 'missing')
    || subjects.some(id => !tx.witnessed.admissionUserIds.has(id))) invalidContext()
}

async function stabilizeMembership(tx: AuthorizationInputTx, context: PlatformRoleUnassignContext): Promise<void> {
  const saved = await tx.query(AUTHORIZATION_INPUT_STATEMENTS.readTimeouts)
  await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)])
  const membership = await tx.query(
    "SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE",
    [context.actorId],
  )
  await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [
    String(saved.rows[0]?.lock_timeout ?? '0'),
    String(saved.rows[0]?.statement_timeout ?? '0'),
  ])
  if (membership.rows.length === 0) throw new PlatformActorAuthorityLost()
}

export async function unassignPlatformUserRoleCommand(input: PlatformRoleUnassignInput): Promise<PlatformRoleUnassignResult> {
  const { actorId, userId, roleId } = input
  const subjects = Object.freeze([...new Set([actorId, userId])].sort())
  const plan: AuthorizationInputPlan = Object.freeze({
    intent: 'REVOKE_ROLE',
    roleIds: Object.freeze([roleId]),
    userIds: subjects,
    admissionUserIds: subjects,
    witness: Object.freeze({ userIds: subjects, admissionUserIds: subjects }),
    ...(roleId === 'admin' ? { platformAdminInvariant: true } : {}),
  })
  const context = Object.freeze({ actorId, userId, roleId, action: 'platform-role-unassign' as const, plan })
  return withAuthorizationInputTransaction(context.plan, async (tx) => {
    assertContext(tx, context)
    if (context.roleId === 'admin' && await isLastSignInPlatformAdmin(tx, context.userId)) return { blocked: true }
    const target = tx.locked.get(context.userId)
    if (!target) throw new AccessGraphUserUnavailableError('NOT_FOUND')
    if (target.deletedAt || target.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')
    const actor = tx.locked.get(context.actorId)
    await assertPlatformActorAuthority(tx, actor)
    if (actor!.role !== 'admin') await stabilizeMembership(tx, context)
    assertContext(tx, context)
    if (!tx.locked.has(context.actorId) || !tx.locked.has(context.userId)
      || !tx.witnessed.userIds.has(context.actorId) || !tx.witnessed.userIds.has(context.userId)) invalidContext()
    const membership = await unassignUserRoles({
      userIds: [context.userId],
      roleId: context.roleId,
      scope: { kind: 'platform-admin' },
      executor: tx,
    })
    const disabledNamespaces = await disableNamespaceAdmissionsWithoutRoles({
      userId: context.userId,
      namespaces: await listRoleNamespaces(context.roleId, tx.query),
      actorId: context.actorId,
      source: 'role_unassigned',
      revokedRoleId: context.roleId,
    }, tx.query)
    if (context.roleId === 'admin') {
      await syncLegacyAdminProfile(context.userId, false, (sql, params) => tx.query(sql, params))
    }
    return { blocked: false, membership, disabledNamespaces }
  })
}
