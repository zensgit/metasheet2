import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { AuthorizationInputTokenRejectedError } from '../../src/rbac/authorization-input-brand'

type RoleState = 'held' | 'missing'
type BrandMode = 'mint' | 'closed' | 'none'
type ResolveSegmentCalculationPosture = typeof import('../../src/attendance/w4c0-identity').resolveSegmentCalculationPosture
type GrantNamespaceAdmissions = typeof import('../../src/rbac/namespace-admission').grantNamespaceAdmissions
type GrantCall = {
  tx: Parameters<GrantNamespaceAdmissions>[0]
  options: Parameters<GrantNamespaceAdmissions>[1]
}

const { ACTOR, USER, ORG, GROUP, SHIFT, harness } = vi.hoisted(() => {
  const ACTOR = 'actor-1'
  const USER = 'user-1'
  const ORG = 'default'
  const GROUP = '11111111-1111-4111-8111-111111111111'
  const SHIFT = '22222222-2222-4222-8222-222222222222'
  const harness = {
    make: ((_plan: AuthorizationInputPlan): AuthorizationInputTx => { throw new Error('unset') }) as (plan: AuthorizationInputPlan) => AuthorizationInputTx,
    sql: [] as Array<{ sql: string; params?: unknown[] }>,
    inserts: [] as Array<Record<string, unknown>>,
    plans: [] as AuthorizationInputPlan[],
    roots: [] as unknown[],
    arity: [] as number[],
    alias: [] as Array<Record<string, unknown>>,
    roles: [] as Array<Record<string, unknown>>,
    grants: [] as GrantCall[],
    w16: [] as Array<Record<string, unknown>>,
    tx: null as AuthorizationInputTx | null,
    actorId: ACTOR,
    actor: 'present' as 'present' | 'missing',
    actorPatch: {} as Record<string, unknown>,
    extraLocked: [] as string[],
    roleRows: [] as Array<[string, RoleState]>,
    born: [] as string[],
    witnessUsers: [ACTOR] as string[],
    witnessAdmissions: [ACTOR] as string[],
    world: 'shared' as 'shared' | 'exclusive',
    open: true,
    planMode: 'same' as 'same' | 'clone',
    brand: 'mint' as BrandMode,
    child: false,
    codes: [] as unknown[],
    orgResult: true as boolean | 'rows' | 'bad',
    shift: 'rows' as 'rows' | 'none',
    segments: 0,
    rolloutResult: true as boolean | 'rows' | 'bad',
    member: true,
    returnId: undefined as string | undefined,
    recordBorn: true,
    failAt: '' as '' | 'alias' | 'roles' | 'grants' | 'w16' | 'permissions' | 'orgs' | 'group' | 'shift',
    mutate: null as string[] | null,
    posture: (async (
      _trx: Parameters<ResolveSegmentCalculationPosture>[0],
      _orgId: Parameters<ResolveSegmentCalculationPosture>[1],
    ): ReturnType<ResolveSegmentCalculationPosture> => {
      throw new Error('posture unset')
    }),
  }
  return { ACTOR, USER, ORG, GROUP, SHIFT, harness }
})

vi.mock('../../src/db/pg', () => ({
  query: () => { throw new Error('pool query') },
  transaction: () => { throw new Error('pool transaction') },
}))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ transaction: () => { throw new Error('pool') } }) },
}))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/rbac/authorization-input-lock', async (load) => {
  const actual = await load<typeof import('../../src/rbac/authorization-input-lock')>()
  return {
    ...actual,
    withAuthorizationInputTransaction: function (
      plan: AuthorizationInputPlan,
      work: (tx: AuthorizationInputTx) => Promise<unknown>,
      options?: unknown,
    ) {
      harness.arity.push(arguments.length)
      harness.roots.push(options)
      return work(harness.make(plan))
    },
  }
})
vi.mock('../../src/auth/login-alias-service', async (load) => {
  const actual = await load<typeof import('../../src/auth/login-alias-service')>()
  return {
    ...actual,
    claimNonEmptyLoginAliasesOrThrow: async (options: Record<string, unknown>) => {
      harness.alias.push(options)
      if (harness.failAt === 'alias') throw new Error('stop')
      return []
    },
  }
})
vi.mock('../../src/rbac/role-assignment', async (load) => {
  const actual = await load<typeof import('../../src/rbac/role-assignment')>()
  return {
    ...actual,
    assignUserRoles: async (options: Record<string, unknown>) => {
      harness.roles.push(options)
      if (harness.failAt === 'roles') throw new Error('stop')
      return { affectedUserIds: [], rowCount: 0, delegatedAdminScopeCleanup: [] }
    },
  }
})
vi.mock('../../src/rbac/namespace-admission', async (load) => {
  const actual = await load<typeof import('../../src/rbac/namespace-admission')>()
  return {
    ...actual,
    grantNamespaceAdmissions: async (tx: GrantCall['tx'], options: GrantCall['options']) => {
      harness.grants.push({ tx, options })
      if (harness.failAt === 'grants') throw new Error('stop')
      return []
    },
    writeUserNamespaceAdmission: async (options: Record<string, unknown>, client: unknown) => {
      harness.w16.push({ ...options, client })
      if (harness.failAt === 'w16') throw new Error('stop')
    },
  }
})
vi.mock('../../src/attendance/w4c0-identity', async (load) => {
  const actual = await load<typeof import('../../src/attendance/w4c0-identity')>()
  harness.posture = actual.resolveSegmentCalculationPosture
  return {
    ...actual,
    resolveSegmentCalculationPosture: vi.fn((...args: Parameters<typeof actual.resolveSegmentCalculationPosture>) => harness.posture(...args)),
  }
})

import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  AuthorizationInputBusyError,
} from '../../src/rbac/authorization-input-lock'
import { buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from '../../src/attendance/attendance-timezone-runtime-locks'
import { resolveSegmentCalculationPosture } from '../../src/attendance/w4c0-identity'
import { PlatformActorAuthorityLost } from '../../src/admin/platform-actor-authority'
import { RoleRowMissingError } from '../../src/admin/role-row-contract'
import {
  AdminUserBirthAdmissionError,
  AttendanceDefaultShiftNotFoundError,
  AttendanceShiftReferenceUnavailableError,
  createAdminUserBirthCommand,
  type AdminUserBirthInput,
} from '../../src/admin/admin-user-birth-command'

const COMMAND = path.resolve(__dirname, '../../src/admin/admin-user-birth-command.ts')
const ROUTE = path.resolve(__dirname, '../../src/routes/admin-users.ts')
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const statements = () => harness.sql.map((call) => flat(call.sql))

function input(over: Partial<AdminUserBirthInput> = {}): AdminUserBirthInput {
  return {
    actorId: ACTOR,
    userId: USER,
    email: 'a@b.co',
    username: 'ada',
    name: 'Ada',
    mobile: '13800000000',
    employeeNo: 'E1',
    department: 'Ops',
    position: 'Lead',
    hireDate: '2026-01-02',
    passwordHash: 'hash',
    mustChangePassword: true,
    role: 'user',
    directPermissions: ['directory:read'],
    isActive: true,
    roleId: 'role-1',
    admissionNamespaces: ['directory'],
    attendanceOrgId: null,
    attendanceGroupId: null,
    attendanceGroupName: null,
    defaultShiftId: null,
    defaultShiftName: null,
    defaultShiftStartDate: null,
    ...over,
  }
}

function actorRow(id: string, patch: Record<string, unknown>) {
  return {
    id,
    name: id,
    email: null,
    username: id,
    mobile: null,
    activationStatus: 'activated',
    role: 'admin',
    isActive: true,
    accessGeneration: 1,
    deletedAt: null,
    purgedAt: null,
    ...patch,
  }
}

function makeTx(plan: AuthorizationInputPlan): AuthorizationInputTx {
  harness.plans.push(plan)
  const locked = new Map<string, ReturnType<typeof actorRow>>()
  if (harness.actor === 'present') locked.set(harness.actorId, actorRow(harness.actorId, harness.actorPatch))
  for (const id of harness.extraLocked) locked.set(id, actorRow(id, { role: 'user' }))
  const roleRows = new Map<string, RoleState>(harness.roleRows)
  const born = new Set(harness.born)
  const tx = {
    query: async (sql: string, params?: unknown[]) => {
      harness.sql.push({ sql, params })
      const text = flat(sql)
      if (text.includes('FROM role_permissions') && harness.mutate) harness.mutate.push('attendance:read')
      if (harness.failAt === 'permissions' && text.includes('INSERT INTO user_permissions')) throw new Error('stop')
      if (harness.failAt === 'orgs' && text.includes('INSERT INTO user_orgs')) throw new Error('stop')
      if (harness.failAt === 'group' && text.includes('INSERT INTO attendance_group_members')) throw new Error('stop')
      if (harness.failAt === 'shift' && text.includes('INSERT INTO attendance_shift_assignments')) throw new Error('stop')
      if (text === AUTHORIZATION_INPUT_STATEMENTS.readTimeouts) return { rows: [{ lock_timeout: '0', statement_timeout: '0' }] }
      if (text.startsWith('SELECT set_config')) return { rows: [{}] }
      if (text.includes("role_id = 'admin' FOR SHARE")) return { rows: harness.child ? [{ role_id: 'admin' }] : [] }
      if (text.includes('FROM role_permissions')) return { rows: harness.codes.map((permission_code) => ({ permission_code })) }
      if (text === 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired') {
        if (harness.orgResult === 'rows') return { rows: [{ acquired: true }, { acquired: false }] }
        if (harness.orgResult === 'bad') return { rows: [{ acquired: 'yes' }] }
        return { rows: [{ acquired: harness.orgResult }] }
      }
      if (text.includes('FROM attendance_shifts')) return { rows: harness.shift === 'none' ? [] : [{ segment_count: harness.segments }] }
      if (text === 'SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired') {
        if (harness.rolloutResult === 'rows') return { rows: [] }
        if (harness.rolloutResult === 'bad') return { rows: [{ acquired: null }] }
        return { rows: [{ acquired: harness.rolloutResult }] }
      }
      if (text.includes('attendance_calculation_rollout_state')) return { rows: [] }
      if (text.includes('INSERT INTO attendance_group_members')) return { rows: harness.member ? [{ memberId: 'member-1' }] : [] }
      if (text.includes('INSERT INTO attendance_shift_assignments')) return { rows: [{ assignmentId: params?.[0] }] }
      return { rows: [] }
    },
    locked,
    world: harness.world,
    plan: harness.planMode === 'clone' ? structuredClone(plan) : plan,
    born,
    roleRows,
    missingRoleIds: [...roleRows].filter(([, state]) => state === 'missing').map(([id]) => id),
    witnessed: { userIds: new Set(harness.witnessUsers), admissionUserIds: new Set(harness.witnessAdmissions) },
    acquire: () => { throw new Error('acquire') },
    requireUserRows: () => undefined,
    requireRoleRows: () => undefined,
    requireIdentityRead: () => undefined,
    insertUserForBirth: async (row: Record<string, unknown>) => {
      harness.inserts.push(row)
      const id = harness.returnId ?? String(row.id)
      if (harness.recordBorn) born.add(id)
      return { id }
    },
    open: harness.open,
  }
  if (harness.brand === 'mint') mintAuthorizationInputBrand(tx, [tx])
  if (harness.brand === 'closed') mintAuthorizationInputBrand(tx, [tx]).close()
  harness.tx = tx as AuthorizationInputTx
  return harness.tx
}

harness.make = makeTx

function reset() {
  harness.sql = []
  harness.inserts = []
  harness.plans = []
  harness.roots = []
  harness.arity = []
  harness.alias = []
  harness.roles = []
  harness.grants = []
  harness.w16 = []
  harness.tx = null
  harness.actorId = ACTOR
  harness.actor = 'present'
  harness.actorPatch = {}
  harness.extraLocked = []
  harness.roleRows = [['role-1', 'held']]
  harness.born = []
  harness.witnessUsers = [ACTOR]
  harness.witnessAdmissions = [ACTOR]
  harness.world = 'shared'
  harness.open = true
  harness.planMode = 'same'
  harness.brand = 'mint'
  harness.child = false
  harness.codes = []
  harness.orgResult = true
  harness.shift = 'rows'
  harness.segments = 0
  harness.rolloutResult = true
  harness.member = true
  harness.returnId = undefined
  harness.recordBorn = true
  harness.failAt = ''
  harness.mutate = null
  vi.mocked(resolveSegmentCalculationPosture).mockReset()
  vi.mocked(resolveSegmentCalculationPosture).mockImplementation((...args: Parameters<ResolveSegmentCalculationPosture>) => harness.posture(...args))
}

const invoke = createAdminUserBirthCommand as (
  value: AdminUserBirthInput,
  extra?: unknown,
) => ReturnType<typeof createAdminUserBirthCommand>

async function birth(value: AdminUserBirthInput, extra?: unknown) {
  return extra === undefined ? createAdminUserBirthCommand(value) : invoke(value, extra)
}

beforeEach(reset)

describe('createAdminUserBirthCommand', () => {
  it('writes the closed user row, alias, role, admission, disabled attendance and direct permissions without onboarding', async () => {
    const direct = ['directory:read']
    harness.mutate = direct
    const onboarding = await birth(input({ directPermissions: direct }))
    expect(onboarding).toBeNull()
    expect(harness.arity).toEqual([2])
    expect(harness.roots).toEqual([undefined])
    expect(harness.plans).toHaveLength(1)
    expect(Object.isFrozen(harness.plans[0])).toBe(true)
    expect(harness.plans[0]).toEqual({ intent: 'BIRTH', roleIds: ['role-1'], witness: { userIds: [ACTOR], admissionUserIds: [ACTOR] } })
    expect('userIds' in harness.plans[0]).toBe(false)
    expect(harness.inserts).toEqual([{
      id: USER,
      email: 'a@b.co',
      username: 'ada',
      name: 'Ada',
      mobile: '13800000000',
      employee_no: 'E1',
      department: 'Ops',
      position: 'Lead',
      hire_date: '2026-01-02',
      password_hash: 'hash',
      must_change_password: true,
      role: 'user',
      permissions: '["directory:read"]',
      is_active: true,
      is_admin: false,
      activation_status: 'activated',
      local_password_set: true,
    }])
    expect(harness.inserts[0]).not.toHaveProperty('created_at')
    expect(harness.alias).toEqual([{ userId: USER, email: 'a@b.co', username: 'ada', mobile: '13800000000', source: 'admin_create', client: harness.tx }])
    expect(harness.roles).toEqual([{ userIds: [USER], roleId: 'role-1', assignmentSource: 'creation', scope: { kind: 'platform-admin' }, executor: harness.tx }])
    expect(harness.grants).toHaveLength(1)
    expect(harness.grants[0]?.tx === harness.tx).toBe(true)
    expect(harness.grants[0]?.options).toEqual({ userId: USER, namespaces: ['directory'], actorId: ACTOR, source: 'admin_create' })
    expect(harness.grants[0]?.options.namespaces).toEqual(['directory'])
    expect(harness.w16).toEqual([{ userId: USER, namespace: 'attendance', enabled: false, actorId: ACTOR, source: 'admin_create', client: harness.tx }])
    expect(statements().some((sql) => sql.includes('INSERT INTO user_permissions'))).toBe(true)
    expect(harness.sql.find((call) => flat(call.sql).includes('INSERT INTO user_permissions'))?.params).toEqual([USER, 'directory:read'])
    expect(direct).toEqual(['directory:read', 'attendance:read'])
    expect(statements().some((sql) => sql.includes('user_orgs') || sql.includes('pg_try_advisory') || sql.includes('FOR SHARE'))).toBe(false)
  })

  it('keeps org-only membership active without the timezone try', async () => {
    const onboarding = await birth(input({ attendanceOrgId: ORG, isActive: false, role: 'admin' }))
    expect(onboarding).toEqual({ orgId: ORG, group: null, defaultShift: null })
    expect(harness.inserts[0]).toMatchObject({ is_active: false, is_admin: true, role: 'admin' })
    const membership = harness.sql.find((call) => flat(call.sql).includes('INSERT INTO user_orgs'))
    expect(flat(membership?.sql ?? '')).toContain('VALUES ($1, $2, TRUE)')
    expect(membership?.params).toEqual([USER, ORG])
    expect(statements().some((sql) => sql.includes('pg_try_advisory') || sql.includes('attendance_group_members') || sql.includes('attendance_shift_assignments'))).toBe(false)
  })

  it('tries the org lock for a group and records the member', async () => {
    harness.member = false
    const onboarding = await birth(input({
      attendanceOrgId: ORG,
      attendanceGroupId: GROUP,
      attendanceGroupName: 'Day',
    }))
    expect(onboarding).toEqual({ orgId: ORG, group: { id: GROUP, name: 'Day', memberCreated: false }, defaultShift: null })
    const lock = harness.sql.find((call) => flat(call.sql) === 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired')
    expect(lock?.params).toEqual([buildAttendanceTimezoneRuntimeOrgLockKeyV1(ORG)])
    expect(statements().some((sql) => sql.includes('pg_try_advisory_xact_lock_shared') || sql.includes('FROM attendance_shifts'))).toBe(false)
  })

  it('assigns one single-segment shift without the rollout try', async () => {
    harness.segments = 1
    const written = await birth(input({
      attendanceOrgId: ORG,
      defaultShiftId: SHIFT,
      defaultShiftName: 'Early',
      defaultShiftStartDate: '2026-11-18',
    }))
    const assignment = harness.sql.find((call) => flat(call.sql).includes('INSERT INTO attendance_shift_assignments'))
    expect(written).toEqual({
      orgId: ORG,
      group: null,
      defaultShift: { id: SHIFT, name: 'Early', startDate: '2026-11-18', assignmentId: assignment?.params?.[0] },
    })
    expect(flat(assignment?.sql ?? '')).toContain('$5::date')
    expect(assignment?.params).toEqual([assignment?.params?.[0], ORG, USER, SHIFT, '2026-11-18'])
    expect(statements().some((sql) => sql.includes('pg_try_advisory_xact_lock_shared'))).toBe(false)
  })

  it('holds a multisegment reference only after the shared try succeeds', async () => {
    harness.segments = 2
    vi.mocked(resolveSegmentCalculationPosture).mockResolvedValueOnce({ referenceSegments: true } as Awaited<ReturnType<typeof resolveSegmentCalculationPosture>>)
    const onboarding = await birth(input({
      attendanceOrgId: ORG,
      defaultShiftId: SHIFT,
      defaultShiftName: 'Split',
      defaultShiftStartDate: '2026-11-18',
    }))
    expect(onboarding?.defaultShift?.id).toBe(SHIFT)
    expect(statements().filter((sql) => sql === 'SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired')).toHaveLength(1)
    expect(resolveSegmentCalculationPosture).toHaveBeenCalledWith(harness.tx, ORG)
  })

  it('refuses a multisegment shift when the real missing posture has no reference', async () => {
    harness.segments = 2
    await expect(birth(input({
      attendanceOrgId: ORG,
      defaultShiftId: SHIFT,
      defaultShiftStartDate: '2026-11-18',
    }))).rejects.toMatchObject({
      name: 'AttendanceShiftReferenceUnavailableError',
      status: 422,
      code: 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED',
      message: expect.stringContaining('2 segments'),
      details: [{ field: 'defaultShiftId', message: 'Multi-segment shift is authoring preview-only while segment calculation is disabled' }],
    })
    expect(statements()).toContain('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired')
    expect(harness.inserts).toEqual([])
  })

  it('keeps an invalid rollout org on the 422 path and does not try class-00', async () => {
    harness.segments = 3
    await expect(birth(input({
      attendanceOrgId: 'not-an-org',
      defaultShiftId: SHIFT,
      defaultShiftStartDate: '2026-11-18',
    }))).rejects.toBeInstanceOf(AttendanceShiftReferenceUnavailableError)
    expect(statements().some((sql) => sql.includes('pg_try_advisory_xact_lock_shared'))).toBe(false)
    expect(harness.inserts).toEqual([])
  })

  it('keeps a missing shift as 404 before any target write', async () => {
    harness.shift = 'none'
    await expect(birth(input({
      attendanceOrgId: ORG,
      defaultShiftId: SHIFT,
      defaultShiftStartDate: '2026-11-18',
    }))).rejects.toMatchObject({ name: 'AttendanceDefaultShiftNotFoundError', status: 404, code: 'DEFAULT_SHIFT_NOT_FOUND', message: 'Default shift not found' })
    expect(harness.inserts).toEqual([])
  })

  it('maps a false org try to lock_timeout and a malformed org result to the fixed contract', async () => {
    harness.orgResult = false
    await expect(birth(input({ attendanceOrgId: ORG, attendanceGroupId: GROUP }))).rejects.toMatchObject({ name: 'AuthorizationInputBusyError', busyReason: 'lock_timeout' })
    expect(harness.inserts).toEqual([])
    reset()
    harness.orgResult = 'bad'
    await expect(birth(input({ attendanceOrgId: ORG, attendanceGroupId: GROUP }))).rejects.toMatchObject({ reason: 'birth_org_lock_result' })
    reset()
    harness.orgResult = 'rows'
    await expect(birth(input({ attendanceOrgId: ORG, defaultShiftId: SHIFT }))).rejects.toMatchObject({ reason: 'birth_org_lock_result' })
  })

  it('maps a false rollout try to the rollout busy error and a malformed result to the protocol code', async () => {
    harness.segments = 2
    harness.rolloutResult = false
    await expect(birth(input({
      attendanceOrgId: ORG,
      defaultShiftId: SHIFT,
      defaultShiftStartDate: '2026-11-18',
    }))).rejects.toMatchObject({ name: 'AttendanceW4OperationError', code: 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY' })
    expect(harness.inserts).toEqual([])
    reset()
    harness.segments = 2
    harness.rolloutResult = 'bad'
    await expect(birth(input({
      attendanceOrgId: ORG,
      defaultShiftId: SHIFT,
      defaultShiftStartDate: '2026-11-18',
    }))).rejects.toMatchObject({ name: 'AttendanceW4IdentityError', code: 'W4C0_BIRTH_ROLLOUT_TRY_RESULT_INVALID' })
  })

  it('refuses a lost actor before a missing role, and accepts a raw admin without the child share', async () => {
    harness.roleRows = [['role-1', 'missing']]
    harness.actor = 'missing'
    await expect(birth(input())).rejects.toBeInstanceOf(PlatformActorAuthorityLost)
    for (const actorPatch of [
      { deletedAt: '2026-01-01' },
      { purgedAt: '2026-01-01' },
      { isActive: false },
      { activationStatus: 'pending' },
      { activationStatus: null },
    ]) {
      reset()
      harness.actorPatch = actorPatch
      await expect(birth(input())).rejects.toMatchObject({ name: 'PlatformActorAuthorityLost', code: 'FORBIDDEN', message: 'Admin access required' })
      expect(harness.inserts).toEqual([])
    }
    reset()
    harness.roleRows = []
    await birth(input({ roleId: '', directPermissions: [], admissionNamespaces: [] }))
    expect(statements().some((sql) => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(false)
  })

  it('requires the exact admin child share when the raw role is not admin', async () => {
    harness.actorPatch = { role: 'user' }
    harness.child = false
    await expect(birth(input())).rejects.toBeInstanceOf(PlatformActorAuthorityLost)
    expect(statements()).toContain("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE")
    const windows = harness.sql.filter((call) => flat(call.sql) === AUTHORIZATION_INPUT_STATEMENTS.setTimeouts)
    expect(windows[0]?.params).toEqual([String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)])
    expect(windows[1]?.params).toEqual(['0', '0'])
    reset()
    harness.actorPatch = { role: 'user' }
    harness.child = true
    harness.roleRows = []
    await expect(birth(input({ roleId: '', directPermissions: [], admissionNamespaces: [] }))).resolves.toBeNull()
  })

  it('refuses a missing, foreign, or extra selected role and reads fresh role codes', async () => {
    harness.roleRows = [['role-1', 'missing']]
    await expect(birth(input())).rejects.toMatchObject({ name: 'RoleRowMissingError', code: 'ROLE_NOT_FOUND', message: 'Role not found' })
    expect(harness.inserts).toEqual([])
    reset()
    harness.roleRows = [['other', 'held']]
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_role_rows' })
    reset()
    harness.roleRows = [['role-1', 'held'], ['other', 'held']]
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_role_rows' })
    reset()
    harness.roleRows = [['role-1', 'held']]
    await expect(birth(input({ roleId: '' }))).rejects.toMatchObject({ reason: 'birth_role_rows' })
    reset()
    harness.codes = ['   ', null, 'attendance:read']
    await birth(input({ directPermissions: [], admissionNamespaces: ['attendance'] }))
    expect(harness.grants[0]?.tx === harness.tx).toBe(true)
    expect(harness.grants[0]?.options).toEqual({ userId: USER, namespaces: ['attendance'], actorId: ACTOR, source: 'admin_create' })
    expect(harness.w16).toEqual([])
  })

  it('rejects an unsupported namespace and a namespace the fresh codes do not derive', async () => {
    await expect(birth(input({ admissionNamespaces: ['workflow'] }))).rejects.toMatchObject({
      name: 'AdminUserBirthAdmissionError',
      code: 'NAMESPACE_NOT_SUPPORTED',
      message: 'namespace is not managed by plugin admission controls',
    })
    reset()
    await expect(birth(input({ directPermissions: [], admissionNamespaces: ['attendance'] }))).rejects.toMatchObject({
      name: 'AdminUserBirthAdmissionError',
      code: 'ADMISSION_NAMESPACE_NOT_DERIVED',
      message: 'admissionNamespaces must be derived from the selected role and preset',
    })
    expect(harness.inserts).toEqual([])
  })

  it('rejects target collision, a foreign witness, and a born or returned id that is not the owned target', async () => {
    await expect(birth(input({ userId: ACTOR }))).rejects.toMatchObject({ reason: 'birth_target_collision' })
    reset()
    harness.extraLocked = [USER]
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_target_collision' })
    reset()
    harness.witnessUsers = []
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_actor_witness' })
    reset()
    harness.born = [ACTOR]
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_actor_witness' })
    reset()
    harness.recordBorn = false
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_actor_witness' })
    expect(harness.alias).toEqual([])
    reset()
    harness.returnId = 'other-user'
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_returned_id' })
    expect(harness.alias).toEqual([])
  })

  it('rejects a closed input, a raw token, a closed token, and a different plan before target DML', async () => {
    await expect(birth(input({ passwordHash: '' }))).rejects.toMatchObject({ reason: 'birth_input' })
    await expect(birth(input({ actorId: ' actor-1' }))).rejects.toMatchObject({ reason: 'birth_input' })
    await expect(birth(input({ roleId: ' role-1 ' }))).rejects.toMatchObject({ reason: 'birth_input' })
    await expect(birth({ ...input(), callback() { return undefined } } as AdminUserBirthInput)).rejects.toMatchObject({ reason: 'birth_input' })
    expect(harness.plans).toEqual([])
    harness.brand = 'none'
    await expect(birth(input())).rejects.toMatchObject({ name: 'AuthorizationInputTokenRejectedError', reason: 'unbranded' })
    reset()
    harness.brand = 'closed'
    await expect(birth(input())).rejects.toBeInstanceOf(AuthorizationInputTokenRejectedError)
    reset()
    harness.planMode = 'clone'
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_context' })
    reset()
    harness.world = 'exclusive'
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_context' })
    reset()
    harness.open = false
    await expect(birth(input())).rejects.toMatchObject({ reason: 'birth_context' })
    expect(harness.inserts).toEqual([])
  })

  it('stops later dependent writers when an earlier one fails', async () => {
    const rich = input({
      attendanceOrgId: ORG,
      attendanceGroupId: GROUP,
      defaultShiftId: SHIFT,
      defaultShiftStartDate: '2026-11-18',
    })
    const stage = { alias: 0, roles: 1, grants: 2, w16: 3, permissions: 4, orgs: 5, group: 6, shift: 7 } as const
    for (const failAt of Object.keys(stage) as Array<keyof typeof stage>) {
      reset()
      harness.failAt = failAt
      harness.segments = 1
      await expect(birth(rich)).rejects.toThrow('stop')
      const at = stage[failAt]
      expect(harness.inserts).toHaveLength(1)
      expect(harness.alias).toHaveLength(1)
      expect(harness.roles).toHaveLength(at >= 1 ? 1 : 0)
      expect(harness.grants).toHaveLength(at >= 2 ? 1 : 0)
      expect(harness.w16).toHaveLength(at >= 3 ? 1 : 0)
      const text = statements().join('\n')
      expect(text.includes('INSERT INTO user_permissions')).toBe(at >= 4)
      expect(text.includes('INSERT INTO user_orgs')).toBe(at >= 5)
      expect(text.includes('INSERT INTO attendance_group_members')).toBe(at >= 6)
      expect(text.includes('INSERT INTO attendance_shift_assignments')).toBe(at >= 7)
    }
  })

  it('ignores a second argument and leaves commit failure to the root', async () => {
    await birth(input(), { client: {}, work() { return undefined } })
    expect(harness.arity).toEqual([2])
    expect(createAdminUserBirthCommand.length).toBe(1)
  })

  it('pins the route literals and keeps post-commit work outside the command', () => {
    const command = fs.readFileSync(COMMAND, 'utf8')
    const route = fs.readFileSync(ROUTE, 'utf8')
    expect(command.match(/tx\.insertUserForBirth\(\{/g)).toHaveLength(1)
    expect(command.match(/withAuthorizationInputTransaction\(/g)).toHaveLength(1)
    expect(command).toContain('return withAuthorizationInputTransaction(context.plan, async (tx) => {')
    expect(command).not.toMatch(/tx\.acquire|from ['"]pg['"]|from ['"].*db\/pg['"]|PoolClient|enterAuthorizationInputTransaction|LOCK TABLE|20261106/)
    expect(command).not.toMatch(/auditLog|invalidateUserPerms|fetchUserAccessSnapshot|issueInviteToken|recordInvite/)
    expect(command.match(/source: 'admin_create'/g)).toHaveLength(3)
    const call = route.indexOf('await createAdminUserBirthCommand({')
    expect(call).toBeGreaterThan(0)
    expect(route.slice(call, call + 80)).not.toContain('...')
    expect(route.indexOf('invalidateUserPerms(userId)', call)).toBeGreaterThan(call)
    expect(route.indexOf('await auditLog({', call)).toBeGreaterThan(call)
    expect(route.indexOf('fetchUserAccessSnapshot(userId)', call)).toBeGreaterThan(call)
    expect(route.indexOf('issueInviteToken({', call)).toBeGreaterThan(call)
    expect(route).toContain("return res.status(409).json({ ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } })")
    expect(route).toContain("return jsonError(res, 503, 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY', 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY')")
    expect(route).toContain('return jsonError(res, error.status, error.code, error.message, error.details)')
    expect(route).toContain("return jsonError(res, 400, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls')")
    expect(route).not.toContain('acquireAttendanceCalculationRolloutLock')
    expect(AuthorizationInputBusyError).toBeTruthy()
    expect(AdminUserBirthAdmissionError).toBeTruthy()
  })
})
