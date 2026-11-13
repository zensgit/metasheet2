/**
 * Authorization-input contract entry points, driven through a recording transaction stand-in.
 *
 * Pinned here: the rank order; the first statement of a self-built transaction; the rank-monotone
 * lock sequence per intent with ids in code-unit order and role rows before admissions and users;
 * the role row mode per intent; the timeout window around the lock statements; the busy mapping and
 * its pass-through cases; the bounded exclusive try; the takeover entry's closed intent sets, prefix
 * list and isolation probe; token rejection before any statement; the single upgrade re-run; the
 * state of a missing role row per intent; the witness slot; locks added by `work`, one request at
 * a time; the closed shapes of a plan, a witness and a request for added locks; the held-row
 * checks; the refusal inside the pull-source gate marker; the borrow-period error listener; dense
 * placeholders and the literal world-lock key; the key's distance from every other fixed two-int4
 * namespace; and the CI wiring of the two real-database files.
 */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ADVISORY_FIXED_KEY1_REGISTRY } from '../../src/attendance/coordination/settlement-coordination-key'
import { isInsidePullSourceGate, runInsidePullSourceGate } from '../../src/directory/pull-source-gate-context'
import { isRecoveryAuthorityBusyError, RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { lockNamespaceAdmissionWrites } from '../../src/rbac/namespace-admission'
import {
  assertAuthorizationInputTx,
  AuthorizationInputContractError,
  AuthorizationInputTokenRejectedError,
} from '../../src/rbac/authorization-input-brand'
import {
  AUTHORIZATION_INPUT_EXCLUSIVE_BUDGET,
  AUTHORIZATION_INPUT_INTENT_CATALOG,
  AUTHORIZATION_INPUT_INTENTS,
  AUTHORIZATION_INPUT_LOCK_RANK_ORDER,
  AUTHORIZATION_INPUT_LOCK_RANKS,
  AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS,
  AUTHORIZATION_INPUT_MAINTENANCE_BUDGET,
  AUTHORIZATION_INPUT_MAX_CONCURRENT_EXCLUSIVE,
  AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS,
  AUTHORIZATION_INPUT_STATEMENTS,
  AUTHORIZATION_INPUT_TAKEOVER_CALLERS,
  AUTHORIZATION_INPUT_WORLD_LOCK_KEY1,
  AUTHORIZATION_INPUT_WORLD_LOCK_KEY2,
  AuthorizationInputBusyError,
  AuthorizationInputUpgradeRequired,
  classifyAuthorizationInputBusyCause,
  enterAuthorizationInputTransaction,
  readClassRaisingRoleIds,
  REGISTERED_TAKEOVER_PREFIXES,
  withAuthorizationInputTransaction,
} from '../../src/rbac/authorization-input-lock'
import type {
  AuthorizationInputHandlerClient,
  AuthorizationInputIntent,
  AuthorizationInputPlan,
  AuthorizationInputTx,
} from '../../src/rbac/authorization-input-lock'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const BACKEND = path.join(ROOT, 'packages', 'core-backend')
const SRC = path.join(BACKEND, 'src')
const LOCK_MODULE = path.join(SRC, 'rbac', 'authorization-input-lock.ts')
const DB_SPECS = [
  'tests/integration/authorization-input-serialization.db.test.ts',
  'tests/integration/authorization-input-census.db.test.ts',
]
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'plugin-tests.yml')
const RECOVERY_MARKER = 'METASHEET_RECOVERY_AUTHORITY_BUSY'

type Recorded = { sql: string; params?: unknown[]; extra: number; listeners: number }

type FakeOptions = {
  tryExclusive?: boolean[]
  trySharedAcquired?: boolean
  roleRows?: ReadonlySet<string>
  /** When given, only these user rows exist. */
  userRows?: ReadonlySet<string>
  rolePermissionRows?: Array<{ role_id: string; permission_code: string }>
  isolation?: string
  failAt?: { match: string; error: unknown }
  failCommit?: unknown
  withRaw?: boolean
  savedTimeouts?: { lock_timeout: string; statement_timeout: string }
}

function pgError(code: string | null, message = 'synthetic'): Error {
  const error = new Error(message)
  if (code !== null) Object.assign(error, { code })
  return error
}

function makeFake(options: FakeOptions = {}) {
  const statements: Recorded[] = []
  const raw = new EventEmitter()
  const tryExclusive = [...(options.tryExclusive ?? [])]
  const listenersAt: Record<string, number> = {}
  const answer = (sql: string, params?: unknown[]): Array<Record<string, unknown>> => {
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.readTimeouts) return [options.savedTimeouts ?? { lock_timeout: '0', statement_timeout: '0' }]
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.isolationProbe) return [{ isolation: options.isolation ?? 'read committed' }]
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry) return [{ acquired: tryExclusive.length > 0 ? tryExclusive.shift() : true }]
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry) return [{ acquired: options.trySharedAcquired ?? true }]
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.roleRow || sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared) return options.roleRows && !options.roleRows.has(String(params?.[0])) ? [] : [{ id: params?.[0] }]
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.rolePermissionCodes) return options.rolePermissionRows ?? []
    if (/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/.test(sql) && options.userRows && !options.userRows.has(String(params?.[0]))) return []
    if (/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/.test(sql)) return [{ id: params?.[0], name: null, email: null, username: null, mobile: null, activation_status: null, role: 'user', is_active: true, access_generation: 0, deleted_at: null, purged_at: null }]
    if (sql.startsWith('INSERT INTO users')) return [{ id: params?.[0] }]
    return []
  }
  const client: AuthorizationInputHandlerClient = {
    query: async (sql: string, params?: unknown[], ...extra: unknown[]) => {
      statements.push({ sql, params, extra: extra.length, listeners: raw.listenerCount('error') })
      if (options.failAt && sql.includes(options.failAt.match)) throw options.failAt.error
      return { rows: answer(sql, params), rowCount: null }
    },
    __rawClient: options.withRaw === false ? undefined : (raw as never),
  }
  const runner = async <T>(handler: (client: AuthorizationInputHandlerClient) => Promise<T>): Promise<T> => {
    statements.push({ sql: 'BEGIN', extra: 0, listeners: raw.listenerCount('error') })
    try {
      const result = await handler(client)
      listenersAt.commit = raw.listenerCount('error')
      statements.push({ sql: 'COMMIT', extra: 0, listeners: raw.listenerCount('error') })
      if (options.failCommit !== undefined) throw options.failCommit
      return result
    } catch (error) {
      listenersAt.rollback = raw.listenerCount('error')
      statements.push({ sql: 'ROLLBACK', extra: 0, listeners: raw.listenerCount('error') })
      throw error
    } finally {
      listenersAt.release = raw.listenerCount('error')
      statements.push({ sql: 'release', extra: 0, listeners: raw.listenerCount('error') })
    }
  }
  return { statements, raw, client, runner, listenersAt, sqls: () => statements.map((s) => s.sql) }
}

function rankOf(sql: string): number | null {
  if (sql === AUTHORIZATION_INPUT_STATEMENTS.worldShared || sql === AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry || sql === AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry) return AUTHORIZATION_INPUT_LOCK_RANKS.R0_WORLD
  if (sql === AUTHORIZATION_INPUT_STATEMENTS.platformAdminInvariant) return AUTHORIZATION_INPUT_LOCK_RANKS.R1_PLATFORM_ADMIN_INVARIANT
  if (sql === AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission) return AUTHORIZATION_INPUT_LOCK_RANKS.R3_NAMESPACE_ADMISSION
  if (sql === AUTHORIZATION_INPUT_STATEMENTS.roleRow || sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared) return AUTHORIZATION_INPUT_LOCK_RANKS.R2R_ROLE_ROW
  if (/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/.test(sql)) return AUTHORIZATION_INPUT_LOCK_RANKS.R5_USER_ROW
  return null
}

function placeholders(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected rejection')
}

const ROLE_ROW_UPDATE_INTENTS: readonly AuthorizationInputIntent[] = ['EDIT_ROLE_CONTENT', 'DELETE_ROLE', 'MAINTENANCE']
const ROLE_ROW_SHARE_INTENTS: readonly AuthorizationInputIntent[] = ['GRANT_ROLE', 'REVOKE_ROLE', 'SET_ADMIN_PROFILE', 'BIRTH', 'PROJECTION_GRANT']
const R = AUTHORIZATION_INPUT_LOCK_RANKS
const S = AUTHORIZATION_INPUT_STATEMENTS
const lockRanks = (sqls: readonly string[]) => sqls.map(rankOf).filter((rank): rank is number => rank !== null)
const run = (plan: AuthorizationInputPlan, work: (tx: AuthorizationInputTx) => Promise<unknown>, fake: ReturnType<typeof makeFake>) =>
  withAuthorizationInputTransaction(plan, work, { transaction: fake.runner, sleep: async () => undefined })

const REPRESENTATIVE_PLANS: Record<AuthorizationInputIntent, AuthorizationInputPlan> = {
  GRANT_ROLE: { intent: 'GRANT_ROLE', userIds: ['u2', 'u1', 'U9'], admissionUserIds: ['u2', 'u1'], roleIds: ['r2', 'r1'] },
  REVOKE_ROLE: { intent: 'REVOKE_ROLE', admissionUserIds: ['u1'], platformAdminInvariant: true, roleIds: ['admin'] },
  GRANT_DIRECT: { intent: 'GRANT_DIRECT', userIds: ['u1'] },
  REVOKE_DIRECT: { intent: 'REVOKE_DIRECT' },
  SET_ADMIN_PROFILE: { intent: 'SET_ADMIN_PROFILE', userIds: ['u1'], platformAdminInvariant: true, roleIds: ['admin'] },
  SET_DELEGATED_SCOPE: { intent: 'SET_DELEGATED_SCOPE', userIds: ['u1'] },
  SET_ADMISSION: { intent: 'SET_ADMISSION', admissionUserIds: ['u1'] },
  EDIT_ROLE_CONTENT: { intent: 'EDIT_ROLE_CONTENT', roleIds: ['r2', 'r1'] },
  DELETE_ROLE: { intent: 'DELETE_ROLE', roleIds: ['r1'] },
  PURGE: { intent: 'PURGE', admissionUserIds: ['u1'], userIds: ['u1'] },
  CASCADE_PARENT_DELETE: { intent: 'CASCADE_PARENT_DELETE' },
  BIRTH: { intent: 'BIRTH' },
  CONSUME_CLASS_DECISION: { intent: 'CONSUME_CLASS_DECISION', userIds: ['u1'] },
  PROJECTION_GRANT: { intent: 'PROJECTION_GRANT' },
  MAINTENANCE: { intent: 'MAINTENANCE' },
}

describe('lock order constants', () => {
  it('ranks are strictly increasing in acquisition order and the order lists every rank', () => {
    const values = AUTHORIZATION_INPUT_LOCK_RANK_ORDER.map((rank) => AUTHORIZATION_INPUT_LOCK_RANKS[rank])
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThan(values[i - 1])
    expect([...AUTHORIZATION_INPUT_LOCK_RANK_ORDER].sort()).toEqual(Object.keys(AUTHORIZATION_INPUT_LOCK_RANKS).sort())
    expect(AUTHORIZATION_INPUT_LOCK_RANK_ORDER[0]).toBe('R0_WORLD')
  })

  it('role rows have one rank, after the source freeze locks and before the admission locks and the user rows', () => {
    expect(AUTHORIZATION_INPUT_LOCK_RANK_ORDER).toEqual([
      'R0_WORLD',
      'R1_PLATFORM_ADMIN_INVARIANT',
      'R2_IDENTITY_MAINTENANCE',
      'R2F_SOURCE_SYNC_FREEZE',
      'R2R_ROLE_ROW',
      'R3_NAMESPACE_ADMISSION',
      'R5_USER_ROW',
      'R6_DOMAIN',
      'R7_SESSION_ROW',
      'R8_CHALLENGE_ROW',
    ])
    expect(R.R2F_SOURCE_SYNC_FREEZE).toBeLessThan(R.R2R_ROLE_ROW)
    expect(R.R2R_ROLE_ROW).toBeLessThan(R.R3_NAMESPACE_ADMISSION)
    expect(R.R3_NAMESPACE_ADMISSION).toBeLessThan(R.R5_USER_ROW)
    expect(S.roleRow).toBe('SELECT id::text AS id FROM roles WHERE id = $1::text FOR UPDATE')
    expect(S.roleRowShared).toBe('SELECT id::text AS id FROM roles WHERE id = $1::text FOR SHARE')
  })

  it('the intent catalogue is closed and the takeover closures exclude role content writes', () => {
    expect(Object.keys(AUTHORIZATION_INPUT_INTENT_CATALOG).sort()).toEqual([...AUTHORIZATION_INPUT_INTENTS].sort())
    expect(AUTHORIZATION_INPUT_TAKEOVER_CALLERS.directory_sync.intents).toEqual(['PROJECTION_GRANT'])
    expect(AUTHORIZATION_INPUT_TAKEOVER_CALLERS.controlled_handover.intents).toEqual(['CASCADE_PARENT_DELETE'])
    for (const caller of Object.values(AUTHORIZATION_INPUT_TAKEOVER_CALLERS)) {
      expect(caller.intents).not.toContain('EDIT_ROLE_CONTENT')
      expect(caller.intents).not.toContain('DELETE_ROLE')
      for (const intent of caller.intents) expect(AUTHORIZATION_INPUT_INTENT_CATALOG[intent].world).toBe('shared')
    }
    expect(REGISTERED_TAKEOVER_PREFIXES).toEqual(['isolation_pin'])
    expect(AUTHORIZATION_INPUT_TAKEOVER_CALLERS.directory_sync.prefixes).toEqual(['isolation_pin'])
    expect(AUTHORIZATION_INPUT_TAKEOVER_CALLERS.controlled_handover.prefixes).toEqual([])
    // The whole catalogue as four literal sets. The entry decides a missing role row by intent and
    // takes R1 for a role delete only when the plan asks for it; the cases that hold those two
    // decisions apart from these flags are not kept while the sets below are what they are.
    const changed = 'the intent catalogue changed: add back the case that marks DELETE_ROLE upgradeable and expects no upgrade at the entry for its missing row, and the mutation that decides the missing-row upgrade by the upgradeable flag'
    const intentsWhere = (predicate: (intent: AuthorizationInputIntent) => boolean) => AUTHORIZATION_INPUT_INTENTS.filter(predicate)
    expect(intentsWhere((intent) => AUTHORIZATION_INPUT_INTENT_CATALOG[intent].upgradeable), changed).toEqual(['EDIT_ROLE_CONTENT'])
    expect(intentsWhere((intent) => AUTHORIZATION_INPUT_INTENT_CATALOG[intent].platformAdminInvariant), changed).toEqual([])
    expect(intentsWhere((intent) => AUTHORIZATION_INPUT_INTENT_CATALOG[intent].world === 'exclusive'), changed).toEqual(['MAINTENANCE'])
    expect(intentsWhere((intent) => AUTHORIZATION_INPUT_INTENT_CATALOG[intent].birth), changed).toEqual(['BIRTH', 'PROJECTION_GRANT'])
  })
})

describe('self-built entry: statement order per intent', () => {
  for (const intent of AUTHORIZATION_INPUT_INTENTS) {
    it(`${intent}: READ COMMITTED first, lock ranks non-decreasing, ids in code-unit order, timeouts around the locks only`, async () => {
      const fake = makeFake()
      const plan = REPRESENTATIVE_PLANS[intent]
      let workStatementIndex = -1
      await withAuthorizationInputTransaction(plan, async (tx) => {
        workStatementIndex = fake.statements.length
        await tx.query('SELECT 1')
        return 'done'
      }, { transaction: fake.runner, sleep: async () => undefined })
      const sqls = fake.sqls()
      expect(sqls[0]).toBe('BEGIN')
      expect(sqls[1]).toBe(AUTHORIZATION_INPUT_STATEMENTS.setTransaction)
      expect(sqls.at(-2)).toBe('COMMIT')
      const ranks = sqls.map(rankOf).filter((rank): rank is number => rank !== null)
      expect(ranks[0]).toBe(AUTHORIZATION_INPUT_LOCK_RANKS.R0_WORLD)
      for (let i = 1; i < ranks.length; i += 1) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1])
      const expectedWorld = AUTHORIZATION_INPUT_INTENT_CATALOG[intent].world === 'exclusive' ? AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry : AUTHORIZATION_INPUT_STATEMENTS.worldShared
      expect(sqls.filter((sql) => rankOf(sql) === 0)).toEqual([expectedWorld])
      // Ids per rank are issued in code-unit order, de-duplicated.
      const byRank = (rank: number) => fake.statements.filter((s) => rankOf(s.sql) === rank).map((s) => String(s.params?.[0]))
      const sorted = (ids: readonly string[] | undefined) => [...new Set(ids ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      expect(byRank(AUTHORIZATION_INPUT_LOCK_RANKS.R5_USER_ROW)).toEqual(sorted(plan.userIds))
      expect(byRank(AUTHORIZATION_INPUT_LOCK_RANKS.R2R_ROLE_ROW)).toEqual(sorted(plan.roleIds))
      // Role rows are locked for update by the intents that write role content and in share mode by the others.
      const roleStatements = [...new Set(sqls.filter((sql) => rankOf(sql) === AUTHORIZATION_INPUT_LOCK_RANKS.R2R_ROLE_ROW))]
      if ((plan.roleIds ?? []).length > 0) expect(roleStatements).toEqual([ROLE_ROW_UPDATE_INTENTS.includes(intent) ? S.roleRow : S.roleRowShared])
      expect(byRank(AUTHORIZATION_INPUT_LOCK_RANKS.R3_NAMESPACE_ADMISSION)).toEqual(sorted(plan.admissionUserIds).map((id) => `namespace-admission:${id}`))
      const r1 = sqls.filter((sql) => sql === AUTHORIZATION_INPUT_STATEMENTS.platformAdminInvariant).length
      expect(r1).toBe(AUTHORIZATION_INPUT_INTENT_CATALOG[intent].platformAdminInvariant || plan.platformAdminInvariant ? 1 : 0)
      // Timeouts: read, set, locks, restore — and nothing of the work inside the window.
      const setIndexes = fake.statements.map((s, i) => (s.sql === AUTHORIZATION_INPUT_STATEMENTS.setTimeouts ? i : -1)).filter((i) => i >= 0)
      expect(setIndexes).toHaveLength(2)
      expect(fake.statements[setIndexes[0] - 1].sql).toBe(AUTHORIZATION_INPUT_STATEMENTS.readTimeouts)
      expect(fake.statements[setIndexes[0]].params).toEqual([String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)])
      expect(fake.statements[setIndexes[1]].params).toEqual(['0', '0'])
      const lockIndexes = fake.statements.map((s, i) => (rankOf(s.sql) !== null ? i : -1)).filter((i) => i >= 0)
      expect(Math.min(...lockIndexes)).toBeGreaterThan(setIndexes[0])
      expect(Math.max(...lockIndexes)).toBeLessThan(setIndexes[1])
      expect(workStatementIndex).toBeGreaterThan(setIndexes[1])
      // No contract statement carries extra query options, and none mentions the idle timeout.
      for (const s of fake.statements) {
        expect(s.extra).toBe(0)
        expect(s.sql).not.toMatch(/idle_in_transaction_session_timeout/i)
      }
    })
  }

  it('every intent that may name role rows is in exactly one of the two role row groups, and the representative plans cover both', () => {
    expect([...ROLE_ROW_UPDATE_INTENTS, ...ROLE_ROW_SHARE_INTENTS].filter((intent, index, all) => all.indexOf(intent) !== index)).toEqual([])
    for (const intent of ROLE_ROW_UPDATE_INTENTS) expect(AUTHORIZATION_INPUT_INTENTS).toContain(intent)
    for (const intent of ['GRANT_ROLE', 'REVOKE_ROLE', 'SET_ADMIN_PROFILE', 'EDIT_ROLE_CONTENT', 'DELETE_ROLE'] as const) expect((REPRESENTATIVE_PLANS[intent].roleIds ?? []).length, intent).toBeGreaterThan(0)
    // The representative member plan holds role rows, admissions and users at once: the three ranks in order.
    expect((REPRESENTATIVE_PLANS.GRANT_ROLE.admissionUserIds ?? []).length).toBeGreaterThan(0)
    expect((REPRESENTATIVE_PLANS.GRANT_ROLE.userIds ?? []).length).toBeGreaterThan(0)
  })

  it('restores the caller\'s own timeout values, not fixed ones', async () => {
    const fake = makeFake({ savedTimeouts: { lock_timeout: '7s', statement_timeout: '1min' } })
    await withAuthorizationInputTransaction({ intent: 'REVOKE_DIRECT' }, async () => 1, { transaction: fake.runner })
    const sets = fake.statements.filter((s) => s.sql === AUTHORIZATION_INPUT_STATEMENTS.setTimeouts)
    expect(sets.map((s) => s.params)).toEqual([[String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)], ['7s', '1min']])
  })

  it('a shared try that is not granted is busy without waiting', async () => {
    const fake = makeFake({ trySharedAcquired: false })
    const error = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', sharedAcquire: 'try' }, async () => 1, { transaction: fake.runner }))
    expect(error).toBeInstanceOf(AuthorizationInputBusyError)
    expect((error as AuthorizationInputBusyError).busyReason).toBe('lock_timeout')
    expect(fake.sqls().filter((sql) => rankOf(sql) === 0)).toEqual([AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry])
    expect(fake.sqls()).toContain('ROLLBACK')
  })
})

describe('self-built entry: busy mapping', () => {
  const cases: Array<[string | null, string, string | null]> = [
    ['55P03', 'synthetic', 'lock_timeout'],
    ['57014', 'synthetic', 'statement_timeout'],
    ['40P01', 'synthetic', 'deadlock'],
    ['40001', 'synthetic', 'serialization'],
    ['25P03', 'synthetic', 'session_terminated'],
    ['57P01', 'synthetic', 'session_terminated'],
    ['57P02', 'synthetic', 'session_terminated'],
    ['57P03', 'synthetic', 'session_terminated'],
    ['40001', RECOVERY_MARKER, null],
    ['42P01', 'synthetic', null],
    [null, 'synthetic', null],
  ]
  for (const [code, message, reason] of cases) {
    it(`lock statement failing with ${code ?? 'no SQLSTATE'}${message === RECOVERY_MARKER ? ' and the recovery marker' : ''} -> ${reason ?? 'passes through unchanged'}`, async () => {
      const thrown = pgError(code, message)
      const fake = makeFake({ failAt: { match: 'pg_advisory_xact_lock_shared', error: thrown } })
      const work = async () => 'never'
      const error = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', userIds: ['u1'] }, work, { transaction: fake.runner }))
      if (reason === null) {
        expect(error).toBe(thrown)
      } else {
        expect(error).toBeInstanceOf(AuthorizationInputBusyError)
        expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', status: 409, retryable: true, busyReason: reason, cause: thrown })
      }
      expect(fake.sqls()).toContain('ROLLBACK')
      expect(fake.sqls().some((sql) => /FOR UPDATE/.test(sql))).toBe(false)
    })
  }

  it('a lock failure inside work maps the same way; a domain error from work passes through', async () => {
    const deadlock = pgError('40P01')
    const fake = makeFake()
    const error = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async () => {
      throw deadlock
    }, { transaction: fake.runner }))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'deadlock' })
    const domain = new Error('domain')
    const second = makeFake()
    expect(await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async () => {
      throw domain
    }, { transaction: second.runner }))).toBe(domain)
  })

  it('the busy error has the fixed shape and a values-free message', () => {
    const cause = pgError('55P03', 'canceling statement due to lock timeout on relation users')
    const error = new AuthorizationInputBusyError('lock_timeout', cause)
    expect(error).toBeInstanceOf(AuthorizationInputContractError)
    expect(error.code).toBe('AUTHORIZATION_INPUT_BUSY')
    expect(error.status).toBe(409)
    expect(error.retryable).toBe(true)
    expect(error.busyReason).toBe('lock_timeout')
    expect(error.message).toBe('Authorization inputs are busy; retry this change.')
    expect(error.message).not.toContain('users')
    expect((error as { cause?: unknown }).cause).toBe(cause)
    expect(classifyAuthorizationInputBusyCause(pgError('40001', RECOVERY_MARKER))).toBeNull()
    expect(classifyAuthorizationInputBusyCause(pgError('40001'))).toBe('serialization')
    expect(classifyAuthorizationInputBusyCause(new Error('socket hang up'), true)).toBe('connection_lost')
    expect(classifyAuthorizationInputBusyCause(new Error('socket hang up'), false)).toBeNull()
  })
})

describe('self-built entry: exclusive try', () => {
  it('with one attempt the outcome is decided by the single try; MAINTENANCE issues only the try form', async () => {
    const denied = makeFake({ tryExclusive: [false] })
    const sleeps: number[] = []
    const error = await rejection(withAuthorizationInputTransaction({ intent: 'MAINTENANCE' }, async () => 1, { transaction: denied.runner, maintenance: { attempts: 1 }, sleep: async (ms) => { sleeps.push(ms) } }))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'exclusive_exhausted' })
    expect(sleeps).toEqual([])
    expect(denied.sqls().filter((sql) => /advisory/.test(sql))).toEqual([AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry])
    const granted = makeFake({ tryExclusive: [true] })
    await withAuthorizationInputTransaction({ intent: 'MAINTENANCE' }, async () => 1, { transaction: granted.runner, maintenance: { attempts: 1 } })
    expect(granted.sqls().filter((sql) => /advisory/.test(sql))).toEqual([AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry])
    expect(granted.sqls()).toContain('COMMIT')
  })

  it('retries up to the budget with the base delay plus jitter, then reports exhaustion', async () => {
    const sleeps: number[] = []
    const fake = makeFake({ tryExclusive: [false, false, true] })
    await withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive' }, async () => 1, { transaction: fake.runner, exclusive: { attempts: 3 }, sleep: async (ms) => { sleeps.push(ms) }, random: () => 0.5 })
    expect(fake.sqls().filter((sql) => sql === AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry)).toHaveLength(3)
    expect(sleeps).toEqual([250, 250])
    const exhausted = makeFake({ tryExclusive: [false, false, false, false, false] })
    const error = await rejection(withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive' }, async () => 1, { transaction: exhausted.runner, sleep: async () => undefined }))
    expect(error).toMatchObject({ busyReason: 'exclusive_exhausted' })
    expect(exhausted.sqls().filter((sql) => sql === AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry)).toHaveLength(AUTHORIZATION_INPUT_EXCLUSIVE_BUDGET.attempts)
    expect(AUTHORIZATION_INPUT_MAINTENANCE_BUDGET.attempts).toBeGreaterThan(AUTHORIZATION_INPUT_EXCLUSIVE_BUDGET.attempts)
  })

  it('a third concurrent exclusive attempt in the process is busy at once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holders = Array.from({ length: AUTHORIZATION_INPUT_MAX_CONCURRENT_EXCLUSIVE }, () => makeFake({ tryExclusive: [false, true] }))
    const inflight = holders.map((fake) => withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive' }, async () => 1, { transaction: fake.runner, sleep: () => gate }))
    await new Promise((resolve) => setImmediate(resolve))
    const third = makeFake({ tryExclusive: [true] })
    const error = await rejection(withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive' }, async () => 1, { transaction: third.runner }))
    expect(error).toMatchObject({ busyReason: 'exclusive_exhausted' })
    expect(third.sqls().filter((sql) => /advisory/.test(sql))).toEqual([])
    release()
    await Promise.all(inflight)
  })

  it('exclusive start is permitted only for role content writes; a birth plan may not lock users', async () => {
    const fake = makeFake()
    const error = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', world: 'exclusive' }, async () => 1, { transaction: fake.runner }))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'exclusive_not_permitted' })
    expect(fake.sqls()).toEqual([])
    const birth = await rejection(withAuthorizationInputTransaction({ intent: 'BIRTH', userIds: ['u1'] }, async () => 1, { transaction: fake.runner }))
    expect(birth).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'birth_locks_users' })
    expect(fake.sqls()).toEqual([])
    const birthAdmission = await rejection(withAuthorizationInputTransaction({ intent: 'BIRTH', admissionUserIds: ['u1'] }, async () => 1, { transaction: fake.runner }))
    expect(birthAdmission).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'birth_locks_admissions' })
    expect(fake.sqls()).toEqual([])
  })

  it('a plan, a witness and a request for added locks are closed shapes: a key the contract does not define is refused with zero statements', async () => {
    const refused = [
      [{ intent: 'GRANT_ROLE', userId: ['u1'] }, 'plan_unknown_key'],
      [{ intent: 'GRANT_ROLE', witnesses: { userIds: ['a1'] } }, 'plan_unknown_key'],
      [{ intent: 'BIRTH', roleIDs: ['r1'] }, 'plan_unknown_key'],
      [{ intent: 'GRANT_ROLE', [Symbol('userIds')]: ['u1'] }, 'plan_unknown_key'],
      [{ intent: 'GRANT_ROLE', witness: { userId: ['a1'] } }, 'witness_unknown_key'],
      [{ intent: 'BIRTH', witness: { userIds: ['a1'], admissionUserId: ['a1'] } }, 'witness_unknown_key'],
      [{ intent: 'GRANT_ROLE', witness: ['a1'] }, 'witness_unknown_key'],
    ] as unknown as Array<[AuthorizationInputPlan, string]>
    for (const [plan, reason] of refused) {
      const fake = makeFake()
      expect(await rejection(run(plan, async () => 1, fake)), reason).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason })
      expect(fake.sqls()).toEqual([])
    }
    const takeover = makeFake()
    const joined = await rejection(enterAuthorizationInputTransaction(takeover.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync', roleId: ['r1'] } as never, ['isolation_pin'], async () => 1))
    expect(joined).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'plan_unknown_key' })
    expect(takeover.sqls()).toEqual([])
    const adding = makeFake()
    await run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => {
      const before = adding.statements.length
      expect(await rejection(tx.acquire({ admissionUserId: ['m1'] } as never))).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'acquire_request_unknown_key' })
      expect(await rejection(tx.acquire({ admissionUserIds: ['m1'], witness: { userIds: ['a1'] } } as never))).toMatchObject({ reason: 'acquire_request_unknown_key' })
      expect(adding.statements.length).toBe(before)
      return 1
    }, adding)
    // Every key the contract defines is accepted, with or without a value.
    const full = makeFake()
    await run({ intent: 'GRANT_ROLE', userIds: ['u1'], roleIds: ['r1'], admissionUserIds: ['u1'], witness: { userIds: ['a1'], admissionUserIds: ['a1'] }, platformAdminInvariant: false, world: 'shared', sharedAcquire: 'wait', caller: undefined }, async () => 1, full)
    expect(full.sqls()).toContain('COMMIT')
  })

  it('a projection names no top-level user, no top-level admission and no witness: each is refused with zero statements on both entry points; role ids and empty witness lists are accepted', async () => {
    const refused: Array<[AuthorizationInputPlan, string]> = [
      [{ intent: 'PROJECTION_GRANT', userIds: ['u1'] }, 'birth_locks_users'],
      [{ intent: 'PROJECTION_GRANT', admissionUserIds: ['u1'] }, 'birth_locks_admissions'],
      [{ intent: 'PROJECTION_GRANT', witness: { userIds: ['a1'] } }, 'projection_grant_witness'],
      [{ intent: 'PROJECTION_GRANT', witness: { admissionUserIds: ['a1'] } }, 'projection_grant_witness'],
      [{ intent: 'PROJECTION_GRANT', roleIds: ['r1'], witness: { userIds: ['a1'], admissionUserIds: ['a1'] } }, 'projection_grant_witness'],
    ]
    for (const [plan, reason] of refused) {
      const fake = makeFake()
      expect(await rejection(run(plan, async () => 1, fake)), reason).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason })
      expect(fake.sqls()).toEqual([])
      const takeover = makeFake()
      expect(await rejection(enterAuthorizationInputTransaction(takeover.client, { ...plan, caller: 'directory_sync' }, ['isolation_pin'], async () => 1)), reason).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason })
      expect(takeover.sqls()).toEqual([])
    }
    const accepted = makeFake()
    await run({ intent: 'PROJECTION_GRANT', roleIds: ['r1'], witness: { userIds: [], admissionUserIds: [] } }, async () => 1, accepted)
    expect(accepted.sqls().filter((sql) => rankOf(sql) !== null)).toEqual([S.worldShared, S.roleRowShared])
    // A birth still names its witnesses.
    const birth = makeFake()
    await run({ intent: 'BIRTH', witness: { userIds: ['a1'], admissionUserIds: ['a1'] } }, async () => 1, birth)
    expect(birth.sqls()).toContain('COMMIT')
  })
})

describe('plan shape and closed catalogues', () => {
  it('an intent or a caller spelled as an inherited object property is unknown, with zero statements', async () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const fake = makeFake()
      const error = await rejection(withAuthorizationInputTransaction({ intent: name as AuthorizationInputIntent }, async () => 1, { transaction: fake.runner }))
      expect(error, name).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'intent_unknown' })
      expect(fake.sqls()).toEqual([])
      const takeover = makeFake()
      const refused = await rejection(enterAuthorizationInputTransaction(takeover.client, { intent: 'PROJECTION_GRANT', caller: name as never }, [...REGISTERED_TAKEOVER_PREFIXES], async () => 1))
      expect(refused, name).toMatchObject({ code: 'AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', reason: 'caller_not_registered' })
      expect(takeover.sqls()).toEqual([])
    }
    const missing = await rejection(withAuthorizationInputTransaction({} as AuthorizationInputPlan, async () => 1, { transaction: makeFake().runner }))
    expect(missing).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'intent_unknown' })
  })

  it('role rows are planned by the role content intents (for update) and the membership intents (share); a shared-start content intent names no users or admissions', async () => {
    const refuse = async (plan: AuthorizationInputPlan, reason: string) => {
      const fake = makeFake()
      const error = await rejection(withAuthorizationInputTransaction(plan, async () => 1, { transaction: fake.runner }))
      expect(error, JSON.stringify(plan)).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason })
      expect(fake.sqls()).toEqual([])
    }
    for (const intent of AUTHORIZATION_INPUT_INTENTS) {
      if (ROLE_ROW_UPDATE_INTENTS.includes(intent) || ROLE_ROW_SHARE_INTENTS.includes(intent)) continue
      await refuse({ intent, roleIds: ['r1'] }, 'role_ids_not_in_intent')
    }
    await refuse({ intent: 'SET_ADMISSION', roleIds: ['r1'] }, 'role_ids_not_in_intent')
    // A membership intent that names role rows takes them in share mode, before its admissions and users.
    const grant = makeFake()
    await run({ intent: 'GRANT_ROLE', userIds: ['u1'], roleIds: ['r1'] }, async () => 1, grant)
    expect(grant.sqls().filter((sql) => rankOf(sql) !== null)).toEqual([S.worldShared, S.roleRowShared, expect.stringMatching(/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/)])
    const projection = makeFake()
    await run({ intent: 'PROJECTION_GRANT', roleIds: ['r2', 'r1'] }, async () => 1, projection)
    expect(projection.statements.filter((s) => rankOf(s.sql) !== null).map((s) => [s.sql, s.params])).toEqual([[S.worldShared, undefined], [S.roleRowShared, ['r1']], [S.roleRowShared, ['r2']]])
    await refuse({ intent: 'EDIT_ROLE_CONTENT', roleIds: ['r1'], userIds: ['u1'] }, 'content_intent_locks_users')
    await refuse({ intent: 'EDIT_ROLE_CONTENT', roleIds: ['r1'], admissionUserIds: ['u1'] }, 'content_intent_locks_users')
    await refuse({ intent: 'DELETE_ROLE', roleIds: ['r1'], userIds: ['u1'] }, 'content_intent_locks_users')
    await refuse({ intent: 'DELETE_ROLE', roleIds: ['r1'], admissionUserIds: ['u1'] }, 'content_intent_locks_users')
    // Exclusive start may plan holders: the role row, then R5, under the exclusive world lock.
    const exclusive = makeFake()
    await withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive', roleIds: ['r1'], userIds: ['u1'] }, async () => 1, { transaction: exclusive.runner, sleep: async () => undefined })
    const ranks = exclusive.sqls().map(rankOf).filter((rank): rank is number => rank !== null)
    expect(ranks).toEqual([AUTHORIZATION_INPUT_LOCK_RANKS.R0_WORLD, AUTHORIZATION_INPUT_LOCK_RANKS.R2R_ROLE_ROW, AUTHORIZATION_INPUT_LOCK_RANKS.R5_USER_ROW])
    const maintenance = makeFake()
    await withAuthorizationInputTransaction({ intent: 'MAINTENANCE', roleIds: ['r1'] }, async () => 1, { transaction: maintenance.runner, sleep: async () => undefined })
    expect(maintenance.sqls().filter((sql) => rankOf(sql) === AUTHORIZATION_INPUT_LOCK_RANKS.R2R_ROLE_ROW)).toEqual([S.roleRow])
  })

  it('a plan that locks role rows for update carries no witness, in either starting mode, with zero statements', async () => {
    const cells: Array<[string, AuthorizationInputPlan]> = [
      ['EDIT_ROLE_CONTENT shared start', { intent: 'EDIT_ROLE_CONTENT', roleIds: ['r1'], witness: { userIds: ['a1'] } }],
      ['EDIT_ROLE_CONTENT exclusive start', { intent: 'EDIT_ROLE_CONTENT', world: 'exclusive', roleIds: ['r1'], witness: { admissionUserIds: ['a1'] } }],
      ['DELETE_ROLE shared start, witness user', { intent: 'DELETE_ROLE', roleIds: ['r1'], witness: { userIds: ['a1'] } }],
      ['DELETE_ROLE shared start, witness admission', { intent: 'DELETE_ROLE', roleIds: ['r1'], witness: { admissionUserIds: ['a1'] } }],
      ['DELETE_ROLE exclusive start', { intent: 'DELETE_ROLE', world: 'exclusive', roleIds: ['r1'], witness: { userIds: ['a1'], admissionUserIds: ['a1'] } }],
      ['MAINTENANCE', { intent: 'MAINTENANCE', roleIds: ['r1'], witness: { userIds: ['a1'] } }],
      ['MAINTENANCE with a shared world requested', { intent: 'MAINTENANCE', world: 'shared', witness: { admissionUserIds: ['a1'] } }],
    ]
    for (const [name, plan] of cells) {
      const fake = makeFake()
      const error = await rejection(run(plan, async () => 1, fake))
      expect(error, name).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'role_row_update_intent_witness' })
      expect(fake.sqls(), name).toEqual([])
    }
    // An empty witness names nobody and is not refused.
    const empty = makeFake()
    await run({ intent: 'DELETE_ROLE', roleIds: ['r1'], witness: { userIds: [], admissionUserIds: [] } }, async () => 1, empty)
    expect(empty.sqls()).toContain('COMMIT')
  })

  it('a role delete takes R1 only when the plan asks for it, and a plan that names the reserved administrator role is refused with zero statements', async () => {
    const plain = makeFake()
    await run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async () => 1, plain)
    expect(plain.sqls().filter((sql) => rankOf(sql) !== null)).toEqual([S.worldShared, S.roleRow])
    const asked = makeFake()
    await run({ intent: 'DELETE_ROLE', roleIds: ['r1'], platformAdminInvariant: true }, async () => 1, asked)
    expect(asked.sqls().filter((sql) => rankOf(sql) !== null)).toEqual([S.worldShared, S.platformAdminInvariant, S.roleRow])
    for (const roleIds of [['admin'], ['a', 'admin', 'z']]) {
      const fake = makeFake()
      const error = await rejection(run({ intent: 'DELETE_ROLE', roleIds }, async () => 1, fake))
      expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'delete_role_platform_admin' })
      expect(fake.sqls()).toEqual([])
    }
    // Exact equality: an id that only resembles the reserved one is an ordinary role and can be deleted.
    for (const roleId of ['Admin', 'ADMIN', 'admin2', 'x_admin']) {
      const fake = makeFake()
      await run({ intent: 'DELETE_ROLE', roleIds: [roleId] }, async () => 1, fake)
      expect(fake.sqls().filter((sql) => rankOf(sql) !== null), roleId).toEqual([S.worldShared, S.roleRow])
    }
    // Other intents may name the reserved role.
    const edit = makeFake()
    await run({ intent: 'EDIT_ROLE_CONTENT', roleIds: ['admin'] }, async () => 1, edit)
    expect(edit.sqls()).toContain('COMMIT')
  })

  it('ids with surrounding whitespace are refused before any statement', async () => {
    const refuse = async (plan: AuthorizationInputPlan, reason: string) => {
      const fake = makeFake()
      const error = await rejection(withAuthorizationInputTransaction(plan, async () => 1, { transaction: fake.runner }))
      expect(error, JSON.stringify(plan)).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason })
      expect(fake.sqls()).toEqual([])
    }
    await refuse({ intent: 'GRANT_ROLE', userIds: [' u1'] }, 'user_ids_not_canonical')
    await refuse({ intent: 'GRANT_ROLE', userIds: ['u1\n'] }, 'user_ids_not_canonical')
    await refuse({ intent: 'EDIT_ROLE_CONTENT', roleIds: ['r1 '] }, 'role_ids_not_canonical')
    await refuse({ intent: 'SET_ADMISSION', admissionUserIds: ['\tu1'] }, 'admission_user_ids_not_canonical')
    await refuse({ intent: 'GRANT_ROLE', userIds: ['  '] }, 'user_ids_blank')
  })

  it('the two refusals that fail no statement restore the caller timeouts before they are raised', async () => {
    const tryRefused = makeFake({ trySharedAcquired: false, savedTimeouts: { lock_timeout: '3s', statement_timeout: '30s' } })
    await rejection(enterAuthorizationInputTransaction(tryRefused.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync', sharedAcquire: 'try' }, [...REGISTERED_TAKEOVER_PREFIXES], async () => 1))
    const trySqls = tryRefused.statements.map((s) => [s.sql, s.params] as const)
    expect(trySqls.at(-2)?.[0]).toBe(AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry)
    expect(trySqls.at(-1)).toEqual([AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, ['3s', '30s']])
    const missingRole = makeFake({ roleRows: new Set(['r1']), savedTimeouts: { lock_timeout: '3s', statement_timeout: '30s' } })
    await withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', roleIds: ['r9'] }, async () => 1, { transaction: missingRole.runner, sleep: async () => undefined })
    const first = missingRole.statements.slice(0, missingRole.sqls().indexOf('ROLLBACK'))
    expect(first.at(-2)?.sql).toBe(AUTHORIZATION_INPUT_STATEMENTS.roleRow)
    expect([first.at(-1)?.sql, first.at(-1)?.params]).toEqual([AUTHORIZATION_INPUT_STATEMENTS.setTimeouts, ['3s', '30s']])
    expect(first.filter((s) => s.sql === AUTHORIZATION_INPUT_STATEMENTS.setTimeouts)).toHaveLength(2)
    // After a failed statement the transaction is aborted: nothing is restored.
    const aborted = makeFake({ failAt: { match: 'pg_advisory_xact_lock_shared', error: pgError('55P03') } })
    await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async () => 1, { transaction: aborted.runner }))
    expect(aborted.statements.filter((s) => s.sql === AUTHORIZATION_INPUT_STATEMENTS.setTimeouts)).toHaveLength(1)
  })
})

describe('self-built entry: upgrade and re-run', () => {
  it('a shared attempt that requests the upgrade is rolled back and the work re-runs once in exclusive mode', async () => {
    const fake = makeFake()
    const worlds: string[] = []
    const result = await withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', roleIds: ['r1'] }, async (tx) => {
      worlds.push(tx.world)
      if (tx.world === 'shared') throw new AuthorizationInputUpgradeRequired('added_raising_code')
      return 'written'
    }, { transaction: fake.runner, sleep: async () => undefined })
    expect(result).toBe('written')
    expect(worlds).toEqual(['shared', 'exclusive'])
    const sqls = fake.sqls()
    expect(sqls.filter((sql) => sql === 'BEGIN')).toHaveLength(2)
    expect(sqls.filter((sql) => sql === 'ROLLBACK')).toHaveLength(1)
    expect(sqls.filter((sql) => sql === 'COMMIT')).toHaveLength(1)
    expect(sqls.filter((sql) => rankOf(sql) === 0)).toEqual([AUTHORIZATION_INPUT_STATEMENTS.worldShared, AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry])
  })

  it('a second upgrade request is AUTHORIZATION_INPUT_UPGRADE_LOOP; a non-upgradeable intent cannot upgrade', async () => {
    const fake = makeFake()
    const loop = await rejection(withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT' }, async () => {
      throw new AuthorizationInputUpgradeRequired('again')
    }, { transaction: fake.runner, sleep: async () => undefined }))
    expect(loop).toMatchObject({ code: 'AUTHORIZATION_INPUT_UPGRADE_LOOP', reason: 'exclusive_requested_twice' })
    expect(fake.sqls().filter((sql) => sql === 'BEGIN')).toHaveLength(2)
    const other = makeFake()
    const refused = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async () => {
      throw new AuthorizationInputUpgradeRequired('x')
    }, { transaction: other.runner }))
    expect(refused).toMatchObject({ code: 'AUTHORIZATION_INPUT_UPGRADE_LOOP', reason: 'intent_not_upgradeable' })
    expect(other.sqls().filter((sql) => sql === 'BEGIN')).toHaveLength(1)
  })

  it('a planned role row that does not exist upgrades a shared attempt before work runs and is reported in exclusive mode', async () => {
    const fake = makeFake({ roleRows: new Set(['r1']) })
    let calls = 0
    const missing = await withAuthorizationInputTransaction({ intent: 'EDIT_ROLE_CONTENT', roleIds: ['r1', 'r9'] }, async (tx) => {
      calls += 1
      return [tx.world, [...tx.missingRoleIds]]
    }, { transaction: fake.runner, sleep: async () => undefined })
    expect(calls).toBe(1)
    expect(missing).toEqual(['exclusive', ['r9']])
  })
})

describe('missing role rows', () => {
  it('a missing row planned by a role delete is recorded and never upgrades: one shared pass, no R1, no exclusive try', async () => {
    const fake = makeFake({ roleRows: new Set(['r1']), savedTimeouts: { lock_timeout: '3s', statement_timeout: '30s' } })
    let calls = 0
    const seen = await run({ intent: 'DELETE_ROLE', roleIds: ['r9'] }, async (tx) => {
      calls += 1
      return { world: tx.world, state: tx.roleRows.get('r9'), size: tx.roleRows.size, missing: [...tx.missingRoleIds] }
    }, fake)
    expect(calls).toBe(1)
    expect(seen).toEqual({ world: 'shared', state: 'missing', size: 1, missing: ['r9'] })
    expect(fake.statements.map((s) => [s.sql, s.params])).toEqual([
      ['BEGIN', undefined],
      [S.setTransaction, undefined],
      [S.readTimeouts, undefined],
      [S.setTimeouts, [String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)]],
      [S.worldShared, undefined],
      [S.roleRow, ['r9']],
      [S.setTimeouts, ['3s', '30s']],
      ['COMMIT', undefined],
      ['release', undefined],
    ])
  })

  it('a missing row planned by a role delete whose plan asks for R1: R1 is taken, and the row is still recorded without an upgrade', async () => {
    const fake = makeFake({ roleRows: new Set() })
    let calls = 0
    const seen = await run({ intent: 'DELETE_ROLE', roleIds: ['r9'], platformAdminInvariant: true }, async (tx) => {
      calls += 1
      return { world: tx.world, state: tx.roleRows.get('r9'), missing: [...tx.missingRoleIds] }
    }, fake)
    expect(calls).toBe(1)
    expect(seen).toEqual({ world: 'shared', state: 'missing', missing: ['r9'] })
    expect(fake.sqls().filter((sql) => rankOf(sql) !== null)).toEqual([S.worldShared, S.platformAdminInvariant, S.roleRow])
    expect(fake.sqls()).not.toContain(S.worldExclusiveTry)
    expect(fake.sqls()).not.toContain('ROLLBACK')
  })

  it('a missing row planned by a membership intent is recorded and never upgrades; held and missing rows are told apart', async () => {
    for (const intent of ROLE_ROW_SHARE_INTENTS) {
      const fake = makeFake({ roleRows: new Set(['r1']) })
      let calls = 0
      const seen = await run({ intent, roleIds: ['r9', 'r1'] }, async (tx) => {
        calls += 1
        return { world: tx.world, rows: [...tx.roleRows], missing: [...tx.missingRoleIds] }
      }, fake)
      expect(calls, intent).toBe(1)
      expect(seen, intent).toEqual({ world: 'shared', rows: [['r1', 'held'], ['r9', 'missing']], missing: ['r9'] })
      expect(fake.sqls().filter((sql) => rankOf(sql) === R.R2R_ROLE_ROW), intent).toEqual([S.roleRowShared, S.roleRowShared])
      expect(fake.sqls(), intent).not.toContain(S.worldExclusiveTry)
      expect(fake.sqls(), intent).not.toContain('ROLLBACK')
    }
  })

  it('a missing row planned by a role content edit upgrades before work; a domain error raised by work in the exclusive pass is passed through unchanged', async () => {
    const fake = makeFake({ roleRows: new Set() })
    const domain = Object.assign(new Error('role not found'), { status: 404 })
    const worlds: string[] = []
    const error = await rejection(run({ intent: 'EDIT_ROLE_CONTENT', roleIds: ['r9'] }, async (tx) => {
      worlds.push(tx.world)
      expect(tx.roleRows.get('r9')).toBe('missing')
      throw domain
    }, fake))
    expect(error).toBe(domain)
    expect(worlds).toEqual(['exclusive'])
    expect(fake.sqls().filter((sql) => rankOf(sql) === 0)).toEqual([S.worldShared, S.worldExclusiveTry])
    expect(fake.sqls().filter((sql) => sql === 'ROLLBACK')).toHaveLength(2)
    expect(fake.sqls()).not.toContain('COMMIT')
    expect(fake.sqls().some((sql) => /\b(?:INSERT|UPDATE\s+\w+\s+SET|DELETE)\b/.test(sql))).toBe(false)
  })

  it('in exclusive mode a missing row is recorded as missing, never as held, in both the map and the list', async () => {
    const edit = makeFake({ roleRows: new Set(['r1']) })
    const seen = await run({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive', roleIds: ['r1', 'r9'] }, async (tx) => ({ rows: [...tx.roleRows], missing: [...tx.missingRoleIds] }), edit)
    expect(seen).toEqual({ rows: [['r1', 'held'], ['r9', 'missing']], missing: ['r9'] })
    const maintenance = makeFake({ roleRows: new Set() })
    const other = await run({ intent: 'MAINTENANCE', roleIds: ['r9'] }, async (tx) => ({ rows: [...tx.roleRows], missing: [...tx.missingRoleIds] }), maintenance)
    expect(other).toEqual({ rows: [['r9', 'missing']], missing: ['r9'] })
  })

  it('a check that needs the row lock refuses a missing row and an unplanned id with zero statements, and passes a held row', async () => {
    const fake = makeFake({ roleRows: new Set(['r1']) })
    await run({ intent: 'GRANT_ROLE', roleIds: ['r1', 'r9'] }, async (tx) => {
      const before = fake.statements.length
      expect(() => tx.requireRoleRows(['r1'])).not.toThrow()
      expect(() => tx.requireRoleRows([])).not.toThrow()
      expect(tx.roleRows.has('r9')).toBe(true)
      expect(() => tx.requireRoleRows(['r9'])).toThrow(expect.objectContaining({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'role_row_not_held' }))
      expect(() => tx.requireRoleRows(['r1', 'r9'])).toThrow(expect.objectContaining({ reason: 'role_row_not_held' }))
      expect(() => tx.requireRoleRows(['r2'])).toThrow(expect.objectContaining({ reason: 'role_row_not_held' }))
      expect(fake.statements.length).toBe(before)
      expect(() => (tx.roleRows as Map<string, string>).set('r9', 'held')).toThrow(TypeError)
      return 1
    }, fake)
  })
})

describe('witnesses', () => {
  const userLock = expect.stringMatching(/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/)

  it('a birth that names only witness users takes R5 and no R3; naming both lists takes role rows, R3, then R5, all before work', async () => {
    const usersOnly = makeFake()
    let workAt = -1
    await run({ intent: 'BIRTH', witness: { userIds: ['a1'] } }, async (tx) => {
      workAt = usersOnly.statements.length
      expect([...tx.witnessed.userIds]).toEqual(['a1'])
      expect([...tx.witnessed.admissionUserIds]).toEqual([])
      expect(tx.locked.has('a1')).toBe(true)
      return 1
    }, usersOnly)
    expect(usersOnly.statements.filter((s) => rankOf(s.sql) !== null).map((s) => [s.sql, s.params])).toEqual([[S.worldShared, undefined], [userLock, ['a1']]])
    expect(usersOnly.sqls()).not.toContain(S.namespaceAdmission)
    expect(Math.max(...usersOnly.statements.map((s, i) => (rankOf(s.sql) !== null ? i : -1)))).toBeLessThan(workAt)

    const both = makeFake()
    await run({ intent: 'BIRTH', roleIds: ['r1'], witness: { userIds: ['a1'], admissionUserIds: ['a1'] } }, async (tx) => {
      workAt = both.statements.length
      expect([...tx.witnessed.admissionUserIds]).toEqual(['a1'])
      expect(tx.roleRows.get('r1')).toBe('held')
      return 1
    }, both)
    expect(both.statements.filter((s) => rankOf(s.sql) !== null).map((s) => [s.sql, s.params])).toEqual([
      [S.worldShared, undefined],
      [S.roleRowShared, ['r1']],
      [S.namespaceAdmission, ['namespace-admission:a1']],
      [userLock, ['a1']],
    ])
    expect(Math.max(...both.statements.map((s, i) => (rankOf(s.sql) !== null ? i : -1)))).toBeLessThan(workAt)

    const admissionOnly = makeFake()
    await run({ intent: 'BIRTH', witness: { admissionUserIds: ['a1'] } }, async () => 1, admissionOnly)
    expect(admissionOnly.sqls().filter((sql) => rankOf(sql) !== null)).toEqual([S.worldShared, S.namespaceAdmission])
  })

  it('a birth with witnesses and no role ids is accepted; a row returned by the birth insert that this transaction locked is refused', async () => {
    const fake = makeFake()
    const born = await run({ intent: 'BIRTH', witness: { userIds: ['a1'], admissionUserIds: ['a1'] } }, async (tx) => {
      const { id } = await tx.insertUserForBirth({ id: 'new-1', username: 'new-1', role: 'user' })
      return { id, born: [...tx.born], roleRows: tx.roleRows.size }
    }, fake)
    expect(born).toEqual({ id: 'new-1', born: ['new-1'], roleRows: 0 })
    const existing = makeFake()
    const error = await rejection(run({ intent: 'BIRTH', witness: { userIds: ['a1'] } }, async (tx) => tx.insertUserForBirth({ id: 'a1', username: 'a1' }), existing))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'birth_row_already_locked' })
    expect(existing.sqls()).toContain('ROLLBACK')
    expect(existing.sqls()).not.toContain('COMMIT')
  })

  it('witnesses merge with the targets of their rank, de-duplicated and in code-unit order, and the entry adds no lock the plan did not name', async () => {
    const fake = makeFake()
    await run({ intent: 'GRANT_ROLE', userIds: ['u2', 'a1'], admissionUserIds: ['u2'], roleIds: ['r1'], witness: { userIds: ['a1', 'U0'], admissionUserIds: ['a1', 'u2'] } }, async (tx) => {
      expect([...tx.witnessed.userIds].sort()).toEqual(['U0', 'a1'])
      expect([...tx.witnessed.admissionUserIds].sort()).toEqual(['a1', 'u2'])
      expect([...tx.locked.keys()].sort()).toEqual(['U0', 'a1', 'u2'])
      expect(() => (tx.witnessed.userIds as Set<string>).add('x')).toThrow(TypeError)
      return 1
    }, fake)
    expect(fake.statements.filter((s) => rankOf(s.sql) !== null).map((s) => [s.sql, s.params])).toEqual([
      [S.worldShared, undefined],
      [S.roleRowShared, ['r1']],
      [S.namespaceAdmission, ['namespace-admission:a1']],
      [S.namespaceAdmission, ['namespace-admission:u2']],
      [userLock, ['U0']],
      [userLock, ['a1']],
      [userLock, ['u2']],
    ])
    // A witness named for R5 only takes no admission lock, for any intent.
    const r5Only = makeFake()
    await run({ intent: 'CONSUME_CLASS_DECISION', userIds: ['u1'], witness: { userIds: ['a1'] } }, async () => 1, r5Only)
    expect(r5Only.sqls()).not.toContain(S.namespaceAdmission)
    expect(r5Only.statements.filter((s) => rankOf(s.sql) === R.R5_USER_ROW).map((s) => s.params)).toEqual([['a1'], ['u1']])
    const none = makeFake()
    await run({ intent: 'GRANT_ROLE', userIds: ['u1'] }, async (tx) => {
      expect(tx.witnessed.userIds.size + tx.witnessed.admissionUserIds.size).toBe(0)
      return 1
    }, none)
  })

  it('a witness whose user row does not exist is not listed as locked: it is absent from the witnessed rows and from the lock set, and a held-row check refuses it', async () => {
    const fake = makeFake({ userRows: new Set(['a1']) })
    await run({ intent: 'BIRTH', witness: { userIds: ['gone', 'a1'], admissionUserIds: ['gone'] } }, async (tx) => {
      expect([...tx.witnessed.userIds]).toEqual(['a1'])
      expect([...tx.witnessed.admissionUserIds]).toEqual(['gone'])
      expect([...tx.locked.keys()]).toEqual(['a1'])
      expect(() => tx.requireUserRows(['a1'])).not.toThrow()
      let refusal: unknown
      try {
        tx.requireUserRows(['gone'])
      } catch (error) {
        refusal = error
      }
      expect(refusal).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'user_row_not_held' })
      return 1
    }, fake)
    // Both row locks were requested; one returned no row.
    expect(fake.statements.filter((s) => rankOf(s.sql) === R.R5_USER_ROW).map((s) => s.params)).toEqual([['a1'], ['gone']])
  })

  it('witness ids obey the same canonical-id rule as targets, with zero statements', async () => {
    for (const [plan, reason] of [
      [{ intent: 'GRANT_ROLE', witness: { userIds: [' a1'] } }, 'witness_user_ids_not_canonical'],
      [{ intent: 'GRANT_ROLE', witness: { admissionUserIds: [''] } }, 'witness_admission_user_ids_blank'],
      [{ intent: 'GRANT_ROLE', witness: 'a1' }, 'witness_not_object'],
    ] as unknown as Array<[AuthorizationInputPlan, string]>) {
      const fake = makeFake()
      expect(await rejection(run(plan, async () => 1, fake))).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason })
      expect(fake.sqls()).toEqual([])
    }
  })
})

describe('locks added by work', () => {
  const userLock = expect.stringMatching(/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/)

  it('a role delete adds the admission locks of the members it read: world, role row for update, then one R3 batch in code-unit order inside its own timeout window', async () => {
    for (const roleRows of [new Set(['r1']), new Set<string>()]) {
      const fake = makeFake({ roleRows, savedTimeouts: { lock_timeout: '3s', statement_timeout: '30s' } })
      await run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => {
        await tx.query('SELECT user_id FROM user_roles WHERE role_id = $1', ['r1'])
        await tx.acquire({ admissionUserIds: ['m2', 'm1', 'm2'] })
        await tx.query('SELECT 2')
        return 1
      }, fake)
      expect(fake.statements.map((s) => [s.sql, s.params])).toEqual([
        ['BEGIN', undefined],
        [S.setTransaction, undefined],
        [S.readTimeouts, undefined],
        [S.setTimeouts, [String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)]],
        [S.worldShared, undefined],
        [S.roleRow, ['r1']],
        [S.setTimeouts, ['3s', '30s']],
        ['SELECT user_id FROM user_roles WHERE role_id = $1', ['r1']],
        [S.readTimeouts, undefined],
        [S.setTimeouts, [String(AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS), String(AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS)]],
        [S.namespaceAdmission, ['namespace-admission:m1']],
        [S.namespaceAdmission, ['namespace-admission:m2']],
        [S.setTimeouts, ['3s', '30s']],
        ['SELECT 2', undefined],
        ['COMMIT', undefined],
        ['release', undefined],
      ])
      expect(lockRanks(fake.sqls())).toEqual([R.R0_WORLD, R.R2R_ROLE_ROW, R.R3_NAMESPACE_ADMISSION, R.R3_NAMESPACE_ADMISSION])
    }
  })

  it('a request below a rank already taken is refused with zero statements', async () => {
    const fake = makeFake()
    await run({ intent: 'GRANT_ROLE', userIds: ['u1'] }, async (tx) => {
      const before = fake.statements.length
      expect(await rejection(tx.acquire({ admissionUserIds: ['u2'] }))).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'acquire_rank_regression' })
      expect(fake.statements.length).toBe(before)
      return 1
    }, fake)
    const exclusive = makeFake()
    await run({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive', roleIds: ['r1'], userIds: ['u1'] }, async (tx) => {
      const before = exclusive.statements.length
      expect(await rejection(tx.acquire({ admissionUserIds: ['u2'], userIds: ['u3'] }))).toMatchObject({ reason: 'acquire_rank_regression' })
      expect(exclusive.statements.length).toBe(before)
      return 1
    }, exclusive)
  })

  it('in shared mode a rank is taken in one batch: a second batch of new ids is refused with zero statements, at the entry\'s rank as well', async () => {
    const fake = makeFake()
    await run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => {
      await tx.acquire({ admissionUserIds: ['m1'] })
      const before = fake.statements.length
      expect(await rejection(tx.acquire({ admissionUserIds: ['m2'] }))).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'acquire_rank_repeated' })
      expect(await rejection(tx.acquire({ admissionUserIds: ['m0', 'm1'] }))).toMatchObject({ reason: 'acquire_rank_repeated' })
      expect(fake.statements.length).toBe(before)
      return 1
    }, fake)
    const entryBatch = makeFake()
    await run({ intent: 'SET_ADMISSION', admissionUserIds: ['u1'] }, async (tx) => {
      const before = entryBatch.statements.length
      expect(await rejection(tx.acquire({ admissionUserIds: ['u2'] }))).toMatchObject({ reason: 'acquire_rank_repeated' })
      expect(entryBatch.statements.length).toBe(before)
      return 1
    }, entryBatch)
  })

  it('a lock added by work raises the highest rank taken: a later request below it is refused as a rank regression, with zero statements', async () => {
    const fake = makeFake()
    await run({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive', roleIds: ['r1'] }, async (tx) => {
      await tx.acquire({ userIds: ['h1'] })
      const before = fake.statements.length
      expect(await rejection(tx.acquire({ admissionUserIds: ['u2'] }))).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'acquire_rank_regression' })
      expect(fake.statements.length).toBe(before)
      return 1
    }, fake)
  })

  it('one request for added locks at a time: a second request made before the first settles is refused with zero statements of its own, in both world modes', async () => {
    const shared = makeFake()
    await run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => {
      const before = shared.statements.length
      const settled = await Promise.allSettled([tx.acquire({ admissionUserIds: ['m2'] }), tx.acquire({ admissionUserIds: ['m1'] })])
      expect(settled[0].status).toBe('fulfilled')
      expect(settled[1]).toMatchObject({ status: 'rejected', reason: { code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'acquire_in_progress' } })
      expect(shared.statements.slice(before).filter((s) => rankOf(s.sql) !== null).map((s) => s.params)).toEqual([['namespace-admission:m2']])
      // Once the first has settled the batch rule answers: the rank was taken in one batch.
      expect(await rejection(tx.acquire({ admissionUserIds: ['m1'] }))).toMatchObject({ reason: 'acquire_rank_repeated' })
      return 1
    }, shared)

    const exclusive = makeFake()
    await run({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive', roleIds: ['r1'] }, async (tx) => {
      const settled = await Promise.allSettled([tx.acquire({ userIds: ['h2'] }), tx.acquire({ userIds: ['h1'] }), tx.acquire({ userIds: ['h2'] })])
      expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'rejected'])
      expect(settled[1]).toMatchObject({ reason: { reason: 'acquire_in_progress' } })
      expect(settled[2]).toMatchObject({ reason: { reason: 'acquire_in_progress' } })
      // The flag is cleared when the request settles: the next one is served.
      await tx.acquire({ userIds: ['h3'] })
      return 1
    }, exclusive)
    expect(exclusive.statements.filter((s) => rankOf(s.sql) === R.R5_USER_ROW).map((s) => s.params)).toEqual([['h2'], ['h3']])

    // Requests issued together and awaited together fail the work with the refusal: nothing commits.
    const together = makeFake()
    const error = await rejection(run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => Promise.all(['m1', 'm2'].map((userId) => tx.acquire({ admissionUserIds: [userId] }))), together))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'acquire_in_progress' })
    expect(together.sqls()).not.toContain('COMMIT')
    expect(together.statements.map((s) => s.params?.[0])).not.toContain('namespace-admission:m2')

    // A request that fails clears the flag as well.
    const failing = makeFake({ failAt: { match: 'hashtextextended($1', error: pgError('55P03') } })
    await rejection(run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => {
      expect(await rejection(tx.acquire({ admissionUserIds: ['m1'] }))).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY' })
      expect(await rejection(tx.acquire({ admissionUserIds: ['m2'] }))).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY' })
      throw new Error('aborted')
    }, failing))
  })

  it('only a role delete (admission locks) and an exclusive role content edit (user rows) may add locks; every other request is refused with zero statements', async () => {
    const refused: Array<[AuthorizationInputPlan, Parameters<AuthorizationInputTx['acquire']>[0]]> = [
      [{ intent: 'GRANT_ROLE' }, { admissionUserIds: ['u1'] }],
      [{ intent: 'GRANT_ROLE' }, { userIds: ['u1'] }],
      [{ intent: 'BIRTH' }, { userIds: ['u1'] }],
      [{ intent: 'DELETE_ROLE', roleIds: ['r1'] }, { userIds: ['u1'] }],
      [{ intent: 'DELETE_ROLE', roleIds: ['r1'] }, { admissionUserIds: ['m1'], userIds: ['u1'] }],
      [{ intent: 'EDIT_ROLE_CONTENT', roleIds: ['r1'] }, { userIds: ['u1'] }],
      [{ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive', roleIds: ['r1'] }, { admissionUserIds: ['u1'] }],
      [{ intent: 'MAINTENANCE', roleIds: ['r1'] }, { userIds: ['u1'] }],
    ]
    for (const [plan, request] of refused) {
      const fake = makeFake()
      await run(plan, async (tx) => {
        const before = fake.statements.length
        expect(await rejection(tx.acquire(request)), JSON.stringify([plan, request])).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'acquire_not_open' })
        expect(fake.statements.length).toBe(before)
        return 1
      }, fake)
    }
  })

  it('an exclusive role content edit adds the rows of the holders it read, after the rows the plan named; ids already held cost no statement and count as no batch', async () => {
    const fake = makeFake()
    await run({ intent: 'EDIT_ROLE_CONTENT', world: 'exclusive', roleIds: ['r1'], userIds: ['h1'] }, async (tx) => {
      await tx.acquire({ userIds: ['h3', 'h1', 'h2'] })
      expect([...tx.locked.keys()].sort()).toEqual(['h1', 'h2', 'h3'])
      const before = fake.statements.length
      await tx.acquire({ userIds: ['h2', 'h1'] })
      await tx.acquire({})
      expect(fake.statements.length).toBe(before)
      await tx.acquire({ userIds: ['h4'] })
      expect(tx.locked.has('h4')).toBe(true)
      expect(() => tx.requireUserRows(['h1', 'h2', 'h3', 'h4'])).not.toThrow()
      return 1
    }, fake)
    expect(fake.statements.filter((s) => rankOf(s.sql) !== null).map((s) => [s.sql, s.params])).toEqual([
      [S.worldExclusiveTry, undefined],
      [S.roleRow, ['r1']],
      [userLock, ['h1']],
      [userLock, ['h2']],
      [userLock, ['h3']],
      [userLock, ['h4']],
    ])
    const held = makeFake()
    await run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => {
      await tx.acquire({ admissionUserIds: ['m1', 'm2'] })
      const before = held.statements.length
      await tx.acquire({ admissionUserIds: ['m2'] })
      await tx.acquire({ admissionUserIds: ['m1', 'm2'] })
      expect(held.statements.length).toBe(before)
      return 1
    }, held)
    // Held ids are skipped for any intent, so a request that names only held ids is never refused.
    const member = makeFake()
    await run({ intent: 'GRANT_ROLE', userIds: ['u1'], admissionUserIds: ['u1'] }, async (tx) => {
      const before = member.statements.length
      await tx.acquire({ admissionUserIds: ['u1'], userIds: ['u1'] })
      expect(member.statements.length).toBe(before)
      return 1
    }, member)
  })

  it('a lock added by work that fails is busy, and a closed token adds nothing', async () => {
    const fake = makeFake({ failAt: { match: 'hashtextextended($1', error: pgError('55P03') } })
    const error = await rejection(run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => tx.acquire({ admissionUserIds: ['m1'] }), fake))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'lock_timeout' })
    expect(fake.sqls()).toContain('ROLLBACK')
    // After the failed statement nothing is restored: the transaction is aborted.
    expect(fake.statements.filter((s) => s.sql === S.setTimeouts)).toHaveLength(3)
    const closed = makeFake()
    let token!: AuthorizationInputTx
    await run({ intent: 'DELETE_ROLE', roleIds: ['r1'] }, async (tx) => {
      token = tx
      return 1
    }, closed)
    const before = closed.statements.length
    expect(await rejection(token.acquire({ admissionUserIds: ['m1'] }))).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'token_closed' })
    expect(closed.statements.length).toBe(before)
  })

  it('a write that references user rows is refused with zero statements unless each is locked by this transaction or was created by it', async () => {
    const fake = makeFake()
    await run({ intent: 'SET_DELEGATED_SCOPE', userIds: ['u1'], witness: { userIds: ['a1'], admissionUserIds: ['a2'] } }, async (tx) => {
      const before = fake.statements.length
      expect(() => tx.requireUserRows(['u1'])).not.toThrow()
      expect(() => tx.requireUserRows(['a1'])).not.toThrow()
      expect(() => tx.requireUserRows(['u1', 'a1'])).not.toThrow()
      expect(() => tx.requireUserRows([])).not.toThrow()
      expect(() => tx.requireUserRows(['u9'])).toThrow(expect.objectContaining({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'user_row_not_held' }))
      expect(() => tx.requireUserRows(['u1', 'u9'])).toThrow(expect.objectContaining({ reason: 'user_row_not_held' }))
      // An admission lock is not a row lock.
      expect(() => tx.requireUserRows(['a2'])).toThrow(expect.objectContaining({ reason: 'user_row_not_held' }))
      expect(fake.statements.length).toBe(before)
      return 1
    }, fake)
    const birth = makeFake()
    await run({ intent: 'BIRTH', witness: { userIds: ['a1'] } }, async (tx) => {
      expect(() => tx.requireUserRows(['new-1'])).toThrow(expect.objectContaining({ reason: 'user_row_not_held' }))
      const { id } = await tx.insertUserForBirth({ id: 'new-1', username: 'new-1' })
      expect(() => tx.requireUserRows([id, 'a1'])).not.toThrow()
      return 1
    }, birth)
  })
})

describe('pull-source gate marker', () => {
  it('while the marker is set both entry points refuse before any statement; outside it they are unaffected', async () => {
    const fake = makeFake()
    const takeover = makeFake()
    await runInsidePullSourceGate(async () => {
      expect(isInsidePullSourceGate()).toBe(true)
      await new Promise((resolve) => setImmediate(resolve))
      const self = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', userIds: ['u1'] }, async () => 1, { transaction: fake.runner }))
      expect(self).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'inside_pull_source_gate', retryable: false })
      const joined = await rejection(enterAuthorizationInputTransaction(takeover.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], async () => 1))
      expect(joined).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'inside_pull_source_gate' })
      // The refusal comes before plan validation: an invalid plan is reported as the marker refusal.
      const invalid = await rejection(withAuthorizationInputTransaction({} as AuthorizationInputPlan, async () => 1, { transaction: fake.runner }))
      expect(invalid).toMatchObject({ reason: 'inside_pull_source_gate' })
    })
    expect(fake.sqls()).toEqual([])
    expect(takeover.sqls()).toEqual([])
    expect(isInsidePullSourceGate()).toBe(false)
    await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', userIds: ['u1'] }, async () => 1, { transaction: fake.runner })
    expect(fake.sqls()).toContain('COMMIT')
    await enterAuthorizationInputTransaction(takeover.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], async () => 1)
    expect(takeover.sqls()).toContain(S.worldShared)
  })

  it('the marker module imports nothing from the package', () => {
    const source = readFileSync(path.join(SRC, 'directory', 'pull-source-gate-context.ts'), 'utf8')
    const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
    const specifiers = file.statements.flatMap((statement) => (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : []))
    expect(specifiers).toEqual(['node:async_hooks'])
    expect(source).not.toMatch(/require\(|import\(/)
  })
})

describe('takeover entry', () => {
  it('an intent outside the caller\'s closure, or an upgrade request inside, is AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER with zero write statements', async () => {
    const fake = makeFake()
    const outside = await rejection(enterAuthorizationInputTransaction(fake.client, { intent: 'EDIT_ROLE_CONTENT', caller: 'directory_sync' }, ['isolation_pin'], async () => 1))
    expect(outside).toMatchObject({ code: 'AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', reason: 'intent_outside_closure' })
    expect(fake.sqls()).toEqual([])
    const unregistered = await rejection(enterAuthorizationInputTransaction(fake.client, { intent: 'PROJECTION_GRANT' }, ['isolation_pin'], async () => 1))
    expect(unregistered).toMatchObject({ code: 'AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', reason: 'caller_not_registered' })
    expect(fake.sqls()).toEqual([])
    const inside = await rejection(enterAuthorizationInputTransaction(fake.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], async (tx) => {
      await tx.query('SELECT 1')
      throw new AuthorizationInputUpgradeRequired('added_raising_code')
    }))
    expect(inside).toMatchObject({ code: 'AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER', reason: 'added_raising_code' })
    expect(fake.sqls().some((sql) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false)
    const exclusive = await rejection(enterAuthorizationInputTransaction(fake.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync', world: 'exclusive' }, ['isolation_pin'], async () => 1))
    expect(exclusive).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })
  })

  it('accepts only the caller\'s registered prefix list and probes the isolation level before any lock', async () => {
    const fake = makeFake()
    const wrong = await rejection(enterAuthorizationInputTransaction(fake.client, { intent: 'CASCADE_PARENT_DELETE', caller: 'controlled_handover' }, ['isolation_pin'], async () => 1))
    expect(wrong).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'prefix_not_registered' })
    const bogus = await rejection(enterAuthorizationInputTransaction(fake.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['lock_timeout_set' as never], async () => 1))
    expect(bogus).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'prefix_not_registered' })
    expect(fake.sqls()).toEqual([])
    const rr = makeFake({ isolation: 'repeatable read' })
    const isolation = await rejection(enterAuthorizationInputTransaction(rr.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], async () => 1))
    expect(isolation).toMatchObject({ code: 'AUTHORIZATION_INPUT_ISOLATION' })
    expect(rr.sqls()).toEqual([AUTHORIZATION_INPUT_STATEMENTS.isolationProbe])
  })

  it('takes the world lock shared under the timeout window, issues no SET TRANSACTION, attaches no listener and maps a lock timeout to busy', async () => {
    const fake = makeFake()
    const result = await enterAuthorizationInputTransaction(fake.client, { intent: 'CASCADE_PARENT_DELETE', caller: 'controlled_handover' }, [], async (tx) => {
      await tx.query('SELECT 1')
      return tx.world
    })
    expect(result).toBe('shared')
    expect(fake.sqls()).toEqual([
      AUTHORIZATION_INPUT_STATEMENTS.isolationProbe,
      AUTHORIZATION_INPUT_STATEMENTS.readTimeouts,
      AUTHORIZATION_INPUT_STATEMENTS.setTimeouts,
      AUTHORIZATION_INPUT_STATEMENTS.worldShared,
      AUTHORIZATION_INPUT_STATEMENTS.setTimeouts,
      'SELECT 1',
    ])
    expect(fake.raw.listenerCount('error')).toBe(0)
    const busy = makeFake({ failAt: { match: 'pg_advisory_xact_lock_shared', error: pgError('55P03') } })
    const error = await rejection(enterAuthorizationInputTransaction(busy.client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], async () => 1))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'lock_timeout' })
  })
})

describe('tokens', () => {
  it('a forged object, a closed token, another connection\'s token and a missing target are refused before any statement', async () => {
    const fake = makeFake()
    const other = makeFake()
    let token!: AuthorizationInputTx
    await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', userIds: ['u1'] }, async (tx) => {
      token = tx
      expect(tx.open).toBe(true)
      expect(() => assertAuthorizationInputTx(tx, { client: fake.client, userId: 'u1' })).not.toThrow()
      expect(() => assertAuthorizationInputTx(tx, { client: other.client, userId: 'u1' })).toThrow(expect.objectContaining({ reason: 'other_connection' }))
      expect(() => assertAuthorizationInputTx(tx, { client: fake.client, userId: '' })).toThrow(expect.objectContaining({ reason: 'missing_target' }))
      expect(() => assertAuthorizationInputTx({ ...tx }, { client: fake.client, userId: 'u1' })).toThrow(expect.objectContaining({ reason: 'unbranded' }))
      expect(() => assertAuthorizationInputTx({ id: 'u1' }, { client: fake.client, userId: 'u1' })).toThrow(expect.objectContaining({ reason: 'unbranded' }))
      return 1
    }, { transaction: fake.runner })
    expect(token.open).toBe(false)
    const before = fake.statements.length
    expect(() => assertAuthorizationInputTx(token, { client: fake.client, userId: 'u1' })).toThrow(expect.objectContaining({ reason: 'closed' }))
    const closed = await rejection(token.query('SELECT 1'))
    expect(closed).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'token_closed' })
    expect(fake.statements.length).toBe(before)
    expect(other.statements.length).toBe(0)
    const rejected = (() => {
      try {
        assertAuthorizationInputTx(null, { client: fake.client, userId: 'u1' })
      } catch (error) {
        return error
      }
      return null
    })()
    expect(rejected).toBeInstanceOf(AuthorizationInputTokenRejectedError)
    expect(rejected).toMatchObject({ code: 'AUTHORIZATION_INPUT_TOKEN_REJECTED', status: 500, retryable: false })
  })

  it('an expectation that names no connection is refused as another connection; the lock set and the birth set are read-only views', async () => {
    const fake = makeFake()
    await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', userIds: ['u1'] }, async (tx) => {
      expect(() => assertAuthorizationInputTx(tx, { userId: 'u1' } as never)).toThrow(expect.objectContaining({ reason: 'other_connection' }))
      expect(() => assertAuthorizationInputTx(tx, { client: undefined, userId: 'u1' } as never)).toThrow(expect.objectContaining({ reason: 'other_connection' }))
      expect(tx.locked.has('u1')).toBe(true)
      expect(tx.locked.size).toBe(1)
      expect([...tx.locked.keys()]).toEqual(['u1'])
      expect(() => (tx.locked as Map<string, unknown>).set('u2', {})).toThrow(TypeError)
      expect(() => (tx.locked as Map<string, unknown>).delete('u1')).toThrow(TypeError)
      expect(() => (tx.locked as Map<string, unknown>).clear()).toThrow(TypeError)
      expect(tx.locked.has('u1')).toBe(true)
      return 1
    }, { transaction: fake.runner })
    await withAuthorizationInputTransaction({ intent: 'BIRTH' }, async (tx) => {
      expect(() => (tx.born as Set<string>).add('existing')).toThrow(TypeError)
      expect(tx.born.size).toBe(0)
      const { id } = await tx.insertUserForBirth({ id: 'new-2', username: 'new-2', role: 'user' })
      expect(tx.born.has(id)).toBe(true)
      expect([...tx.born]).toEqual(['new-2'])
      expect(() => (tx.born as Set<string>).delete(id)).toThrow(TypeError)
      expect(() => (tx.born as Set<string>).clear()).toThrow(TypeError)
      expect(tx.born.has(id)).toBe(true)
      return 1
    }, { transaction: makeFake().runner })
  })

  it('insertUserForBirth issues a plain INSERT RETURNING id for birth intents only and records the id', async () => {
    const fake = makeFake()
    const born = await withAuthorizationInputTransaction({ intent: 'BIRTH' }, async (tx) => {
      const { id } = await tx.insertUserForBirth({ id: 'new-1', username: 'new-1', role: 'user' })
      return { id, born: [...tx.born] }
    }, { transaction: fake.runner })
    expect(born).toEqual({ id: 'new-1', born: ['new-1'] })
    const insert = fake.statements.find((s) => s.sql.startsWith('INSERT INTO users'))
    expect(insert?.sql).toBe('INSERT INTO users (id, username, role) VALUES ($1, $2, $3) RETURNING id::text AS id')
    expect(insert?.sql).not.toMatch(/ON CONFLICT/i)
    expect(insert?.params).toEqual(['new-1', 'new-1', 'user'])
    const refused = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => tx.insertUserForBirth({ id: 'x' }), { transaction: makeFake().runner }))
    expect(refused).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'birth_not_in_intent' })
    const column = await rejection(withAuthorizationInputTransaction({ intent: 'BIRTH' }, async (tx) => tx.insertUserForBirth({ 'id) VALUES (1); --': 'x' }), { transaction: makeFake().runner }))
    expect(column).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'birth_column_invalid' })
  })

  it('readClassRaisingRoleIds answers class-raising ids without a read and reads role_permissions by role id only', async () => {
    const fake = makeFake({ rolePermissionRows: [{ role_id: 'viewer', permission_code: 'users:write' }, { role_id: 'reader', permission_code: 'docs:read' }] })
    const raising = await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => [...(await readClassRaisingRoleIds(tx, ['viewer', 'reader', 'admin', 'users_admin']))].sort(), { transaction: fake.runner })
    expect(raising).toEqual(['admin', 'users_admin', 'viewer'])
    const read = fake.statements.find((s) => s.sql === AUTHORIZATION_INPUT_STATEMENTS.rolePermissionCodes)
    expect(read?.params).toEqual([['reader', 'viewer']])
    expect(read?.sql).not.toMatch(/\broles\b/)
  })
})

describe('borrow-period error listener', () => {
  it('is attached before the first statement, stays through COMMIT and release, and is removed once the transaction settles', async () => {
    const fake = makeFake()
    await withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async () => 1, { transaction: fake.runner })
    expect(fake.statements[0]).toMatchObject({ sql: 'BEGIN', listeners: 0 })
    expect(fake.statements[1]).toMatchObject({ sql: AUTHORIZATION_INPUT_STATEMENTS.setTransaction, listeners: 1 })
    expect(fake.listenersAt).toEqual({ commit: 1, release: 1 })
    expect(fake.raw.listenerCount('error')).toBe(0)
    const failing = makeFake({ failAt: { match: 'pg_advisory_xact_lock_shared', error: pgError('55P03') } })
    await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async () => 1, { transaction: failing.runner }))
    expect(failing.listenersAt).toEqual({ rollback: 1, release: 1 })
    expect(failing.raw.listenerCount('error')).toBe(0)
  })

  it('a connection error heard during work makes the entry answer busy (connection_lost); a failure after work returned passes through', async () => {
    const fake = makeFake()
    const driverError = new Error('Connection terminated unexpectedly')
    const error = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async (tx) => {
      fake.raw.emit('error', driverError)
      ;(fake as { statements: Recorded[] }).statements.push({ sql: 'heard', extra: 0, listeners: fake.raw.listenerCount('error') })
      await tx.query('SELECT 1')
      throw driverError
    }, { transaction: fake.runner }))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'connection_lost', cause: driverError })
    const commitFailure = new Error('Connection terminated unexpectedly')
    const after = makeFake({ failCommit: commitFailure })
    expect(await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async () => 1, { transaction: after.runner }))).toBe(commitFailure)
    expect(after.raw.listenerCount('error')).toBe(0)
  })

  it('a connection error heard before work returned makes a failed COMMIT busy even though work returned normally', async () => {
    const commitFailure = new Error('Connection terminated unexpectedly')
    const fake = makeFake({ failCommit: commitFailure })
    const driverError = new Error('Connection terminated unexpectedly')
    const error = await rejection(withAuthorizationInputTransaction({ intent: 'GRANT_ROLE' }, async () => {
      fake.raw.emit('error', driverError)
      return 1
    }, { transaction: fake.runner }))
    expect(error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'connection_lost', cause: commitFailure })
    expect(fake.raw.listenerCount('error')).toBe(0)
  })
})

describe('busy family boundary', () => {
  it('for every busy SQLSTATE shape, the contract passes an error through exactly when the recovery-lease discriminator claims it', () => {
    const shapes: unknown[] = [
      pgError('40001', RECOVERY_MARKER),
      pgError('40001', 'synthetic'),
      pgError('40001', `${RECOVERY_MARKER} `),
      pgError('40001', ''),
      pgError('55P03', RECOVERY_MARKER),
      pgError('57014', RECOVERY_MARKER),
      pgError('40P01', RECOVERY_MARKER),
      pgError('57P01', RECOVERY_MARKER),
      pgError('25P03', RECOVERY_MARKER),
      { code: '40001', message: RECOVERY_MARKER },
      { code: '40001', message: RECOVERY_MARKER.toLowerCase() },
    ]
    for (const shape of shapes) {
      expect(classifyAuthorizationInputBusyCause(shape) === null, JSON.stringify(shape)).toBe(isRecoveryAuthorityBusyError(shape))
    }
    expect(isRecoveryAuthorityBusyError(pgError('40001', RECOVERY_MARKER))).toBe(true)
    expect(RECOVERY_MARKER).toBe(RECOVERY_AUTHORITY_BUSY_MARKER)
  })
})

describe('statement text and the world-lock key', () => {
  it('every issued statement references exactly $1..$n for its n parameters; the world-lock statements are literal and parameterless', async () => {
    const fake = makeFake()
    await withAuthorizationInputTransaction(REPRESENTATIVE_PLANS.GRANT_ROLE, async (tx) => tx.insertUserForBirth({ id: 'x' }).catch(() => undefined), { transaction: fake.runner })
    await withAuthorizationInputTransaction(REPRESENTATIVE_PLANS.DELETE_ROLE, async () => 1, { transaction: fake.runner })
    await withAuthorizationInputTransaction({ intent: 'BIRTH' }, async (tx) => tx.insertUserForBirth({ id: 'x', username: 'y' }), { transaction: fake.runner })
    await withAuthorizationInputTransaction({ intent: 'MAINTENANCE' }, async () => 1, { transaction: fake.runner })
    expect(fake.statements.length).toBeGreaterThan(20)
    for (const s of fake.statements) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK', 'release'].includes(s.sql)) continue
      const n = s.params?.length ?? 0
      expect(placeholders(s.sql), s.sql).toEqual(Array.from({ length: n }, (_, i) => i + 1))
    }
    for (const sql of [AUTHORIZATION_INPUT_STATEMENTS.worldShared, AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry, AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry]) {
      expect(sql).toContain(`(${AUTHORIZATION_INPUT_WORLD_LOCK_KEY1}, ${AUTHORIZATION_INPUT_WORLD_LOCK_KEY2})`)
      expect(sql).not.toContain('$')
    }
    const source = readFileSync(LOCK_MODULE, 'utf8')
    expect(source).not.toMatch(/pg_advisory_xact_lock\(20261106/)
    expect(source).not.toMatch(/pg_advisory_lock/)
    expect(source).not.toMatch(/idle_in_transaction_session_timeout/)
    expect(source).not.toMatch(/timeoutMs/)
  })

  it('the three world-lock statements are the literal shared, shared-try and exclusive-try forms', () => {
    expect(AUTHORIZATION_INPUT_STATEMENTS.worldShared).toBe('SELECT pg_advisory_xact_lock_shared(20261106, 1)')
    expect(AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry).toBe('SELECT pg_try_advisory_xact_lock_shared(20261106, 1) AS acquired')
    expect(AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry).toBe('SELECT pg_try_advisory_xact_lock(20261106, 1) AS acquired')
  })

  it('the R1 and R3 statements equal the definitions they mirror', async () => {
    const recycle = readFileSync(path.join(SRC, 'admin', 'user-recycle.ts'), 'utf8')
    const file = ts.createSourceFile('m.ts', recycle, ts.ScriptTarget.Latest, true)
    let platformAdmin: string | null = null
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PLATFORM_ADMIN_ADVISORY_LOCK_SQL' && node.initializer && ts.isStringLiteral(node.initializer)) platformAdmin = node.initializer.text
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(platformAdmin).toBe(AUTHORIZATION_INPUT_STATEMENTS.platformAdminInvariant)
    const recorded: Array<[string, unknown[] | undefined]> = []
    await lockNamespaceAdmissionWrites({ query: async (sql: string, params?: unknown[]) => void recorded.push([sql, params]) }, 'u1')
    expect(recorded).toEqual([[AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission, ['namespace-admission:u1']]])
  })

  it('the first key differs from every other fixed two-int4 namespace in the repository and is registered', () => {
    const fixed: Array<[string, RegExp]> = [
      ['integration/yida-initialization-bootstrap.ts', /YIDA_INITIALIZATION_LOCK_NS = (0x[0-9a-fA-F]+)/],
      ['multitable/stock-preparation-persist-unit-of-work.ts', /STOCK_PREPARATION_PROJECT_LOCK_NS = (0x[0-9a-fA-F]+)/],
      ['multitable/stock-preparation-persist-unit-of-work.ts', /STOCK_PREPARATION_BATCH_LOCK_NS = (0x[0-9a-fA-F]+)/],
      ['multitable/canonical-sheet-fence.ts', /PIT_RECOVERY_LOCK_NS = (0x[0-9a-fA-F]+)/],
      ['attendance/coordination/settlement-coordination-key.ts', /SETTLEMENT_COORDINATION_KEY1 = (0x[0-9a-fA-F]+)/],
    ]
    const seen: number[] = []
    for (const [file, pattern] of fixed) {
      const match = pattern.exec(readFileSync(path.join(SRC, file), 'utf8'))
      expect(match, file).not.toBeNull()
      seen.push(Number(match![1]))
    }
    expect(seen).toHaveLength(5)
    for (const value of seen) expect(value).not.toBe(AUTHORIZATION_INPUT_WORLD_LOCK_KEY1)
    const literals = ADVISORY_FIXED_KEY1_REGISTRY.flatMap((entry) => ('literal' in entry.key1 ? [[entry.name, entry.key1.literal] as const] : []))
    expect(literals.filter(([, value]) => value === AUTHORIZATION_INPUT_WORLD_LOCK_KEY1).map(([name]) => name)).toEqual(['authorization-input-world'])
    expect(AUTHORIZATION_INPUT_WORLD_LOCK_KEY2).toBe(1)
  })

  it('the lock module imports the brand, the predicates, the user mutex, the pull-source gate marker, the pool and the recovery discriminator, and never the classifier', () => {
    const source = readFileSync(LOCK_MODULE, 'utf8')
    const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
    const specifiers = file.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [])
    expect([...new Set(specifiers)].sort()).toEqual([
      '../directory/access-graph-mutex',
      '../directory/pull-source-gate-context',
      '../integration/db/connection-pool',
      '../multitable/recovery-authorization-stability',
      './authorization-input-brand',
      './authorization-input-classes',
      'pg',
    ])
    expect(source).not.toMatch(/security-action-privilege|external-login-assurance/)
    expect(source).not.toMatch(/require\(|import\(/)
  })
})

describe('real-database files are wired', () => {
  const config = readFileSync(path.join(BACKEND, 'vitest.config.ts'), 'utf8')
  const workflow = readFileSync(WORKFLOW, 'utf8')
  for (const spec of DB_SPECS) {
    it(`${spec} exists, is excluded from the default lane and runs once in the approval real-DB step`, () => {
      expect(existsSync(path.join(BACKEND, spec))).toBe(true)
      expect(config.split(`'${spec}'`).length - 1).toBe(1)
      const step = workflow.slice(workflow.indexOf('id: approval-real-db-integration'))
      const run = step.slice(0, step.indexOf('\n      - '))
      expect(run.split(`${spec} \\\n`).length - 1).toBe(1)
    })
  }
})
