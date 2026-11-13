/**
 * Pull-source write gate (src/directory/pull-source-write-gate.ts) and the routing-policy PATCH that
 * uses it, without a database: the database module is replaced by a scripted connection that records
 * every statement, so what is pinned here is which statements a gate transaction issues, in which order,
 * and what each outcome becomes: the row lock and the policy clear are the gate module's own statements,
 * and the whole transaction runs with the pull-source gate marker set, so an authorization-input entry
 * point reached from the write or from the judgement refuses before any statement. What PostgreSQL does
 * with those statements (locks, isolation, waits) is pinned by
 * tests/integration/directory-pull-source-gate.db.test.ts.
 */
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))
const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: auditMocks.auditLog }))

import { Logger } from '../../src/core/logger'
import {
  APPROVAL_ROUTING_POLICY_EXISTS_SQL,
  COUNT_ACTIVE_PULL_SOURCES_SQL,
  COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL,
  DIRECTORY_ROUTING_POLICY_REQUIRED_MESSAGE,
  DirectoryRoutingPolicyRequiredError,
  PullSourceCountUnavailableError,
  directoryOrgLockSql,
} from '../../src/directory/pull-source-rule'
import { isInsidePullSourceGate } from '../../src/directory/pull-source-gate-context'
import {
  DIRECTORY_ROUTING_GATE_BUSY_MESSAGE,
  DIRECTORY_ROUTING_GATE_UNAVAILABLE_MESSAGE,
  DirectoryRoutingGateBusyError,
  DirectoryRoutingGateUnavailableError,
  PULL_SOURCE_GATE_BUSY_SQLSTATES,
  PullSourceGateRowMovedError,
  runGatedPullSourceWrite,
  runGatedRoutingPolicyClear,
  type PullSourceGateClient,
} from '../../src/directory/pull-source-write-gate'
import {
  enterAuthorizationInputTransaction,
  withAuthorizationInputTransaction,
} from '../../src/rbac/authorization-input-lock'
import { adminDirectoryRoutingPolicyRouter } from '../../src/routes/admin-directory-routing-policy'

const RC = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '25s'"
const ORG_LOCK = directoryOrgLockSql('$1')
const PREAMBLE = [RC, LOCK_TIMEOUT, STATEMENT_TIMEOUT]
const WRITE = 'INSERT INTO t VALUES (1)'
/** The row lock is the gate's own statement; a case recognises it and answers it. */
const ROW_LOCK = /^SELECT org_id, status\s+FROM directory_integrations\s+WHERE id = \$1 AND provider = \$2\s+FOR UPDATE$/
const isRowLock = (sql: string): boolean => ROW_LOCK.test(sql)

type Rows = Array<Record<string, unknown>>
type Script = (sql: string, params: unknown[] | undefined) => Rows | Error | undefined

/** A gate connection that records every statement and answers from `script` (no rows by default). */
function scriptedConnection(script: Script = () => undefined) {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = []
  /** Whether the pull-source gate marker was set when each statement was issued. */
  const marked: boolean[] = []
  const client: PullSourceGateClient = {
    query: async (sql, params) => {
      statements.push({ sql, params })
      marked.push(isInsidePullSourceGate())
      const answer = script(sql, params)
      if (answer instanceof Error) throw answer
      return { rows: answer ?? [] }
    },
  }
  pgMocks.transaction.mockImplementation(async (handler: (c: PullSourceGateClient) => Promise<unknown>) => handler(client))
  return { statements, marked, texts: () => statements.map((s) => s.sql) }
}

const sqlStateError = (code: string): Error => Object.assign(new Error(`driver text ${code} org-secret-1`), { code })
const failureOf = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error)

const ON = { APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED: 'true' }
const TARGET = { orgId: 'org-1', provider: 'dingtalk', corpId: 'corp-1' }

beforeEach(() => {
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  auditMocks.auditLog.mockReset()
  auditMocks.auditLog.mockResolvedValue(undefined)
})

describe('a legacy entry while the switch is off', () => {
  for (const value of [undefined, '', 'false', '0', 'TRUE', ' true ', '1']) {
    it(`switch ${JSON.stringify(value)}: the write runs on the pool, with no transaction, lock or policy read`, async () => {
      pgMocks.query.mockResolvedValue({ rows: [{ id: 'row-1' }] })
      const contexts: unknown[] = []
      const outcome = await runGatedPullSourceWrite(
        { ...TARGET, enforce: 'flagged' },
        async (client, context) => {
          contexts.push(context)
          return client.query(WRITE, ['p'])
        },
        { env: value === undefined ? {} : { APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED: value } },
      )
      expect(outcome).toEqual({ result: { rows: [{ id: 'row-1' }] }, gated: false, joined: false })
      expect(contexts).toEqual([{ gated: false, lockedStatus: null, joined: false }])
      expect(pgMocks.transaction).not.toHaveBeenCalled()
      expect(pgMocks.query.mock.calls).toEqual([[WRITE, ['p']]])
    })
  }

  it('an entry that is always gated does not read the switch', async () => {
    const connection = scriptedConnection((sql) => (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL ? [{ other_source_count: 0 }] : undefined))
    const outcome = await runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, (client) => client.query(WRITE), { env: {} })
    expect(outcome.gated).toBe(true)
    expect(connection.texts()).toEqual([...PREAMBLE, ORG_LOCK, APPROVAL_ROUTING_POLICY_EXISTS_SQL, COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, WRITE])
    expect(pgMocks.query).not.toHaveBeenCalled()
  })
})

describe('a gated write', () => {
  it('pins READ COMMITTED first, bounds waits, takes the organisation lock, then reads, then writes', async () => {
    const connection = scriptedConnection((sql) => (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL ? [{ other_source_count: 0 }] : undefined))
    const outcome = await runGatedPullSourceWrite({ ...TARGET, enforce: 'flagged' }, (client) => client.query(WRITE), { env: ON })
    expect(outcome).toEqual({ result: { rows: [] }, gated: true, joined: true })
    expect(connection.statements).toEqual([
      { sql: RC, params: undefined },
      { sql: LOCK_TIMEOUT, params: undefined },
      { sql: STATEMENT_TIMEOUT, params: undefined },
      { sql: ORG_LOCK, params: ['org-1'] },
      { sql: APPROVAL_ROUTING_POLICY_EXISTS_SQL, params: ['org-1'] },
      { sql: COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, params: ['org-1', 'dingtalk', 'corp-1'] },
      { sql: WRITE, params: undefined },
    ])
    // The write ran on the transaction's connection, not on the pool.
    expect(pgMocks.query).not.toHaveBeenCalled()
    expect(pgMocks.transaction).toHaveBeenCalledTimes(1)
  })

  it('an organisation that has a policy is not counted', async () => {
    const connection = scriptedConnection((sql) => (sql === APPROVAL_ROUTING_POLICY_EXISTS_SQL ? [{ present: 1 }] : undefined))
    const outcome = await runGatedPullSourceWrite({ ...TARGET, enforce: 'flagged' }, (client) => client.query(WRITE), { env: ON })
    expect(outcome.joined).toBe(true)
    expect(connection.texts()).toEqual([...PREAMBLE, ORG_LOCK, APPROVAL_ROUTING_POLICY_EXISTS_SQL, WRITE])
  })

  it('another active source and no policy refuses with the fixed sentence, and the write never runs', async () => {
    const connection = scriptedConnection((sql) => (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL ? [{ other_source_count: 1 }] : undefined))
    const write = vi.fn()
    const failure = await failureOf(runGatedPullSourceWrite({ ...TARGET, enforce: 'flagged' }, write, { env: ON }))
    expect(failure).toBeInstanceOf(DirectoryRoutingPolicyRequiredError)
    expect((failure as Error).message).toBe(DIRECTORY_ROUTING_POLICY_REQUIRED_MESSAGE)
    expect(write).not.toHaveBeenCalled()
    expect(connection.texts()).toEqual([...PREAMBLE, ORG_LOCK, APPROVAL_ROUTING_POLICY_EXISTS_SQL, COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL])
  })

  it('the local directory is not a pull source: it takes the lock and is neither probed nor counted', async () => {
    // Without the provider rule this script would refuse: no policy and another active source.
    const connection = scriptedConnection((sql) => (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL ? [{ other_source_count: 1 }] : undefined))
    const outcome = await runGatedPullSourceWrite(
      { orgId: 'org-1', provider: 'local', corpId: 'local:org-1', enforce: 'always' },
      (client) => client.query(WRITE),
      { env: ON },
    )
    expect(outcome).toMatchObject({ gated: true, joined: true })
    expect(connection.texts()).toEqual([...PREAMBLE, ORG_LOCK, WRITE])
  })

  it('locks the row itself, first, then the organisation, and decides the join from the status the row lock read', async () => {
    const connection = scriptedConnection((sql) => {
      if (isRowLock(sql)) return [{ org_id: 'org-1', status: 'paused' }]
      if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return [{ other_source_count: 0 }]
      return undefined
    })
    const seen: unknown[] = []
    const judged: unknown[] = []
    const outcome = await runGatedPullSourceWrite(
      { ...TARGET, enforce: 'flagged' },
      async (client, context) => {
        seen.push(context)
        return client.query(WRITE)
      },
      {
        env: ON,
        lockRowId: 'row-1',
        joins: (lockedStatus) => {
          judged.push(lockedStatus)
          return lockedStatus !== 'active'
        },
      },
    )
    expect(outcome).toMatchObject({ gated: true, joined: true })
    expect(judged).toEqual(['paused'])
    expect(seen).toEqual([{ gated: true, lockedStatus: 'paused', joined: true }])
    const texts = connection.texts()
    expect(texts.slice(0, 3)).toEqual(PREAMBLE)
    expect(isRowLock(texts[3])).toBe(true)
    // The row is looked up by its id and the target's provider.
    expect(connection.statements[3].params).toEqual(['row-1', 'dingtalk'])
    expect(texts.slice(4)).toEqual([ORG_LOCK, APPROVAL_ROUTING_POLICY_EXISTS_SQL, COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, WRITE])
  })

  it('a write that adds no source keeps both locks and skips the check', async () => {
    const connection = scriptedConnection((sql) => {
      if (isRowLock(sql)) return [{ org_id: 'org-1', status: 'active' }]
      // Would refuse if the check ran.
      if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return [{ other_source_count: 3 }]
      return undefined
    })
    const outcome = await runGatedPullSourceWrite(
      { ...TARGET, enforce: 'flagged' },
      (client) => client.query(WRITE),
      { env: ON, lockRowId: 'row-1', joins: (lockedStatus) => lockedStatus !== 'active' },
    )
    expect(outcome).toMatchObject({ gated: true, joined: false })
    const texts = connection.texts()
    expect(isRowLock(texts[3])).toBe(true)
    expect(texts.slice(4)).toEqual([ORG_LOCK, WRITE])
  })

  it('a row that is gone is read as no status: the judgement and the write both receive null', async () => {
    const connection = scriptedConnection()
    const seen: unknown[] = []
    const judged: unknown[] = []
    const outcome = await runGatedPullSourceWrite(
      { ...TARGET, enforce: 'flagged' },
      async (client, context) => {
        seen.push(context)
        return client.query(WRITE)
      },
      {
        env: ON,
        lockRowId: 'row-1',
        joins: (lockedStatus) => {
          judged.push(lockedStatus)
          return lockedStatus !== null && lockedStatus !== 'active'
        },
      },
    )
    expect(outcome).toMatchObject({ gated: true, joined: false })
    expect(judged).toEqual([null])
    expect(seen).toEqual([{ gated: true, lockedStatus: null, joined: false }])
    expect(connection.texts().slice(4)).toEqual([ORG_LOCK, WRITE])
  })

  it('a row read in another organisation ends the transaction before the organisation lock: nothing is judged or written', async () => {
    const connection = scriptedConnection((sql) => (isRowLock(sql) ? [{ org_id: 'org-2', status: 'paused' }] : undefined))
    const write = vi.fn()
    const joins = vi.fn(() => true)
    const failure = await failureOf(runGatedPullSourceWrite({ ...TARGET, enforce: 'flagged' }, write, { env: ON, lockRowId: 'row-1', joins }))
    expect(failure).toBeInstanceOf(PullSourceGateRowMovedError)
    // The sentence carries no organisation id and no row id.
    expect((failure as Error).message).not.toMatch(/org-1|org-2|row-1/)
    expect(write).not.toHaveBeenCalled()
    expect(joins).not.toHaveBeenCalled()
    const texts = connection.texts()
    expect(texts).toHaveLength(4)
    expect(isRowLock(texts[3])).toBe(true)
    expect(texts).not.toContain(ORG_LOCK)
  })

  it('without a row to lock no row statement is issued, and the judgement receives null', async () => {
    const connection = scriptedConnection()
    const judged: unknown[] = []
    await runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, (client) => client.query(WRITE), {
      joins: (lockedStatus) => {
        judged.push(lockedStatus)
        return false
      },
    })
    expect(judged).toEqual([null])
    expect(connection.texts()).toEqual([...PREAMBLE, ORG_LOCK, WRITE])
  })
})

describe('a gate transaction runs with the pull-source gate marker set', () => {
  /** Both authorization-input entry points, each with a transaction stand-in that records its statements. */
  function authorizationInputEntries() {
    const statements: string[] = []
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        return { rows: [], rowCount: null }
      },
    }
    const runner = async <T>(handler: (c: typeof client) => Promise<T>): Promise<T> => {
      statements.push('BEGIN')
      return handler(client)
    }
    const selfBuilt = () => withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', userIds: ['u1'] }, async () => 'entered', { transaction: runner as never })
    const takeover = () => enterAuthorizationInputTransaction(client as never, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], async () => 'entered')
    return { statements, selfBuilt, takeover }
  }
  const REFUSED = { code: 'AUTHORIZATION_INPUT_PLAN_INVALID', reason: 'inside_pull_source_gate' }

  it('every statement of a gated write, the judgement and the write see the marker; it is clear before and after', async () => {
    const connection = scriptedConnection((sql) => {
      if (isRowLock(sql)) return [{ org_id: 'org-1', status: 'paused' }]
      if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return [{ other_source_count: 0 }]
      return undefined
    })
    const seen: Record<string, boolean> = {}
    expect(isInsidePullSourceGate()).toBe(false)
    await runGatedPullSourceWrite(
      { ...TARGET, enforce: 'always' },
      async (client) => {
        seen.write = isInsidePullSourceGate()
        // The marker follows the asynchronous call chain.
        await new Promise((resolve) => setImmediate(resolve))
        seen.writeLater = isInsidePullSourceGate()
        return client.query(WRITE)
      },
      {
        lockRowId: 'row-1',
        joins: () => {
          seen.joins = isInsidePullSourceGate()
          return true
        },
      },
    )
    expect(seen).toEqual({ joins: true, write: true, writeLater: true })
    expect(connection.texts()).toHaveLength(8)
    expect(connection.marked).toEqual(connection.texts().map(() => true))
    expect(isInsidePullSourceGate()).toBe(false)
  })

  it('both authorization-input entry points refuse before any statement when the write reaches them', async () => {
    const connection = scriptedConnection((sql) => (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL ? [{ other_source_count: 0 }] : undefined))
    for (const entry of ['selfBuilt', 'takeover'] as const) {
      const entries = authorizationInputEntries()
      // Reached directly, and through another function on a connection of its own.
      const indirect = async () => entries[entry]()
      for (const reach of [entries[entry], indirect]) {
        const failure = await failureOf(runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, async () => reach()))
        expect(failure, entry).toMatchObject(REFUSED)
      }
      expect(entries.statements, entry).toEqual([])
    }
    // The gate transaction issued its own statements and nothing else: the refused write added none.
    expect(connection.texts().filter((sql) => sql === WRITE)).toEqual([])
  })

  it('both authorization-input entry points refuse before any statement when the judgement reaches them', async () => {
    scriptedConnection((sql) => (isRowLock(sql) ? [{ org_id: 'org-1', status: 'paused' }] : undefined))
    for (const entry of ['selfBuilt', 'takeover'] as const) {
      const entries = authorizationInputEntries()
      const refusals: unknown[] = []
      const write = vi.fn()
      const outcome = runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, write, {
        lockRowId: 'row-1',
        joins: () => {
          // The judgement is synchronous; what it started is observed after the gate has ended.
          refusals.push(failureOf(entries[entry]()))
          return false
        },
      })
      await outcome
      expect(await refusals[0], entry).toMatchObject(REFUSED)
      expect(entries.statements, entry).toEqual([])
    }
  })

  it('a policy clear runs with the marker set from its first statement to its last', async () => {
    const connection = scriptedConnection((sql) => {
      if (isPolicyRead(sql)) return [{ canonical_integration_id: OTHER_ID }]
      if (sql === COUNT_ACTIVE_PULL_SOURCES_SQL) return [{ pull_source_count: 1 }]
      return undefined
    })
    await expect(runGatedRoutingPolicyClear('org-1', 'approval_routing')).resolves.toEqual({ kind: 'cleared', previous: OTHER_ID })
    expect(connection.texts()).toHaveLength(7)
    expect(connection.marked).toEqual(connection.texts().map(() => true))
    expect(isInsidePullSourceGate()).toBe(false)
  })

  it('a write that is not gated runs without the marker: it holds no organisation lock', async () => {
    pgMocks.query.mockResolvedValue({ rows: [] })
    const entries = authorizationInputEntries()
    const seen: boolean[] = []
    const failure = await failureOf(runGatedPullSourceWrite(
      { ...TARGET, enforce: 'flagged' },
      async () => {
        seen.push(isInsidePullSourceGate())
        return entries.selfBuilt()
      },
      { env: {} },
    ))
    expect(seen).toEqual([false])
    // The entry point was not refused for the marker: it opened its transaction. (What its stand-in
    // connection answers afterwards is not the subject here.)
    expect(entries.statements[0]).toBe('BEGIN')
    if (failure !== null) expect(failure).not.toMatchObject({ reason: 'inside_pull_source_gate' })
    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  it('the marker is clear again after a gate transaction that failed', async () => {
    scriptedConnection((sql) => (sql === ORG_LOCK ? sqlStateError('55P03') : undefined))
    await failureOf(runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, (client) => client.query(WRITE)))
    expect(isInsidePullSourceGate()).toBe(false)
  })
})

describe('a gate transaction that cannot finish', () => {
  it('lists exactly the three retryable SQLSTATEs', () => {
    expect([...PULL_SOURCE_GATE_BUSY_SQLSTATES]).toEqual(['40P01', '55P03', '57014'])
  })

  for (const code of ['40P01', '55P03', '57014']) {
    for (const stage of ['organisation lock', 'row lock', 'count', 'write', 'commit'] as const) {
      it(`${code} at the ${stage}: busy, fixed sentence, the SQLSTATE in a typed property only`, async () => {
        const error = sqlStateError(code)
        const connection = scriptedConnection((sql) => {
          if (stage === 'organisation lock' && sql === ORG_LOCK) return error
          if (stage === 'row lock' && isRowLock(sql)) return error
          if (stage === 'count' && sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return error
          if (stage === 'write' && sql === WRITE) return error
          if (isRowLock(sql)) return [{ org_id: 'org-1', status: 'paused' }]
          if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return [{ other_source_count: 0 }]
          return undefined
        })
        if (stage === 'commit') pgMocks.transaction.mockRejectedValue(error)
        const failure = await failureOf(
          runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, (client) => client.query(WRITE), { lockRowId: 'row-1' }),
        )
        expect(failure).toBeInstanceOf(DirectoryRoutingGateBusyError)
        expect((failure as DirectoryRoutingGateBusyError).sqlState).toBe(code)
        expect((failure as DirectoryRoutingGateBusyError).code).toBe('DIRECTORY_ROUTING_GATE_BUSY')
        expect((failure as Error).message).toBe(DIRECTORY_ROUTING_GATE_BUSY_MESSAGE)
        expect((failure as Error).message).not.toContain('org-secret-1')
        // Nothing follows the failed statement: in particular no read and no write without the lock.
        if (stage === 'organisation lock') {
          expect(connection.texts()).toHaveLength(5)
          expect(connection.texts()[4]).toBe(ORG_LOCK)
        }
        if (stage === 'row lock') {
          expect(connection.texts()).toHaveLength(4)
          expect(isRowLock(connection.texts()[3])).toBe(true)
        }
      })
    }
  }

  it('a source count that cannot be read is unavailable, never zero: the write does not run', async () => {
    for (const rows of [[], [{ other_source_count: null }], [{ other_source_count: 'x' }]] as Rows[]) {
      const connection = scriptedConnection((sql) => (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL ? rows : undefined))
      const write = vi.fn()
      const failure = await failureOf(runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, write))
      expect(failure).toBeInstanceOf(DirectoryRoutingGateUnavailableError)
      expect(failure).not.toBeInstanceOf(PullSourceCountUnavailableError)
      expect((failure as DirectoryRoutingGateUnavailableError).code).toBe('DIRECTORY_ROUTING_GATE_UNAVAILABLE')
      expect((failure as Error).message).toBe(DIRECTORY_ROUTING_GATE_UNAVAILABLE_MESSAGE)
      expect(write).not.toHaveBeenCalled()
      expect(connection.texts().at(-1)).toBe(COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL)
    }
  })

  it('any other failure passes through unchanged', async () => {
    const unique = sqlStateError('23505')
    scriptedConnection((sql) => (sql === WRITE ? unique : sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL ? [{ other_source_count: 0 }] : undefined))
    expect(await failureOf(runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, (client) => client.query(WRITE)))).toBe(unique)
    const plain = new Error('boom')
    scriptedConnection((sql) => (sql === ORG_LOCK ? plain : undefined))
    expect(await failureOf(runGatedRoutingPolicyClear('org-1', 'approval_routing'))).toBe(plain)
  })
})

describe('a policy clear, called on the gate module', () => {
  it('has the same preamble and lock as a gated write, then the policy row, the source count and the delete', async () => {
    const connection = scriptedConnection((sql) => {
      if (isPolicyRead(sql)) return [{ canonical_integration_id: OTHER_ID }]
      if (sql === COUNT_ACTIVE_PULL_SOURCES_SQL) return [{ pull_source_count: 1 }]
      return undefined
    })
    await expect(runGatedRoutingPolicyClear('org-9', 'approval_routing')).resolves.toEqual({ kind: 'cleared', previous: OTHER_ID })
    expect(connection.statements.slice(0, 4)).toEqual([
      { sql: RC, params: undefined },
      { sql: LOCK_TIMEOUT, params: undefined },
      { sql: STATEMENT_TIMEOUT, params: undefined },
      { sql: ORG_LOCK, params: ['org-9'] },
    ])
    expect(isPolicyRead(connection.texts()[4])).toBe(true)
    expect(connection.statements[4].params).toEqual(['org-9', 'approval_routing'])
    expect(connection.statements[5]).toEqual({ sql: COUNT_ACTIVE_PULL_SOURCES_SQL, params: ['org-9'] })
    expect(connection.statements[6]).toEqual({
      sql: 'DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = $2',
      params: ['org-9', 'approval_routing'],
    })
    expect(connection.texts()).toHaveLength(7)
    expect(pgMocks.query).not.toHaveBeenCalled()
  })

  it('no policy row is absent without a count; two or more sources is blocked without a delete', async () => {
    const absent = scriptedConnection((sql) => (sql === COUNT_ACTIVE_PULL_SOURCES_SQL ? [{ pull_source_count: 9 }] : undefined))
    await expect(runGatedRoutingPolicyClear('org-9', 'approval_routing')).resolves.toEqual({ kind: 'absent' })
    expect(absent.texts()).toHaveLength(5)
    for (const count of [2, 3]) {
      const blocked = scriptedConnection((sql) => {
        if (isPolicyRead(sql)) return [{ canonical_integration_id: OTHER_ID }]
        if (sql === COUNT_ACTIVE_PULL_SOURCES_SQL) return [{ pull_source_count: count }]
        return undefined
      })
      await expect(runGatedRoutingPolicyClear('org-9', 'approval_routing')).resolves.toEqual({ kind: 'blocked' })
      expect(blocked.texts()).toHaveLength(6)
      expect(blocked.texts().some((sql) => /DELETE/i.test(sql))).toBe(false)
    }
  })

  it('an unreadable count is unavailable and a lost lock race is busy, with no delete', async () => {
    const unreadable = scriptedConnection((sql) => (isPolicyRead(sql) ? [{ canonical_integration_id: OTHER_ID }] : undefined))
    const unavailable = await failureOf(runGatedRoutingPolicyClear('org-9', 'approval_routing'))
    expect(unavailable).toBeInstanceOf(DirectoryRoutingGateUnavailableError)
    expect(unavailable).not.toBeInstanceOf(PullSourceCountUnavailableError)
    expect(unreadable.texts().some((sql) => /DELETE/i.test(sql))).toBe(false)
    scriptedConnection((sql) => (sql === ORG_LOCK ? sqlStateError('40P01') : undefined))
    expect(await failureOf(runGatedRoutingPolicyClear('org-9', 'approval_routing'))).toBeInstanceOf(DirectoryRoutingGateBusyError)
  })
})

// ── PATCH /api/admin/directory/routing-policy/:purpose ─────────────────────────────────────────────

interface StubResponse {
  statusCode: number
  body: unknown
  status(code: number): StubResponse
  json(payload: unknown): StubResponse
}
function stubResponse(): StubResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }> }
}

async function patchPolicy(body: Record<string, unknown>): Promise<StubResponse> {
  const router = adminDirectoryRoutingPolicyRouter() as unknown as { stack: RouteLayer[] }
  const layer = router.stack.find((entry) => entry.route?.path === '/:purpose' && entry.route?.methods?.patch)
  if (!layer?.route) throw new Error('PATCH /:purpose not found')
  const res = stubResponse()
  const req = {
    method: 'PATCH',
    params: { purpose: 'approval_routing' },
    query: {},
    body,
    // The legacy admin claim short-circuits ensurePlatformAdmin's RBAC read.
    user: { id: 'admin-7', role: 'admin' },
  } as unknown as Request
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res as unknown as Response, (err?: unknown) => {
    if (err) throw err
  })
  return res
}

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const POLICY_READ = /FROM org_directory_routing_policy\s+WHERE org_id = \$1 AND purpose = \$2\s+FOR UPDATE/
const isPolicyRead = (sql: string): boolean => POLICY_READ.test(sql)
const isTargetLock = (sql: string): boolean => /FROM directory_integrations\s+WHERE id = \$1::uuid AND org_id = \$2\s+FOR SHARE/.test(sql)
const errorBody = (code: string, message: string) => ({ ok: false, error: { code, message, details: undefined } })

describe('PATCH routing policy: clear', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('runs in a gate transaction: organisation lock, the policy row, the source count, the delete', async () => {
    const connection = scriptedConnection((sql) => {
      if (isPolicyRead(sql)) return [{ canonical_integration_id: OTHER_ID }]
      if (sql === COUNT_ACTIVE_PULL_SOURCES_SQL) return [{ pull_source_count: 1 }]
      return undefined
    })
    const res = await patchPolicy({ canonicalIntegrationId: null })
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { cleared: true }, meta: undefined })
    const texts = connection.texts()
    expect(texts.slice(0, 4)).toEqual([...PREAMBLE, ORG_LOCK])
    expect(connection.statements[3].params).toEqual(['default'])
    expect(isPolicyRead(texts[4])).toBe(true)
    expect(texts[5]).toBe(COUNT_ACTIVE_PULL_SOURCES_SQL)
    expect(texts[6]).toMatch(/^DELETE FROM org_directory_routing_policy WHERE org_id = \$1 AND purpose = \$2$/)
    expect(texts).toHaveLength(7)
    expect(pgMocks.query).not.toHaveBeenCalled()
    expect(auditMocks.auditLog.mock.calls).toEqual([[{
      actorId: 'admin-7',
      actorType: 'user',
      action: 'directory.routing_policy.clear',
      resourceType: 'directory-routing-policy',
      resourceId: 'default:approval_routing',
      meta: { orgId: 'default', purpose: 'approval_routing', actorId: 'admin-7', previousCanonicalIntegrationId: OTHER_ID },
    }]])
  })

  it('two or more active sources: 409 ROUTING_POLICY_CLEAR_BLOCKED, no delete, no audit, one values-free log line', async () => {
    for (const count of [2, 3]) {
      auditMocks.auditLog.mockClear()
      warnSpy.mockClear()
      const connection = scriptedConnection((sql) => {
        if (isPolicyRead(sql)) return [{ canonical_integration_id: OTHER_ID }]
        if (sql === COUNT_ACTIVE_PULL_SOURCES_SQL) return [{ pull_source_count: count }]
        return undefined
      })
      const res = await patchPolicy({ canonicalIntegrationId: null })
      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual(errorBody(
        'ROUTING_POLICY_CLEAR_BLOCKED',
        'The routing policy cannot be cleared while the organization has more than one active directory source',
      ))
      expect(connection.texts().some((sql) => /DELETE/i.test(sql))).toBe(false)
      expect(auditMocks.auditLog).not.toHaveBeenCalled()
      expect(warnSpy.mock.calls).toEqual([[
        'Routing policy clear refused: the organisation has more than one active pull source',
        { code: 'ROUTING_POLICY_CLEAR_BLOCKED', actorId: 'admin-7' },
      ]])
    }
  })

  it('does not read the switch: the refusal is the same with it on, off or unset', async () => {
    const saved = process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
    try {
      for (const value of [undefined, 'false', 'true']) {
        if (value === undefined) delete process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
        else process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = value
        scriptedConnection((sql) => {
          if (isPolicyRead(sql)) return [{ canonical_integration_id: OTHER_ID }]
          if (sql === COUNT_ACTIVE_PULL_SOURCES_SQL) return [{ pull_source_count: 2 }]
          return undefined
        })
        expect((await patchPolicy({ canonicalIntegrationId: null })).statusCode, String(value)).toBe(409)
      }
    } finally {
      if (saved === undefined) delete process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
      else process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = saved
    }
  })

  it('no policy row answers cleared:false whatever the source count, without counting, deleting or auditing', async () => {
    const connection = scriptedConnection((sql) => (sql === COUNT_ACTIVE_PULL_SOURCES_SQL ? [{ pull_source_count: 5 }] : undefined))
    const res = await patchPolicy({ canonicalIntegrationId: null })
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { cleared: false }, meta: undefined })
    expect(connection.texts()).toHaveLength(5)
    expect(isPolicyRead(connection.texts()[4])).toBe(true)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('an unreadable source count is a retryable 503 with the fixed sentence and no delete', async () => {
    const connection = scriptedConnection((sql) => (isPolicyRead(sql) ? [{ canonical_integration_id: OTHER_ID }] : undefined))
    const res = await patchPolicy({ canonicalIntegrationId: null })
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual(errorBody('DIRECTORY_ROUTING_GATE_UNAVAILABLE', DIRECTORY_ROUTING_GATE_UNAVAILABLE_MESSAGE))
    expect(connection.texts().some((sql) => /DELETE/i.test(sql))).toBe(false)
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  for (const code of ['40P01', '55P03', '57014']) {
    it(`${code} in the clear transaction is a retryable 503 with the fixed sentence, never the driver text`, async () => {
      scriptedConnection((sql) => (sql === ORG_LOCK ? sqlStateError(code) : undefined))
      const res = await patchPolicy({ canonicalIntegrationId: null })
      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual(errorBody('DIRECTORY_ROUTING_GATE_BUSY', DIRECTORY_ROUTING_GATE_BUSY_MESSAGE))
      expect(JSON.stringify(res.body)).not.toContain('driver text')
      expect(auditMocks.auditLog).not.toHaveBeenCalled()
    })
  }

  it('an untyped failure in the clear transaction stays the fixed 500', async () => {
    scriptedConnection((sql) => (sql === ORG_LOCK ? new Error('driver text org-secret-1') : undefined))
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    try {
      const res = await patchPolicy({ canonicalIntegrationId: null })
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual(errorBody('ROUTING_POLICY_WRITE_FAILED', 'Failed to update the routing policy'))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('rejects the expected-state field on a clear instead of ignoring it', async () => {
    scriptedConnection()
    for (const expected of [null, OTHER_ID]) {
      const res = await patchPolicy({ canonicalIntegrationId: null, expectedCurrentCanonicalIntegrationId: expected })
      expect(res.statusCode).toBe(400)
      expect((res.body as { error: { code: string } }).error.code).toBe('ROUTING_POLICY_INVALID_INPUT')
    }
    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })
})

describe('PATCH routing policy: set with the expected current canonical', () => {
  const UPSERT = /ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq\s+DO UPDATE SET canonical_integration_id = EXCLUDED\.canonical_integration_id, updated_at = NOW\(\)$/
  const INSERT_IF_ABSENT = /ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq DO NOTHING\s+RETURNING id$/

  function setScript(current: string | null, insertedRows: Rows = [{ id: 'p-1' }]): Script {
    return (sql) => {
      if (isTargetLock(sql)) return [{ id: TARGET_ID, provider: 'dingtalk', status: 'active' }]
      if (isPolicyRead(sql)) return current === null ? [] : [{ canonical_integration_id: current }]
      if (INSERT_IF_ABSENT.test(sql)) return insertedRows
      return undefined
    }
  }
  const setAudit = (previous: string | null) => [[{
    actorId: 'admin-7',
    actorType: 'user',
    action: 'directory.routing_policy.set',
    resourceType: 'directory-routing-policy',
    resourceId: 'default:approval_routing',
    meta: { orgId: 'default', purpose: 'approval_routing', integrationId: TARGET_ID, actorId: 'admin-7', previousCanonicalIntegrationId: previous },
  }]]

  it('absent: the set is unconditional, pins READ COMMITTED first, takes no organisation lock, and audits the operator and the previous canonical', async () => {
    for (const current of [null, OTHER_ID]) {
      auditMocks.auditLog.mockClear()
      const connection = scriptedConnection(setScript(current))
      const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID })
      expect(res.statusCode).toBe(200)
      const texts = connection.texts()
      expect(texts).toHaveLength(4)
      expect(texts[0]).toBe(RC)
      expect(isTargetLock(texts[1])).toBe(true)
      expect(isPolicyRead(texts[2])).toBe(true)
      expect(texts[3]).toMatch(UPSERT)
      expect(texts).not.toContain(ORG_LOCK)
      expect(texts).not.toContain(LOCK_TIMEOUT)
      expect(texts).not.toContain(STATEMENT_TIMEOUT)
      expect(auditMocks.auditLog.mock.calls).toEqual(setAudit(current))
    }
  })

  it('matching uuid (any letter case): the set goes through', async () => {
    const connection = scriptedConnection(setScript(OTHER_ID))
    const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: OTHER_ID.toUpperCase() })
    expect(res.statusCode).toBe(200)
    // Every set pins READ COMMITTED first.
    expect(connection.texts()[0]).toBe(RC)
    expect(isTargetLock(connection.texts()[1])).toBe(true)
    expect(isPolicyRead(connection.texts()[2])).toBe(true)
    expect(connection.texts()[3]).toMatch(UPSERT)
    expect(connection.texts()).toHaveLength(4)
    expect(auditMocks.auditLog.mock.calls).toEqual(setAudit(OTHER_ID))
  })

  it('a different current canonical, or none: 409 ROUTING_POLICY_STATE_CHANGED with nothing written or audited', async () => {
    for (const current of [TARGET_ID, null]) {
      const connection = scriptedConnection(setScript(current))
      const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: OTHER_ID })
      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual(errorBody('ROUTING_POLICY_STATE_CHANGED', 'The routing policy is not in the expected state; reload before applying'))
      expect(connection.texts()).toHaveLength(3)
      expect(isPolicyRead(connection.texts()[2])).toBe(true)
      expect(auditMocks.auditLog).not.toHaveBeenCalled()
    }
  })

  it('null with no policy: inserts only if still absent', async () => {
    const connection = scriptedConnection(setScript(null))
    const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: null })
    expect(res.statusCode).toBe(200)
    expect(connection.texts()).toHaveLength(4)
    expect(connection.texts()[0]).toBe(RC)
    expect(connection.texts()[3]).toMatch(INSERT_IF_ABSENT)
    expect(connection.texts()[3]).not.toMatch(/DO UPDATE/)
    expect(auditMocks.auditLog.mock.calls).toEqual(setAudit(null))
  })

  it('null while a policy exists, or one appears before the insert: 409 with nothing audited', async () => {
    const existing = scriptedConnection(setScript(OTHER_ID))
    const first = await patchPolicy({ canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: null })
    expect(first.statusCode).toBe(409)
    expect(existing.texts()).toHaveLength(3)
    scriptedConnection(setScript(null, []))
    const second = await patchPolicy({ canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: null })
    expect(second.statusCode).toBe(409)
    expect((second.body as { error: { code: string } }).error.code).toBe('ROUTING_POLICY_STATE_CHANGED')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  const SET_STAGES: Array<{ stage: string; fails: (sql: string) => boolean }> = [
    { stage: 'target row lock', fails: isTargetLock },
    { stage: 'policy row lock', fails: isPolicyRead },
    { stage: 'write', fails: (sql) => UPSERT.test(sql) || INSERT_IF_ABSENT.test(sql) },
  ]
  for (const code of ['40P01', '55P03', '57014']) {
    for (const { stage, fails } of SET_STAGES) {
      it(`${code} at the ${stage} of a set is a retryable 503 with the fixed sentence, never the driver text, and no audit`, async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
        try {
          for (const body of [
            { canonicalIntegrationId: TARGET_ID },
            { canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: OTHER_ID },
            { canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: null },
          ]) {
            warnSpy.mockClear()
            const expectsNone = 'expectedCurrentCanonicalIntegrationId' in body && body.expectedCurrentCanonicalIntegrationId === null
            const script = setScript(expectsNone ? null : OTHER_ID)
            const connection = scriptedConnection((sql, params) => (fails(sql) ? sqlStateError(code) : script(sql, params)))
            const res = await patchPolicy(body)
            expect(res.statusCode, JSON.stringify(body)).toBe(503)
            expect(res.body).toEqual(errorBody('DIRECTORY_ROUTING_GATE_BUSY', DIRECTORY_ROUTING_GATE_BUSY_MESSAGE))
            expect(JSON.stringify(res.body)).not.toContain('driver text')
            // The failing statement is the last one the transaction issued.
            expect(fails(connection.texts()[connection.texts().length - 1])).toBe(true)
            expect(auditMocks.auditLog).not.toHaveBeenCalled()
            expect(warnSpy.mock.calls).toEqual([[
              'Directory source check busy',
              { code: 'DIRECTORY_ROUTING_GATE_BUSY', sqlState: code, actorId: 'admin-7' },
            ]])
          }
        } finally {
          warnSpy.mockRestore()
        }
      })
    }
  }

  it('any other failure of a set transaction stays the fixed 500', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    try {
      for (const failure of [new Error('driver text org-secret-1'), sqlStateError('40001'), sqlStateError('23503')]) {
        scriptedConnection((sql) => (isPolicyRead(sql) ? failure : setScript(OTHER_ID)(sql, undefined)))
        const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID })
        expect(res.statusCode).toBe(500)
        expect(res.body).toEqual(errorBody('ROUTING_POLICY_WRITE_FAILED', 'Failed to update the routing policy'))
        expect(auditMocks.auditLog).not.toHaveBeenCalled()
      }
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('only the transaction is mapped: a failure after the commit, whatever its code, is not answered as "nothing was changed"', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    try {
      for (const code of ['40P01', '55P03', '57014']) {
        const connection = scriptedConnection(setScript(OTHER_ID))
        auditMocks.auditLog.mockRejectedValueOnce(sqlStateError(code))
        const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID })
        // The upsert ran and the transaction ended without an error before the audit write failed.
        expect(connection.texts()[connection.texts().length - 1]).toMatch(UPSERT)
        expect(res.statusCode, code).toBe(500)
        expect(res.body).toEqual(errorBody('ROUTING_POLICY_WRITE_FAILED', 'Failed to update the routing policy'))
      }
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a value that is neither a uuid nor null is 400 before any statement; other fields stay rejected', async () => {
    scriptedConnection()
    for (const expected of ['nope', 7, '', {}]) {
      const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: expected })
      expect(res.statusCode, JSON.stringify(expected)).toBe(400)
    }
    const smuggled = await patchPolicy({ canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: null, orgId: 'other' })
    expect(smuggled.statusCode).toBe(400)
    expect((smuggled.body as { error: { message: string } }).error.message).toBe('Unexpected field(s): orgId')
    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })
})
