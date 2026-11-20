import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'
import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  withAuthorizationInputTransaction,
} from '../rbac/authorization-input-lock'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { writeUserNamespaceAdmission } from '../rbac/namespace-admission'
import { PlatformActorAuthorityLost } from './platform-actor-authority'

type PlatformNamespaceAdmissionInput = {
  actorId: string
  userId: string
  namespace: string
  enabled: boolean
}

type AdmissionContext = Readonly<{
  actorId: string
  userId: string
  namespace: string
  enabled: boolean
  roleIds: readonly string[]
  subjects: readonly string[]
  plan: AuthorizationInputPlan
}>

const PLAN_KEYS = new Set(['intent', 'roleIds', 'userIds', 'admissionUserIds', 'witness'])
const WITNESS_KEYS = new Set(['userIds', 'admissionUserIds'])

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function invalidContext(): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500,
    retryable: false,
    reason: 'platform_namespace_admission_context',
    message: 'Authorization input plan is invalid',
  })
}

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && right.every((id, index) => left[index] === id)
}

function exactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.size && keys.every((key) => typeof key === 'string' && expected.has(key))
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

async function shareAdminChild(tx: AuthorizationInputTx, actorId: string): Promise<boolean> {
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

async function assertActorS0(tx: AuthorizationInputTx, actorId: string): Promise<void> {
  const actor = tx.locked.get(actorId)
  if (!actor || actor.deletedAt || actor.purgedAt || actor.isActive !== true || actor.activationStatus !== 'activated') {
    throw new PlatformActorAuthorityLost()
  }
  if (actor.role === 'admin') return
  if (!await shareAdminChild(tx, actorId)) throw new PlatformActorAuthorityLost()
}

export async function writePlatformNamespaceAdmissionCommand(
  input: PlatformNamespaceAdmissionInput,
): Promise<void> {
  const actorId = input.actorId
  const userId = input.userId
  const namespace = input.namespace
  const enabled = input.enabled
  const roleIds = Object.freeze([] as string[])
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
    roleIds,
    subjects,
    plan,
  })
  await withAuthorizationInputTransaction(plan, async (tx) => {
    assertStructural(tx, context)
    requireWritableTarget(tx, userId)
    await assertActorS0(tx, actorId)
    assertBeforeDml(tx, context)
    await writeUserNamespaceAdmission({
      userId,
      namespace,
      enabled,
      actorId,
      source: 'platform_admin',
    }, tx)
  })
}
