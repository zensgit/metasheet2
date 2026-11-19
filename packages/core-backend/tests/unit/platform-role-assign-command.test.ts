import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  memberships: new Map<string, Set<string>>(),
  roles: new Map<string, string | null>(),
  scopes: [] as Array<{ userId: string; namespace: string; table: string }>,
  events: [] as string[],
  fail: '',
  errorCode: 'XX000',
  commitUnknown: false,
  commitGate: undefined as Promise<void> | undefined,
  onQuery: undefined as ((sql: string) => void) | undefined,
  transform: undefined as ((tx: unknown, plan: unknown) => unknown) | undefined,
  actorId: 'actor',
  outsideAdmin: true,
  lockedTargetMissing: false,
  afterCommitReadFailure: false,
}))
const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), audit: vi.fn(), invalidate: vi.fn(), entry: vi.fn(),
}))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ transaction: mocks.transaction }) },
}))
vi.mock('../../src/rbac/authorization-input-lock', async (original) => {
  const actual = await original<typeof import('../../src/rbac/authorization-input-lock')>()
  return { ...actual, withAuthorizationInputTransaction: (plan: unknown, work: (tx: unknown) => Promise<unknown>) => {
    mocks.entry(plan)
    return actual.withAuthorizationInputTransaction(plan as AuthorizationInputPlan, tx => work(state.transform ? state.transform(tx, plan) : tx))
  } }
})
vi.mock('../../src/db/pg', () => ({ query: mocks.query, transaction: mocks.transaction }))
vi.mock('../../src/middleware/auth', () => ({ authenticate: () => { throw new Error('HANDLER_SEAM_ONLY') } }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.audit }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => state.outsideAdmin),
  invalidateUserPerms: mocks.invalidate,
  listUserPermissions: vi.fn(async () => []),
  userHasPermission: vi.fn(async () => false),
}))
vi.mock('../../src/services/AttendanceScheduler', () => ({ getSharedAttendanceScheduler: vi.fn(() => null) }))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({ redeliverFailedAttendanceNotification: vi.fn() }))

import { assignPlatformUserRoleCommand } from '../../src/admin/platform-role-assign-command'
import { RoleModifiedError, RoleRowMissingError } from '../../src/admin/role-row-contract'
import { adminUsersRouter } from '../../src/routes/admin-users'

const input = { actorId: 'actor', userId: 'target', roleId: 'crm_user', expectedUpdatedAt: null }
const version = '2026-11-16T00:00:00.000Z'
const busyBody = { ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } }

function sqlEvents(pattern: RegExp) {
  return state.events.filter(event => pattern.test(event))
}

async function route(body: Record<string, unknown> = { roleId: 'crm_user' }, userId: unknown = 'target') {
  const layer = adminUsersRouter().stack.find(entry => entry.route?.path === '/api/admin/users/:userId/roles/assign' && entry.route.methods.post)
  const handler = layer!.route.stack.at(-1)!.handle
  const response = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(value: unknown) { this.body = value; return this },
  }
  const req = { params: { userId }, body, headers: {}, user: { id: state.actorId, role: state.outsideAdmin ? 'admin' : 'user' } } as unknown as Request
  await handler(req, response as unknown as Response, () => { throw new Error('UNEXPECTED_NEXT') })
  return response
}

beforeEach(() => {
  vi.clearAllMocks()
  state.users = new Map(['actor', 'target'].map(id => [id, {
    id, name: id, email: null, username: id, mobile: null, role: 'user', is_active: true, is_admin: false,
    activation_status: 'activated', deleted_at: null, purged_at: null, access_generation: 0, permissions: [],
  }]))
  state.memberships = new Map([['actor', new Set(['admin'])], ['target', new Set<string>()]])
  state.roles = new Map([['admin', version], ['crm_user', version], ['crm_admin', version], ['crm_extra_admin', version]])
  state.scopes = []
  state.events = []
  state.fail = ''
  state.errorCode = 'XX000'
  state.commitUnknown = false
  state.commitGate = undefined
  state.onQuery = undefined
  state.transform = undefined
  state.actorId = 'actor'
  state.outsideAdmin = true
  state.lockedTargetMissing = false
  state.afterCommitReadFailure = false
  mocks.invalidate.mockImplementation(() => { state.events.push('invalidate') })
  mocks.audit.mockImplementation(async () => { state.events.push('audit') })
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    state.events.push(sql.replace(/\s+/g, ' ').trim())
    state.onQuery?.(sql)
    if (state.fail && sql.includes(state.fail)) throw Object.assign(new Error('fixed SQL failure'), { code: state.errorCode })
    if (state.afterCommitReadFailure && state.events.includes('COMMIT_CONFIRMED') && /FROM users/.test(sql)) throw new Error('fixed readback failure')
    if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '2s', statement_timeout: '3s' }] }
    if (/FROM roles/.test(sql)) return { rows: state.roles.has(String(params?.[0])) ? [{ id: params?.[0], updated_at: state.roles.get(String(params?.[0])) }] : [] }
    if (/FROM users/.test(sql)) {
      const userId = String(params?.[0])
      const missing = /FOR UPDATE/.test(sql) && userId === 'target' && state.lockedTargetMissing
      return { rows: !missing && state.users.has(userId) ? [state.users.get(userId)] : [] }
    }
    if (/SELECT.*FROM user_roles/s.test(sql)) {
      if (/ANY/.test(sql)) {
        return { rows: (params?.[0] as string[]).flatMap(userId => [...(state.memberships.get(userId) ?? [])].map(roleId => ({ user_id: userId, role_id: roleId }))) }
      }
      const roleIds = [...(state.memberships.get(String(params?.[0])) ?? [])]
      return { rows: roleIds.filter(roleId => !/AND role_id = 'admin'/.test(sql) || roleId === 'admin').map(role_id => ({ role_id })) }
    }
    if (/INSERT INTO user_roles/.test(sql)) {
      const userId = (params?.[0] as string[])[0]
      const roleId = String(params?.[1])
      const roles = state.memberships.get(userId) ?? new Set<string>()
      const added = !roles.has(roleId)
      roles.add(roleId)
      state.memberships.set(userId, roles)
      return { rows: added ? [{ user_id: userId }] : [], rowCount: added ? 1 : 0 }
    }
    if (/DELETE FROM delegated_role_admin_/.test(sql)) {
      const table = sql.includes('member_groups') ? 'group' : 'department'
      const targets = params?.[0] as string[]
      const removed = state.scopes.filter(scope => targets.includes(scope.userId) && scope.namespace === params?.[1] && scope.table === table)
      state.scopes = state.scopes.filter(scope => !removed.includes(scope))
      return { rows: removed.map(scope => ({ admin_user_id: scope.userId })), rowCount: removed.length }
    }
    if (/UPDATE users/.test(sql)) {
      Object.assign(state.users.get(String(params?.[0]))!, { role: params?.[1] ? 'admin' : 'user', is_admin: params?.[1] })
    }
    return { rows: [], rowCount: 0 }
  })
  mocks.transaction.mockImplementation(async (work) => {
    const savedUsers = structuredClone(state.users)
    const savedMemberships = structuredClone(state.memberships)
    const savedScopes = structuredClone(state.scopes)
    let committed = false
    state.events.push('BEGIN')
    try {
      const result = await work({ query: mocks.query })
      if (state.commitGate) await state.commitGate
      committed = true
      if (state.commitUnknown) throw new Error('commit outcome unknown')
      state.events.push('COMMIT_CONFIRMED')
      return result
    } catch (error) {
      state.events.push('ROLLBACK_ATTEMPT')
      if (!committed) {
        state.users = savedUsers
        state.memberships = savedMemberships
        state.scopes = savedScopes
      }
      throw error
    }
  })
})

describe('platform role command using the real default entry and shared writers', () => {
  it('uses frozen exact plan, parent before full R3/R5 and separate membership timeout', async () => {
    expect(await assignPlatformUserRoleCommand(input)).toEqual({ affectedUserIds: ['target'], rowCount: 1, delegatedAdminScopeCleanup: [] })
    const plan = mocks.entry.mock.calls[0][0] as AuthorizationInputPlan
    expect(plan).toEqual({ intent: 'GRANT_ROLE', roleIds: ['crm_user'], userIds: ['actor', 'target'], admissionUserIds: ['actor', 'target'], witness: { userIds: ['actor', 'target'], admissionUserIds: ['actor', 'target'] } })
    for (const value of [plan, plan.roleIds, plan.userIds, plan.admissionUserIds, plan.witness, plan.witness?.userIds, plan.witness?.admissionUserIds]) expect(Object.isFrozen(value)).toBe(true)
    const calls = mocks.query.mock.calls
    const parent = calls.findIndex(([sql]) => sql === 'SELECT id::text AS id FROM roles WHERE id = $1::text FOR SHARE')
    const admission = calls.findIndex(([sql]) => sql.includes('hashtextextended($1'))
    const users = calls.map(([sql], index) => /FROM users/.test(sql) ? index : -1).filter(index => index >= 0)
    expect(parent).toBeLessThan(admission)
    expect(calls.filter(([sql]) => sql.includes('hashtextextended($1')).map(([, params]) => params)).toEqual([['namespace-admission:actor'], ['namespace-admission:target']])
    expect(users.every(index => index > admission + 1)).toBe(true)
    const share = calls.findIndex(([sql]) => /FROM user_roles/.test(sql) && /FOR SHARE/.test(sql))
    expect(calls[share - 1][1]).toEqual(['5000', '10000'])
    expect(calls[share + 1][1]).toEqual(['2s', '3s'])
    expect(state.events.at(-1)).toBe('COMMIT_CONFIRMED')
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it.each(['admin', 'disabled', 'user'])('preserves original raw %s plus membership predicate', async role => {
    state.users.get('actor')!.role = role
    if (role === 'admin') state.memberships.set('actor', new Set())
    await expect(assignPlatformUserRoleCommand(input)).resolves.toMatchObject({ rowCount: 1 })
    expect(sqlEvents(/FROM user_roles.*FOR SHARE/)).toHaveLength(role === 'admin' ? 0 : 1)
    expect(sqlEvents(/SELECT role_id FROM user_roles WHERE user_id = \$1 ORDER/)).toHaveLength(1)
  })

  it.each([{ is_admin: true }, { role: 'user', permissions: ['*:*'] }, { role: 'user' }])('rejects an actor without either real authority source %j', async patch => {
    Object.assign(state.users.get('actor')!, patch)
    state.memberships.set('actor', new Set())
    await expect(assignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(sqlEvents(/INSERT INTO user_roles/)).toEqual([])
  })

  it.each([{ is_active: false }, { activation_status: 'pending_activation' }, { deleted_at: 'set' }, { purged_at: 'set' }])('retains actor state rejection %j', async patch => {
    Object.assign(state.users.get('actor')!, patch)
    await expect(assignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it.each([{ is_active: false }, { activation_status: 'pending_activation' }])('retains writable inactive/pending target %j', async patch => {
    Object.assign(state.users.get('target')!, patch)
    await expect(assignPlatformUserRoleCommand(input)).resolves.toMatchObject({ rowCount: 1 })
  })

  it('preserves role, version, target, actor refusal order', async () => {
    state.roles.delete('crm_user')
    state.users.clear()
    await expect(assignPlatformUserRoleCommand(input)).rejects.toBeInstanceOf(RoleRowMissingError)
    state.roles.set('crm_user', version)
    await expect(assignPlatformUserRoleCommand({ ...input, expectedUpdatedAt: 1 })).rejects.toBeInstanceOf(RoleModifiedError)
    await expect(assignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    state.users.set('target', { id: 'target', deleted_at: 'set' })
    await expect(assignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'USER_IN_RECYCLE_BIN' })
    state.users.get('target')!.deleted_at = null
    await expect(assignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('preserves null stored version mismatch and absent version path', async () => {
    state.roles.set('crm_user', null)
    await expect(assignPlatformUserRoleCommand({ ...input, expectedUpdatedAt: Date.parse(version) })).rejects.toBeInstanceOf(RoleModifiedError)
    await expect(assignPlatformUserRoleCommand(input)).resolves.toMatchObject({ rowCount: 1 })
  })

  it('deduplicates actor equals target and snapshots scalars before await', async () => {
    const mutable = { ...input, userId: 'actor' }
    state.onQuery = () => { mutable.actorId = 'other'; mutable.userId = 'other'; mutable.roleId = 'other'; state.onQuery = undefined }
    await expect(assignPlatformUserRoleCommand(mutable)).resolves.toMatchObject({ affectedUserIds: ['actor'] })
    expect(mocks.entry.mock.calls[0][0].userIds).toEqual(['actor'])
  })

  it('fresh main-admin cleanup is atomic and duplicate appointment preserves audience', async () => {
    state.scopes = [{ userId: 'target', namespace: 'crm', table: 'department' }, { userId: 'target', namespace: 'crm', table: 'group' }, { userId: 'target', namespace: 'other', table: 'group' }]
    const result = await assignPlatformUserRoleCommand({ ...input, roleId: 'crm_admin' })
    expect(result).toEqual({ affectedUserIds: ['target'], rowCount: 1, delegatedAdminScopeCleanup: [{ userId: 'target', namespace: 'crm', scopeRows: 1, groupScopeRows: 1 }] })
    expect(state.scopes).toEqual([{ userId: 'target', namespace: 'other', table: 'group' }])
    state.scopes.push({ userId: 'target', namespace: 'crm', table: 'group' })
    expect(await assignPlatformUserRoleCommand({ ...input, roleId: 'crm_admin' })).toEqual({ affectedUserIds: [], rowCount: 0, delegatedAdminScopeCleanup: [] })
    expect(state.scopes).toHaveLength(2)
  })

  it('retains audience when another same-namespace main-admin role remains', async () => {
    state.memberships.get('target')!.add('crm _admin')
    state.scopes = [{ userId: 'target', namespace: 'crm', table: 'group' }]
    expect(await assignPlatformUserRoleCommand({ ...input, roleId: 'crm_admin' })).toMatchObject({ delegatedAdminScopeCleanup: [] })
    expect(state.scopes).toHaveLength(1)
  })

  it('admin legacy update still occurs for duplicate membership', async () => {
    state.memberships.get('target')!.add('admin')
    expect(await assignPlatformUserRoleCommand({ ...input, roleId: 'admin' })).toMatchObject({ rowCount: 0 })
    expect(state.users.get('target')).toMatchObject({ role: 'admin', is_admin: true })
    expect(sqlEvents(/UPDATE users/)).toHaveLength(1)
  })

  it.each(['DELETE FROM delegated_role_admin_member_groups', 'UPDATE users'])('rolls back original shared effects when %s fails', async fail => {
    state.scopes = [{ userId: 'target', namespace: 'crm', table: 'department' }, { userId: 'target', namespace: 'crm', table: 'group' }]
    state.fail = fail
    await expect(assignPlatformUserRoleCommand({ ...input, roleId: fail === 'UPDATE users' ? 'admin' : 'crm_admin' })).rejects.toThrow('fixed SQL failure')
    expect(state.memberships.get('target')?.size).toBe(0)
    expect(state.scopes).toHaveLength(2)
    expect(state.users.get('target')).toMatchObject({ role: 'user', is_admin: false })
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
  })

  it('does not shortcut the old role query for a raw admin', async () => {
    state.users.get('actor')!.role = 'admin'
    state.fail = 'ORDER BY role_id ASC'
    await expect(assignPlatformUserRoleCommand(input)).rejects.toThrow('fixed SQL failure')
  })

  it('failed new SHARE does not execute restore SQL', async () => {
    state.fail = "AND role_id = 'admin' FOR SHARE"
    await expect(assignPlatformUserRoleCommand(input)).rejects.toThrow('fixed SQL failure')
    expect(state.events.at(-2)).toContain("AND role_id = 'admin' FOR SHARE")
    expect(state.events.at(-1)).toBe('ROLLBACK_ATTEMPT')
  })

  it('restores timeouts when the positive edge disappeared after ordinary authority read', async () => {
    state.onQuery = sql => { if (sql.includes("AND role_id = 'admin' FOR SHARE")) state.memberships.set('actor', new Set()) }
    await expect(assignPlatformUserRoleCommand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual(['2s', '3s'])
    expect(sqlEvents(/INSERT INTO user_roles/)).toEqual([])
  })
})

describe('test-only invalid entry tokens', () => {
  it.each(['fake', 'closed', 'cross-plan', 'wrong-intent', 'wrong-world', 'r3-actor', 'r3-target', 'r5-actor', 'r5-target', 'born-only', 'role-key', 'witness-actor', 'witness-target'])('rejects %s before shared DML', async mode => {
    state.transform = (candidate) => {
      const original = candidate as AuthorizationInputTx
      const token = { ...original } as unknown as AuthorizationInputTx
      if (mode === 'cross-plan') Object.assign(token, { plan: { ...original.plan } })
      if (mode === 'wrong-intent') Object.assign(token, { plan: { ...original.plan, intent: 'REVOKE_ROLE' } })
      if (mode === 'wrong-world') Object.assign(token, { world: 'exclusive' })
      if (mode.startsWith('r3')) Object.assign(token, { witnessed: { ...original.witnessed, admissionUserIds: new Set(mode.endsWith('actor') ? ['target'] : ['actor']) } })
      if (mode.startsWith('r5') || mode === 'born-only') Object.assign(token, { locked: new Map([...original.locked].filter(([id]) => id !== (mode.endsWith('actor') ? 'actor' : 'target'))), born: new Set(['actor', 'target']) })
      if (mode === 'role-key') Object.assign(token, { roleRows: new Map() })
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
        : mode === 'r5-target' || mode === 'born-only' ? { code: 'NOT_FOUND' }
          : { code: 'AUTHORIZATION_INPUT_PLAN_INVALID' }
    await expect(assignPlatformUserRoleCommand(input)).rejects.toMatchObject(refusal)
    expect(sqlEvents(/INSERT INTO user_roles|DELETE FROM delegated_role_admin_|UPDATE users/)).toEqual([])
  })
})

describe('actual registered final handler seam, not HTTP authentication acceptance', () => {
  it.each([undefined, null, '', 7, 'bad', '2026-01-01'])('retains version-input behavior for %j', async expectedUpdatedAt => {
    const response = await route({ roleId: 'crm_user', expectedUpdatedAt })
    expect(response.statusCode).toBe(expectedUpdatedAt === undefined ? 200 : 400)
    if (expectedUpdatedAt !== undefined) expect(response.body).toEqual({ ok: false, error: { code: 'EXPECTED_UPDATED_AT_INVALID', message: 'expectedUpdatedAt must be a non-empty ISO 8601 timestamp (omit the field to skip the concurrency check)', details: undefined } })
  })

  it('preserves outer role before missing profile and locked target before actor', async () => {
    state.roles.delete('crm_user')
    state.users.delete('target')
    expect(await route()).toMatchObject({ statusCode: 404, body: { ok: false, error: { code: 'ROLE_NOT_FOUND', message: 'Role not found' } } })
    state.roles.set('crm_user', version)
    expect((await route()).statusCode).toBe(404)
    state.users.set('target', { id: 'target', is_active: true })
    state.lockedTargetMissing = true
    state.users.delete('actor')
    expect((await route()).statusCode).toBe(404)
  })

  it('preserves outside admin and required-field precedence plus existing trim/coercion', async () => {
    state.outsideAdmin = false
    expect((await route({ roleId: '' })).statusCode).toBe(403)
    state.outsideAdmin = true
    expect((await route({ roleId: '' })).statusCode).toBe(400)
    expect((await route({ roleId: ' crm_user ' }, ' target ')).statusCode).toBe(200)
  })

  it('retains exact ROLE_MODIFIED and generic correlation response', async () => {
    expect(await route({ roleId: 'crm_user', expectedUpdatedAt: '2026-01-01T00:00:00Z' })).toMatchObject({ statusCode: 409, body: { ok: false, error: { code: 'ROLE_MODIFIED', message: 'This role changed since it was loaded; reload it and re-apply the change', details: { retryable: true } } } })
    state.fail = 'INSERT INTO user_roles'
    expect(await route()).toMatchObject({ statusCode: 500, body: { ok: false, error: { code: 'ROLE_ASSIGN_FAILED', message: 'Failed to assign role' } } })
  })

  it.each(['40P01', '40001', '55P03', '57014'])('maps DML %s to exact authorization busy separately from recovery', async code => {
    state.fail = 'INSERT INTO user_roles'
    state.errorCode = code
    expect(await route()).toMatchObject({ statusCode: 409, body: busyBody })
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('waits for the whole root commit and preserves effect order', async () => {
    let release!: () => void
    state.commitGate = new Promise<void>(resolve => { release = resolve })
    const pending = route()
    await vi.waitFor(() => expect(sqlEvents(/INSERT INTO user_roles/)).toHaveLength(1))
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
    release()
    expect((await pending).statusCode).toBe(200)
    expect(state.events.filter(event => ['COMMIT_CONFIRMED', 'invalidate', 'audit'].includes(event))).toEqual(['COMMIT_CONFIRMED', 'invalidate', 'audit'])
  })

  it('keeps cleanup audit before invalidate and business audit', async () => {
    state.scopes = [{ userId: 'target', namespace: 'crm', table: 'group' }]
    expect((await route({ roleId: 'crm_admin' })).statusCode).toBe(200)
    expect(state.events.filter(event => ['COMMIT_CONFIRMED', 'invalidate', 'audit'].includes(event))).toEqual(['COMMIT_CONFIRMED', 'audit', 'invalidate', 'audit'])
  })

  it('does not replay unknown COMMIT or run effects', async () => {
    state.commitUnknown = true
    expect((await route()).statusCode).toBe(500)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('does not pretend committed data rolled back after snapshot failure', async () => {
    state.afterCommitReadFailure = true
    expect((await route()).statusCode).toBe(500)
    expect(state.memberships.get('target')?.has('crm_user')).toBe(true)
    expect(state.events).toContain('COMMIT_CONFIRMED')
    expect(state.events).not.toContain('ROLLBACK_ATTEMPT')
  })
})
