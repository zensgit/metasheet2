/**
 * The consumer resolver against real PostgreSQL: an effective decision and each refusal; the
 * transaction contract (read committed, in a transaction, a bounded lock wait) and the difference
 * between a requirement that does not hold (`transaction_required`) and a statement the database fails
 * (`read_failed`); the two FOR SHARE locks blocking a generic PUT and a disable until the consumer
 * ends; a missing row and a racing insert; a repeatable-read-default pool; the caller's lock wait bound
 * against a controlled-handover-shaped FOR UPDATE; and several candidates for one scope.
 *
 * DATABASE_URL-gated, with the EXPECT_DB sentinel. The suite runs only against a disposable database
 * whose schema the lane has already migrated: it owns no migration, never runs one, never bootstraps a
 * table and fails (does not skip) when the required schema is absent. It never changes the schema on
 * any connection; `schema_unavailable` is exercised by narrowing `search_path` inside the reader's own
 * transaction only.
 *
 * Rows a test needs "enabled" are written directly: nothing in the product writes them. Every row the
 * suite writes belongs to an integration it inserted (fresh ids, fresh organizations, a per-run scope
 * suffix), and cleanup deletes exactly those rows: capability rows first, then the integrations. The
 * resolver never writes history, so the history table is not touched; the suite asserts it holds no row
 * for those integrations. Positive cases use a test-only mock of the provider registry and the
 * implementation table (production governs every dingtalk capability as legacy); the resolver itself
 * has no override.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool, type PoolClient } from 'pg'

const control = vi.hoisted(() => ({
  testRegistry: true,
  governance: { directory: 'gated', login: 'gated', notification: 'gated' } as Record<string, 'gated' | 'legacy' | 'unsupported'>,
  implemented: true,
}))

vi.mock('../../src/integrations/provider-capability-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/provider-capability-registry')>()
  return {
    ...actual,
    resolveProviderCapabilityDescriptor: (provider: string) => {
      if (!control.testRegistry) return actual.resolveProviderCapabilityDescriptor(provider)
      if (provider !== 'dingtalk') return null
      const production = actual.resolveProviderCapabilityDescriptor('dingtalk')
      if (production === null) throw new Error('production dingtalk descriptor missing')
      return {
        provider: 'dingtalk',
        governance: { ...control.governance },
        scopeOf: production.scopeOf,
        enablePreconditions: async () => ({ ok: true as const }),
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

import {
  CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS,
  computeIntegrationCapabilityWitness,
  resolveEffectiveIntegrationCapability,
  type CapabilityDecision,
} from '../../src/integrations/integration-capability-resolve'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

// Module top level: it must run (and fail) when the gated describe below is skipped for want of a database.
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const SWITCH = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'
const INTEGRATIONS = 'directory_integrations'
const CAPS = 'directory_integration_capabilities'
const HISTORY = 'directory_integration_capability_history'
type Capability = 'directory' | 'login' | 'notification'

// A per-run scope, so the login uniqueness index never meets a row of another suite or another run.
const RUN = randomUUID().slice(0, 8)
const CORP = `CorpOne-${RUN}`
const APP = `AppOne-${RUN}`
const APP_TWO = `AppTwo-${RUN}`
const APP_INACTIVE = `AppInactive-${RUN}`

interface PgError extends Error {
  code?: string
}

async function pgError(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise
  } catch (error) {
    return error as PgError
  }
  throw new Error('expected the statement to fail')
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const refused = (reason: string) => ({ effective: false, reason })

describeIfDatabase('directory integration capability resolver (real database)', () => {
  let pool: Pool
  let rrPool: Pool | null = null
  const integrationIds: string[] = []

  const run = (text: string, values?: unknown[]) => pool.query(text, values)
  const executorOf = (client: PoolClient | Pool): Queryable => ({
    query: (text: string, values?: unknown[]) => client.query(text, values) as never,
  })

  /** The tables this suite reads, as visible on a default connection; the names of those missing. */
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

  async function insertIntegration(overrides: { provider?: string; orgId?: string; corp?: string; config?: unknown; status?: string } = {}): Promise<{ id: string; org: string }> {
    const org = overrides.orgId ?? `cap-resolve-${randomUUID()}`
    const result = await run(
      `INSERT INTO ${INTEGRATIONS} (org_id, provider, name, status, corp_id, config)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id::text AS id`,
      [org, overrides.provider ?? 'dingtalk', `cap-resolve-${randomUUID()}`, overrides.status ?? 'active', overrides.corp ?? CORP, JSON.stringify(overrides.config ?? { appKey: APP })],
    )
    const id = result.rows[0].id as string
    integrationIds.push(id)
    return { id, org }
  }

  async function insertCapabilityRow(integrationId: string, provider: string, org: string, extra: Record<string, unknown> = {}, executor: Pool | PoolClient = pool): Promise<void> {
    if (!integrationIds.includes(integrationId)) throw new Error('capability rows are written only for integrations this suite inserted')
    const row: Record<string, unknown> = {
      integration_id: integrationId, bound_provider: provider, bound_org_id: org,
      revision: 1, created_by: 'admin-1', updated_by: 'admin-1', ...extra,
    }
    const columns = Object.keys(row)
    await executor.query(
      `INSERT INTO ${CAPS} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map((column) => row[column]),
    )
  }

  const enabled = (capability: Capability, tenant = CORP, appScope = APP) => ({
    [`${capability}_enabled`]: true, [`${capability}_bound_tenant`]: tenant, [`${capability}_bound_app_scope`]: appScope,
  })

  const setAppKey = (integrationId: string, appKey: string) =>
    run(`UPDATE ${INTEGRATIONS} SET config = jsonb_set(config, '{appKey}', to_jsonb($2::text)) WHERE id = $1`, [integrationId, appKey])

  const DISABLE_LOGIN_SQL = `UPDATE ${CAPS} SET login_enabled = false, login_bound_tenant = NULL, login_bound_app_scope = NULL,
    revision = revision + 1, updated_by = 'admin-2' WHERE integration_id = $1`
  const GENERIC_PUT_SQL = `UPDATE ${INTEGRATIONS} SET config = config || '{}'::jsonb, updated_at = now() WHERE id = $1`

  /** One consumer transaction: BEGIN at `isolation`, SET LOCAL lock_timeout, then `fn`; always rolled back. */
  async function inConsumer<T>(fn: (client: PoolClient) => Promise<T>, options: { isolation?: string; lockTimeout?: string; source?: Pool } = {}): Promise<T> {
    const client = await (options.source ?? pool).connect()
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? 'READ COMMITTED'}`)
      await client.query(`SET LOCAL lock_timeout = '${options.lockTimeout ?? '2s'}'`)
      return await fn(client)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  }

  const resolveOn = (client: PoolClient | Pool, integrationId: string, expectedOrgId: string, capability: Capability = 'login'): Promise<CapabilityDecision> =>
    resolveEffectiveIntegrationCapability(executorOf(client), { integrationId, capability, expectedOrgId })

  const resolveFresh = (integrationId: string, expectedOrgId: string, capability: Capability = 'login'): Promise<CapabilityDecision> =>
    inConsumer((client) => resolveOn(client, integrationId, expectedOrgId, capability))

  async function backendPid(client: PoolClient): Promise<number> {
    return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  }

  /** Barrier: returns once backend `pid` is waiting on a heavyweight lock; throws after `timeoutMs`. */
  async function waitUntilLockWait(pid: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await run('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])
      if (result.rows[0]?.wait_event_type === 'Lock') return
      await sleep(25)
    }
    throw new Error(`backend ${pid} never waited on a lock`)
  }

  function tracked<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
    let done = false
    const wrapped = promise.finally(() => { done = true })
    wrapped.catch(() => undefined)
    return { promise: wrapped, settled: () => done }
  }

  function repeatableReadDefaultPool(): Pool {
    const base = dbUrl as string
    const separator = base.includes('?') ? '&' : '?'
    rrPool ??= new Pool({
      connectionString: `${base}${separator}options=${encodeURIComponent('-c default_transaction_isolation=repeatable\\ read')}`,
      max: 2,
    })
    return rrPool
  }

  /** Deletes exactly the rows of the integrations this suite inserted, then checks no history was written for them. */
  async function cleanup(): Promise<void> {
    const ids = [...integrationIds]
    integrationIds.length = 0
    if (ids.length === 0) return
    await run(`DELETE FROM ${CAPS} WHERE integration_id = ANY($1::uuid[])`, [ids])
    await run(`DELETE FROM ${INTEGRATIONS} WHERE id = ANY($1::uuid[])`, [ids])
    const history = await run(`SELECT count(*)::int AS n FROM ${HISTORY} WHERE integration_id = ANY($1::uuid[])`, [ids])
    expect(history.rows[0].n, 'the resolver and this suite write no capability history').toBe(0)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl, max: 8 })
    const missing = await missingTables()
    if (missing.length > 0) {
      throw new Error(
        `the disposable test database must already be migrated; missing: ${missing.join(', ')}. ` +
          'This suite owns no migration and does not bootstrap the schema.',
      )
    }
  })

  beforeEach(() => {
    vi.stubEnv(SWITCH, 'true')
    control.testRegistry = true
    control.governance = { directory: 'gated', login: 'gated', notification: 'gated' }
    control.implemented = true
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await cleanup()
  })

  afterAll(async () => {
    try {
      await cleanup()
    } finally {
      await pool.end()
      if (rrPool) await rrPool.end()
    }
  })

  describe('#1 decisions', () => {
    it('is effective when every condition holds, and returns the witness of the locked rows', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      const decision = await resolveFresh(id, org)
      expect(decision).toEqual({
        effective: true, capability: 'login', integrationId: id, orgId: org, provider: 'dingtalk', status: 'active',
        revision: 1, witness: expect.stringMatching(/^[0-9a-f]{64}$/), orgSource: 'authenticated_tenant',
      })
      if (!decision.effective) throw new Error('expected effective')
      expect(decision.witness).toBe(computeIntegrationCapabilityWitness({
        orgSource: 'authenticated_tenant', integrationId: id, orgId: org, provider: 'dingtalk', status: 'active',
        capability: 'login', revision: 1, anchor: { tenant: CORP, appScope: APP },
      }))

      // A capability row update must advance the revision by exactly one and keep its immutable columns.
      const bumped = await run(
        `UPDATE ${CAPS} SET revision = revision + 1, updated_by = 'admin-2', updated_at = now()
          WHERE integration_id = $1 AND revision = 1
          RETURNING revision::text AS revision, bound_provider, bound_org_id, login_enabled, login_bound_tenant, login_bound_app_scope`,
        [id],
      )
      expect(bumped.rowCount).toBe(1)
      expect(bumped.rows[0]).toEqual({
        revision: '2', bound_provider: 'dingtalk', bound_org_id: org,
        login_enabled: true, login_bound_tenant: CORP, login_bound_app_scope: APP,
      })

      // Only the revision changed, so the decision differs from the earlier one only in revision and witness.
      const next = await resolveFresh(id, org)
      if (!next.effective) throw new Error(`expected effective, got ${next.reason}`)
      expect(next.revision).toBe(2)
      expect(next).toEqual({ ...decision, revision: 2, witness: expect.stringMatching(/^[0-9a-f]{64}$/) })
      expect(next.witness).not.toBe(decision.witness)
      expect(next.witness).toBe(computeIntegrationCapabilityWitness({
        orgSource: 'authenticated_tenant', integrationId: id, orgId: org, provider: 'dingtalk', status: 'active',
        capability: 'login', revision: 2, anchor: { tenant: CORP, appScope: APP },
      }))
    })

    it('refuses each single broken condition with its own reason', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))

      vi.stubEnv(SWITCH, 'false')
      expect(await resolveFresh(id, org)).toEqual(refused('switch_off'))
      vi.stubEnv(SWITCH, 'true')

      expect(await resolveFresh(id, '')).toEqual(refused('org_mismatch'))
      expect(await resolveFresh(id, '  ')).toEqual(refused('org_mismatch'))
      expect(await resolveFresh('not-a-uuid', org)).toEqual(refused('input_invalid'))

      control.governance.login = 'legacy'
      expect(await resolveFresh(id, org)).toEqual(refused('governed_by_legacy_path'))
      control.governance.login = 'unsupported'
      expect(await resolveFresh(id, org)).toEqual(refused('unsupported'))
      control.governance.login = 'gated'
      control.implemented = false
      expect(await resolveFresh(id, org)).toEqual(refused('implementation_missing'))
      control.implemented = true

      expect(await resolveFresh(id, org, 'notification')).toEqual(refused('not_enabled'))
      const bare = await insertIntegration({ orgId: org })
      expect(await resolveFresh(bare.id, org)).toEqual(refused('not_enabled'))

      const inactive = await insertIntegration({ orgId: org, status: 'inactive', config: { appKey: APP_INACTIVE } })
      await insertCapabilityRow(inactive.id, 'dingtalk', org, enabled('login', CORP, APP_INACTIVE))
      expect(await resolveFresh(inactive.id, org)).toEqual(refused('integration_inactive'))

      const wecom = await insertIntegration({ orgId: org, provider: 'wecom' })
      await insertCapabilityRow(wecom.id, 'wecom', org, enabled('login'))
      expect(await resolveFresh(wecom.id, org)).toEqual(refused('provider_not_registered'))

      await setAppKey(id, APP_TWO)
      expect(await resolveFresh(id, org)).toEqual(refused('scope_changed'))
      await setAppKey(id, APP)
      expect((await resolveFresh(id, org)).effective).toBe(true)
    })

    it('refuses through the production registry: every dingtalk capability is legacy', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, { ...enabled('directory'), ...enabled('login'), ...enabled('notification') })
      control.testRegistry = false
      for (const capability of ['directory', 'login', 'notification'] as const) {
        expect(await resolveFresh(id, org, capability), capability).toEqual(refused('governed_by_legacy_path'))
      }
    })

    it('refuses a foreign organization exactly as a missing integration', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      const other = await insertIntegration()
      const foreign = await resolveFresh(id, other.org)
      const missing = await resolveFresh(randomUUID(), org)
      expect(foreign).toEqual(refused('integration_missing'))
      expect(foreign).toEqual(missing)
    })

    it('does not let one integration’s capability row enable another integration sharing its scope', async () => {
      const org = `cap-resolve-${randomUUID()}`
      const first = await insertIntegration({ orgId: org })
      const second = await insertIntegration({ orgId: org })
      await insertCapabilityRow(first.id, 'dingtalk', org, enabled('login'))
      expect((await resolveFresh(first.id, org)).effective).toBe(true)
      expect(await resolveFresh(second.id, org)).toEqual(refused('not_enabled'))
    })

    it('refuses with schema_unavailable when the reader transaction cannot see the tables, and leaves that transaction usable', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      await inConsumer(async (client) => {
        // Only this reader's transaction loses sight of the tables; the schema itself is not touched.
        await client.query('SET LOCAL search_path = pg_catalog')
        expect(await resolveOn(client, id, org)).toEqual(refused('schema_unavailable'))
        expect((await client.query('SELECT 1 AS one')).rows[0].one).toBe(1)
      })
      expect(await missingTables()).toEqual([])
      expect((await resolveFresh(id, org)).effective).toBe(true)
    })
  })

  describe('#2 the caller transaction', () => {
    it.each(['REPEATABLE READ', 'SERIALIZABLE'])('refuses inside a %s transaction', async (isolation) => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      await inConsumer(async (client) => {
        expect(await resolveOn(client, id, org)).toEqual(refused('transaction_required'))
      }, { isolation })
    })

    it('refuses outside a transaction, even with a bounded session lock wait', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      const client = await pool.connect()
      try {
        await client.query("SET lock_timeout = '1s'")
        expect(await resolveOn(client, id, org)).toEqual(refused('transaction_required'))
      } finally {
        await client.query('RESET lock_timeout')
        client.release()
      }
      const bounded = new Pool({
        connectionString: `${dbUrl}${(dbUrl as string).includes('?') ? '&' : '?'}options=${encodeURIComponent('-c lock_timeout=1000')}`,
        max: 2,
      })
      try {
        expect(await resolveOn(bounded, id, org)).toEqual(refused('transaction_required'))
      } finally {
        await bounded.end()
      }
    })

    it('refuses inside an already aborted transaction with read_failed, and the transaction stays aborted', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      await inConsumer(async (client) => {
        expect((await pgError(client.query('SELECT 1 / 0'))).code).toBe('22012')
        expect(await resolveOn(client, id, org)).toEqual(refused('read_failed'))
        expect((await pgError(client.query('SELECT 1'))).code).toBe('25P02')
      })
    })

    it.each([
      ['the settings statement', "current_setting('transaction_isolation') AS isolation", "current_setting('transaction_isolation') AS isolation, pg_sleep(5) AS slept"],
      ['a transaction probe', 'pg_current_xact_id()::text AS xid', 'pg_current_xact_id()::text AS xid, pg_sleep(5) AS slept'],
    ])('refuses with read_failed, not transaction_required, when the database cancels %s (57014), and the caller transaction is then aborted', async (_label, from, to) => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      await inConsumer(async (client) => {
        await client.query("SET LOCAL statement_timeout = '200ms'")
        let rewritten = 0
        // The database itself cancels the one rewritten statement; every other statement is unchanged.
        const slowed: Queryable = {
          query: (text: string, values?: unknown[]) => {
            if (rewritten === 0 && text.includes(from)) {
              rewritten += 1
              return client.query(text.replace(from, to), values) as never
            }
            return client.query(text, values) as never
          },
        }
        expect(await resolveEffectiveIntegrationCapability(slowed, { integrationId: id, capability: 'login', expectedOrgId: org })).toEqual(refused('read_failed'))
        expect(rewritten).toBe(1)
        expect((await pgError(client.query('SELECT 1'))).code).toBe('25P02')
      })
    })

    it('refuses when one of its locked reads fails, and the caller transaction is then aborted', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      await inConsumer(async (client) => {
        // The capability read is sent to a table that does not exist, so the database raises 42P01.
        const failing: Queryable = {
          query: (text: string, values?: unknown[]) =>
            client.query(text.replace(`FROM ${CAPS} `, 'FROM directory_integration_capabilities_absent '), values) as never,
        }
        expect(await resolveEffectiveIntegrationCapability(failing, { integrationId: id, capability: 'login', expectedOrgId: org })).toEqual(refused('read_failed'))
        expect((await pgError(client.query('SELECT 1'))).code).toBe('25P02')
      })
    })
  })

  describe('#3 lock semantics', () => {
    it('blocks a generic PUT of the integration row and a disable of the capability row until the consumer ends', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      const consumer = await pool.connect()
      const putter = await pool.connect()
      const disabler = await pool.connect()
      try {
        await consumer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await consumer.query("SET LOCAL lock_timeout = '2s'")
        expect((await resolveOn(consumer, id, org)).effective).toBe(true)

        for (const writer of [putter, disabler]) {
          await writer.query('BEGIN')
          await writer.query("SET LOCAL lock_timeout = '30s'")
        }
        const putterPid = await backendPid(putter)
        const disablerPid = await backendPid(disabler)
        const put = tracked(putter.query(GENERIC_PUT_SQL, [id]))
        const disable = tracked(disabler.query(DISABLE_LOGIN_SQL, [id]))
        await waitUntilLockWait(putterPid)
        await waitUntilLockWait(disablerPid)
        expect(put.settled()).toBe(false)
        expect(disable.settled()).toBe(false)

        await consumer.query('COMMIT')
        await expect(put.promise).resolves.toMatchObject({ rowCount: 1 })
        await expect(disable.promise).resolves.toMatchObject({ rowCount: 1 })
        await putter.query('COMMIT')
        await disabler.query('COMMIT')
      } finally {
        for (const client of [consumer, putter, disabler]) {
          await client.query('ROLLBACK').catch(() => undefined)
          client.release()
        }
      }
      expect(await resolveFresh(id, org)).toEqual(refused('not_enabled'))
    })
  })

  describe('#4 no capability row', () => {
    it('refuses with no row, and a racing insert committed afterwards neither waits for the consumer nor changes that refusal', async () => {
      const { id, org } = await insertIntegration()
      await inConsumer(async (client) => {
        const decision = await resolveOn(client, id, org)
        expect(decision).toEqual(refused('not_enabled'))
        const inserter = await pool.connect()
        try {
          await inserter.query('BEGIN')
          await inserter.query("SET LOCAL lock_timeout = '5s'")
          await insertCapabilityRow(id, 'dingtalk', org, enabled('login'), inserter)
          await inserter.query('COMMIT')
        } finally {
          await inserter.query('ROLLBACK').catch(() => undefined)
          inserter.release()
        }
        expect(decision).toEqual(refused('not_enabled'))
      })
      expect((await resolveFresh(id, org)).effective).toBe(true)
    })
  })

  describe('#5 repeatable-read-default pool', () => {
    it('refuses after a bare BEGIN instead of answering from an older snapshot', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      const rr = repeatableReadDefaultPool()
      expect((await rr.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation).toBe('repeatable read')
      const client = await rr.connect()
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL lock_timeout = '1s'")
        // Take the snapshot, then disable the capability from another connection.
        expect((await client.query(`SELECT login_enabled FROM ${CAPS} WHERE integration_id = $1`, [id])).rows[0].login_enabled).toBe(true)
        await run(DISABLE_LOGIN_SQL, [id])
        expect(await resolveOn(client, id, org)).toEqual(refused('transaction_required'))
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })

  describe('#6 lock wait bound', () => {
    it('refuses with read_failed within the caller bound while another connection holds the integration row FOR UPDATE, and the caller transaction is aborted', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(`SELECT 1 FROM ${INTEGRATIONS} WHERE id = $1 FOR UPDATE`, [id])
        await inConsumer(async (client) => {
          const started = Date.now()
          expect(await resolveOn(client, id, org)).toEqual(refused('read_failed'))
          expect(Date.now() - started).toBeLessThan(CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS)
          expect((await pgError(client.query('SELECT 1'))).code).toBe('25P02')
        }, { lockTimeout: '1s' })
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
    })

    it.each(['0', '6s'])('refuses lock_timeout=%s with transaction_required and requests no lock on the integration row', async (lockTimeout) => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org, enabled('login'))
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(`SELECT 1 FROM ${INTEGRATIONS} WHERE id = $1 FOR UPDATE`, [id])
        await inConsumer(async (client) => {
          // Safety net only: a resolver that ignored the bound would otherwise wait for the holder forever.
          await client.query("SET LOCAL statement_timeout = '10s'")
          const pid = await backendPid(client)
          const outcome = await Promise.race([
            resolveOn(client, id, org),
            sleep(8_000).then(() => 'blocked' as const),
          ])
          expect(outcome).toEqual(refused('transaction_required'))
          const locks = await run(
            `SELECT count(*)::int AS n FROM pg_locks
              WHERE pid = $1 AND (relation = '${INTEGRATIONS}'::regclass OR (locktype IN ('tuple', 'transactionid') AND NOT granted))`,
            [pid],
          )
          expect(locks.rows[0].n).toBe(0)
          expect((await client.query('SELECT 1 AS one')).rows[0].one).toBe(1)
        }, { lockTimeout })
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
    })
  })

  describe('#7 several candidates for one scope', () => {
    it('finds exactly one effective login among candidates resolved in id order, and two effective notifications that the caller must refuse', async () => {
      const org = `cap-resolve-${randomUUID()}`
      const first = await insertIntegration({ orgId: org })
      const second = await insertIntegration({ orgId: org })
      const ids = [first.id, second.id].sort()
      await insertCapabilityRow(first.id, 'dingtalk', org, { ...enabled('login'), ...enabled('notification') })
      await insertCapabilityRow(second.id, 'dingtalk', org, enabled('notification'))

      const resolveAll = (capability: Capability) => inConsumer(async (client) => {
        const decisions: CapabilityDecision[] = []
        for (const integrationId of ids) decisions.push(await resolveOn(client, integrationId, org, capability))
        return decisions
      })

      const login = await resolveAll('login')
      expect(login.filter((decision) => decision.effective)).toHaveLength(1)
      expect(login.find((decision) => decision.effective)).toMatchObject({ integrationId: first.id })
      expect(login.find((decision) => !decision.effective)).toEqual(refused('not_enabled'))

      const notification = await resolveAll('notification')
      expect(notification.map((decision) => decision.effective)).toEqual([true, true])
      const witnesses = notification.map((decision) => (decision.effective ? decision.witness : ''))
      expect(new Set(witnesses).size).toBe(2)
    })
  })
})
