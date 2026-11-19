import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'

const DERIVING_CHILD_SQL = 'SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = ANY($2::text[]) ORDER BY role_id FOR SHARE'
const DEPARTMENT_SHARE_SQL = 'SELECT id FROM directory_departments WHERE id = $1 FOR SHARE'
const MEMBERSHIP_SHARE_SQL = 'SELECT group_id, user_id FROM platform_member_group_members WHERE group_id = $1 AND user_id = $2 FOR SHARE'
const ADMIN_CHILD_SQL = "SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE"

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  memberships: new Map<string, string[]>(),
  events: [] as string[],
  fail: '',
  errorCode: 'XX000',
  errorMessage: 'fixed SQL failure',
  onQuery: undefined as (() => void) | undefined,
  transform: undefined as ((tx: AuthorizationInputTx) => AuthorizationInputTx) | undefined,
  roleIds: [] as string[],
  roleIdsAfterChildShare: null as string[] | null,
  childShares: 0,
  missingParents: false,
  allowed: true,
  allowedReads: 0,
  finalAllowed: true,
  configured: true,
  disabledNamespaces: [] as string[],
  seeds: [] as Array<Record<string, unknown>>,
  secondSeeds: null as Array<Record<string, unknown>> | null,
  seedReads: 0,
  children: [] as Array<Record<string, unknown>>,
  leaves: [] as Array<Record<string, unknown>>,
  groups: [] as Array<Record<string, unknown>>,
  departmentHeld: ((_id: string) => true) as (id: string) => boolean,
  membershipHeld: ((_groupId: string, _userId: string) => true) as (groupId: string, userId: string) => boolean,
}))

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  entry: vi.fn(),
}))

const helper = vi.hoisted(() => ({
  calls: [] as Array<[Record<string, unknown>, AuthorizationInputTx]>,
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
vi.mock('../../src/rbac/namespace-admission', async (original) => {
  const actual = await original<typeof import('../../src/rbac/namespace-admission')>()
  return {
    ...actual,
    writeUserNamespaceAdmission: async (
      options: Parameters<typeof actual.writeUserNamespaceAdmission>[0],
      client: Parameters<typeof actual.writeUserNamespaceAdmission>[1],
    ) => {
      helper.calls.push([options as Record<string, unknown>, client as AuthorizationInputTx])
      return actual.writeUserNamespaceAdmission(options, client)
    },
  }
})

import { writeRoleDelegationNamespaceAdmissionCommand } from '../../src/admin/role-delegation-namespace-admission-command'
import { enumerateScopePathWitness, sameScopePathWitness } from '../../src/admin/delegated-scope-witness'
import { DelegationAuthorityRefusal, deriveDelegableNamespaces } from '../../src/admin/delegated-authority'
import {
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  AuthorizationInputBusyError,
} from '../../src/rbac/authorization-input-lock'
import { AUTHORIZATION_INPUT_WRITERS } from '../../src/rbac/authorization-input-writers'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

const calls = () => mocks.query.mock.calls as Array<[string, unknown[]?]>
const business = () => state.events.filter((sql) => sql.includes('INSERT INTO user_namespace_admissions'))
const planOf = () => mocks.entry.mock.calls.at(-1)?.[0] as AuthorizationInputPlan
const pair = (left: string, right: string) => calls().filter(([, params]) => params?.[0] === left && params?.[1] === right)
const roleReads = () => calls().filter(([sql]) => sql.includes('FROM user_roles') && sql.includes('ORDER BY role_id ASC') && !sql.includes('FOR SHARE'))
const seedCalls = () => calls().filter(([sql]) => sql.includes('bool_or') && !sql.includes('WITH RECURSIVE'))
const admissionInput = (patch: Record<string, unknown> = {}) => ({
  actorId: 'actor',
  userId: 'target',
  namespace: 'crm',
  enabled: true,
  isPlatformAdmin: true,
  ...patch,
})
const delegatedInput = (patch: Record<string, unknown> = {}) => admissionInput({ isPlatformAdmin: false, ...patch })

function user(id: string, role = 'user', extra: Record<string, unknown> = {}) {
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

function retoken(source: AuthorizationInputTx, patch: Partial<AuthorizationInputTx> = {}): AuthorizationInputTx {
  const token = { ...source, query: source.query, ...patch }
  mintAuthorizationInputBrand(token, [token])
  return token as AuthorizationInputTx
}

function expectNoWrite() {
  expect(helper.calls).toEqual([])
  expect(business()).toEqual([])
}

function usePath() {
  state.seeds = [{
    id: 'p1',
    integration_id: 'i',
    external_department_id: 'E',
    include_children: true,
  }]
  state.children = [
    { id: 'mid', integration_id: 'i', external_department_id: 'M', external_parent_department_id: 'E' },
    { id: 'z-leaf', integration_id: 'i', external_department_id: 'L', external_parent_department_id: 'M' },
    { id: 'side', integration_id: 'i', external_department_id: 'S', external_parent_department_id: 'E' },
  ]
  state.leaves = [{ id: 'z-leaf' }]
  state.groups = []
}

function throwCoded() {
  throw Object.assign(new Error(state.errorMessage), { code: state.errorCode })
}

beforeEach(() => {
  vi.clearAllMocks()
  helper.calls = []
  state.users = new Map([
    ['actor', user('actor', 'admin')],
    ['target', user('target', 'user')],
  ])
  state.memberships = new Map([
    ['actor', ['admin']],
    ['target', []],
  ])
  state.events = []
  state.fail = ''
  state.errorCode = 'XX000'
  state.errorMessage = 'fixed SQL failure'
  state.onQuery = undefined
  state.transform = undefined
  state.roleIds = []
  state.roleIdsAfterChildShare = null
  state.childShares = 0
  state.missingParents = false
  state.allowed = true
  state.allowedReads = 0
  state.finalAllowed = true
  state.configured = true
  state.disabledNamespaces = []
  state.seeds = []
  state.secondSeeds = null
  state.seedReads = 0
  state.children = []
  state.leaves = []
  state.groups = []
  state.departmentHeld = () => true
  state.membershipHeld = () => true
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    state.events.push(text)
    state.onQuery?.()
    if (state.fail === 'user-lock' && /FROM users/.test(sql) && /FOR UPDATE/.test(sql)) throwCoded()
    if (state.fail === 'admin-share' && sql.includes(ADMIN_CHILD_SQL)) throwCoded()
    if (state.fail === 'deriving-share' && sql === DERIVING_CHILD_SQL) throwCoded()
    if (state.fail === 'department-share' && sql === DEPARTMENT_SHARE_SQL) throwCoded()
    if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '2s', statement_timeout: '3s' }] }
    if (sql.includes('set_config')) return { rows: [] }
    if (/FROM users/.test(sql) && /FOR UPDATE/.test(sql)) {
      const row = state.users.get(String(params?.[0]))
      return { rows: row ? [row] : [] }
    }
    if (sql.includes(ADMIN_CHILD_SQL)) {
      const held = (state.memberships.get(String(params?.[0])) ?? []).includes('admin')
      return { rows: held ? [{ role_id: 'admin' }] : [] }
    }
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared) {
      return { rows: state.missingParents ? [] : [{ id: params?.[0] }] }
    }
    if (sql === DERIVING_CHILD_SQL) {
      state.childShares += 1
      const requested = Array.isArray(params?.[1]) ? params[1] as string[] : []
      return { rows: state.roleIds.filter((id) => requested.includes(id)).map((role_id) => ({ role_id })) }
    }
    if (sql.includes('FROM user_roles') && sql.includes('ORDER BY role_id ASC') && !sql.includes('FOR SHARE')) {
      const ids = state.childShares > 0 && state.roleIdsAfterChildShare ? state.roleIdsAfterChildShare : state.roleIds
      return { rows: ids.map((role_id) => ({ role_id })) }
    }
    if (sql.includes('FROM delegated_role_admin_activation')) {
      return { rows: state.disabledNamespaces.map(namespace => ({ namespace, enabled: false })) }
    }
    if (sql.includes('AS configured')) return { rows: [{ configured: state.configured }] }
    if (sql.includes('WITH RECURSIVE') || sql.includes('AS allowed')) {
      state.allowedReads += 1
      const allowed = state.allowedReads > 1 ? state.finalAllowed : state.allowed
      return { rows: [{ allowed }] }
    }
    if (sql.includes('bool_or')) {
      state.seedReads += 1
      return { rows: state.seedReads > 1 && state.secondSeeds ? state.secondSeeds : state.seeds }
    }
    if (sql.includes('external_parent_department_id')) return { rows: state.children }
    if (sql.includes("link_status = 'linked'")) return { rows: state.leaves }
    if (sql === DEPARTMENT_SHARE_SQL) {
      const id = String(params?.[0])
      return { rows: state.departmentHeld(id) ? [{ id }] : [] }
    }
    if (sql === MEMBERSHIP_SHARE_SQL) {
      const groupId = String(params?.[0])
      const userId = String(params?.[1])
      return { rows: state.membershipHeld(groupId, userId) ? [{ group_id: groupId, user_id: userId }] : [] }
    }
    if (sql.includes('gscope.group_id')) return { rows: state.groups }
    return { rows: [], rowCount: 0 }
  })
  mocks.transaction.mockImplementation(async (work: (client: { query: typeof mocks.query }) => Promise<unknown>) => {
    const saved = { users: state.users, memberships: state.memberships }
    state.events.push('BEGIN')
    try {
      const result = await work({ query: mocks.query })
      state.events.push('COMMIT_CONFIRMED')
      return result
    } catch (error) {
      state.events.push('ROLLBACK_ATTEMPT')
      state.users = saved.users
      state.memberships = saved.memberships
      throw error
    }
  })
})

describe('role delegation namespace admission platform arm', () => {
  it('writes one raw-admin admission without a child lock or a pre-root role read', async () => {
    await writeRoleDelegationNamespaceAdmissionCommand(admissionInput())
    const plan = planOf()
    expect(plan).toEqual({
      intent: 'SET_ADMISSION',
      roleIds: [],
      userIds: ['actor', 'target'],
      admissionUserIds: ['actor', 'target'],
      witness: { userIds: ['actor', 'target'], admissionUserIds: ['actor', 'target'] },
    })
    expect(plan.userIds).toBe(plan.admissionUserIds)
    expect(plan.witness?.userIds).toBe(plan.userIds)
    expect(plan.witness?.admissionUserIds).toBe(plan.userIds)
    for (const value of [plan, plan.roleIds, plan.userIds, plan.admissionUserIds, plan.witness, plan.witness?.userIds, plan.witness?.admissionUserIds]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    expect(Object.keys(plan).sort()).toEqual(['admissionUserIds', 'intent', 'roleIds', 'userIds', 'witness'])
    const beginAt = state.events.indexOf('BEGIN')
    expect(state.events.slice(0, beginAt).some((sql) => sql.includes('FROM user_roles'))).toBe(false)
    expect(state.events.some((sql) => sql.includes('FROM user_roles'))).toBe(false)
    expect(calls().some(([sql]) => sql.includes(ADMIN_CHILD_SQL))).toBe(false)
    expect(calls().some(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)).toBe(false)
    expect(mocks.entry).toHaveBeenCalledTimes(1)
    expect(mocks.entry.mock.calls[0]?.[2]).toBeUndefined()
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(helper.calls).toHaveLength(1)
    expect(helper.calls[0]?.[0]).toEqual({
      userId: 'target',
      namespace: 'crm',
      enabled: true,
      actorId: 'actor',
      source: 'platform_admin',
    })
    expect(helper.calls[0]?.[1].plan).toBe(plan)
    expect(helper.calls[0]?.[1].world).toBe('shared')
    expect(calls().find(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))?.[1]).toEqual([
      'target', 'crm', true, 'platform_admin', 'actor', 'actor',
    ])
  })

  it('share-locks the admin child for a membership actor and restores the saved timeouts', async () => {
    expect(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS).toBe(5000)
    expect(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS).toBe(10000)
    state.users.set('actor', user('actor', 'user'))
    await writeRoleDelegationNamespaceAdmissionCommand(admissionInput())
    const share = calls().findIndex(([sql]) => sql.includes(ADMIN_CHILD_SQL))
    expect(share).toBeGreaterThan(0)
    expect(calls()[share - 1]?.[1]).toEqual(['5000', '10000'])
    expect(calls()[share + 1]?.[1]).toEqual(['2s', '3s'])
    expect(calls()[share]?.[1]).toEqual(['actor'])
    expect(calls().some(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)).toBe(false)
    expect(roleReads()).toHaveLength(0)
    expect(helper.calls).toHaveLength(1)
    expect(helper.calls[0]?.[1].plan).toBe(planOf())
  })

  it('deduplicates actor and target into one subject', async () => {
    await writeRoleDelegationNamespaceAdmissionCommand(admissionInput({ userId: 'actor' }))
    expect(planOf().userIds).toEqual(['actor'])
    expect(planOf().admissionUserIds).toEqual(['actor'])
    expect(calls().filter(([sql]) => /FROM users/.test(sql) && /FOR UPDATE/.test(sql))).toHaveLength(1)
    expect(calls().some(([sql]) => sql.includes(ADMIN_CHILD_SQL))).toBe(false)
    expect(helper.calls[0]?.[0]).toMatchObject({ userId: 'actor', actorId: 'actor', source: 'platform_admin' })
  })

  it('snapshots scalar inputs before the first await and leaves the caller mutable', async () => {
    const input = admissionInput()
    state.onQuery = () => {
      input.actorId = 'other'
      input.userId = 'other-user'
      input.namespace = 'other'
      input.enabled = false
      input.isPlatformAdmin = false
      state.onQuery = undefined
    }
    await writeRoleDelegationNamespaceAdmissionCommand(input)
    expect(helper.calls[0]?.[0]).toEqual({
      userId: 'target',
      namespace: 'crm',
      enabled: true,
      actorId: 'actor',
      source: 'platform_admin',
    })
    expect(planOf().roleIds).toEqual([])
    input.actorId = 'after'
    expect(input.actorId).toBe('after')
  })

  it('reports a missing target before actor authority and before a corrupt witness', async () => {
    state.users.delete('target')
    state.users.delete('actor')
    state.transform = (tx) => retoken(tx, {
      witnessed: { userIds: new Set<string>(), admissionUserIds: new Set<string>() },
    })
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      name: 'AccessGraphUserUnavailableError',
      code: 'NOT_FOUND',
    })
    expectNoWrite()
  })

  it.each([
    ['deleted', { deleted_at: '2026-01-01' }],
    ['purged', { purged_at: '2026-01-01' }],
  ])('reports a %s target before an inactive actor', async (_label, extra) => {
    state.users.set('target', user('target', 'user', extra))
    state.users.set('actor', user('actor', 'admin', { is_active: false }))
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      code: 'USER_IN_RECYCLE_BIN',
    })
    expect(calls().some(([sql]) => sql.includes(ADMIN_CHILD_SQL))).toBe(false)
    expectNoWrite()
  })

  it.each([
    ['inactive', { is_active: false }],
    ['pending', { activation_status: 'pending' }],
  ])('still writes an %s target', async (_label, extra) => {
    state.users.set('target', user('target', 'user', extra))
    await writeRoleDelegationNamespaceAdmissionCommand(admissionInput())
    expect(helper.calls).toHaveLength(1)
    expect(business()).toHaveLength(1)
  })

  it('refuses a missing, inactive, pending, or purged actor with no DML', async () => {
    for (const extra of [null, { is_active: false }, { activation_status: 'pending' }, { purged_at: '2026-01-01' }]) {
      state.events = []
      helper.calls = []
      mocks.query.mockClear()
      if (extra === null) state.users.delete('actor')
      else state.users.set('actor', user('actor', 'admin', extra))
      await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expectNoWrite()
      expect(calls().some(([sql]) => sql.includes(ADMIN_CHILD_SQL))).toBe(false)
    }
  })

  it('does not treat the target admin membership as the actor edge', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.memberships.set('actor', [])
    state.memberships.set('target', ['admin'])
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      name: 'PlatformActorAuthorityLost',
      code: 'FORBIDDEN',
    })
    expect(calls().filter(([sql]) => sql.includes(ADMIN_CHILD_SQL)).map(([, params]) => params)).toEqual([['actor']])
    expectNoWrite()
  })

  it('rejects an unbranded, closed, wrong-plan, unfrozen, witness-corrupt, extra-parent, or born token before DML', async () => {
    await writeRoleDelegationNamespaceAdmissionCommand(admissionInput())
    const foreign = planOf()
    state.transform = (tx) => ({ ...tx, query: tx.query }) as AuthorizationInputTx
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({ reason: 'unbranded' })
    state.transform = (tx) => {
      const token = { ...tx, query: tx.query }
      mintAuthorizationInputBrand(token, [token]).close()
      return token as AuthorizationInputTx
    }
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({ reason: 'closed' })
    state.transform = (tx) => retoken(tx, { plan: foreign })
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'role_delegation_namespace_admission_context',
    })
    state.transform = (tx) => retoken(tx, {
      plan: {
        intent: 'SET_ADMISSION',
        roleIds: [],
        userIds: ['actor', 'target'],
        admissionUserIds: ['actor', 'target'],
        witness: { userIds: ['actor', 'target'], admissionUserIds: ['actor', 'target'] },
      },
    })
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'role_delegation_namespace_admission_context',
    })
    state.transform = (tx) => retoken(tx, {
      witnessed: { userIds: new Set(['target']), admissionUserIds: new Set(['actor', 'target']) },
    })
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'role_delegation_namespace_admission_context',
    })
    state.transform = (tx) => retoken(tx, { roleRows: new Map([['admin', 'held']]) })
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'role_delegation_namespace_admission_context',
    })
    state.transform = (tx) => retoken(tx, { born: new Set(['actor']) })
    await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'role_delegation_namespace_admission_context',
    })
    expect(helper.calls).toHaveLength(1)
    expect(business()).toHaveLength(1)
  })

  it('skips timeout restore when the admin child share throws', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.fail = 'admin-share'
    try {
      await writeRoleDelegationNamespaceAdmissionCommand(admissionInput())
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'XX000' })
      expect(error).not.toBeInstanceOf(AuthorizationInputBusyError)
    }
    expect(pair('2s', '3s')).toHaveLength(1)
    expect(pair('5000', '10000')).toHaveLength(2)
    expectNoWrite()
    expect(mocks.entry).toHaveBeenCalledTimes(1)
    expect(mocks.entry.mock.calls[0]?.[2]).toBeUndefined()
  })

  it('maps acquisition and awaited-work busy codes once and leaves marker 40001 and XX000 unmapped', async () => {
    async function once(run: () => Promise<void>) {
      helper.calls = []
      state.events = []
      mocks.query.mockClear()
      mocks.entry.mockClear()
      mocks.transaction.mockClear()
      await run()
      expect(mocks.entry).toHaveBeenCalledTimes(1)
      expect(mocks.entry.mock.calls[0]?.[2]).toBeUndefined()
      expect(mocks.transaction).toHaveBeenCalledTimes(1)
      expectNoWrite()
    }

    state.fail = 'user-lock'
    state.errorCode = '55P03'
    await once(() => expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      name: 'AuthorizationInputBusyError',
      busyReason: 'lock_timeout',
    }))

    state.errorCode = '57014'
    await once(() => expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      busyReason: 'statement_timeout',
    }))

    state.users.set('actor', user('actor', 'user'))
    state.fail = 'admin-share'
    state.errorCode = '40P01'
    state.errorMessage = 'deadlock detected'
    await once(async () => {
      await expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({ busyReason: 'deadlock' })
      expect(pair('2s', '3s')).toHaveLength(1)
    })

    state.users.set('actor', user('actor', 'admin'))
    state.fail = 'user-lock'
    state.errorCode = '40001'
    state.errorMessage = 'serialization failure'
    await once(() => expect(writeRoleDelegationNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      busyReason: 'serialization',
    }))

    state.errorMessage = RECOVERY_AUTHORITY_BUSY_MARKER
    await once(async () => {
      try {
        await writeRoleDelegationNamespaceAdmissionCommand(admissionInput())
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).not.toBeInstanceOf(AuthorizationInputBusyError)
        expect(error).toMatchObject({ code: '40001' })
      }
    })

    state.errorCode = 'XX000'
    state.errorMessage = 'fixed SQL failure'
    await once(async () => {
      try {
        await writeRoleDelegationNamespaceAdmissionCommand(admissionInput())
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).not.toBeInstanceOf(AuthorizationInputBusyError)
        expect(error).toMatchObject({ code: 'XX000' })
      }
    })
  })

  it('still calls the helper once when enabled is false', async () => {
    await writeRoleDelegationNamespaceAdmissionCommand(admissionInput({ enabled: false }))
    expect(helper.calls).toHaveLength(1)
    expect(helper.calls[0]?.[0]).toMatchObject({ enabled: false, source: 'platform_admin' })
    expect(calls().find(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))?.[1]).toEqual([
      'target', 'crm', false, 'platform_admin', null, 'actor',
    ])
  })
})

describe('role delegation namespace admission delegated arm', () => {
  beforeEach(() => {
    state.users.set('actor', user('actor', 'user'))
    state.roleIds = ['crm_admin', 'qa_admin']
    state.memberships.set('actor', ['crm_admin', 'qa_admin'])
    state.groups = [{ group_id: 'g1' }]
  })

  it('refuses an empty positive witness even when the earlier and later predicates would both be true', async () => {
    state.allowed = true
    state.finalAllowed = true
    state.seeds = []
    state.secondSeeds = []
    state.groups = []
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
    })
    expect(state.allowedReads).toBe(1)
    expect(state.seedReads).toBe(1)
    expectNoWrite()
  })

  it('uses a UUID array for the unrelated active seed of a group-only witness', async () => {
    state.seeds = [{ id: 'seed', integration_id: '00000000-0000-4000-8000-000000000001', external_department_id: 'seed', include_children: true }]
    state.groups = [{ group_id: 'g1' }]
    const witness = await enumerateScopePathWitness(mocks.query, 'actor', ['crm'], 'target')
    expect(witness).toEqual({ departmentIds: [], memberships: [{ groupId: 'g1', targetUserId: 'target' }] })
    const childQuery = calls().find(([sql]) => sql.includes('child.integration_id = ANY'))
    expect(childQuery?.[0]).toContain('child.integration_id = ANY($1::uuid[])')
    expect(childQuery?.[1]).toEqual([['00000000-0000-4000-8000-000000000001']])
  })

  it('pins canonical deriving children, filters helper namespaces, and writes on a group-only positive witness', async () => {
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    const plan = planOf()
    expect(plan.roleIds).toEqual(['crm_admin', 'qa_admin'])
    expect(plan.userIds).toEqual(['actor', 'target'])
    expect(plan.intent).toBe('SET_ADMISSION')
    expect(Object.isFrozen(plan.roleIds)).toBe(true)
    const beginAt = state.events.indexOf('BEGIN')
    expect(state.events.slice(0, beginAt).filter((sql) => sql.includes('FROM user_roles'))).toHaveLength(1)
    expect(roleReads()).toHaveLength(3)
    expect(calls().find(([sql]) => sql === DERIVING_CHILD_SQL)?.[1]).toEqual(['actor', ['crm_admin', 'qa_admin']])
    const share = calls().findIndex(([sql]) => sql === DERIVING_CHILD_SQL)
    expect(calls()[share - 1]?.[1]).toEqual(['5000', '10000'])
    expect(calls()[share + 1]?.[1]).toEqual(['2s', '3s'])
    expect(calls().filter(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared).map(([, params]) => params)).toEqual([
      ['crm_admin'],
      ['qa_admin'],
    ])
    expect(calls().filter(([sql]) => sql.includes('AS configured')).map(([, params]) => params)).toEqual([
      ['actor', ['crm', 'qa']],
    ])
    expect(calls().filter(([sql]) => sql.includes('AS allowed')).map(([, params]) => params)).toEqual([
      ['actor', ['crm'], 'target'],
      ['actor', ['crm'], 'target'],
    ])
    expect(seedCalls().map(([, params]) => params)).toEqual([
      ['actor', ['crm']],
      ['actor', ['crm']],
    ])
    expect(calls().some(([sql]) => sql === DEPARTMENT_SHARE_SQL)).toBe(false)
    expect(calls().filter(([sql]) => sql === MEMBERSHIP_SHARE_SQL).map(([, params]) => params)).toEqual([['g1', 'target']])
    expect(pair('5000', '10000')).toHaveLength(3)
    expect(pair('2s', '3s')).toHaveLength(3)
    expect(mocks.entry.mock.calls[0]?.[2]).toBeUndefined()
    expect(helper.calls[0]?.[0]).toEqual({
      userId: 'target',
      namespace: 'crm',
      enabled: true,
      actorId: 'actor',
      source: 'delegated_admin',
    })
    expect(helper.calls[0]?.[1].world).toBe('shared')
    expect(helper.calls[0]?.[1].plan).toBe(plan)
    expect(calls().find(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))?.[1]).toEqual([
      'target', 'crm', true, 'delegated_admin', 'actor', 'actor',
    ])
  })

  it('deduplicates a delegated actor and target into one subject', async () => {
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput({ userId: 'actor' }))
    expect(planOf().userIds).toEqual(['actor'])
    expect(calls().filter(([sql]) => /FROM users/.test(sql) && /FOR UPDATE/.test(sql))).toHaveLength(1)
    expect(helper.calls[0]?.[0]).toMatchObject({ userId: 'actor', actorId: 'actor', source: 'delegated_admin' })
  })

  it.each([
    ['inactive', { is_active: false }],
    ['pending', { activation_status: 'pending' }],
  ])('still writes an %s delegated target', async (_label, extra) => {
    state.users.set('target', user('target', 'user', extra))
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    expect(helper.calls).toHaveLength(1)
    expect(business()).toHaveLength(1)
  })

  it.each([
    ['deleted', { deleted_at: '2026-01-01' }],
    ['purged', { purged_at: '2026-01-01' }],
  ])('reports a %s delegated target before an inactive actor and before the child pin', async (_label, extra) => {
    state.users.set('target', user('target', 'user', extra))
    state.users.set('actor', user('actor', 'user', { is_active: false }))
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'USER_IN_RECYCLE_BIN',
    })
    expect(calls().some(([sql]) => sql === DERIVING_CHILD_SQL)).toBe(false)
    expectNoWrite()
  })

  it('snapshots delegated scalars before the discovery read', async () => {
    const input = delegatedInput()
    state.onQuery = () => {
      input.actorId = 'other'
      input.userId = 'other-user'
      input.namespace = 'other'
      input.enabled = false
      input.isPlatformAdmin = true
      state.onQuery = undefined
    }
    await writeRoleDelegationNamespaceAdmissionCommand(input)
    expect(roleReads()[0]?.[1]).toEqual(['actor'])
    expect(planOf().roleIds).toEqual(['crm_admin', 'qa_admin'])
    expect(helper.calls[0]?.[0]).toEqual({
      userId: 'target',
      namespace: 'crm',
      enabled: true,
      actorId: 'actor',
      source: 'delegated_admin',
    })
    input.namespace = 'after'
    expect(input.namespace).toBe('after')
  })

  it('rejects a noncanonical deriving id before the root', async () => {
    state.roleIds = ['crm_admin', ' qa_admin']
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'AUTHORIZATION_INPUT_PLAN_STALE',
      reason: 'deriving_role_noncanonical',
    })
    expect(mocks.entry).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expectNoWrite()
  })

  it('treats an added canonical deriving id as a stale set', async () => {
    state.roleIds = ['crm_admin']
    state.roleIdsAfterChildShare = ['crm_admin', 'qa_admin']
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'AUTHORIZATION_INPUT_PLAN_STALE',
      reason: 'deriving_role_set',
    })
    expect(calls().filter(([sql]) => sql.includes('AS configured'))).toHaveLength(1)
    expect(seedCalls()).toHaveLength(0)
    expectNoWrite()
  })

  it('treats removal of an unrequested deriving id as a stale set', async () => {
    state.roleIdsAfterChildShare = ['crm_admin']
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      reason: 'deriving_role_set',
    })
    expectNoWrite()
  })

  it('treats substitution of an unrequested deriving id as a stale set', async () => {
    state.roleIds = ['crm_admin', 'qa_admin']
    state.roleIdsAfterChildShare = ['crm_admin', 'billing_admin']
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      reason: 'deriving_role_set',
    })
    expectNoWrite()
  })

  it.each([
    { remaining: [] },
    { remaining: ['qa_admin'] },
  ])('refuses lost authority for the requested namespace with remaining roles $remaining', async ({ remaining }) => {
    state.roleIds = ['crm_admin']
    state.roleIdsAfterChildShare = remaining
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      name: 'DelegationAuthorityRefusal',
      code: 'ROLE_DELEGATION_FORBIDDEN',
    })
    expect(seedCalls()).toHaveLength(0)
    expectNoWrite()
  })

  it('enforces a stored delegation stop during the locked recheck with the rollout off', async () => {
    vi.stubEnv('DELEGATED_SCOPE_ACTIVATION_ENABLED', 'false')
    try {
      state.disabledNamespaces = ['crm']
      await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
        name: 'DelegationAuthorityRefusal',
        code: 'ROLE_DELEGATION_FORBIDDEN',
      })
      const children = calls().findIndex(([sql]) => sql === DERIVING_CHILD_SQL)
      const activation = calls().findIndex(([sql]) => sql.includes('FROM delegated_role_admin_activation'))
      expect(children).toBeGreaterThanOrEqual(0)
      expect(activation).toBeGreaterThan(children)
      expect(calls()[activation]?.[1]).toEqual(['actor', ['crm', 'qa']])
      expect(seedCalls()).toHaveLength(0)
      expectNoWrite()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('preserves the scope refusal when the actor also loses an unrelated deriving role', async () => {
    state.roleIdsAfterChildShare = ['crm_admin']
    state.configured = false
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      name: 'DelegationAuthorityRefusal',
      code: 'ROLE_DELEGATION_SCOPE_REQUIRED',
    })
    expect(seedCalls()).toHaveLength(0)
    expectNoWrite()
  })

  it('treats a newly appeared noncanonical deriving id as stale', async () => {
    state.roleIds = ['crm_admin']
    state.roleIdsAfterChildShare = ['crm_admin', ' qa_admin']
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'AUTHORIZATION_INPUT_PLAN_STALE',
      reason: 'deriving_role_noncanonical',
    })
    expect(mocks.entry).toHaveBeenCalledTimes(1)
    expectNoWrite()
  })

  it('accepts reordered raw deriving ids', async () => {
    state.roleIds = ['qa_admin', 'crm_admin']
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    expect(planOf().roleIds).toEqual(['crm_admin', 'qa_admin'])
    expect(helper.calls).toHaveLength(1)
  })

  it('ignores unrelated non-deriving drift', async () => {
    state.roleIds = ['crm_operator', 'crm_admin']
    state.roleIdsAfterChildShare = ['sales_reader', 'crm_admin', 'crm_operator']
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    expect(planOf().roleIds).toEqual(['crm_admin'])
    expect(calls().find(([sql]) => sql === DERIVING_CHILD_SQL)?.[1]).toEqual(['actor', ['crm_admin']])
    expect(helper.calls).toHaveLength(1)
  })

  it('does not parent admin or a spaced non-deriving id', async () => {
    state.roleIds = ['admin', 'crm_admin', ' crm_operator']
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    expect(planOf().roleIds).toEqual(['crm_admin'])
    expect(helper.calls).toHaveLength(1)
  })

  it('writes when the kernel role row is missing', async () => {
    state.missingParents = true
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    expect(calls().filter(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared).map(([, params]) => params?.[0])).toEqual([
      'crm_admin',
      'qa_admin',
    ])
    expect(helper.calls).toHaveLength(1)
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).resolves.toBeUndefined()
  })

  it('issues no child share for an empty deriving set and then refuses', async () => {
    state.roleIds = ['admin', 'crm_operator']
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'ROLE_DELEGATION_FORBIDDEN',
    })
    expect(calls().some(([sql]) => sql === DERIVING_CHILD_SQL)).toBe(false)
    expect(pair('5000', '10000')).toHaveLength(1)
    expect(pair('2s', '3s')).toHaveLength(1)
    expect(seedCalls()).toHaveLength(0)
    expect(roleReads().map(([, params]) => params)).toEqual([['actor'], ['actor'], ['actor']])
    expectNoWrite()
  })

  it('skips child-window restore when the deriving share throws a non-busy error', async () => {
    state.fail = 'deriving-share'
    try {
      await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'XX000' })
      expect(error).not.toBeInstanceOf(AuthorizationInputBusyError)
    }
    expect(pair('2s', '3s')).toHaveLength(1)
    expect(pair('5000', '10000')).toHaveLength(2)
    expectNoWrite()
  })

  it('classifies an injected deriving-child 40P01 as deadlock without a physical cycle', async () => {
    state.fail = 'deriving-share'
    state.errorCode = '40P01'
    state.errorMessage = 'deadlock detected'
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      name: 'AuthorizationInputBusyError',
      busyReason: 'deadlock',
    })
    expect(pair('2s', '3s')).toHaveLength(1)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expectNoWrite()
  })

  it('shares no department row for a group-only witness', async () => {
    state.groups = [{ group_id: 'g2' }, { group_id: 'g1' }]
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    expect(calls().some(([sql]) => sql === DEPARTMENT_SHARE_SQL)).toBe(false)
    expect(calls().filter(([sql]) => sql.includes('external_parent_department_id') && !sql.includes('WITH RECURSIVE'))).toHaveLength(0)
    expect(calls().filter(([sql]) => sql.includes("link_status = 'linked'") && !sql.includes('WITH RECURSIVE'))).toHaveLength(0)
    expect(calls().filter(([sql]) => sql === MEMBERSHIP_SHARE_SQL).map(([, params]) => params)).toEqual([
      ['g1', 'target'],
      ['g2', 'target'],
    ])
    expect(pair('5000', '10000')).toHaveLength(3)
    expect(pair('2s', '3s')).toHaveLength(3)
  })

  it('shares every successful path node and not the side branch', async () => {
    usePath()
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    expect(calls().filter(([sql]) => sql === DEPARTMENT_SHARE_SQL).map(([, params]) => params)).toEqual([
      ['mid'],
      ['p1'],
      ['z-leaf'],
    ])
    expect(calls().some(([sql]) => sql === MEMBERSHIP_SHARE_SQL)).toBe(false)
    expect(calls().some(([, params]) => params?.[0] === 'side')).toBe(false)
  })

  it('shares sorted departments then sorted groups for a mixed witness', async () => {
    usePath()
    state.groups = [{ group_id: 'g2' }, { group_id: 'g1' }]
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())
    const shares = calls().filter(([sql]) => sql === DEPARTMENT_SHARE_SQL || sql === MEMBERSHIP_SHARE_SQL)
    expect(shares.map(([sql, params]) => [sql, params])).toEqual([
      [DEPARTMENT_SHARE_SQL, ['mid']],
      [DEPARTMENT_SHARE_SQL, ['p1']],
      [DEPARTMENT_SHARE_SQL, ['z-leaf']],
      [MEMBERSHIP_SHARE_SQL, ['g1', 'target']],
      [MEMBERSHIP_SHARE_SQL, ['g2', 'target']],
    ])
    expect(pair('5000', '10000')).toHaveLength(3)
    expect(pair('2s', '3s')).toHaveLength(3)
  })

  it('refuses a missing department row without restore or a second lock', async () => {
    usePath()
    state.departmentHeld = () => false
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
    })
    expect(calls().filter(([sql]) => sql === DEPARTMENT_SHARE_SQL).map(([, params]) => params)).toEqual([['mid']])
    expect(calls().some(([sql]) => sql === MEMBERSHIP_SHARE_SQL)).toBe(false)
    expect(pair('5000', '10000')).toHaveLength(3)
    expect(pair('2s', '3s')).toHaveLength(2)
    expectNoWrite()
  })

  it('refuses a re-enumerated addition and does not share the new key', async () => {
    state.seeds = [{ id: 'a', integration_id: 'i', external_department_id: 'a', include_children: true }]
    state.secondSeeds = [
      { id: 'a', integration_id: 'i', external_department_id: 'a', include_children: true },
      { id: 'z', integration_id: 'i', external_department_id: 'z', include_children: true },
    ]
    state.leaves = [{ id: 'a' }, { id: 'z' }]
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
    })
    expect(calls().filter(([sql]) => sql === DEPARTMENT_SHARE_SQL).map(([, params]) => params)).toEqual([['a']])
    expectNoWrite()
  })

  it('refuses when the original predicate becomes false after re-enumeration', async () => {
    state.finalAllowed = false
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
    })
    expect(calls().filter(([sql]) => sql.includes('AS configured'))).toHaveLength(1)
    expect(calls().filter(([sql]) => sql.includes('AS allowed'))).toHaveLength(2)
    expectNoWrite()
  })

  it('still calls the delegated helper once when enabled is false', async () => {
    await writeRoleDelegationNamespaceAdmissionCommand(delegatedInput({ enabled: false }))
    expect(helper.calls).toHaveLength(1)
    expect(helper.calls[0]?.[0]).toMatchObject({ enabled: false, source: 'delegated_admin' })
    expect(calls().find(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))?.[1]).toEqual([
      'target', 'crm', false, 'delegated_admin', null, 'actor',
    ])
  })

  it('pins deriving children before an inactive actor is refused', async () => {
    state.users.set('actor', user('actor', 'user', { is_active: false }))
    await expect(writeRoleDelegationNamespaceAdmissionCommand(delegatedInput())).rejects.toMatchObject({
      code: 'ROLE_DELEGATION_FORBIDDEN',
    })
    expect(calls().some(([sql]) => sql === DERIVING_CHILD_SQL)).toBe(true)
    expect(calls().some(([sql]) => sql.includes('AS configured'))).toBe(false)
    expectNoWrite()
  })
})

type GraphDepartment = {
  id: string
  integrationId: string | null
  externalDepartmentId: string | null
  externalParentDepartmentId: string | null
  active: boolean
}

type GraphModel = {
  departments: GraphDepartment[]
  assignments: Array<{ departmentId: string; namespace: string; includeChildren: boolean | null }>
  leafIds: string[]
  groupIds: string[]
}

function dept(
  id: string,
  external: string,
  parent: string | null,
  active = true,
  integrationId: string | null = 'i',
): GraphDepartment {
  return { id, integrationId, externalDepartmentId: external, externalParentDepartmentId: parent, active }
}

function graphQuery(model: GraphModel) {
  const seen: string[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('bool_or')) {
      seen.push('seed')
      const namespaces = params[1] as string[]
      const grouped = new Map<string, { department: GraphDepartment; include: boolean }>()
      for (const assignment of model.assignments) {
        if (!namespaces.includes(assignment.namespace)) continue
        const department = model.departments.find((item) => item.id === assignment.departmentId)
        if (!department?.active) continue
        const flag = assignment.includeChildren == null ? true : assignment.includeChildren === true
        const current = grouped.get(department.id)
        if (current) current.include = current.include || flag
        else grouped.set(department.id, { department, include: flag })
      }
      return {
        rows: [...grouped.values()].map(({ department, include }) => ({
          id: department.id,
          integration_id: department.integrationId,
          external_department_id: department.externalDepartmentId,
          include_children: include,
        })),
      }
    }
    if (sql.includes('external_parent_department_id')) {
      seen.push('child')
      const integrationIds = params[0] as string[]
      return {
        rows: model.departments
          .filter((item) => item.active && item.integrationId !== null && integrationIds.includes(item.integrationId))
          .map((item) => ({
            id: item.id,
            integration_id: item.integrationId,
            external_department_id: item.externalDepartmentId,
            external_parent_department_id: item.externalParentDepartmentId,
          })),
      }
    }
    if (sql.includes("link_status = 'linked'")) {
      seen.push('leaf')
      return { rows: model.leafIds.map((id) => ({ id })) }
    }
    if (sql.includes('gscope.group_id')) {
      seen.push('group')
      return { rows: model.groupIds.map((group_id) => ({ group_id })) }
    }
    seen.push('other')
    return { rows: [] }
  }
  return { seen, query }
}

async function runGraph(model: GraphModel, namespaces: readonly string[] = ['crm']) {
  const probe = graphQuery(model)
  const witness = await enumerateScopePathWitness(probe.query, 'actor', namespaces, 'target')
  return { witness, seen: probe.seen }
}

describe('delegated scope path witness', () => {
  it('keeps a false seed that is itself the leaf and drops its descendant', async () => {
    const { witness } = await runGraph({
      departments: [dept('f', 'F', null), dept('c', 'C', 'F')],
      assignments: [{ departmentId: 'f', namespace: 'crm', includeChildren: false }],
      leafIds: ['f', 'c'],
      groupIds: [],
    })
    expect(witness.departmentIds).toEqual(['f'])
  })

  it('drops a false seed that is not a matching leaf', async () => {
    const { witness } = await runGraph({
      departments: [dept('f', 'F', null), dept('c', 'C', 'F')],
      assignments: [{ departmentId: 'f', namespace: 'crm', includeChildren: false }],
      leafIds: ['c'],
      groupIds: [],
    })
    expect(witness.departmentIds).toEqual([])
  })

  it('coalesces a null include flag to true and keeps descendants', async () => {
    const { witness } = await runGraph({
      departments: [dept('seed', 'S', null), dept('leaf', 'L', 'S')],
      assignments: [{ departmentId: 'seed', namespace: 'crm', includeChildren: null }],
      leafIds: ['leaf'],
      groupIds: [],
    })
    expect(witness.departmentIds).toEqual(['leaf', 'seed'])
  })

  it('excludes an archived ancestor above an independent seed', async () => {
    const { witness } = await runGraph({
      departments: [dept('archived', 'ROOT', null, false), dept('seed', 'S', 'ROOT'), dept('leaf', 'L', 'S')],
      assignments: [{ departmentId: 'seed', namespace: 'crm', includeChildren: true }],
      leafIds: ['leaf'],
      groupIds: [],
    })
    expect(witness.departmentIds).toEqual(['leaf', 'seed'])
  })

  it('keeps both alternate parents and excludes the side branch', async () => {
    const { witness } = await runGraph({
      departments: [
        dept('p1', 'E', null),
        dept('p2', 'E', null),
        dept('leaf', 'L', 'E'),
        dept('side', 'S', 'E'),
      ],
      assignments: [
        { departmentId: 'p1', namespace: 'crm', includeChildren: true },
        { departmentId: 'p2', namespace: 'crm', includeChildren: true },
      ],
      leafIds: ['leaf'],
      groupIds: ['g9'],
    })
    expect(witness.departmentIds).toEqual(['leaf', 'p1', 'p2'])
    expect(witness.memberships).toEqual([{ groupId: 'g9', targetUserId: 'target' }])
    expect(Object.isFrozen(witness)).toBe(true)
    expect(Object.isFrozen(witness.departmentIds)).toBe(true)
    expect(Object.isFrozen(witness.memberships)).toBe(true)
    expect(Object.isFrozen(witness.memberships[0])).toBe(true)
  })

  it('keeps seed and intermediate nodes, not the leaf alone', async () => {
    const { witness, seen } = await runGraph({
      departments: [
        dept('p1', 'E', null),
        dept('mid', 'M', 'E'),
        dept('leaf', 'L', 'M'),
        dept('side', 'S', 'E'),
      ],
      assignments: [{ departmentId: 'p1', namespace: 'crm', includeChildren: true }],
      leafIds: ['leaf'],
      groupIds: [],
    })
    expect(witness.departmentIds).toEqual(['leaf', 'mid', 'p1'])
    expect(seen).toEqual(['seed', 'child', 'leaf', 'group'])
  })

  it('terminates a cycle and keeps both cycle nodes when the seed is the leaf', async () => {
    const { witness } = await runGraph({
      departments: [dept('a', 'A', 'B'), dept('b', 'B', 'A')],
      assignments: [{ departmentId: 'a', namespace: 'crm', includeChildren: true }],
      leafIds: ['a'],
      groupIds: [],
    })
    expect(witness.departmentIds).toEqual(['a', 'b'])
  })

  it('returns a frozen empty witness without queries when namespaces are empty', async () => {
    const witness = await enumerateScopePathWitness(async () => {
      throw new Error('queried')
    }, 'actor', [], 'target')
    expect(witness).toEqual({ departmentIds: [], memberships: [] })
    expect(Object.isFrozen(witness)).toBe(true)
    expect(Object.isFrozen(witness.departmentIds)).toBe(true)
    expect(Object.isFrozen(witness.memberships)).toBe(true)
  })

  it('skips child and leaf queries for a group-only witness', async () => {
    const { witness, seen } = await runGraph({
      departments: [],
      assignments: [],
      leafIds: ['leaf'],
      groupIds: ['g2', 'g1'],
    })
    expect(seen).toEqual(['seed', 'group'])
    expect(witness).toEqual({
      departmentIds: [],
      memberships: [
        { groupId: 'g1', targetUserId: 'target' },
        { groupId: 'g2', targetUserId: 'target' },
      ],
    })
  })

  it('compares two enumerations symmetrically', async () => {
    const model: GraphModel = {
      departments: [dept('p1', 'E', null), dept('leaf', 'L', 'E')],
      assignments: [{ departmentId: 'p1', namespace: 'crm', includeChildren: true }],
      leafIds: ['leaf'],
      groupIds: [],
    }
    const left = await runGraph(model)
    const right = await runGraph(model)
    expect(sameScopePathWitness(left.witness, right.witness)).toBe(true)
    const emptied = await runGraph({ ...model, leafIds: [] })
    expect(sameScopePathWitness(left.witness, emptied.witness)).toBe(false)
    expect(sameScopePathWitness(
      { departmentIds: ['a', 'b'], memberships: [] },
      { departmentIds: ['b', 'a'], memberships: [] },
    )).toBe(false)
  })
})

describe('role delegation namespace admission keeps the extracted boundary', () => {
  const command = readFileSync(new URL('../../src/admin/role-delegation-namespace-admission-command.ts', import.meta.url), 'utf8')
  const authority = readFileSync(new URL('../../src/admin/delegated-authority.ts', import.meta.url), 'utf8')
  const witness = readFileSync(new URL('../../src/admin/delegated-scope-witness.ts', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../../src/routes/admin-users.ts', import.meta.url), 'utf8')
  const lock = readFileSync(new URL('../../src/rbac/authorization-input-lock.ts', import.meta.url), 'utf8')

  it('copies no DML and leaves W-16 pending', () => {
    expect(command).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/)
    expect(command).not.toContain('finally')
    expect(command).not.toContain('assertPlatformActorAuthority')
    expect(command).not.toContain('tx.acquire')
    expect(command).not.toContain('identityRead')
    expect(command).not.toContain('lockSharedAccessSubjects')
    expect(command.split('await writeUserNamespaceAdmission').length - 1).toBe(1)
    expect(command.split('withAuthorizationInputTransaction(').length - 1).toBe(1)
    expect(command).toContain('await withAuthorizationInputTransaction(plan, async (tx) => {')
    expect(command.match(/from '\.\.\/rbac\/authorization-input-brand'/g)).toHaveLength(1)
    expect(command.match(/from '\.\.\/rbac\/authorization-input-lock'/g)).toHaveLength(2)
    expect(command).toContain(DERIVING_CHILD_SQL)
    expect(command).toContain(DEPARTMENT_SHARE_SQL)
    expect(command).toContain(MEMBERSHIP_SHARE_SQL)
    expect(command).toContain(ADMIN_CHILD_SQL)
    expect(witness).not.toContain('authorization-input-')
    expect(witness).not.toContain('FOR SHARE')
    expect(witness).toContain('bool_or(COALESCE(s.include_children, TRUE))')
    expect(authority).not.toContain('authorization-input-')
    const writer = AUTHORIZATION_INPUT_WRITERS.find((entry) => entry.id === 'W-16')
    expect(writer).toMatchObject({
      status: 'pending',
      symbol: 'writeUserNamespaceAdmission',
      file: 'packages/core-backend/src/rbac/namespace-admission.ts',
    })
  })

  it('preserves the five helper texts, messages, and the shared constructor', () => {
    const fetchSql = [
      'SELECT role_id',
      '     FROM user_roles',
      '     WHERE user_id = $1',
      '     ORDER BY role_id ASC',
    ].join('\n')
    const scopeSql = [
      'WITH RECURSIVE seed_departments AS (',
      '        SELECT d.id,',
      '               d.integration_id,',
      '               d.external_department_id,',
      '               bool_or(COALESCE(s.include_children, TRUE)) AS include_children',
      '        FROM delegated_role_admin_scopes s',
      '        JOIN directory_departments d ON d.id = s.directory_department_id',
      '        WHERE s.admin_user_id = $1',
      '          AND s.namespace = ANY($2::text[])',
      '          AND d.is_active = true',
      '        GROUP BY d.id, d.integration_id, d.external_department_id',
      '      ),',
      '      allowed_departments AS (',
      '        SELECT id, integration_id, external_department_id, include_children',
      '        FROM seed_departments',
      '        UNION',
      '        SELECT child.id, child.integration_id, child.external_department_id, TRUE AS include_children',
      '        FROM directory_departments child',
      '        JOIN allowed_departments parent',
      '         ON child.integration_id = parent.integration_id',
      '         AND child.external_parent_department_id = parent.external_department_id',
      '        WHERE parent.include_children IS TRUE',
      '          AND child.is_active = true',
      '      ),',
      '      allowed_groups AS (',
      '        SELECT DISTINCT gscope.group_id',
      '        FROM delegated_role_admin_member_groups gscope',
      '        WHERE gscope.admin_user_id = $1',
      '          AND gscope.namespace = ANY($2::text[])',
      '      )',
      '      SELECT EXISTS (',
      '        SELECT 1',
      '        FROM directory_account_links l',
      '        JOIN directory_accounts a',
      '          ON a.id = l.directory_account_id',
      '         AND a.is_active = true',
      '        JOIN directory_account_departments ad',
      '          ON ad.directory_account_id = a.id',
      '        JOIN allowed_departments scoped',
      '          ON scoped.id = ad.directory_department_id',
      '        WHERE l.local_user_id = $3',
      '          AND l.link_status = \'linked\'',
      '        UNION',
      '        SELECT 1',
      '        FROM platform_member_group_members gm',
      '        JOIN allowed_groups scoped_groups',
      '          ON scoped_groups.group_id = gm.group_id',
      '        WHERE gm.user_id = $3',
      '      ) AS allowed',
    ].join('\n')
    const audienceSql = [
      'SELECT EXISTS (',
      '       SELECT 1 FROM delegated_role_admin_scopes WHERE admin_user_id = $1 AND namespace = ANY($2::text[])',
      '       UNION ALL',
      '       SELECT 1 FROM delegated_role_admin_member_groups WHERE admin_user_id = $1 AND namespace = ANY($2::text[])',
      '     ) AS configured',
    ].join('\n')
    expect(authority).toContain(fetchSql)
    const audience = readFileSync(new URL('../../src/admin/authorization-operation-audience.ts', import.meta.url), 'utf8')
    expect(audience).toContain(scopeSql)
    expect(authority).toContain('return checkDelegatedAudience(adminUserId, namespaces, userId, runQuery)')
    expect(authority).toContain(audienceSql)
    expect(authority.split('export async function fetchUserRoleIds').length - 1).toBe(1)
    expect(authority.split('export function deriveDelegableNamespaces').length - 1).toBe(1)
    expect(authority.split('export async function isUserWithinDelegatedScope').length - 1).toBe(1)
    expect(authority.split('export async function recheckDelegatedAuthority').length - 1).toBe(1)
    expect(authority.split('export class DelegationAuthorityRefusal').length - 1).toBe(1)
    expect(new DelegationAuthorityRefusal('ROLE_DELEGATION_FORBIDDEN').message).toBe('Namespace is outside your delegated admin scope')
    expect(new DelegationAuthorityRefusal('ROLE_DELEGATION_SCOPE_REQUIRED').message).toBe('No delegated department or member-group scope is configured for your plugin admin role')
    expect(new DelegationAuthorityRefusal('ROLE_DELEGATION_USER_OUT_OF_SCOPE').message).toBe('User is outside your delegated department or member-group scope')
    expect(deriveDelegableNamespaces(['qa_admin', 'crm_admin', 'admin', 'nope', ' qa_admin'])).toEqual(['crm', 'qa'])
  })

  it('keeps the route call, the one lock import, and the share-intent literal', () => {
    expect(route).toContain("from '../admin/delegated-authority'")
    expect(route).toContain('await writeRoleDelegationNamespaceAdmissionCommand({')
    expect(route).toContain('isPlatformAdmin: delegation.isPlatformAdmin,')
    expect(route).toContain('const namespaces = await recheckDelegatedAuthority(')
    expect(route).not.toContain('class DelegationAuthorityRefusal')
    expect(route).not.toContain('function fetchUserRoleIds')
    expect(route).not.toContain('function deriveDelegableNamespaces')
    expect(route).not.toContain('async function isUserWithinDelegatedScope')
    expect(route).not.toContain('async function recheckDelegatedAuthority')
    expect(route.match(/from '\.\.\/rbac\/authorization-input-lock'/g)).toHaveLength(1)
    expect(route.split('\n').filter(line => line.includes("from '../rbac/authorization-input-brand'"))).toEqual([
      "import { AuthorizationInputContractError } from '../rbac/authorization-input-brand'",
    ])
    expect(lock).toContain("const ROLE_ROW_SHARE_INTENTS: ReadonlySet<AuthorizationInputIntent> = new Set(['AUTHORIZATION_OPERATION', 'GRANT_ROLE', 'REVOKE_ROLE', 'SET_ADMIN_PROFILE', 'SET_DELEGATED_SCOPE', 'SET_ADMISSION', 'BIRTH', 'PROJECTION_GRANT', 'CONSUME_CLASS_DECISION'])")
  })
})
