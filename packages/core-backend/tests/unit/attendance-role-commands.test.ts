import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'

type UserRow = {
  id: string
  email: string
  name: string | null
  employeeNo: string | null
  department: string | null
  role: string
  is_active: boolean
  is_admin: boolean
  activation_status: string
  deleted_at: string | null
  purged_at: string | null
  last_login_at: string | null
  created_at: string
}

type Call = { kind: string; params: unknown[]; rows: number }

const TEMPLATES = ['attendance_admin', 'attendance_approver', 'attendance_employee', 'attendance_importer']
const CUSTOM = 'attendance_compat_custom'
const savedTimeouts = { lock_timeout: '2s', statement_timeout: '3s' }

const state = vi.hoisted(() => ({
  users: new Map<string, UserRow>(),
  adminEdge: new Set<string>(),
  heldRoles: new Set<string>(),
  calls: [] as Call[],
  boundaries: [] as string[],
  inside: false,
  outside: 0,
  dropEdgeOnShare: false,
  mutate: undefined as (() => void) | undefined,
  transform: undefined as ((tx: AuthorizationInputTx) => AuthorizationInputTx) | undefined,
}))

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), entry: vi.fn() }))

vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: { get: () => ({ transaction: mocks.transaction }) } }))
vi.mock('../../src/rbac/authorization-input-lock', async (original) => {
  const actual = await original<typeof import('../../src/rbac/authorization-input-lock')>()
  return {
    ...actual,
    withAuthorizationInputTransaction: (plan: AuthorizationInputPlan, work: (tx: AuthorizationInputTx) => Promise<unknown>) => {
      mocks.entry(plan)
      return actual.withAuthorizationInputTransaction(plan, (tx) => work(state.transform ? state.transform(tx) : tx))
    },
  }
})
vi.mock('../../src/db/pg', () => ({ query: mocks.query, transaction: mocks.transaction, pool: { query: mocks.query } }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/metrics/metrics', () => ({ metrics: new Proxy({}, { get: () => () => undefined }) }))

import { AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS } from '../../src/rbac/authorization-input-lock'
import { assignAttendanceGlobalRolesCommand, unassignAttendanceGlobalRolesCommand } from '../../src/admin/attendance-role-commands'

const lockWindow = [String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)]
const restoreWindow = [savedTimeouts.lock_timeout, savedTimeouts.statement_timeout]
const pair = [lockWindow, restoreWindow]

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const assignParents = [...TEMPLATES, CUSTOM].sort(byCodeUnit)

function addUser(id: string, role = 'user', patch: Partial<UserRow> = {}) {
  state.users.set(id, {
    id, email: `${id}@example.test`, name: id, employeeNo: null, department: null, role,
    is_active: true, is_admin: false, activation_status: 'activated', deleted_at: null, purged_at: null,
    last_login_at: null, created_at: '2026-01-01T00:00:00.000Z', ...patch,
  })
}

function commandInput(patch: Partial<{ actorId: string; userIds: string[]; roleId: string; legacyAdminClaim: boolean; includeProfile: boolean }> = {}) {
  return { actorId: 'actor', userIds: ['target'] as string[], roleId: CUSTOM, legacyAdminClaim: true, includeProfile: false, ...patch }
}

function kinds(): string[] {
  return state.calls.map((call) => call.kind)
}

function paramsOf(kind: string): unknown[][] {
  return state.calls.filter((call) => call.kind === kind).map((call) => call.params)
}

function targetItem(row: UserRow) {
  return { id: row.id, email: row.email, name: row.name, employeeNo: row.employeeNo, department: row.department, is_active: row.is_active }
}

function profileOf(row: UserRow) {
  return {
    id: row.id, email: row.email, name: row.name, employeeNo: row.employeeNo, department: row.department,
    role: row.role, is_active: row.is_active, is_admin: row.is_admin, last_login_at: row.last_login_at, created_at: row.created_at,
  }
}

function lockKinds(roleIds: readonly string[], subjects: readonly string[]): string[] {
  return [
    'isolation', 'read-timeouts', 'set-timeouts', 'world',
    ...roleIds.map(() => 'parent'),
    ...subjects.map(() => 'admission'),
    // D21 (Y5a): the access-graph mutex bumps the sorted subjects' version rows before the users rows.
    ...(subjects.length > 0 ? ['authz-version'] : []),
    ...subjects.map(() => 'user-row'),
    'set-timeouts',
  ]
}

function expectPrefix(roleIds: readonly string[], subjects: readonly string[], tail: readonly string[]) {
  // D21 (Y5a): role-assignment bumps the written subjects again right before each membership DML.
  const withBumps = tail.flatMap((kind) => (kind === 'assign-dml' || kind === 'revoke-dml' ? ['authz-version', kind] : [kind]))
  expect(kinds()).toEqual([...lockKinds(roleIds, subjects), 'member-list', ...withBumps])
}

function expectPlan(intent: 'GRANT_ROLE' | 'REVOKE_ROLE', roleIds: readonly string[], subjects: readonly string[]) {
  const plan = mocks.entry.mock.calls[0][0] as AuthorizationInputPlan
  expect(plan).toEqual({
    intent, roleIds: [...roleIds], userIds: [...subjects], admissionUserIds: [...subjects],
    witness: { userIds: [...subjects], admissionUserIds: [...subjects] },
  })
  for (const value of [plan, plan.roleIds, plan.userIds, plan.admissionUserIds, plan.witness, plan.witness?.userIds, plan.witness?.admissionUserIds]) {
    expect(Object.isFrozen(value)).toBe(true)
  }
  expect(plan.platformAdminInvariant).not.toBe(true)
}

function expectSubjectLocks(subjects: readonly string[]) {
  expect(paramsOf('admission')).toEqual(subjects.map((id) => [`namespace-admission:${id}`]))
  expect(paramsOf('user-row')).toEqual(subjects.map((id) => [id]))
  // D21 (Y5a): the mutex bumps every locked subject's version row in one sorted statement, after the
  // admission advisories and before the first users-row lock.
  const kinds = state.calls.map((call) => call.kind)
  expect(paramsOf('authz-version')[0]).toEqual([[...subjects].sort()])
  expect(kinds.indexOf('authz-version')).toBeGreaterThan(kinds.lastIndexOf('admission'))
  expect(kinds.indexOf('authz-version')).toBeLessThan(kinds.indexOf('user-row'))
}

function expectRoot(closed: 'COMMIT' | 'ROLLBACK') {
  expect(state.outside).toBe(0)
  expect(state.boundaries).toEqual(['BEGIN', closed])
  expect(mocks.transaction).toHaveBeenCalledTimes(1)
}

function classify(sql: string): string {
  const text = sql.replace(/\s+/g, ' ').trim()
  if (text === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return 'isolation'
  if (text === "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout") return 'read-timeouts'
  if (text === "SELECT set_config('lock_timeout', $1, true) AS lock_timeout, set_config('statement_timeout', $2, true) AS statement_timeout") return 'set-timeouts'
  if (text === 'SELECT pg_advisory_xact_lock_shared(20261106, 1)') return 'world'
  if (text === 'SELECT id::text AS id FROM roles WHERE id = $1::text FOR SHARE') return 'parent'
  if (text === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))') return 'admission'
  if (text.includes('activation_status') && text.includes('FOR UPDATE') && text.includes('FROM users') && !text.includes('FROM users u')) return 'user-row'
  if (text === "SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE") return 'admin-edge'
  if (text.includes('ORDER BY role_id ASC') && text.includes('FROM user_roles')) return 'member-list'
  if (text === 'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1') return 'is-admin'
  if (text.includes('FOR SHARE OF u') && text.includes('FROM users u') && text.includes('employee_no AS "employeeNo"') && !text.includes('is_admin')) return 'targets'
  if (text.includes('last_login_at') && text.includes('is_admin') && text.includes('FROM users') && !text.includes('FOR UPDATE') && !text.includes('FOR SHARE')) return 'profile'
  // D21 (Y5a): the subject authorization version bump, one sorted statement (a protocol upsert, no command state).
  if (text.startsWith('INSERT INTO subject_authorization_versions ')) return 'authz-version'
  if (text.startsWith('INSERT INTO user_roles ')) return 'assign-dml'
  if (text.startsWith('DELETE FROM user_roles ')) return 'revoke-dml'
  if (text === 'SELECT permission_code FROM role_permissions WHERE role_id = $1') return 'role-permissions'
  throw new Error(`UNCLASSIFIED_SQL ${text}`)
}

function rowsOf(rows: Array<Record<string, unknown>>) {
  return { rows, rowCount: rows.length }
}

function answer(kind: string, params: unknown[]) {
  if (kind === 'read-timeouts') return rowsOf([{ ...savedTimeouts }])
  if (kind === 'authz-version') return { rows: [], rowCount: (params[0] as unknown[]).length }
  if (kind === 'parent') return state.heldRoles.has(String(params[0])) ? rowsOf([{ id: params[0] }]) : rowsOf([])
  if (kind === 'admission') {
    if (!String(params[0]).startsWith('namespace-admission:')) throw new Error(`UNCLASSIFIED_ADMISSION ${String(params[0])}`)
    return rowsOf([])
  }
  if (kind === 'user-row') {
    const row = state.users.get(String(params[0]))
    return row ? rowsOf([{
      id: row.id, name: row.name, email: row.email, username: row.id, mobile: null, activation_status: row.activation_status,
      role: row.role, is_active: row.is_active, access_generation: 0, deleted_at: row.deleted_at, purged_at: row.purged_at,
    }]) : rowsOf([])
  }
  if (kind === 'member-list' || kind === 'admin-edge') {
    return state.adminEdge.has(String(params[0])) ? rowsOf([{ role_id: 'admin' }]) : rowsOf([])
  }
  if (kind === 'is-admin') return state.adminEdge.has(String(params[0])) && params[1] === 'admin' ? rowsOf([{ present: 1 }]) : rowsOf([])
  if (kind === 'targets') {
    const rows = (params[0] as string[]).flatMap((id) => {
      const row = state.users.get(id)
      return row && row.deleted_at === null && row.purged_at === null ? [targetItem(row)] : []
    })
    return rowsOf(rows)
  }
  if (kind === 'profile') {
    const row = state.users.get(String(params[0]))
    return row ? rowsOf([profileOf(row)]) : rowsOf([])
  }
  if (kind === 'assign-dml' || kind === 'revoke-dml') return rowsOf((params[0] as string[]).map((user_id) => ({ user_id })))
  if (kind === 'isolation' || kind === 'set-timeouts' || kind === 'world' || kind === 'role-permissions') return rowsOf([])
  throw new Error(`UNANSWERED_SQL ${kind}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.users = new Map()
  state.adminEdge = new Set()
  state.heldRoles = new Set(TEMPLATES)
  state.calls = []
  state.boundaries = []
  state.inside = false
  state.outside = 0
  state.dropEdgeOnShare = false
  state.mutate = undefined
  state.transform = undefined
  addUser('actor', 'admin')
  addUser('target', 'user', { activation_status: 'pending' })
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (!state.inside) {
      state.outside += 1
      throw new Error('QUERY_OUTSIDE_ROOT')
    }
    if (state.mutate) {
      const mutate = state.mutate
      state.mutate = undefined
      mutate()
    }
    const kind = classify(sql)
    if (kind === 'admin-edge' && state.dropEdgeOnShare) state.adminEdge.delete(String(params?.[0]))
    const result = answer(kind, params ?? [])
    state.calls.push({ kind, params: params ?? [], rows: result.rows.length })
    return result
  })
  mocks.transaction.mockImplementation(async (work: (client: { query: typeof mocks.query }) => Promise<unknown>) => {
    state.boundaries.push('BEGIN')
    state.inside = true
    try {
      const result = await work({ query: mocks.query })
      state.boundaries.push('COMMIT')
      return result
    } catch (error) {
      state.boundaries.push('ROLLBACK')
      throw error
    } finally {
      state.inside = false
    }
  })
})

describe('attendance global role commands through the real authorization-input entry', () => {
  const subjects = ['actor', 'target']

  it('assigns sorted template-plus-custom parents for a raw-admin true claim with no admin edge', async () => {
    const target = state.users.get('target')!
    const result = await assignAttendanceGlobalRolesCommand(commandInput({ includeProfile: true }))
    expect(target.activation_status).toBe('pending')
    expect(result).toEqual({
      membership: { affectedUserIds: ['target'], rowCount: 1, delegatedAdminScopeCleanup: [] },
      targets: { items: [targetItem(target)], missingUserIds: [], inactiveUserIds: [] },
      profile: profileOf(target),
    })
    expectPlan('GRANT_ROLE', assignParents, subjects)
    expect(state.calls.filter((call) => call.kind === 'parent').map((call) => [call.params[0], call.rows])).toEqual(
      assignParents.map((roleId) => [roleId, state.heldRoles.has(roleId) ? 1 : 0]),
    )
    expectSubjectLocks(subjects)
    expect(paramsOf('set-timeouts')).toEqual(pair)
    expect(paramsOf('assign-dml')).toEqual([[['target'], CUSTOM, 'manual']])
    expect(paramsOf('profile')).toEqual([['target']])
    expectPrefix(assignParents, subjects, ['targets', 'assign-dml', 'profile'])
    expectRoot('COMMIT')
  })

  it('revokes only the action role when that parent row is missing', async () => {
    const result = await unassignAttendanceGlobalRolesCommand(commandInput())
    expect(result).toEqual({
      membership: { affectedUserIds: ['target'], rowCount: 1, delegatedAdminScopeCleanup: [] },
      targets: { items: [targetItem(state.users.get('target')!)], missingUserIds: [], inactiveUserIds: [] },
      profile: null,
    })
    expectPlan('REVOKE_ROLE', [CUSTOM], subjects)
    expect(state.calls.filter((call) => call.kind === 'parent').map((call) => [call.params[0], call.rows])).toEqual([[CUSTOM, 0]])
    expect(paramsOf('revoke-dml')).toEqual([[['target'], CUSTOM]])
    expect(paramsOf('role-permissions')).toEqual([[CUSTOM]])
    expectPrefix([CUSTOM], subjects, ['targets', 'revoke-dml', 'role-permissions'])
    expectRoot('COMMIT')
  })

  it('accepts a false claim from a raw admin only while the admin edge and membership reader agree', async () => {
    state.adminEdge.add('actor')
    const result = await assignAttendanceGlobalRolesCommand(commandInput({ legacyAdminClaim: false }))
    expect(result.membership).toEqual({ affectedUserIds: ['target'], rowCount: 1, delegatedAdminScopeCleanup: [] })
    expect(result.profile).toBeNull()
    expect(paramsOf('admin-edge')).toEqual([['actor']])
    expect(paramsOf('is-admin')).toEqual([['actor', 'admin']])
    expect(paramsOf('set-timeouts')).toEqual([...pair, ...pair])
    expectPrefix(assignParents, subjects, ['read-timeouts', 'set-timeouts', 'admin-edge', 'set-timeouts', 'is-admin', 'targets', 'assign-dml'])
    expectRoot('COMMIT')
  })

  it('returns global 403 before target eligibility when a false claim has no admin edge', async () => {
    state.users.delete('target')
    await expect(assignAttendanceGlobalRolesCommand(commandInput({ legacyAdminClaim: false }))).rejects.toMatchObject({
      name: 'AttendanceAdminUserScopeError', status: 403, code: 'FORBIDDEN',
      message: 'Platform admin access required for global user scope',
    })
    expectPrefix(assignParents, subjects, ['read-timeouts', 'set-timeouts', 'admin-edge', 'set-timeouts'])
    expectRoot('ROLLBACK')
  })

  it('keeps a non-raw actor when the admin membership stays through the share', async () => {
    state.users.get('actor')!.role = 'user'
    state.adminEdge.add('actor')
    const result = await assignAttendanceGlobalRolesCommand(commandInput())
    expect(result.targets.missingUserIds).toEqual([])
    expect(result.targets.inactiveUserIds).toEqual([])
    expect(paramsOf('admin-edge')).toEqual([['actor']])
    expectPrefix(assignParents, subjects, ['read-timeouts', 'set-timeouts', 'admin-edge', 'set-timeouts', 'targets', 'assign-dml'])
    expectRoot('COMMIT')
  })

  it('rejects a non-raw actor when the shared admin edge disappears', async () => {
    state.users.get('actor')!.role = 'user'
    state.adminEdge.add('actor')
    state.dropEdgeOnShare = true
    await expect(assignAttendanceGlobalRolesCommand(commandInput())).rejects.toMatchObject({
      name: 'PlatformActorAuthorityLost', code: 'FORBIDDEN', message: 'Admin access required',
    })
    expect(state.calls.find((call) => call.kind === 'member-list')).toMatchObject({ rows: 1 })
    expect(state.calls.find((call) => call.kind === 'admin-edge')).toMatchObject({ rows: 0 })
    expectPrefix(assignParents, subjects, ['read-timeouts', 'set-timeouts', 'admin-edge', 'set-timeouts'])
    expectRoot('ROLLBACK')
  })

  it('refuses an unactivated raw admin before the true-claim path reads an admin edge', async () => {
    state.users.get('actor')!.activation_status = 'pending'
    await expect(assignAttendanceGlobalRolesCommand(commandInput())).rejects.toMatchObject({
      name: 'PlatformActorAuthorityLost', code: 'FORBIDDEN', message: 'Admin access required',
    })
    expect(kinds()).toEqual(lockKinds(assignParents, subjects))
    expectRoot('ROLLBACK')
  })

  it.each([
    ['inactive', () => { state.users.get('target')!.is_active = false }],
    ['missing', () => { state.users.delete('target') }],
  ] as const)('rejects an %s target with the existing eligibility 404', async (_label, arrange) => {
    arrange()
    await expect(assignAttendanceGlobalRolesCommand(commandInput())).rejects.toMatchObject({
      name: 'AttendanceAdminUserScopeError', status: 404, code: 'USER_TARGET_NOT_FOUND',
      message: 'User not found in requested scope',
    })
    expectPrefix(assignParents, subjects, ['targets'])
    expectRoot('ROLLBACK')
  })

  it('freezes sorted subject locks, keeps request order, and dedupes the actor', async () => {
    addUser('a-user', 'user', { activation_status: 'pending' })
    addUser('m-user')
    addUser('b-actor', 'admin')
    const userIds = ['b-actor', 'm-user', 'a-user', 'm-user']
    const locked = ['a-user', 'b-actor', 'm-user']
    const result = await assignAttendanceGlobalRolesCommand(commandInput({ actorId: 'b-actor', userIds, includeProfile: true }))
    expectPlan('GRANT_ROLE', assignParents, locked)
    expectSubjectLocks(locked)
    expect(paramsOf('assign-dml')).toEqual([[['b-actor', 'm-user', 'a-user'], CUSTOM, 'manual']])
    expect(paramsOf('targets')).toEqual([[userIds]])
    expect(result).toEqual({
      membership: { affectedUserIds: ['b-actor', 'm-user', 'a-user'], rowCount: 3, delegatedAdminScopeCleanup: [] },
      targets: { items: userIds.map((id) => targetItem(state.users.get(id)!)), missingUserIds: [], inactiveUserIds: [] },
      profile: profileOf(state.users.get('b-actor')!),
    })
    expectPrefix(assignParents, locked, ['targets', 'assign-dml', 'profile'])
    expectRoot('COMMIT')
  })

  it('ignores caller userIds mutation during the first await and leaves that array unfrozen', async () => {
    const userIds = ['target']
    state.mutate = () => { userIds[0] = 'redirected'; userIds.push('extra') }
    const result = await assignAttendanceGlobalRolesCommand(commandInput({ userIds }))
    expect(Object.isFrozen(userIds)).toBe(false)
    expect(userIds).toEqual(['redirected', 'extra'])
    expect(result.membership.affectedUserIds).toEqual(['target'])
    expect(paramsOf('assign-dml')).toEqual([[['target'], CUSTOM, 'manual']])
    expect(paramsOf('targets')).toEqual([[['target']]])
    expect(JSON.stringify(state.calls)).not.toContain('redirected')
    expect(JSON.stringify(state.calls)).not.toContain('extra')
    expectPrefix(assignParents, subjects, ['targets', 'assign-dml'])
    expectRoot('COMMIT')
  })

  it.each(['unbranded', 'closed', 'cloned-plan'] as const)('rejects a %s substitute after the real entry mints its own token', async (mode) => {
    state.transform = (original) => {
      const token = { ...original, ...(mode === 'cloned-plan' ? { plan: Object.freeze({ ...original.plan }) } : {}) } as AuthorizationInputTx
      if (mode !== 'unbranded') {
        const brand = mintAuthorizationInputBrand(token, [token])
        if (mode === 'closed') brand.close()
      }
      return token
    }
    const refusal = mode === 'cloned-plan'
      ? { name: 'AuthorizationInputContractError', code: 'AUTHORIZATION_INPUT_PLAN_INVALID', status: 500, retryable: false, reason: 'attendance_global_role_context', message: 'Authorization input plan is invalid' }
      : { name: 'AuthorizationInputTokenRejectedError', code: 'AUTHORIZATION_INPUT_TOKEN_REJECTED', status: 500, reason: mode, message: 'Authorization input transaction token is not acceptable' }
    await expect(assignAttendanceGlobalRolesCommand(commandInput())).rejects.toMatchObject(refusal)
    expect(kinds()).toEqual(lockKinds(assignParents, subjects))
    expectRoot('ROLLBACK')
  })

  it.each([
    ['user witness', (original: AuthorizationInputTx) => ({
      witnessed: Object.freeze({
        userIds: new Set([...original.witnessed.userIds].filter((id) => id !== 'target')),
        admissionUserIds: original.witnessed.admissionUserIds,
      }),
    })],
    ['admission witness', (original: AuthorizationInputTx) => ({
      witnessed: Object.freeze({
        userIds: original.witnessed.userIds,
        admissionUserIds: new Set([...original.witnessed.admissionUserIds].filter((id) => id !== 'target')),
      }),
    })],
    ['target lock', (original: AuthorizationInputTx) => ({
      locked: new Map([...original.locked].filter(([id]) => id !== 'target')),
    })],
  ])('rejects a real token missing the %s before either role writer', async (_label, patch) => {
    state.transform = (original) => {
      const token = { ...original, ...patch(original) } as AuthorizationInputTx
      mintAuthorizationInputBrand(token, [token])
      return token
    }
    await expect(assignAttendanceGlobalRolesCommand(commandInput())).rejects.toMatchObject({
      name: 'AuthorizationInputContractError', code: 'AUTHORIZATION_INPUT_PLAN_INVALID', status: 500,
      retryable: false, reason: 'attendance_global_role_context', message: 'Authorization input plan is invalid',
    })
    expectPrefix(assignParents, subjects, ['targets'])
    expect(paramsOf('assign-dml')).toEqual([])
    expect(paramsOf('revoke-dml')).toEqual([])
    expectRoot('ROLLBACK')
  })
})
