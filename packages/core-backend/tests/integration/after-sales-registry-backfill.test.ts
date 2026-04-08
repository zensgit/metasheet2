import { createHash } from 'crypto'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import type { Database } from '../../src/db/types'
import { up as backfillAfterSalesRegistry } from '../../src/db/migrations/zzzz20260408160000_backfill_after_sales_plugin_multitable_object_registry'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const migrationLoaders = import.meta.glob('../../src/db/migrations/*.ts')

function stableMetaId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha1')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 24)
  return `${prefix}_${digest}`.slice(0, 50)
}

function createTestDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString }),
    }),
  })
}

function createIsolatedSchemaName(): string {
  return `after_sales_registry_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function withSearchPath(connectionString: string, schemaName: string): string {
  const url = new URL(connectionString)
  const existingOptions = url.searchParams.get('options')
  const schemaOption = `-c search_path=${schemaName}`
  url.searchParams.set('options', existingOptions ? `${existingOptions} ${schemaOption}` : schemaOption)
  return url.toString()
}

async function createSchema(connectionString: string, schemaName: string): Promise<void> {
  const adminPool = new Pool({ connectionString })
  try {
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  } finally {
    await adminPool.end()
  }
}

async function dropSchema(connectionString: string, schemaName: string): Promise<void> {
  const adminPool = new Pool({ connectionString })
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  } finally {
    await adminPool.end()
  }
}

async function migrateTestDb(testDb: Kysely<Database>, schemaName: string): Promise<void> {
  const migrator = new Migrator({
    db: testDb,
    migrationTableSchema: schemaName,
    migrationLockTableSchema: schemaName,
    provider: {
      async getMigrations() {
        const migrations = await Promise.all(
          Object.entries(migrationLoaders).map(async ([filePath, load]) => {
            const migration = await load()
            return [path.basename(filePath, '.ts'), migration] as const
          }),
        )
        return Object.fromEntries(
          migrations
            .filter(([name]) => !name.startsWith('_'))
            .sort(([left], [right]) => left.localeCompare(right)),
        )
      },
    },
  })

  const { error } = await migrator.migrateToLatest()
  if (error) {
    throw error
  }
}

const describeWithDb = dbUrl ? describe : describe.skip

describeWithDb('after-sales registry backfill migration', () => {
  let schemaName = ''
  let testDb: Kysely<Database> | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    schemaName = createIsolatedSchemaName()
    await createSchema(dbUrl as string, schemaName)

    const isolatedDbUrl = withSearchPath(dbUrl as string, schemaName)
    testDb = createTestDb(isolatedDbUrl)
    pool = new Pool({ connectionString: isolatedDbUrl })
    await migrateTestDb(testDb, schemaName)
  })

  afterAll(async () => {
    if (testDb) {
      await testDb.destroy()
    }
    if (pool) {
      await pool.end()
    }
    if (schemaName) {
      await dropSchema(dbUrl as string, schemaName)
    }
  })

  it('backfills registry rows for legacy after-sales installs and skips missing sheets', async () => {
    if (!testDb || !pool) return

    const projectId = 'legacy-tenant:after-sales'
    const existingObjects = ['serviceTicket', 'installedAsset']
    const missingObject = 'followUp'
    const allObjects = [...existingObjects, missingObject]

    await pool.query(`DELETE FROM plugin_multitable_object_registry`)
    await pool.query(`DELETE FROM plugin_after_sales_template_installs`)
    await pool.query(`DELETE FROM meta_sheets`)

    for (const objectId of existingObjects) {
      const sheetId = stableMetaId('sheet', projectId, objectId)
      await pool.query(
        `INSERT INTO meta_sheets (id, base_id, name, description)
         VALUES ($1, $2, $3, $4)`,
        [sheetId, 'base_legacy', objectId, null],
      )
    }

    await pool.query(
      `INSERT INTO plugin_after_sales_template_installs (
         tenant_id, app_id, project_id, template_id, template_version, mode, status,
         created_objects_json, created_views_json, warnings_json, display_name, config_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb)`,
      [
        'legacy-tenant',
        'after-sales',
        projectId,
        'after-sales-default',
        'v1',
        'enable',
        'installed',
        JSON.stringify(allObjects),
        '[]',
        '[]',
        'Legacy After Sales',
        '{}',
      ],
    )

    await backfillAfterSalesRegistry(testDb)
    await backfillAfterSalesRegistry(testDb)

    const result = await pool.query<{
      sheet_id: string
      project_id: string
      object_id: string
      plugin_name: string
    }>(
      `SELECT sheet_id, project_id, object_id, plugin_name
       FROM plugin_multitable_object_registry
       ORDER BY object_id ASC`,
    )

    expect(result.rows).toEqual([
      {
        sheet_id: stableMetaId('sheet', projectId, 'installedAsset'),
        project_id: projectId,
        object_id: 'installedAsset',
        plugin_name: 'plugin-after-sales',
      },
      {
        sheet_id: stableMetaId('sheet', projectId, 'serviceTicket'),
        project_id: projectId,
        object_id: 'serviceTicket',
        plugin_name: 'plugin-after-sales',
      },
    ])
  })
})
