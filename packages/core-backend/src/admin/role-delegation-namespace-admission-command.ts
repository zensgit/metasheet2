import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'
import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  withAuthorizationInputTransaction,
} from '../rbac/authorization-input-lock'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { deriveDelegatedAdminNamespace, writeUserNamespaceAdmission } from '../rbac/namespace-admission'
import {
  DelegationAuthorityRefusal,
  fetchUserRoleIds,
  isUserWithinDelegatedScope,
  recheckDelegatedAuthority,
} from './delegated-authority'
import { enumerateScopePathWitness, sameScopePathWitness, type ScopePathWitness } from './delegated-scope-witness'
import { PlatformActorAuthorityLost } from './platform-actor-authority'

type RoleDelegationNamespaceAdmissionInput = {
  actorId: string
  userId: string
  namespace: string
  enabled: boolean
  isPlatformAdmin: boolean
}

type AdmissionContext = Readonly<{
  actorId: string
  userId: string
  namespace: string
  enabled: boolean
  isPlatformAdmin: boolean
  roleIds: readonly string[]
  subjects: readonly string[]
  plan: AuthorizationInputPlan
}>

const PLAN_KEYS = new Set(['intent', 'roleIds', 'userIds', 'admissionUserIds', 'witness'])
const WITNESS_KEYS = new Set(['userIds', 'admissionUserIds'])
const DERIVING_CHILD_SQL = 'SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = ANY($2::text[]) ORDER BY role_id FOR SHARE'
const DEPARTMENT_SHARE_SQL = 'SELECT id FROM directory_departments WHERE id = $1 FOR SHARE'
const MEMBERSHIP_SHARE_SQL = 'SELECT group_id, user_id FROM platform_member_group_members WHERE group_id = $1 AND user_id = $2 FOR SHARE'

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function invalidContext(): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500,
    retryable: false,
    reason: 'role_delegation_namespace_admission_context',
    message: 'Authorization input plan is invalid',
  })
}

function stale(reason: string): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_STALE', {
    status: 500,
    retryable: false,
    reason,
    message: 'Authorization input plan is stale; retry this change.',
  })
}

function outOfScope(): never {
  throw new DelegationAuthorityRefusal('ROLE_DELEGATION_USER_OUT_OF_SCOPE')
}

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && right.every((id, index) => left[index] === id)
}

function exactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.size && keys.every((key) => typeof key === 'string' && expected.has(key))
}

function canonicalDerivingRoleIds(roleIds: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const roleId of roleIds) {
    if (deriveDelegatedAdminNamespace(roleId) === null) continue
    if (roleId.trim() !== roleId) stale('deriving_role_noncanonical')
    ids.add(roleId)
  }
  return [...ids].sort(compareCodeUnits)
}

function assertStructural(tx: AuthorizationInputTx, context: AdmissionContext): void {
  assertAuthorizationInputTx(tx, { client: tx, userId: context.userId })
  const plan = context.plan
  if (
    tx.plan !== plan
    || tx.world !== 'shared'
    || plan.intent !== 'SET_ADMISSION'
    || !Object.isFrozen(context)
    || !Object.isFrozen(context.roleIds)
    || !Object.isFrozen(context.subjects)
    || !Object.isFrozen(plan)
    || !Object.isFrozen(plan.roleIds)
    || !Object.isFrozen(plan.userIds)
    || !Object.isFrozen(plan.admissionUserIds)
    || plan.witness === undefined
    || !Object.isFrozen(plan.witness)
    || !Object.isFrozen(plan.witness.userIds)
    || !Object.isFrozen(plan.witness.admissionUserIds)
    || !exactKeys(plan, PLAN_KEYS)
    || !exactKeys(plan.witness, WITNESS_KEYS)
    || !sameIds(plan.roleIds, context.roleIds)
    || !sameIds(plan.userIds, context.subjects)
    || !sameIds(plan.admissionUserIds, context.subjects)
    || !sameIds(plan.witness.userIds, context.subjects)
    || !sameIds(plan.witness.admissionUserIds, context.subjects)
  ) invalidContext()
}

function assertActual(tx: AuthorizationInputTx, context: AdmissionContext): void {
  const parents = [...tx.roleRows.keys()].sort(compareCodeUnits)
  const witnessedUsers = [...tx.witnessed.userIds].sort(compareCodeUnits)
  const witnessedAdmissions = [...tx.witnessed.admissionUserIds].sort(compareCodeUnits)
  const lockedIds = [...tx.locked.keys()].sort(compareCodeUnits)
  const statesMatch = context.roleIds.every((roleId) => {
    const state = tx.roleRows.get(roleId)
    return state === 'held' || state === 'missing'
  })
  if (
    !statesMatch
    || context.subjects.some((id) => tx.born.has(id))
    || !sameIds(parents, context.roleIds)
    || !sameIds(witnessedUsers, context.subjects)
    || !sameIds(witnessedAdmissions, context.subjects)
    || !sameIds(lockedIds, context.subjects)
  ) invalidContext()
}

function assertBeforeDml(tx: AuthorizationInputTx, context: AdmissionContext): void {
  assertStructural(tx, context)
  assertActual(tx, context)
}

function requireWritableTarget(tx: AuthorizationInputTx, targetId: string): void {
  const target = tx.locked.get(targetId)
  if (!target) throw new AccessGraphUserUnavailableError('NOT_FOUND')
  if (target.deletedAt || target.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')
}

async function runHeldWindow(tx: AuthorizationInputTx, share: () => Promise<void>): Promise<void> {
  const saved = await tx.query(AUTHORIZATION_INPUT_STATEMENTS.readTimeouts)
  await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [
    String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS),
    String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS),
  ])
  await share()
  await tx.query(AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, [
    String(saved.rows[0]?.lock_timeout ?? '0'),
    String(saved.rows[0]?.statement_timeout ?? '0'),
  ])
}

async function shareAdminChild(tx: AuthorizationInputTx, actorId: string): Promise<boolean> {
  let held = false
  await runHeldWindow(tx, async () => {
    const membership = await tx.query(
      "SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE",
      [actorId],
    )
    held = membership.rows.length > 0
  })
  return held
}

async function assertActorS0(tx: AuthorizationInputTx, actorId: string): Promise<void> {
  const actor = tx.locked.get(actorId)
  if (!actor || actor.deletedAt || actor.purgedAt || actor.isActive !== true || actor.activationStatus !== 'activated') {
    throw new PlatformActorAuthorityLost()
  }
  if (actor.role === 'admin') return
  if (!await shareAdminChild(tx, actorId)) throw new PlatformActorAuthorityLost()
}

async function shareDerivingChildren(tx: AuthorizationInputTx, actorId: string, roleIds: readonly string[]): Promise<void> {
  if (roleIds.length === 0) return
  await runHeldWindow(tx, async () => {
    await tx.query(DERIVING_CHILD_SQL, [actorId, [...roleIds]])
  })
}

async function shareScopeWitness(tx: AuthorizationInputTx, witness: ScopePathWitness): Promise<void> {
  if (witness.departmentIds.length === 0 && witness.memberships.length === 0) outOfScope()
  await runHeldWindow(tx, async () => {
    for (const departmentId of witness.departmentIds) {
      const row = await tx.query(DEPARTMENT_SHARE_SQL, [departmentId])
      if (row.rows.length !== 1) outOfScope()
    }
    for (const membership of witness.memberships) {
      const row = await tx.query(MEMBERSHIP_SHARE_SQL, [membership.groupId, membership.targetUserId])
      if (row.rows.length !== 1) outOfScope()
    }
  })
}

async function assertDelegatedScope(tx: AuthorizationInputTx, context: AdmissionContext): Promise<void> {
  await shareDerivingChildren(tx, context.actorId, context.roleIds)
  const observed = await fetchUserRoleIds(
    context.actorId,
    tx as NonNullable<Parameters<typeof fetchUserRoleIds>[1]>,
  )
  const namespaces = await recheckDelegatedAuthority(
    tx,
    context.actorId,
    context.userId,
    [context.namespace],
    tx.locked.get(context.actorId),
  )
  if (!sameIds(canonicalDerivingRoleIds(observed), context.roleIds)) stale('deriving_role_set')
  const matching = Object.freeze(namespaces.filter((namespace) => namespace === context.namespace))
  const witness = await enumerateScopePathWitness(tx.query, context.actorId, matching, context.userId)
  await shareScopeWitness(tx, witness)
  const again = await enumerateScopePathWitness(tx.query, context.actorId, matching, context.userId)
  if (!sameScopePathWitness(witness, again)) outOfScope()
  if (!await isUserWithinDelegatedScope(context.actorId, [...matching], context.userId, tx.query)) outOfScope()
}

export async function writeRoleDelegationNamespaceAdmissionCommand(
  input: RoleDelegationNamespaceAdmissionInput,
): Promise<void> {
  const actorId = input.actorId
  const userId = input.userId
  const namespace = input.namespace
  const enabled = input.enabled
  const isPlatformAdmin = input.isPlatformAdmin
  const discovered = isPlatformAdmin ? [] : canonicalDerivingRoleIds(await fetchUserRoleIds(actorId))
  const roleIds = Object.freeze(discovered)
  const subjects = Object.freeze([...new Set([actorId, userId])].sort(compareCodeUnits))
  const witness = Object.freeze({
    userIds: subjects,
    admissionUserIds: subjects,
  })
  const plan = Object.freeze({
    intent: 'SET_ADMISSION' as const,
    roleIds,
    userIds: subjects,
    admissionUserIds: subjects,
    witness,
  })
  const context = Object.freeze({
    actorId,
    userId,
    namespace,
    enabled,
    isPlatformAdmin,
    roleIds,
    subjects,
    plan,
  })
  await withAuthorizationInputTransaction(plan, async (tx) => {
    assertStructural(tx, context)
    requireWritableTarget(tx, userId)
    if (isPlatformAdmin) await assertActorS0(tx, actorId)
    else await assertDelegatedScope(tx, context)
    assertBeforeDml(tx, context)
    await writeUserNamespaceAdmission({
      userId,
      namespace,
      enabled,
      actorId,
      source: isPlatformAdmin ? 'platform_admin' : 'delegated_admin',
    }, tx)
  })
}
