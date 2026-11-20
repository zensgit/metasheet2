import { assertPlatformActorAuthority, PlatformActorAuthorityLost } from './platform-actor-authority'
import {
  assertAllRoleTargetsEligible,
  AttendanceAdminUserScopeError,
  deriveAttendanceRoleAssignmentScope,
  fetchUserProfile,
  resolveBatchUsers,
} from './attendance-role-target-read'
import type { query } from '../db/pg'
import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  withAuthorizationInputTransaction,
} from '../rbac/authorization-input-lock'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { disableNamespaceAdmissionsWithoutRoles, listRoleNamespaces } from '../rbac/namespace-admission'
import { assignUserRoles, unassignUserRoles } from '../rbac/role-assignment'
import type { RoleAssignmentResult } from '../rbac/role-assignment'
import { isAdmin } from '../rbac/service'

export const ATTENDANCE_TEMPLATE_ROLE_IDS = Object.freeze([
  'attendance_admin',
  'attendance_approver',
  'attendance_employee',
  'attendance_importer',
])

type AttendanceGlobalRoleCommandInput = Readonly<{
  actorId: string
  userIds: readonly string[]
  roleId: string
  legacyAdminClaim: boolean
  includeProfile: boolean
}>

type AttendanceGlobalRoleContext = AttendanceGlobalRoleCommandInput & Readonly<{
  action: 'attendance-global-role-assign' | 'attendance-global-role-unassign'
  plan: AuthorizationInputPlan
}>

export type AttendanceGlobalRoleCommandResult = {
  membership: RoleAssignmentResult
  targets: Awaited<ReturnType<typeof resolveBatchUsers>>
  profile: Record<string, unknown> | null
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function invalidContext(): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500,
    retryable: false,
    reason: 'attendance_global_role_context',
    message: 'Authorization input plan is invalid',
  })
}

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && right.every((id, index) => left[index] === id)
}

function subjectIds(actorId: string, userIds: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([actorId, ...userIds])].sort(compareCodeUnits))
}

function assignParentRoleIds(roleId: string): readonly string[] {
  return Object.freeze([...new Set([...ATTENDANCE_TEMPLATE_ROLE_IDS, roleId])].sort(compareCodeUnits))
}

function declaredParentRoleIds(context: AttendanceGlobalRoleContext): readonly string[] {
  if (context.action === 'attendance-global-role-assign') return assignParentRoleIds(context.roleId)
  if (context.action === 'attendance-global-role-unassign') return Object.freeze([context.roleId])
  return Object.freeze([])
}

function actionIntentMatches(context: AttendanceGlobalRoleContext): boolean {
  if (context.action === 'attendance-global-role-assign') return context.plan.intent === 'GRANT_ROLE'
  if (context.action === 'attendance-global-role-unassign') return context.plan.intent === 'REVOKE_ROLE'
  return false
}

function parentMetadataAccepted(tx: AuthorizationInputTx, roleIds: readonly string[]): boolean {
  return tx.roleRows.size === roleIds.length && roleIds.every((roleId) => {
    const state = tx.roleRows.get(roleId)
    return state === 'held' || state === 'missing'
  })
}

function assertContext(tx: AuthorizationInputTx, context: AttendanceGlobalRoleContext): void {
  assertAuthorizationInputTx(tx, { client: tx, userId: context.actorId })
  const subjects = subjectIds(context.actorId, context.userIds)
  const plan = context.plan
  const roleIds = declaredParentRoleIds(context)
  if (
    tx.plan !== plan
    || !actionIntentMatches(context)
    || tx.world !== 'shared'
    || plan.platformAdminInvariant === true
    || !Object.isFrozen(context)
    || !Object.isFrozen(context.userIds)
    || !Object.isFrozen(plan)
    || !Object.isFrozen(plan.roleIds)
    || !Object.isFrozen(plan.userIds)
    || !Object.isFrozen(plan.admissionUserIds)
    || !Object.isFrozen(plan.witness)
    || !Object.isFrozen(plan.witness?.userIds)
    || !Object.isFrozen(plan.witness?.admissionUserIds)
    || !sameIds(plan.roleIds, roleIds)
    || !sameIds(plan.userIds, subjects)
    || !sameIds(plan.admissionUserIds, subjects)
    || !sameIds(plan.witness?.userIds, subjects)
    || !sameIds(plan.witness?.admissionUserIds, subjects)
    || !parentMetadataAccepted(tx, roleIds)
  ) invalidContext()
}

function assertWitnessedSubjects(tx: AuthorizationInputTx, context: AttendanceGlobalRoleContext): void {
  const subjects = subjectIds(context.actorId, context.userIds)
  const witnessedUsers = [...tx.witnessed.userIds].sort(compareCodeUnits)
  const witnessedAdmissions = [...tx.witnessed.admissionUserIds].sort(compareCodeUnits)
  const lockedIds = [...tx.locked.keys()].sort(compareCodeUnits)
  if (!sameIds(witnessedUsers, subjects) || !sameIds(witnessedAdmissions, subjects) || !sameIds(lockedIds, subjects)) {
    invalidContext()
  }
}

function freezeRequestedUserIds(userIds: readonly string[]): readonly string[] {
  return Object.freeze([...userIds])
}

function commandContext(
  input: AttendanceGlobalRoleCommandInput,
  action: AttendanceGlobalRoleContext['action'],
  roleIds: readonly string[],
): AttendanceGlobalRoleContext {
  const userIds = freezeRequestedUserIds(input.userIds)
  const subjects = subjectIds(input.actorId, userIds)
  const intent = action === 'attendance-global-role-assign' ? 'GRANT_ROLE' : 'REVOKE_ROLE'
  return Object.freeze({
    actorId: input.actorId,
    userIds,
    roleId: input.roleId,
    legacyAdminClaim: input.legacyAdminClaim,
    includeProfile: input.includeProfile,
    action,
    plan: buildPlan(intent, roleIds, subjects),
  })
}

async function shareAdminEdge(tx: AuthorizationInputTx, actorId: string): Promise<boolean> {
  const saved = await tx.query(AUTHORIZATION_INPUT_STATEMENTS.readTimeouts)
  await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [
    String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS),
    String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS),
  ])
  const membership = await tx.query(
    "SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE",
    [actorId],
  )
  await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [
    String(saved.rows[0]?.lock_timeout ?? '0'),
    String(saved.rows[0]?.statement_timeout ?? '0'),
  ])
  return membership.rows.length > 0
}

async function assertLockedActorScope(
  tx: AuthorizationInputTx,
  actorId: string,
  legacyAdminClaim: boolean,
): Promise<void> {
  const actor = tx.locked.get(actorId)
  await assertPlatformActorAuthority(tx, actor)
  if (!actor) throw new PlatformActorAuthorityLost()
  const edgeHeld = legacyAdminClaim === false || actor.role !== 'admin'
    ? await shareAdminEdge(tx, actorId)
    : false
  if (legacyAdminClaim === false) {
    if (!edgeHeld || !await isAdmin(actorId, tx.query as typeof query)) {
      throw new AttendanceAdminUserScopeError(
        403,
        'FORBIDDEN',
        'Platform admin access required for global user scope',
      )
    }
    return
  }
  if (actor.role !== 'admin' && !edgeHeld) throw new PlatformActorAuthorityLost()
}

function buildPlan(
  intent: 'GRANT_ROLE' | 'REVOKE_ROLE',
  roleIds: readonly string[],
  subjects: readonly string[],
): AuthorizationInputPlan {
  return Object.freeze({
    intent,
    roleIds: Object.freeze([...roleIds]),
    userIds: subjects,
    admissionUserIds: subjects,
    witness: Object.freeze({
      userIds: subjects,
      admissionUserIds: subjects,
    }),
  })
}

async function finishProfile(
  tx: AuthorizationInputTx,
  userIds: readonly string[],
  includeProfile: boolean,
): Promise<Record<string, unknown> | null> {
  const listedUserId = userIds[0]
  if (!includeProfile || listedUserId === undefined) return null
  return fetchUserProfile(listedUserId, tx.query as typeof query)
}

export async function assignAttendanceGlobalRolesCommand(
  input: AttendanceGlobalRoleCommandInput,
): Promise<AttendanceGlobalRoleCommandResult> {
  const context = commandContext(input, 'attendance-global-role-assign', assignParentRoleIds(input.roleId))
  return withAuthorizationInputTransaction(context.plan, async (tx) => {
    assertContext(tx, context)
    await assertLockedActorScope(tx, context.actorId, context.legacyAdminClaim)
    const runQuery = tx.query as typeof query
    const targets = await resolveBatchUsers([...context.userIds], { kind: 'global' }, runQuery, true)
    assertAllRoleTargetsEligible([...context.userIds], targets)
    assertWitnessedSubjects(tx, context)
    assertContext(tx, context)
    const roleWriteScope = deriveAttendanceRoleAssignmentScope({ kind: 'global' })
    const membership = await assignUserRoles({
      userIds: context.userIds,
      roleId: context.roleId,
      assignmentSource: 'manual',
      scope: roleWriteScope,
      executor: tx,
    })
    return {
      membership,
      targets,
      profile: await finishProfile(tx, context.userIds, context.includeProfile),
    }
  })
}

export async function unassignAttendanceGlobalRolesCommand(
  input: AttendanceGlobalRoleCommandInput,
): Promise<AttendanceGlobalRoleCommandResult> {
  const context = commandContext(input, 'attendance-global-role-unassign', Object.freeze([input.roleId]))
  return withAuthorizationInputTransaction(context.plan, async (tx) => {
    assertContext(tx, context)
    await assertLockedActorScope(tx, context.actorId, context.legacyAdminClaim)
    const runQuery = tx.query as typeof query
    const targets = await resolveBatchUsers([...context.userIds], { kind: 'global' }, runQuery, true)
    assertAllRoleTargetsEligible([...context.userIds], targets)
    assertWitnessedSubjects(tx, context)
    assertContext(tx, context)
    const roleWriteScope = deriveAttendanceRoleAssignmentScope({ kind: 'global' })
    const membership = await unassignUserRoles({
      userIds: context.userIds,
      roleId: context.roleId,
      scope: roleWriteScope,
      executor: tx,
    })
    const targetIds = [...context.userIds].sort(compareCodeUnits)
    for (const targetId of targetIds) {
      await disableNamespaceAdmissionsWithoutRoles({
        userId: targetId,
        namespaces: await listRoleNamespaces(context.roleId, tx.query),
        actorId: context.actorId,
        source: 'role_unassigned',
        revokedRoleId: context.roleId,
      }, tx.query)
    }
    return {
      membership,
      targets,
      profile: await finishProfile(tx, context.userIds, context.includeProfile),
    }
  })
}
