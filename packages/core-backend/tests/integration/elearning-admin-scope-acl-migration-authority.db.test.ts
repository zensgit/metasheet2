import { randomUUID } from 'node:crypto'

import {
  Kysely,
  Migrator,
  PostgresDialect,
  type MigrationProvider,
} from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  down as userOrgsDown,
  up as userOrgsUp,
} from '../../src/db/migrations/zzzz20260114110000_create_user_orgs_table'
import {
  ELEARNING_ADMIN_SCOPES_TABLE,
  ELEARNING_OBJECT_ACL_TABLE,
  down as aclDown,
  up as aclUp,
} from '../../src/db/migrations/zzzz20260826200000_create_elearning_admin_scope_acl'
import {
  assertSafeScratchDatabaseName,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const adminUrl = process.env.DATABASE_URL
const scratchName = `ms2_elacl_${randomUUID().replaceAll('-', '').slice(0, 12)}`
const USER_ORGS_MIGRATION = 'zzzz20260114110000_create_user_orgs_table'
const ACL_MIGRATION = 'zzzz20260826200000_create_elearning_admin_scope_acl'
const MIGRATION_REPLAY_EXCLUDES = [
  '008_plugin_infrastructure.sql',
  '048_create_event_bus_tables.sql',
  '049_create_bpmn_workflow_tables.sql',
  '042a_core_model_views.sql',
  '20250924140000_create_gantt_tables.ts',
  'zzzz20260114110000_create_user_orgs_table.ts',
]
const USER_ORG_FKS = [
  'elearning_admin_scopes_granter_org_fk',
  'elearning_admin_scopes_revoker_org_fk',
  'elearning_admin_scopes_user_org_fk',
  'elearning_object_acl_grantee_org_fk',
  'elearning_object_acl_granter_org_fk',
  'elearning_object_acl_revoker_org_fk',
]

let adminPool: Pool | undefined
let scratchUrl: string
let sequence = 0

type Harness = {
  db: Kysely<unknown>
  migrator: Migrator
  pool: Pool
  schema: string
  close(): Promise<void>
}

function databaseUrl(base: string, name: string): string {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

function exactExcludeProvider(): MigrationProvider {
  const excluded = new Set(MIGRATION_REPLAY_EXCLUDES.map((name) => (
    name.replace(/\.(sql|ts|js|mjs|mts)$/i, '')
  )))
  const migrations = {
    [USER_ORGS_MIGRATION]: { up: userOrgsUp, down: userOrgsDown },
    [ACL_MIGRATION]: { up: aclUp, down: aclDown },
  }
  const selected = Object.fromEntries(
    Object.entries(migrations).filter(([name]) => !excluded.has(name)),
  )
  if (selected[USER_ORGS_MIGRATION]) {
    throw new Error('exact exclude unexpectedly retained the user_orgs migration')
  }
  if (!selected[ACL_MIGRATION]) {
    throw new Error('exact exclude omitted the e-learning ACL migration')
  }
  return {
    async getMigrations() {
      return selected
    },
  }
}

async function createPrerequisites(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE directory_integrations (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      provider text NOT NULL,
      UNIQUE (id, org_id),
      UNIQUE (id, provider)
    );
    CREATE TABLE directory_departments (
      id uuid PRIMARY KEY,
      integration_id uuid NOT NULL,
      provider text NOT NULL,
      UNIQUE (id, integration_id, provider)
    );
    CREATE TABLE elearning_courses (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      UNIQUE (org_id, id)
    );
    CREATE TABLE elearning_training_plans (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      UNIQUE (org_id, id)
    )
  `)
}

async function createHarness(tag: string): Promise<Harness> {
  sequence += 1
  const schema = `el_acl_${tag}_${process.pid}_${sequence}`
  const setupPool = new Pool({ connectionString: scratchUrl, max: 1 })
  await setupPool.query(`CREATE SCHEMA "${schema}"`)
  await setupPool.end()

  const pool = new Pool({
    application_name: `elearning-acl-${tag}`,
    connectionString: scratchUrl,
    max: 2,
    options: `-c search_path=${schema}`,
  })
  await createPrerequisites(pool)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const migrator = new Migrator({
    db,
    migrationTableSchema: schema,
    provider: exactExcludeProvider(),
  })
  return {
    db,
    migrator,
    pool,
    schema,
    async close() {
      await db.destroy()
      const cleanup = new Pool({ connectionString: scratchUrl, max: 1 })
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await cleanup.end()
      }
    },
  }
}

async function expectCanonicalUserOrgs(pool: Pool): Promise<void> {
  const columns = await pool.query(`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'user_orgs'
     ORDER BY ordinal_position
  `)
  expect(columns.rows).toEqual([
    { column_name: 'user_id', data_type: 'text', is_nullable: 'NO' },
    { column_name: 'org_id', data_type: 'text', is_nullable: 'NO' },
    { column_name: 'is_active', data_type: 'boolean', is_nullable: 'NO' },
    {
      column_name: 'created_at',
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
    },
  ])
  const authority = await pool.query(`
    SELECT
      ARRAY(
        SELECT attribute_info.attname::text
          FROM unnest(constraint_info.conkey) WITH ORDINALITY
            AS key_column(attnum, ordinality)
          JOIN pg_attribute attribute_info
            ON attribute_info.attrelid = constraint_info.conrelid
           AND attribute_info.attnum = key_column.attnum
         ORDER BY key_column.ordinality
      )::text[] AS primary_key,
      to_regclass('idx_user_orgs_org')::text AS org_index
      FROM pg_constraint constraint_info
     WHERE constraint_info.conrelid = 'user_orgs'::regclass
       AND constraint_info.contype = 'p'
  `)
  expect(authority.rows).toEqual([{
    primary_key: ['user_id', 'org_id'],
    org_index: 'idx_user_orgs_org',
  }])
}

function expectMigrationSucceeded(error: unknown): void {
  if (error === undefined) return
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'unknown'
  throw new Error(`unexpected migration failure code=${code}`, { cause: error })
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error(
      'e-learning admin ACL migration authority requires DATABASE_URL; refusing skip-shaped green',
    )
  }
  assertSafeScratchDatabaseName(scratchName)
  adminPool = new Pool({
    application_name: 'elearning-acl-migration-admin',
    connectionString: adminUrl,
    max: 1,
  })
  const collision = await adminPool.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [scratchName],
  )
  if (collision.rows.length !== 0) throw new Error('scratch database name collision')
  await adminPool.query(`CREATE DATABASE "${scratchName}"`)
  scratchUrl = databaseUrl(adminUrl, scratchName)
}, 30_000)

afterAll(async () => {
  if (!adminPool) return
  try {
    const outcome = await dropScratchDatabase(adminPool, scratchName)
    console.info(formatScratchDropOutcome('elearning-admin-acl-migration', outcome))
  } catch (error) {
    console.error(formatScratchDropFailure('elearning-admin-acl-migration', error))
    throw error
  } finally {
    const residue = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [scratchName],
    )
    await adminPool.end()
    if (residue.rows.length !== 0) throw new Error('scratch database remains after teardown')
  }
}, 30_000)

describe('e-learning admin ACL migration user_orgs authority', () => {
  it('applies under the exact replay excludes without user_orgs, replays, rolls down, and reapplies with all FKs', async () => {
    const harness = await createHarness('fresh')
    try {
      const applied = await harness.migrator.migrateToLatest()
      expectMigrationSucceeded(applied.error)
      await expectCanonicalUserOrgs(harness.pool)

      const foreignKeys = await harness.pool.query(`
        SELECT constraint_info.conname
          FROM pg_constraint constraint_info
         WHERE constraint_info.contype = 'f'
           AND constraint_info.confrelid = 'user_orgs'::regclass
         ORDER BY constraint_info.conname
      `)
      expect(foreignKeys.rows.map((row) => row.conname)).toEqual(USER_ORG_FKS)

      const replayed = await harness.migrator.migrateToLatest()
      expectMigrationSucceeded(replayed.error)
      expect(replayed.results ?? []).toEqual([])

      const rolledBack = await harness.migrator.migrateDown()
      expectMigrationSucceeded(rolledBack.error)
      const afterDown = await harness.pool.query(`
        SELECT
          to_regclass('user_orgs')::text AS user_orgs,
          to_regclass('${ELEARNING_ADMIN_SCOPES_TABLE}')::text AS admin_scopes,
          to_regclass('${ELEARNING_OBJECT_ACL_TABLE}')::text AS object_acl
      `)
      expect(afterDown.rows).toEqual([{
        user_orgs: 'user_orgs',
        admin_scopes: null,
        object_acl: null,
      }])

      const reapplied = await harness.migrator.migrateToLatest()
      expectMigrationSucceeded(reapplied.error)
      const restored = await harness.pool.query(`
        SELECT
          to_regclass('${ELEARNING_ADMIN_SCOPES_TABLE}')::text AS admin_scopes,
          to_regclass('${ELEARNING_OBJECT_ACL_TABLE}')::text AS object_acl
      `)
      expect(restored.rows).toEqual([{
        admin_scopes: ELEARNING_ADMIN_SCOPES_TABLE,
        object_acl: ELEARNING_OBJECT_ACL_TABLE,
      }])
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('keeps the canonical existing user_orgs table and its data idempotently', async () => {
    const harness = await createHarness('existing')
    try {
      await harness.pool.query(`
        CREATE TABLE users (
          id text PRIMARY KEY,
          is_active boolean NOT NULL DEFAULT true
        )
      `)
      await harness.pool.query(
        `INSERT INTO users (id, is_active) VALUES ('existing-user', true)`,
      )
      await userOrgsUp(harness.db)
      await userOrgsUp(harness.db)

      const applied = await harness.migrator.migrateToLatest()
      expectMigrationSucceeded(applied.error)
      await expectCanonicalUserOrgs(harness.pool)
      const memberships = await harness.pool.query(
        `SELECT user_id, org_id, is_active FROM user_orgs ORDER BY user_id, org_id`,
      )
      expect(memberships.rows).toEqual([{
        user_id: 'existing-user',
        org_id: 'default',
        is_active: true,
      }])
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('fails loud on an incompatible existing user_orgs shape and records no ACL migration', async () => {
    const harness = await createHarness('drift')
    try {
      await harness.pool.query(`
        CREATE TABLE user_orgs (
          user_id text NOT NULL,
          org_id uuid NOT NULL,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, org_id)
        )
      `)
      const migrated = await harness.migrator.migrateToLatest()
      expect(String(migrated.error)).toContain('USER_ORGS_SCHEMA_DRIFT')
      const state = await harness.pool.query(`
        SELECT
          to_regclass('${ELEARNING_ADMIN_SCOPES_TABLE}')::text AS admin_scopes,
          to_regclass('${ELEARNING_OBJECT_ACL_TABLE}')::text AS object_acl,
          EXISTS (
            SELECT 1 FROM kysely_migration WHERE name = $1
          ) AS ledgered
      `, [ACL_MIGRATION])
      expect(state.rows).toEqual([{
        admin_scopes: null,
        object_acl: null,
        ledgered: false,
      }])
    } finally {
      await harness.close()
    }
  }, 30_000)
})
