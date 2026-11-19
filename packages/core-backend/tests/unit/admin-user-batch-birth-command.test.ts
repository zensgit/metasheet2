import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  memberships: new Map<string, string[]>(),
  roles: new Set<string>(),
  births: [] as unknown[][],
  admissions: [] as unknown[][],
  roleGrants: [] as unknown[][],
  events: [] as string[],
  fail: '',
  transform: undefined as ((tx: AuthorizationInputTx) => AuthorizationInputTx) | undefined,
}))

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  entry: vi.fn(),
}))

const helper = vi.hoisted(() => ({
  aliases: [] as Array<[Record<string, unknown>, AuthorizationInputTx]>,
  roles: [] as Array<[Record<string, unknown>, AuthorizationInputTx]>,
  admissions: [] as Array<[Record<string, unknown>, AuthorizationInputTx]>,
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ transaction: mocks.transaction }) },
}))
vi.mock('../../src/rbac/authorization-input-lock', async (original) => {
  const actual = await original<typeof import('../../src/rbac/authorization-input-lock')>()
  return {
    ...actual,
    withAuthorizationInputTransaction: (
      plan: AuthorizationInputPlan,
      work: (tx: AuthorizationInputTx) => Promise<unknown>,
      options?: unknown,
    ) => {
      mocks.entry(plan, work, options)
      return actual.withAuthorizationInputTransaction(
        plan,
        (tx) => work(state.transform ? state.transform(tx) : tx),
        options as never,
      )
    },
  }
})
vi.mock('../../src/db/pg', () => ({ query: mocks.query, transaction: mocks.transaction }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/auth/login-alias-service', async (original) => {
  const actual = await original<typeof import('../../src/auth/login-alias-service')>()
  return {
    ...actual,
    claimNonEmptyLoginAliasesOrThrow: async (
      options: Parameters<typeof actual.claimNonEmptyLoginAliasesOrThrow>[0],
    ) => {
      const claimed = await actual.claimNonEmptyLoginAliasesOrThrow(options)
      helper.aliases.push([options as Record<string, unknown>, options.client as AuthorizationInputTx])
      return claimed
    },
  }
})
vi.mock('../../src/rbac/role-assignment', async (original) => {
  const actual = await original<typeof import('../../src/rbac/role-assignment')>()
  return {
    ...actual,
    assignUserRoles: async (options: Parameters<typeof actual.assignUserRoles>[0]) => {
      const assigned = await actual.assignUserRoles(options)
      helper.roles.push([options as Record<string, unknown>, options.executor as AuthorizationInputTx])
      return assigned
    },
  }
})
vi.mock('../../src/rbac/namespace-admission', async (original) => {
  const actual = await original<typeof import('../../src/rbac/namespace-admission')>()
  return {
    ...actual,
    writeUserNamespaceAdmission: async (
      options: Parameters<typeof actual.writeUserNamespaceAdmission>[0],
      client: Parameters<typeof actual.writeUserNamespaceAdmission>[1],
    ) => {
      await actual.writeUserNamespaceAdmission(options, client)
      helper.admissions.push([options as Record<string, unknown>, client as AuthorizationInputTx])
    },
  }
})

import { createAdminBatchUserCommand } from '../../src/admin/admin-user-batch-birth-command'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
} from '../../src/rbac/authorization-input-lock'

type BirthInput = {
  actorId: string
  userId: string
  email: string
  name: string
  department: string | null
  passwordHash: string
  roleId: string | null
}

const calls = () => mocks.query.mock.calls as Array<[string, unknown[]?]>
const planOf = () => mocks.entry.mock.calls.at(-1)?.[0] as AuthorizationInputPlan
const sqlText = (sql: string) => sql.replace(/\s+/g, ' ').trim()

function user(id: string, role = 'admin', extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    email: null,
    username: id,
    mobile: null,
    activation_status: 'activated',
    role,
    is_active: true,
    access_generation: 0,
    deleted_at: null,
    purged_at: null,
    ...extra,
  }
}

function birthInput(patch: Partial<BirthInput> = {}): BirthInput {
  return {
    actorId: 'actor',
    userId: 'target',
    email: 'new@example.com',
    name: 'New Colleague',
    department: '计划部',
    passwordHash: 'hashed',
    roleId: 'planner',
    ...patch,
  }
}

function retoken(source: AuthorizationInputTx, patch: Partial<AuthorizationInputTx> = {}): AuthorizationInputTx {
  const token = { ...source, query: source.query, ...patch }
  mintAuthorizationInputBrand(token, [token])
  return token as AuthorizationInputTx
}

function snapshot() {
  return {
    births: state.births.slice(),
    admissions: state.admissions.slice(),
    roleGrants: state.roleGrants.slice(),
  }
}

async function rejectionOf(input: BirthInput = birthInput()): Promise<{ code?: string; reason?: string }> {
  try {
    await createAdminBatchUserCommand(input)
  } catch (error) {
    const caught = error as { code?: string; reason?: string }
    return { code: caught.code, reason: caught.reason }
  }
  throw new Error('expected rejection')
}

beforeEach(() => {
  vi.clearAllMocks()
  helper.aliases = []
  helper.roles = []
  helper.admissions = []
  state.users = new Map([['actor', user('actor', 'admin')]])
  state.memberships = new Map([['actor', []]])
  state.roles = new Set(['planner', 'admin'])
  state.births = []
  state.admissions = []
  state.roleGrants = []
  state.events = []
  state.fail = ''
  state.transform = undefined
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = sqlText(sql)
    state.events.push(text)
    if (state.fail === 'unique' && text.includes('INSERT INTO users')) {
      throw Object.assign(new Error('duplicate'), { code: '23505' })
    }
    if (state.fail === 'alias-throw' && text.includes('INSERT INTO user_login_aliases')) {
      throw Object.assign(new Error('alias write'), { code: 'XX000' })
    }
    if (state.fail === 'role-write' && text.includes('INSERT INTO user_roles')) {
      throw Object.assign(new Error('role write'), { code: 'XX000' })
    }
    if (state.fail === 'admission' && text.includes('INSERT INTO user_namespace_admissions')) {
      throw Object.assign(new Error('admission write'), { code: 'XX000' })
    }
    if (text.includes('current_setting')) return { rows: [{ lock_timeout: '2s', statement_timeout: '3s' }] }
    if (text.includes('set_config')) return { rows: [] }
    if (text === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared) {
      const roleId = String(params?.[0])
      return { rows: state.roles.has(roleId) ? [{ id: roleId }] : [] }
    }
    if (/FROM users/.test(text) && /FOR UPDATE/.test(text)) {
      const row = state.users.get(String(params?.[0]))
      return { rows: row ? [row] : [] }
    }
    if (text.includes('FROM user_roles') && text.includes('FOR SHARE')) {
      if (state.fail === 'child-gone') return { rows: [] }
      const held = (state.memberships.get(String(params?.[0])) ?? []).includes('admin')
      return { rows: held ? [{ role_id: 'admin' }] : [] }
    }
    if (text.includes('FROM user_roles')) {
      const roles = state.memberships.get(String(params?.[0])) ?? []
      return { rows: roles.map((roleId) => ({ role_id: roleId })) }
    }
    if (text.includes('INSERT INTO users')) {
      const id = state.fail === 'birth-id' ? 'not-the-target' : params?.[0]
      state.births.push(params ?? [])
      return { rows: [{ id }], rowCount: 1 }
    }
    if (text.includes('INSERT INTO user_login_aliases')) return { rows: [], rowCount: 1 }
    if (text.includes('FROM user_login_aliases')) {
      if (state.fail === 'alias-conflict') return { rows: [{ user_id: 'other-owner' }] }
      return { rows: [{ user_id: 'target' }] }
    }
    if (text.includes('INSERT INTO user_roles')) {
      state.roleGrants.push(params ?? [])
      return { rows: [{ user_id: 'target' }], rowCount: 1 }
    }
    if (text.includes('INSERT INTO user_namespace_admissions')) {
      state.admissions.push(params ?? [])
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  mocks.transaction.mockImplementation(async (work: (client: { query: typeof mocks.query }) => Promise<unknown>) => {
    const saved = snapshot()
    state.events.push('BEGIN')
    try {
      const result = await work({ query: mocks.query })
      if (state.fail === 'commit') throw Object.assign(new Error('commit failed'), { code: 'COMMIT_UNCONFIRMED' })
      state.events.push('COMMIT_CONFIRMED')
      return result
    } catch (error) {
      state.events.push('ROLLBACK_ATTEMPT')
      state.births = saved.births
      state.admissions = saved.admissions
      state.roleGrants = saved.roleGrants
      throw error
    }
  })
})

describe('admin batch user birth command', () => {
  it('freezes one shared BIRTH root and writes the fixed row for a raw admin', async () => {
    await createAdminBatchUserCommand(birthInput())
    const plan = planOf()
    expect(plan).toEqual({
      intent: 'BIRTH',
      roleIds: ['planner'],
      witness: { userIds: ['actor'], admissionUserIds: ['actor'] },
    })
    expect(plan.witness?.userIds).toBe(plan.witness?.admissionUserIds)
    expect(Object.keys(plan).sort()).toEqual(['intent', 'roleIds', 'witness'])
    expect(plan.userIds).toBeUndefined()
    expect(plan.admissionUserIds).toBeUndefined()
    expect(plan.world).toBeUndefined()
    expect(plan.platformAdminInvariant).toBeUndefined()
    for (const value of [plan, plan.roleIds, plan.witness, plan.witness?.userIds, plan.witness?.admissionUserIds]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    expect(mocks.entry).toHaveBeenCalledTimes(1)
    expect(mocks.entry.mock.calls[0]?.[2]).toBeUndefined()
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    const usersInsert = calls().find(([sql]) => sql.includes('INSERT INTO users'))
    expect(usersInsert?.[0]).toContain('INSERT INTO users (id, email, username, name, mobile, employee_no, department, position, hire_date, password_hash, must_change_password, role, permissions, is_active, is_admin, activation_status, local_password_set)')
    expect(usersInsert?.[0]).not.toContain('created_at')
    expect(usersInsert?.[0]).not.toContain('updated_at')
    expect(usersInsert?.[1]).toEqual([
      'target', 'new@example.com', null, 'New Colleague', null, null, '计划部', null, null,
      'hashed', true, 'planner', '[]', true, false, 'activated', true,
    ])
    expect(usersInsert?.[1]?.[12]).toBe('[]')
    expect(calls().some(([sql]) => sql.includes('user-recycle:platform-admin'))).toBe(false)
    expect(calls().some(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry)).toBe(false)
    expect(calls().some(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRow)).toBe(false)
    expect(calls().filter(([sql]) => sql.includes('FROM user_roles') && sql.includes('FOR SHARE'))).toEqual([])
    expect(calls().filter(([, params]) => params?.[0] === 'namespace-admission:actor')).toHaveLength(1)
    expect(calls().filter(([sql]) => /FOR UPDATE/.test(sql))).toHaveLength(1)
    const worldAt = calls().findIndex(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.worldShared)
    const roleAt = calls().findIndex(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)
    const admissionLockAt = calls().findIndex(([, params]) => params?.[0] === 'namespace-admission:actor')
    const userAt = calls().findIndex(([sql]) => /FROM users/.test(sql) && /FOR UPDATE/.test(sql))
    const insertAt = calls().findIndex(([sql]) => sql.includes('INSERT INTO users'))
    const aliasAt = calls().findIndex(([sql]) => sql.includes('INSERT INTO user_login_aliases'))
    const grantAt = calls().findIndex(([sql]) => sql.includes('INSERT INTO user_roles'))
    const admissionAt = calls().findIndex(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))
    expect(worldAt).toBeGreaterThanOrEqual(0)
    expect(roleAt).toBeGreaterThan(worldAt)
    expect(admissionLockAt).toBeGreaterThan(roleAt)
    expect(userAt).toBeGreaterThan(admissionLockAt)
    expect(insertAt).toBeGreaterThan(userAt)
    expect(aliasAt).toBeGreaterThan(insertAt)
    expect(grantAt).toBeGreaterThan(aliasAt)
    expect(admissionAt).toBeGreaterThan(grantAt)
    expect(state.events[0]).toBe('BEGIN')
    expect(state.events.at(-1)).toBe('COMMIT_CONFIRMED')
    expect(state.events.indexOf('COMMIT_CONFIRMED')).toBeGreaterThan(state.events.findIndex((sql) => sql.includes('INSERT INTO users')))
    expect(calls()[roleAt]?.[1]).toEqual(['planner'])
    expect(helper.aliases).toHaveLength(1)
    expect(helper.roles).toHaveLength(1)
    expect(helper.admissions).toHaveLength(1)
    const client = helper.aliases[0]?.[1]
    expect(client?.plan).toBe(plan)
    expect(client?.world).toBe('shared')
    expect(client?.born.has('target')).toBe(true)
    expect(client?.born.size).toBe(1)
    expect([...client?.locked.keys() ?? []]).toEqual(['actor'])
    expect(client?.roleRows.get('planner')).toBe('held')
    expect(helper.aliases[0]?.[0]).toMatchObject({
      userId: 'target',
      email: 'new@example.com',
      source: 'admin_batch_create',
    })
    expect(helper.aliases[0]?.[0].client).toBe(client)
    expect(helper.roles[0]?.[0]).toMatchObject({
      userIds: ['target'],
      roleId: 'planner',
      scope: { kind: 'platform-admin' },
    })
    expect(helper.roles[0]?.[1]).toBe(client)
    expect(helper.admissions[0]?.[0]).toEqual({
      userId: 'target',
      namespace: 'attendance',
      enabled: false,
      actorId: 'actor',
      source: 'admin_batch_create',
    })
    expect(helper.admissions[0]?.[1]).toBe(client)
    expect(state.admissions[0]).toEqual(['target', 'attendance', false, 'admin_batch_create', null, 'actor'])
    expect(JSON.stringify(helper.aliases)).not.toContain('Tmp-')
    expect(JSON.stringify(helper.admissions)).not.toContain('Tmp-')
    expect(state.births).toHaveLength(1)
    expect(state.roleGrants).toHaveLength(1)
  })

  it('keeps a no-role birth on the user display role and still disables attendance', async () => {
    await createAdminBatchUserCommand(birthInput({ roleId: null, department: null }))
    const plan = planOf()
    expect(plan.roleIds).toEqual([])
    expect(Object.isFrozen(plan.roleIds)).toBe(true)
    expect(calls().some(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)).toBe(false)
    expect(calls().some(([sql]) => sql.includes('INSERT INTO user_roles'))).toBe(false)
    expect(helper.roles).toEqual([])
    const usersInsert = calls().find(([sql]) => sql.includes('INSERT INTO users'))
    expect(usersInsert?.[1]?.[6]).toBeNull()
    expect(usersInsert?.[1]?.[11]).toBe('user')
    expect(usersInsert?.[1]?.[14]).toBe(false)
    expect(helper.admissions).toHaveLength(1)
    expect(state.events.at(-1)).toBe('COMMIT_CONFIRMED')
  })

  it('stores an admin display role and is_admin only for the admin parent', async () => {
    await createAdminBatchUserCommand(birthInput({ roleId: 'admin' }))
    expect(planOf().roleIds).toEqual(['admin'])
    const usersInsert = calls().find(([sql]) => sql.includes('INSERT INTO users'))
    expect(usersInsert?.[1]?.[11]).toBe('admin')
    expect(usersInsert?.[1]?.[14]).toBe(true)
    expect(calls().find(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)?.[1]).toEqual(['admin'])
    expect(calls().filter(([sql]) => sql.includes('FROM user_roles') && sql.includes('FOR SHARE'))).toEqual([])
    expect(helper.roles[0]?.[0]).toMatchObject({ roleId: 'admin', scope: { kind: 'platform-admin' } })
    expect(helper.admissions).toHaveLength(1)
  })

  it('holds the exact admin child for a non-raw actor and restores the caller timeouts', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.memberships.set('actor', ['admin'])
    await createAdminBatchUserCommand(birthInput())
    const child = calls().filter(([sql]) => sql.includes('FROM user_roles') && sql.includes('FOR SHARE'))
    expect(child).toHaveLength(1)
    expect(child[0]?.[1]).toEqual(['actor'])
    const shareAt = calls().findIndex(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))
    expect(calls()[shareAt - 1]?.[1]).toEqual([
      String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS),
      String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS),
    ])
    expect(calls()[shareAt + 1]?.[1]).toEqual(['2s', '3s'])
    expect(shareAt).toBeLessThan(calls().findIndex(([sql]) => sql.includes('INSERT INTO users')))
    expect(state.births).toHaveLength(1)
  })

  it('refuses a non-raw actor when the shared child disappears before birth', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.memberships.set('actor', ['admin'])
    state.fail = 'child-gone'
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'FORBIDDEN' })
    expect(calls().some(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(true)
    expect(state.births).toEqual([])
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
  })

  it('refuses a non-raw actor with no admin child before birth', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.memberships.set('actor', [])
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'FORBIDDEN' })
    expect(calls().some(([sql]) => sql.includes('FROM user_roles') && !sql.includes('FOR SHARE'))).toBe(true)
    expect(calls().some(([sql]) => sql.includes('FOR SHARE') && sql.includes('FROM user_roles'))).toBe(false)
    expect(state.births).toEqual([])
    expect(helper.aliases).toEqual([])
  })

  it.each([
    ['absent', () => { state.users.delete('actor') }],
    ['pending', () => { state.users.set('actor', user('actor', 'admin', { activation_status: 'pending' })) }],
    ['inactive', () => { state.users.set('actor', user('actor', 'admin', { is_active: false })) }],
    ['recycled', () => { state.users.set('actor', user('actor', 'admin', { deleted_at: '2026-01-01T00:00:00.000Z' })) }],
    ['purged', () => { state.users.set('actor', user('actor', 'admin', { purged_at: '2026-01-02T00:00:00.000Z' })) }],
  ])('refuses a %s actor before birth SQL', async (_name, arrange) => {
    arrange()
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'FORBIDDEN' })
    expect(calls().some(([sql]) => sql.includes('FROM user_roles'))).toBe(false)
    expect(calls().some(([sql]) => sql.includes('INSERT INTO users'))).toBe(false)
    expect(state.births).toEqual([])
    expect(state.events.at(-1)).toBe('ROLLBACK_ATTEMPT')
  })

  it('lets actor denial win over a selected role that disappeared after planning', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.memberships.set('actor', [])
    state.roles.delete('planner')
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.births).toEqual([])
  })

  it('returns ROLE_NOT_FOUND when the selected parent is gone and writes nothing', async () => {
    state.roles.delete('planner')
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'ROLE_NOT_FOUND' })
    expect(calls().some(([sql]) => sql.includes('INSERT INTO users'))).toBe(false)
    expect(helper.aliases).toEqual([])
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
  })

  it('rejects an actor and target collision before opening a root', async () => {
    await expect(rejectionOf(birthInput({ userId: 'actor' }))).resolves.toMatchObject({
      code: 'AUTHORIZATION_INPUT_PLAN_INVALID',
      reason: 'admin_batch_birth_context',
    })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(state.events).toEqual([])
  })

  it('rejects a held target, a foreign born id, and a returned id that is not the generated id', async () => {
    state.transform = (tx) => retoken(tx, {
      locked: new Map([...tx.locked.entries(), ['target', { ...tx.locked.get('actor')!, id: 'target', role: 'user' }]]),
    })
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })
    expect(calls().some(([sql]) => sql.includes('INSERT INTO users'))).toBe(false)

    state.transform = undefined
    state.fail = 'birth-id'
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })
    expect(helper.aliases).toEqual([])
    expect(state.births).toEqual([])

    state.fail = 'unique'
    await expect(rejectionOf()).resolves.toMatchObject({ code: '23505' })
    expect(helper.aliases).toEqual([])
    expect(state.births).toEqual([])
    expect(state.events.at(-1)).toBe('ROLLBACK_ATTEMPT')
  })

  it('rejects a different plan object and a witness or born set that is not the actor then the target', async () => {
    state.transform = (tx) => retoken(tx, {
      plan: { intent: 'BIRTH', roleIds: tx.plan.roleIds, witness: tx.plan.witness },
    })
    await expect(rejectionOf()).resolves.toMatchObject({
      code: 'AUTHORIZATION_INPUT_PLAN_INVALID',
      reason: 'admin_batch_birth_context',
    })

    state.transform = (tx) => retoken(tx, {
      witnessed: { userIds: new Set(['actor', 'extra']), admissionUserIds: tx.witnessed.admissionUserIds },
    })
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })

    state.transform = (tx) => retoken(tx, {
      witnessed: { userIds: new Set<string>(), admissionUserIds: new Set(['actor']) },
    })
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })

    state.transform = (tx) => retoken(tx, { born: new Set(['stranger']) })
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })
    expect(calls().some(([sql]) => sql.includes('INSERT INTO users'))).toBe(false)

    const born = new Set<string>()
    state.transform = (tx) => retoken(tx, {
      born,
      insertUserForBirth: async (row) => {
        const inserted = await tx.insertUserForBirth(row)
        born.add(inserted.id)
        born.add('stranger')
        return inserted
      },
    })
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })
    expect(helper.aliases).toEqual([])
    expect(state.births).toEqual([])
  })

  it('rejects an actor that is only born, a closed token, and an unbranded token', async () => {
    state.transform = (tx) => retoken(tx, {
      locked: new Map(),
      witnessed: { userIds: new Set<string>(), admissionUserIds: new Set(['actor']) },
      born: new Set(['actor']),
    })
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })

    state.transform = (tx) => {
      const token = { ...tx, query: tx.query }
      const brand = mintAuthorizationInputBrand(token, [token])
      brand.close()
      return token as AuthorizationInputTx
    }
    await expect(rejectionOf()).resolves.toMatchObject({
      code: 'AUTHORIZATION_INPUT_TOKEN_REJECTED',
      reason: 'closed',
    })

    state.transform = (tx) => ({ ...tx, query: tx.query }) as AuthorizationInputTx
    await expect(rejectionOf()).resolves.toMatchObject({
      code: 'AUTHORIZATION_INPUT_TOKEN_REJECTED',
      reason: 'unbranded',
    })
    expect(state.births).toEqual([])
  })

  it('rolls back when alias, role, or admission fails and does not continue', async () => {
    state.fail = 'alias-conflict'
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'ALIAS_CONFLICT' })
    expect(helper.roles).toEqual([])
    expect(helper.admissions).toEqual([])
    expect(state.births).toEqual([])
    expect(state.events.some((sql) => sql.includes('INSERT INTO user_roles'))).toBe(false)

    state.fail = 'alias-throw'
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'ALIAS_WRITE_FAILED' })
    expect(helper.admissions).toEqual([])
    expect(state.births).toEqual([])

    state.fail = 'role-write'
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'XX000' })
    expect(calls().some(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))).toBe(false)
    expect(state.births).toEqual([])
    expect(state.roleGrants).toEqual([])
    expect(state.admissions).toEqual([])

    state.fail = 'admission'
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'XX000' })
    expect(state.births).toEqual([])
    expect(state.roleGrants).toEqual([])
    expect(state.admissions).toEqual([])
    expect(state.events.at(-1)).toBe('ROLLBACK_ATTEMPT')
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
  })

  it('treats an unconfirmed commit as failure and keeps no residue', async () => {
    state.fail = 'commit'
    await expect(rejectionOf()).resolves.toMatchObject({ code: 'COMMIT_UNCONFIRMED' })
    expect(state.events.some((sql) => sql.includes('INSERT INTO users'))).toBe(true)
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
    expect(state.events.at(-1)).toBe('ROLLBACK_ATTEMPT')
    expect(state.births).toEqual([])
    expect(state.roleGrants).toEqual([])
    expect(state.admissions).toEqual([])
  })

  it('copies plain input before its first await', async () => {
    const input = birthInput()
    const current = mocks.transaction.getMockImplementation()
    mocks.transaction.mockImplementationOnce(async (work: (client: { query: typeof mocks.query }) => Promise<unknown>) => {
      input.email = 'changed@example.com'
      input.name = 'Changed Name'
      input.roleId = 'admin'
      input.department = '别处'
      return current?.(work)
    })
    await createAdminBatchUserCommand(input)
    expect(planOf().roleIds).toEqual(['planner'])
    const usersInsert = calls().find(([sql]) => sql.includes('INSERT INTO users'))
    expect(usersInsert?.[1]?.[1]).toBe('new@example.com')
    expect(usersInsert?.[1]?.[3]).toBe('New Colleague')
    expect(usersInsert?.[1]?.[6]).toBe('计划部')
    expect(usersInsert?.[1]?.[11]).toBe('planner')
  })
})
