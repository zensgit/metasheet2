import * as crypto from 'crypto'
import { ATTENDANCE_SELF_SERVICE_NAMESPACE } from '../auth/attendanceSelfServiceBackfill'
import { claimNonEmptyLoginAliasesOrThrow } from '../auth/login-alias-service'
import { buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from '../attendance/attendance-timezone-runtime-locks'
import {
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  tryAcquireAttendanceCalculationRolloutLockForBirthV1,
} from '../attendance/w4c0-identity'
import type { CanonicalAttendanceRolloutOrgKeyV1 } from '../attendance/w4c0-identity'
import { PlatformActorAuthorityLost } from './platform-actor-authority'
import { RoleRowMissingError } from './role-row-contract'
import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  AuthorizationInputBusyError,
  withAuthorizationInputTransaction,
} from '../rbac/authorization-input-lock'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import {
  deriveGrantNamespaces,
  grantNamespaceAdmissions,
  isNamespaceAdmissionControlledResource,
  writeUserNamespaceAdmission,
} from '../rbac/namespace-admission'
import { assignUserRoles } from '../rbac/role-assignment'

const ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED =
  'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED'

export class AttendanceShiftReferenceUnavailableError extends Error {
  readonly status = 422
  readonly code = ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED
  readonly details: Array<{ field: string; message: string }>

  constructor(segmentCount: number) {
    super(
      `Shift has ${segmentCount} segments; authoritative segment calculation is disabled for this org, ` +
      'so default user onboarding cannot reference a multi-segment shift',
    )
    this.name = 'AttendanceShiftReferenceUnavailableError'
    this.details = [{
      field: 'defaultShiftId',
      message: 'Multi-segment shift is authoring preview-only while segment calculation is disabled',
    }]
  }
}

export class AttendanceDefaultShiftNotFoundError extends Error {
  readonly status = 404
  readonly code = 'DEFAULT_SHIFT_NOT_FOUND'

  constructor() {
    super('Default shift not found')
    this.name = 'AttendanceDefaultShiftNotFoundError'
  }
}

export class AdminUserBirthAdmissionError extends Error {
  readonly code: 'NAMESPACE_NOT_SUPPORTED' | 'ADMISSION_NAMESPACE_NOT_DERIVED'

  constructor(code: 'NAMESPACE_NOT_SUPPORTED' | 'ADMISSION_NAMESPACE_NOT_DERIVED') {
    super(code === 'NAMESPACE_NOT_SUPPORTED'
      ? 'namespace is not managed by plugin admission controls'
      : 'admissionNamespaces must be derived from the selected role and preset')
    this.name = 'AdminUserBirthAdmissionError'
    this.code = code
  }
}

export type AdminUserBirthOnboarding = {
  orgId: string
  group: {
    id: string
    name: string | null
    memberCreated: boolean
  } | null
  defaultShift: {
    id: string
    name: string | null
    startDate: string
    assignmentId: string | null
  } | null
}

export type AdminUserBirthInput = {
  actorId: string
  userId: string
  email: string | null
  username: string | null
  name: string
  mobile: string | null
  employeeNo: string | null
  department: string | null
  position: string | null
  hireDate: string | null
  passwordHash: string
  mustChangePassword: boolean
  role: string
  directPermissions: readonly string[]
  isActive: boolean
  roleId: string
  admissionNamespaces: readonly string[]
  attendanceOrgId: string | null
  attendanceGroupId: string | null
  attendanceGroupName: string | null
  defaultShiftId: string | null
  defaultShiftName: string | null
  defaultShiftStartDate: string | null
}

const INPUT_KEYS = new Set([
  'actorId',
  'userId',
  'email',
  'username',
  'name',
  'mobile',
  'employeeNo',
  'department',
  'position',
  'hireDate',
  'passwordHash',
  'mustChangePassword',
  'role',
  'directPermissions',
  'isActive',
  'roleId',
  'admissionNamespaces',
  'attendanceOrgId',
  'attendanceGroupId',
  'attendanceGroupName',
  'defaultShiftId',
  'defaultShiftName',
  'defaultShiftStartDate',
])

type BirthContext = Readonly<{
  actorId: string
  userId: string
  email: string | null
  username: string | null
  name: string
  mobile: string | null
  employeeNo: string | null
  department: string | null
  position: string | null
  hireDate: string | null
  passwordHash: string
  mustChangePassword: boolean
  role: string
  directPermissions: readonly string[]
  permissionsJson: string
  isActive: boolean
  isAdmin: boolean
  roleId: string
  roleIds: readonly string[]
  actorIds: readonly string[]
  admissionNamespaces: readonly string[]
  attendanceOrgId: string | null
  attendanceGroupId: string | null
  attendanceGroupName: string | null
  defaultShiftId: string | null
  defaultShiftName: string | null
  defaultShiftStartDate: string | null
  plan: AuthorizationInputPlan
}>

function invalid(reason: string): never {
  throw new AuthorizationInputContractError('AUTHORIZATION_INPUT_PLAN_INVALID', {
    status: 500,
    retryable: false,
    reason,
    message: 'Authorization input plan is invalid',
  })
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.size && keys.every((key) => typeof key === 'string' && expected.has(key))
}

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && right.every((id, index) => left[index] === id)
}

function sameMembers(values: Iterable<string>, expected: readonly string[]): boolean {
  const actual = [...values].sort(compareCodeUnits)
  return actual.length === expected.length && expected.every((id, index) => actual[index] === id)
}

function stringList(value: unknown, reason: string): readonly string[] {
  if (!Array.isArray(value)) invalid(reason)
  const copy: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') invalid(reason)
    copy.push(item)
  }
  return Object.freeze(copy)
}

function nullableText(value: unknown, reason: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') invalid(reason)
  return value
}

function requiredText(value: unknown, reason: string): string {
  if (typeof value !== 'string') invalid(reason)
  return value
}

function canonicalId(value: unknown, reason: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) invalid(reason)
  return value
}

function requiredBoolean(value: unknown, reason: string): boolean {
  if (typeof value !== 'boolean') invalid(reason)
  return value
}

function freezeBirth(input: AdminUserBirthInput): BirthContext {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || !exactKeys(input, INPUT_KEYS)) invalid('birth_input')
  const actorId = canonicalId(input.actorId, 'birth_input')
  const userId = canonicalId(input.userId, 'birth_input')
  const roleId = requiredText(input.roleId, 'birth_input')
  if (roleId.trim() !== roleId) invalid('birth_input')
  const passwordHash = requiredText(input.passwordHash, 'birth_input')
  if (passwordHash.length === 0) invalid('birth_input')
  const directPermissions = stringList(input.directPermissions, 'birth_input')
  const admissionNamespaces = stringList(input.admissionNamespaces, 'birth_input')
  const actorIds = Object.freeze([actorId])
  const roleIds = Object.freeze(roleId ? [roleId] : [])
  const witness = Object.freeze({ userIds: actorIds, admissionUserIds: actorIds })
  const plan: AuthorizationInputPlan = Object.freeze({ intent: 'BIRTH', roleIds, witness })
  const role = requiredText(input.role, 'birth_input')
  return Object.freeze({
    actorId,
    userId,
    email: nullableText(input.email, 'birth_input'),
    username: nullableText(input.username, 'birth_input'),
    name: requiredText(input.name, 'birth_input'),
    mobile: nullableText(input.mobile, 'birth_input'),
    employeeNo: nullableText(input.employeeNo, 'birth_input'),
    department: nullableText(input.department, 'birth_input'),
    position: nullableText(input.position, 'birth_input'),
    hireDate: nullableText(input.hireDate, 'birth_input'),
    passwordHash,
    mustChangePassword: requiredBoolean(input.mustChangePassword, 'birth_input'),
    role,
    directPermissions,
    permissionsJson: JSON.stringify(directPermissions),
    isActive: requiredBoolean(input.isActive, 'birth_input'),
    isAdmin: role === 'admin',
    roleId,
    roleIds,
    actorIds,
    admissionNamespaces,
    attendanceOrgId: nullableText(input.attendanceOrgId, 'birth_input'),
    attendanceGroupId: nullableText(input.attendanceGroupId, 'birth_input'),
    attendanceGroupName: nullableText(input.attendanceGroupName, 'birth_input'),
    defaultShiftId: nullableText(input.defaultShiftId, 'birth_input'),
    defaultShiftName: nullableText(input.defaultShiftName, 'birth_input'),
    defaultShiftStartDate: nullableText(input.defaultShiftStartDate, 'birth_input'),
    plan,
  })
}

const PLAN_KEYS = new Set(['intent', 'roleIds', 'witness'])
const WITNESS_KEYS = new Set(['userIds', 'admissionUserIds'])

function assertToken(tx: AuthorizationInputTx, context: BirthContext): void {
  assertAuthorizationInputTx(tx, { client: tx, userId: context.userId })
  const plan = context.plan
  if (
    tx.open !== true
    || tx.plan !== plan
    || tx.world !== 'shared'
    || plan.intent !== 'BIRTH'
    || !Object.isFrozen(context)
    || !Object.isFrozen(context.directPermissions)
    || !Object.isFrozen(context.admissionNamespaces)
    || !Object.isFrozen(context.roleIds)
    || !Object.isFrozen(context.actorIds)
    || !Object.isFrozen(plan)
    || !Object.isFrozen(plan.roleIds)
    || plan.witness === undefined
    || !Object.isFrozen(plan.witness)
    || !Object.isFrozen(plan.witness.userIds)
    || !Object.isFrozen(plan.witness.admissionUserIds)
    || !exactKeys(plan, PLAN_KEYS)
    || !exactKeys(plan.witness, WITNESS_KEYS)
    || !sameIds(plan.roleIds, context.roleIds)
    || !sameIds(plan.witness.userIds, context.actorIds)
    || !sameIds(plan.witness.admissionUserIds, context.actorIds)
    || 'userIds' in plan
    || 'admissionUserIds' in plan
  ) invalid('birth_context')
}

function assertWitness(tx: AuthorizationInputTx, context: BirthContext, born: readonly string[]): void {
  if (
    context.userId === context.actorId
    || tx.locked.has(context.userId)
    || tx.witnessed.userIds.has(context.userId)
    || tx.witnessed.admissionUserIds.has(context.userId)
    || tx.born.has(context.actorId)
    || !sameMembers(tx.locked.keys(), context.actorIds)
    || !sameMembers(tx.witnessed.userIds, context.actorIds)
    || !sameMembers(tx.witnessed.admissionUserIds, context.actorIds)
    || !sameMembers(tx.born, born)
  ) invalid('birth_actor_witness')
  if (context.roleId) {
    if (tx.roleRows.size !== 1) invalid('birth_role_rows')
    const state = tx.roleRows.get(context.roleId)
    if (state === 'missing') throw new RoleRowMissingError()
    if (state !== 'held') invalid('birth_role_rows')
  } else if (tx.roleRows.size !== 0) invalid('birth_role_rows')
}

function recheck(tx: AuthorizationInputTx, context: BirthContext, born: readonly string[]): void {
  assertToken(tx, context)
  assertWitness(tx, context, born)
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

async function assertActor(tx: AuthorizationInputTx, context: BirthContext): Promise<void> {
  const actor = tx.locked.get(context.actorId)
  if (!actor || actor.deletedAt || actor.purgedAt || actor.isActive !== true || actor.activationStatus !== 'activated') {
    throw new PlatformActorAuthorityLost()
  }
  if (actor.role === 'admin') return
  if (!await shareAdminChild(tx, context.actorId)) throw new PlatformActorAuthorityLost()
}

async function freshRoleCodes(tx: AuthorizationInputTx, context: BirthContext): Promise<readonly string[]> {
  if (!context.roleId) {
    if (tx.roleRows.size !== 0) invalid('birth_role_rows')
    return Object.freeze([])
  }
  if (tx.roleRows.size !== 1) invalid('birth_role_rows')
  const state = tx.roleRows.get(context.roleId)
  if (state === 'missing') throw new RoleRowMissingError()
  if (state !== 'held') invalid('birth_role_rows')
  const stored = await tx.query('SELECT permission_code FROM role_permissions WHERE role_id = $1', [context.roleId])
  const codes: string[] = []
  for (const row of stored.rows) {
    const code = row.permission_code
    if (typeof code === 'string' && code.trim().length > 0) codes.push(code)
  }
  return Object.freeze(codes)
}

function assertAdmissions(context: BirthContext, roleCodes: readonly string[]): void {
  if (context.admissionNamespaces.length === 0) return
  const derived = deriveGrantNamespaces({
    roleId: context.roleId,
    permissionCodes: [...context.directPermissions, ...roleCodes],
  })
  for (const namespace of context.admissionNamespaces) {
    if (!isNamespaceAdmissionControlledResource(namespace)) throw new AdminUserBirthAdmissionError('NAMESPACE_NOT_SUPPORTED')
    if (!derived.includes(namespace)) throw new AdminUserBirthAdmissionError('ADMISSION_NAMESPACE_NOT_DERIVED')
  }
}

async function tryOrgLock(tx: AuthorizationInputTx, orgId: string): Promise<void> {
  const result = await tx.query(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
    [buildAttendanceTimezoneRuntimeOrgLockKeyV1(orgId)],
  )
  if (result.rows.length !== 1) invalid('birth_org_lock_result')
  const acquired = result.rows[0]?.acquired
  if (acquired !== true && acquired !== false) invalid('birth_org_lock_result')
  if (acquired !== true) throw new AuthorizationInputBusyError('lock_timeout')
}

async function admitShift(
  tx: AuthorizationInputTx,
  context: BirthContext,
): Promise<void> {
  if (!context.attendanceOrgId || !context.defaultShiftId || !context.defaultShiftStartDate) return
  const lockedShift = await tx.query(
    `SELECT s.id,
            (
              SELECT COUNT(*)::int
                FROM attendance_shift_segments seg
               WHERE seg.org_id = s.org_id
                 AND seg.shift_id = s.id
            ) AS segment_count
       FROM attendance_shifts s
      WHERE s.id = $1 AND s.org_id = $2
      FOR SHARE`,
    [context.defaultShiftId, context.attendanceOrgId],
  )
  if (!lockedShift.rows.length) throw new AttendanceDefaultShiftNotFoundError()
  const segmentCount = Number(lockedShift.rows[0]?.segment_count ?? 0)
  if (segmentCount <= 1) return
  let rolloutOrg: CanonicalAttendanceRolloutOrgKeyV1
  try {
    rolloutOrg = parseCanonicalAttendanceRolloutOrgKeyV1(context.attendanceOrgId)
  } catch {
    throw new AttendanceShiftReferenceUnavailableError(segmentCount)
  }
  await tryAcquireAttendanceCalculationRolloutLockForBirthV1(tx, rolloutOrg)
  const posture = await resolveSegmentCalculationPosture(tx, rolloutOrg)
  if (!posture.referenceSegments) throw new AttendanceShiftReferenceUnavailableError(segmentCount)
}

export async function createAdminUserBirthCommand(input: AdminUserBirthInput): Promise<AdminUserBirthOnboarding | null> {
  const context = freezeBirth(input)
  return withAuthorizationInputTransaction(context.plan, async (tx) => {
    assertToken(tx, context)
    if (context.userId === context.actorId || tx.locked.has(context.userId)) invalid('birth_target_collision')
    await assertActor(tx, context)
    assertAdmissions(context, await freshRoleCodes(tx, context))
    recheck(tx, context, [])
    if (context.attendanceOrgId && (context.attendanceGroupId || context.defaultShiftId)) {
      await tryOrgLock(tx, context.attendanceOrgId)
    }
    await admitShift(tx, context)
    recheck(tx, context, [])

    const born = await tx.insertUserForBirth({
      id: context.userId,
      email: context.email,
      username: context.username,
      name: context.name,
      mobile: context.mobile,
      employee_no: context.employeeNo,
      department: context.department,
      position: context.position,
      hire_date: context.hireDate,
      password_hash: context.passwordHash,
      must_change_password: context.mustChangePassword,
      role: context.role,
      permissions: context.permissionsJson,
      is_active: context.isActive,
      is_admin: context.isAdmin,
      activation_status: 'activated',
      local_password_set: true,
    })
    if (born.id !== context.userId) invalid('birth_returned_id')
    recheck(tx, context, [context.userId])

    await claimNonEmptyLoginAliasesOrThrow({
      userId: context.userId,
      email: context.email,
      username: context.username,
      mobile: context.mobile,
      source: 'admin_create',
      client: tx,
    })
    recheck(tx, context, [context.userId])
    if (context.roleId) {
      await assignUserRoles({
        userIds: [context.userId],
        roleId: context.roleId,
        assignmentSource: 'creation',
        scope: { kind: 'platform-admin' },
        executor: tx,
      })
    }
    recheck(tx, context, [context.userId])
    if (context.admissionNamespaces.length > 0) {
      await grantNamespaceAdmissions(tx, {
        userId: context.userId,
        namespaces: context.admissionNamespaces,
        actorId: context.actorId,
        source: 'admin_create',
      })
    }
    recheck(tx, context, [context.userId])
    if (!context.admissionNamespaces.includes(ATTENDANCE_SELF_SERVICE_NAMESPACE)) {
      await writeUserNamespaceAdmission({
        userId: context.userId,
        namespace: ATTENDANCE_SELF_SERVICE_NAMESPACE,
        enabled: false,
        actorId: context.actorId,
        source: 'admin_create',
      }, tx)
    }
    recheck(tx, context, [context.userId])
    if (context.directPermissions.length > 0) {
      const values = context.directPermissions.map((_, index) => `($1, $${index + 2})`).join(', ')
      await tx.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [context.userId, ...context.directPermissions],
      )
    }
    const onboarding: AdminUserBirthOnboarding | null = context.attendanceOrgId
      ? { orgId: context.attendanceOrgId, group: null, defaultShift: null }
      : null
    if (context.attendanceOrgId) {
      await tx.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
        [context.userId, context.attendanceOrgId],
      )
    }
    if (onboarding && context.attendanceGroupId) {
      const memberResult = await tx.query(
        `INSERT INTO attendance_group_members (org_id, group_id, user_id, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (org_id, group_id, user_id) DO NOTHING
         RETURNING id AS "memberId"`,
        [context.attendanceOrgId, context.attendanceGroupId, context.userId],
      )
      onboarding.group = {
        id: context.attendanceGroupId,
        name: context.attendanceGroupName,
        memberCreated: memberResult.rows.length > 0,
      }
    }
    if (onboarding && context.defaultShiftId && context.defaultShiftStartDate) {
      const assignmentId = crypto.randomUUID()
      const assignmentResult = await tx.query(
        `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, start_date, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::date, true, NOW(), NOW())
         RETURNING id AS "assignmentId"`,
        [assignmentId, context.attendanceOrgId, context.userId, context.defaultShiftId, context.defaultShiftStartDate],
      )
      onboarding.defaultShift = {
        id: context.defaultShiftId,
        name: context.defaultShiftName,
        startDate: context.defaultShiftStartDate,
        assignmentId: (assignmentResult.rows as Array<{ assignmentId?: string }>)[0]?.assignmentId ?? assignmentId,
      }
    }
    recheck(tx, context, [context.userId])
    return onboarding
  })
}
