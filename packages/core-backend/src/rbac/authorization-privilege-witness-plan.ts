import { PrivilegeInputsUnavailableError, readPrivilegeInputs } from '../auth/security-action-privilege'
import { assertAuthorizationInputTx, AuthorizationInputContractError } from './authorization-input-brand'
import type { AuthorizationInputQueryable } from './authorization-input-brand'
import type { AuthorizationInputPlan, AuthorizationInputTx } from './authorization-input-lock'
import { normalizeAuthorizationInputIdentityRead } from './authorization-input-lock'
import type { AuthorizationInputIdentityRead } from './authorization-input-lock'

export type PrivilegeRolePlan = Readonly<{
  subjectIds: readonly string[]
  subjects: readonly Readonly<{ userId: string; roleIds: readonly string[] }>[]
  roleIds: readonly string[]
  lockPlan: AuthorizationInputPlan
}>

type InvalidReason = 'subject_ids_invalid' | 'role_plan_unregistered' | 'lock_plan_mismatch'
  | 'consume_shared_required' | 'user_row_not_held' | 'user_witness_not_held'
  | 'admission_witness_not_held' | 'role_row_not_held' | 'role_rows_mismatch'

const plans = new WeakSet<PrivilegeRolePlan>()
const MEMBERSHIP_STATEMENT = 'SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1::text[])'

function invalid(reason: InvalidReason): AuthorizationInputContractError {
  return new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500, retryable: false, reason, message: 'Authorization input plan is invalid',
  })
}

function isRoleId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function isSubjectId(value: unknown): value is string {
  return isRoleId(value) && value.length <= 255
    && !Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
}

export async function discoverPrivilegeRolePlan(
  queryable: AuthorizationInputQueryable,
  subjectIds: readonly string[],
  identityRead?: AuthorizationInputIdentityRead,
): Promise<PrivilegeRolePlan> {
  const normalizedIdentityRead = arguments.length >= 3 ? normalizeAuthorizationInputIdentityRead(identityRead) : undefined
  if (!Array.isArray(subjectIds) || subjectIds.length === 0 || !Array.from(subjectIds).every(isSubjectId)) {
    throw invalid('subject_ids_invalid')
  }
  const ids = Object.freeze([...new Set(subjectIds)].sort())
  const memberships = new Map(ids.map((userId) => [userId, new Set<string>()]))
  let rows: unknown
  try {
    rows = (await queryable.query(MEMBERSHIP_STATEMENT, [[...ids]])).rows
  } catch {
    throw new PrivilegeInputsUnavailableError('read_failed')
  }
  if (!Array.isArray(rows)) throw new PrivilegeInputsUnavailableError('input_malformed')
  try {
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)
        || !isSubjectId(row.user_id) || !isRoleId(row.role_id)) {
        throw new PrivilegeInputsUnavailableError('input_malformed')
      }
      const roles = memberships.get(row.user_id)
      if (!roles || roles.has(row.role_id)) throw new PrivilegeInputsUnavailableError('input_malformed')
      roles.add(row.role_id)
    }
  } catch {
    throw new PrivilegeInputsUnavailableError('input_malformed')
  }
  const subjects = Object.freeze(ids.map((userId) => Object.freeze({
    userId,
    roleIds: Object.freeze([...memberships.get(userId)!].sort()),
  })))
  const roleIds = Object.freeze([...new Set(subjects.flatMap((subject) => subject.roleIds))].sort())
  const lockPlan = Object.freeze({
    intent: 'CONSUME_CLASS_DECISION' as const,
    roleIds,
    witness: Object.freeze({ userIds: ids, admissionUserIds: ids }),
    ...(normalizedIdentityRead ? { identityRead: normalizedIdentityRead } : {}),
  })
  const plan = Object.freeze({ subjectIds: ids, subjects, roleIds, lockPlan })
  plans.add(plan)
  return plan
}

export async function revalidatePrivilegeRolePlan(tx: AuthorizationInputTx, plan: PrivilegeRolePlan): Promise<void> {
  assertAuthorizationInputTx(tx, { client: tx })
  if (!plans.has(plan)) throw invalid('role_plan_unregistered')
  if (tx.plan !== plan.lockPlan) throw invalid('lock_plan_mismatch')
  if (tx.plan.intent !== 'CONSUME_CLASS_DECISION' || tx.world !== 'shared') throw invalid('consume_shared_required')
  if (tx.roleRows.size !== plan.roleIds.length || [...tx.roleRows.keys()].some((roleId) => !plan.roleIds.includes(roleId))) {
    throw invalid('role_rows_mismatch')
  }
  for (const userId of plan.subjectIds) {
    if (!tx.locked.has(userId)) throw invalid('user_row_not_held')
    if (!tx.witnessed.userIds.has(userId)) throw invalid('user_witness_not_held')
    if (!tx.witnessed.admissionUserIds.has(userId)) throw invalid('admission_witness_not_held')
  }
  try {
    tx.requireUserRows(plan.subjectIds)
  } catch {
    throw invalid('user_row_not_held')
  }
  try {
    tx.requireRoleRows(plan.roleIds)
  } catch {
    throw invalid('role_row_not_held')
  }
  for (const subject of plan.subjects) {
    assertAuthorizationInputTx(tx, { client: tx })
    let inputs: Awaited<ReturnType<typeof readPrivilegeInputs>>
    try {
      inputs = await readPrivilegeInputs(tx as Parameters<typeof readPrivilegeInputs>[0], subject.userId)
    } catch (error) {
      assertAuthorizationInputTx(tx, { client: tx })
      const reason = error instanceof PrivilegeInputsUnavailableError
        && ['read_failed', 'input_malformed', 'subject_missing', 'transaction_required'].includes(error.reason)
        ? error.reason : 'read_failed'
      throw new PrivilegeInputsUnavailableError(reason)
    }
    assertAuthorizationInputTx(tx, { client: tx })
    if (inputs.userId !== subject.userId || !Array.isArray(inputs.roleIds)
      || !inputs.roleIds.every(isRoleId) || new Set(inputs.roleIds).size !== inputs.roleIds.length) {
      throw new PrivilegeInputsUnavailableError('input_malformed')
    }
    const roleIds = [...inputs.roleIds].sort()
    if (roleIds.length !== subject.roleIds.length || roleIds.some((roleId, index) => roleId !== subject.roleIds[index])) {
      throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_STALE', {
        status: 409, retryable: false, reason: 'role_membership_changed',
        message: 'Authorization input plan is stale; retry this change.',
      })
    }
  }
}
