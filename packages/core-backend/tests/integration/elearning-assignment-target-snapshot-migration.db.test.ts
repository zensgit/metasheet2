import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import {
  Kysely,
  Migrator,
  PostgresDialect,
  type MigrationProvider,
} from 'kysely'
import { Pool } from 'pg'

import {
  ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_CHECK,
  ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_COLUMN,
  ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_DOWN_IN_USE,
  ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_GUARD_FN,
  ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_GUARD_TRIGGER,
  ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_VALID_FN,
  down,
  up,
} from '../../src/db/migrations/zzzz20260826170000_add_elearning_assignment_target_snapshot'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning assignment target-snapshot migration gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const adminPool = new Pool({ connectionString: DATABASE_URL, max: 2 })
const MIGRATION_NAME = 'zzzz20260826170000_add_elearning_assignment_target_snapshot'
let sequence = 0

type Harness = {
  schema: string
  pool: Pool
  migrator: Migrator
  close(): Promise<void>
}

function provider(): MigrationProvider {
  return {
    async getMigrations() {
      return { [MIGRATION_NAME]: { up, down } }
    },
  }
}

async function createHarness(): Promise<Harness> {
  sequence += 1
  const schema = `el_target_snapshot_${process.pid}_${Date.now()}_${sequence}`
  await adminPool.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 3,
    options: `-c search_path=${schema},public`,
  })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const migrator = new Migrator({ db, migrationTableSchema: schema, provider: provider() })
  return {
    schema,
    pool,
    migrator,
    close: async () => {
      await db.destroy()
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    },
  }
}

async function createLegacyTable(pool: Pool, withDriftColumn = false): Promise<void> {
  await pool.query(`
    CREATE TABLE elearning_assignments (
      id uuid PRIMARY KEY,
      org_id text NOT NULL
      ${withDriftColumn ? ', target_snapshot text' : ''}
    )
  `)
}

afterAll(async () => {
  await adminPool.end()
})

describe('e-learning assignment target-snapshot migration (isolated real PostgreSQL)', () => {
  it('adds a nullable legacy-compatible column with executable JSON shape checks', async () => {
    const harness = await createHarness()
    try {
      await createLegacyTable(harness.pool)
      const legacyId = randomUUID()
      await harness.pool.query(
        `INSERT INTO elearning_assignments (id, org_id) VALUES ($1, 'legacy-org')`,
        [legacyId],
      )

      const migrated = await harness.migrator.migrateToLatest()
      expect(migrated.error).toBeUndefined()
      const schema = await harness.pool.query<{
        column_name: string
        is_nullable: string
        constraint_name: string
        function_name: string
        trigger_name: string
      }>(
        `SELECT
           column_info.column_name,
           column_info.is_nullable,
           constraint_info.conname AS constraint_name,
           function_info.proname AS function_name,
           trigger_info.tgname AS trigger_name
         FROM information_schema.columns column_info
         JOIN pg_constraint constraint_info
           ON constraint_info.conrelid = 'elearning_assignments'::regclass
          AND constraint_info.conname = $1
         JOIN pg_proc function_info ON function_info.proname = $2
         JOIN pg_namespace function_namespace
           ON function_namespace.oid = function_info.pronamespace
          AND function_namespace.nspname = current_schema()
         JOIN pg_trigger trigger_info
           ON trigger_info.tgrelid = 'elearning_assignments'::regclass
          AND trigger_info.tgname = $4
          AND NOT trigger_info.tgisinternal
        WHERE column_info.table_schema = current_schema()
          AND column_info.table_name = 'elearning_assignments'
          AND column_info.column_name = $3`,
        [
          ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_CHECK,
          ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_VALID_FN,
          ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_COLUMN,
          ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_GUARD_TRIGGER,
        ],
      )
      expect(schema.rows).toEqual([{
        column_name: ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_COLUMN,
        is_nullable: 'YES',
        constraint_name: ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_CHECK,
        function_name: ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_VALID_FN,
        trigger_name: ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_GUARD_TRIGGER,
      }])
      const legacy = await harness.pool.query(
        `SELECT target_snapshot FROM elearning_assignments WHERE id = $1`,
        [legacyId],
      )
      expect(legacy.rows).toEqual([{ target_snapshot: null }])

      const validSnapshots = [
        [{ subjectType: 'all', subjectRef: null, includeChildren: false }],
        [{
          subjectType: 'department',
          subjectRef: randomUUID(),
          includeChildren: true,
        }],
        [{ subjectType: 'position', subjectRef: 'Engineer', includeChildren: false }],
        [{ subjectType: 'user', subjectRef: 'user-1', includeChildren: false }],
      ]
      for (const snapshot of validSnapshots) {
        await harness.pool.query(
          `INSERT INTO elearning_assignments (id, org_id, target_snapshot)
           VALUES ($1, 'valid-org', $2::jsonb)`,
          [randomUUID(), JSON.stringify(snapshot)],
        )
      }

      const immutableId = randomUUID()
      await harness.pool.query(
        `INSERT INTO elearning_assignments (id, org_id, target_snapshot)
         VALUES ($1, 'immutable-org', $2::jsonb)`,
        [immutableId, JSON.stringify(validSnapshots[0])],
      )
      await expect(harness.pool.query(
        `UPDATE elearning_assignments
            SET target_snapshot = $2::jsonb
          WHERE id = $1`,
        [immutableId, JSON.stringify(validSnapshots[1])],
      )).rejects.toMatchObject({ message: expect.stringContaining('snapshot is immutable') })

      const invalidSnapshots = [
        [],
        {},
        [null],
        [{ subjectType: 'all', subjectRef: null, includeChildren: true }],
        [{ subjectType: 'role', subjectRef: 'manager', includeChildren: false }],
        [{ subjectType: 'department', subjectRef: 'not-a-uuid', includeChildren: false }],
        [{ subjectType: 'position', subjectRef: 'Engineer', includeChildren: true }],
        [{ subjectType: 'user', subjectRef: '', includeChildren: false }],
        [{ subjectType: 'user', subjectRef: 'user-1', includeChildren: false, extra: true }],
      ]
      for (const snapshot of invalidSnapshots) {
        await expect(harness.pool.query(
          `INSERT INTO elearning_assignments (id, org_id, target_snapshot)
           VALUES ($1, 'invalid-org', $2::jsonb)`,
          [randomUUID(), JSON.stringify(snapshot)],
        )).rejects.toMatchObject({ code: '23514' })
      }

      const refused = await harness.migrator.migrateDown()
      expect(String(refused.error)).toContain(
        ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_DOWN_IN_USE,
      )
      const ledgerAfterRefusal = await harness.pool.query(
        `SELECT name FROM kysely_migration WHERE name = $1`,
        [MIGRATION_NAME],
      )
      expect(ledgerAfterRefusal.rows).toEqual([{ name: MIGRATION_NAME }])

      await harness.pool.query(
        `DELETE FROM elearning_assignments WHERE target_snapshot IS NOT NULL`,
      )
      const rolledBack = await harness.migrator.migrateDown()
      expect(rolledBack.error).toBeUndefined()
      const removed = await harness.pool.query<{
        column_exists: boolean
        function_exists: boolean
        guard_function_exists: boolean
        guard_trigger_exists: boolean
      }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'elearning_assignments'
                AND column_name = $1
           ) AS column_exists,
           EXISTS (
             SELECT 1
               FROM pg_proc function_info
               JOIN pg_namespace function_namespace
                 ON function_namespace.oid = function_info.pronamespace
              WHERE function_info.proname = $2
                AND function_namespace.nspname = current_schema()
           ) AS function_exists,
           EXISTS (
             SELECT 1
               FROM pg_proc function_info
               JOIN pg_namespace function_namespace
                 ON function_namespace.oid = function_info.pronamespace
              WHERE function_info.proname = $3
                AND function_namespace.nspname = current_schema()
           ) AS guard_function_exists,
           EXISTS (
             SELECT 1
               FROM pg_trigger trigger_info
              WHERE trigger_info.tgrelid = 'elearning_assignments'::regclass
                AND trigger_info.tgname = $4
                AND NOT trigger_info.tgisinternal
           ) AS guard_trigger_exists`,
        [
          ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_COLUMN,
          ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_VALID_FN,
          ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_GUARD_FN,
          ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_GUARD_TRIGGER,
        ],
      )
      expect(removed.rows).toEqual([{
        column_exists: false,
        function_exists: false,
        guard_function_exists: false,
        guard_trigger_exists: false,
      }])
      const retained = await harness.pool.query(
        `SELECT id, org_id FROM elearning_assignments WHERE id = $1`,
        [legacyId],
      )
      expect(retained.rows).toEqual([{ id: legacyId, org_id: 'legacy-org' }])
    } finally {
      await harness.close()
    }
  })

  it('fails closed on a pre-existing incompatible column and leaves no migration ledger', async () => {
    const harness = await createHarness()
    try {
      await createLegacyTable(harness.pool, true)
      const migrated = await harness.migrator.migrateToLatest()
      expect(String(migrated.error)).toMatch(/target_snapshot|already exists/i)
      const ledger = await harness.pool.query(
        `SELECT name FROM kysely_migration WHERE name = $1`,
        [MIGRATION_NAME],
      )
      expect(ledger.rows).toEqual([])
      const drift = await harness.pool.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'elearning_assignments'
            AND column_name = 'target_snapshot'`,
      )
      expect(drift.rows).toEqual([{ data_type: 'text' }])
    } finally {
      await harness.close()
    }
  })
})
