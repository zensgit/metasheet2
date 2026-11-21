/**
 * The administrator PATCH of directory integration capabilities against real PostgreSQL, through the
 * HTTP route and the real write service:
 *   #1  the integration row is never written; legacy capabilities and notification without evidence cannot be turned on;
 *   #2  the revision check under two connections, on a read-committed-default and on a
 *       repeatable-read-default pool, on the update path and on the insert path;
 *   #3  login scope uniqueness on the insert and update paths, case folding, and release on disable;
 *   #4  anchors are per capability: a stale login is not re-confirmed by another capability's change;
 *       turning a capability off reads no scope when no anchor is left on the row;
 *   #5  a generic save of the integration row cannot slip between the PATCH's read and its write;
 *   #6  an integration that is not active, and one made active again by a generic save without a status;
 *   #7  a controlled handover previewed before a PATCH still applies after it;
 *   #8  the history row is written in the same transaction as the capability row;
 *   #9  the busy answer, and the isolation level and time bounds the PATCH sets for itself;
 *   #10 scope shape;
 *   #11 enable preconditions;
 *   #13 enable gates.
 *
 * DATABASE_URL-gated, with the EXPECT_DB sentinel. The suite runs against a disposable database whose
 * schema the lane has already brought up to date: it owns no schema change of its own except one
 * temporary trigger in #8, which it removes again.
 *
 * Every capability row and every history row asserted here was written by the PATCH under test; the
 * suite itself only reads those two tables, and removes the rows of the integrations it inserted. The
 * consumer resolver reads the rows the PATCH wrote. A test-only mock of the provider registry and of
 * the implementation table enables all three capabilities for the write-protocol cases (as the resolver
 * suite does); the registry case in #1 turns that mock off and goes through the production router.
 * Production notification is gated; its evidence success cases are in notification-capability-production.db.test.ts.
 *
 * The generic save in #5 and #6 is the application's own: `updateDirectoryIntegration`, the function
 * the administrator PUT handler calls, on the application's pool, with a complete synthetic payload. It
 * makes no external call. Where a case must keep the writing transaction open itself (the reverse lock
 * order in #5) or only needs another application key on the row, it uses one explicit statement, named
 * a controlled row writer here and not presented as the save.
 *
 * No wait in this suite is unbounded: a gate that a request was to reach is abandoned when the request
 * settles first or a bound runs out, and every request a case started is drained before the case ends.
 *
 * Synthetic data only: fresh integration ids and organizations, a per-run scope suffix. History rows
 * cannot be deleted one by one; when every row of the history table belongs to an integration this
 * suite inserted, the table is emptied at the end, and otherwise it is left as it is.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type {
  CapabilityTransactionClient,
  EnablePreconditionContext,
  EnablePreconditionResult,
  IntegrationCapability,
} from '../../src/integrations/provider-capability-registry'

type PreconditionHook = (capability: IntegrationCapability, context: EnablePreconditionContext) => Promise<EnablePreconditionResult>

const control = vi.hoisted(() => ({
  /** False: the real production registry and implementation table. */
  testRegistry: true,
  /** False: the test registry has no entry for the provider. */
  registered: true,
  governance: { directory: 'gated', login: 'gated', notification: 'gated' } as Record<string, 'gated' | 'legacy' | 'unsupported'>,
  implemented: true,
  /** True: the scope is passed on as stored, without the shape check. */
  laxScope: false,
  precondition: null as PreconditionHook | null,
  /** Called at every scope read of the test registry, before the scope is computed; it may throw. */
  onScopeRead: null as (() => void) | null,
}))
const audit = vi.hoisted(() => ({ events: [] as Array<{ action: string; resourceId: string; meta: Record<string, unknown> }> }))

vi.mock('../../src/integrations/provider-capability-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/provider-capability-registry')>()
  return {
    ...actual,
    resolveProviderCapabilityDescriptor: (provider: string) => {
      if (!control.testRegistry) return actual.resolveProviderCapabilityDescriptor(provider)
      if (provider !== 'dingtalk' || !control.registered) return null
      const production = actual.resolveProviderCapabilityDescriptor('dingtalk')
      if (production === null) throw new Error('production dingtalk descriptor missing')
      return {
        provider: 'dingtalk',
        governance: { ...control.governance },
        scopeOf: (row: { corp_id: string; config: unknown }) => {
          control.onScopeRead?.()
          return control.laxScope
            ? { tenant: row.corp_id, appScope: String((row.config as { appKey?: unknown } | null)?.appKey ?? '') }
            : production.scopeOf(row)
        },
        enablePreconditions: async (capability: IntegrationCapability, context: EnablePreconditionContext) =>
          control.precondition ? control.precondition(capability, context) : { ok: true as const },
        secretConfigKeys: production.secretConfigKeys,
      }
    },
  }
})

vi.mock('../../src/integrations/integration-capability-implementations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/integration-capability-implementations')>()
  return {
    ...actual,
    isCapabilityImplementationAvailable: (provider: string, capability: 'directory' | 'login' | 'notification') =>
      control.testRegistry ? provider === 'dingtalk' && control.implemented : actual.isCapabilityImplementationAvailable(provider, capability),
  }
})

// The production router records refusals through the audit module; they are captured here instead of
// being stored.
vi.mock('../../src/audit/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/audit/audit')>()),
  auditLog: async (event: { action: string; resourceId: string; meta: Record<string, unknown> }) => {
    audit.events.push(event)
  },
}))

import { applyDirectoryHandover, previewDirectoryHandover } from '../../src/directory/controlled-handover'
import { updateDirectoryIntegration, type DirectoryIntegrationInput } from '../../src/directory/directory-sync'
import { createDirectoryIntegrationCapabilitiesService } from '../../src/integrations/directory-integration-capabilities-service'
import {
  PRODUCTION_CAPABILITY_ENABLE_GATES,
  createDirectoryIntegrationCapabilitiesWriteService,
  type CapabilityEnableGates,
} from '../../src/integrations/directory-integration-capabilities-write-service'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import { resolveEffectiveIntegrationCapability, type CapabilityDecision } from '../../src/integrations/integration-capability-resolve'
import { resolveProviderCapabilityDescriptor } from '../../src/integrations/provider-capability-registry'
import { adminDirectoryCapabilitiesRouter, createAdminDirectoryCapabilitiesRouter } from '../../src/routes/admin-directory-capabilities'
import { usePinnedServer } from '../utils/pinned-server'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

// Module top level: it must run (and fail) when the gated describe below is skipped for want of a database.
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const SWITCH = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'
const BASE = '/api/admin/directory/integration-capabilities'
const INTEGRATIONS = 'directory_integrations'
const CAPS = 'directory_integration_capabilities'
const HISTORY = 'directory_integration_capability_history'
const ACTOR = 'cap-patch-admin'
type Capability = 'directory' | 'login' | 'notification'
type Row = Record<string, unknown>

// A per-run scope, so the login uniqueness index never meets a row of another suite or another run.
const RUN = randomUUID().slice(0, 8)
const CORP = `CorpPatch-${RUN}`
const APP = `AppOne-${RUN}`
const APP_TWO = `AppTwo-${RUN}`
const APP_THREE = `AppThree-${RUN}`
const HISTORY_GUARD = `cap_patch_refuse_history_${RUN}`

interface PgError extends Error {
  code?: string
  constraint?: string
}

interface Trace {
  /** Statements the write service issued, in order, across the requests served by this app. */
  statements: string[]
  /** SQLSTATE and constraint of every statement the database refused. */
  errors: Array<{ code?: string; constraint?: string }>
  /** Backend process id of each write transaction, in the order the requests arrived. */
  pids: number[]
  audits: Array<{ action: string; resourceId: string; meta: Row }>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const body = (expectedRevision: number, capabilities: Partial<Record<Capability, boolean>>) => ({ expectedRevision, capabilities })
const refused = (reason: string) => ({ effective: false, reason })

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface Tracked<T> {
  promise: Promise<T>
  settled: () => boolean
}

function tracked<T>(promise: Promise<T>): Tracked<T> {
  let done = false
  const wrapped = promise.finally(() => {
    done = true
  })
  wrapped.catch(() => undefined)
  return { promise: wrapped, settled: () => done }
}

/** `promise`, or a failure once `timeoutMs` have passed. */
async function within<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Waits until `gate` opens, for at most `timeoutMs`, and gives up at once when one of `requests` (the
 * requests that were to reach the gate) settles first. A request that answered before the gate, or a
 * database promise that rejected, fails the case here instead of leaving it waiting for a gate that
 * nothing will reach any more.
 */
async function enterGate(gate: Promise<void>, label: string, requests: Array<Tracked<unknown>>, timeoutMs = 8_000): Promise<void> {
  const entered = 'entered'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race<string>([
      gate.then(() => entered),
      ...requests.map((request) => request.promise.then(
        (value) => {
          const status = (value as { status?: unknown } | null | undefined)?.status
          return typeof status === 'number' ? `a request answered ${status} first` : 'a request settled first'
        },
        (error: unknown) => `a request failed first (${String((error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.name : 'error'))})`,
      )),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`not within ${timeoutMs} ms`), timeoutMs)
      }),
    ])
    if (outcome !== entered) throw new Error(`${label} was not reached: ${outcome}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * For a finally block: waits, within a bound and without failing, until every request the case started
 * has settled, so that none of them is still running, and holding a connection, when the case ends.
 */
async function drain(...requests: Array<Tracked<unknown> | undefined>): Promise<void> {
  await Promise.all(requests.map(async (request) => {
    if (request !== undefined) await within(request.promise, 'a started request', 10_000).catch(() => undefined)
  }))
}

describeIfDatabase('directory integration capability PATCH (real database)', () => {
  const pinned = usePinnedServer()
  let pool: Pool
  let rrPool: Pool
  const integrationIds: string[] = []
  const everyIntegrationId: string[] = []
  const userIds: string[] = []

  const run = (text: string, values?: unknown[]) => pool.query(text, values)

  async function missingTables(): Promise<string[]> {
    const result = await run(
      `SELECT to_regclass('${INTEGRATIONS}') IS NOT NULL AS integrations,
              to_regclass('${CAPS}') IS NOT NULL AS capabilities,
              to_regclass('${HISTORY}') IS NOT NULL AS history`,
    )
    const row = result.rows[0]
    return [
      row.integrations === true ? null : INTEGRATIONS,
      row.capabilities === true ? null : CAPS,
      row.history === true ? null : HISTORY,
    ].filter((name): name is string => name !== null)
  }

  async function insertIntegration(overrides: { id?: string; provider?: string; orgId?: string; corp?: string; config?: unknown; status?: string } = {}): Promise<{ id: string; org: string }> {
    const org = overrides.orgId ?? `cap-patch-${randomUUID()}`
    const result = await run(
      `INSERT INTO ${INTEGRATIONS} (id, org_id, provider, name, status, corp_id, config)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id::text AS id`,
      [overrides.id ?? randomUUID(), org, overrides.provider ?? 'dingtalk', `cap-patch-${randomUUID()}`, overrides.status ?? 'active', overrides.corp ?? CORP, JSON.stringify(overrides.config ?? { appKey: APP })],
    )
    const id = result.rows[0].id as string
    integrationIds.push(id)
    everyIntegrationId.push(id)
    return { id, org }
  }

  /** The capability row as stored, or null. Read only: the suite never writes this table. */
  async function stateOf(integrationId: string): Promise<Row | null> {
    const result = await run(
      `SELECT bound_provider, bound_org_id,
              directory_enabled, directory_bound_tenant, directory_bound_app_scope,
              login_enabled, login_bound_tenant, login_bound_app_scope,
              notification_enabled, notification_bound_tenant, notification_bound_app_scope,
              revision::text AS revision, created_by, updated_by
         FROM ${CAPS} WHERE integration_id = $1::uuid`,
      [integrationId],
    )
    return (result.rows[0] as Row | undefined) ?? null
  }

  async function historyOf(integrationId: string): Promise<Row[]> {
    const result = await run(
      `SELECT bound_provider, revision::text AS revision, actor_id, changed, anchor_rebound,
              directory_enabled, login_enabled, notification_enabled
         FROM ${HISTORY} WHERE integration_id = $1::uuid ORDER BY id`,
      [integrationId],
    )
    return result.rows as Row[]
  }

  /** Every column of the integration row and its row version: a write of the row changes at least one. */
  async function imageOf(integrationId: string): Promise<{ image: string; xmin: string }> {
    const result = await run(`SELECT to_jsonb(i)::text AS image, i.xmin::text AS xmin FROM ${INTEGRATIONS} i WHERE i.id = $1::uuid`, [integrationId])
    return result.rows[0] as { image: string; xmin: string }
  }

  async function tableCounts(): Promise<{ capabilities: number; history: number }> {
    const result = await run(`SELECT (SELECT count(*)::int FROM ${CAPS}) AS capabilities, (SELECT count(*)::int FROM ${HISTORY}) AS history`)
    return result.rows[0] as { capabilities: number; history: number }
  }

  // A controlled row writer, not the application's save: one statement that puts another application
  // key on the integration row. It is used where a case only needs the row to carry another key, and
  // where the case itself must keep the writing transaction open.
  const CONTROLLED_APP_KEY_WRITE_SQL = `UPDATE ${INTEGRATIONS} SET config = jsonb_set(config, '{appKey}', to_jsonb($2::text)), updated_at = now() WHERE id = $1::uuid`
  const setAppKey = (integrationId: string, appKey: string) => run(CONTROLLED_APP_KEY_WRITE_SQL, [integrationId, appKey])

  /**
   * The payload of a complete generic save of a fixture integration: the corp id the fixture already
   * has (a generic save cannot change it), a new synthetic name, an application key and a synthetic
   * secret. It has a `status` property only when one is asked for.
   */
  function genericSave(overrides: { appKey?: string; status?: string } = {}): DirectoryIntegrationInput {
    const payload: DirectoryIntegrationInput = {
      name: `cap-patch-saved-${randomUUID()}`,
      corpId: CORP,
      appKey: overrides.appKey ?? APP,
      appSecret: `cap-patch-synthetic-secret-${RUN}`,
    }
    if (overrides.status !== undefined) payload.status = overrides.status
    return payload
  }

  /**
   * What a generic save leaves on the integration row. `rebuilt` and `secret_sealed` are true only after
   * the application's save: it writes the whole configuration object and stores the secret sealed.
   */
  async function integrationOf(integrationId: string): Promise<{ name: string; status: string; corp_id: string; app_key: string | null; rebuilt: boolean; secret_sealed: boolean; xmin: string }> {
    const result = await run(
      `SELECT i.name, i.status, i.corp_id, i.config->>'appKey' AS app_key,
              i.config ? 'rootDepartmentId' AS rebuilt,
              COALESCE(i.config->>'appSecret' LIKE 'enc:%', false) AS secret_sealed,
              i.xmin::text AS xmin
         FROM ${INTEGRATIONS} i WHERE i.id = $1::uuid`,
      [integrationId],
    )
    return result.rows[0] as { name: string; status: string; corp_id: string; app_key: string | null; rebuilt: boolean; secret_sealed: boolean; xmin: string }
  }

  /** The write service's transaction runner on `source`: a bare BEGIN, as the application's own runner issues. */
  function runnerOn(source: Pool, trace: Trace) {
    return async <T>(work: (client: CapabilityTransactionClient) => Promise<T>): Promise<T> => {
      const client = await source.connect()
      try {
        trace.pids.push(Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid))
        await client.query('BEGIN')
        const traced: CapabilityTransactionClient = {
          query: async (text: string, values?: unknown[]) => {
            trace.statements.push(text)
            try {
              return (await client.query(text, values)) as never
            } catch (error) {
              trace.errors.push({ code: (error as PgError).code, constraint: (error as PgError).constraint })
              throw error
            }
          },
        }
        const result = await work(traced)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
  }

  function appOf(router: express.Router): express.Express {
    const app = express()
    app.use(express.json())
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: ACTOR, role: 'admin' } as never
      next()
    })
    app.use(BASE, router)
    return app
  }

  /** Serves the route with the real read and write services on `source`, and returns what the write did. */
  function useApp(options: { source?: Pool; gates?: CapabilityEnableGates } = {}): Trace {
    const source = options.source ?? pool
    const trace: Trace = { statements: [], errors: [], pids: [], audits: [] }
    const view = {
      resolveDescriptor: (provider: string) => resolveProviderCapabilityDescriptor(provider),
      isImplementationAvailable: (provider: string, capability: Capability) => isCapabilityImplementationAvailable(provider, capability),
      readLoginRuntime: () => ({ available: false, requireGrant: false, autoLinkEmail: false, autoProvision: false }),
      isIntegrationScopedCredentialsEnabled: () => false,
    }
    const service = createDirectoryIntegrationCapabilitiesService({
      executor: { query: (text: string, values?: unknown[]) => source.query(text, values) as never },
      isEnabled: () => true,
      ...view,
    })
    const writer = createDirectoryIntegrationCapabilitiesWriteService({
      isEnabled: () => true,
      ...view,
      transaction: runnerOn(source, trace),
      capabilityGates: options.gates ?? PRODUCTION_CAPABILITY_ENABLE_GATES,
      audit: async (event) => {
        trace.audits.push(event)
      },
    })
    pinned.setApp(appOf(createAdminDirectoryCapabilitiesRouter({ service, writer })))
    return trace
  }

  async function patch(integrationId: string, payload: unknown): Promise<request.Response> {
    return await request(pinned.url()).patch(`${BASE}/${integrationId}`).send(payload as object)
  }

  async function get(integrationId: string): Promise<request.Response> {
    return await request(pinned.url()).get(`${BASE}/${integrationId}`)
  }

  /** The consumer resolver in a fresh read-committed consumer transaction, over whatever the PATCH stored. */
  async function resolveFresh(integrationId: string, expectedOrgId: string, capability: Capability): Promise<CapabilityDecision> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await client.query("SET LOCAL lock_timeout = '2s'")
      return await resolveEffectiveIntegrationCapability(
        { query: (text: string, values?: unknown[]) => client.query(text, values) as never },
        { integrationId, capability, expectedOrgId },
      )
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  }

  /**
   * Barrier: returns once backend `pid` is waiting on a heavyweight lock; throws after `timeoutMs`, or as
   * soon as `request` (the request that backend serves) has settled without having waited.
   */
  async function waitUntilLockWait(pid: number, request?: Tracked<unknown>, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await run('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])
      if (result.rows[0]?.wait_event_type === 'Lock') return
      if (request?.settled()) throw new Error(`the request settled before backend ${pid} waited on a lock`)
      await sleep(25)
    }
    throw new Error(`backend ${pid} never waited on a lock`)
  }

  /**
   * Barrier: the backends of this database that wait on a lock held by backend `holderPid`, read from
   * pg_blocking_pids, once there is at least one. Throws after `timeoutMs`, or as soon as `operation`
   * (the operation that was to wait) has settled instead. Used for a connection whose backend the case
   * does not know in advance: one the application's own pool handed out.
   */
  async function waitUntilBlockedBy(holderPid: number, operation: Tracked<unknown>, timeoutMs = 4_000): Promise<Array<{ pid: number; statement: string }>> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await run(
        `SELECT a.pid, a.query AS statement
           FROM pg_stat_activity a
          WHERE a.datname = current_database()
            AND a.pid <> pg_backend_pid()
            AND a.wait_event_type = 'Lock'
            AND $1::int = ANY(pg_blocking_pids(a.pid))
          ORDER BY a.pid`,
        [holderPid],
      )
      if (result.rows.length > 0) return result.rows.map((row) => ({ pid: Number(row.pid), statement: String(row.statement) }))
      if (operation.settled()) throw new Error(`the operation settled without waiting on backend ${holderPid}`)
      await sleep(25)
    }
    throw new Error(`no backend waited on backend ${holderPid}`)
  }

  /** The backend of the write transaction that starts after `count` earlier ones. */
  async function pidAfter(trace: Trace, count: number, timeoutMs = 4_000): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (trace.pids.length > count) return trace.pids[count]
      await sleep(10)
    }
    throw new Error('the write transaction never started')
  }

  /** One lock attempt that does not wait: 'acquired', or the SQLSTATE it was refused with. */
  async function lockAttempt(text: string, integrationId: string): Promise<string> {
    try {
      await run(text, [integrationId])
      return 'acquired'
    } catch (error) {
      return String((error as PgError).code)
    }
  }

  /** Holds every insert into the history table back until the returned function is called. */
  async function holdHistoryInserts(): Promise<() => Promise<void>> {
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      // Bounded, and the connection goes back to the pool when the lock cannot be taken.
      await holder.query("SET LOCAL lock_timeout = '5s'")
      await holder.query(`LOCK TABLE ${HISTORY} IN EXCLUSIVE MODE`)
    } catch (error) {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
      throw error
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
    }
  }

  async function dropHistoryGuard(): Promise<void> {
    await run(`DROP TRIGGER IF EXISTS ${HISTORY_GUARD} ON ${HISTORY}`)
    await run(`DROP FUNCTION IF EXISTS ${HISTORY_GUARD}()`)
  }

  /** Removes exactly the rows of the integrations this suite inserted. History rows stay until the end. */
  async function cleanup(): Promise<void> {
    const ids = [...integrationIds]
    integrationIds.length = 0
    const users = [...userIds]
    userIds.length = 0
    if (ids.length > 0) {
      await run(`DELETE FROM ${CAPS} WHERE integration_id = ANY($1::uuid[])`, [ids])
      await run('DELETE FROM directory_handovers WHERE source_integration_id = ANY($1::uuid[]) OR target_integration_id = ANY($1::uuid[])', [ids])
      await run('DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])', [ids])
      await run(`DELETE FROM ${INTEGRATIONS} WHERE id = ANY($1::uuid[])`, [ids])
    }
    if (users.length > 0) await run('DELETE FROM users WHERE id = ANY($1::text[])', [users])
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl, max: 10 })
    const base = dbUrl as string
    rrPool = new Pool({
      connectionString: `${base}${base.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c default_transaction_isolation=repeatable\\ read')}`,
      max: 4,
    })
    const missing = await missingTables()
    if (missing.length > 0) {
      throw new Error(`the disposable test database must already carry the schema; missing: ${missing.join(', ')}.`)
    }
  })

  beforeEach(() => {
    vi.stubEnv(SWITCH, 'true')
    control.testRegistry = true
    control.registered = true
    control.governance = { directory: 'gated', login: 'gated', notification: 'gated' }
    control.implemented = true
    control.laxScope = false
    control.precondition = null
    control.onScopeRead = null
    audit.events.length = 0
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    control.precondition = null
    control.onScopeRead = null
    await cleanup()
  })

  afterAll(async () => {
    try {
      await cleanup()
      await dropHistoryGuard()
      const foreign = await run(`SELECT count(*)::int AS n FROM ${HISTORY} WHERE NOT (integration_id = ANY($1::uuid[]))`, [everyIntegrationId])
      if (foreign.rows[0].n === 0) await run(`TRUNCATE ${HISTORY}`)
    } finally {
      await pool.end()
      await rrPool.end()
    }
  })

  describe('#1 the integration row and the production registry', () => {
    it('never writes the integration row: every column and the row version are the same after enable, re-anchor and disable', async () => {
      const { id, org } = await insertIntegration()
      useApp()
      const before = await imageOf(id)

      const enabled = await patch(id, body(0, { login: true, notification: true }))
      expect(enabled.status).toBe(200)
      expect(enabled.body.data).toMatchObject({ integrationId: id, provider: 'dingtalk', revision: 1 })
      expect(await imageOf(id)).toEqual(before)
      expect(enabled.body.data).toEqual((await get(id)).body.data)
      expect((await resolveFresh(id, org, 'login')).effective).toBe(true)
      expect((await resolveFresh(id, org, 'notification')).effective).toBe(true)
      expect(await resolveFresh(id, org, 'directory')).toEqual(refused('not_enabled'))

      await setAppKey(id, APP_TWO)
      const moved = await imageOf(id)
      const reanchored = await patch(id, body(1, { login: true }))
      expect(reanchored.status).toBe(200)
      expect(reanchored.body.data.revision).toBe(2)
      expect(await imageOf(id)).toEqual(moved)

      const disabled = await patch(id, body(2, { login: false, notification: false }))
      expect(disabled.status).toBe(200)
      expect(disabled.body.data.revision).toBe(3)
      expect(await imageOf(id)).toEqual(moved)
      expect(disabled.body.data).toEqual((await get(id)).body.data)

      const text = JSON.stringify([enabled.body, reanchored.body, disabled.body])
      for (const value of [CORP, APP, APP_TWO]) expect(text).not.toContain(value)
    })

    it('stores what it answered: the row, the administrator and one history row per change', async () => {
      const { id, org } = await insertIntegration()
      const trace = useApp()
      expect((await patch(id, body(0, { login: true }))).status).toBe(200)
      expect(await stateOf(id)).toEqual({
        bound_provider: 'dingtalk', bound_org_id: org,
        directory_enabled: false, directory_bound_tenant: null, directory_bound_app_scope: null,
        login_enabled: true, login_bound_tenant: CORP, login_bound_app_scope: APP,
        notification_enabled: false, notification_bound_tenant: null, notification_bound_app_scope: null,
        revision: '1', created_by: ACTOR, updated_by: ACTOR,
      })
      expect(await historyOf(id)).toEqual([{
        bound_provider: 'dingtalk', revision: '1', actor_id: ACTOR, changed: ['login'], anchor_rebound: [],
        directory_enabled: false, login_enabled: true, notification_enabled: false,
      }])
      expect(trace.audits).toEqual([{
        actorId: ACTOR, actorType: 'user', action: 'directory.integration.capabilities.update',
        resourceType: 'directory-integration-capabilities', resourceId: id,
        meta: {
          provider: 'dingtalk', actorId: ACTOR, fromRevision: 0, toRevision: 1, changed: ['login'], anchorRebound: [],
          directoryEnabled: false, loginEnabled: true, notificationEnabled: false,
        },
      }])
      const stored = await run(`SELECT to_jsonb(h)::text AS image FROM ${HISTORY} h WHERE integration_id = $1::uuid`, [id])
      for (const value of [CORP, APP, org]) expect(String(stored.rows[0].image)).not.toContain(value)
    })

    it('through the production router: legacy and unverified notification enables are refused; disabling keeps both tables unchanged', async () => {
      control.testRegistry = false
      vi.stubEnv('USER_NOTIFICATION_PREFERENCES_ENABLED', 'false')
      const dingtalk = await insertIntegration()
      const wecom = await insertIntegration({ provider: 'wecom' })
      pinned.setApp(appOf(adminDirectoryCapabilitiesRouter()))
      const counts = await tableCounts()
      const images = await Promise.all([dingtalk, wecom].map(({ id }) => imageOf(id)))

      const cases: Array<[string, string]> = [
        [dingtalk.id, 'CAPABILITY_GOVERNED_BY_LEGACY_PATH'],
        [wecom.id, 'CAPABILITY_PROVIDER_NOT_REGISTERED'],
      ]
      for (const [id, code] of cases) {
        for (const capability of ['directory', 'login', 'notification'] as const) {
          const response = await patch(id, body(0, { [capability]: true }))
          expect(response.status).toBe(409)
          if (id === dingtalk.id && capability === 'notification') {
            expect(response.body.error).toMatchObject({
              code: 'CAPABILITY_PRECONDITION_FAILED', details: { capability, reason: 'verification_missing' },
            })
          } else {
            expect(response.body.error).toMatchObject({ code, details: { capability } })
          }
        }
        const all = await patch(id, body(0, { directory: true, login: true, notification: true }))
        expect(all.status).toBe(409)
        expect(all.body.error).toMatchObject({ code, details: { capability: 'directory' } })
        const off = await patch(id, body(0, { directory: false, login: false, notification: false }))
        expect(off.status).toBe(200)
        expect(off.body.data).toMatchObject({ revision: 0, updatedAt: null })
        expect(await stateOf(id)).toBeNull()
        expect(await historyOf(id)).toEqual([])
      }
      expect(await tableCounts()).toEqual(counts)
      expect(await Promise.all([dingtalk, wecom].map(({ id }) => imageOf(id)))).toEqual(images)
      // Four refusals per integration: one per capability, and one for the three together.
      expect(audit.events).toHaveLength(8)
      expect(new Set(audit.events.map((event) => event.action))).toEqual(new Set(['directory.integration.capabilities.refused']))
      expect(audit.events[0]).toMatchObject({
        resourceId: dingtalk.id,
        meta: { provider: 'dingtalk', actorId: ACTOR, code: 'CAPABILITY_GOVERNED_BY_LEGACY_PATH', capability: 'directory' },
      })
      expect(audit.events[2]).toMatchObject({
        resourceId: dingtalk.id,
        meta: { provider: 'dingtalk', actorId: ACTOR, code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'notification' },
      })
      expect(await resolveFresh(dingtalk.id, dingtalk.org, 'login')).toEqual(refused('governed_by_legacy_path'))
    })

    it('answers the production router with 404 while the switch is off, and reads nothing', async () => {
      vi.stubEnv(SWITCH, 'false')
      const { id } = await insertIntegration()
      pinned.setApp(appOf(adminDirectoryCapabilitiesRouter()))
      const response = await patch(id, body(0, { login: false }))
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('DIRECTORY_CAPABILITIES_DISABLED')
      expect(await stateOf(id)).toBeNull()
    })
  })

  describe.each([
    ['a read-committed-default pool', () => pool],
    ['a repeatable-read-default pool', () => rrPool],
  ] as const)('#2 the revision check under two connections, on %s', (_label, sourceOf) => {
    it('holds a second PATCH with the same expected revision at the capability row until the first commits, then answers it 409 STALE', async () => {
      const { id } = await insertIntegration()
      const trace = useApp({ source: sourceOf() })
      expect((await patch(id, body(0, { notification: true }))).status).toBe(200)

      const reached = deferred()
      const release = deferred()
      control.precondition = async (capability) => {
        if (capability === 'login') {
          reached.resolve()
          await release.promise
        }
        return { ok: true }
      }
      let first: Tracked<request.Response> | undefined
      let second: Tracked<request.Response> | undefined
      try {
        first = tracked(patch(id, body(1, { login: true })))
        await enterGate(reached.promise, 'the precondition of the first PATCH', [first])
        const started = trace.pids.length
        second = tracked(patch(id, body(1, { directory: true })))
        await waitUntilLockWait(await pidAfter(trace, started), second)
        expect(first.settled()).toBe(false)
        expect(second.settled()).toBe(false)
        expect(await stateOf(id)).toMatchObject({ revision: '1', login_enabled: false, directory_enabled: false })

        release.resolve()
        const [winner, loser] = await within(Promise.all([first.promise, second.promise]), 'the two PATCH requests')
        expect(winner.status).toBe(200)
        expect(winner.body.data.revision).toBe(2)
        expect(loser.status).toBe(409)
        expect(loser.body.error).toEqual({ code: 'DIRECTORY_CAPABILITIES_STALE', message: 'The capability state has changed; reload before applying' })
      } finally {
        release.resolve()
        await drain(first, second)
      }
      expect(await stateOf(id)).toMatchObject({ revision: '2', login_enabled: true, directory_enabled: false, notification_enabled: true })
      expect((await historyOf(id)).map((row) => [row.revision, row.changed])).toEqual([['1', ['notification']], ['2', ['login']]])
      // The loser, repeated with the revision it can now read, succeeds.
      expect((await patch(id, body(2, { directory: true }))).status).toBe(200)
    })

    it('holds a second first-time PATCH at the insert until the first commits, then answers it 409 STALE and not a scope refusal', async () => {
      const { id } = await insertIntegration()
      const trace = useApp({ source: sourceOf() })
      const releaseHistory = await holdHistoryInserts()
      let first: Tracked<request.Response> | undefined
      let second: Tracked<request.Response> | undefined
      try {
        // The first has inserted its capability row and waits to write its history row.
        first = tracked(patch(id, body(0, { login: true })))
        await waitUntilLockWait(await pidAfter(trace, 0), first)
        second = tracked(patch(id, body(0, { notification: true })))
        await waitUntilLockWait(await pidAfter(trace, 1), second)
        expect(first.settled()).toBe(false)
        expect(second.settled()).toBe(false)
        expect(await stateOf(id)).toBeNull()

        await releaseHistory()
        const [winner, loser] = await within(Promise.all([first.promise, second.promise]), 'the two PATCH requests')
        expect(winner.status).toBe(200)
        expect(winner.body.data.revision).toBe(1)
        expect(loser.status).toBe(409)
        expect(loser.body.error.code).toBe('DIRECTORY_CAPABILITIES_STALE')
      } finally {
        await releaseHistory()
        await drain(first, second)
      }
      expect(await stateOf(id)).toMatchObject({ revision: '1', login_enabled: true, notification_enabled: false })
      expect(await historyOf(id)).toHaveLength(1)
      expect(trace.errors).toEqual([])
    })

    it('answers a request that changes nothing with 200 after the revision check, and a wrong revision with 409 even when it would change nothing', async () => {
      const { id } = await insertIntegration()
      useApp({ source: sourceOf() })
      expect((await patch(id, body(0, { login: true }))).status).toBe(200)
      const same = await patch(id, body(1, { login: true, directory: false }))
      expect(same.status).toBe(200)
      expect(same.body.data.revision).toBe(1)
      for (const expectedRevision of [0, 2]) {
        const stale = await patch(id, body(expectedRevision, { login: true }))
        expect(stale.status).toBe(409)
        expect(stale.body.error.code).toBe('DIRECTORY_CAPABILITIES_STALE')
      }
      expect(await historyOf(id)).toHaveLength(1)
      const rowless = await insertIntegration()
      expect((await patch(rowless.id, body(1, { login: false }))).status).toBe(409)
      expect((await patch(rowless.id, body(0, { login: false }))).status).toBe(200)
      expect(await stateOf(rowless.id)).toBeNull()
    })
  })

  describe('#3 login scope uniqueness', () => {
    it('refuses, on the insert path, a second integration with the same scope: CAPABILITY_LOGIN_SCOPE_TAKEN from the unique index, not STALE', async () => {
      const org = `cap-patch-${randomUUID()}`
      const first = await insertIntegration({ orgId: org })
      const second = await insertIntegration({ orgId: org })
      const trace = useApp()
      expect((await patch(first.id, body(0, { login: true }))).status).toBe(200)
      const response = await patch(second.id, body(0, { login: true }))
      expect(response.status).toBe(409)
      expect(response.body.error).toEqual({
        code: 'CAPABILITY_LOGIN_SCOPE_TAKEN', message: 'Another integration already has login enabled for the same scope', details: { capability: 'login' },
      })
      expect(trace.errors).toEqual([{ code: '23505', constraint: 'dic_login_scope_uniq' }])
      expect(await stateOf(second.id)).toBeNull()
      expect(await historyOf(second.id)).toEqual([])
      expect(trace.audits.at(-1)).toMatchObject({
        action: 'directory.integration.capabilities.refused', resourceId: second.id,
        meta: { provider: 'dingtalk', actorId: ACTOR, code: 'CAPABILITY_LOGIN_SCOPE_TAKEN', capability: 'login' },
      })
      expect((await resolveFresh(first.id, org, 'login')).effective).toBe(true)
      expect(await resolveFresh(second.id, org, 'login')).toEqual(refused('not_enabled'))
      // Other capabilities are not unique per scope.
      expect((await patch(second.id, body(0, { notification: true, directory: true }))).status).toBe(200)
    })

    it('makes the later of two concurrent first-time requests wait at the index for the earlier one, then refuses it', async () => {
      const first = await insertIntegration()
      const second = await insertIntegration()
      const trace = useApp()
      const releaseHistory = await holdHistoryInserts()
      let earlier: Tracked<request.Response> | undefined
      let later: Tracked<request.Response> | undefined
      try {
        earlier = tracked(patch(first.id, body(0, { login: true })))
        await waitUntilLockWait(await pidAfter(trace, 0), earlier)
        later = tracked(patch(second.id, body(0, { login: true })))
        await waitUntilLockWait(await pidAfter(trace, 1), later)
        expect(later.settled()).toBe(false)
        await releaseHistory()
        const [won, lost] = await within(Promise.all([earlier.promise, later.promise]), 'the two PATCH requests')
        expect(won.status).toBe(200)
        expect(lost.status).toBe(409)
        expect(lost.body.error.code).toBe('CAPABILITY_LOGIN_SCOPE_TAKEN')
      } finally {
        await releaseHistory()
        await drain(earlier, later)
      }
      expect(trace.errors).toEqual([{ code: '23505', constraint: 'dic_login_scope_uniq' }])
      expect(await stateOf(first.id)).toMatchObject({ login_enabled: true, revision: '1' })
      expect(await stateOf(second.id)).toBeNull()
    })

    it('refuses on the update path too, and leaves the refused row as it was', async () => {
      const first = await insertIntegration()
      const second = await insertIntegration()
      const trace = useApp()
      expect((await patch(first.id, body(0, { login: true }))).status).toBe(200)
      expect((await patch(second.id, body(0, { notification: true }))).status).toBe(200)
      const before = await stateOf(second.id)
      const response = await patch(second.id, body(1, { login: true, directory: true }))
      expect(response.status).toBe(409)
      expect(response.body.error).toMatchObject({ code: 'CAPABILITY_LOGIN_SCOPE_TAKEN', details: { capability: 'login' } })
      expect(trace.errors).toEqual([{ code: '23505', constraint: 'dic_login_scope_uniq' }])
      expect(await stateOf(second.id)).toEqual(before)
      expect(await historyOf(second.id)).toHaveLength(1)
    })

    it('admits another application, refuses the same scope in another letter case, and frees the scope when login is turned off', async () => {
      const first = await insertIntegration()
      const otherApp = await insertIntegration({ config: { appKey: APP_TWO } })
      const otherCase = await insertIntegration({ corp: CORP.toUpperCase(), config: { appKey: APP.toLowerCase() } })
      useApp()
      expect((await patch(first.id, body(0, { login: true }))).status).toBe(200)
      expect((await patch(otherApp.id, body(0, { login: true }))).status).toBe(200)
      const folded = await patch(otherCase.id, body(0, { login: true }))
      expect(folded.status).toBe(409)
      expect(folded.body.error.code).toBe('CAPABILITY_LOGIN_SCOPE_TAKEN')

      const released = await patch(first.id, body(1, { login: false }))
      expect(released.status).toBe(200)
      expect(await stateOf(first.id)).toMatchObject({ login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null, revision: '2' })
      const taken = await patch(otherCase.id, body(0, { login: true }))
      expect(taken.status).toBe(200)
      expect(await stateOf(otherCase.id)).toMatchObject({ login_enabled: true, login_bound_tenant: CORP.toUpperCase(), login_bound_app_scope: APP.toLowerCase() })
      const back = await patch(first.id, body(2, { login: true }))
      expect(back.status).toBe(409)
      expect(back.body.error.code).toBe('CAPABILITY_LOGIN_SCOPE_TAKEN')
    })
  })

  describe('#4 anchors are per capability', () => {
    it('with login stale: another capability does not re-confirm it; naming it re-anchors it; repeating changes nothing; turning it off frees the scope', async () => {
      const { id, org } = await insertIntegration()
      useApp()
      expect((await patch(id, body(0, { login: true }))).status).toBe(200)
      await setAppKey(id, APP_TWO)
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('scope_changed'))

      // 1. Notification is turned on; login keeps its older anchor and stays stale.
      const one = await patch(id, body(1, { notification: true }))
      expect(one.status).toBe(200)
      expect(one.body.data.revision).toBe(2)
      expect(one.body.data.capabilities.login).toMatchObject({ enabled: true, effective: false, reason: 'scope_changed', anchor: { bound: true, matchesCurrent: false } })
      expect(one.body.data.capabilities.notification).toMatchObject({ enabled: true, effective: true, anchor: { bound: true, matchesCurrent: true } })
      expect(await stateOf(id)).toMatchObject({
        login_enabled: true, login_bound_tenant: CORP, login_bound_app_scope: APP,
        notification_enabled: true, notification_bound_tenant: CORP, notification_bound_app_scope: APP_TWO,
        revision: '2',
      })
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('scope_changed'))
      expect((await resolveFresh(id, org, 'notification')).effective).toBe(true)

      // 2. Login is named: its anchor is replaced, which is a change.
      const two = await patch(id, body(2, { login: true }))
      expect(two.status).toBe(200)
      expect(two.body.data.revision).toBe(3)
      expect(await stateOf(id)).toMatchObject({ login_enabled: true, login_bound_app_scope: APP_TWO, revision: '3' })
      const login = await resolveFresh(id, org, 'login')
      expect(login).toMatchObject({ effective: true, revision: 3, orgId: org })

      // 3. The same request again changes nothing.
      const three = await patch(id, body(3, { login: true }))
      expect(three.status).toBe(200)
      expect(three.body.data.revision).toBe(3)

      expect((await historyOf(id)).map((row) => [row.revision, row.changed, row.anchor_rebound])).toEqual([
        ['1', ['login'], []],
        ['2', ['notification'], []],
        ['3', ['login'], ['login']],
      ])

      // 4. Login is turned off: its anchor is cleared and another integration may take the scope.
      const four = await patch(id, body(3, { login: false }))
      expect(four.status).toBe(200)
      expect(await stateOf(id)).toMatchObject({
        login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null,
        notification_enabled: true, notification_bound_app_scope: APP_TWO, revision: '4',
      })
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('not_enabled'))
      const other = await insertIntegration({ config: { appKey: APP_TWO } })
      expect((await patch(other.id, body(0, { login: true }))).status).toBe(200)
    })

    it('with login and notification both stale: turning login off succeeds and leaves the notification anchor alone', async () => {
      const { id, org } = await insertIntegration()
      useApp()
      expect((await patch(id, body(0, { login: true, notification: true }))).status).toBe(200)
      await setAppKey(id, APP_TWO)
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('scope_changed'))
      expect(await resolveFresh(id, org, 'notification')).toEqual(refused('scope_changed'))

      const response = await patch(id, body(1, { login: false }))
      expect(response.status).toBe(200)
      expect(await stateOf(id)).toMatchObject({
        login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null,
        notification_enabled: true, notification_bound_tenant: CORP, notification_bound_app_scope: APP,
        revision: '2',
      })
      expect(await resolveFresh(id, org, 'notification')).toEqual(refused('scope_changed'))
      expect((await historyOf(id)).at(-1)).toMatchObject({ changed: ['login'], anchor_rebound: [], login_enabled: false, notification_enabled: true })
    })

    it('after the provider is no longer registered: turning a capability off still succeeds, turning one on is refused', async () => {
      const { id } = await insertIntegration()
      useApp()
      expect((await patch(id, body(0, { login: true, notification: true }))).status).toBe(200)
      control.registered = false
      const on = await patch(id, body(1, { directory: true }))
      expect(on.status).toBe(409)
      expect(on.body.error).toMatchObject({ code: 'CAPABILITY_PROVIDER_NOT_REGISTERED', details: { capability: 'directory' } })
      const off = await patch(id, body(1, { login: false }))
      expect(off.status).toBe(200)
      expect(off.body.data.capabilities.login).toEqual({ enabled: false, governance: null, effective: null, reason: 'provider_not_registered', anchor: { bound: false, matchesCurrent: null } })
      expect(await stateOf(id)).toMatchObject({ login_enabled: false, login_bound_app_scope: null, notification_enabled: true, notification_bound_app_scope: APP, revision: '2' })
    })

    it('when the application key is changed and changed back: the capability is effective again without a new confirmation', async () => {
      const { id, org } = await insertIntegration()
      useApp()
      expect((await patch(id, body(0, { login: true }))).status).toBe(200)
      const before = await resolveFresh(id, org, 'login')
      expect(before.effective).toBe(true)
      await setAppKey(id, APP_TWO)
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('scope_changed'))
      await setAppKey(id, APP)
      expect(await resolveFresh(id, org, 'login')).toEqual(before)
      expect(await stateOf(id)).toMatchObject({ revision: '1' })
      expect(await historyOf(id)).toHaveLength(1)
    })

    it('reads no scope at all when no anchor is left on the row: nothing stored, the last capability turned off, and everything already off, with a provider whose every scope read fails', async () => {
      const { id, org } = await insertIntegration()
      const trace = useApp()
      /** One PATCH under a provider that counts every scope read and then fails it. */
      const witnessed = async (payload: unknown): Promise<{ response: request.Response; reads: number }> => {
        let reads = 0
        control.onScopeRead = () => {
          reads += 1
          throw new Error('synthetic scope read failure')
        }
        try {
          return { response: await patch(id, payload), reads }
        } finally {
          control.onScopeRead = null
        }
      }

      // No capability row: nothing to turn off, nothing stored.
      const nothing = await witnessed(body(0, { directory: false, login: false, notification: false }))
      expect(nothing.response.status).toBe(200)
      expect(nothing.reads).toBe(0)
      expect(nothing.response.body.data).toMatchObject({ revision: 0, updatedAt: null })
      expect(await stateOf(id)).toBeNull()

      // The witness is live: under the same provider, turning a capability on reads the scope and fails.
      const on = await witnessed(body(0, { login: true }))
      expect(on.response.status).toBe(500)
      expect(on.response.body.error.code).toBe('DIRECTORY_CAPABILITIES_INTERNAL')
      expect(on.reads).toBe(1)
      expect(await stateOf(id)).toBeNull()

      // Login is turned on (the scope is read), and then turned off as the last capability that was on.
      expect((await patch(id, body(0, { login: true }))).status).toBe(200)
      const last = await witnessed(body(1, { login: false }))
      expect(last.response.status).toBe(200)
      expect(last.reads).toBe(0)
      expect(last.response.body.data.revision).toBe(2)
      for (const capability of ['directory', 'login', 'notification'] as const) {
        expect(last.response.body.data.capabilities[capability]).toMatchObject({ enabled: false, anchor: { bound: false, matchesCurrent: null } })
      }
      expect(await stateOf(id)).toMatchObject({ login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null, revision: '2' })
      expect((await historyOf(id)).at(-1)).toMatchObject({ revision: '2', changed: ['login'], anchor_rebound: [], login_enabled: false })

      // The row exists and every capability on it is off: nothing changes.
      const already = await witnessed(body(2, { login: false, notification: false }))
      expect(already.response.status).toBe(200)
      expect(already.reads).toBe(0)
      expect(already.response.body.data.revision).toBe(2)
      expect(await historyOf(id)).toHaveLength(2)

      expect(trace.errors).toEqual([])
      expect(already.response.body.data).toEqual((await get(id)).body.data)
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('not_enabled'))
    })

    it('with another capability still bound: the scope is read after the write, for that capability’s display only, and a scope that is not complete does not stop the disable', async () => {
      const { id, org } = await insertIntegration()
      const trace = useApp()
      expect((await patch(id, body(0, { directory: true, login: true, notification: true }))).status).toBe(200)

      /** One PATCH; returns the response and, per scope read, how many statements the write had issued by then. */
      const observed = async (payload: unknown): Promise<{ response: request.Response; readsAt: number[]; historyAt: number }> => {
        const readsAt: number[] = []
        control.onScopeRead = () => {
          readsAt.push(trace.statements.length)
        }
        try {
          const response = await patch(id, payload)
          const historyAt = trace.statements.map((text) => /^INSERT INTO directory_integration_capability_history\b/.test(text)).lastIndexOf(true)
          return { response, readsAt, historyAt }
        } finally {
          control.onScopeRead = null
        }
      }

      // The scope matches: directory is turned off, and the two that stay on are shown as they are.
      const matching = await observed(body(1, { directory: false }))
      expect(matching.response.status).toBe(200)
      expect(matching.readsAt.length).toBeGreaterThan(0)
      // Every read came after the history row, the last statement of the write.
      expect(matching.historyAt).toBe(trace.statements.length - 1)
      expect(Math.min(...matching.readsAt)).toBe(trace.statements.length)
      expect(matching.response.body.data.capabilities).toMatchObject({
        directory: { enabled: false, anchor: { bound: false, matchesCurrent: null } },
        login: { enabled: true, effective: true, reason: null, anchor: { bound: true, matchesCurrent: true } },
        notification: { enabled: true, effective: true, reason: null, anchor: { bound: true, matchesCurrent: true } },
      })
      expect(matching.response.body.data).toEqual((await get(id)).body.data)

      // The row now carries an application key that is not a complete scope. Login is turned off all
      // the same; notification keeps its anchor and is shown as not matching.
      await setAppKey(id, 'two words')
      const incomplete = await observed(body(2, { login: false }))
      expect(incomplete.response.status).toBe(200)
      expect(incomplete.readsAt.length).toBeGreaterThan(0)
      expect(incomplete.historyAt).toBe(trace.statements.length - 1)
      expect(Math.min(...incomplete.readsAt)).toBe(trace.statements.length)
      expect(incomplete.response.body.data.revision).toBe(3)
      expect(incomplete.response.body.data.capabilities).toMatchObject({
        login: { enabled: false, anchor: { bound: false, matchesCurrent: null } },
        notification: { enabled: true, effective: false, reason: 'scope_changed', anchor: { bound: true, matchesCurrent: false } },
      })
      expect(incomplete.response.body.data).toEqual((await get(id)).body.data)
      expect(await stateOf(id)).toMatchObject({
        directory_enabled: false, directory_bound_tenant: null, directory_bound_app_scope: null,
        login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null,
        notification_enabled: true, notification_bound_tenant: CORP, notification_bound_app_scope: APP,
        revision: '3',
      })
      expect((await historyOf(id)).map((row) => [row.revision, row.changed])).toEqual([
        ['1', ['directory', 'login', 'notification']],
        ['2', ['directory']],
        ['3', ['login']],
      ])
      expect(trace.errors).toEqual([])
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('not_enabled'))
      expect(await resolveFresh(id, org, 'notification')).toEqual(refused('scope_changed'))
    })
  })

  describe('#5 a change of the integration row cannot slip between the read and the write', () => {
    it('holds the application’s generic save back while the PATCH is between its read and its write; the anchor is the key the PATCH read, and once the save lands the capability is not effective', async () => {
      const { id, org } = await insertIntegration()
      const trace = useApp()
      const reached = deferred()
      const release = deferred()
      control.precondition = async () => {
        reached.resolve()
        await release.promise
        return { ok: true }
      }
      const before = await integrationOf(id)
      expect(before).toMatchObject({ status: 'active', corp_id: CORP, app_key: APP, rebuilt: false, secret_sealed: false })
      const payload = genericSave({ appKey: APP_TWO })
      let patching: Tracked<request.Response> | undefined
      let saving: Tracked<Awaited<ReturnType<typeof updateDirectoryIntegration>>> | undefined
      try {
        patching = tracked(patch(id, body(0, { login: true })))
        await enterGate(reached.promise, 'the precondition of the PATCH', [patching])
        // The PATCH holds its two locks and has written nothing.
        expect(trace.pids).toHaveLength(1)
        const patchPid = trace.pids[0]

        // The application's save, through the function the PUT handler calls, on the application's pool.
        saving = tracked(updateDirectoryIntegration(id, payload, { actorId: ACTOR }))
        const waiting = await waitUntilBlockedBy(patchPid, saving)
        // One backend waits on the PATCH's backend, and its statement is the save's: the row update, or
        // the row lock the save takes first when it runs inside the source gate.
        expect(waiting).toHaveLength(1)
        expect(waiting[0].pid).not.toBe(patchPid)
        expect(waiting[0].statement).toMatch(/^\s*UPDATE directory_integrations\b|\bFROM directory_integrations\b[\s\S]*\bFOR UPDATE\s*$/)
        expect(saving.settled()).toBe(false)
        expect(patching.settled()).toBe(false)
        // Nothing of the save is on the row yet, and nothing of the PATCH is stored.
        expect(await integrationOf(id)).toEqual(before)
        expect(await stateOf(id)).toBeNull()

        release.resolve()
        const response = await within(patching.promise, 'the PATCH')
        expect(response.status).toBe(200)
        expect(response.body.data.capabilities.login).toMatchObject({ enabled: true, effective: true, anchor: { bound: true, matchesCurrent: true } })
        const saved = await within(saving.promise, 'the generic save')
        expect(saved).toMatchObject({ id, status: 'active', corpId: CORP, name: payload.name, config: { appKey: APP_TWO, appSecretConfigured: true } })
      } finally {
        release.resolve()
        await drain(patching, saving)
      }
      // The PATCH committed first, with the key it had locked: that is the anchor that is stored.
      expect(await stateOf(id)).toMatchObject({ login_enabled: true, login_bound_tenant: CORP, login_bound_app_scope: APP, revision: '1' })
      // The save came after it and is the application's: the whole row was rewritten.
      const after = await integrationOf(id)
      expect(after).toMatchObject({ name: payload.name, status: 'active', corp_id: CORP, app_key: APP_TWO, rebuilt: true, secret_sealed: true })
      expect(after.xmin).not.toBe(before.xmin)
      // The stored anchor no longer matches the row, so the capability is not effective.
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('scope_changed'))
      expect((await get(id)).body.data.capabilities.login).toMatchObject({
        enabled: true, effective: false, reason: 'scope_changed', anchor: { bound: true, matchesCurrent: false },
      })
      expect(trace.errors).toEqual([])
    })

    // The reverse lock order. The writing transaction has to stay open across the PATCH's start, which
    // the application's save does not allow (it commits by itself), so the writer here is the
    // controlled row writer on a connection the case holds.
    it.each([
      ['a read-committed-default pool', () => pool],
      ['a repeatable-read-default pool', () => rrPool],
    ] as const)('waits for a controlled row write that is already under way and anchors the key that write committed, on %s', async (_label, sourceOf) => {
      const { id, org } = await insertIntegration()
      const trace = useApp({ source: sourceOf() })
      const writer = await pool.connect()
      let patching: Tracked<request.Response> | undefined
      try {
        await writer.query('BEGIN')
        await writer.query(CONTROLLED_APP_KEY_WRITE_SQL, [id, APP_TWO])
        patching = tracked(patch(id, body(0, { login: true })))
        await waitUntilLockWait(await pidAfter(trace, 0), patching)
        expect(patching.settled()).toBe(false)
        await writer.query('COMMIT')
        const response = await within(patching.promise, 'the PATCH')
        expect(response.status).toBe(200)
      } finally {
        await writer.query('ROLLBACK').catch(() => undefined)
        writer.release()
        await drain(patching)
      }
      expect(await stateOf(id)).toMatchObject({ login_enabled: true, login_bound_app_scope: APP_TWO })
      expect((await resolveFresh(id, org, 'login')).effective).toBe(true)
      expect(trace.errors).toEqual([])
    })
  })

  describe('#6 an integration that is not active', () => {
    it('is not effective, cannot have a capability turned on, can have one turned off, and is effective again once a generic save that names no status has made it active', async () => {
      const { id, org } = await insertIntegration()
      useApp()
      expect((await patch(id, body(0, { login: true, notification: true }))).status).toBe(200)

      // The application's generic save with a status: the integration is no longer active.
      const deactivation = genericSave({ status: 'inactive' })
      expect(await updateDirectoryIntegration(id, deactivation, { actorId: ACTOR })).toMatchObject({ id, status: 'inactive' })
      const inactive = await integrationOf(id)
      expect(inactive).toMatchObject({ name: deactivation.name, status: 'inactive', corp_id: CORP, app_key: APP, rebuilt: true, secret_sealed: true })
      expect(await resolveFresh(id, org, 'login')).toEqual(refused('integration_inactive'))

      const on = await patch(id, body(1, { directory: true }))
      expect(on.status).toBe(409)
      expect(on.body.error).toEqual({ code: 'CAPABILITY_INTEGRATION_INACTIVE', message: 'The integration is not active', details: { capability: 'directory' } })
      const off = await patch(id, body(1, { notification: false }))
      expect(off.status).toBe(200)
      expect(off.body.data).toMatchObject({ integrationStatus: 'inactive', revision: 2 })
      expect(await stateOf(id)).toMatchObject({ login_enabled: true, notification_enabled: false, revision: '2' })
      // The PATCH wrote nothing to the integration row: it is still the inactive row the save left.
      expect(await integrationOf(id)).toEqual(inactive)

      // Existing behaviour, recorded: a generic save whose payload names no status stores 'active', and
      // the stored capability state survives the inactive period.
      const reactivation = genericSave()
      expect(Object.keys(reactivation).sort()).toEqual(['appKey', 'appSecret', 'corpId', 'name'])
      expect('status' in reactivation).toBe(false)
      const saved = await updateDirectoryIntegration(id, reactivation, { actorId: ACTOR })
      expect(saved).toMatchObject({ id, status: 'active', corpId: CORP, name: reactivation.name })
      const active = await integrationOf(id)
      expect(active).toMatchObject({ name: reactivation.name, status: 'active', corp_id: CORP, app_key: APP, rebuilt: true, secret_sealed: true })
      // The save did write the row, and the row is not the one that was inactive.
      expect(active.name).not.toBe(inactive.name)
      expect(active.xmin).not.toBe(inactive.xmin)
      expect(await resolveFresh(id, org, 'login')).toMatchObject({ effective: true, revision: 2 })
      expect(await resolveFresh(id, org, 'notification')).toEqual(refused('not_enabled'))
      expect((await get(id)).body.data).toMatchObject({
        integrationStatus: 'active', revision: 2,
        capabilities: { login: { enabled: true, effective: true, reason: null, anchor: { bound: true, matchesCurrent: true } } },
      })
    })

    it('answers a first-time request for an inactive integration with the same refusal and stores nothing', async () => {
      const { id } = await insertIntegration({ status: 'inactive' })
      useApp()
      const response = await patch(id, body(0, { login: true }))
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('CAPABILITY_INTEGRATION_INACTIVE')
      expect(await stateOf(id)).toBeNull()
    })
  })

  describe('#7 a controlled handover', () => {
    // The capability rows are not part of what a handover preview pins, so a PATCH between preview and
    // apply does not invalidate the preview. The first change that governs login as gated for a real
    // provider is expected to pin them and to turn this case around.
    it('previewed before a PATCH still applies after it, and the PATCH leaves both integration rows as they were', async () => {
      const org = `cap-patch-${randomUUID()}`
      const corp = `CorpHandover-${RUN}`
      const admin = `cap-patch-operator-${randomUUID()}`
      await run(`INSERT INTO users(id, username, name, password_hash, is_active, is_admin) VALUES ($1, $1, $1, 'synthetic-only', true, true)`, [admin])
      userIds.push(admin)
      const verified = (appKey: string) => ({
        appKey,
        identityVerification: { source: 'admin_console', corpId: corp, appKey, appCorpId: corp, checkedBy: admin, checkedAt: '2026-11-01T00:00:00Z' },
      })
      const source = await insertIntegration({ orgId: org, corp, config: verified(APP) })
      const target = await insertIntegration({ orgId: org, corp, config: verified(APP_THREE) })
      await run(
        `INSERT INTO directory_accounts(id, integration_id, corp_id, external_user_id, external_key, name) VALUES ($1::uuid, $2::uuid, $3, $4, $4, 'Synthetic person')`,
        [randomUUID(), source.id, corp, `cap-patch-person-${RUN}`],
      )
      const pair = { sourceIntegrationId: source.id, targetIntegrationId: target.id }

      const preview = await previewDirectoryHandover(pair, admin)
      expect(preview.accounts).toBe(1)
      const images = [await imageOf(source.id), await imageOf(target.id)]

      useApp()
      const response = await patch(target.id, body(0, { login: true, notification: true }))
      expect(response.status).toBe(200)
      expect((await patch(source.id, body(0, { notification: true }))).status).toBe(200)
      expect([await imageOf(source.id), await imageOf(target.id)]).toEqual(images)
      expect((await previewDirectoryHandover(pair, admin)).digest).toBe(preview.digest)

      const applied = await applyDirectoryHandover(pair, preview.digest, admin)
      expect(applied.accounts).toBe(1)
      expect(await stateOf(target.id)).toMatchObject({ login_enabled: true, notification_enabled: true, revision: '1' })
      expect((await resolveFresh(target.id, org, 'login')).effective).toBe(true)
    })
  })

  describe('#8 history in the same transaction', () => {
    async function refuseHistoryFor(integrationId: string): Promise<void> {
      await run(`CREATE FUNCTION ${HISTORY_GUARD}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.integration_id::text = TG_ARGV[0] THEN
            RAISE EXCEPTION 'synthetic history refusal' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $$`)
      await run(`CREATE TRIGGER ${HISTORY_GUARD} BEFORE INSERT ON ${HISTORY} FOR EACH ROW EXECUTE FUNCTION ${HISTORY_GUARD}('${integrationId}')`)
    }

    it('writes neither the capability row nor an audit record when the history row cannot be written, on the insert and on the update path', async () => {
      const fresh = await insertIntegration()
      const existing = await insertIntegration({ config: { appKey: APP_TWO } })
      const trace = useApp()
      expect((await patch(existing.id, body(0, { notification: true }))).status).toBe(200)
      const before = await stateOf(existing.id)
      trace.audits.length = 0

      for (const [id, expectedRevision] of [[fresh.id, 0], [existing.id, 1]] as const) {
        await refuseHistoryFor(id)
        try {
          const response = await patch(id, body(expectedRevision, { login: true }))
          expect(response.status).toBe(500)
          expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_INTERNAL', message: 'Directory integration capabilities request failed' } })
          expect(response.text).not.toContain('synthetic history refusal')
        } finally {
          await dropHistoryGuard()
        }
      }
      expect(trace.errors).toEqual([{ code: 'P0001', constraint: undefined }, { code: 'P0001', constraint: undefined }])
      expect(await stateOf(fresh.id)).toBeNull()
      expect(await historyOf(fresh.id)).toEqual([])
      expect(await stateOf(existing.id)).toEqual(before)
      expect(await historyOf(existing.id)).toHaveLength(1)
      expect(trace.audits).toEqual([])

      // With the refusal gone the same requests are stored, each with its history row.
      expect((await patch(fresh.id, body(0, { login: true }))).status).toBe(200)
      expect((await patch(existing.id, body(1, { login: true }))).status).toBe(200)
      expect(await historyOf(fresh.id)).toEqual([{
        bound_provider: 'dingtalk', revision: '1', actor_id: ACTOR, changed: ['login'], anchor_rebound: [],
        directory_enabled: false, login_enabled: true, notification_enabled: false,
      }])
      expect((await historyOf(existing.id)).map((row) => [row.revision, row.actor_id, row.changed])).toEqual([
        ['1', ACTOR, ['notification']],
        ['2', ACTOR, ['login']],
      ])
    })
  })

  describe('#9 the busy answer and the transaction the PATCH runs in', () => {
    it('answers 503 BUSY within its own lock wait bound while another connection holds the integration row, writes nothing, and succeeds when retried', async () => {
      const { id } = await insertIntegration()
      const trace = useApp()
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(`SELECT 1 FROM ${INTEGRATIONS} WHERE id = $1::uuid FOR UPDATE`, [id])
        const started = Date.now()
        const response = await patch(id, body(0, { login: true }))
        const waited = Date.now() - started
        expect(response.status).toBe(503)
        expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_CAPABILITIES_BUSY', message: 'Directory integration capabilities are busy; retry later' } })
        expect(waited).toBeGreaterThanOrEqual(4_000)
        expect(waited).toBeLessThan(15_000)
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
      expect(trace.errors).toEqual([{ code: '55P03', constraint: undefined }])
      expect(trace.statements.at(-1)).toMatch(/FROM directory_integrations WHERE id = \$1::uuid FOR SHARE$/)
      expect(await stateOf(id)).toBeNull()
      expect(await historyOf(id)).toEqual([])
      expect(trace.audits).toEqual([])

      const retried = await patch(id, body(0, { login: true }))
      expect(retried.status).toBe(200)
      expect(retried.body.data.revision).toBe(1)
    })

    it.each([
      ['a read-committed-default pool', () => pool, 'read committed'],
      ['a repeatable-read-default pool', () => rrPool, 'repeatable read'],
    ] as const)('sets READ COMMITTED as its first statement and its own time bounds, on %s', async (_label, sourceOf, sessionDefault) => {
      const source = sourceOf()
      expect((await source.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation).toBe(sessionDefault)
      const { id } = await insertIntegration()
      const trace = useApp({ source })
      const seen: Row[] = []
      control.precondition = async (_capability, context) => {
        const settings = await context.client.query(
          `SELECT current_setting('transaction_isolation') AS isolation,
                  current_setting('lock_timeout') AS lock_timeout,
                  current_setting('statement_timeout') AS statement_timeout`,
        )
        seen.push(settings.rows[0])
        return { ok: true }
      }
      const response = await patch(id, body(0, { login: true }))
      expect(response.status).toBe(200)
      expect(seen).toEqual([{ isolation: 'read committed', lock_timeout: '5s', statement_timeout: '30s' }])
      expect(trace.statements.slice(0, 3)).toEqual([
        'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
        "SET LOCAL lock_timeout = '5s'",
        "SET LOCAL statement_timeout = '30s'",
      ])
      // The bounds were local to that transaction: the pooled session is as it was.
      const after = await source.query(`SELECT current_setting('transaction_isolation') AS isolation, current_setting('lock_timeout') AS lock_timeout`)
      expect(after.rows[0].isolation).toBe(sessionDefault)
      expect(after.rows[0].lock_timeout).not.toBe('5s')
    })
  })

  describe('#10 scope shape', () => {
    it('refuses a blank-separated, a non-ASCII and an over-long application key with 409 CAPABILITY_SCOPE_INCOMPLETE and stores nothing', async () => {
      const keys = ['two words', '应用标识', `${'a'.repeat(249)}${RUN}`, '', '   ']
      expect(keys[2]).toHaveLength(257)
      const trace = useApp()
      for (const appKey of keys) {
        const { id } = await insertIntegration({ config: { appKey } })
        const response = await patch(id, body(0, { login: true }))
        expect(response.status, JSON.stringify(appKey.slice(0, 12))).toBe(409)
        expect(response.body.error).toEqual({ code: 'CAPABILITY_SCOPE_INCOMPLETE', message: 'The integration scope is missing or malformed', details: { capability: 'login' } })
        expect(await stateOf(id)).toBeNull()
        expect(await historyOf(id)).toEqual([])
        // Turning off does not depend on the scope.
        expect((await patch(id, body(0, { login: false }))).status).toBe(200)
      }
      expect(trace.errors).toEqual([])
      const longest = await insertIntegration({ config: { appKey: `${'b'.repeat(248)}${RUN}` } })
      expect((await patch(longest.id, body(0, { notification: true }))).status).toBe(200)
    })

    it('maps the table’s own anchor check to the same refusal when a provider passes a malformed scope on', async () => {
      control.laxScope = true
      const trace = useApp()
      const cases: Array<[Capability, string]> = [['login', 'two words'], ['notification', '应用标识'], ['directory', 'c'.repeat(257)]]
      for (const [capability, appKey] of cases) {
        const { id } = await insertIntegration({ config: { appKey } })
        const response = await patch(id, body(0, { [capability]: true }))
        expect(response.status).toBe(409)
        expect(response.body.error).toMatchObject({ code: 'CAPABILITY_SCOPE_INCOMPLETE', details: { capability } })
        expect(await stateOf(id)).toBeNull()
        expect(await historyOf(id)).toEqual([])
      }
      expect(trace.errors).toEqual([
        { code: '23514', constraint: 'dic_login_anchor_chk' },
        { code: '23514', constraint: 'dic_notification_anchor_chk' },
        { code: '23514', constraint: 'dic_directory_anchor_chk' },
      ])
    })
  })

  describe('#11 enable preconditions', () => {
    it('refuse with 409 and their own code, and store nothing', async () => {
      const { id } = await insertIntegration()
      const trace = useApp()
      control.precondition = async (capability) => (capability === 'login' ? { ok: false, code: 'IDENTITY_NOT_VERIFIED' } : { ok: true })
      const response = await patch(id, body(0, { notification: true, login: true }))
      expect(response.status).toBe(409)
      expect(response.body.error).toEqual({
        code: 'CAPABILITY_PRECONDITION_FAILED', message: 'An enable precondition is not met', details: { capability: 'login', reason: 'IDENTITY_NOT_VERIFIED' },
      })
      expect(await stateOf(id)).toBeNull()
      expect(await historyOf(id)).toEqual([])
      expect(trace.statements.some((text) => /^(INSERT|UPDATE)\b/.test(text))).toBe(false)
      expect(trace.audits).toEqual([{
        actorId: ACTOR, actorType: 'user', action: 'directory.integration.capabilities.refused',
        resourceType: 'directory-integration-capabilities', resourceId: id,
        meta: { provider: 'dingtalk', actorId: ACTOR, code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'login' },
      }])
      expect((await patch(id, body(0, { notification: true }))).status).toBe(200)
    })

    it('run on the write’s own connection with both rows locked and before the write', async () => {
      const { id, org } = await insertIntegration()
      const trace = useApp()
      expect((await patch(id, body(0, { notification: true }))).status).toBe(200)

      const reached = deferred()
      const release = deferred()
      const witness: { pid?: number; org?: string; row?: Row; history?: number; statementsBefore?: number } = {}
      control.precondition = async (capability, context) => {
        if (capability !== 'login') return { ok: true }
        witness.statementsBefore = trace.statements.length
        witness.pid = Number((await context.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        witness.org = context.orgId
        witness.row = (await context.client.query(`SELECT login_enabled, revision::text AS revision FROM ${CAPS} WHERE integration_id = $1::uuid`, [context.integrationId])).rows[0]
        witness.history = Number((await context.client.query(`SELECT count(*)::int AS n FROM ${HISTORY} WHERE integration_id = $1::uuid`, [context.integrationId])).rows[0].n)
        reached.resolve()
        await release.promise
        return { ok: true }
      }
      let patching: Tracked<request.Response> | undefined
      try {
        patching = tracked(patch(id, body(1, { login: true })))
        await enterGate(reached.promise, 'the precondition of the PATCH', [patching])
        // The integration row is share-locked: an exclusive lock is refused, a shared one is granted.
        expect(await lockAttempt(`SELECT 1 FROM ${INTEGRATIONS} WHERE id = $1::uuid FOR UPDATE NOWAIT`, id)).toBe('55P03')
        expect(await lockAttempt(`SELECT 1 FROM ${INTEGRATIONS} WHERE id = $1::uuid FOR SHARE NOWAIT`, id)).toBe('acquired')
        // The capability row is locked for update: even the weakest row lock is refused.
        expect(await lockAttempt(`SELECT 1 FROM ${CAPS} WHERE integration_id = $1::uuid FOR KEY SHARE NOWAIT`, id)).toBe('55P03')
        expect(patching.settled()).toBe(false)
        release.resolve()
        expect((await within(patching.promise, 'the PATCH')).status).toBe(200)
      } finally {
        release.resolve()
        await drain(patching)
      }
      expect(witness.pid).toBe(trace.pids.at(-1))
      expect(witness.org).toBe(org)
      // Read through the write's own transaction: nothing of this request had been written yet.
      expect(witness.row).toEqual({ login_enabled: false, revision: '1' })
      expect(witness.history).toBe(1)
      // The statements of this request up to the precondition: both locked reads, and no write.
      const upTo = trace.statements.slice(0, witness.statementsBefore)
      const ownStatements = upTo.slice(upTo.lastIndexOf('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'))
      expect(ownStatements.filter((text) => /\bFOR (SHARE|UPDATE)$/.test(text)).map((text) => /FOR (SHARE|UPDATE)$/.exec(text)?.[1])).toEqual(['SHARE', 'UPDATE'])
      expect(ownStatements.some((text) => /^(INSERT|UPDATE)\b/.test(text))).toBe(false)
      const afterwards = trace.statements.slice(witness.statementsBefore)
      expect(afterwards.filter((text) => /^(INSERT|UPDATE)\b/.test(text))).toHaveLength(2)
      expect(await stateOf(id)).toMatchObject({ login_enabled: true, revision: '2' })
    })
  })

  describe('#13 enable gates', () => {
    it('refuse with 409 and their own code after the provider’s precondition passed, and store nothing: no row and no history', async () => {
      const { id } = await insertIntegration()
      const order: string[] = []
      control.precondition = async (capability) => {
        order.push(`precondition:${capability}`)
        return { ok: true }
      }
      const gates: CapabilityEnableGates = {
        directory: [async () => {
          order.push('gate:directory')
          return { ok: false, code: 'ROUTING_POLICY_REQUIRED' }
        }],
      }
      const trace = useApp({ gates })
      const response = await patch(id, body(0, { directory: true }))
      expect(response.status).toBe(409)
      expect(response.body.error).toEqual({
        code: 'CAPABILITY_PRECONDITION_FAILED', message: 'An enable precondition is not met', details: { capability: 'directory', reason: 'ROUTING_POLICY_REQUIRED' },
      })
      expect(order).toEqual(['precondition:directory', 'gate:directory'])
      expect(await stateOf(id)).toBeNull()
      expect(await historyOf(id)).toEqual([])
      expect(trace.statements.some((text) => /^(INSERT|UPDATE)\b/.test(text))).toBe(false)

      // The gate belongs to one capability: another capability of the same integration is not asked.
      order.length = 0
      expect((await patch(id, body(0, { login: true }))).status).toBe(200)
      expect(order).toEqual(['precondition:login'])
      // When the provider's own precondition fails too, its code answers and the gate is not asked.
      order.length = 0
      control.precondition = async () => ({ ok: false, code: 'IDENTITY_NOT_VERIFIED' })
      const both = await patch(id, body(1, { directory: true }))
      expect(both.body.error.details).toEqual({ capability: 'directory', reason: 'IDENTITY_NOT_VERIFIED' })
      expect(order).toEqual([])
    })

    it('run on the write’s own connection with both rows locked and before the write', async () => {
      const { id, org } = await insertIntegration()
      const reached = deferred()
      const release = deferred()
      const witness: { pid?: number; org?: string; row?: Row; history?: number; sameClient?: boolean } = {}
      const gates: CapabilityEnableGates = {
        login: [async (client, context) => {
          witness.sameClient = client === context.client
          witness.pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          witness.org = context.orgId
          witness.row = (await client.query(`SELECT login_enabled, revision::text AS revision FROM ${CAPS} WHERE integration_id = $1::uuid`, [context.integrationId])).rows[0]
          witness.history = Number((await client.query(`SELECT count(*)::int AS n FROM ${HISTORY} WHERE integration_id = $1::uuid`, [context.integrationId])).rows[0].n)
          reached.resolve()
          await release.promise
          return { ok: true }
        }],
      }
      const trace = useApp({ gates })
      expect((await patch(id, body(0, { notification: true }))).status).toBe(200)
      let patching: Tracked<request.Response> | undefined
      try {
        patching = tracked(patch(id, body(1, { login: true })))
        await enterGate(reached.promise, 'the login gate of the PATCH', [patching])
        expect(await lockAttempt(`SELECT 1 FROM ${INTEGRATIONS} WHERE id = $1::uuid FOR UPDATE NOWAIT`, id)).toBe('55P03')
        expect(await lockAttempt(`SELECT 1 FROM ${CAPS} WHERE integration_id = $1::uuid FOR KEY SHARE NOWAIT`, id)).toBe('55P03')
        expect(patching.settled()).toBe(false)
        release.resolve()
        expect((await within(patching.promise, 'the PATCH')).status).toBe(200)
      } finally {
        release.resolve()
        await drain(patching)
      }
      expect(witness.sameClient).toBe(true)
      expect(witness.pid).toBe(trace.pids.at(-1))
      expect(witness.org).toBe(org)
      expect(witness.row).toEqual({ login_enabled: false, revision: '1' })
      expect(witness.history).toBe(1)
      expect(await stateOf(id)).toMatchObject({ login_enabled: true, revision: '2' })
      expect(await historyOf(id)).toHaveLength(2)
    })
  })
})
