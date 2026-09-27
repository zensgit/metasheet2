/**
 * 备料定时试拉 `CONNECTION_CANONICAL_UNAVAILABLE` on REAL PostgreSQL — the refusal reasons reach the
 * server log and the HTTP response does not move by one byte (R1/R2/R3/R7 of
 * docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §5).
 *
 * Same harness and the same three properties as the no-DB suite
 * (tests/unit/stock-prep-connection-refusal-diagnostics.test.ts), but every read is real:
 * `data_sources` and `integration_external_systems` are the tables the repository's migrations
 * create (run `db:migrate` first), DataSourceManager loads through a PostgreSQL Kysely, the R7 probe
 * is a real primary-key read, and the plugin reads its external-system rows through its own
 * `lib/db.cjs` over the same pool.
 *
 * REQUIRES DATABASE_URL (a migrated database). It throws without one rather than skipping, and it is
 * excluded from the no-DB default job in vitest.config.ts for that reason. Run it with:
 *   DATABASE_URL=... pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts \
 *     run tests/integration/stock-prep-connection-refusal-diagnostics.db.test.ts
 *
 * Every row it writes carries SENTINEL in its id and is deleted before and after the run.
 * S2a (a binding that points at a soft-deleted source) and S2f (a binding whose source row is gone)
 * are the STORED rows the live-id foreign key tolerates because it is `NOT VALID`
 * (zzzz20260920120000_data_source_live_id_binding_lock.ts): the database refuses to create them
 * today, so they are seeded with foreign-key triggers off for that one transaction
 * (`session_replication_role = replica`, which needs a superuser — as the CI database user is).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import {
  CANONICAL_REFUSAL_RESPONSE,
  HOSTILE_ERROR_CODE,
  HOSTILE_ERROR_MESSAGE,
  LOAD_FAILED_MESSAGE,
  OWNER,
  PULL_ACTION_ID,
  REFUSAL_LOG_MESSAGE,
  ROUTE_FAILED_MESSAGE,
  SCHEDULER_USER,
  SENTINEL,
  SOFT_DELETED_AT,
  TENANT,
  createPluginDb,
  createRefusalStack,
  dataSourceRow,
  externalSystemRow,
  hostileReadError,
  logLinesSince,
  postScheduledDryRun,
  refusalStates,
  resolvableState,
  type CapturedResponse,
  type DataSourceRow,
  type LogEntry,
  type RefusalStack,
} from '../utils/connection-refusal-stack'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()
const SETUP_TIMEOUT_MS = 180_000

const DATA_SOURCE_COLUMNS = [
  'id', 'name', 'type', 'description', 'config', 'status', 'last_connected_at', 'last_error', 'owner_id',
  'workspace_id', 'tenant_id', 'scope_kind', 'is_active', 'auto_connect', 'metadata', 'tags',
  'created_at', 'updated_at', 'deleted_at',
] as const
const JSON_DATA_SOURCE_COLUMNS = new Set(['config', 'metadata', 'tags'])
const EXTERNAL_SYSTEM_COLUMNS = [
  'id', 'tenant_id', 'workspace_id', 'project_id', 'name', 'kind', 'role', 'config', 'credentials_encrypted',
  'capabilities', 'status', 'last_tested_at', 'last_error', 'connection_id', 'legacy_connection_fallback_eligible',
  'created_at', 'updated_at',
] as const
const JSON_EXTERNAL_SYSTEM_COLUMNS = new Set(['config', 'capabilities'])

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required: this suite asserts against real PostgreSQL and never skips')
  }
  return url
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<unknown> }

async function insertRow(
  client: Queryable,
  table: string,
  columns: readonly string[],
  jsonColumns: Set<string>,
  row: Record<string, unknown>,
): Promise<void> {
  const values = columns.map((column) => {
    const value = row[column] === undefined ? null : row[column]
    return jsonColumns.has(column) && value !== null ? JSON.stringify(value) : value
  })
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ')
  await client.query(
    `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders})`,
    values,
  )
}

async function removeSentinelRows(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query('DELETE FROM integration_external_systems WHERE id LIKE $1', [`${SENTINEL}-%`])
    await client.query('DELETE FROM data_sources WHERE id LIKE $1', [`${SENTINEL}-%`])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function assertMigratedSchema(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = ANY (current_schemas(false))
        AND ((table_name = 'data_sources' AND column_name IN ('live_id', 'tenant_id', 'scope_kind'))
          OR (table_name = 'integration_external_systems' AND column_name = 'connection_id'))`,
  )
  expect(rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual([
    'data_sources.live_id',
    'data_sources.scope_kind',
    'data_sources.tenant_id',
    'integration_external_systems.connection_id',
  ])
}

/**
 * Seed the states. Live, referenced sources and their bindings go in the ordinary way (the live-id
 * foreign key checks them); the two stored-corruption states go in with foreign-key triggers off.
 */
async function seed(pool: Pool, dataSources: DataSourceRow[], externalSystems: Array<Record<string, unknown>>, tolerated: Set<string>): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const row of dataSources) {
      const live = tolerated.has(row.id) ? { ...row, deleted_at: null, is_active: true } : row
      await insertRow(client, 'data_sources', DATA_SOURCE_COLUMNS, JSON_DATA_SOURCE_COLUMNS, live)
    }
    for (const row of externalSystems) {
      if (tolerated.has(String(row.connection_id))) continue
      await insertRow(client, 'integration_external_systems', EXTERNAL_SYSTEM_COLUMNS, JSON_EXTERNAL_SYSTEM_COLUMNS, row)
    }
    await client.query('COMMIT')

    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    for (const row of externalSystems) {
      if (!tolerated.has(String(row.connection_id))) continue
      await insertRow(client, 'integration_external_systems', EXTERNAL_SYSTEM_COLUMNS, JSON_EXTERNAL_SYSTEM_COLUMNS, row)
    }
    for (const row of dataSources) {
      if (!tolerated.has(row.id)) continue
      await client.query(
        'UPDATE data_sources SET is_active = $2, deleted_at = $3 WHERE id = $1',
        [row.id, row.is_active, row.deleted_at],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function only(entries: LogEntry[], message: string): LogEntry[] {
  return entries.filter((entry) => entry.message === message)
}

describe('connection refusal diagnostics on real PostgreSQL', () => {
  let pool: Pool
  let kysely: Kysely<unknown>
  let pluginDb: unknown
  const states = refusalStates()
  const control = resolvableState()
  const responses = new Map<string, CapturedResponse>()
  const logs = new Map<string, LogEntry[]>()
  let s2e: { response: CapturedResponse; entries: LogEntry[] }
  let s1: { response: CapturedResponse; entries: LogEntry[] }
  let hostile: { response: CapturedResponse; entries: LogEntry[] }

  async function pull(stack: RefusalStack, externalSystemId: string, expectRefusal: boolean) {
    pinned.setApp(stack.buildApp({ externalSystemId, user: SCHEDULER_USER }))
    const from = stack.logger.entries.length
    const response = await postScheduledDryRun(pinned.url(), TENANT)
    const entries = await logLinesSince(stack.logger, from, { expectRefusal })
    return { response, entries }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireDatabaseUrl(), max: 4 })
    kysely = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    pluginDb = createPluginDb({
      database: { query: async (text: string, params: unknown[]) => (await pool.query(text, params)).rows },
    })
    await assertMigratedSchema(pool)
    await removeSentinelRows(pool)

    // S2a / S2f are stored rows the NOT VALID foreign key tolerates (see the header).
    const s2a = states.find((state) => state.key === 's2a')!
    const s2f = states.find((state) => state.key === 's2f')!
    expect(s2a.dataSource!.deleted_at).toEqual(SOFT_DELETED_AT)
    const tolerated = new Set([s2a.dataSource!.id, String(s2f.externalSystem.connection_id)])
    const s2eSource = dataSourceRow('s2e')
    const s1Source = dataSourceRow('s1')
    const hostileSource = dataSourceRow('r2')
    await seed(
      pool,
      [...states, control].flatMap((state) => (state.dataSource ? [state.dataSource] : []))
        .concat([s2eSource, s1Source, hostileSource]),
      [...states, control].map((state) => state.externalSystem)
        .concat([
          externalSystemRow('s2e', s2eSource.id, OWNER),
          externalSystemRow('s1', s1Source.id, OWNER),
          externalSystemRow('r2', hostileSource.id, OWNER),
        ]),
      tolerated,
    )

    const stack = await createRefusalStack({ kysely, pluginDb })
    // S6: the table changes AFTER the registry loaded, and not through the manager.
    for (const state of states) {
      if (!state.afterLoad || !state.dataSource) continue
      const sets = Object.keys(state.afterLoad)
      expect(sets).toEqual(['is_active'])
      await pool.query('UPDATE data_sources SET is_active = $2 WHERE id = $1', [state.dataSource.id, state.afterLoad.is_active])
    }
    for (const state of [...states, control]) {
      const { response, entries } = await pull(stack, String(state.externalSystem.id), state !== control)
      responses.set(state.key, response)
      logs.set(state.key, entries)
    }

    s2e = await pull(await createRefusalStack({ kysely, pluginDb, loadRegistry: false }), `${SENTINEL}-es-s2e`, true)
    s1 = await pull(await createRefusalStack({ kysely, pluginDb, facadeInjected: false }), `${SENTINEL}-es-s1`, true)
    const failingPluginDb = createPluginDb({
      database: { async query() { throw hostileReadError() } },
    })
    hostile = await pull(await createRefusalStack({ kysely, pluginDb: failingPluginDb }), `${SENTINEL}-es-r2`, false)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    if (pool) {
      await removeSentinelRows(pool).catch(() => undefined)
      await kysely.destroy().catch(() => undefined)
    }
  })

  for (const state of refusalStates()) {
    it(`${state.key}: (a) the HTTP response is byte-identical to the pre-change refusal`, () => {
      expect(responses.get(state.key)).toEqual(CANONICAL_REFUSAL_RESPONSE)
    })

    it(`${state.key}: (b) R1/R7 + R2 + R3 — each line exactly once, with this state's words`, () => {
      const entries = logs.get(state.key)!
      expect(only(entries, REFUSAL_LOG_MESSAGE).map((entry) => entry.detail)).toEqual([
        { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', ...state.expected },
      ])
      expect(only(entries, ROUTE_FAILED_MESSAGE).map((entry) => entry.detail)).toEqual([
        { code: 'CONNECTION_CANONICAL_UNAVAILABLE' },
      ])
      expect(only(entries, LOAD_FAILED_MESSAGE).map((entry) => entry.detail)).toEqual([
        { actionId: PULL_ACTION_ID, delegated: state.delegated, bindingShape: 'canonical' },
      ])
    })
  }

  it('S2e: (a) same bytes; (b) not_loaded / registry_not_loaded, and the table says the row is live', () => {
    expect(s2e.response).toEqual(CANONICAL_REFUSAL_RESPONSE)
    expect(only(s2e.entries, REFUSAL_LOG_MESSAGE).map((entry) => entry.detail)).toEqual([{
      phase: 'canonical',
      code: 'CONNECTION_CANONICAL_UNAVAILABLE',
      reason: 'not_loaded',
      loadOutcome: 'registry_not_loaded',
      persistedLive: true,
    }])
  })

  it('S1: (a) same bytes; (b) facade_unavailable', () => {
    expect(s1.response).toEqual(CANONICAL_REFUSAL_RESPONSE)
    expect(only(s1.entries, REFUSAL_LOG_MESSAGE).map((entry) => entry.detail)).toEqual([{
      phase: 'canonical',
      code: 'CONNECTION_CANONICAL_UNAVAILABLE',
      reason: 'facade_unavailable',
    }])
  })

  it('R2 hostile code: (a) the pre-change response; (b) UNLISTED on the route-failure line', () => {
    expect(hostile.response).toEqual({
      status: 500,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: false, error: { code: HOSTILE_ERROR_CODE, message: HOSTILE_ERROR_MESSAGE } }),
    })
    expect(only(hostile.entries, ROUTE_FAILED_MESSAGE).map((entry) => entry.detail)).toEqual([{ code: 'UNLISTED' }])
    expect(only(hostile.entries, LOAD_FAILED_MESSAGE).map((entry) => entry.detail)).toEqual([
      { actionId: PULL_ACTION_ID, delegated: false, bindingShape: 'unreadable' },
    ])
  })

  it('(a) every canonical refusal state answers with one byte string', () => {
    const answers = new Set([...refusalStates().map((state) => responses.get(state.key)), s2e.response, s1.response]
      .map((response) => JSON.stringify(response)))
    expect(answers.size).toBe(1)
  })

  it('(c) values-free: no fixture value reaches any log line', () => {
    const everything = JSON.stringify([...logs.values(), s2e.entries, s1.entries, hostile.entries])
    expect(everything.toLowerCase()).not.toContain(SENTINEL)
    expect(everything).not.toContain('FORGED')
    expect(everything).toContain('connection resolution refused')
  })

  it('control: a resolvable binding produces no refusal, load-failure or route-failure line', () => {
    const entries = logs.get(control.key)!
    expect(only(entries, REFUSAL_LOG_MESSAGE)).toEqual([])
    expect(only(entries, LOAD_FAILED_MESSAGE)).toEqual([])
    expect(only(entries, ROUTE_FAILED_MESSAGE)).toEqual([])
    expect(responses.get(control.key)!.body).not.toContain('CONNECTION_CANONICAL_UNAVAILABLE')
  })
})
