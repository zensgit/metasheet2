import { randomBytes } from 'node:crypto'
import { Kysely, Migrator, PostgresDialect, sql } from 'kysely'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCoreBackendMigrationProvider } from '../../src/db/migration-provider'

const fixtureUrl = process.env.PERMISSION_COMMAND_TEST_DATABASE_URL
if (fixtureUrl) {
  const parsed = new URL(fixtureUrl)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/permission_command_test') {
    throw new Error('Dedicated loopback fixture database required')
  }
}

describe.skipIf(!fixtureUrl)('production migration provider and Kysely transaction', () => {
  const schema = `permission_migrate_${randomBytes(8).toString('hex')}`
  const table = `${schema}.probe`
  const migrationName = '202611170001_authorization_gate_probe'
  const runtimeDir = 'authorization-gate-fixture'
  const contents = `CREATE TABLE ${table} (id integer PRIMARY KEY);`
  let admin: Client
  let db: Kysely<unknown>
  let migrator: Migrator

  beforeAll(async () => {
    admin = new Client({ connectionString: fixtureUrl })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: fixtureUrl }) }) })
    migrator = new Migrator({
      db,
      migrationTableSchema: schema,
      provider: createCoreBackendMigrationProvider({
        runtimeDir,
        excludedNames: [],
        fsImpl: {
          readdir: (async (folder: string) => folder.endsWith(`${runtimeDir}\\migrations`) || folder.endsWith(`${runtimeDir}/migrations`)
            ? [`${migrationName}.sql`] : []) as typeof import('node:fs/promises').readdir,
          readFile: (async () => contents) as typeof import('node:fs/promises').readFile,
        },
      }),
    })
  })

  afterAll(async () => {
    await db?.destroy()
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await admin.end()
    }
  })

  it('refuses migration and ledger writes while an authorization reader holds the world lock', async () => {
    await admin.query('BEGIN')
    try {
      await admin.query('SELECT pg_advisory_xact_lock_shared(20261106, 1)')
      const result = await migrator.migrateToLatest()
      expect(result.error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY' })
      expect(result.results).toEqual([expect.objectContaining({ migrationName, status: 'Error' })])
      expect((await sql<{ relation: string | null }>`SELECT to_regclass(${table}) AS relation`.execute(db)).rows[0].relation).toBeNull()
      expect((await migrator.getMigrations()).find((item) => item.name === migrationName)?.executedAt).toBeUndefined()
    } finally {
      await admin.query('ROLLBACK')
    }

    const retry = await migrator.migrateToLatest()
    expect(retry.error).toBeUndefined()
    expect(retry.results).toEqual([expect.objectContaining({ migrationName, status: 'Success' })])
    expect((await sql<{ relation: string | null }>`SELECT to_regclass(${table}) AS relation`.execute(db)).rows[0].relation).not.toBeNull()
    expect((await migrator.getMigrations()).find((item) => item.name === migrationName)?.executedAt).toBeInstanceOf(Date)
  })
})
