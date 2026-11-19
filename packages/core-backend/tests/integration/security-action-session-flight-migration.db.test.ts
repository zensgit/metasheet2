import { randomBytes, randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, type PostgresPoolClient } from 'kysely'
import { Client as PgClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as installChallenges } from '../../src/db/migrations/zzzz20261106120000_create_security_action_challenges'
import {
  SECURITY_ACTION_SESSION_FLIGHT_DOWN_BLOCKED_CODE,
  SECURITY_ACTION_SESSION_FLIGHT_SCHEMA_BLOCKED_CODE,
  down,
  up,
} from '../../src/db/migrations/zzzz20261117120100_create_security_action_session_flight'

const databaseUrl = process.env.DATABASE_URL
if (process.env.EXPECT_DB !== '1' || !databaseUrl) {
  throw new Error('security-action-session-flight-migration.db.test.ts requires EXPECT_DB=1 and DATABASE_URL')
}

const RELATION = 'security_action_session_flight'
const ACQUIRE = `${RELATION}_acquire`
const RELEASE = `${RELATION}_release`
const GUARD = `${RELATION}_guard`
const RELATIONS = ['users', 'user_sessions', 'security_action_challenges', RELATION]
const FUNCTIONS = [ACQUIRE, RELEASE, GUARD, 'guard_security_action_challenge_transition']
const DOWN_BLOCKED = SECURITY_ACTION_SESSION_FLIGHT_DOWN_BLOCKED_CODE
const SCHEMA_BLOCKED = SECURITY_ACTION_SESSION_FLIGHT_SCHEMA_BLOCKED_CODE

type Migration = (db: Kysely<unknown>) => Promise<void>
type Snapshot = Awaited<ReturnType<typeof catalog>>

let clients: PgClient[] = []
let connected = new Set<PgClient>()
let schemas = new Set<string>()
let caller: PgClient | undefined
let selected = ''
let unrelated = ''
let sessionId = ''
let deletionUserId = ''
let originalToken = ''
let foreignToken = ''
let publicBefore: Snapshot | undefined
let statements: string[] = []

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function owned(namespace: string, object: string): string {
  if (!schemas.has(namespace)) throw new Error('unowned fixture namespace refused')
  return `${quote(namespace)}.${quote(object)}`
}

function client(): PgClient {
  if (!caller) throw new Error('fixture connection was not established')
  return caller
}

async function connect(): Promise<PgClient> {
  const connection = new PgClient({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    options: '-c search_path=pg_catalog -c lock_timeout=5s -c statement_timeout=30s',
  })
  clients.push(connection)
  await connection.connect()
  connected.add(connection)
  return connection
}

async function pin(connection: PgClient, namespaces: string[]): Promise<void> {
  await connection.query('SELECT pg_catalog.set_config(\'search_path\', $1, false)', [
    namespaces.map(quote).join(', '),
  ])
}

async function createSchema(invalid = false): Promise<string> {
  const namespace = `${invalid ? 'wpc-invalid-' : 'wpc_migration_'}${randomUUID().replace(/-/g, '')}`
  await client().query(`CREATE SCHEMA ${quote(namespace)}`)
  schemas.add(namespace)
  return namespace
}

async function migrate(connection: PgClient, migration: Migration): Promise<void> {
  statements = []
  const bound = {
    query: ((text: string, values: readonly unknown[]) => {
      statements.push(text)
      return connection.query(text, [...values])
    }) as unknown as PostgresPoolClient['query'],
    release: () => undefined,
  }
  const database = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: {
        connect: async () => bound,
        end: async () => undefined,
      },
    }),
  })
  try {
    await migration(database)
  } finally {
    await database.destroy()
  }
}

async function transaction(connection: PgClient, operation: () => Promise<void>): Promise<void> {
  await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  try {
    await operation()
    await connection.query('COMMIT')
  } catch (error) {
    await connection.query('ROLLBACK')
    throw error
  }
}

async function install(namespace: string): Promise<void> {
  await pin(client(), [namespace, 'pg_catalog'])
  await transaction(client(), () => migrate(client(), up))
}

async function timeouts(connection = client()) {
  const result = await connection.query<{ lock_timeout: string; statement_timeout: string }>(`
    SELECT pg_catalog.current_setting('lock_timeout') AS lock_timeout,
           pg_catalog.current_setting('statement_timeout') AS statement_timeout
  `)
  return result.rows[0]
}

async function customTimeouts(): Promise<Awaited<ReturnType<typeof timeouts>>> {
  await client().query(`
    SELECT pg_catalog.set_config('lock_timeout', '1379ms', true),
           pg_catalog.set_config('statement_timeout', '23111ms', true)
  `)
  return timeouts()
}

function expectNoDrop(): void {
  expect(statements.filter((statement) => /^\s*DROP\b/i.test(statement))).toEqual([])
}

async function catalog(namespace: string) {
  const path = await client().query<{ path: string }>("SELECT pg_catalog.current_setting('search_path') AS path")
  await client().query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', false)")
  const relations = await client().query(`
    SELECT relation.oid::text AS oid, relation.relname AS name,
           relation.relkind AS kind, relation.relpersistence AS persistence,
           relation.relowner::text AS owner_oid, relation.relacl::text AS acl,
           CASE WHEN relation.relkind IN ('v', 'm')
             THEN pg_catalog.pg_get_viewdef(relation.oid, true) ELSE NULL END AS view_definition
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
     ORDER BY relation.relname
  `, [namespace, RELATIONS])
  const columns = await client().query(`
    SELECT relation.relname AS relation, attribute.attnum AS position,
           attribute.attname AS name,
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type,
           attribute.attnotnull AS not_null,
           pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS default_value
      FROM pg_catalog.pg_attribute attribute
      JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef default_value
        ON default_value.adrelid = relation.oid AND default_value.adnum = attribute.attnum
     WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
     ORDER BY relation.relname, attribute.attnum
  `, [namespace, RELATIONS])
  const constraints = await client().query(`
    SELECT constraint_row.oid::text AS oid, relation.relname AS relation,
           constraint_row.conname AS name, constraint_row.contype AS type,
           constraint_row.convalidated AS validated,
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
     ORDER BY relation.relname, constraint_row.conname
  `, [namespace, RELATIONS])
  const indexes = await client().query(`
    SELECT index_row.indexrelid::text AS oid, relation.relname AS relation,
           index_relation.relname AS name,
           pg_catalog.pg_get_indexdef(index_row.indexrelid) AS definition
      FROM pg_catalog.pg_index index_row
      JOIN pg_catalog.pg_class relation ON relation.oid = index_row.indrelid
      JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
     ORDER BY relation.relname, index_relation.relname
  `, [namespace, RELATIONS])
  const functions = await client().query(`
    SELECT procedure.oid::text AS oid, procedure.proname AS name,
           procedure.prosecdef AS security_definer, procedure.proconfig AS settings,
           pg_catalog.pg_get_functiondef(procedure.oid) AS definition
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = $1 AND procedure.proname = ANY($2::text[])
     ORDER BY procedure.proname, procedure.oid
  `, [namespace, FUNCTIONS])
  const triggers = await client().query(`
    SELECT trigger_row.oid::text AS oid, relation.relname AS relation,
           trigger_row.tgname AS name, trigger_row.tgenabled AS enabled,
           pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
      FROM pg_catalog.pg_trigger trigger_row
      JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
     ORDER BY relation.relname, trigger_row.tgname
  `, [namespace, RELATIONS])
  await client().query("SELECT pg_catalog.set_config('search_path', $1, false)", [path.rows[0]!.path])
  return {
    relations: relations.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    functions: functions.rows,
    triggers: triggers.rows,
  }
}

async function sentinelRows() {
  const results = []
  for (const relation of RELATIONS.slice(0, 3)) {
    const result = await client().query(`SELECT * FROM ${owned(selected, relation)} ORDER BY id`)
    results.push({ relation, rows: result.rows })
  }
  return results
}

async function flightRows(namespace = selected) {
  const result = await client().query(`SELECT * FROM ${owned(namespace, RELATION)} ORDER BY session_id`)
  return result.rows
}

async function helper(
  name: typeof ACQUIRE | typeof RELEASE,
  token = originalToken,
  sid = sessionId,
  connection = client(),
  namespace = selected,
): Promise<boolean> {
  const result = await connection.query<{ result: boolean }>(
    `SELECT ${owned(namespace, name)}($1::text, $2::text) AS result`,
    [sid, token],
  )
  expect(result.rows).toHaveLength(1)
  return result.rows[0]!.result
}

async function rejectedSql(operation: () => Promise<unknown>, code: string): Promise<void> {
  await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
  try {
    await expect(operation()).rejects.toMatchObject({ code })
  } finally {
    await client().query('ROLLBACK')
  }
}

beforeEach(async () => {
  clients = []
  connected = new Set()
  schemas = new Set()
  caller = undefined
  publicBefore = undefined
  statements = []
  sessionId = randomUUID()
  deletionUserId = randomUUID()
  originalToken = randomBytes(32).toString('hex')
  foreignToken = randomBytes(32).toString('hex')
  caller = await connect()
  publicBefore = await catalog('public')
  selected = await createSchema()
  unrelated = await createSchema()
  await pin(client(), [selected, 'pg_catalog'])
  await client().query(`
    CREATE TABLE ${owned(selected, 'users')} (id text PRIMARY KEY);
    CREATE TABLE ${owned(selected, 'user_sessions')} (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES ${owned(selected, 'users')}(id) ON DELETE CASCADE
    )
  `)
  const retainedUserId = randomUUID()
  await client().query(`INSERT INTO ${owned(selected, 'users')}(id) VALUES ($1), ($2)`, [
    retainedUserId, deletionUserId,
  ])
  await client().query(`INSERT INTO ${owned(selected, 'user_sessions')}(id, user_id) VALUES ($1, $2)`, [
    sessionId, deletionUserId,
  ])
  await transaction(client(), () => migrate(client(), installChallenges))
  await client().query(`
    INSERT INTO ${owned(selected, 'security_action_challenges')} (
      id, user_id, session_id, purpose, target_kind, target_witness, method,
      status, failure_code, policy_revision, access_generation,
      credential_witness, privilege_witness, privilege_class
    ) VALUES ($1, $2, $3, 'external_identity_bind', 'empty_slot', $4, 'local_password',
              'failed', 'credential_rejected', 1, 1, $4, $4, 'standard')
  `, [randomUUID(), retainedUserId, randomUUID(), randomBytes(32).toString('hex')])
})

afterEach(async () => {
  const failures: unknown[] = []
  for (const connection of clients) {
    if (!connected.has(connection)) continue
    try {
      await connection.query('ROLLBACK')
    } catch (error) {
      failures.push(error)
    }
  }
  for (const connection of clients.filter((connection) => connection !== caller)) {
    try {
      await connection.end()
      connected.delete(connection)
    } catch (error) {
      failures.push(error)
    }
  }
  if (caller && connected.has(caller)) {
    if (publicBefore) {
      try {
        expect(await catalog('public')).toEqual(publicBefore)
      } catch (error) {
        failures.push(error)
      }
    }
    for (const namespace of [...schemas].reverse()) {
      try {
        await caller.query(`DROP SCHEMA ${quote(namespace)} CASCADE`)
        schemas.delete(namespace)
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await caller.end()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'owned migration fixture cleanup failed')
})

describe('security action session flight migration: stage 1 real PostgreSQL', () => {
  it('installs the exact permanent catalog, text session PK, active/token checks and no incoming or outgoing FK', async () => {
    const sentinels = await sentinelRows()
    await install(selected)
    const installed = await catalog(selected)
    const relation = installed.relations.find((entry) => entry.name === RELATION)
    expect(relation).toEqual({
      oid: expect.stringMatching(/^[1-9][0-9]*$/),
      name: RELATION,
      kind: 'r',
      persistence: 'p',
      owner_oid: expect.stringMatching(/^[1-9][0-9]*$/),
      acl: null,
      view_definition: null,
    })
    expect(installed.columns.filter((entry) => entry.relation === RELATION)).toEqual([
      { relation: RELATION, position: 1, name: 'session_id', type: 'text', not_null: true, default_value: null },
      { relation: RELATION, position: 2, name: 'owner_token', type: 'text', not_null: true, default_value: null },
      { relation: RELATION, position: 3, name: 'state', type: 'text', not_null: true, default_value: null },
      { relation: RELATION, position: 4, name: 'bound_at', type: 'timestamp with time zone', not_null: true, default_value: 'clock_timestamp()' },
    ])
    expect(installed.constraints.filter((entry) => entry.relation === RELATION).map((entry) => ({
      name: entry.name, type: entry.type, validated: entry.validated, definition: entry.definition,
    }))).toEqual([
      { name: `${RELATION}_owner_token_chk`, type: 'c', validated: true, definition: "CHECK (owner_token ~ '^[0-9a-f]{64}$'::text)" },
      { name: `${RELATION}_pkey`, type: 'p', validated: true, definition: 'PRIMARY KEY (session_id)' },
      { name: `${RELATION}_state_chk`, type: 'c', validated: true, definition: "CHECK (state = 'active'::text)" },
    ])
    const foreignKeys = await client().query(`
      SELECT oid::text AS oid FROM pg_catalog.pg_constraint
       WHERE contype = 'f' AND (conrelid = $1::oid OR confrelid = $1::oid)
    `, [relation!.oid])
    expect(foreignKeys.rows).toEqual([])
    expect(installed.functions.filter((entry) => [ACQUIRE, RELEASE, GUARD].includes(entry.name)).map((entry) => ({
      name: entry.name, security_definer: entry.security_definer, settings: entry.settings,
    }))).toEqual([ACQUIRE, GUARD, RELEASE].map((name) => ({ name, security_definer: false, settings: ['search_path=pg_catalog'] })))
    expect(installed.triggers.filter((entry) => entry.relation === RELATION).map((entry) => ({
      name: entry.name, enabled: entry.enabled,
    }))).toEqual([{ name: GUARD, enabled: 'O' }])
    expect(await sentinelRows()).toEqual(sentinels)
  })

  it('claims only once, binds database time, preserves foreign ownership and releases only the exact original pair', async () => {
    await install(selected)
    const started = await client().query<{ started: Date }>('SELECT pg_catalog.clock_timestamp() AS started')
    expect(await helper(ACQUIRE)).toBe(true)
    const first = await flightRows()
    expect(first).toHaveLength(1)
    expect(first[0]).toEqual({ session_id: sessionId, owner_token: originalToken, state: 'active', bound_at: expect.any(Date) })
    const boundTime = await client().query(`
      SELECT bound_at >= $1::timestamptz AND bound_at <= pg_catalog.clock_timestamp() AS within_database_interval
        FROM ${owned(selected, RELATION)} WHERE session_id = $2
    `, [started.rows[0]!.started, sessionId])
    expect(boundTime.rows).toEqual([{ within_database_interval: true }])
    expect(await helper(ACQUIRE)).toBe(false)
    expect(await helper(ACQUIRE, foreignToken)).toBe(false)
    expect(await helper(RELEASE, foreignToken)).toBe(false)
    expect(await helper(RELEASE, originalToken, randomUUID())).toBe(false)
    expect(await flightRows()).toEqual(first)
    expect(await helper(RELEASE)).toBe(true)
    expect(await helper(RELEASE)).toBe(false)
    expect(await flightRows()).toEqual([])
    expect(await helper(ACQUIRE, foreignToken)).toBe(true)
    const successor = await flightRows()
    expect(await helper(RELEASE)).toBe(false)
    expect(await flightRows()).toEqual(successor)
    expect(await helper(RELEASE, foreignToken)).toBe(true)
  })

  it.each([
    ['short', 'a'.repeat(63)],
    ['long', 'a'.repeat(65)],
    ['uppercase', 'A'.repeat(64)],
    ['nonhex', 'g'.repeat(64)],
    ['empty', ''],
  ])('rejects a %s owner token without inserting a latch', async (_label, token) => {
    await install(selected)
    await rejectedSql(() => helper(ACQUIRE, token), '23514')
    expect(await flightRows()).toEqual([])
  })

  it('rejects an inactive direct insert even with the matching transaction-local token', async () => {
    await install(selected)
    await rejectedSql(async () => {
      await client().query("SELECT pg_catalog.set_config('security_action.session_flight_token', $1, true)", [originalToken])
      await client().query(`INSERT INTO ${owned(selected, RELATION)}(session_id, owner_token, state) VALUES ($1, $2, 'expired')`, [sessionId, originalToken])
    }, '42501')
    expect(await flightRows()).toEqual([])
  })

  it('refuses unguarded direct INSERT and DELETE and preserves the owned row', async () => {
    await install(selected)
    await rejectedSql(() => client().query(
      `INSERT INTO ${owned(selected, RELATION)}(session_id, owner_token, state) VALUES ($1, $2, 'active')`,
      [sessionId, originalToken],
    ), '42501')
    expect(await flightRows()).toEqual([])
    expect(await helper(ACQUIRE)).toBe(true)
    const before = await flightRows()
    await rejectedSql(() => client().query(`DELETE FROM ${owned(selected, RELATION)} WHERE session_id = $1`, [sessionId]), '42501')
    expect(await flightRows()).toEqual(before)
  })

  it.each(['session_id', 'owner_token', 'state', 'bound_at'])('rejects even a no-op UPDATE of %s with the correct guard token', async (column) => {
    await install(selected)
    expect(await helper(ACQUIRE)).toBe(true)
    const before = await flightRows()
    await rejectedSql(async () => {
      await client().query("SELECT pg_catalog.set_config('security_action.session_flight_token', $1, true)", [originalToken])
      await client().query(`UPDATE ${owned(selected, RELATION)} SET ${quote(column)} = ${quote(column)} WHERE session_id = $1`, [sessionId])
    }, '42501')
    expect(await flightRows()).toEqual(before)
  })

  it.each(['session', 'user'])('retains the committed latch after synthetic %s deletion', async (parent) => {
    await install(selected)
    expect(await helper(ACQUIRE)).toBe(true)
    const before = await flightRows()
    const challenges = await client().query(`SELECT * FROM ${owned(selected, 'security_action_challenges')} ORDER BY id`)
    if (parent === 'session') {
      await client().query(`DELETE FROM ${owned(selected, 'user_sessions')} WHERE id = $1`, [sessionId])
    } else {
      await client().query(`DELETE FROM ${owned(selected, 'users')} WHERE id = $1`, [deletionUserId])
    }
    expect((await client().query(`SELECT id FROM ${owned(selected, 'user_sessions')} WHERE id = $1`, [sessionId])).rows).toEqual([])
    expect(await flightRows()).toEqual(before)
    expect((await client().query(`SELECT * FROM ${owned(selected, 'security_action_challenges')} ORDER BY id`)).rows).toEqual(challenges.rows)
    expect(await helper(RELEASE)).toBe(true)
  })

  it('selects the first explicit application namespace after system entries and coexists with another installation', async () => {
    await install(unrelated)
    const peerBefore = await catalog(unrelated)
    const original = await catalog(selected)
    const sentinels = await sentinelRows()
    await pin(client(), ['pg_catalog', 'information_schema', selected, unrelated, 'public'])
    const effective = await client().query<{ schemas: string[] }>('SELECT pg_catalog.current_schemas(false)::text[] AS schemas')
    expect(effective.rows[0]!.schemas.filter((namespace) => !namespace.startsWith('pg_') && namespace !== 'information_schema')[0]).toBe(selected)
    await transaction(client(), async () => {
      const beforeTimeouts = await customTimeouts()
      await migrate(client(), up)
      expect(await timeouts()).toEqual(beforeTimeouts)
    })
    const installed = await catalog(selected)
    expect(installed.relations.filter((entry) => entry.name === RELATION).map((entry) => ({ kind: entry.kind, persistence: entry.persistence }))).toEqual([{ kind: 'r', persistence: 'p' }])
    expect(await catalog(unrelated)).toEqual(peerBefore)
    await transaction(client(), async () => {
      await client().query('SELECT 1')
      const beforeTimeouts = await customTimeouts()
      await migrate(client(), down)
      expect(await timeouts()).toEqual(beforeTimeouts)
      expect(await catalog(selected)).toEqual(original)
    })
    expect(await catalog(selected)).toEqual(original)
    expect(await catalog(unrelated)).toEqual(peerBefore)
    expect(await sentinelRows()).toEqual(sentinels)
  })

  it('no-ops down only for an absent relation in the valid selected namespace without falling through to unrelated or public', async () => {
    await install(unrelated)
    const peerBefore = await catalog(unrelated)
    const selectedBefore = await catalog(selected)
    const sentinels = await sentinelRows()
    await pin(client(), [selected, unrelated, 'public', 'pg_catalog'])
    await transaction(client(), async () => {
      const beforeTimeouts = await customTimeouts()
      await migrate(client(), down)
      expectNoDrop()
      expect(await timeouts()).toEqual(beforeTimeouts)
      expect(await catalog(unrelated)).toEqual(peerBefore)
      expect(await catalog(selected)).toEqual(selectedBefore)
    })
    expect(await catalog(unrelated)).toEqual(peerBefore)
    expect(await catalog(selected)).toEqual(selectedBefore)
    expect(await sentinelRows()).toEqual(sentinels)
  })

  it.each(['up', 'down'] as const)('%s rejects an invalid first application identifier instead of selecting a later installation', async (direction) => {
    await install(unrelated)
    const invalid = await createSchema(true)
    const peerBefore = await catalog(unrelated)
    const invalidBefore = await catalog(invalid)
    await pin(client(), ['pg_catalog', invalid, unrelated, 'public'])
    await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      const beforeTimeouts = await customTimeouts()
      await expect(migrate(client(), direction === 'up' ? up : down)).rejects.toMatchObject({ code: SCHEMA_BLOCKED })
      expectNoDrop()
      if (direction === 'down') expect(await timeouts()).toEqual(beforeTimeouts)
      expect(await catalog(invalid)).toEqual(invalidBefore)
      expect(await catalog(unrelated)).toEqual(peerBefore)
    } finally {
      await client().query('ROLLBACK')
    }
    expect(await catalog(unrelated)).toEqual(peerBefore)
  })

  it.each(['up', 'down'] as const)('%s refuses a system-only effective path without a public fallback', async (direction) => {
    await install(unrelated)
    const peerBefore = await catalog(unrelated)
    await pin(client(), ['pg_catalog', 'information_schema'])
    await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      const beforeTimeouts = await customTimeouts()
      await expect(migrate(client(), direction === 'up' ? up : down)).rejects.toMatchObject({ code: SCHEMA_BLOCKED })
      expectNoDrop()
      if (direction === 'down') expect(await timeouts()).toEqual(beforeTimeouts)
    } finally {
      await client().query('ROLLBACK')
    }
    expect(await catalog(unrelated)).toEqual(peerBefore)
  })

  it.each([
    ['view', 'CREATE VIEW', "AS SELECT 'synthetic'::text AS session_id"],
    ['materialized view', 'CREATE MATERIALIZED VIEW', "AS SELECT 'synthetic'::text AS session_id"],
    ['unlogged table', 'CREATE UNLOGGED TABLE', '(session_id text PRIMARY KEY)'],
    ['partitioned table', 'CREATE TABLE', '(session_id text) PARTITION BY HASH (session_id)'],
  ])('refuses a selected %s without dropping it or falling through to an installed peer', async (_label, create, definition) => {
    await install(unrelated)
    await client().query(`${create} ${owned(selected, RELATION)} ${definition}`)
    const selectedBefore = await catalog(selected)
    const peerBefore = await catalog(unrelated)
    await pin(client(), [selected, unrelated, 'public', 'pg_catalog'])
    await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      const beforeTimeouts = await customTimeouts()
      await expect(migrate(client(), down)).rejects.toMatchObject({ code: DOWN_BLOCKED })
      expectNoDrop()
      expect(await timeouts()).toEqual(beforeTimeouts)
      expect(await catalog(selected)).toEqual(selectedBefore)
      expect(await catalog(unrelated)).toEqual(peerBefore)
    } finally {
      await client().query('ROLLBACK')
    }
    await rejectedSql(() => migrate(client(), up), '42P07')
    expectNoDrop()
    expect(await catalog(selected)).toEqual(selectedBefore)
    expect(await catalog(unrelated)).toEqual(peerBefore)
  })

  it('ignores temporary same-name relation and helper shadows for qualified helpers and selected-schema down', async () => {
    await install(selected)
    await install(unrelated)
    const peerBefore = await catalog(unrelated)
    await client().query(`CREATE TEMP TABLE ${quote(RELATION)} (marker text PRIMARY KEY)`)
    await client().query(`INSERT INTO pg_temp.${quote(RELATION)}(marker) VALUES ('untouched')`)
    await client().query(`CREATE FUNCTION pg_temp.${quote(ACQUIRE)}(text, text) RETURNS boolean LANGUAGE sql AS 'SELECT false'`)
    await client().query(`CREATE FUNCTION pg_temp.${quote(RELEASE)}(text, text) RETURNS boolean LANGUAGE sql AS 'SELECT false'`)
    const temporary = await client().query(`SELECT pg_catalog.to_regclass($1)::oid::text AS oid`, [`pg_temp.${RELATION}`])
    await pin(client(), ['pg_temp', 'pg_catalog', 'information_schema', selected, unrelated, 'public'])
    expect(await helper(ACQUIRE)).toBe(true)
    expect(await flightRows()).toHaveLength(1)
    expect(await helper(RELEASE)).toBe(true)
    await transaction(client(), () => migrate(client(), down))
    expect((await catalog(selected)).relations.filter((entry) => entry.name === RELATION)).toEqual([])
    expect(await catalog(unrelated)).toEqual(peerBefore)
    expect((await client().query(`SELECT pg_catalog.to_regclass($1)::oid::text AS oid`, [`pg_temp.${RELATION}`])).rows).toEqual(temporary.rows)
    expect((await client().query(`SELECT marker FROM pg_temp.${quote(RELATION)}`)).rows).toEqual([{ marker: 'untouched' }])
    expect((await client().query(`SELECT pg_temp.${quote(ACQUIRE)}('unused', 'unused') AS result`)).rows).toEqual([{ result: false }])
    expect((await client().query(`SELECT pg_temp.${quote(RELEASE)}('unused', 'unused') AS result`)).rows).toEqual([{ result: false }])
  })

  it('refuses autocommit down before every DROP without altering objects, rows or timeout settings', async () => {
    await install(selected)
    const before = await catalog(selected)
    const sentinels = await sentinelRows()
    const beforeTimeouts = await timeouts()
    await expect(migrate(client(), down)).rejects.toMatchObject({ code: DOWN_BLOCKED })
    expectNoDrop()
    expect(await timeouts()).toEqual(beforeTimeouts)
    expect(await catalog(selected)).toEqual(before)
    expect(await sentinelRows()).toEqual(sentinels)
  })

  it.each(['REPEATABLE READ', 'SERIALIZABLE'])('refuses %s after an earlier snapshot instead of changing caller isolation or dropping objects', async (isolation) => {
    await install(selected)
    const before = await catalog(selected)
    await client().query(`BEGIN ISOLATION LEVEL ${isolation}`)
    try {
      await client().query(`SELECT COUNT(*) FROM ${owned(selected, RELATION)}`)
      const beforeTimeouts = await customTimeouts()
      await expect(migrate(client(), down)).rejects.toMatchObject({ code: DOWN_BLOCKED })
      expectNoDrop()
      expect((await client().query("SELECT pg_catalog.current_setting('transaction_isolation') AS isolation")).rows).toEqual([{ isolation: isolation.toLowerCase() }])
      expect(await timeouts()).toEqual(beforeTimeouts)
      expect(await catalog(selected)).toEqual(before)
    } finally {
      await client().query('ROLLBACK')
    }
    expect(await catalog(selected)).toEqual(before)
  })

  it.each(['live owner', 'disconnected owner'])('refuses any committed row from a %s and restores healthy-refusal timeouts before caller rollback', async (ownerState) => {
    await install(selected)
    const owner = await connect()
    await pin(owner, [selected, 'pg_catalog'])
    expect(await helper(ACQUIRE, originalToken, sessionId, owner)).toBe(true)
    if (ownerState === 'disconnected owner') {
      await owner.end()
      connected.delete(owner)
      clients = clients.filter((connection) => connection !== owner)
    }
    const before = await catalog(selected)
    const rows = await flightRows()
    const sentinels = await sentinelRows()
    await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      const beforeTimeouts = await customTimeouts()
      await expect(migrate(client(), down)).rejects.toMatchObject({ code: DOWN_BLOCKED })
      expectNoDrop()
      expect(await timeouts()).toEqual(beforeTimeouts)
      expect(await catalog(selected)).toEqual(before)
      expect(await flightRows()).toEqual(rows)
    } finally {
      await client().query('ROLLBACK')
    }
    expect(await catalog(selected)).toEqual(before)
    expect(await flightRows()).toEqual(rows)
    expect(await sentinelRows()).toEqual(sentinels)
  })

  it('rolls back up with no residual new objects and exact original parent/challenge objects and rows', async () => {
    const before = await catalog(selected)
    const sentinels = await sentinelRows()
    await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      const beforeTimeouts = await customTimeouts()
      await migrate(client(), up)
      expect(await timeouts()).toEqual(beforeTimeouts)
      expect((await catalog(selected)).relations.filter((entry) => entry.name === RELATION)).toHaveLength(1)
    } finally {
      await client().query('ROLLBACK')
    }
    expect(await catalog(selected)).toEqual(before)
    expect(await sentinelRows()).toEqual(sentinels)
  })

  it('rolls back empty READ COMMITTED down preserving exact OIDs and definitions while the caller retains AX until rollback', async () => {
    await install(selected)
    await install(unrelated)
    await pin(client(), [selected, unrelated, 'public', 'pg_catalog'])
    const before = await catalog(selected)
    const peerBefore = await catalog(unrelated)
    const sentinels = await sentinelRows()
    const relation = before.relations.find((entry) => entry.name === RELATION)!
    await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      await client().query(`SELECT COUNT(*) FROM ${owned(selected, RELATION)}`)
      const beforeTimeouts = await customTimeouts()
      await migrate(client(), down)
      expect(await timeouts()).toEqual(beforeTimeouts)
      const removed = await catalog(selected)
      expect(removed.relations.filter((entry) => entry.name === RELATION)).toEqual([])
      expect(removed.functions.filter((entry) => [ACQUIRE, RELEASE, GUARD].includes(entry.name))).toEqual([])
      const held = await client().query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_locks
           WHERE pid = pg_catalog.pg_backend_pid() AND relation = $1::oid
             AND mode = 'AccessExclusiveLock' AND granted
        ) AS held
      `, [relation.oid])
      expect(held.rows).toEqual([{ held: true }])
      expect(await catalog(unrelated)).toEqual(peerBefore)
      expect(await sentinelRows()).toEqual(sentinels)
    } finally {
      await client().query('ROLLBACK')
    }
    expect(await catalog(selected)).toEqual(before)
    expect(await catalog(unrelated)).toEqual(peerBefore)
    expect(await sentinelRows()).toEqual(sentinels)
    expect(await helper(ACQUIRE)).toBe(true)
    expect(await helper(RELEASE)).toBe(true)
  })
})

const OBSERVATION_BUDGET_MS = 2500

type ObservedResult<Value> =
  | { status: 'fulfilled'; value: Value }
  | { status: 'rejected'; code: string }

type ObservedOperation<Value> = {
  pending: () => boolean
  done: Promise<ObservedResult<Value>>
}

type QueryEvent = {
  phase: 'before_error' | 'after_error'
  command: 'BEGIN' | 'COMMIT' | 'ROLLBACK' | 'LOCK' | 'DROP' | 'SET_CONFIG' | 'SELECT' | 'OTHER'
  status: 'dispatched' | 'acknowledged' | 'rejected'
  code: string
}

type BlockingEvidence = {
  waiter_pid: number
  blocker_pid: number
  lock_type: string
  waiter_mode: string
  blocker_mode: string
  waiter_status: string
  blocker_status: string
  wait_event_type: string
  wait_event: string
  relation_status: 'selected_relation' | 'null_relation_transaction_id'
  pid_link_status: 'confirmed'
}

function sqlState(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'NO_SQLSTATE'
  const code = error.code
  if (code === DOWN_BLOCKED || code === SCHEMA_BLOCKED) return code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'NO_SQLSTATE'
}

function observe<Value>(operation: Promise<Value>): ObservedOperation<Value> {
  let pending = true
  const done = operation.then<ObservedResult<Value>, ObservedResult<Value>>(
    (value) => {
      pending = false
      return { status: 'fulfilled', value }
    },
    (error: unknown) => {
      pending = false
      return { status: 'rejected', code: sqlState(error) }
    },
  )
  return { pending: () => pending, done }
}

function emitPhysicalEvidence(evidence: Record<string, string | number>): void {
  console.info('WPC_MIGRATION_PG_EVIDENCE', JSON.stringify(evidence))
}

async function backendPid(connection: PgClient): Promise<number> {
  const result = await connection.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]!.pid).toBeGreaterThan(0)
  return result.rows[0]!.pid
}

async function preparePhysicalRace() {
  const original = await catalog(selected)
  await install(selected)
  await install(unrelated)
  await pin(client(), [selected, unrelated, 'public', 'pg_catalog'])
  const installed = await catalog(selected)
  const peer = await catalog(unrelated)
  const sentinels = await sentinelRows()
  const writer = await connect()
  await pin(writer, [selected, 'pg_catalog'])
  const observer = await connect()
  await observer.query("SET statement_timeout = '1s'")
  const removerPid = await backendPid(client())
  const writerPid = await backendPid(writer)
  const observerPid = await backendPid(observer)
  expect(new Set([removerPid, writerPid, observerPid]).size).toBe(3)
  const target = await observer.query<{ oid: string }>(`
    SELECT relation.oid::text AS oid
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relname = $2
       AND relation.relkind = 'r' AND relation.relpersistence = 'p'
  `, [selected, RELATION])
  expect(target.rows.length).toBe(1)
  emitPhysicalEvidence({
    phase: 'race_participants', status: 'distinct_backends',
    remover_pid: removerPid, writer_pid: writerPid, observer_pid: observerPid,
    backend_count: 3,
  })
  return {
    original, installed, peer, sentinels, writer, observer,
    removerPid, writerPid, observerPid, relationOid: target.rows[0]!.oid,
  }
}

async function expectPhysicalCatalog(
  race: Awaited<ReturnType<typeof preparePhysicalRace>>,
  expected = race.installed,
): Promise<void> {
  expect(JSON.stringify(await catalog(selected)) === JSON.stringify(expected)).toBe(true)
  expect(JSON.stringify(await catalog(unrelated)) === JSON.stringify(race.peer)).toBe(true)
  expect(JSON.stringify(await sentinelRows()) === JSON.stringify(race.sentinels)).toBe(true)
}

async function rowCounts(connection: PgClient): Promise<{ row_count: number; original_owner_count: number }> {
  const result = await connection.query<{ row_count: number; original_owner_count: number }>(`
    SELECT COUNT(*)::integer AS row_count,
           COUNT(*) FILTER (
             WHERE session_id = $1 AND owner_token = $2 AND state = 'active'
           )::integer AS original_owner_count
      FROM ${owned(selected, RELATION)}
  `, [sessionId, originalToken])
  expect(result.rows).toHaveLength(1)
  return result.rows[0]!
}

async function waitForPhysicalBlock(
  observer: PgClient,
  waiterPid: number,
  blockerPid: number,
  relationOid: string,
  phase: string,
  operation: { pending: () => boolean },
  expected: { lockType: 'relation' | 'transactionid'; waiterMode: string; blockerMode: string },
): Promise<BlockingEvidence> {
  const deadline = Date.now() + OBSERVATION_BUDGET_MS
  while (Date.now() < deadline) {
    const result = await observer.query<BlockingEvidence>(`
      SELECT DISTINCT waiting.pid AS waiter_pid, holding.pid AS blocker_pid,
             waiting.locktype::text AS lock_type, waiting.mode::text AS waiter_mode,
             holding.mode::text AS blocker_mode,
             waiter.state::text AS waiter_status, blocker.state::text AS blocker_status,
             waiter.wait_event_type::text AS wait_event_type,
             waiter.wait_event::text AS wait_event,
             CASE WHEN waiting.locktype = 'transactionid'
               THEN 'null_relation_transaction_id' ELSE 'selected_relation' END AS relation_status,
             'confirmed'::text AS pid_link_status
        FROM pg_catalog.pg_locks waiting
        JOIN pg_catalog.pg_locks holding ON holding.locktype = waiting.locktype
        JOIN pg_catalog.pg_stat_activity waiter ON waiter.pid = waiting.pid
        JOIN pg_catalog.pg_stat_activity blocker ON blocker.pid = holding.pid
       WHERE waiting.pid = $1 AND holding.pid = $2
         AND NOT waiting.granted AND holding.granted
         AND waiting.locktype = $4 AND waiting.mode = $5 AND holding.mode = $6
         AND waiter.state = 'active' AND waiter.wait_event_type = 'Lock'
         AND pg_catalog.pg_blocking_pids(waiting.pid) @> ARRAY[$2::integer]
         AND (
           (waiting.locktype = 'relation' AND waiting.relation = $3::oid
             AND holding.relation = waiting.relation
             AND holding.database IS NOT DISTINCT FROM waiting.database)
           OR
           (waiting.locktype = 'transactionid' AND waiting.relation IS NULL
             AND holding.transactionid = waiting.transactionid)
         )
    `, [waiterPid, blockerPid, relationOid, expected.lockType, expected.waiterMode, expected.blockerMode])
    if (result.rows.length > 0) {
      expect(result.rows).toHaveLength(1)
      expect(operation.pending()).toBe(true)
      const evidence = result.rows[0]!
      expect(evidence.waiter_pid).toBe(waiterPid)
      expect(evidence.blocker_pid).toBe(blockerPid)
      expect(evidence.lock_type).toBe(expected.lockType)
      expect(evidence.waiter_mode).toBe(expected.waiterMode)
      expect(evidence.blocker_mode).toBe(expected.blockerMode)
      expect(evidence.wait_event).toBe(expected.lockType)
      expect(evidence.blocker_status).toBe('idle in transaction')
      expect(evidence.relation_status).toBe(expected.lockType === 'transactionid' ? 'null_relation_transaction_id' : 'selected_relation')
      emitPhysicalEvidence({ phase, status: 'blocked', ...evidence })
      return evidence
    }
    if (!operation.pending()) throw new Error('operation settled before required physical blocker evidence')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('physical blocker observation budget exhausted')
}

async function expectGrantedAx(observer: PgClient, ownerPid: number, relationOid: string, phase: string): Promise<void> {
  const result = await observer.query<{ lock_count: number }>(`
    SELECT COUNT(*)::integer AS lock_count FROM pg_catalog.pg_locks
     WHERE pid = $1 AND relation = $2::oid AND locktype = 'relation'
       AND mode = 'AccessExclusiveLock' AND granted
  `, [ownerPid, relationOid])
  expect(result.rows).toEqual([{ lock_count: 1 }])
  emitPhysicalEvidence({
    phase, status: 'granted', owner_pid: ownerPid,
    mode: 'AccessExclusiveLock', lock_count: 1,
  })
}

function recordPhysicalQueries(connection: PgClient) {
  const events: QueryEvent[] = []
  let failed = false
  const query = async (text: string, values: readonly unknown[] = []) => {
    const verb = text.trimStart().split(/\s+/, 1)[0]!.toUpperCase()
    let command: QueryEvent['command'] = 'OTHER'
    if (verb === 'BEGIN' || verb === 'COMMIT' || verb === 'ROLLBACK' || verb === 'LOCK' || verb === 'DROP') {
      command = verb
    } else if (verb === 'SELECT') {
      command = /\bset_config\s*\(/i.test(text) ? 'SET_CONFIG' : 'SELECT'
    }
    const event: QueryEvent = {
      phase: failed ? 'after_error' : 'before_error', command, status: 'dispatched', code: 'NONE',
    }
    events.push(event)
    try {
      const result = await connection.query(text, [...values])
      event.status = 'acknowledged'
      return result
    } catch (error) {
      event.status = 'rejected'
      event.code = sqlState(error)
      failed = true
      throw error
    }
  }
  return { query, events }
}

async function recordedDown(recording: ReturnType<typeof recordPhysicalQueries>): Promise<void> {
  const database = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: {
        connect: async () => ({ query: recording.query as unknown as PostgresPoolClient['query'], release: () => undefined }),
        end: async () => undefined,
      },
    }),
  })
  try {
    await down(database)
  } finally {
    await database.destroy()
  }
}

async function expectAbortedBackend(observer: PgClient, targetPid: number, phase: string): Promise<void> {
  const deadline = Date.now() + OBSERVATION_BUDGET_MS
  while (Date.now() < deadline) {
    const result = await observer.query<{ status: string }>(`
      SELECT state::text AS status FROM pg_catalog.pg_stat_activity WHERE pid = $1
    `, [targetPid])
    if (result.rows[0]?.status === 'idle in transaction (aborted)') {
      emitPhysicalEvidence({ phase, status: 'idle_in_transaction_aborted', backend_pid: targetPid })
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('aborted backend observation budget exhausted')
}

function expectOnlyRollbackAfterError(recording: ReturnType<typeof recordPhysicalQueries>, code: string): void {
  expect(recording.events.filter((event) => event.status === 'rejected').map((event) => event.code)).toEqual([code])
  expect(recording.events.filter((event) => event.phase === 'after_error')).toEqual([
    { phase: 'after_error', command: 'ROLLBACK', status: 'acknowledged', code: 'NONE' },
  ])
  emitPhysicalEvidence({
    phase: 'abort_cleanup', status: 'rollback_only', sqlstate: code,
    rejected_query_count: 1, post_error_rollback_count: 1, post_error_other_query_count: 0,
  })
}

describe('security action session flight migration: stage 2 physical schedules', () => {
  it('sees a writer COMMIT only after the blocked AX is granted and refuses down using a fresh row snapshot', async () => {
    const race = await preparePhysicalRace()
    let removal: ObservedOperation<void> | undefined
    try {
      await race.writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      expect(await helper(ACQUIRE, originalToken, sessionId, race.writer)).toBe(true)
      expect(await rowCounts(race.writer)).toEqual({ row_count: 1, original_owner_count: 1 })
      expect(await rowCounts(race.observer)).toEqual({ row_count: 0, original_owner_count: 0 })
      await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const beforeTimeouts = await customTimeouts()
      expect(await rowCounts(client())).toEqual({ row_count: 0, original_owner_count: 0 })
      removal = observe(migrate(client(), down))
      await waitForPhysicalBlock(race.observer, race.removerPid, race.writerPid, race.relationOid,
        'writer_before_removal_writer_uncommitted', removal,
        { lockType: 'relation', waiterMode: 'AccessExclusiveLock', blockerMode: 'RowExclusiveLock' })
      await race.writer.query('COMMIT')
      emitPhysicalEvidence({ phase: 'writer_before_removal', status: 'writer_commit_acknowledged', writer_pid: race.writerPid })
      expect(await removal.done).toEqual({ status: 'rejected', code: DOWN_BLOCKED })
      expectNoDrop()
      expect(await timeouts()).toEqual(beforeTimeouts)
      await expectGrantedAx(race.observer, race.removerPid, race.relationOid, 'refusal_after_writer_commit')
      expect(await rowCounts(client())).toEqual({ row_count: 1, original_owner_count: 1 })
      await client().query('ROLLBACK')
      expect(await rowCounts(race.observer)).toEqual({ row_count: 1, original_owner_count: 1 })
      await expectPhysicalCatalog(race)
      emitPhysicalEvidence({
        phase: 'writer_before_removal_complete', status: 'refused_row_preserved',
        row_count: 1, original_owner_count: 1,
      })
    } finally {
      try {
        await race.writer.query('ROLLBACK')
      } finally {
        if (removal) await removal.done
        await client().query('ROLLBACK')
      }
    }
  })

  it.each(['COMMIT', 'ROLLBACK'] as const)('holds the real helper writer behind AX through caller %s without an early claim acknowledgement', async (finish) => {
    const race = await preparePhysicalRace()
    let claim: ObservedOperation<boolean> | undefined
    try {
      await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const beforeTimeouts = await customTimeouts()
      await migrate(client(), down)
      expect(await timeouts()).toEqual(beforeTimeouts)
      await expectGrantedAx(race.observer, race.removerPid, race.relationOid, 'empty_down_awaiting_caller_finish')
      await race.writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      claim = observe(helper(ACQUIRE, originalToken, sessionId, race.writer))
      await waitForPhysicalBlock(race.observer, race.writerPid, race.removerPid, race.relationOid,
        'helper_behind_uncommitted_removal', claim,
        { lockType: 'relation', waiterMode: 'RowExclusiveLock', blockerMode: 'AccessExclusiveLock' })
      emitPhysicalEvidence({
        phase: 'helper_before_caller_finish', status: 'pending_no_claim_acknowledgement',
        writer_pid: race.writerPid, claim_acknowledgement_count: 0,
      })
      await client().query(finish)
      const outcome = await claim.done
      if (finish === 'ROLLBACK') {
        expect(outcome).toEqual({ status: 'fulfilled', value: true })
        await race.writer.query('COMMIT')
        expect(await rowCounts(race.observer)).toEqual({ row_count: 1, original_owner_count: 1 })
        await expectPhysicalCatalog(race)
        emitPhysicalEvidence({
          phase: 'helper_after_removal_rollback', status: 'claim_committed_on_restored_relation',
          writer_pid: race.writerPid, row_count: 1, original_owner_count: 1,
        })
      } else {
        expect(outcome.status).toBe('rejected')
        if (outcome.status !== 'rejected') throw new Error('helper unexpectedly acknowledged a claim after removal commit')
        expect(['42P01', '42883']).toContain(outcome.code)
        await race.writer.query('ROLLBACK')
        await expectPhysicalCatalog(race, race.original)
        emitPhysicalEvidence({
          phase: 'helper_after_removal_commit', status: 'missing_object_refusal',
          writer_pid: race.writerPid, sqlstate: outcome.code, claim_acknowledgement_count: 0,
        })
      }
    } finally {
      try {
        await client().query('ROLLBACK')
      } finally {
        if (claim) await claim.done
        await race.writer.query('ROLLBACK')
      }
    }
  })

  it('links a duplicate helper row wait to the owning backend transaction ID even when the waiting relation is NULL', async () => {
    const race = await preparePhysicalRace()
    let competingClaim: ObservedOperation<boolean> | undefined
    try {
      await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
      expect(await helper(ACQUIRE)).toBe(true)
      expect(await rowCounts(race.observer)).toEqual({ row_count: 0, original_owner_count: 0 })
      await race.writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      competingClaim = observe(helper(ACQUIRE, foreignToken, sessionId, race.writer))
      await waitForPhysicalBlock(race.observer, race.writerPid, race.removerPid, race.relationOid,
        'competing_helper_waits_for_owner_transaction', competingClaim,
        { lockType: 'transactionid', waiterMode: 'ShareLock', blockerMode: 'ExclusiveLock' })
      await client().query('COMMIT')
      expect(await competingClaim.done).toEqual({ status: 'fulfilled', value: false })
      await race.writer.query('ROLLBACK')
      expect(await rowCounts(race.observer)).toEqual({ row_count: 1, original_owner_count: 1 })
      await expectPhysicalCatalog(race)
      emitPhysicalEvidence({
        phase: 'competing_helper_after_owner_commit', status: 'foreign_claim_refused_original_preserved',
        waiter_pid: race.writerPid, blocker_pid: race.removerPid,
        row_count: 1, original_owner_count: 1, competing_claim_acknowledgement_count: 0,
      })
    } finally {
      try {
        await client().query('ROLLBACK')
      } finally {
        if (competingClaim) await competingClaim.done
        await race.writer.query('ROLLBACK')
      }
    }
  })

  it('returns actual 55P03 from blocked migration AX and sends only ROLLBACK after the server aborts the transaction', async () => {
    const race = await preparePhysicalRace()
    const recording = recordPhysicalQueries(client())
    const sessionTimeouts = await timeouts()
    let removal: ObservedOperation<void> | undefined
    let callerRolledBack = false
    try {
      await race.writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      expect(await helper(ACQUIRE, originalToken, sessionId, race.writer)).toBe(true)
      await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await customTimeouts()
      removal = observe(recordedDown(recording))
      await waitForPhysicalBlock(race.observer, race.removerPid, race.writerPid, race.relationOid,
        'migration_waiting_for_actual_lock_timeout', removal,
        { lockType: 'relation', waiterMode: 'AccessExclusiveLock', blockerMode: 'RowExclusiveLock' })
      expect(await removal.done).toEqual({ status: 'rejected', code: '55P03' })
      expect(recording.events.filter((event) => event.command === 'DROP')).toEqual([])
      await expectAbortedBackend(race.observer, race.removerPid, 'migration_lock_timeout')
      await recording.query('ROLLBACK')
      callerRolledBack = true
      expectOnlyRollbackAfterError(recording, '55P03')
      expect(await timeouts()).toEqual(sessionTimeouts)
      await race.writer.query('COMMIT')
      expect(await rowCounts(race.observer)).toEqual({ row_count: 1, original_owner_count: 1 })
      await expectPhysicalCatalog(race)
      emitPhysicalEvidence({
        phase: 'migration_lock_timeout_complete', status: 'original_objects_and_writer_row_preserved',
        sqlstate: '55P03', row_count: 1, original_owner_count: 1,
      })
    } finally {
      try {
        await race.writer.query('ROLLBACK')
      } finally {
        if (removal) await removal.done
        if (!callerRolledBack) await recording.query('ROLLBACK')
      }
    }
  })

  it('returns actual 57014 for a bounded helper statement behind AX and rolls back before any setting read or restore', async () => {
    const race = await preparePhysicalRace()
    const recording = recordPhysicalQueries(race.writer)
    const sessionTimeouts = await timeouts(race.writer)
    let claim: ObservedOperation<boolean> | undefined
    let writerRolledBack = false
    try {
      await client().query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await migrate(client(), down)
      await expectGrantedAx(race.observer, race.removerPid, race.relationOid, 'helper_statement_timeout_owner')
      await race.writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await race.writer.query("SELECT pg_catalog.set_config('statement_timeout', '1s', true)")
      claim = observe(recording.query(
        `SELECT ${owned(selected, ACQUIRE)}($1::text, $2::text) AS result`,
        [sessionId, originalToken],
      ).then((result) => {
        expect(result.rows).toHaveLength(1)
        return result.rows[0]!.result as boolean
      }))
      await waitForPhysicalBlock(race.observer, race.writerPid, race.removerPid, race.relationOid,
        'helper_waiting_for_actual_statement_timeout', claim,
        { lockType: 'relation', waiterMode: 'RowExclusiveLock', blockerMode: 'AccessExclusiveLock' })
      expect(await claim.done).toEqual({ status: 'rejected', code: '57014' })
      await expectAbortedBackend(race.observer, race.writerPid, 'helper_statement_timeout')
      await recording.query('ROLLBACK')
      writerRolledBack = true
      expectOnlyRollbackAfterError(recording, '57014')
      expect(await timeouts(race.writer)).toEqual(sessionTimeouts)
      await client().query('ROLLBACK')
      expect(await rowCounts(race.observer)).toEqual({ row_count: 0, original_owner_count: 0 })
      await expectPhysicalCatalog(race)
      emitPhysicalEvidence({
        phase: 'helper_statement_timeout_complete', status: 'no_claim_original_objects_restored',
        sqlstate: '57014', row_count: 0, claim_acknowledgement_count: 0,
      })
    } finally {
      try {
        await client().query('ROLLBACK')
      } finally {
        if (claim) await claim.done
        if (!writerRolledBack) await recording.query('ROLLBACK')
      }
    }
  })
})
