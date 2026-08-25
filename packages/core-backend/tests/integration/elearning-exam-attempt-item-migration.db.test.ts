import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import {
  Kysely,
  Migrator,
  PostgresDialect,
  type MigrationProvider,
} from 'kysely'
import { Pool, type PoolClient } from 'pg'

import {
  ATTEMPT_ITEM_BACKFILL_ABORT,
  ATTEMPT_ITEM_DOWN_NONEMPTY,
  ATTEMPT_ITEM_SCHEMA_CONFLICT,
  ATTEMPTS_ITEM_COLUMN,
  ATTEMPTS_ITEM_FK,
  ATTEMPTS_ITEM_USER_INDEX,
  ITEMS_ORG_VERSION_EXAM_ID_UNIQ,
  down,
  up,
} from '../../src/db/migrations/zzzz20260826130000_scope_elearning_exam_attempts_to_item'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning exam-attempt item migration gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const adminPool = new Pool({ connectionString: DATABASE_URL, max: 2 })
const MIGRATION_NAME = 'zzzz20260826130000_scope_elearning_exam_attempts_to_item'
let schemaSequence = 0

type Harness = {
  schema: string
  pool: Pool
  db: Kysely<unknown>
  migrator: Migrator
  close: () => Promise<void>
}

type LegacyFixture = {
  orgId: string
  versionId: string
  examId: string
  itemId: string
  attemptId: string
}

function safeSchemaName(): string {
  schemaSequence += 1
  return `el_item_mig_${process.pid}_${Date.now()}_${schemaSequence}`
}

function migrationProvider(): MigrationProvider {
  return {
    async getMigrations() {
      return { [MIGRATION_NAME]: { up, down } }
    },
  }
}

async function createHarness(): Promise<Harness> {
  const schema = safeSchemaName()
  await adminPool.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    options: `-c search_path=${schema},public`,
  })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const migrator = new Migrator({
    db,
    migrationTableSchema: schema,
    provider: migrationProvider(),
  })
  return {
    schema,
    pool,
    db,
    migrator,
    close: async () => {
      await db.destroy()
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    },
  }
}

async function createLegacySchema(pool: Pool, withItemColumn = false): Promise<void> {
  await pool.query(`
    CREATE TABLE elearning_course_version_items (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      course_version_id uuid NOT NULL,
      item_type text NOT NULL,
      exam_id uuid
    )
  `)
  await pool.query(`
    CREATE TABLE elearning_exam_attempts (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      exam_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      ${withItemColumn ? 'course_version_item_id uuid,' : ''}
      user_id text NOT NULL,
      attempt_no integer NOT NULL,
      paper_snapshot jsonb NOT NULL,
      answers jsonb,
      auto_score numeric,
      total_score numeric,
      passed boolean,
      status text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      submitted_at timestamptz,
      graded_at timestamptz,
      CONSTRAINT elearning_exam_attempts_attempt_uniq
        UNIQUE (org_id, exam_id, user_id, attempt_no)
    )
  `)
  await pool.query(`
    CREATE FUNCTION elearning_exam_attempts_state_guard()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END
    $fn$
  `)
  await pool.query(`
    CREATE TRIGGER trg_elearning_exam_attempts_state_guard
    BEFORE INSERT OR UPDATE OR DELETE ON elearning_exam_attempts
    FOR EACH ROW EXECUTE FUNCTION elearning_exam_attempts_state_guard()
  `)
  await pool.query(`
    CREATE INDEX idx_elearning_exam_attempts_org_exam_user
      ON elearning_exam_attempts (org_id, exam_id, user_id)
  `)
}

async function seedLegacyAttempt(
  pool: Pool,
  options: { matchCount: 0 | 1 | 2; withItemColumn?: boolean },
): Promise<LegacyFixture> {
  const fixture: LegacyFixture = {
    orgId: `org-${randomUUID()}`,
    versionId: randomUUID(),
    examId: randomUUID(),
    itemId: randomUUID(),
    attemptId: randomUUID(),
  }
  for (let index = 0; index < options.matchCount; index += 1) {
    await pool.query(
      `INSERT INTO elearning_course_version_items
         (id, org_id, course_version_id, item_type, exam_id)
       VALUES ($1, $2, $3, 'exam', $4)`,
      [index === 0 ? fixture.itemId : randomUUID(), fixture.orgId, fixture.versionId, fixture.examId],
    )
  }
  const columns = options.withItemColumn
    ? ', course_version_item_id'
    : ''
  const values = options.withItemColumn ? ', $6' : ''
  const parameters: unknown[] = [
    fixture.attemptId,
    fixture.orgId,
    fixture.examId,
    fixture.versionId,
    `user-${randomUUID()}`,
  ]
  if (options.withItemColumn) parameters.push(fixture.itemId)
  await pool.query(
    `INSERT INTO elearning_exam_attempts
       (id, org_id, exam_id, course_version_id, user_id, attempt_no,
        paper_snapshot, status${columns})
     VALUES ($1, $2, $3, $4, $5, 1, '{}'::jsonb, 'started'${values})`,
    parameters,
  )
  return fixture
}

async function expectTargetNotRecorded(pool: Pool): Promise<void> {
  const ledger = await pool.query<{ name: string }>(
    `SELECT name FROM kysely_migration WHERE name = $1`,
    [MIGRATION_NAME],
  )
  expect(ledger.rows).toEqual([])
}

async function waitForTableLockWaiter(
  observer: PoolClient,
  table: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_locks
          WHERE relation = $1::regclass
            AND NOT granted
       ) AS waiting`,
      [table],
    )
    if (waiting.rows[0]?.waiting === true) return
    await observer.query('SELECT pg_sleep(0.01)')
  }
  throw new Error(`migration never queued a table lock on ${table}`)
}

afterAll(async () => {
  await adminPool.end()
})

describe('e-learning exam-attempt item migration (isolated real PostgreSQL schema)', () => {
  it('runs the complete legacy backfill through Migrator, records ledger, and replays cleanly', async () => {
    const harness = await createHarness()
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedLegacyAttempt(harness.pool, { matchCount: 1 })

      const first = await harness.migrator.migrateToLatest()
      expect(first.error).toBeUndefined()
      expect(first.results?.map((result) => [result.migrationName, result.status])).toEqual([
        [MIGRATION_NAME, 'Success'],
      ])

      const attempt = await harness.pool.query<{ course_version_item_id: string }>(
        `SELECT course_version_item_id
           FROM elearning_exam_attempts
          WHERE id = $1`,
        [fixture.attemptId],
      )
      expect(attempt.rows).toEqual([{ course_version_item_id: fixture.itemId }])

      const column = await harness.pool.query<{ is_nullable: string }>(
        `SELECT is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'elearning_exam_attempts'
            AND column_name = $1`,
        [ATTEMPTS_ITEM_COLUMN],
      )
      expect(column.rows).toEqual([{ is_nullable: 'NO' }])

      const ledger = await harness.pool.query<{ name: string }>(
        `SELECT name FROM kysely_migration WHERE name = $1`,
        [MIGRATION_NAME],
      )
      expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])

      const replay = await harness.migrator.migrateToLatest()
      expect(replay.error).toBeUndefined()
      expect(replay.results).toEqual([])
    } finally {
      await harness.close()
    }
  })

  it('runs an empty rollback through Migrator and removes the item-scope ledger entry', async () => {
    const harness = await createHarness()
    try {
      await createLegacySchema(harness.pool)
      const migrated = await harness.migrator.migrateToLatest()
      expect(migrated.error).toBeUndefined()

      const rolledBack = await harness.migrator.migrateDown()
      expect(rolledBack.error).toBeUndefined()
      expect(rolledBack.results?.map((result) => [result.migrationName, result.status])).toEqual([
        [MIGRATION_NAME, 'Success'],
      ])

      await expectTargetNotRecorded(harness.pool)
      const column = await harness.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'elearning_exam_attempts'
            AND column_name = $1`,
        [ATTEMPTS_ITEM_COLUMN],
      )
      expect(column.rows[0]?.n).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('fails closed before rollback when a migration-owned index definition drifted', async () => {
    const harness = await createHarness()
    try {
      await createLegacySchema(harness.pool)
      const migrated = await harness.migrator.migrateToLatest()
      expect(migrated.error).toBeUndefined()
      await harness.pool.query(`DROP INDEX ${ATTEMPTS_ITEM_USER_INDEX}`)
      await harness.pool.query(`
        CREATE INDEX ${ATTEMPTS_ITEM_USER_INDEX}
          ON elearning_exam_attempts (org_id, user_id)
      `)

      const rolledBack = await harness.migrator.migrateDown()
      expect(String(rolledBack.error)).toContain(ATTEMPT_ITEM_SCHEMA_CONFLICT)
      const ledger = await harness.pool.query<{ name: string }>(
        `SELECT name FROM kysely_migration WHERE name = $1`,
        [MIGRATION_NAME],
      )
      expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])
      const column = await harness.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'elearning_exam_attempts'
            AND column_name = $1`,
        [ATTEMPTS_ITEM_COLUMN],
      )
      expect(column.rows[0]?.n).toBe(1)
    } finally {
      await harness.close()
    }
  })

  for (const matchCount of [0, 2] as const) {
    it(`rolls back complete migration and ledger for ${matchCount === 0 ? 'zero' : 'ambiguous'} legacy matches`, async () => {
      const harness = await createHarness()
      try {
        await createLegacySchema(harness.pool)
        await seedLegacyAttempt(harness.pool, { matchCount })

        const result = await harness.migrator.migrateToLatest()
        expect(String(result.error)).toContain(ATTEMPT_ITEM_BACKFILL_ABORT)
        await expectTargetNotRecorded(harness.pool)

        const column = await harness.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'elearning_exam_attempts'
              AND column_name = $1`,
          [ATTEMPTS_ITEM_COLUMN],
        )
        expect(column.rows[0]?.n).toBe(0)
      } finally {
        await harness.close()
      }
    })
  }

  for (const malformed of [
    'parent-unique',
    'item-fk',
    'item-fk-update',
    'item-index',
  ] as const) {
    it(`fails closed on a same-name malformed ${malformed}`, async () => {
      const harness = await createHarness()
      try {
        await createLegacySchema(harness.pool, true)
        await seedLegacyAttempt(harness.pool, { matchCount: 1, withItemColumn: true })
        if (malformed === 'parent-unique') {
          await harness.pool.query(`
            ALTER TABLE elearning_course_version_items
              ADD CONSTRAINT ${ITEMS_ORG_VERSION_EXAM_ID_UNIQ}
              UNIQUE (org_id, id)
          `)
        }
        if (malformed === 'item-fk') {
          await harness.pool.query(`
            ALTER TABLE elearning_course_version_items
              ADD CONSTRAINT test_items_org_id_id_uniq UNIQUE (org_id, id)
          `)
          await harness.pool.query(`
            ALTER TABLE elearning_exam_attempts
              ADD CONSTRAINT ${ATTEMPTS_ITEM_FK}
              FOREIGN KEY (org_id, course_version_item_id)
              REFERENCES elearning_course_version_items (org_id, id)
              ON DELETE RESTRICT
          `)
        }
        if (malformed === 'item-fk-update') {
          await harness.pool.query(`
            ALTER TABLE elearning_course_version_items
              ADD CONSTRAINT ${ITEMS_ORG_VERSION_EXAM_ID_UNIQ}
              UNIQUE (org_id, course_version_id, exam_id, id)
          `)
          await harness.pool.query(`
            ALTER TABLE elearning_exam_attempts
              ADD CONSTRAINT ${ATTEMPTS_ITEM_FK}
              FOREIGN KEY (org_id, course_version_id, exam_id, course_version_item_id)
              REFERENCES elearning_course_version_items
                (org_id, course_version_id, exam_id, id)
              ON UPDATE CASCADE
              ON DELETE RESTRICT
          `)
        }
        if (malformed === 'item-index') {
          await harness.pool.query(`
            CREATE INDEX ${ATTEMPTS_ITEM_USER_INDEX}
              ON elearning_exam_attempts (org_id, user_id)
          `)
        }

        const result = await harness.migrator.migrateToLatest()
        expect(String(result.error)).toContain(ATTEMPT_ITEM_SCHEMA_CONFLICT)
        await expectTargetNotRecorded(harness.pool)
      } finally {
        await harness.close()
      }
    })
  }

  it('rejects a same-name FK parent from another schema', async () => {
    const harness = await createHarness()
    const shadowSchema = `el_item_shadow_${process.pid}_${Date.now()}_${schemaSequence}`
    try {
      await createLegacySchema(harness.pool, true)
      const fixture = await seedLegacyAttempt(harness.pool, {
        matchCount: 1,
        withItemColumn: true,
      })
      await adminPool.query(`CREATE SCHEMA ${shadowSchema}`)
      await adminPool.query(`
        CREATE TABLE ${shadowSchema}.elearning_course_version_items (
          id uuid PRIMARY KEY,
          org_id text NOT NULL,
          course_version_id uuid NOT NULL,
          item_type text NOT NULL,
          exam_id uuid,
          CONSTRAINT shadow_items_scope_uniq
            UNIQUE (org_id, course_version_id, exam_id, id)
        )
      `)
      await adminPool.query(
        `INSERT INTO ${shadowSchema}.elearning_course_version_items
           (id, org_id, course_version_id, item_type, exam_id)
         VALUES ($1, $2, $3, 'exam', $4)`,
        [fixture.itemId, fixture.orgId, fixture.versionId, fixture.examId],
      )
      await harness.pool.query(`
        ALTER TABLE elearning_exam_attempts
          ADD CONSTRAINT ${ATTEMPTS_ITEM_FK}
          FOREIGN KEY (org_id, course_version_id, exam_id, course_version_item_id)
          REFERENCES ${shadowSchema}.elearning_course_version_items
            (org_id, course_version_id, exam_id, id)
          ON DELETE RESTRICT
      `)

      const result = await harness.migrator.migrateToLatest()
      expect(String(result.error)).toContain(ATTEMPT_ITEM_SCHEMA_CONFLICT)
      await expectTargetNotRecorded(harness.pool)
    } finally {
      await harness.close()
      await adminPool.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`)
    }
  })

  it('freezes item writes before preflight so a concurrent alias makes backfill abort', async () => {
    const harness = await createHarness()
    const holder = await harness.pool.connect()
    const observer = await harness.pool.connect()
    let migration: Promise<Awaited<ReturnType<Migrator['migrateToLatest']>>> | undefined
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedLegacyAttempt(harness.pool, { matchCount: 1 })
      await holder.query('BEGIN')
      await holder.query(
        `INSERT INTO elearning_course_version_items
           (id, org_id, course_version_id, item_type, exam_id)
         VALUES ($1, $2, $3, 'exam', $4)`,
        [randomUUID(), fixture.orgId, fixture.versionId, fixture.examId],
      )

      migration = harness.migrator.migrateToLatest()
      await waitForTableLockWaiter(observer, 'elearning_course_version_items')
      await holder.query('COMMIT')

      const result = await migration
      expect(String(result.error)).toContain(ATTEMPT_ITEM_BACKFILL_ABORT)
      await expectTargetNotRecorded(harness.pool)
    } finally {
      try {
        await holder.query('ROLLBACK')
      } catch {
        // Already committed or connection is closing.
      }
      if (migration) await migration.catch(() => undefined)
      holder.release()
      observer.release()
      await harness.close()
    }
  })

  it('waits behind service item locks before freezing attempts, without a lock-upgrade deadlock', async () => {
    const harness = await createHarness()
    const service = await harness.pool.connect()
    const observer = await harness.pool.connect()
    let migration: Promise<Awaited<ReturnType<Migrator['migrateToLatest']>>> | undefined
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedLegacyAttempt(harness.pool, { matchCount: 1 })
      await service.query('BEGIN')
      await service.query(`SET LOCAL lock_timeout = '2s'`)
      await service.query(
        `SELECT id
           FROM elearning_course_version_items
          WHERE id = $1
          FOR UPDATE`,
        [fixture.itemId],
      )

      migration = harness.migrator.migrateToLatest()
      await waitForTableLockWaiter(observer, 'elearning_course_version_items')

      await service.query(
        `UPDATE elearning_exam_attempts
            SET answers = '{}'::jsonb
          WHERE id = $1`,
        [fixture.attemptId],
      )
      await service.query('COMMIT')

      const result = await migration
      expect(result.error).toBeUndefined()
      const ledger = await harness.pool.query<{ name: string }>(
        `SELECT name FROM kysely_migration WHERE name = $1`,
        [MIGRATION_NAME],
      )
      expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])
    } finally {
      try {
        await service.query('ROLLBACK')
      } catch {
        // Already committed or connection is closing.
      }
      if (migration) await migration.catch(() => undefined)
      service.release()
      observer.release()
      await harness.close()
    }
  })

  it('serializes down before the empty check and refuses a concurrently committed insert', async () => {
    const harness = await createHarness()
    const holder = await harness.pool.connect()
    const observer = await harness.pool.connect()
    let downAttempt: Promise<Awaited<ReturnType<Migrator['migrateDown']>>> | undefined
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedLegacyAttempt(harness.pool, { matchCount: 1 })
      await harness.pool.query('DELETE FROM elearning_exam_attempts WHERE id = $1', [fixture.attemptId])
      const migrated = await harness.migrator.migrateToLatest()
      expect(migrated.error).toBeUndefined()

      await holder.query('BEGIN')
      await holder.query(
        `INSERT INTO elearning_exam_attempts
           (id, org_id, exam_id, course_version_id, course_version_item_id,
            user_id, attempt_no, paper_snapshot, status)
         VALUES ($1, $2, $3, $4, $5, $6, 1, '{}'::jsonb, 'started')`,
        [
          randomUUID(),
          fixture.orgId,
          fixture.examId,
          fixture.versionId,
          fixture.itemId,
          `user-${randomUUID()}`,
        ],
      )

      downAttempt = harness.migrator.migrateDown()
      await waitForTableLockWaiter(observer, 'elearning_course_version_items')
      await holder.query('COMMIT')
      const downResult = await downAttempt
      expect(String(downResult.error)).toContain(ATTEMPT_ITEM_DOWN_NONEMPTY)

      const ledger = await harness.pool.query<{ name: string }>(
        `SELECT name FROM kysely_migration WHERE name = $1`,
        [MIGRATION_NAME],
      )
      expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])

      const column = await harness.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'elearning_exam_attempts'
            AND column_name = $1`,
        [ATTEMPTS_ITEM_COLUMN],
      )
      expect(column.rows[0]?.n).toBe(1)
      const attempts = await harness.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM elearning_exam_attempts`,
      )
      expect(attempts.rows[0]?.n).toBe(1)
    } finally {
      try {
        await holder.query('ROLLBACK')
      } catch {
        // Already committed or connection is closing.
      }
      if (downAttempt) await downAttempt.catch(() => undefined)
      holder.release()
      observer.release()
      await harness.close()
    }
  })

  it('waits behind service item locks before freezing attempts on down, then rejects the new attempt', async () => {
    const harness = await createHarness()
    const service = await harness.pool.connect()
    const observer = await harness.pool.connect()
    let downAttempt: Promise<Awaited<ReturnType<Migrator['migrateDown']>>> | undefined
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedLegacyAttempt(harness.pool, { matchCount: 1 })
      await harness.pool.query('DELETE FROM elearning_exam_attempts WHERE id = $1', [fixture.attemptId])
      const migrated = await harness.migrator.migrateToLatest()
      expect(migrated.error).toBeUndefined()

      await service.query('BEGIN')
      await service.query(`SET LOCAL lock_timeout = '2s'`)
      await service.query(
        `SELECT id
           FROM elearning_course_version_items
          WHERE id = $1
          FOR UPDATE`,
        [fixture.itemId],
      )

      downAttempt = harness.migrator.migrateDown()
      await waitForTableLockWaiter(observer, 'elearning_course_version_items')

      await service.query(
        `INSERT INTO elearning_exam_attempts
           (id, org_id, exam_id, course_version_id, course_version_item_id,
            user_id, attempt_no, paper_snapshot, status)
         VALUES ($1, $2, $3, $4, $5, $6, 1, '{}'::jsonb, 'started')`,
        [
          randomUUID(),
          fixture.orgId,
          fixture.examId,
          fixture.versionId,
          fixture.itemId,
          `user-${randomUUID()}`,
        ],
      )
      await service.query('COMMIT')

      const result = await downAttempt
      expect(String(result.error)).toContain(ATTEMPT_ITEM_DOWN_NONEMPTY)
      const ledger = await harness.pool.query<{ name: string }>(
        `SELECT name FROM kysely_migration WHERE name = $1`,
        [MIGRATION_NAME],
      )
      expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])
      const attempts = await harness.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM elearning_exam_attempts`,
      )
      expect(attempts.rows[0]?.n).toBe(1)
    } finally {
      try {
        await service.query('ROLLBACK')
      } catch {
        // Already committed or connection is closing.
      }
      if (downAttempt) await downAttempt.catch(() => undefined)
      service.release()
      observer.release()
      await harness.close()
    }
  })
})
