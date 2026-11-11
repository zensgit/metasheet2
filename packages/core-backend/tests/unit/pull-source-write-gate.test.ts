/**
 * Pull-source write gate (src/directory/pull-source-write-gate.ts) and the routing-policy PATCH that
 * uses it, without a database: the database module is replaced by a scripted connection that records
 * every statement, so what is pinned here is which statements a gate transaction issues, in which order,
 * and what each outcome becomes. What PostgreSQL does with those statements (locks, isolation, waits) is
 * pinned by tests/integration/directory-pull-source-gate.db.test.ts.
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
import {
  DIRECTORY_ROUTING_GATE_BUSY_MESSAGE,
  DIRECTORY_ROUTING_GATE_UNAVAILABLE_MESSAGE,
  DirectoryRoutingGateBusyError,
  DirectoryRoutingGateUnavailableError,
  PULL_SOURCE_GATE_BUSY_SQLSTATES,
  runGatedPullSourceWrite,
  runPullSourceGateTransaction,
  type PullSourceGateClient,
} from '../../src/directory/pull-source-write-gate'
import { adminDirectoryRoutingPolicyRouter } from '../../src/routes/admin-directory-routing-policy'

const RC = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '30s'"
const ORG_LOCK = directoryOrgLockSql('$1')
const PREAMBLE = [RC, LOCK_TIMEOUT, STATEMENT_TIMEOUT]
const WRITE = 'INSERT INTO t VALUES (1)'
const ROW_LOCK = 'SELECT status FROM t WHERE id = $1 FOR UPDATE'

type Rows = Array<Record<string, unknown>>
type Script = (sql: string, params: unknown[] | undefined) => Rows | Error | undefined

/** A gate connection that records every statement and answers from `script` (no rows by default). */
function scriptedConnection(script: Script = () => undefined) {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = []
  const client: PullSourceGateClient = {
    query: async (sql, params) => {
      statements.push({ sql, params })
      const answer = script(sql, params)
      if (answer instanceof Error) throw answer
      return { rows: answer ?? [] }
    },
  }
  pgMocks.transaction.mockImplementation(async (handler: (c: PullSourceGateClient) => Promise<unknown>) => handler(client))
  return { statements, texts: () => statements.map((s) => s.sql) }
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
      expect(contexts).toEqual([{ gated: false, locked: undefined, joined: false }])
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

  it('locks the row first, then the organisation, and decides the join from what the row lock read', async () => {
    const connection = scriptedConnection((sql) => {
      if (sql === ROW_LOCK) return [{ status: 'paused' }]
      if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return [{ other_source_count: 0 }]
      return undefined
    })
    const seen: unknown[] = []
    const outcome = await runGatedPullSourceWrite<unknown, { status: string }>(
      { ...TARGET, enforce: 'flagged' },
      async (client, context) => {
        seen.push(context)
        return client.query(WRITE)
      },
      {
        env: ON,
        lockTarget: async (client) => (await client.query(ROW_LOCK, ['row-1'])).rows[0] as { status: string },
        joins: (locked) => locked.status !== 'active',
      },
    )
    expect(outcome).toMatchObject({ gated: true, joined: true })
    expect(seen).toEqual([{ gated: true, locked: { status: 'paused' }, joined: true }])
    expect(connection.texts()).toEqual([
      ...PREAMBLE, ROW_LOCK, ORG_LOCK, APPROVAL_ROUTING_POLICY_EXISTS_SQL, COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, WRITE,
    ])
  })

  it('a write that adds no source keeps both locks and skips the check', async () => {
    const connection = scriptedConnection((sql) => {
      if (sql === ROW_LOCK) return [{ status: 'active' }]
      // Would refuse if the check ran.
      if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return [{ other_source_count: 3 }]
      return undefined
    })
    const outcome = await runGatedPullSourceWrite<unknown, { status: string }>(
      { ...TARGET, enforce: 'flagged' },
      (client) => client.query(WRITE),
      {
        env: ON,
        lockTarget: async (client) => (await client.query(ROW_LOCK, ['row-1'])).rows[0] as { status: string },
        joins: (locked) => locked.status !== 'active',
      },
    )
    expect(outcome).toMatchObject({ gated: true, joined: false })
    expect(connection.texts()).toEqual([...PREAMBLE, ROW_LOCK, ORG_LOCK, WRITE])
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
          if (stage === 'row lock' && sql === ROW_LOCK) return error
          if (stage === 'count' && sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return error
          if (stage === 'write' && sql === WRITE) return error
          if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return [{ other_source_count: 0 }]
          return undefined
        })
        if (stage === 'commit') pgMocks.transaction.mockRejectedValue(error)
        const failure = await failureOf(
          runGatedPullSourceWrite({ ...TARGET, enforce: 'always' }, (client) => client.query(WRITE), {
            lockTarget: async (client) => { await client.query(ROW_LOCK) },
          }),
        )
        expect(failure).toBeInstanceOf(DirectoryRoutingGateBusyError)
        expect((failure as DirectoryRoutingGateBusyError).sqlState).toBe(code)
        expect((failure as DirectoryRoutingGateBusyError).code).toBe('DIRECTORY_ROUTING_GATE_BUSY')
        expect((failure as Error).message).toBe(DIRECTORY_ROUTING_GATE_BUSY_MESSAGE)
        expect((failure as Error).message).not.toContain('org-secret-1')
        // Nothing follows the failed statement: in particular no read and no write without the lock.
        if (stage === 'organisation lock') expect(connection.texts()).toEqual([...PREAMBLE, ROW_LOCK, ORG_LOCK])
        if (stage === 'row lock') expect(connection.texts()).toEqual([...PREAMBLE, ROW_LOCK])
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
    expect(await failureOf(runPullSourceGateTransaction('org-1', async () => 1))).toBe(plain)
  })

  it('the bare transaction has the same preamble, lock and mapping', async () => {
    const connection = scriptedConnection()
    await expect(runPullSourceGateTransaction('org-9', async (client) => (await client.query('SELECT 1')).rows.length)).resolves.toBe(0)
    expect(connection.statements.slice(0, 4)).toEqual([
      { sql: RC, params: undefined },
      { sql: LOCK_TIMEOUT, params: undefined },
      { sql: STATEMENT_TIMEOUT, params: undefined },
      { sql: ORG_LOCK, params: ['org-9'] },
    ])
    scriptedConnection()
    const failure = await failureOf(runPullSourceGateTransaction('org-9', async () => { throw new PullSourceCountUnavailableError('org-9') }))
    expect(failure).toBeInstanceOf(DirectoryRoutingGateUnavailableError)
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

  it('absent: the set is unconditional, takes no organisation lock, and audits the operator and the previous canonical', async () => {
    for (const current of [null, OTHER_ID]) {
      auditMocks.auditLog.mockClear()
      const connection = scriptedConnection(setScript(current))
      const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID })
      expect(res.statusCode).toBe(200)
      const texts = connection.texts()
      expect(texts).toHaveLength(3)
      expect(isTargetLock(texts[0])).toBe(true)
      expect(isPolicyRead(texts[1])).toBe(true)
      expect(texts[2]).toMatch(UPSERT)
      expect(texts).not.toContain(ORG_LOCK)
      expect(texts).not.toContain(RC)
      expect(auditMocks.auditLog.mock.calls).toEqual(setAudit(current))
    }
  })

  it('matching uuid (any letter case): the set goes through', async () => {
    const connection = scriptedConnection(setScript(OTHER_ID))
    const res = await patchPolicy({ canonicalIntegrationId: TARGET_ID, expectedCurrentCanonicalIntegrationId: OTHER_ID.toUpperCase() })
    expect(res.statusCode).toBe(200)
    // A conditional set pins READ COMMITTED first; an unconditional one (above) does not.
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
