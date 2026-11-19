/**
 * Native strict-login scope cases. This slice does not run them.
 * Without EXPECT_DB=1 the suite is skipped. A skip is not a pass.
 * Fixture SQL is labeled fixture and is not a T3 proof producer.
 * The suite does not call executeAdminLoginGrantEnable or the application pool.
 */
import { randomBytes } from 'node:crypto'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import {
  insertConnectionLoginScope,
  readConnectionLoginScope,
  readStrictLoginInstallation,
  StrictLoginGrantError,
  type StrictLoginGrantCaller,
} from '../../src/auth/strict-login-grant-store'
import {
  down,
  STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE,
  STRICT_LOGIN_GRANT_MIGRATION_NAME,
  up,
} from '../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (process.env.EXPECT_DB === '1' && databaseUrl.length === 0) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for strict-login-grant-scope.db.test.ts')
}

const describeDb = process.env.EXPECT_DB === '1' ? describe : describe.skip
const kept: string[] = []
const CONNECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function quoteSchema(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('STRICT_LOGIN_GRANT_FIXTURE_SCHEMA_REFUSED')
  return `"${name}"`
}

function namesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').filter((item) => item.length > 0)
  throw new Error('STRICT_LOGIN_GRANT_SEARCH_PATH_UNREADABLE')
}

async function assertSearchPath(pool: Pool, schema: string): Promise<void> {
  const seen = await pool.query('SELECT pg_catalog.current_schemas(false) AS names')
  const names = namesOf(seen.rows[0]?.names)
  expect(names).toContain(schema)
  expect(names).toContain('pg_catalog')
  expect(names).not.toContain('public')
}

function callerFor(pool: Pool): StrictLoginGrantCaller {
  return {
    query: async (text, params) => {
      const result = await pool.query(text, params)
      return { rows: result.rows, rowCount: result.rowCount }
    },
  }
}

async function withSchema(fn: (env: { schema: string, pool: Pool, db: Kysely<unknown> }) => Promise<void>): Promise<void> {
  const schema = `slg${randomBytes(8).toString('hex')}`
  kept.push(schema)
  const admin = new Pool({ connectionString: databaseUrl, options: '-c search_path=pg_catalog' })
  try {
    await admin.query(`CREATE SCHEMA ${quoteSchema(schema)}`)
  } finally {
    await admin.end()
  }
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},pg_catalog` })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  try {
    await assertSearchPath(pool, schema)
    await fn({ schema, pool, db })
  } finally {
    await pool.end()
  }
}

async function fixtureParents(pool: Pool): Promise<void> {
  await pool.query(`
    -- fixture parents for strict login grant. Not a T3 proof producer.
    CREATE TABLE kysely_migration (
      name varchar(255) PRIMARY KEY,
      timestamp varchar(255) NOT NULL
    );
    CREATE TABLE directory_integrations (id uuid PRIMARY KEY);
    CREATE TABLE user_external_identities (id uuid PRIMARY KEY);
    CREATE TABLE user_external_identity_evidence (id text PRIMARY KEY);
    CREATE TABLE security_action_challenges (
      id uuid PRIMARY KEY,
      purpose text,
      status text
    );
    CREATE TABLE user_sessions (id text PRIMARY KEY);
    CREATE TABLE user_session_revocations (user_id text PRIMARY KEY);
    CREATE TABLE directory_deprovision_events (id uuid PRIMARY KEY);
    CREATE TABLE directory_sync_runs (id uuid PRIMARY KEY);
  `)
}

async function relationKind(pool: Pool, schema: string, name: string): Promise<string | null> {
  const found = await pool.query(
    `SELECT c.relkind, c.relpersistence
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  )
  const row = found.rows[0]
  if (!row) return null
  return `${String(row.relkind)}:${String(row.relpersistence)}`
}

afterAll(async () => {
  if (kept.length === 0) return
  const admin = new Pool({ connectionString: databaseUrl, options: '-c search_path=pg_catalog' })
  try {
    for (const schema of kept) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`)
    }
  } finally {
    await admin.end()
  }
})

describeDb('strict login grant scope installation', () => {
  it('treats an empty ledger and no owned relation as never-installed', async () => {
    await withSchema(async ({ schema, pool, db }) => {
      await pool.query(`
        -- fixture empty ledger. Not a T3 proof producer.
        CREATE TABLE kysely_migration (
          name varchar(255) PRIMARY KEY,
          timestamp varchar(255) NOT NULL
        )
      `)
      const caller = callerFor(pool)
      await expect(readStrictLoginInstallation(caller)).resolves.toEqual({ installation: 'never-installed' })
      await db.transaction().execute(async (trx) => {
        await sql`select pg_catalog.set_config('search_path', ${`${schema},pg_catalog`}, true)`.execute(trx)
        const seen = await sql<{ names: unknown }>`select pg_catalog.current_schemas(false) as names`.execute(trx)
        const names = namesOf(seen.rows[0]?.names)
        expect(names).not.toContain('public')
        await down(trx)
      })
      await expect(relationKind(pool, schema, 'directory_connection_login_scope')).resolves.toBeNull()
    })
  })

  it('refuses an unlogged or view relation of an owned name and blocks down', async () => {
    await withSchema(async ({ schema, pool, db }) => {
      await pool.query(`
        -- fixture unexpected unlogged relation. Not an installed strict login grant table.
        CREATE TABLE kysely_migration (
          name varchar(255) PRIMARY KEY,
          timestamp varchar(255) NOT NULL
        );
        CREATE UNLOGGED TABLE directory_connection_login_scope (connection_id uuid)
      `)
      await expect(readStrictLoginInstallation(callerFor(pool))).rejects.toMatchObject({
        code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED',
      })
      await expect(db.transaction().execute(async (trx) => {
        await sql`select pg_catalog.set_config('search_path', ${`${schema},pg_catalog`}, true)`.execute(trx)
        await down(trx)
      })).rejects.toMatchObject({ code: STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE })
      await expect(relationKind(pool, schema, 'directory_connection_login_scope')).resolves.toBe('r:u')
    })
    await withSchema(async ({ schema, pool, db }) => {
      await pool.query(`
        -- fixture unexpected view. Not an installed strict login grant table.
        CREATE TABLE kysely_migration (
          name varchar(255) PRIMARY KEY,
          timestamp varchar(255) NOT NULL
        );
        CREATE VIEW directory_connection_login_scope AS SELECT NULL::uuid AS connection_id
      `)
      await expect(readStrictLoginInstallation(callerFor(pool))).rejects.toBeInstanceOf(StrictLoginGrantError)
      await expect(db.transaction().execute(async (trx) => {
        await sql`select pg_catalog.set_config('search_path', ${`${schema},pg_catalog`}, true)`.execute(trx)
        await down(trx)
      })).rejects.toMatchObject({ code: STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE })
      await expect(relationKind(pool, schema, 'directory_connection_login_scope')).resolves.toBe('v:p')
    })
  })

  it('requires the ledger row before installed, then keeps a scope row from down', async () => {
    await withSchema(async ({ schema, pool, db }) => {
      await fixtureParents(pool)
      await db.transaction().execute(async (trx) => {
        await sql`select pg_catalog.set_config('search_path', ${`${schema},pg_catalog`}, true)`.execute(trx)
        const seen = await sql<{ names: unknown }>`select pg_catalog.current_schemas(false) as names`.execute(trx)
        expect(namesOf(seen.rows[0]?.names)).not.toContain('public')
        await up(trx)
      })
      const caller = callerFor(pool)
      await expect(readStrictLoginInstallation(caller)).rejects.toMatchObject({
        code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED',
      })
      await pool.query(
        'INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)',
        [STRICT_LOGIN_GRANT_MIGRATION_NAME, 'fixture'],
      )
      await expect(readStrictLoginInstallation(caller)).resolves.toEqual({ installation: 'installed' })
      await pool.query('INSERT INTO directory_integrations (id) VALUES ($1::uuid)', [CONNECTION_ID])
      const inserted = await insertConnectionLoginScope(caller, { connectionId: CONNECTION_ID, commandId: 'fixture-command' })
      expect(inserted.connectionId).toBe(CONNECTION_ID)
      expect(inserted.commandId).toBe('fixture-command')
      expect(inserted.transitionedAt.length).toBeGreaterThan(0)
      const read = await readConnectionLoginScope(caller, CONNECTION_ID)
      expect(read).toMatchObject({
        installation: 'installed',
        scope: { connectionId: CONNECTION_ID, commandId: 'fixture-command' },
      })
      await expect(insertConnectionLoginScope(caller, {
        connectionId: CONNECTION_ID,
        commandId: 'fixture-command-2',
      })).rejects.toMatchObject({ code: 'STRICT_LOGIN_GRANT_SCOPE_PRESENT' })
      await expect(db.transaction().execute(async (trx) => {
        await sql`select pg_catalog.set_config('search_path', ${`${schema},pg_catalog`}, true)`.execute(trx)
        await down(trx)
      })).rejects.toMatchObject({ code: STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE })
      const remaining = await pool.query('SELECT count(*)::text AS n FROM directory_connection_login_scope')
      expect(remaining.rows[0]?.n).toBe('1')
    })
  })
})
