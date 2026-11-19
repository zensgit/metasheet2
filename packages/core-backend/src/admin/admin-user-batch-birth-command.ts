import { ATTENDANCE_SELF_SERVICE_NAMESPACE } from '../auth/attendanceSelfServiceBackfill'
import { claimNonEmptyLoginAliasesOrThrow } from '../auth/login-alias-service'
import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  withAuthorizationInputTransaction,
} from '../rbac/authorization-input-lock'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { writeUserNamespaceAdmission } from '../rbac/namespace-admission'
import { assignUserRoles } from '../rbac/role-assignment'
import { assertPlatformActorAuthority, PlatformActorAuthorityLost } from './platform-actor-authority'
import { RoleRowMissingError } from './role-row-contract'

type AdminBatchBirthInput = Readonly<{
  actorId: string
  userId: string
  email: string
  name: string
  department: string | null
  passwordHash: string
  roleId: string | null
}>

type BirthContext = Readonly<{
  actorId: string
  userId: string
  email: string
  name: string
  department: string | null
  passwordHash: string
  roleId: string | null
  roleIds: readonly string[]
  actors: readonly string[]
  plan: AuthorizationInputPlan
}>

const PLAN_KEYS = new Set(['intent', 'roleIds', 'witness'])
const WITNESS_KEYS = new Set(['userIds', 'admissionUserIds'])

function invalidContext(): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500,
    retryable: false,
    reason: 'admin_batch_birth_context',
    message: 'Batch user birth transaction context is invalid',
  })
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return !!left && left.length === right.length && right.every((id, index) => left[index] === id)
}

function exactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.size && keys.every((key) => typeof key === 'string' && expected.has(key))
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort(compareCodeUnits)
}

function displayRole(roleId: string | null): string {
  return roleId === 'admin' ? 'admin' : (roleId || 'user')
}

function assertShape(tx: AuthorizationInputTx, context: BirthContext, expectedBorn: readonly string[]): void {
  assertAuthorizationInputTx(tx, { client: tx, userId: context.userId })
  const plan = context.plan
  const actors = sortedIds(context.actors)
  const born = sortedIds([...tx.born])
  const parents = sortedIds([...tx.roleRows.keys()])
  const locked = sortedIds([...tx.locked.keys()])
  const witnessedUsers = sortedIds([...tx.witnessed.userIds])
  const witnessedAdmissions = sortedIds([...tx.witnessed.admissionUserIds])
  if (
    tx.plan !== plan
    || tx.world !== 'shared'
    || plan.intent !== 'BIRTH'
    || context.userId === context.actorId
    || !Object.isFrozen(context)
    || !Object.isFrozen(context.roleIds)
    || !Object.isFrozen(context.actors)
    || !Object.isFrozen(plan)
    || !Object.isFrozen(plan.roleIds)
    || plan.witness === undefined
    || !Object.isFrozen(plan.witness)
    || !Object.isFrozen(plan.witness.userIds)
    || !Object.isFrozen(plan.witness.admissionUserIds)
    || !exactKeys(plan, PLAN_KEYS)
    || !exactKeys(plan.witness, WITNESS_KEYS)
    || !sameIds(plan.roleIds, context.roleIds)
    || !sameIds(plan.witness.userIds, context.actors)
    || !sameIds(plan.witness.admissionUserIds, context.actors)
    || !sameIds(parents, sortedIds(context.roleIds))
    || !sameIds(born, sortedIds(expectedBorn))
    || !sameIds(witnessedAdmissions, actors)
    || tx.locked.has(context.userId)
    || tx.witnessed.userIds.has(context.userId)
    || tx.witnessed.admissionUserIds.has(context.userId)
    || tx.born.has(context.actorId)
  ) invalidContext()
  const actorHeld = sameIds(locked, actors) && sameIds(witnessedUsers, actors)
  if (actorHeld) return
  if (locked.length === 0 && witnessedUsers.length === 0) throw new PlatformActorAuthorityLost()
  invalidContext()
}

function assertSelectedRole(tx: AuthorizationInputTx, context: BirthContext): void {
  if (context.roleId === null) {
    if (tx.roleRows.size !== 0) invalidContext()
    return
  }
  const state = tx.roleRows.get(context.roleId)
  if (state === 'missing') throw new RoleRowMissingError()
  if (state !== 'held') invalidContext()
}

function assertReady(tx: AuthorizationInputTx, context: BirthContext): void {
  assertShape(tx, context, [context.userId])
  const actor = tx.locked.get(context.actorId)
  if (!actor || actor.deletedAt || actor.purgedAt || actor.isActive !== true || actor.activationStatus !== 'activated') {
    throw new PlatformActorAuthorityLost()
  }
  assertSelectedRole(tx, context)
}

async function stabilizeMembership(tx: AuthorizationInputTx, actorId: string): Promise<void> {
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
  if (membership.rows.length === 0) throw new PlatformActorAuthorityLost()
}

async function assertActorAuthority(tx: AuthorizationInputTx, context: BirthContext): Promise<void> {
  const actor = tx.locked.get(context.actorId)
  await assertPlatformActorAuthority(tx, actor)
  if (!actor || actor.role === 'admin') return
  await stabilizeMembership(tx, context.actorId)
}

function birthRow(context: BirthContext): Record<string, unknown> {
  const role = displayRole(context.roleId)
  return {
    id: context.userId,
    email: context.email,
    username: null,
    name: context.name,
    mobile: null,
    employee_no: null,
    department: context.department,
    position: null,
    hire_date: null,
    password_hash: context.passwordHash,
    must_change_password: true,
    role,
    permissions: '[]',
    is_active: true,
    is_admin: role === 'admin',
    activation_status: 'activated',
    local_password_set: true,
  }
}

export async function createAdminBatchUserCommand(input: AdminBatchBirthInput): Promise<void> {
  const actorId = input.actorId
  const userId = input.userId
  const email = input.email
  const name = input.name
  const department = input.department
  const passwordHash = input.passwordHash
  const roleId = input.roleId ? input.roleId : null
  const roleIds = Object.freeze(roleId ? [roleId] : [])
  const actors = Object.freeze([actorId])
  const witness = Object.freeze({ userIds: actors, admissionUserIds: actors })
  const plan = Object.freeze({
    intent: 'BIRTH' as const,
    roleIds,
    witness,
  })
  const context = Object.freeze({
    actorId,
    userId,
    email,
    name,
    department,
    passwordHash,
    roleId,
    roleIds,
    actors,
    plan,
  })
  if (actorId === userId) invalidContext()
  await withAuthorizationInputTransaction(plan, async (tx) => {
    assertShape(tx, context, [])
    await assertActorAuthority(tx, context)
    assertSelectedRole(tx, context)
    assertShape(tx, context, [])
    const inserted = await tx.insertUserForBirth(birthRow(context))
    if (inserted.id !== context.userId) invalidContext()
    assertReady(tx, context)
    await claimNonEmptyLoginAliasesOrThrow({
      userId: context.userId,
      email: context.email,
      source: 'admin_batch_create',
      client: tx,
    })
    assertReady(tx, context)
    if (context.roleId) {
      await assignUserRoles({
        userIds: [context.userId],
        roleId: context.roleId,
        assignmentSource: 'creation',
        scope: { kind: 'platform-admin' },
        executor: tx,
      })
      assertReady(tx, context)
    }
    await writeUserNamespaceAdmission({
      userId: context.userId,
      namespace: ATTENDANCE_SELF_SERVICE_NAMESPACE,
      enabled: false,
      actorId: context.actorId,
      source: 'admin_batch_create',
    }, tx)
  })
}
