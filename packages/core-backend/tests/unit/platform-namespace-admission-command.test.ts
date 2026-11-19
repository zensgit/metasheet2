import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  memberships: new Map<string, string[]>(),
  events: [] as string[],
  fail: '',
  errorCode: 'XX000',
  errorMessage: 'fixed SQL failure',
  onQuery: undefined as (() => void) | undefined,
  transform: undefined as ((tx: AuthorizationInputTx) => AuthorizationInputTx) | undefined,
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

import { writePlatformNamespaceAdmissionCommand } from '../../src/admin/platform-namespace-admission-command'
import { AuthorizationInputBusyError, AUTHORIZATION_INPUT_STATEMENTS } from '../../src/rbac/authorization-input-lock'
import { AUTHORIZATION_INPUT_WRITERS } from '../../src/rbac/authorization-input-writers'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

const calls = () => mocks.query.mock.calls as Array<[string, unknown[]?]>
const business = () => state.events.filter((sql) => sql.includes('INSERT INTO user_namespace_admissions'))
const planOf = () => mocks.entry.mock.calls.at(-1)?.[0] as AuthorizationInputPlan
const admissionInput = (patch: Record<string, unknown> = {}) => ({
  actorId: 'actor',
  userId: 'target',
  namespace: 'crm',
  enabled: true,
  ...patch,
})

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
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    state.events.push(text)
    state.onQuery?.()
    if (state.fail === 'user-lock' && /FROM users/.test(sql) && /FOR UPDATE/.test(sql)) {
      throw Object.assign(new Error(state.errorMessage), { code: state.errorCode })
    }
    if (state.fail === 'admin-share' && sql.includes("role_id = 'admin' FOR SHARE")) {
      throw Object.assign(new Error(state.errorMessage), { code: state.errorCode })
    }
    if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '2s', statement_timeout: '3s' }] }
    if (sql.includes('set_config')) return { rows: [] }
    if (/FROM users/.test(sql) && /FOR UPDATE/.test(sql)) {
      const row = state.users.get(String(params?.[0]))
      return { rows: row ? [row] : [] }
    }
    if (sql.includes("role_id = 'admin' FOR SHARE")) {
      const held = (state.memberships.get(String(params?.[0])) ?? []).includes('admin')
      return { rows: held ? [{ role_id: 'admin' }] : [] }
    }
    return { rows: [], rowCount: 0 }
  })
  mocks.transaction.mockImplementation(async (work: (client: { query: typeof mocks.query }) => Promise<unknown>) => {
    const saved = {
      users: state.users,
      memberships: state.memberships,
    }
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

describe('platform namespace admission command through the real default root', () => {
  it('writes one raw-admin admission on the branded token without a child or role-parent lock', async () => {
    await writePlatformNamespaceAdmissionCommand(admissionInput())
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
    expect(calls().some(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(false)
    expect(calls().some(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)).toBe(false)
    expect(calls().some(([sql]) => sql.includes('user-recycle:platform-admin'))).toBe(false)
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
    const client = helper.calls[0]?.[1]
    expect(client?.plan).toBe(plan)
    expect(client?.world).toBe('shared')
    expect(calls().find(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))?.[1]).toEqual([
      'target', 'crm', true, 'platform_admin', 'actor', 'actor',
    ])
    const worldAt = calls().findIndex(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.worldShared)
    const admissionAt = calls().findIndex(([, params]) => params?.[0] === 'namespace-admission:actor')
    const userAt = calls().findIndex(([sql]) => /FROM users/.test(sql) && /FOR UPDATE/.test(sql))
    const insertAt = calls().findIndex(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))
    expect(worldAt).toBeGreaterThanOrEqual(0)
    expect(admissionAt).toBeGreaterThan(worldAt)
    expect(userAt).toBeGreaterThan(admissionAt)
    expect(insertAt).toBeGreaterThan(userAt)
    expect(calls().filter(([, params]) => String(params?.[0] ?? '').startsWith('namespace-admission:')).map(([, params]) => params)).toEqual([
      ['namespace-admission:actor'],
      ['namespace-admission:target'],
    ])
  })

  it('share-locks the admin child for a membership actor and restores the saved timeouts', async () => {
    state.users.set('actor', user('actor', 'user'))
    await writePlatformNamespaceAdmissionCommand(admissionInput())
    const share = calls().findIndex(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))
    expect(share).toBeGreaterThan(0)
    expect(calls()[share - 1]?.[1]).toEqual(['5000', '10000'])
    expect(calls()[share + 1]?.[1]).toEqual(['2s', '3s'])
    expect(calls()[share]?.[1]).toEqual(['actor'])
    expect(calls().some(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)).toBe(false)
    expect(helper.calls).toHaveLength(1)
    expect(helper.calls[0]?.[1].plan).toBe(planOf())
  })

  it('deduplicates actor and target into one subject', async () => {
    await writePlatformNamespaceAdmissionCommand(admissionInput({ userId: 'actor' }))
    expect(planOf().userIds).toEqual(['actor'])
    expect(planOf().admissionUserIds).toEqual(['actor'])
    expect(planOf().witness).toEqual({ userIds: ['actor'], admissionUserIds: ['actor'] })
    expect(calls().filter(([sql]) => /FROM users/.test(sql) && /FOR UPDATE/.test(sql))).toHaveLength(1)
    expect(calls().some(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(false)
    expect(helper.calls[0]?.[0]).toMatchObject({ userId: 'actor', actorId: 'actor' })
  })

  it('snapshots scalar inputs before the first await and leaves the caller mutable', async () => {
    const input = admissionInput()
    state.onQuery = () => {
      input.actorId = 'other'
      input.userId = 'other-user'
      input.namespace = 'other'
      input.enabled = false
      state.onQuery = undefined
    }
    await writePlatformNamespaceAdmissionCommand(input)
    expect(helper.calls[0]?.[0]).toEqual({
      userId: 'target',
      namespace: 'crm',
      enabled: true,
      actorId: 'actor',
      source: 'platform_admin',
    })
    expect(calls().find(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))?.[1]).toEqual([
      'target', 'crm', true, 'platform_admin', 'actor', 'actor',
    ])
    input.actorId = 'after'
    expect(input.actorId).toBe('after')
  })

  it('reports a missing target before actor authority and before a corrupt witness', async () => {
    state.users.delete('target')
    state.users.delete('actor')
    state.transform = (tx) => retoken(tx, {
      witnessed: { userIds: new Set<string>(), admissionUserIds: new Set<string>() },
    })
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      name: 'AccessGraphUserUnavailableError',
      code: 'NOT_FOUND',
    })
    expect(business()).toEqual([])
    expect(helper.calls).toEqual([])
  })

  it.each([
    ['deleted', { deleted_at: '2026-01-01' }],
    ['purged', { purged_at: '2026-01-01' }],
  ])('reports a %s target before an inactive actor', async (_label, extra) => {
    state.users.set('target', user('target', 'user', extra))
    state.users.set('actor', user('actor', 'admin', { is_active: false }))
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      code: 'USER_IN_RECYCLE_BIN',
    })
    expect(business()).toEqual([])
    expect(helper.calls).toEqual([])
  })

  it.each([
    ['inactive', { is_active: false }],
    ['pending', { activation_status: 'pending' }],
  ])('still writes an %s target', async (_label, extra) => {
    state.users.set('target', user('target', 'user', extra))
    await writePlatformNamespaceAdmissionCommand(admissionInput())
    expect(helper.calls).toHaveLength(1)
    expect(business()).toHaveLength(1)
  })

  it('refuses a missing, inactive, pending, or purged actor with no DML', async () => {
    for (const extra of [
      null,
      { is_active: false },
      { activation_status: 'pending' },
      { purged_at: '2026-01-01' },
    ]) {
      state.events = []
      helper.calls = []
      mocks.query.mockClear()
      state.users.set('actor', extra === null ? user('missing', 'admin') : user('actor', 'admin', extra))
      if (extra === null) state.users.delete('actor')
      await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(business()).toEqual([])
      expect(helper.calls).toEqual([])
      expect(calls().some(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(false)
    }
  })

  it('does not treat the target admin membership as the actor edge', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.memberships.set('actor', [])
    state.memberships.set('target', ['admin'])
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      name: 'PlatformActorAuthorityLost',
      code: 'FORBIDDEN',
    })
    expect(calls().filter(([sql]) => sql.includes("role_id = 'admin' FOR SHARE")).map(([, params]) => params)).toEqual([['actor']])
    expect(business()).toEqual([])
    expect(helper.calls).toEqual([])
  })

  it('rejects an unbranded, closed, wrong-plan, unfrozen, witness-corrupt, or parent-bearing token before DML', async () => {
    await writePlatformNamespaceAdmissionCommand(admissionInput())
    const foreign = planOf()
    state.transform = (tx) => ({ ...tx, query: tx.query }) as AuthorizationInputTx
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({ reason: 'unbranded' })
    state.transform = (tx) => {
      const token = { ...tx, query: tx.query }
      mintAuthorizationInputBrand(token, [token]).close()
      return token as AuthorizationInputTx
    }
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({ reason: 'closed' })
    state.transform = (tx) => retoken(tx, { plan: foreign })
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'platform_namespace_admission_context',
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
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'platform_namespace_admission_context',
    })
    state.transform = (tx) => retoken(tx, {
      witnessed: { userIds: new Set(['target']), admissionUserIds: new Set(['actor', 'target']) },
    })
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'platform_namespace_admission_context',
    })
    state.transform = (tx) => retoken(tx, {
      roleRows: new Map([['admin', 'held']]),
    })
    await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      reason: 'platform_namespace_admission_context',
    })
    expect(helper.calls).toHaveLength(1)
    expect(business().filter((sql) => sql.includes('INSERT INTO user_namespace_admissions'))).toHaveLength(1)
  })

  it('skips timeout restore when the admin child share throws', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.fail = 'admin-share'
    try {
      await writePlatformNamespaceAdmissionCommand(admissionInput())
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'XX000' })
      expect(error).not.toBeInstanceOf(AuthorizationInputBusyError)
    }
    expect(calls().filter(([, params]) => params?.[0] === '2s' && params?.[1] === '3s')).toHaveLength(1)
    expect(business()).toEqual([])
    expect(helper.calls).toEqual([])
    expect(mocks.entry).toHaveBeenCalledTimes(1)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
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
      expect(helper.calls).toEqual([])
    }

    state.fail = 'user-lock'
    state.errorCode = '55P03'
    await once(() => expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      name: 'AuthorizationInputBusyError',
      busyReason: 'lock_timeout',
    }))

    state.errorCode = '57014'
    await once(() => expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      busyReason: 'statement_timeout',
    }))

    state.users.set('actor', user('actor', 'user'))
    state.fail = 'admin-share'
    state.errorCode = '40P01'
    state.errorMessage = 'deadlock detected'
    await once(async () => {
      await expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({ busyReason: 'deadlock' })
      expect(calls().filter(([, params]) => params?.[0] === '2s' && params?.[1] === '3s')).toHaveLength(1)
    })

    state.users.set('actor', user('actor', 'admin'))
    state.fail = 'user-lock'
    state.errorCode = '40001'
    state.errorMessage = 'serialization failure'
    await once(() => expect(writePlatformNamespaceAdmissionCommand(admissionInput())).rejects.toMatchObject({
      busyReason: 'serialization',
    }))

    state.errorMessage = RECOVERY_AUTHORITY_BUSY_MARKER
    await once(async () => {
      try {
        await writePlatformNamespaceAdmissionCommand(admissionInput())
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
        await writePlatformNamespaceAdmissionCommand(admissionInput())
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).not.toBeInstanceOf(AuthorizationInputBusyError)
        expect(error).toMatchObject({ code: 'XX000' })
      }
    })
  })

  it('still calls the helper once when enabled is false', async () => {
    await writePlatformNamespaceAdmissionCommand(admissionInput({ enabled: false }))
    expect(helper.calls).toHaveLength(1)
    expect(helper.calls[0]?.[0]).toMatchObject({ enabled: false, source: 'platform_admin' })
    expect(calls().find(([sql]) => sql.includes('INSERT INTO user_namespace_admissions'))?.[1]).toEqual([
      'target', 'crm', false, 'platform_admin', null, 'actor',
    ])
  })
})

describe('platform namespace admission command keeps W-16 on its helper', () => {
  const source = readFileSync(new URL('../../src/admin/platform-namespace-admission-command.ts', import.meta.url), 'utf8')

  it('retires the actor-optional raw transaction wrapper', () => {
    const namespaceSource = readFileSync(new URL('../../src/rbac/namespace-admission.ts', import.meta.url), 'utf8')
    expect(namespaceSource).not.toContain('setUserNamespaceAdmission')
  })

  it('copies no DML and leaves W-16 pending', () => {
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/)
    expect(source.split('await writeUserNamespaceAdmission').length - 1).toBe(1)
    expect(source).not.toContain('setUserNamespaceAdmission')
    expect(source).not.toContain('lockSharedAccessSubjects')
    expect(source).not.toContain('lockNamespaceAdmissionWrites')
    expect(source).not.toContain('assertPlatformActorAuthority')
    const writer = AUTHORIZATION_INPUT_WRITERS.find((entry) => entry.id === 'W-16')
    expect(writer).toMatchObject({
      status: 'pending',
      symbol: 'writeUserNamespaceAdmission',
      file: 'packages/core-backend/src/rbac/namespace-admission.ts',
    })
  })
})
