import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_STATEMENTS,
  withAuthorizationInputTransaction,
} from '../../src/rbac/authorization-input-lock'
import type { AuthorizationInputHandlerClient, AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import {
  discoverPrivilegeRolePlan,
  revalidatePrivilegeRolePlan,
} from '../../src/rbac/authorization-privilege-witness-plan'
import type { PrivilegeRolePlan } from '../../src/rbac/authorization-privilege-witness-plan'
import { privilegeRow } from '../helpers/security-action-privilege-harness'
import { collectImportEdges, importEdgeViolations } from '../helpers/import-edge-allowlist'

const MARKER = 'SENSITIVE_SYNTHETIC_DRIVER_DETAIL'
const INVALID = { name: 'AuthorizationInputContractError', code: 'AUTHORIZATION_INPUT_PLAN_INVALID', status: 500, retryable: false, message: 'Authorization input plan is invalid' }
const UNAVAILABLE = { name: 'PrivilegeInputsUnavailableError', code: 'SECURITY_ACTION_UNAVAILABLE', status: 503, message: 'Privilege inputs are unavailable' }
const TOKEN = { name: 'AuthorizationInputTokenRejectedError', code: 'AUTHORIZATION_INPUT_TOKEN_REJECTED', status: 500, retryable: false, message: 'Authorization input transaction token is not acceptable' }

async function failure(promise: Promise<unknown>, expected: Record<string, unknown>) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    const object = error as Error & Record<string, unknown>
    const shape = Object.fromEntries(Object.getOwnPropertyNames(object).filter((key) => key !== 'stack').map((key) => [key, object[key]]))
    expect(shape).toEqual(expected)
    expect(`${String(error)}${JSON.stringify(shape)}`).not.toContain(MARKER)
    expect(object).not.toHaveProperty('cause')
    return object
  }
  throw new Error('Expected rejection')
}

function discovery(rows: unknown = []) {
  return { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: rows as Array<Record<string, unknown>>, rowCount: null })) }
}

type FakeOptions = {
  roles?: ReadonlySet<string>
  users?: ReadonlySet<string>
  data?: Record<string, Array<Record<string, unknown>>>
  failAt?: string
  onData?: () => Promise<void>
}

function transaction(mapping: Record<string, string[]> = {}, options: FakeOptions = {}) {
  const statements: Array<{ sql: string; params?: unknown[] }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params })
    if (options.failAt && sql.includes(options.failAt)) throw Object.assign(new Error(MARKER), { detail: MARKER, cause: MARKER })
    let rows: Array<Record<string, unknown>> = []
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.readTimeouts) rows = [{ lock_timeout: '0', statement_timeout: '0' }]
    else if (sql === AUTHORIZATION_INPUT_STATEMENTS.isolationProbe) rows = [{ isolation: 'read committed' }]
    else if (sql.includes('pg_current_xact_id()')) rows = [{ xid: '100' }]
    else if (sql === 'SELECT id::text AS id FROM directory_integrations WHERE id = ANY($1::uuid[])') rows = (params?.[0] as string[]).map((id) => ({ id }))
    else if (sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared) rows = options.roles && !options.roles.has(String(params?.[0])) ? [] : [{ id: params?.[0] }]
    else if (/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/.test(sql)) {
      if (!options.users || options.users.has(String(params?.[0]))) rows = [{ id: params?.[0], role: 'user', is_active: true, access_generation: 0 }]
    } else if (sql.includes('FROM users u')) {
      await options.onData?.()
      const userId = String(params?.[0])
      rows = options.data?.[userId] ?? [privilegeRow({ id: userId, role_ids: mapping[userId] ?? [] })]
    }
    return { rows, rowCount: rows.length }
  })
  const client: AuthorizationInputHandlerClient = { query }
  const runner = async <Result>(work: (client: AuthorizationInputHandlerClient) => Promise<Result>): Promise<Result> => {
    statements.push({ sql: 'BEGIN' })
    try {
      const result = await work(client)
      statements.push({ sql: 'COMMIT' })
      return result
    } catch (error) {
      statements.push({ sql: 'ROLLBACK' })
      throw error
    }
  }
  const run = <Result>(plan: AuthorizationInputPlan, work: (tx: AuthorizationInputTx) => Promise<Result>) =>
    withAuthorizationInputTransaction(plan, work, { transaction: runner })
  return { query, statements, run }
}

async function rolePlan() {
  return discoverPrivilegeRolePlan(discovery([
    { user_id: 'u2', role_id: 'r2' },
    { user_id: 'u1', role_id: 'r1' },
  ]), ['u2', 'u1'])
}

function assertNoDml(statements: Array<{ sql: string }>) {
  expect(statements.filter(({ sql }) => /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(sql.replace(/FOR UPDATE/g, '')))).toEqual([])
}

describe('discoverPrivilegeRolePlan', () => {
  it.each(['source', 'index'])('rejects %s accessors without invoking them or discovery SQL', async (fault) => {
    const source = '00000000-0000-0000-0000-000000000000'
    const baseline = await discoverPrivilegeRolePlan(discovery(), ['u1'], { sourceIntegrationIds: [source] })
    expect(baseline.lockPlan.identityRead).toEqual({ sourceIntegrationIds: [source] })
    const input = { sourceIntegrationIds: [source] }
    let getterCalls = 0
    const getter = () => { getterCalls += 1; throw Object.assign(new Error(MARKER), { cause: MARKER }) }
    Object.defineProperty(fault === 'source' ? input : input.sourceIntegrationIds, fault === 'source' ? 'sourceIntegrationIds' : '0', { get: getter })
    const queryable = discovery()
    await failure(discoverPrivilegeRolePlan(queryable, ['u1'], input), { ...INVALID, reason: 'identity_read_invalid' })
    expect(getterCalls).toBe(0)
    expect(queryable.query).not.toHaveBeenCalled()
  })

  it('composes a canonical frozen identity slot on the same registered original plan', async () => {
    const source = 'AAAAAAAA-0000-0000-0000-000000000000'
    const input = { sourceIntegrationIds: [source, source.toLowerCase()] }
    const queryable = discovery([{ user_id: 'u1', role_id: 'r1' }])
    const plan = await discoverPrivilegeRolePlan(queryable, ['u1'], input)
    expect(plan.lockPlan.identityRead).toEqual({ sourceIntegrationIds: [source.toLowerCase()] })
    expect(Object.isFrozen(plan.lockPlan.identityRead)).toBe(true)
    expect(Object.isFrozen(plan.lockPlan.identityRead!.sourceIntegrationIds)).toBe(true)
    input.sourceIntegrationIds.length = 0
    const fake = transaction({ u1: ['r1'] })
    await fake.run(plan.lockPlan, async (tx) => {
      tx.requireIdentityRead([source])
      await revalidatePrivilegeRolePlan(tx, plan)
      const count = fake.statements.length
      await failure(revalidatePrivilegeRolePlan(tx, { ...plan }), { ...INVALID, reason: 'role_plan_unregistered' })
      expect(fake.statements.length).toBe(count)
    })
    await fake.run({ ...plan.lockPlan }, async (tx) => {
      const count = fake.statements.length
      await failure(revalidatePrivilegeRolePlan(tx, plan), { ...INVALID, reason: 'lock_plan_mismatch' })
      expect(fake.statements.length).toBe(count)
    })
  })

  it.each([undefined, null, {}, { sourceIntegrationIds: [] }, { sourceIntegrationIds: ['bad'] }])('rejects invalid optional slot before discovery SQL', async (input) => {
    const queryable = discovery()
    await expect(discoverPrivilegeRolePlan(queryable, ['u1'], input as never)).rejects.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })
    expect(queryable.query).not.toHaveBeenCalled()
  })

  it('composes an empty role set and rejects a missing subject before callbacks', async () => {
    const identityRead = { sourceIntegrationIds: ['00000000-0000-0000-0000-000000000000'] }
    const plan = await discoverPrivilegeRolePlan(discovery(), ['u1'], identityRead)
    expect(plan.roleIds).toEqual([])
    const fake = transaction()
    await fake.run(plan.lockPlan, async (tx) => {
      tx.requireIdentityRead(identityRead.sourceIntegrationIds)
      await revalidatePrivilegeRolePlan(tx, plan)
    })
    const missing = transaction({}, { users: new Set() })
    let callbacks = 0
    await failure(missing.run(plan.lockPlan, async () => { callbacks += 1 }), { ...INVALID, reason: 'user_row_not_held' })
    expect(callbacks).toBe(0)
  })

  it.each([undefined, null, {}, 'u1', [], [''], [' u1'], ['u1 '], ['u\u0000'], ['u\u007f'], ['u'.repeat(256)], [1], new Array(1)].map((subjects) => ({ subjects })))('rejects noncanonical or empty subjects before SQL: $subjects', async ({ subjects }) => {
    const queryable = discovery()
    await failure(discoverPrivilegeRolePlan(queryable, subjects as string[]), { ...INVALID, reason: 'subject_ids_invalid' })
    expect(queryable.query).not.toHaveBeenCalled()
  })

  it('copies, deduplicates and code-unit sorts complete mappings, preserving role spelling and empty roles', async () => {
    const rows = [
      { user_id: 'u2', role_id: 'r2' },
      { user_id: 'u1', role_id: 'r2' },
      { user_id: 'u1', role_id: 'R1' },
    ]
    const subjects = ['u2', 'u1', 'u2', 'u0']
    const queryable = discovery(rows)
    const plan = await discoverPrivilegeRolePlan(queryable, subjects)
    expect(queryable.query.mock.calls).toEqual([['SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1::text[])', [['u0', 'u1', 'u2']]]])
    expect(plan).toEqual({
      subjectIds: ['u0', 'u1', 'u2'],
      subjects: [{ userId: 'u0', roleIds: [] }, { userId: 'u1', roleIds: ['R1', 'r2'] }, { userId: 'u2', roleIds: ['r2'] }],
      roleIds: ['R1', 'r2'],
      lockPlan: { intent: 'CONSUME_CLASS_DECISION', roleIds: ['R1', 'r2'], witness: { userIds: ['u0', 'u1', 'u2'], admissionUserIds: ['u0', 'u1', 'u2'] } },
    })
    rows[0].role_id = 'changed'
    rows.push({ user_id: 'u0', role_id: 'changed' })
    subjects.push('changed')
    expect(plan.subjectIds).toEqual(['u0', 'u1', 'u2'])
    expect(plan.roleIds).toEqual(['R1', 'r2'])
    const containers = [plan, plan.subjectIds, plan.subjects, plan.roleIds, plan.lockPlan, plan.lockPlan.witness, ...plan.subjects, ...plan.subjects.map((subject) => subject.roleIds)]
    for (const container of containers) expect(Object.isFrozen(container)).toBe(true)
    expect(plan.lockPlan.witness?.userIds).toBe(plan.subjectIds)
    expect(plan.lockPlan.witness?.admissionUserIds).toBe(plan.subjectIds)
    expect(() => (plan.roleIds as string[]).push('changed')).toThrow(TypeError)
    expect(() => Object.assign(plan.lockPlan, { userIds: ['changed'] })).toThrow(TypeError)
    expect(() => Object.assign(plan.subjects[0], { userId: 'changed' })).toThrow(TypeError)
  })

  it.each([null, {}, [null], [[]], [{}], [{ user_id: 'other', role_id: 'r1' }], [{ user_id: 1, role_id: 'r1' }], [{ user_id: 'u1', role_id: '' }], [{ user_id: 'u1', role_id: ' r1' }], [{ user_id: 'u1', role_id: 1 }], [{ user_id: 'u1', role_id: 'r1' }, { user_id: 'u1', role_id: 'r1' }]].map((rows) => ({ rows })))('refuses unreadable rows, unknown subjects and duplicate pairs: $rows', async ({ rows }) => {
    await failure(discoverPrivilegeRolePlan(discovery(rows), ['u1']), { ...UNAVAILABLE, reason: 'input_malformed' })
  })

  it('does not join roles, filter privilege, trim roles or fold case', async () => {
    const queryable = discovery([{ user_id: 'u1', role_id: 'OrphanRole' }])
    expect((await discoverPrivilegeRolePlan(queryable, ['u1', 'u1'])).roleIds).toEqual(['OrphanRole'])
    const sql = queryable.query.mock.calls[0][0]
    expect(sql).not.toMatch(/\bJOIN\b|permission|namespace|cache|admin/i)
  })

  it('sanitizes discovery driver errors without forwarding detail or cause', async () => {
    const queryable = { query: vi.fn(async () => { throw Object.assign(new Error(MARKER), { detail: MARKER, cause: MARKER }) }) }
    await failure(discoverPrivilegeRolePlan(queryable, ['u1']), { ...UNAVAILABLE, reason: 'read_failed' })
    expect(queryable.query).toHaveBeenCalledTimes(1)
  })

  it('sanitizes unexpected exceptions while interpreting discovery rows', async () => {
    const row = { user_id: 'u1', get role_id(): string { throw new Error(MARKER) } }
    await failure(discoverPrivilegeRolePlan(discovery([row]), ['u1']), { ...UNAVAILABLE, reason: 'input_malformed' })
  })
})

describe('revalidatePrivilegeRolePlan', () => {
  it('uses a real entry token, sorted R2R/R3/R5 and sequential per-subject reads, returning only void', async () => {
    const plan = await rolePlan()
    const fake = transaction({ u1: ['r1'], u2: ['r2'] })
    await expect(fake.run(plan.lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan))).resolves.toBeUndefined()
    const roles = fake.statements.filter(({ sql }) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)
    const admissions = fake.statements.filter(({ sql }) => sql === AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission)
    const users = fake.statements.filter(({ sql }) => /FROM users\s+WHERE/.test(sql))
    expect(roles.map(({ params }) => params)).toEqual([['r1'], ['r2']])
    expect(admissions.map(({ params }) => params)).toEqual([['namespace-admission:u1'], ['namespace-admission:u2']])
    expect(users.map(({ params }) => params)).toEqual([['u1'], ['u2']])
    expect(fake.statements.indexOf(roles[1])).toBeLessThan(fake.statements.indexOf(admissions[0]))
    expect(fake.statements.indexOf(admissions[1])).toBeLessThan(fake.statements.indexOf(users[0]))
    expect(fake.statements.filter(({ sql }) => sql.includes('FROM users u')).map(({ params }) => params)).toEqual([['u1'], ['u2']])
    expect(fake.statements.filter(({ sql }) => sql.includes('pg_current_xact_id()'))).toHaveLength(4)
    expect(fake.statements.at(-1)?.sql).toBe('COMMIT')
    assertNoDml(fake.statements)
  })

  it('supports empty roles and repeated actor/target without creating authorization output', async () => {
    const plan = await discoverPrivilegeRolePlan(discovery(), ['u1', 'u1'])
    expect(plan.subjects).toEqual([{ userId: 'u1', roleIds: [] }])
    const fake = transaction()
    await expect(fake.run(plan.lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan))).resolves.toBeUndefined()
    expect(fake.statements.filter(({ sql }) => sql.includes('FROM users u'))).toHaveLength(1)
    assertNoDml(fake.statements)
  })

  it.each([
    { u1: ['r1', 'r2'], u2: ['r2'] },
    { u1: [], u2: ['r2'] },
    { u1: ['r2'], u2: ['r1'] },
    { u1: ['r1'], u2: ['r1', 'r2'] },
    { u1: ['r1'], u2: [] },
    { u1: ['R1'], u2: ['r2'] },
  ])('refuses per-subject drift, including an unchanged union: %j', async (mapping) => {
    const plan = await rolePlan()
    const fake = transaction(mapping)
    await failure(fake.run(plan.lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan)), {
      name: 'AuthorizationInputContractError', code: 'AUTHORIZATION_INPUT_PLAN_STALE', status: 409,
      retryable: false, reason: 'role_membership_changed', message: 'Authorization input plan is stale; retry this change.',
    })
    expect(fake.statements.at(-1)?.sql).toBe('ROLLBACK')
    expect(fake.statements.filter(({ sql }) => sql === 'BEGIN')).toHaveLength(1)
    assertNoDml(fake.statements)
  })

  it.each(['spread', 'json', 'cast'] as const)('refuses an unregistered %s plan before reads', async (kind) => {
    const plan = await rolePlan()
    const forged = kind === 'spread' ? { ...plan } : kind === 'json'
      ? { ...JSON.parse(JSON.stringify(plan)), lockPlan: plan.lockPlan }
      : Object.assign(Object.create(null), plan)
    const fake = transaction({ u1: ['r1'], u2: ['r2'] })
    await fake.run(plan.lockPlan, async (tx) => {
      await expect(revalidatePrivilegeRolePlan(tx, plan)).resolves.toBeUndefined()
      const count = fake.query.mock.calls.length
      await failure(revalidatePrivilegeRolePlan(tx, forged as PrivilegeRolePlan), { ...INVALID, reason: 'role_plan_unregistered' })
      expect(fake.query).toHaveBeenCalledTimes(count)
    })
  })

  it.each(['copy', 'missing-role', 'extra-role'] as const)('refuses another lock plan even with the %s shape', async (kind) => {
    const plan = await rolePlan()
    const lockPlan = { ...plan.lockPlan, roleIds: kind === 'missing-role' ? ['r1'] : kind === 'extra-role' ? ['r1', 'r2', 'r3'] : plan.roleIds }
    const fake = transaction({ u1: ['r1'], u2: ['r2'] })
    await expect(fake.run(plan.lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan))).resolves.toBeUndefined()
    const count = fake.statements.filter(({ sql }) => sql.includes('FROM users u')).length
    await failure(fake.run(lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan)), { ...INVALID, reason: 'lock_plan_mismatch' })
    expect(fake.statements.filter(({ sql }) => sql.includes('FROM users u'))).toHaveLength(count)
  })

  it('refuses a structural cast and a connection wrapper even when open is true', async () => {
    const plan = await rolePlan()
    const fake = transaction({ u1: ['r1'], u2: ['r2'] })
    await fake.run(plan.lockPlan, async (tx) => {
      await expect(revalidatePrivilegeRolePlan(tx, plan)).resolves.toBeUndefined()
      const count = fake.query.mock.calls.length
      for (const candidate of [{ ...tx, open: true }, Object.create(tx), { query: tx.query, plan: plan.lockPlan, open: true }]) {
        await failure(revalidatePrivilegeRolePlan(candidate as AuthorizationInputTx, plan), { ...TOKEN, reason: 'unbranded' })
      }
      expect(fake.query).toHaveBeenCalledTimes(count)
    })
    expect(fake.statements.filter(({ sql }) => sql.includes('FROM users u'))).toHaveLength(2)
  })

  it('refuses a real closed token before SQL', async () => {
    const plan = await rolePlan()
    const fake = transaction({ u1: ['r1'], u2: ['r2'] })
    const token = await fake.run(plan.lockPlan, async (tx) => {
      await expect(revalidatePrivilegeRolePlan(tx, plan)).resolves.toBeUndefined()
      return tx
    })
    const count = fake.query.mock.calls.length
    await failure(revalidatePrivilegeRolePlan(token, plan), { ...TOKEN, reason: 'closed' })
    expect(fake.query).toHaveBeenCalledTimes(count)
  })

  it('rechecks the real brand after an asynchronous read finishes outside the work closure', async () => {
    const plan = await discoverPrivilegeRolePlan(discovery([{ user_id: 'u1', role_id: 'r1' }]), ['u1'])
    let release!: () => void
    let started!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const reading = new Promise<void>((resolve) => { started = resolve })
    const fake = transaction({ u1: ['r1'], u2: ['r2'] }, { onData: async () => { started(); await barrier } })
    let pending!: Promise<void>
    await fake.run(plan.lockPlan, async (tx) => {
      pending = revalidatePrivilegeRolePlan(tx, plan)
      await reading
    })
    const rejected = failure(pending, { ...TOKEN, reason: 'closed' })
    release()
    await rejected
    expect(fake.statements.filter(({ sql }) => sql.includes('FROM users u'))).toHaveLength(1)
  })

  it.each([
    ['R3 witness', 'admission_witness_not_held'],
    ['R5 witness', 'user_witness_not_held'],
    ['R5 row', 'user_row_not_held'],
    ['role set', 'role_rows_mismatch'],
    ['extra role', 'role_rows_mismatch'],
    ['actual user check', 'user_row_not_held'],
    ['actual role check', 'role_row_not_held'],
    ['world', 'consume_shared_required'],
  ])('isolates the %s check with a test-only branded token, not PG evidence', async (kind, reason) => {
    const plan = await rolePlan()
    const fake = transaction({ u1: ['r1'], u2: ['r2'] })
    await fake.run(plan.lockPlan, async (tx) => {
      const baseline = { ...tx } as AuthorizationInputTx
      const baselineBrand = mintAuthorizationInputBrand(baseline, [baseline])
      try {
        await expect(revalidatePrivilegeRolePlan(baseline, plan)).resolves.toBeUndefined()
      } finally {
        baselineBrand.close()
      }
      const synthetic = {
        ...tx,
        ...(kind === 'R3 witness' ? { witnessed: { ...tx.witnessed, admissionUserIds: new Set(['u2']) } } : {}),
        ...(kind === 'R5 witness' ? { witnessed: { ...tx.witnessed, userIds: new Set(['u2']) } } : {}),
        ...(kind === 'R5 row' ? { locked: new Map([...tx.locked].filter(([userId]) => userId !== 'u1')) } : {}),
        ...(kind === 'role set' ? { roleRows: new Map([['r1', 'held']]) } : {}),
        ...(kind === 'extra role' ? { roleRows: new Map([...tx.roleRows, ['r3', 'held']]) } : {}),
        ...(kind === 'actual user check' ? { requireUserRows: () => { throw new Error(MARKER) } } : {}),
        ...(kind === 'actual role check' ? { requireRoleRows: () => { throw new Error(MARKER) } } : {}),
        ...(kind === 'world' ? { world: 'exclusive' } : {}),
      } as AuthorizationInputTx
      const brand = mintAuthorizationInputBrand(synthetic, [synthetic])
      const count = fake.query.mock.calls.length
      try {
        await failure(revalidatePrivilegeRolePlan(synthetic, plan), { ...INVALID, reason })
        expect(fake.query).toHaveBeenCalledTimes(count)
      } finally {
        brand.close()
      }
    })
  })

  it('refuses orphan role rows in the actual entry before R3/R5 and does not late acquire', async () => {
    const plan = await rolePlan()
    const fake = transaction({}, { roles: new Set(['r1']) })
    let called = false
    await failure(fake.run(plan.lockPlan, async (tx) => { called = true; await revalidatePrivilegeRolePlan(tx, plan) }), { ...INVALID, reason: 'role_row_not_held' })
    expect(called).toBe(false)
    expect(fake.statements.filter(({ sql }) => sql === AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission || /FROM users\b/.test(sql))).toEqual([])
  })

  it('refuses a missing user locked by the actual entry', async () => {
    const plan = await rolePlan()
    const fake = transaction({}, { users: new Set(['u2']) })
    await failure(fake.run(plan.lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan)), { ...INVALID, reason: 'user_row_not_held' })
    expect(fake.statements.filter(({ sql }) => sql.includes('FROM users u'))).toEqual([])
  })

  it.each([
    { rows: [], reason: 'subject_missing' },
    { rows: [privilegeRow({ id: 'u1', role_ids: ['r1', 'r1'] })], reason: 'input_malformed' },
    { rows: [privilegeRow({ id: 'u1', role_ids: [' r1'] })], reason: 'input_malformed' },
    { rows: [privilegeRow({ id: 'u1', role_ids: [1] })], reason: 'input_malformed' },
    { rows: [privilegeRow({ id: 'u1', legacy_permissions: null })], reason: 'input_malformed' },
  ])('refuses missing or malformed privilege rows: $reason', async ({ rows, reason }) => {
    const plan = await rolePlan()
    const fake = transaction({}, { data: { u1: rows } })
    await failure(fake.run(plan.lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan)), { ...UNAVAILABLE, reason })
    expect(fake.statements.at(-1)?.sql).toBe('ROLLBACK')
    assertNoDml(fake.statements)
  })

  it.each([
    ['FROM users u', 'read_failed'],
    ['pg_current_xact_id()', 'transaction_required'],
  ])('sanitizes classifier failures at %s', async (failAt, reason) => {
    const plan = await rolePlan()
    const fake = transaction({}, { failAt })
    await failure(fake.run(plan.lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan)), { ...UNAVAILABLE, reason })
    expect(fake.statements.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('normalizes unexpected classifier exceptions rather than forwarding them', async () => {
    const plan = await rolePlan()
    const row = privilegeRow({ id: 'u1', role_ids: ['r1'] })
    Object.defineProperty(row, 'is_admin', { get: () => { throw Object.assign(new Error(MARKER), { cause: MARKER }) } })
    const fake = transaction({}, { data: { u1: [row] } })
    await failure(fake.run(plan.lockPlan, (tx) => revalidatePrivilegeRolePlan(tx, plan)), { ...UNAVAILABLE, reason: 'read_failed' })
    expect(fake.statements.at(-1)?.sql).toBe('ROLLBACK')
  })
})

const ROLE_PLAN_IMPORT_EDGES = [
  ['auth/admin-grant-proof.ts', '../rbac/authorization-privilege-witness-plan'],
  ['auth/admin-grant-proof.ts', '../rbac/authorization-privilege-witness-plan'],
  ['auth/admin-grant-receiving-reader.ts', '../rbac/authorization-privilege-witness-plan'],
  ['auth/admin-grant-target-ceremony.ts', '../rbac/authorization-privilege-witness-plan'],
  ['auth/admin-login-grant-command.ts', '../rbac/authorization-privilege-witness-plan'],
  ['auth/admin-login-grant-command.ts', '../rbac/authorization-privilege-witness-plan'],
  ['auth/security-action-attempt-admission.ts', '../rbac/authorization-privilege-witness-plan'],
  ['auth/strict-dingtalk-entry.ts', '../rbac/authorization-privilege-witness-plan'],
] as const

describe('read-only bounded surface', () => {
  it('allows only the exact receiving, ceremony, proof, command, attempt and runtime imports, including plugins', () => {
    const root = path.resolve(__dirname, '..', '..', '..', '..')
    const pattern = /authorization-privilege-witness-plan/
    for (const directory of ['packages/core-backend/src', 'plugins']) {
      const expected = directory === 'packages/core-backend/src'
        ? ROLE_PLAN_IMPORT_EDGES
        : []
      expect(importEdgeViolations(collectImportEdges(path.join(root, directory), pattern, (file) => readFileSync(file, 'utf8')), expected)).toEqual([])
    }
  })

  it('rejects omission, duplication, relocation or computed loading of each current role-plan edge', () => {
    ROLE_PLAN_IMPORT_EDGES.forEach((edge, index) => {
      const omitted = ROLE_PLAN_IMPORT_EDGES.filter((_candidate, candidateIndex) => candidateIndex !== index)
      expect(importEdgeViolations(omitted, ROLE_PLAN_IMPORT_EDGES)).not.toEqual([])
      expect(importEdgeViolations([...ROLE_PLAN_IMPORT_EDGES, edge], ROLE_PLAN_IMPORT_EDGES)).not.toEqual([])
      expect(importEdgeViolations([...omitted, ['auth/other.ts', edge[1]]], ROLE_PLAN_IMPORT_EDGES)).not.toEqual([])
      expect(importEdgeViolations([...omitted, [edge[0], '<non-literal>']], ROLE_PLAN_IMPORT_EDGES)).not.toEqual([])
    })
  })

  it('rejects an omitted, duplicate, dynamic or unrelated prepared-reader edge', () => {
    const edge = ['auth/admin-grant-receiving-reader.ts', '../rbac/authorization-privilege-witness-plan'] as const
    expect(importEdgeViolations([edge], [edge])).toEqual([])
    for (const found of [[], [edge, edge], [[edge[0], '<non-literal>']], [['auth/other.ts', edge[1]]], [[edge[0], './other']], [edge, [edge[0], '<non-literal>']]]) {
      expect(importEdgeViolations(found as Array<readonly [string, string]>, [edge])).not.toEqual([])
    }
  })

  it('exports only two functions and the plan type; no authorization inputs, mint, IO runner or business caller', () => {
    const file = path.resolve(__dirname, '../../src/rbac/authorization-privilege-witness-plan.ts')
    const source = readFileSync(file, 'utf8')
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const exports = tree.statements.filter((statement) => ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .map((statement) => (statement as ts.FunctionDeclaration | ts.TypeAliasDeclaration).name?.getText(tree))
    expect(exports).toEqual(['PrivilegeRolePlan', 'discoverPrivilegeRolePlan', 'revalidatePrivilegeRolePlan'])
    expect(source).not.toMatch(/mintAuthorizationInputBrand|withAuthorizationInputTransaction|\.acquire\(|\b(?:INSERT|DELETE|MERGE|TRUNCATE)\b/)
    expect(source).not.toMatch(/assessSecurityActionPrivilege|classifyPrivilege|computePrivilegeWitness/)
  })
})
