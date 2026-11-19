import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  memberships: new Map<string, Set<string>>(),
  roles: new Set<string>(),
  scopes: [] as Array<{ userId: string; namespace: string; table: string }>,
  admissions: new Map<string, { enabled: boolean; source: string }>(),
  events: [] as string[],
  fail: '', errorCode: 'XX000', errorMessage: 'fixed SQL failure',
  commitUnknown: false, afterCommitReadFailure: false, outsideAdmin: true,
  commitGate: undefined as Promise<void> | undefined,
  onQuery: undefined as ((sql: string) => void) | undefined,
  transform: undefined as ((tx: AuthorizationInputTx) => AuthorizationInputTx) | undefined,
}))
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), audit: vi.fn(), invalidate: vi.fn(), entry: vi.fn() }))
vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: { get: () => ({ transaction: mocks.transaction }) } }))
vi.mock('../../src/rbac/authorization-input-lock', async original => {
  const actual = await original<typeof import('../../src/rbac/authorization-input-lock')>()
  return { ...actual, withAuthorizationInputTransaction: (plan: AuthorizationInputPlan, work: (tx: AuthorizationInputTx) => Promise<unknown>) => {
    mocks.entry(plan)
    return actual.withAuthorizationInputTransaction(plan, tx => work(state.transform ? state.transform(tx) : tx))
  } }
})
vi.mock('../../src/db/pg', () => ({ query: mocks.query, transaction: mocks.transaction }))
vi.mock('../../src/middleware/auth', () => ({ authenticate: () => { throw new Error('HANDLER_SEAM_ONLY') } }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.audit }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => state.outsideAdmin), invalidateUserPerms: mocks.invalidate,
  listUserPermissions: vi.fn(async () => []), userHasPermission: vi.fn(async () => false),
}))
vi.mock('../../src/services/AttendanceScheduler', () => ({ getSharedAttendanceScheduler: vi.fn(() => null) }))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({ redeliverFailedAttendanceNotification: vi.fn() }))

import { unassignPlatformUserRoleCommand } from '../../src/admin/platform-role-unassign-command'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

const input = { actorId: 'actor', userId: 'target', roleId: 'crm_admin' }
const busyBody = { ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } }
const businessSql = /DELETE FROM user_roles|DELETE FROM delegated_role_admin_|INSERT INTO user_namespace_admissions|UPDATE users/
const sqlEvents = (pattern: RegExp) => state.events.filter(event => pattern.test(event))
const accepted = (id: string) => {
  const user = state.users.get(id)
  return user?.is_active === true && user.activation_status === 'activated' && !user.deleted_at && !user.purged_at
    && (user.role === 'admin' || state.memberships.get(id)?.has('admin') === true)
}

async function route(body: Record<string, unknown> = { roleId: input.roleId }, userId: unknown = input.userId, correlationId?: string) {
  const layer = adminUsersRouter().stack.find(entry => entry.route?.path === '/api/admin/users/:userId/roles/unassign' && entry.route.methods.post)
  const response = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(value: unknown) { this.body = value; return this },
  }
  const request = { params: { userId }, body, headers: {}, user: { id: 'actor', role: state.outsideAdmin ? 'admin' : 'user' }, ...(correlationId === undefined ? {} : { correlationId }) }
  await layer!.route.stack.at(-1)!.handle(request as unknown as Request, response as unknown as Response, () => { throw new Error('UNEXPECTED_NEXT') })
  return response
}

beforeEach(() => {
  vi.clearAllMocks()
  state.users = new Map(['actor', 'target'].map(id => [id, {
    id, name: id, username: id, role: 'user', is_active: true, is_admin: false, permissions: [],
    activation_status: 'activated', deleted_at: null, purged_at: null, access_generation: 0,
  }]))
  state.memberships = new Map([['actor', new Set(['admin'])], ['target', new Set(['crm_admin'])]])
  state.roles = new Set(['admin', 'crm_admin', 'attendance_employee', 'attendance_manager'])
  state.scopes = []
  state.admissions = new Map()
  state.events = []
  state.fail = ''; state.errorCode = 'XX000'; state.errorMessage = 'fixed SQL failure'
  state.commitUnknown = false; state.afterCommitReadFailure = false; state.outsideAdmin = true
  state.commitGate = undefined; state.onQuery = undefined; state.transform = undefined
  mocks.invalidate.mockImplementation(() => { state.events.push('invalidate') })
  mocks.audit.mockImplementation(async () => { state.events.push('audit') })
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    state.events.push(sql.replace(/\s+/g, ' ').trim())
    state.onQuery?.(sql)
    if (state.fail && sql.includes(state.fail)) throw Object.assign(new Error(state.errorMessage), { code: state.errorCode })
    if (state.afterCommitReadFailure && state.events.includes('COMMIT_CONFIRMED') && /FROM users/.test(sql)) throw new Error('fixed readback failure')
    if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '2s', statement_timeout: '3s' }] }
    if (sql.includes('AS is_sign_in_admin')) return { rows: state.users.has(String(params?.[0])) ? [{ is_sign_in_admin: accepted(String(params?.[0])) }] : [] }
    if (/COUNT\(\*\)::int AS c/.test(sql)) return { rows: [{ c: [...state.users.keys()].filter(id => id !== params?.[0] && accepted(id) && state.users.get(id)!.role !== 'disabled').length }] }
    if (/FROM roles/.test(sql)) return { rows: state.roles.has(String(params?.[0])) ? [{ id: params?.[0] }] : [] }
    if (/FROM users/.test(sql)) return { rows: state.users.has(String(params?.[0])) ? [state.users.get(String(params?.[0]))] : [] }
    if (/SELECT TRUE AS allowed/.test(sql)) return { rows: [...(state.memberships.get(String(params?.[0])) ?? [])].some(role => role === params?.[1] || role.startsWith(`${params?.[1]}_`)) ? [{ allowed: true }] : [] }
    if (/SELECT.*FROM user_roles/s.test(sql)) {
      const ids = /ANY/.test(sql) ? params?.[0] as string[] : [String(params?.[0])]
      return { rows: ids.flatMap(userId => [...(state.memberships.get(userId) ?? [])].filter(role => !/AND role_id = 'admin'/.test(sql) || role === 'admin').map(role_id => ({ user_id: userId, role_id }))) }
    }
    if (/DELETE FROM user_roles/.test(sql)) {
      const removed = (params?.[0] as string[]).filter(id => state.memberships.get(id)?.delete(String(params?.[1])))
      return { rows: removed.map(user_id => ({ user_id })), rowCount: removed.length }
    }
    if (/DELETE FROM delegated_role_admin_/.test(sql)) {
      const table = sql.includes('member_groups') ? 'group' : 'department'
      const removed = state.scopes.filter(scope => (params?.[0] as string[]).includes(scope.userId) && scope.namespace === params?.[1] && scope.table === table)
      state.scopes = state.scopes.filter(scope => !removed.includes(scope))
      return { rows: removed.map(scope => ({ admin_user_id: scope.userId })), rowCount: removed.length }
    }
    if (/INSERT INTO user_namespace_admissions/.test(sql)) {
      const key = `${params?.[0]}:${params?.[1]}`
      state.admissions.set(key, { enabled: params?.[4] === true ? state.admissions.get(key)?.enabled ?? false : false, source: String(params?.[2]) })
    }
    if (/UPDATE users/.test(sql)) {
      const user = state.users.get(String(params?.[0]))!
      Object.assign(user, { role: params?.[1] ? 'admin' : user.role === 'admin' ? 'user' : user.role, is_admin: params?.[1] })
    }
    return { rows: [], rowCount: 0 }
  })
  mocks.transaction.mockImplementation(async work => {
    const saved = structuredClone({ users: state.users, memberships: state.memberships, scopes: state.scopes, admissions: state.admissions })
    let committed = false
    state.events.push('BEGIN')
    try {
      const result = await work({ query: mocks.query })
      if (state.commitGate) await state.commitGate
      committed = true
      if (state.commitUnknown) throw new Error('commit acknowledgement unknown')
      state.events.push('COMMIT_CONFIRMED')
      return result
    } catch (error) {
      state.events.push('ROLLBACK_ATTEMPT')
      if (!committed) Object.assign(state, saved)
      throw error
    }
  })
})

describe('unassign command: real default entry and unchanged shared writers', () => {
  it('freezes the exact revoke plan and orders R0, parent, all sorted R3, all sorted R5, child', async () => {
    expect(await unassignPlatformUserRoleCommand(input)).toEqual({ blocked: false, membership: { affectedUserIds: ['target'], rowCount: 1, delegatedAdminScopeCleanup: [{ userId: 'target', namespace: 'crm', scopeRows: 0, groupScopeRows: 0 }] }, disabledNamespaces: ['crm'] })
    const plan = mocks.entry.mock.calls[0][0] as AuthorizationInputPlan
    expect(plan).toEqual({ intent: 'REVOKE_ROLE', roleIds: ['crm_admin'], userIds: ['actor', 'target'], admissionUserIds: ['actor', 'target'], witness: { userIds: ['actor', 'target'], admissionUserIds: ['actor', 'target'] } })
    for (const value of [plan, plan.roleIds, plan.userIds, plan.admissionUserIds, plan.witness, plan.witness?.userIds, plan.witness?.admissionUserIds]) expect(Object.isFrozen(value)).toBe(true)
    const calls = mocks.query.mock.calls
    const world = calls.findIndex(([sql]) => sql.includes('pg_advisory_xact_lock_shared(20261106, 1)'))
    const parent = calls.findIndex(([sql]) => sql === 'SELECT id::text AS id FROM roles WHERE id = $1::text FOR SHARE')
    const admissionIndices = calls.flatMap(([sql], index) => sql.includes('hashtextextended($1') ? [index] : [])
    const userIndices = calls.flatMap(([sql], index) => /FROM users/.test(sql) && /FOR UPDATE/.test(sql) ? [index] : [])
    const child = calls.findIndex(([sql]) => /FROM user_roles/.test(sql) && /FOR SHARE/.test(sql))
    expect(world).toBeGreaterThanOrEqual(0)
    expect(parent).toBeGreaterThan(world)
    expect(admissionIndices).toHaveLength(2)
    expect(userIndices).toHaveLength(2)
    expect(admissionIndices[0]).toBeGreaterThan(parent)
    expect(userIndices[0]).toBeGreaterThan(admissionIndices[1])
    expect(child).toBeGreaterThan(userIndices[1])
    expect(admissionIndices.map(index => calls[index][1])).toEqual([['namespace-admission:actor'], ['namespace-admission:target']])
    expect(userIndices.map(index => calls[index][1])).toEqual([['actor'], ['target']])
    expect(calls[child - 1][1]).toEqual(['5000', '10000'])
    expect(calls[child + 1][1]).toEqual(['2s', '3s'])
    expect(sqlEvents(/FROM roles/)).toHaveLength(1)
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it('declares R1 only for admin, before parent and subjects; LAST is first business check', async () => {
    state.memberships.get('target')!.add('admin')
    state.memberships.get('actor')!.delete('admin')
    state.users.get('target')!.role = 'disabled'
    expect(await unassignPlatformUserRoleCommand({ ...input, roleId: 'admin' })).toEqual({ blocked: true })
    expect(mocks.entry.mock.calls[0][0].platformAdminInvariant).toBe(true)
    const invariant = state.events.findIndex(event => event.includes('user-recycle:platform-admin'))
    const parent = state.events.findIndex(event => /FROM roles/.test(event))
    const last = state.events.findIndex(event => event.includes('AS is_sign_in_admin'))
    expect(invariant).toBeGreaterThan(state.events.findIndex(event => event.includes('pg_advisory_xact_lock_shared')))
    expect(parent).toBeGreaterThan(invariant)
    expect(last).toBeGreaterThan(state.events.findLastIndex(event => /FROM users.*FOR UPDATE/.test(event)))
    expect(sqlEvents(businessSql)).toEqual([])
    expect(sqlEvents(/ORDER BY role_id ASC/)).toEqual([])
  })

  it.each(['disabled', null])('counts raw %s membership-backed self but not a disabled backup', async rawRole => {
    state.users.get('target')!.role = rawRole
    state.memberships.get('target')!.add('admin')
    state.users.get('actor')!.role = 'disabled'
    expect(await unassignPlatformUserRoleCommand({ ...input, roleId: 'admin' })).toEqual({ blocked: true })
    state.users.get('actor')!.role = 'user'
    expect(await unassignPlatformUserRoleCommand({ ...input, roleId: 'admin' })).toMatchObject({ blocked: false, membership: { rowCount: 1 } })
    expect(state.users.get('target')).toMatchObject({ role: rawRole, is_admin: false })
  })

  it('accepts an orphan and never repeats parent acquisition if it appears during work', async () => {
    state.roles.delete(input.roleId)
    state.onQuery = sql => { if (/ORDER BY role_id ASC/.test(sql)) state.roles.add(input.roleId) }
    expect(await unassignPlatformUserRoleCommand(input)).toMatchObject({ blocked: false, membership: { rowCount: 1 } })
    expect(sqlEvents(/FROM roles/)).toHaveLength(1)
  })

  it('snapshots scalars before await and deduplicates a self command', async () => {
    const mutable = { ...input, userId: 'actor' }
    state.memberships.get('actor')!.add(input.roleId)
    state.onQuery = () => { mutable.actorId = 'other'; mutable.userId = 'other'; mutable.roleId = 'other'; state.onQuery = undefined }
    expect(await unassignPlatformUserRoleCommand(mutable)).toMatchObject({ membership: { affectedUserIds: ['actor'] } })
    expect(mocks.entry.mock.calls[0][0].userIds).toEqual(['actor'])
  })

  it.each(['admin', 'disabled', 'user'])('retains raw %s authority with a passing real authority baseline', async rawRole => {
    state.users.get('actor')!.role = rawRole
    if (rawRole === 'admin') state.memberships.get('actor')!.clear()
    await expect(unassignPlatformUserRoleCommand(input)).resolves.toMatchObject({ blocked: false })
    expect(sqlEvents(/ORDER BY role_id ASC/)).toHaveLength(1)
    expect(sqlEvents(/FROM user_roles.*FOR SHARE/)).toHaveLength(rawRole === 'admin' ? 0 : 1)
  })

  it.each([{ is_admin: true }, { permissions: ['*:*'] }, { is_active: false }, { activation_status: 'pending_activation' }, { deleted_at: 'set' }, { purged_at: 'set' }])('isolates actor refusal %j after a passing baseline', async patch => {
    await expect(unassignPlatformUserRoleCommand(input)).resolves.toMatchObject({ blocked: false })
    state.memberships.get('target')!.add(input.roleId)
    Object.assign(state.users.get('actor')!, patch)
    if ('is_admin' in patch || 'permissions' in patch) state.memberships.get('actor')!.clear()
    state.events = []
    await expect(unassignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(sqlEvents(businessSql)).toEqual([])
  })

  it.each([{ is_active: false }, { activation_status: 'pending_activation' }])('keeps target writable %j', async patch => {
    Object.assign(state.users.get('target')!, patch)
    await expect(unassignPlatformUserRoleCommand(input)).resolves.toMatchObject({ membership: { rowCount: 1 } })
  })

  it('preserves missing/recycled target before actor refusal', async () => {
    state.users.delete('actor')
    state.users.delete('target')
    await expect(unassignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    state.users.set('target', { id: 'target', deleted_at: 'set' })
    await expect(unassignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'USER_IN_RECYCLE_BIN' })
    state.users.get('target')!.deleted_at = null
    state.users.get('target')!.purged_at = 'set'
    await expect(unassignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'USER_IN_RECYCLE_BIN' })
    expect(sqlEvents(businessSql)).toEqual([])
  })

  it('preserves both audience counts, other-user isolation and zero-row cleanup behavior', async () => {
    state.scopes = ['department', 'group'].flatMap(table => [{ userId: 'target', namespace: 'crm', table }, { userId: 'actor', namespace: 'crm', table }])
    const result = await unassignPlatformUserRoleCommand(input)
    expect(result).toMatchObject({ membership: { delegatedAdminScopeCleanup: [{ userId: 'target', namespace: 'crm', scopeRows: 1, groupScopeRows: 1 }] } })
    expect(state.scopes).toEqual([{ userId: 'actor', namespace: 'crm', table: 'department' }, { userId: 'actor', namespace: 'crm', table: 'group' }])
    state.scopes.push({ userId: 'target', namespace: 'crm', table: 'group' })
    expect(await unassignPlatformUserRoleCommand(input)).toEqual({ blocked: false, membership: { rowCount: 0, affectedUserIds: [], delegatedAdminScopeCleanup: [] }, disabledNamespaces: ['crm'] })
    expect(state.scopes).toHaveLength(3)
  })

  it('keeps audiences when another historical same-namespace main-admin role remains', async () => {
    state.memberships.get('target')!.add('crm _admin')
    state.scopes = [{ userId: 'target', namespace: 'crm', table: 'group' }]
    expect(await unassignPlatformUserRoleCommand(input)).toMatchObject({ membership: { delegatedAdminScopeCleanup: [] } })
    expect(state.scopes).toHaveLength(1)
  })

  it('records zero-row attendance opt-out, preserves enabled existing admission, inserts false otherwise', async () => {
    state.memberships.set('target', new Set(['attendance_manager']))
    state.admissions.set('target:attendance', { enabled: true, source: 'manual' })
    const attendance = { ...input, roleId: 'attendance_employee' }
    expect(await unassignPlatformUserRoleCommand(attendance)).toEqual({ blocked: false, membership: { affectedUserIds: [], rowCount: 0, delegatedAdminScopeCleanup: [] }, disabledNamespaces: [] })
    expect(state.admissions.get('target:attendance')).toEqual({ enabled: true, source: 'role_unassigned' })
    state.admissions.clear()
    await unassignPlatformUserRoleCommand(attendance)
    expect(state.admissions.get('target:attendance')).toEqual({ enabled: false, source: 'role_unassigned' })
    state.memberships.get('target')!.clear()
    expect(await unassignPlatformUserRoleCommand(attendance)).toMatchObject({ disabledNamespaces: ['attendance'] })
  })

  it.each(['DELETE FROM delegated_role_admin_member_groups', 'INSERT INTO user_namespace_admissions', 'UPDATE users'])('rolls back shared membership, cleanup, admission and legacy on %s failure', async fail => {
    const roleId = fail === 'UPDATE users' ? 'admin' : input.roleId
    state.memberships.get('target')!.add(roleId)
    state.users.get('target')!.role = 'admin'
    state.users.get('target')!.is_admin = true
    state.scopes = [{ userId: 'target', namespace: 'crm', table: 'department' }, { userId: 'target', namespace: 'crm', table: 'group' }]
    state.admissions.set('target:crm', { enabled: true, source: 'manual' })
    const before = structuredClone({ users: state.users, memberships: state.memberships, scopes: state.scopes, admissions: state.admissions })
    state.fail = fail
    await expect(unassignPlatformUserRoleCommand({ ...input, roleId })).rejects.toThrow('fixed SQL failure')
    expect({ users: state.users, memberships: state.memberships, scopes: state.scopes, admissions: state.admissions }).toEqual(before)
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
  })

  it('demotes a raw admin even for zero-row revoke', async () => {
    state.users.get('target')!.role = 'admin'
    state.users.get('target')!.is_admin = true
    expect(await unassignPlatformUserRoleCommand({ ...input, roleId: 'admin' })).toMatchObject({ blocked: false, membership: { rowCount: 0 } })
    expect(state.users.get('target')).toMatchObject({ role: 'user', is_admin: false })
  })

  it('propagates the original ordinary role-read failure even for raw admin', async () => {
    state.users.get('actor')!.role = 'admin'
    state.fail = 'ORDER BY role_id ASC'
    await expect(unassignPlatformUserRoleCommand(input)).rejects.toThrow('fixed SQL failure')
  })

  it('does not restore after failed child SQL, but restores after a disappeared positive edge', async () => {
    state.fail = "AND role_id = 'admin' FOR SHARE"
    await expect(unassignPlatformUserRoleCommand(input)).rejects.toThrow('fixed SQL failure')
    expect(state.events.at(-2)).toContain(state.fail)
    expect(state.events.at(-1)).toBe('ROLLBACK_ATTEMPT')
    state.fail = ''
    state.onQuery = sql => { if (sql.includes("AND role_id = 'admin' FOR SHARE")) state.memberships.get('actor')!.clear() }
    await expect(unassignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual(['2s', '3s'])
    expect(sqlEvents(businessSql)).toEqual([])
  })
})

describe('test-only token substitutions through the real entry', () => {
  it.each(['fake', 'closed', 'cross-plan', 'intent', 'world', 'r1', 'role-key', 'role-state', 'r3-actor', 'r3-target', 'r5-actor', 'r5-target', 'born', 'witness-actor', 'witness-target'])('refuses %s with a passing unmodified baseline', async mode => {
    await expect(unassignPlatformUserRoleCommand(input)).resolves.toMatchObject({ blocked: false })
    state.memberships.get('target')!.add(input.roleId)
    state.events = []
    state.transform = original => {
      const token = { ...original } as AuthorizationInputTx
      if (mode === 'cross-plan') Object.assign(token, { plan: Object.freeze({ ...original.plan }) })
      if (mode === 'intent') Object.assign(token, { plan: Object.freeze({ ...original.plan, intent: 'GRANT_ROLE' }) })
      if (mode === 'r1') Object.assign(token, { plan: Object.freeze({ ...original.plan, platformAdminInvariant: true }) })
      if (mode === 'world') Object.assign(token, { world: 'exclusive' })
      if (mode === 'role-key') Object.assign(token, { roleRows: new Map() })
      if (mode === 'role-state') Object.assign(token, { roleRows: new Map([[input.roleId, 'born']]) })
      if (mode.startsWith('r3-')) Object.assign(token, { witnessed: { ...original.witnessed, admissionUserIds: new Set(mode.endsWith('actor') ? ['target'] : ['actor']) } })
      if (mode.startsWith('r5-') || mode === 'born') Object.assign(token, { locked: new Map([...original.locked].filter(([id]) => id !== (mode.endsWith('actor') ? 'actor' : 'target'))), born: new Set(['actor', 'target']) })
      if (mode.startsWith('witness-')) Object.assign(token, { witnessed: { ...original.witnessed, userIds: new Set(mode.endsWith('actor') ? ['target'] : ['actor']) } })
      if (mode !== 'fake') {
        const brand = mintAuthorizationInputBrand(token, [token])
        if (mode === 'closed') brand.close()
      }
      return token
    }
    const refusal = mode === 'fake' || mode === 'closed'
      ? { code: 'AUTHORIZATION_INPUT_TOKEN_REJECTED', reason: mode === 'fake' ? 'unbranded' : 'closed' }
      : mode === 'r5-actor' ? { code: 'FORBIDDEN' }
        : mode === 'r5-target' || mode === 'born' ? { code: 'NOT_FOUND' } : { code: 'AUTHORIZATION_INPUT_PLAN_INVALID' }
    await expect(unassignPlatformUserRoleCommand(input)).rejects.toMatchObject(refusal)
    expect(sqlEvents(businessSql)).toEqual([])
  })
})

describe('registered final handler only, not HTTP authentication acceptance', () => {
  it('preserves outside-admin, required-field, profile and trim/coercion behavior', async () => {
    state.outsideAdmin = false
    expect((await route({ roleId: '' })).statusCode).toBe(403)
    state.outsideAdmin = true
    expect(await route({ roleId: '' }, '')).toMatchObject({ statusCode: 400, body: { ok: false, error: { code: 'USER_ID_REQUIRED', message: 'userId is required' } } })
    expect(await route({ roleId: '' })).toMatchObject({ statusCode: 400, body: { ok: false, error: { code: 'ROLE_REQUIRED', message: 'roleId is required' } } })
    expect((await route({ roleId: ' crm_admin ' }, ' target ')).statusCode).toBe(200)
    state.users.delete('target')
    expect(await route()).toMatchObject({ statusCode: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'User not found' } } })
  })

  it('returns exact LAST409 without effects after full-plan transaction', async () => {
    state.memberships.set('actor', new Set())
    state.memberships.get('target')!.add('admin')
    expect(await route({ roleId: 'admin' })).toMatchObject({ statusCode: 409, body: { ok: false, error: { code: 'LAST_PLATFORM_ADMIN', message: '至少保留一名可登录的平台管理员' } } })
    expect(sqlEvents(businessSql)).toEqual([])
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it.each(['40P01', '40001', '55P03', '57014'])('returns exact AUTH_BUSY409 for entry or work %s', async code => {
    state.errorCode = code
    for (const fail of ['SELECT id::text AS id FROM roles', 'DELETE FROM user_roles']) {
      state.fail = fail
      expect(await route()).toMatchObject({ statusCode: 409, body: busyBody })
    }
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it('retains the recovery-marker family and fixed generic correlation error', async () => {
    state.fail = 'DELETE FROM user_roles'; state.errorCode = '40001'; state.errorMessage = RECOVERY_AUTHORITY_BUSY_MARKER
    expect(await route()).toMatchObject({ statusCode: 409, body: { ok: false, error: { code: 'RECOVERY_AUTHORITY_BUSY', message: 'Recovery is stabilizing permissions; retry this change.', details: { retryable: true } } } })
    state.errorCode = 'XX000'; state.errorMessage = 'secret-shaped driver text'
    const response = await route()
    expect(response).toMatchObject({ statusCode: 500, body: { ok: false, error: { code: 'ROLE_UNASSIGN_FAILED', message: 'Failed to unassign role' } } })
    const plain = (response.body as { error: Record<string, unknown> }).error
    expect(plain).not.toHaveProperty('details')
    expect(plain).not.toHaveProperty('correlationId')
    expect(JSON.stringify(response.body)).not.toContain(state.errorMessage)
    const correlated = await route({ roleId: input.roleId }, input.userId, 'route-correlation-1')
    expect(correlated).toMatchObject({ statusCode: 500, body: { ok: false, error: { code: 'ROLE_UNASSIGN_FAILED', message: 'Failed to unassign role', correlationId: 'route-correlation-1' } } })
    expect((correlated.body as { error: Record<string, unknown> }).error).not.toHaveProperty('details')
    const ignored = await route({ roleId: input.roleId }, input.userId, 'not a correlation')
    expect((ignored.body as { error: Record<string, unknown> }).error).not.toHaveProperty('correlationId')
    expect(JSON.stringify(ignored.body)).not.toContain(state.errorMessage)
  })

  it('waits for root COMMIT then cleanup audit, invalidate, business audit, snapshot', async () => {
    state.scopes = [{ userId: 'target', namespace: 'crm', table: 'group' }]
    let release!: () => void
    state.commitGate = new Promise<void>(resolve => { release = resolve })
    const pending = route()
    await vi.waitFor(() => expect(sqlEvents(/INSERT INTO user_namespace_admissions/)).toHaveLength(1))
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
    release()
    const response = await pending
    expect(response).toMatchObject({ statusCode: 200, body: { ok: true, data: { changedRoleId: input.roleId, actorId: 'actor', roleHeld: false, membershipChanged: true } } })
    expect(state.events.filter(event => ['COMMIT_CONFIRMED', 'audit', 'invalidate'].includes(event))).toEqual(['COMMIT_CONFIRMED', 'audit', 'invalidate', 'audit'])
    expect(state.events.findLastIndex(event => /FROM users/.test(event))).toBeGreaterThan(state.events.lastIndexOf('audit'))
  })

  it('does not replay unknown COMMIT or pretend readback failure rolled back', async () => {
    state.commitUnknown = true
    expect((await route()).statusCode).toBe(500)
    expect(state.memberships.get('target')!.has(input.roleId)).toBe(false)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
    state.commitUnknown = false
    state.afterCommitReadFailure = true
    state.memberships.get('target')!.add(input.roleId)
    state.events = []
    expect((await route()).statusCode).toBe(500)
    expect(state.memberships.get('target')!.has(input.roleId)).toBe(false)
    expect(state.events).toContain('COMMIT_CONFIRMED')
    expect(state.events).not.toContain('ROLLBACK_ATTEMPT')
    expect(mocks.invalidate).toHaveBeenCalledTimes(1)
    expect(mocks.audit).toHaveBeenCalledTimes(1)
  })
})
