import express from 'express'
import { Client } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pull-source write gate against real PostgreSQL.
 *
 * Invariants proven here:
 *  - With the approval-routing switch on, no supported entry (creating an active integration, a save
 *    that turns a non-active integration active) leaves an organisation with two or more active pull
 *    sources and no approval-routing policy; with two concurrent writers the end state satisfies this
 *    whichever goes first.
 *  - An organisation with two or more active pull sources keeps its approval-routing policy: a clear
 *    is refused whatever the switch says, and a clear with no policy row keeps answering
 *    `cleared: false`.
 *  - Whether a save turns a row active is decided from the status read under the row lock, and the
 *    statement applies only while the row still carries that status.
 *  - A gate transaction runs under READ COMMITTED with bounded waits, holds the organisation's
 *    advisory lock while it reads and writes, and ends with nothing written when it loses a lock race
 *    (deadlock, lock wait timeout, cancelled statement) or cannot read the source count.
 *  - A policy set takes no organisation lock; when PostgreSQL ends its transaction (deadlock, cancelled
 *    statement) it answers the same retryable 503 with nothing written.
 *  - A successful transition writes one values-free audit row naming the operator; a refusal writes
 *    none and logs one values-free line.
 *  - With the switch off the legacy entries issue the single statement they always issued.
 *  - Only active rows count as sources, and two rows are the same source when provider and corp id are
 *    equal. The cases named "current definition" pin exactly that; they change if the definition does.
 *
 * `directoryOrgLockSql()` and `COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL` execute on PostgreSQL in this file.
 *
 * HARNESS: the whole service pool of this file runs with `default_transaction_isolation = repeatable
 * read` (DATABASE_URL is amended inside vi.hoisted, before the pool is built), so every case below also
 * shows that the gate does not depend on the deployment's default isolation level. A sentinel asserts
 * the posture is active. vitest.integration.config.ts runs files in isolated forks without file
 * parallelism, so the posture stays in this file.
 *
 * Route-level cases live in organisation 'default' (the only organisation the routes address): before
 * each case the other active pull-type rows and the policy rows of that organisation are set aside,
 * and restored afterwards. Cases that call the gate directly use an organisation id of their own.
 *
 * Statements issued inside pool transactions pass through a recorder that a case can hook by statement
 * text: to park a transaction at a known statement (a deterministic interleave, observed through
 * pg_locks, never a sleep), to read the transaction's own connection, or to answer a count statement
 * with an empty row set. The recorder forwards everything else unchanged.
 *
 * DATABASE_URL-gated; excluded from the no-DB job and wired as a whole file into the approval real-DB
 * step of plugin-tests.yml; the EXPECT_DB sentinel below fails instead of skipping when that step has
 * no database.
 */
vi.hoisted(() => {
  const base = process.env.DATABASE_URL
  if (base) {
    const sep = base.includes('?') ? '&' : '?'
    // libpq `options`: spaces separate arguments unless backslash-escaped.
    process.env.DATABASE_URL = `${base}${sep}options=${encodeURIComponent(
      '-c default_transaction_isolation=repeatable\\ read',
    )}`
  }
})

import { Logger } from '../../src/core/logger'
import { query, transaction } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import {
  COUNT_ACTIVE_PULL_SOURCES_SQL,
  COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL,
  DirectoryRoutingPolicyRequiredError,
  countActivePullSources,
  directoryOrgLockKey,
  directoryOrgLockSql,
  isApprovalRoutingPolicyRequired,
} from '../../src/directory/pull-source-rule'
import {
  DirectoryRoutingGateBusyError,
  runGatedPullSourceWrite,
  type PullSourceGateClient,
} from '../../src/directory/pull-source-write-gate'
import { poolManager } from '../../src/integration/db/connection-pool'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'
import { adminDirectoryRoutingPolicyRouter } from '../../src/routes/admin-directory-routing-policy'
import { usePinnedServer } from '../utils/pinned-server'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

itIfExpectDb('requires a real DB', () => {
  expect(process.env.DATABASE_URL, 'EXPECT_DB=1 but DATABASE_URL is not set').toBeTruthy()
})

const STAMP = `${Date.now()}`
const DEFAULT_ORG = 'default'
const ADMIN = `ars2-admin-${STAMP}`
const NAME_PREFIX = `ARS2 ${STAMP}`
const ORG_PREFIX = `ars2-${STAMP}-`
const SET_ASIDE = 'ars2-set-aside:'
const SWITCH = 'APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED'
const INTEGRATIONS = '/api/admin/directory/integrations'
const POLICY = '/api/admin/directory/routing-policy/approval_routing'

const RC_PIN = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const ORG_LOCK = directoryOrgLockSql('$1')
const isPolicyRowLock = (sql: string): boolean => /FROM org_directory_routing_policy\s+WHERE org_id = \$1 AND purpose = \$2\s+FOR UPDATE/.test(sql)
const isIntegrationInsert = (sql: string): boolean => /^\s*INSERT INTO directory_integrations\b/.test(sql)
const isIntegrationUpdate = (sql: string): boolean => /^\s*UPDATE directory_integrations\s+SET name = \$2/.test(sql)
const isPolicyInsert = (sql: string): boolean => /^\s*INSERT INTO org_directory_routing_policy\b/.test(sql)

// ── recorder over pool transactions ─────────────────────────────────────────────────────────────────

type Rows = { rows: Array<Record<string, unknown>> }
type RawQuery = (sql: string, params?: unknown[]) => Promise<Rows>
interface Hook {
  phase: 'before' | 'after'
  when: (sql: string) => boolean
  /** A `before` hook that returns a result answers the statement itself; the statement is not sent. */
  run: (connection: { query: RawQuery }, sql: string, params: unknown[] | undefined) => Promise<Rows | void>
  once: boolean
  fired: number
}
const hooks: Hook[] = []
/** Release functions of every park of the running case; all are called when the case ends. */
const parkReleases: Array<() => void> = []
/** One entry per pool transaction started since the last reset: the statements it issued, in order. */
const transactions: Array<Array<{ sql: string; params: unknown[] | undefined }>> = []

function addHook(phase: Hook['phase'], when: Hook['when'], run: Hook['run'], once = true): Hook {
  const hook: Hook = { phase, when, run, once, fired: 0 }
  hooks.push(hook)
  return hook
}

async function runHooks(phase: Hook['phase'], connection: { query: RawQuery }, sql: string, params: unknown[] | undefined): Promise<Rows | void> {
  for (const hook of hooks) {
    if (hook.phase !== phase || !hook.when(sql) || (hook.once && hook.fired > 0)) continue
    hook.fired += 1
    const answer = await hook.run(connection, sql, params)
    if (answer) return answer
  }
}

/** Transactions that took an organisation lock, i.e. gate transactions. */
const gateTransactions = () => transactions.filter((statements) => statements.some((s) => s.sql === ORG_LOCK))

/** Parks the first transaction that reaches a statement, before the statement is sent. */
function parkBefore(when: (sql: string) => boolean): { reached: Promise<void>; release: () => void } {
  let signalReached!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => { signalReached = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  addHook('before', when, async () => {
    signalReached()
    await released
  })
  parkReleases.push(release)
  return { reached, release }
}

// ── observation helpers ─────────────────────────────────────────────────────────────────────────────

const ADVISORY_KEY_MATCH = `locktype = 'advisory' AND objsubid = 1
   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
   AND ((classid::bigint << 32) | objid::bigint) = hashtext($1)::bigint`

async function advisoryLocks(orgId: string): Promise<{ granted: number[]; waiting: number[] }> {
  const r = await query<{ pid: number; granted: boolean }>(
    `SELECT pid, granted FROM pg_locks WHERE ${ADVISORY_KEY_MATCH}`,
    [directoryOrgLockKey(orgId)],
  )
  return {
    granted: r.rows.filter((row) => row.granted).map((row) => row.pid),
    waiting: r.rows.filter((row) => !row.granted).map((row) => row.pid),
  }
}

async function poll<T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Resolves with the pid of a backend that is waiting for the organisation lock. */
function waiterOnOrgLock(orgId: string): Promise<number> {
  return poll(`a backend waiting for the organisation lock of ${orgId}`, async () => (await advisoryLocks(orgId)).waiting[0])
}

async function waitUntilBlocked(pid: number): Promise<void> {
  await poll(`backend ${pid} to wait for a lock`, async () => {
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
      [pid],
    )
    return (r.rows[0]?.n ?? 0) > 0
  })
}

/** A dedicated raw connection, never from the service pool. */
async function withRawConnection<T>(fn: (client: Client, pid: number) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    return await fn(client, pid)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────

let serial = 0
const nextTag = (): string => `${(serial += 1)}`
const newOrg = (label: string): string => `${ORG_PREFIX}${label}-${nextTag()}`
const corpOf = (label: string): string => `corp-ars2-${STAMP}-${label}`

async function seedIntegration(
  orgId: string,
  corp: string,
  options: { status?: string; provider?: string; config?: Record<string, unknown> } = {},
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id::text AS id`,
    [
      orgId,
      options.provider ?? 'dingtalk',
      `${NAME_PREFIX} ${nextTag()}`,
      options.status ?? 'active',
      corp,
      JSON.stringify(options.config ?? { appKey: `key-${corp}`, appSecret: 'seeded-secret' }),
    ],
  )
  return r.rows[0].id
}

async function seedPolicy(orgId: string, integrationId: string): Promise<void> {
  await query(
    `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id) VALUES ($1, 'approval_routing', $2)`,
    [orgId, integrationId],
  )
}

const setStatus = (integrationId: string, status: string) =>
  query(`UPDATE directory_integrations SET status = $2 WHERE id = $1`, [integrationId, status])

async function statusOf(integrationId: string): Promise<string | null> {
  const r = await query<{ status: string }>(`SELECT status FROM directory_integrations WHERE id = $1`, [integrationId])
  return r.rows[0]?.status ?? null
}

async function ourRows(orgId: string): Promise<Array<{ id: string; status: string; corp_id: string; provider: string }>> {
  const r = await query<{ id: string; status: string; corp_id: string; provider: string }>(
    `SELECT id::text AS id, status, corp_id, provider FROM directory_integrations
      WHERE org_id = $1 AND name LIKE $2 ORDER BY created_at, id`,
    [orgId, `${NAME_PREFIX}%`],
  )
  return r.rows
}

async function canonicalOf(orgId: string): Promise<string | null> {
  const r = await query<{ canonical: string }>(
    `SELECT canonical_integration_id::text AS canonical FROM org_directory_routing_policy
      WHERE org_id = $1 AND purpose = 'approval_routing'`,
    [orgId],
  )
  return r.rows[0]?.canonical ?? null
}

/** The state the rule forbids: two or more active pull sources and no approval-routing policy. */
async function expectRuleHolds(orgId: string): Promise<{ sourceCount: number; hasPolicy: boolean }> {
  const status = await isApprovalRoutingPolicyRequired(query, orgId)
  expect(status.required, `organisation has ${status.sourceCount} active pull sources and policy=${status.hasPolicy}`).toBe(false)
  return { sourceCount: status.sourceCount, hasPolicy: status.hasPolicy }
}

type AuditRow = { action: string; resource_id: string; user_id: unknown; action_details: Record<string, unknown> }
async function auditRows(action: string): Promise<AuditRow[]> {
  const r = await query<AuditRow>(
    `SELECT action, resource_id, user_id, action_details FROM audit_logs
      WHERE action = $1 AND action_details->>'actorId' = $2 ORDER BY created_at, id`,
    [action, ADMIN],
  )
  return r.rows
}
const CREATE_AUDIT = 'directory.integration.pull_source_create'
const ACTIVATE_AUDIT = 'directory.integration.pull_source_activate'
const SET_AUDIT = 'directory.routing_policy.set'
const CLEAR_AUDIT = 'directory.routing_policy.clear'

const createBody = (corp: string, extra: Record<string, unknown> = {}) => ({
  name: `${NAME_PREFIX} ${nextTag()}`,
  corpId: corp,
  appKey: `key-${corp}`,
  appSecret: `secret-${corp}`,
  ...extra,
})

const errorOf = (res: { body: { error?: { code?: string; message?: string } } }) => ({ code: res.body.error?.code, message: res.body.error?.message })
const POLICY_REQUIRED = { code: 'DIRECTORY_ROUTING_POLICY_REQUIRED', message: 'A routing policy is required before another directory source can be added' }
const GATE_BUSY = { code: 'DIRECTORY_ROUTING_GATE_BUSY', message: 'The directory source check is busy with a concurrent change; nothing was changed. Retry.' }
const GATE_UNAVAILABLE = { code: 'DIRECTORY_ROUTING_GATE_UNAVAILABLE', message: 'The directory source check could not be completed; nothing was changed. Retry.' }
const CLEAR_BLOCKED = { code: 'ROUTING_POLICY_CLEAR_BLOCKED', message: 'The routing policy cannot be cleared while the organization has more than one active directory source' }
const STATE_CHANGED = { code: 'ROUTING_POLICY_STATE_CHANGED', message: 'The routing policy is not in the expected state; reload before applying' }

describeIfDatabase('pull-source write gate (real DB, pool default REPEATABLE READ)', () => {
  const pinned = usePinnedServer()
  let warnSpy: ReturnType<typeof vi.spyOn>
  let setAside: { integrationIds: string[]; policies: Array<{ purpose: string; canonical: string; fallback: string | null }> }

  const api = () => request(pinned.url())
  const createViaRoute = (body: Record<string, unknown>) => api().post(INTEGRATIONS).send(body)
  const updateViaRoute = (id: string, body: Record<string, unknown>) => api().put(`${INTEGRATIONS}/${id}`).send(body)
  const patchPolicy = (body: Record<string, unknown>) => api().patch(POLICY).send(body)
  /** What the route's PUT needs to keep a seeded row as it is, apart from the fields a case overrides. */
  const saveBody = (corp: string, extra: Record<string, unknown> = {}) => ({ name: `${NAME_PREFIX} ${nextTag()}`, corpId: corp, appKey: `key-${corp}`, ...extra })
  /** Everything handed to logger.warn. */
  const warned = (): Array<{ message: string; meta: unknown }> => warnSpy.mock.calls.map((args) => ({ message: String(args[0]), meta: args[1] }))
  /** The warn lines that carry a refusal code: the one line a gate or clear refusal writes. */
  const refusalLogs = (): Array<{ message: string; meta: Record<string, unknown> }> => warned()
    .filter((entry): entry is { message: string; meta: Record<string, unknown> } =>
      !!entry.meta && typeof entry.meta === 'object' && typeof (entry.meta as { code?: unknown }).code === 'string')

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: unknown }).user = { id: ADMIN, role: 'admin' }
      next()
    })
    app.use('/api/admin/directory/routing-policy', adminDirectoryRoutingPolicyRouter())
    app.use('/api/admin/directory', adminDirectoryRouter())
    pinned.setApp(app)

    // Recorder: every statement of every pool transaction passes through the hooks.
    const pool = poolManager.get()
    const original = pool.transaction.bind(pool) as (handler: (client: { query: RawQuery }) => Promise<unknown>) => Promise<unknown>
    vi.spyOn(pool, 'transaction').mockImplementation(((handler: (client: { query: RawQuery }) => Promise<unknown>) => {
      const statements: Array<{ sql: string; params: unknown[] | undefined }> = []
      transactions.push(statements)
      return original((client) => handler({
        ...client,
        query: async (sql: string, params?: unknown[]) => {
          statements.push({ sql, params })
          const answered = await runHooks('before', client, sql, params)
          if (answered) return answered
          const result = await client.query(sql, params)
          await runHooks('after', client, sql, params)
          return result
        },
      }))
    }) as never)
  })

  beforeEach(async () => {
    delete process.env[SWITCH]
    hooks.length = 0
    transactions.length = 0
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    // Set aside what other suites left in the shared organisation, so a case starts from its own rows.
    const policies = await query<{ purpose: string; canonical: string; fallback: string | null }>(
      `SELECT purpose, canonical_integration_id::text AS canonical, fallback_integration_id::text AS fallback
         FROM org_directory_routing_policy WHERE org_id = $1`,
      [DEFAULT_ORG],
    )
    await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [DEFAULT_ORG])
    const others = await query<{ id: string }>(
      `UPDATE directory_integrations SET status = $2::text || status
        WHERE org_id = $1 AND provider <> 'local' AND status = 'active'
        RETURNING id::text AS id`,
      [DEFAULT_ORG, SET_ASIDE],
    )
    setAside = { integrationIds: others.rows.map((row) => row.id), policies: policies.rows }
  })

  afterEach(async () => {
    delete process.env[SWITCH]
    // A case that failed half-way must not leave a transaction parked on a pooled connection.
    for (const release of parkReleases.splice(0)) release()
    hooks.length = 0
    warnSpy.mockRestore()
    await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1 OR org_id LIKE $2`, [DEFAULT_ORG, `${ORG_PREFIX}%`])
    await query(
      `DELETE FROM directory_accounts WHERE integration_id IN
         (SELECT id FROM directory_integrations WHERE name LIKE $1 OR org_id LIKE $2)`,
      [`${NAME_PREFIX}%`, `${ORG_PREFIX}%`],
    )
    await query(`DELETE FROM directory_integrations WHERE name LIKE $1 OR org_id LIKE $2`, [`${NAME_PREFIX}%`, `${ORG_PREFIX}%`])
    await query(`DELETE FROM users WHERE id LIKE $1`, [`ars2-user-${STAMP}-%`])
    await query(
      `DELETE FROM audit_logs WHERE action_details->>'actorId' = $1 OR action_details->>'orgId' LIKE $2`,
      [ADMIN, `${ORG_PREFIX}%`],
    )
    await query(
      `UPDATE directory_integrations SET status = substr(status, $2::int) WHERE id = ANY($1::uuid[])`,
      [setAside.integrationIds, SET_ASIDE.length + 1],
    )
    for (const policy of setAside.policies) {
      await query(
        `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id, fallback_integration_id)
         VALUES ($1, $2, $3, $4)`,
        [DEFAULT_ORG, policy.purpose, policy.canonical, policy.fallback],
      )
    }
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  it('G10 sentinel: the service pool runs with default_transaction_isolation = repeatable read', async () => {
    const def = await query<{ default_transaction_isolation: string }>('SHOW default_transaction_isolation')
    expect(def.rows[0].default_transaction_isolation).toBe('repeatable read')
    const inTransaction = await transaction(async (client) => {
      const r = await client.query('SHOW transaction_isolation')
      return (r.rows[0] as { transaction_isolation: string }).transaction_isolation
    })
    // A bare pool transaction inherits the default: without its own pin a gate transaction would run here.
    expect(inTransaction).toBe('repeatable read')
  })

  it('G1 switch on: a second pull source is refused until the organisation has a policy, then created and audited; the gate transaction holds the organisation lock under READ COMMITTED with bounded waits', async () => {
    process.env[SWITCH] = 'true'
    const first = await seedIntegration(DEFAULT_ORG, corpOf('g1-x'))
    const secondCorp = corpOf('g1-y')

    const refused = await createViaRoute(createBody(secondCorp))
    expect(refused.status).toBe(409)
    expect(errorOf(refused)).toEqual(POLICY_REQUIRED)
    expect(await ourRows(DEFAULT_ORG)).toHaveLength(1)
    expect(await auditRows(CREATE_AUDIT)).toHaveLength(0)
    // The refusal is logged once, values-free: the code and the operator, no corp id.
    expect(refusalLogs()).toEqual([{ message: 'Directory source write refused: a routing policy is required', meta: { code: 'DIRECTORY_ROUTING_POLICY_REQUIRED', actorId: ADMIN } }])
    expect(JSON.stringify(refused.body) + JSON.stringify(warned())).not.toContain(secondCorp)
    expect((await advisoryLocks(DEFAULT_ORG)).granted).toEqual([])

    const set = await patchPolicy({ canonicalIntegrationId: first })
    expect(set.status).toBe(200)

    // Witness on the gate transaction's own connection, right after it took the organisation lock.
    const witness: { pid?: number; isolation?: string; lockTimeout?: string; statementTimeout?: string; holders?: number[] } = {}
    addHook('after', (sql) => sql === ORG_LOCK, async (connection) => {
      witness.pid = Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      witness.isolation = String((await connection.query('SHOW transaction_isolation')).rows[0].transaction_isolation)
      witness.lockTimeout = String((await connection.query('SHOW lock_timeout')).rows[0].lock_timeout)
      witness.statementTimeout = String((await connection.query('SHOW statement_timeout')).rows[0].statement_timeout)
      witness.holders = (await advisoryLocks(DEFAULT_ORG)).granted
    })
    transactions.length = 0
    const created = await createViaRoute(createBody(secondCorp))
    expect(created.status).toBe(200)
    expect(witness.isolation).toBe('read committed')
    expect(witness.lockTimeout).toBe('5s')
    expect(witness.statementTimeout).toBe('25s')
    expect(witness.holders).toEqual([witness.pid])
    // The lock ends with the transaction, and the timeouts did not stay on the pooled connection.
    expect((await advisoryLocks(DEFAULT_ORG)).granted).toEqual([])
    const gate = gateTransactions()
    expect(gate).toHaveLength(1)
    expect(gate[0].map((s) => s.sql).slice(0, 4)).toEqual([RC_PIN, "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '25s'", ORG_LOCK])
    expect(gate[0].some((s) => isIntegrationInsert(s.sql))).toBe(true)

    const rows = await ourRows(DEFAULT_ORG)
    expect(rows.map((row) => row.status)).toEqual(['active', 'active'])
    const createdId = created.body.data.integration.id as string
    const audits = await auditRows(CREATE_AUDIT)
    expect(audits).toHaveLength(1)
    expect(audits[0].resource_id).toBe(createdId)
    expect(audits[0].action_details).toEqual({ orgId: DEFAULT_ORG, provider: 'dingtalk', actorId: ADMIN })
    expect(JSON.stringify(audits[0])).not.toContain(secondCorp)
    await expectRuleHolds(DEFAULT_ORG)
  })

  it('G2 switch on: a second row of the same provider and corp id is the same source and is created without a policy', async () => {
    process.env[SWITCH] = 'true'
    const corp = corpOf('g2-x')
    await seedIntegration(DEFAULT_ORG, corp)
    const created = await createViaRoute(createBody(corp))
    expect(created.status).toBe(200)
    expect(await countActivePullSources(query, DEFAULT_ORG)).toBe(1)
    expect((await ourRows(DEFAULT_ORG)).map((row) => row.status)).toEqual(['active', 'active'])
    expect(await auditRows(CREATE_AUDIT)).toHaveLength(1)
    await expectRuleHolds(DEFAULT_ORG)
  })

  it('G3 the local directory is never a pull source: a local-only organisation takes its first pull source, a local target passes the gate, and the local anchor is created and revived without the gate', async () => {
    process.env[SWITCH] = 'true'
    // An organisation whose only integration is the local anchor takes its first pull source.
    const localOnly = newOrg('g3-local-only')
    await getOrCreateLocalIntegration(localOnly)
    const firstJoin = await runGatedPullSourceWrite({ orgId: localOnly, provider: 'dingtalk', corpId: corpOf('g3-first'), enforce: 'flagged' }, async () => 'first')
    expect(firstJoin).toEqual({ result: 'first', gated: true, joined: true })
    // So does the shared organisation through the route, with no other active pull source in it.
    const firstSource = await createViaRoute(createBody(corpOf('g3-route-first')))
    expect(firstSource.status).toBe(200)

    // An organisation with one active pull source and no policy: a further pull source is refused,
    const org = newOrg('g3')
    await seedIntegration(org, corpOf('g3-a'))
    const write = vi.fn(async () => 'written')
    await expect(runGatedPullSourceWrite({ orgId: org, provider: 'wecom', corpId: corpOf('g3-b'), enforce: 'always' }, write))
      .rejects.toBeInstanceOf(DirectoryRoutingPolicyRequiredError)
    expect(write).not.toHaveBeenCalled()
    // …while a local target in the same organisation passes: it is not a pull source.
    const local = await runGatedPullSourceWrite({ orgId: org, provider: 'local', corpId: `local:${org}`, enforce: 'always' }, write)
    expect(local).toEqual({ result: 'written', gated: true, joined: true })

    // The local anchor of an organisation that already has two active pull sources and no policy is
    // created, and after a deactivation revived, without any gate transaction.
    const crowded = newOrg('g3-crowded')
    await seedIntegration(crowded, corpOf('g3-c'))
    await seedIntegration(crowded, corpOf('g3-d'))
    transactions.length = 0
    const anchor = await getOrCreateLocalIntegration(crowded)
    expect(anchor.status).toBe('active')
    await setStatus(anchor.id, 'inactive')
    const revived = await getOrCreateLocalIntegration(crowded)
    expect(revived.id).toBe(anchor.id)
    expect(await statusOf(anchor.id)).toBe('active')
    expect(gateTransactions()).toHaveLength(0)
    // The anchor did not change the count: local rows are not sources.
    expect(await countActivePullSources(query, crowded)).toBe(2)
  })

  it('G4 switch off: a legacy entry creates a second pull source with its single statement; an entry that is always gated is still refused', async () => {
    // Legacy entry, switch off (unset and every non-exact value): one INSERT on the pool, no gate.
    await seedIntegration(DEFAULT_ORG, corpOf('g4-x'))
    for (const [index, value] of [undefined, 'false', 'TRUE', '1'].entries()) {
      if (value === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = value
      transactions.length = 0
      const created = await createViaRoute(createBody(corpOf(`g4-y${index}`)))
      expect(created.status, String(value)).toBe(200)
      expect(gateTransactions()).toHaveLength(0)
    }
    expect(await countActivePullSources(query, DEFAULT_ORG)).toBe(5)
    expect(await auditRows(CREATE_AUDIT)).toHaveLength(0)

    // An entry for a further provider is gated whatever the switch says.
    delete process.env[SWITCH]
    const org = newOrg('g4')
    await seedIntegration(org, corpOf('g4-a'))
    const insertWecom = (client: PullSourceGateClient) => client.query(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ($1, 'wecom', $2, 'active', $3, '{}'::jsonb) RETURNING id::text AS id`,
      [org, `${NAME_PREFIX} ${nextTag()}`, corpOf('g4-b')],
    )
    await expect(runGatedPullSourceWrite({ orgId: org, provider: 'wecom', corpId: corpOf('g4-b'), enforce: 'always' }, insertWecom))
      .rejects.toBeInstanceOf(DirectoryRoutingPolicyRequiredError)
    expect(await ourRows(org)).toHaveLength(1)
    // Control: the same write through a legacy entry runs, because the switch is off.
    const legacy = await runGatedPullSourceWrite({ orgId: org, provider: 'wecom', corpId: corpOf('g4-b'), enforce: 'flagged' }, insertWecom)
    expect(legacy.gated).toBe(false)
    expect(await ourRows(org)).toHaveLength(2)
  })

  it('G5 switch on: a save that turns a non-active second source active is refused (with or without an explicit status); a save that keeps a row active, and a save to a non-active status, are not gated', async () => {
    process.env[SWITCH] = 'true'
    const corpA = corpOf('g5-x')
    const corpB = corpOf('g5-y')
    const a = await seedIntegration(DEFAULT_ORG, corpA)
    const b = await seedIntegration(DEFAULT_ORG, corpB, { status: 'paused' })

    const explicit = await updateViaRoute(b, saveBody(corpB, { status: 'active' }))
    expect(explicit.status).toBe(409)
    expect(errorOf(explicit)).toEqual(POLICY_REQUIRED)
    // Omitting `status` means active: the same transition, the same refusal.
    const omitted = await updateViaRoute(b, saveBody(corpB))
    expect(omitted.status).toBe(409)
    expect(errorOf(omitted)).toEqual(POLICY_REQUIRED)
    expect(await statusOf(b)).toBe('paused')
    expect(await auditRows(ACTIVATE_AUDIT)).toHaveLength(0)
    expect(refusalLogs().map((entry) => entry.meta)).toEqual([
      { code: 'DIRECTORY_ROUTING_POLICY_REQUIRED', actorId: ADMIN, integrationId: b },
      { code: 'DIRECTORY_ROUTING_POLICY_REQUIRED', actorId: ADMIN, integrationId: b },
    ])

    // A save to a non-active status adds no source: one statement, no gate transaction.
    transactions.length = 0
    const pausedAgain = await updateViaRoute(b, saveBody(corpB, { status: 'paused' }))
    expect(pausedAgain.status).toBe(200)
    expect(gateTransactions()).toHaveLength(0)

    // A save that keeps an active row active is not a transition: it passes even where a transition
    // would be refused (two active sources, no policy), and writes no audit row.
    await setStatus(b, 'active')
    const renamed = await updateViaRoute(a, saveBody(corpA))
    expect(renamed.status).toBe(200)
    expect(await statusOf(a)).toBe('active')
    expect(await auditRows(ACTIVATE_AUDIT)).toHaveLength(0)

    // With a policy the transition goes through and is audited.
    await setStatus(b, 'paused')
    await seedPolicy(DEFAULT_ORG, a)
    const activated = await updateViaRoute(b, saveBody(corpB, { status: 'active' }))
    expect(activated.status).toBe(200)
    expect(await statusOf(b)).toBe('active')
    const audits = await auditRows(ACTIVATE_AUDIT)
    expect(audits).toHaveLength(1)
    expect(audits[0].resource_id).toBe(b)
    expect(audits[0].action_details).toEqual({ orgId: DEFAULT_ORG, provider: 'dingtalk', actorId: ADMIN })
    await expectRuleHolds(DEFAULT_ORG)
  })

  it('G5b a save that read "active" before its transaction, on a row paused meanwhile, is a transition: it is decided from the status read under the row lock', async () => {
    process.env[SWITCH] = 'true'
    const corpB = corpOf('g5b-y')
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g5b-x'))
    const b = await seedIntegration(DEFAULT_ORG, corpB)
    await seedPolicy(DEFAULT_ORG, a)

    // The save has read the row (active) and is parked before the first statement of its transaction.
    const parked = parkBefore((sql) => sql === RC_PIN)
    const save = updateViaRoute(b, saveBody(corpB, { status: 'active' })).then((res) => res)
    await parked.reached
    // Meanwhile the row is paused (a committed write that leaves the configuration untouched) and, the
    // organisation now having one active source, its policy is cleared.
    await setStatus(b, 'paused')
    const cleared = await patchPolicy({ canonicalIntegrationId: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.data.cleared).toBe(true)
    parked.release()

    const res = await save
    expect(res.status).toBe(409)
    expect(errorOf(res)).toEqual(POLICY_REQUIRED)
    expect(await statusOf(b)).toBe('paused')
    expect(await expectRuleHolds(DEFAULT_ORG)).toEqual({ sourceCount: 1, hasPolicy: false })
  })

  it('G5c the gated save applies only while the row still carries the status read under its lock', async () => {
    process.env[SWITCH] = 'true'
    const corpB = corpOf('g5c-y')
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g5c-x'))
    const b = await seedIntegration(DEFAULT_ORG, corpB, { status: 'paused' })
    await seedPolicy(DEFAULT_ORG, a)

    // After the row lock read "paused" and the organisation lock was taken, the same transaction's
    // connection moves the row to another status. The save must then match no row.
    addHook('after', (sql) => sql === ORG_LOCK, async (connection) => {
      await connection.query(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [b])
    })
    transactions.length = 0
    const res = await updateViaRoute(b, saveBody(corpB, { status: 'active' }))
    expect(res.status).toBe(409)
    expect(errorOf(res)).toEqual({ code: 'DIRECTORY_UPDATE_FAILED', message: 'Directory configuration changed; reload before saving' })
    expect(await statusOf(b)).toBe('disabled')
    expect(await auditRows(ACTIVATE_AUDIT)).toHaveLength(0)
    // The statement itself: the guard is the twelfth placeholder, bound to the status read under the lock.
    const save = gateTransactions()[0].find((s) => isIntegrationUpdate(s.sql))
    expect(save?.sql).toContain('WHERE id = $1 AND config IS NOT DISTINCT FROM $10::jsonb AND corp_id = $11 AND status = $12')
    expect(save?.params).toHaveLength(12)
    expect(save?.params?.[11]).toBe('paused')
    // Row lock first, then the organisation lock.
    const texts = gateTransactions()[0].map((s) => s.sql)
    const rowLock = texts.findIndex((sql) => /FROM directory_integrations\s+WHERE id = \$1 AND provider = \$2\s+FOR UPDATE/.test(sql))
    expect(rowLock).toBe(3)
    expect(texts.indexOf(ORG_LOCK)).toBe(4)
  })

  it('G6 a policy is not cleared while the organisation has two or more active pull sources; with one it is cleared and audited; with no policy row the answer stays cleared:false', async () => {
    process.env[SWITCH] = 'true'
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g6-x'))
    const b = await seedIntegration(DEFAULT_ORG, corpOf('g6-y'))
    await seedPolicy(DEFAULT_ORG, a)

    const blocked = await patchPolicy({ canonicalIntegrationId: null })
    expect(blocked.status).toBe(409)
    expect(errorOf(blocked)).toEqual(CLEAR_BLOCKED)
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a)
    expect(await auditRows(CLEAR_AUDIT)).toHaveLength(0)
    expect(refusalLogs()).toEqual([{
      message: 'Routing policy clear refused: the organisation has more than one active pull source',
      meta: { code: 'ROUTING_POLICY_CLEAR_BLOCKED', actorId: ADMIN },
    }])

    await setStatus(b, 'paused')
    transactions.length = 0
    const cleared = await patchPolicy({ canonicalIntegrationId: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.data).toEqual({ cleared: true })
    expect(await canonicalOf(DEFAULT_ORG)).toBeNull()
    // The clear ran in a gate transaction: organisation lock, the policy row, the count, the delete.
    expect(gateTransactions()).toHaveLength(1)
    expect(gateTransactions()[0].map((s) => s.sql).slice(0, 4)).toEqual([RC_PIN, "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '25s'", ORG_LOCK])
    expect(gateTransactions()[0][5].sql).toBe(COUNT_ACTIVE_PULL_SOURCES_SQL)
    const audits = await auditRows(CLEAR_AUDIT)
    expect(audits).toHaveLength(1)
    expect(audits[0].resource_id).toBe(`${DEFAULT_ORG}:approval_routing`)
    expect(audits[0].action_details).toEqual({ orgId: DEFAULT_ORG, purpose: 'approval_routing', actorId: ADMIN, previousCanonicalIntegrationId: a })

    // No policy row: cleared:false and no audit, also when the organisation has two active sources.
    const again = await patchPolicy({ canonicalIntegrationId: null })
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual({ cleared: false })
    await setStatus(b, 'active')
    const crowded = await patchPolicy({ canonicalIntegrationId: null })
    expect(crowded.status).toBe(200)
    expect(crowded.body.data).toEqual({ cleared: false })
    expect(await auditRows(CLEAR_AUDIT)).toHaveLength(1)
  })

  it('G6-OFF switch off: after a second source joined through an entry that is always gated, the policy is still not cleared', async () => {
    delete process.env[SWITCH]
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g6off-x'))
    await seedPolicy(DEFAULT_ORG, a)
    const joined = await runGatedPullSourceWrite(
      { orgId: DEFAULT_ORG, provider: 'wecom', corpId: corpOf('g6off-y'), enforce: 'always' },
      (client) => client.query(
        `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
         VALUES ($1, 'wecom', $2, 'active', $3, '{}'::jsonb) RETURNING id::text AS id`,
        [DEFAULT_ORG, `${NAME_PREFIX} ${nextTag()}`, corpOf('g6off-y')],
      ),
    )
    expect(joined).toMatchObject({ gated: true, joined: true })
    expect(await countActivePullSources(query, DEFAULT_ORG)).toBe(2)

    for (const value of [undefined, 'false']) {
      if (value === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = value
      const blocked = await patchPolicy({ canonicalIntegrationId: null })
      expect(blocked.status, String(value)).toBe(409)
      expect(errorOf(blocked)).toEqual(CLEAR_BLOCKED)
    }
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a)
    expect(await auditRows(CLEAR_AUDIT)).toHaveLength(0)
    await expectRuleHolds(DEFAULT_ORG)
  })

  it('G7 clearing the policy and creating a second source serialise on the organisation lock (the clear first): exactly one succeeds and the rule holds', async () => {
    process.env[SWITCH] = 'true'
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g7a-x'))
    await seedPolicy(DEFAULT_ORG, a)

    // The clear holds the organisation lock and is parked before it reads the policy row.
    const parked = parkBefore(isPolicyRowLock)
    const clear = patchPolicy({ canonicalIntegrationId: null }).then((res) => res)
    await parked.reached
    const holder = (await advisoryLocks(DEFAULT_ORG)).granted
    expect(holder).toHaveLength(1)
    let createSettled = false
    const create = createViaRoute(createBody(corpOf('g7a-y'))).then((res) => {
      createSettled = true
      return res
    })
    // The create is waiting for that same lock, not for anything else.
    const waiter = await waiterOnOrgLock(DEFAULT_ORG)
    expect(waiter).not.toBe(holder[0])
    expect(createSettled).toBe(false)
    parked.release()

    const [clearRes, createRes] = await Promise.all([clear, create])
    expect(clearRes.status).toBe(200)
    expect(clearRes.body.data).toEqual({ cleared: true })
    expect(createRes.status).toBe(409)
    expect(errorOf(createRes)).toEqual(POLICY_REQUIRED)
    expect(await expectRuleHolds(DEFAULT_ORG)).toEqual({ sourceCount: 1, hasPolicy: false })
    expect(await ourRows(DEFAULT_ORG)).toHaveLength(1)
  })

  it('G7 creating a second source and clearing the policy serialise on the organisation lock (the create first): exactly one succeeds and the rule holds', async () => {
    process.env[SWITCH] = 'true'
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g7b-x'))
    await seedPolicy(DEFAULT_ORG, a)

    // The create passed the check (there is a policy) and is parked, holding the lock, before its INSERT.
    const parked = parkBefore(isIntegrationInsert)
    const create = createViaRoute(createBody(corpOf('g7b-y'))).then((res) => res)
    await parked.reached
    expect((await advisoryLocks(DEFAULT_ORG)).granted).toHaveLength(1)
    let clearSettled = false
    const clear = patchPolicy({ canonicalIntegrationId: null }).then((res) => {
      clearSettled = true
      return res
    })
    await waiterOnOrgLock(DEFAULT_ORG)
    expect(clearSettled).toBe(false)
    parked.release()

    const [createRes, clearRes] = await Promise.all([create, clear])
    expect(createRes.status).toBe(200)
    expect(clearRes.status).toBe(409)
    expect(errorOf(clearRes)).toEqual(CLEAR_BLOCKED)
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a)
    expect(await expectRuleHolds(DEFAULT_ORG)).toEqual({ sourceCount: 2, hasPolicy: true })
  })

  it('G7b clearing the policy and setting a paused source active serialise on the organisation lock, in both orders', async () => {
    process.env[SWITCH] = 'true'
    // The clear first.
    {
      const corpB = corpOf('g7c-y')
      const a = await seedIntegration(DEFAULT_ORG, corpOf('g7c-x'))
      const b = await seedIntegration(DEFAULT_ORG, corpB, { status: 'paused' })
      await seedPolicy(DEFAULT_ORG, a)
      const parked = parkBefore(isPolicyRowLock)
      const clear = patchPolicy({ canonicalIntegrationId: null }).then((res) => res)
      await parked.reached
      const activate = updateViaRoute(b, saveBody(corpB, { status: 'active' })).then((res) => res)
      await waiterOnOrgLock(DEFAULT_ORG)
      parked.release()
      const [clearRes, activateRes] = await Promise.all([clear, activate])
      expect(clearRes.status).toBe(200)
      expect(activateRes.status).toBe(409)
      expect(errorOf(activateRes)).toEqual(POLICY_REQUIRED)
      expect(await statusOf(b)).toBe('paused')
      expect(await expectRuleHolds(DEFAULT_ORG)).toEqual({ sourceCount: 1, hasPolicy: false })
      await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [[a, b]])
    }
    // The activation first.
    {
      hooks.length = 0
      const corpB = corpOf('g7d-y')
      const a = await seedIntegration(DEFAULT_ORG, corpOf('g7d-x'))
      const b = await seedIntegration(DEFAULT_ORG, corpB, { status: 'paused' })
      await seedPolicy(DEFAULT_ORG, a)
      const parked = parkBefore(isIntegrationUpdate)
      const activate = updateViaRoute(b, saveBody(corpB, { status: 'active' })).then((res) => res)
      await parked.reached
      const clear = patchPolicy({ canonicalIntegrationId: null }).then((res) => res)
      await waiterOnOrgLock(DEFAULT_ORG)
      parked.release()
      const [activateRes, clearRes] = await Promise.all([activate, clear])
      expect(activateRes.status).toBe(200)
      expect(clearRes.status).toBe(409)
      expect(errorOf(clearRes)).toEqual(CLEAR_BLOCKED)
      expect(await statusOf(b)).toBe('active')
      expect(await expectRuleHolds(DEFAULT_ORG)).toEqual({ sourceCount: 2, hasPolicy: true })
    }
  })

  it('G8 the count is confined to the organisation: sources of another organisation do not count', async () => {
    process.env[SWITCH] = 'true'
    const crowded = newOrg('g8-crowded')
    await seedIntegration(crowded, corpOf('g8-a'))
    await seedIntegration(crowded, corpOf('g8-b'))
    const quiet = newOrg('g8-quiet')
    const corp = corpOf('g8-c')
    const first = await runGatedPullSourceWrite({ orgId: quiet, provider: 'dingtalk', corpId: corp, enforce: 'flagged' }, async () => 'ok')
    expect(first).toEqual({ result: 'ok', gated: true, joined: true })
    await seedIntegration(quiet, corp)
    // The same corp id that another organisation holds is still a different source here.
    await expect(runGatedPullSourceWrite({ orgId: quiet, provider: 'dingtalk', corpId: corpOf('g8-a'), enforce: 'flagged' }, async () => 'no'))
      .rejects.toBeInstanceOf(DirectoryRoutingPolicyRequiredError)
    const otherCount = await query<{ other_source_count: number }>(COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, [quiet, 'dingtalk', corp])
    expect(otherCount.rows[0].other_source_count).toBe(0)
    expect((await query<{ other_source_count: number }>(COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, [crowded, 'dingtalk', corp])).rows[0].other_source_count).toBe(2)
    // The shared organisation is untouched by either.
    expect(await countActivePullSources(query, DEFAULT_ORG)).toBe(0)
  })

  it('G11 a lock wait that times out is a retryable 503 with nothing written, and it ends within the lock timeout', async () => {
    process.env[SWITCH] = 'true'
    await seedIntegration(DEFAULT_ORG, corpOf('g11a-x'))
    await withRawConnection(async (holder) => {
      await holder.query('BEGIN')
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [directoryOrgLockKey(DEFAULT_ORG)])
      const startedAt = Date.now()
      const res = await createViaRoute(createBody(corpOf('g11a-y')))
      const elapsed = Date.now() - startedAt
      expect(res.status).toBe(503)
      expect(errorOf(res)).toEqual(GATE_BUSY)
      // The wait is bounded by the lock timeout (5s), far below the statement timeout (25s).
      expect(elapsed).toBeGreaterThanOrEqual(4500)
      expect(elapsed).toBeLessThan(15000)
      expect(refusalLogs().map((entry) => entry.meta)).toEqual([{ code: 'DIRECTORY_ROUTING_GATE_BUSY', sqlState: '55P03', actorId: ADMIN }])
    })
    expect(await ourRows(DEFAULT_ORG)).toHaveLength(1)
    expect(await auditRows(CREATE_AUDIT)).toHaveLength(0)
    expect(await advisoryLocks(DEFAULT_ORG)).toEqual({ granted: [], waiting: [] })
  }, 25000)

  it('G11 a cancelled statement is a retryable 503 with nothing written', async () => {
    process.env[SWITCH] = 'true'
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g11b-x'))
    await seedPolicy(DEFAULT_ORG, a)
    await withRawConnection(async (holder) => {
      await holder.query('BEGIN')
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [directoryOrgLockKey(DEFAULT_ORG)])
      const clear = patchPolicy({ canonicalIntegrationId: null }).then((res) => res)
      const waiter = await waiterOnOrgLock(DEFAULT_ORG)
      await query('SELECT pg_cancel_backend($1)', [waiter])
      const res = await clear
      expect(res.status).toBe(503)
      expect(errorOf(res)).toEqual(GATE_BUSY)
      expect(refusalLogs().map((entry) => entry.meta)).toEqual([{ code: 'DIRECTORY_ROUTING_GATE_BUSY', sqlState: '57014', actorId: ADMIN }])
    })
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a)
    expect(await auditRows(CLEAR_AUDIT)).toHaveLength(0)
  })

  it('G11 a wait cycle between an activation, a policy clear and a transaction that holds the policy table and wants the integration row is broken: one gate writer gets a retryable 503, the other completes, nothing is half-written', async () => {
    process.env[SWITCH] = 'true'
    const corpB = corpOf('g11c-y')
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g11c-x'))
    const b = await seedIntegration(DEFAULT_ORG, corpB, { status: 'paused' })
    await seedPolicy(DEFAULT_ORG, a)

    // 1. The clear takes the organisation lock and is parked before it touches the policy table.
    const parked = parkBefore(isPolicyRowLock)
    const clear = patchPolicy({ canonicalIntegrationId: null }).then((res) => res)
    await parked.reached
    // 2. The activation locks its row and waits for the organisation lock.
    const activate = updateViaRoute(b, saveBody(corpB, { status: 'active' })).then((res) => res)
    await waiterOnOrgLock(DEFAULT_ORG)

    await withRawConnection(async (third, thirdPid) => {
      // 3. The third transaction (the lock order of a controlled handover) holds the policy table in
      //    SHARE mode and waits for the integration row the activation has locked. Its own deadlock
      //    check is set late, so the waiter PostgreSQL cancels is one of the two gate writers.
      await third.query(`SET deadlock_timeout = '20s'`)
      await third.query('BEGIN')
      await third.query('LOCK TABLE org_directory_routing_policy IN SHARE MODE NOWAIT')
      const rowWait = third.query('SELECT id FROM directory_integrations WHERE id = $1 FOR UPDATE', [b]).then(() => 'granted', (error: { code?: string }) => `failed:${error.code}`)
      await waitUntilBlocked(thirdPid)
      // 4. The clear goes on: its DELETE waits for the table lock, which closes the cycle
      //    clear → third → activation → clear. PostgreSQL cancels one of the two gate writers; the
      //    other completes once the third transaction has the row and ends.
      parked.release()
      await Promise.race([clear, activate])
      expect(await rowWait).toBe('granted')
      await third.query('ROLLBACK')
      const [clearRes, activateRes] = await Promise.all([clear, activate])
      expect([clearRes.status, activateRes.status].sort()).toEqual([200, 503])
      const busy = clearRes.status === 503 ? clearRes : activateRes
      expect(errorOf(busy)).toEqual(GATE_BUSY)
      expect(refusalLogs().map((entry) => entry.meta.sqlState)).toEqual(['40P01'])

      // Nothing half-written: either the clear won (policy gone, row still paused) or the activation
      // won (row active, policy kept).
      if (clearRes.status === 200) {
        expect(await canonicalOf(DEFAULT_ORG)).toBeNull()
        expect(await statusOf(b)).toBe('paused')
        expect(await auditRows(ACTIVATE_AUDIT)).toHaveLength(0)
        expect(await auditRows(CLEAR_AUDIT)).toHaveLength(1)
      } else {
        expect(await canonicalOf(DEFAULT_ORG)).toBe(a)
        expect(await statusOf(b)).toBe('active')
        expect(await auditRows(ACTIVATE_AUDIT)).toHaveLength(1)
        expect(await auditRows(CLEAR_AUDIT)).toHaveLength(0)
      }
    })
    await expectRuleHolds(DEFAULT_ORG)
    expect(await advisoryLocks(DEFAULT_ORG)).toEqual({ granted: [], waiting: [] })
  }, 25000)

  it('G11 a policy set that PostgreSQL ends is a retryable 503 with nothing written: the deadlock victim of a wait cycle with a transaction that holds the policy table and wants the target row, and a cancelled set', async () => {
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g11d-x'))
    const b = await seedIntegration(DEFAULT_ORG, corpOf('g11d-y'))
    await seedPolicy(DEFAULT_ORG, a)

    // Deadlock. The set holds its target row FOR SHARE and is parked before its write.
    await withRawConnection(async (third, thirdPid) => {
      // The third transaction (the lock order of a controlled handover) holds the policy table in SHARE
      // mode and then waits for the row the set has locked. Its own deadlock check is set late, so the
      // waiter PostgreSQL ends is the set.
      await third.query(`SET deadlock_timeout = '20s'`)
      await third.query('BEGIN')
      await third.query('LOCK TABLE org_directory_routing_policy IN SHARE MODE NOWAIT')
      const parked = parkBefore(isPolicyInsert)
      const set = patchPolicy({ canonicalIntegrationId: b }).then((res) => res)
      await parked.reached
      const rowWait = third.query('SELECT id FROM directory_integrations WHERE id = $1 FOR UPDATE', [b]).then(() => 'granted', (error: { code?: string }) => `failed:${error.code}`)
      await waitUntilBlocked(thirdPid)
      // The set goes on: its write waits for the table lock, which closes the cycle set → third → set.
      parked.release()
      const res = await set
      expect(res.status).toBe(503)
      expect(errorOf(res)).toEqual(GATE_BUSY)
      expect(refusalLogs().map((entry) => entry.meta)).toEqual([{ code: 'DIRECTORY_ROUTING_GATE_BUSY', sqlState: '40P01', actorId: ADMIN }])
      expect(await rowWait).toBe('granted')
      await third.query('ROLLBACK')
    })
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a)
    expect(await auditRows(SET_AUDIT)).toHaveLength(0)

    // Cancelled statement. The set waits for its target row, which another transaction holds.
    warnSpy.mockClear()
    await withRawConnection(async (holder, holderPid) => {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM directory_integrations WHERE id = $1 FOR UPDATE', [b])
      const set = patchPolicy({ canonicalIntegrationId: b, expectedCurrentCanonicalIntegrationId: a }).then((res) => res)
      const waiter = await poll('a backend waiting for the row the holder locked', async () => {
        const r = await query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        )
        return r.rows[0]?.pid
      })
      await query('SELECT pg_cancel_backend($1)', [waiter])
      const res = await set
      expect(res.status).toBe(503)
      expect(errorOf(res)).toEqual(GATE_BUSY)
      expect(refusalLogs().map((entry) => entry.meta)).toEqual([{ code: 'DIRECTORY_ROUTING_GATE_BUSY', sqlState: '57014', actorId: ADMIN }])
    })
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a)
    expect(await auditRows(SET_AUDIT)).toHaveLength(0)
    // The same set goes through once nothing is in its way.
    const retried = await patchPolicy({ canonicalIntegrationId: b, expectedCurrentCanonicalIntegrationId: a })
    expect(retried.status).toBe(200)
    expect(await canonicalOf(DEFAULT_ORG)).toBe(b)
    expect(await auditRows(SET_AUDIT)).toHaveLength(1)
  }, 25000)

  it('G12 every successful transition writes one values-free audit row that names the operator; a refusal writes none and logs one values-free line', async () => {
    process.env[SWITCH] = 'true'
    const corpA = corpOf('g12-x')
    const corpB = corpOf('g12-y')

    const first = await createViaRoute(createBody(corpA))
    expect(first.status).toBe(200)
    const a = first.body.data.integration.id as string
    const refusedCreate = await createViaRoute(createBody(corpB))
    expect(refusedCreate.status).toBe(409)
    const set = await patchPolicy({ canonicalIntegrationId: a })
    expect(set.status).toBe(200)
    const second = await createViaRoute(createBody(corpB))
    expect(second.status).toBe(200)
    const b = second.body.data.integration.id as string
    const refusedClear = await patchPolicy({ canonicalIntegrationId: null })
    expect(refusedClear.status).toBe(409)
    // Pausing is not a transition into the source set: no audit row of this kind.
    expect((await updateViaRoute(b, saveBody(corpB, { status: 'paused' }))).status).toBe(200)
    expect((await updateViaRoute(b, saveBody(corpB, { status: 'active' }))).status).toBe(200)
    expect((await updateViaRoute(b, saveBody(corpB, { status: 'paused' }))).status).toBe(200)
    const cleared = await patchPolicy({ canonicalIntegrationId: null })
    expect(cleared.status).toBe(200)

    const integrationMeta = { orgId: DEFAULT_ORG, provider: 'dingtalk', actorId: ADMIN }
    expect((await auditRows(CREATE_AUDIT)).map((row) => [row.resource_id, row.action_details])).toEqual([[a, integrationMeta], [b, integrationMeta]])
    expect((await auditRows(ACTIVATE_AUDIT)).map((row) => [row.resource_id, row.action_details])).toEqual([[b, integrationMeta]])
    expect((await auditRows(SET_AUDIT)).map((row) => row.action_details)).toEqual([
      { orgId: DEFAULT_ORG, purpose: 'approval_routing', integrationId: a, actorId: ADMIN, previousCanonicalIntegrationId: null },
    ])
    expect((await auditRows(CLEAR_AUDIT)).map((row) => row.action_details)).toEqual([
      { orgId: DEFAULT_ORG, purpose: 'approval_routing', actorId: ADMIN, previousCanonicalIntegrationId: a },
    ])
    // Values-free: no corp id, credential or name in any audit row or log line.
    const everything = JSON.stringify([
      await auditRows(CREATE_AUDIT), await auditRows(ACTIVATE_AUDIT), await auditRows(SET_AUDIT), await auditRows(CLEAR_AUDIT), warned(),
    ])
    for (const value of [corpA, corpB, `key-${corpB}`, `secret-${corpB}`, NAME_PREFIX]) expect(everything).not.toContain(value)
    // Exactly the two refusals were logged, each once.
    expect(refusalLogs().map((entry) => entry.meta)).toEqual([
      { code: 'DIRECTORY_ROUTING_POLICY_REQUIRED', actorId: ADMIN },
      { code: 'ROUTING_POLICY_CLEAR_BLOCKED', actorId: ADMIN },
    ])
  })

  it('G13 a set that carries the expected current canonical is written only if that is still the current one', async () => {
    const corp = corpOf('g13-x')
    const a = await seedIntegration(DEFAULT_ORG, corp)
    const a2 = await seedIntegration(DEFAULT_ORG, corp)

    // Absent: unconditional, as before.
    expect((await patchPolicy({ canonicalIntegrationId: a })).status).toBe(200)
    // Match.
    const matched = await patchPolicy({ canonicalIntegrationId: a2, expectedCurrentCanonicalIntegrationId: a })
    expect(matched.status).toBe(200)
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a2)
    // Mismatch: nothing written, nothing audited.
    const auditsBefore = (await auditRows(SET_AUDIT)).length
    const stale = await patchPolicy({ canonicalIntegrationId: a, expectedCurrentCanonicalIntegrationId: a })
    expect(stale.status).toBe(409)
    expect(errorOf(stale)).toEqual(STATE_CHANGED)
    const expectedNone = await patchPolicy({ canonicalIntegrationId: a, expectedCurrentCanonicalIntegrationId: null })
    expect(expectedNone.status).toBe(409)
    expect(errorOf(expectedNone)).toEqual(STATE_CHANGED)
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a2)
    expect(await auditRows(SET_AUDIT)).toHaveLength(auditsBefore)
    // Null with no policy.
    expect((await patchPolicy({ canonicalIntegrationId: null })).body.data).toEqual({ cleared: true })
    const expectedSomething = await patchPolicy({ canonicalIntegrationId: a, expectedCurrentCanonicalIntegrationId: a2 })
    expect(expectedSomething.status).toBe(409)
    expect(await canonicalOf(DEFAULT_ORG)).toBeNull()
    const fromNone = await patchPolicy({ canonicalIntegrationId: a, expectedCurrentCanonicalIntegrationId: null })
    expect(fromNone.status).toBe(200)
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a)
    expect((await auditRows(SET_AUDIT)).map((row) => row.action_details.previousCanonicalIntegrationId)).toEqual([null, a, null])
  })

  it('G13 two sets that both expect "no policy": the one that inserts second writes nothing', async () => {
    const corp = corpOf('g13c-x')
    const a = await seedIntegration(DEFAULT_ORG, corp)
    const a2 = await seedIntegration(DEFAULT_ORG, corp)

    // The first set has read "no policy row" and is parked before its insert.
    const parked = parkBefore(isPolicyInsert)
    const first = patchPolicy({ canonicalIntegrationId: a, expectedCurrentCanonicalIntegrationId: null }).then((res) => res)
    await parked.reached
    const second = await patchPolicy({ canonicalIntegrationId: a2, expectedCurrentCanonicalIntegrationId: null })
    expect(second.status).toBe(200)
    parked.release()
    const firstRes = await first
    expect(firstRes.status).toBe(409)
    expect(errorOf(firstRes)).toEqual(STATE_CHANGED)
    expect(await canonicalOf(DEFAULT_ORG)).toBe(a2)
    expect((await auditRows(SET_AUDIT)).map((row) => row.action_details.integrationId)).toEqual([a2])
  })

  it('G14 current definition (only active rows are sources): a second row created paused is not a join, and after one of two sources is paused the policy can be cleared although the paused source keeps a linked active account', async () => {
    // If rows that are not active but still carry linked active accounts come to count for the policy
    // rule, only the clear below becomes a refusal; if every pull-type row comes to count for the gate,
    // the paused create becomes a refusal too.
    process.env[SWITCH] = 'true'
    const corpB = corpOf('g14-y')
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g14-x'))

    transactions.length = 0
    const created = await createViaRoute(createBody(corpB, { status: 'paused' }))
    expect(created.status).toBe(200)
    const b = created.body.data.integration.id as string
    expect(await statusOf(b)).toBe('paused')
    expect(gateTransactions()).toHaveLength(0)
    expect(await auditRows(CREATE_AUDIT)).toHaveLength(0)

    // Two active sources under a policy, the second with a linked, active account.
    expect((await patchPolicy({ canonicalIntegrationId: a })).status).toBe(200)
    expect((await updateViaRoute(b, saveBody(corpB, { status: 'active' }))).status).toBe(200)
    const userId = `ars2-user-${STAMP}-${nextTag()}`
    await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [userId, `${userId}@example.test`, userId])
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $2, $3, true, '{}'::jsonb) RETURNING id`,
      [b, `dingtalk:ars2:${STAMP}:${userId}`, userId],
    )
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [account.rows[0].id, userId],
    )
    expect((await patchPolicy({ canonicalIntegrationId: null })).status).toBe(409)

    expect((await updateViaRoute(b, saveBody(corpB, { status: 'paused' }))).status).toBe(200)
    const cleared = await patchPolicy({ canonicalIntegrationId: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.data).toEqual({ cleared: true })
    // One active source, no policy, and a paused source whose linked active account is still there.
    expect(await expectRuleHolds(DEFAULT_ORG)).toEqual({ sourceCount: 1, hasPolicy: false })
    const linked = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM directory_accounts acc
         JOIN directory_account_links l ON l.directory_account_id = acc.id
        WHERE acc.integration_id = $1 AND acc.is_active = true AND l.link_status = 'linked'`,
      [b],
    )
    expect(linked.rows[0].n).toBe(1)
  })

  it('G15 current definition (same provider and corp id is the same source): an active second row with the same corp id and a different app key is created without a policy', async () => {
    // If the same-source rule comes to require more than the two columns, this becomes a refusal.
    process.env[SWITCH] = 'true'
    const corp = corpOf('g15-x')
    await seedIntegration(DEFAULT_ORG, corp, { config: { appKey: 'key-one', appSecret: 'seeded-secret' } })
    const created = await createViaRoute(createBody(corp, { appKey: 'key-two' }))
    expect(created.status).toBe(200)
    expect(created.body.data.integration.config.appKey).toBe('key-two')
    expect(created.body.data.integration.config.identityStatus).toBe('unverified')
    expect((await ourRows(DEFAULT_ORG)).map((row) => row.status)).toEqual(['active', 'active'])
    expect(await countActivePullSources(query, DEFAULT_ORG)).toBe(1)
  })

  it('G16 a source count that cannot be read is a retryable 503 at each of the three entries, with nothing written and no lock left behind', async () => {
    process.env[SWITCH] = 'true'
    const corpB = corpOf('g16-y')
    const a = await seedIntegration(DEFAULT_ORG, corpOf('g16-x'))
    const b = await seedIntegration(DEFAULT_ORG, corpB, { status: 'paused' })
    const emptyRowSet = async (): Promise<Rows> => ({ rows: [] })
    const unchanged = async (canonical: string | null) => {
      expect((await ourRows(DEFAULT_ORG)).map((row) => row.status)).toEqual(['active', 'paused'])
      expect(await canonicalOf(DEFAULT_ORG)).toBe(canonical)
      expect(await advisoryLocks(DEFAULT_ORG)).toEqual({ granted: [], waiting: [] })
      const open = await query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`)
      expect(open.rows[0].n).toBe(0)
    }

    // Create: the count of the other sources.
    const otherCount = addHook('before', (sql) => sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, emptyRowSet, false)
    const create = await createViaRoute(createBody(corpOf('g16-z')))
    expect(create.status).toBe(503)
    expect(errorOf(create)).toEqual(GATE_UNAVAILABLE)
    await unchanged(null)
    // Activation: the same count.
    const activate = await updateViaRoute(b, saveBody(corpB, { status: 'active' }))
    expect(activate.status).toBe(503)
    expect(errorOf(activate)).toEqual(GATE_UNAVAILABLE)
    await unchanged(null)
    expect(otherCount.fired).toBe(2)
    // Clear: the count of all active sources.
    await seedPolicy(DEFAULT_ORG, a)
    const allCount = addHook('before', (sql) => sql === COUNT_ACTIVE_PULL_SOURCES_SQL, emptyRowSet, false)
    const clear = await patchPolicy({ canonicalIntegrationId: null })
    expect(clear.status).toBe(503)
    expect(errorOf(clear)).toEqual(GATE_UNAVAILABLE)
    await unchanged(a)
    expect(allCount.fired).toBe(1)

    expect(await auditRows(CREATE_AUDIT)).toHaveLength(0)
    expect(await auditRows(ACTIVATE_AUDIT)).toHaveLength(0)
    expect(await auditRows(CLEAR_AUDIT)).toHaveLength(0)
    expect(refusalLogs().map((entry) => entry.meta)).toEqual([
      { code: 'DIRECTORY_ROUTING_GATE_UNAVAILABLE', actorId: ADMIN },
      { code: 'DIRECTORY_ROUTING_GATE_UNAVAILABLE', actorId: ADMIN, integrationId: b },
      { code: 'DIRECTORY_ROUTING_GATE_UNAVAILABLE', actorId: ADMIN },
    ])
    // Control: with the counts readable the same create is refused by the rule, not by the read.
    hooks.length = 0
    await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [DEFAULT_ORG])
    const refused = await createViaRoute(createBody(corpOf('g16-z')))
    expect(refused.status).toBe(409)
    expect(errorOf(refused)).toEqual(POLICY_REQUIRED)
  })

  it('a gate failure is typed, not read from text: the busy error carries its SQLSTATE only in a typed property', async () => {
    const org = newOrg('typed')
    await withRawConnection(async (holder) => {
      await holder.query('BEGIN')
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [directoryOrgLockKey(org)])
      const attempt = runGatedPullSourceWrite({ orgId: org, provider: 'dingtalk', corpId: corpOf('typed'), enforce: 'always' }, async () => 'never')
      const waiter = await waiterOnOrgLock(org)
      await query('SELECT pg_cancel_backend($1)', [waiter])
      const failure = await attempt.then(() => null, (error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryRoutingGateBusyError)
      expect((failure as DirectoryRoutingGateBusyError).sqlState).toBe('57014')
      expect((failure as Error).message).not.toContain(org)
    })
  })
})
