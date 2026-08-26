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
  ELEARNING_ATTEMPT_EARNED_SCORE_CAP_CHECK,
  ELEARNING_GRADING_RECORD_AUTO_UNIQUE,
  ELEARNING_GRADING_RECORD_EFFECTIVE_INDEX,
  ELEARNING_GRADING_RECORD_KIND_SHAPE_CHECK,
  ELEARNING_GRADING_RECORD_REQUEST_UNIQUE,
  ELEARNING_GRADING_RECORD_SEQUENCE_UNIQUE,
  ELEARNING_MANUAL_GRADING_DOWN_NONEMPTY,
  down,
  up,
} from '../../src/db/migrations/zzzz20260826235930_prepare_elearning_manual_grading'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning manual-grading schema gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const adminPool = new Pool({ connectionString: DATABASE_URL, max: 2 })
const MIGRATION_NAME = 'zzzz20260826235930_prepare_elearning_manual_grading'
let schemaSequence = 0

type Harness = {
  schema: string
  pool: Pool
  migrator: Migrator
  close: () => Promise<void>
}

type AttemptFixture = {
  attemptId: string
  orgId: string
  questionRevisionId: string
}

function safeSchemaName(): string {
  schemaSequence += 1
  return `el_manual_${process.pid}_${Date.now()}_${schemaSequence}`
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
    max: 4,
    options: `-c search_path=${schema}`,
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
    migrator,
    close: async () => {
      await db.destroy()
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    },
  }
}

async function createLegacySchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE elearning_question_revisions (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      CONSTRAINT elearning_question_revisions_org_id_id_uniq UNIQUE (org_id, id)
    )
  `)
  await pool.query(`
    CREATE TABLE elearning_exam_attempts (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      exam_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
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
      deadline_at timestamptz,
      expired_at timestamptz,
      CONSTRAINT elearning_exam_attempts_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_exam_attempts_status_chk
        CHECK (status IN ('started', 'submitted', 'graded', 'expired')),
      CONSTRAINT elearning_exam_attempts_auto_score_nonneg_chk
        CHECK (auto_score IS NULL OR auto_score >= 0),
      CONSTRAINT elearning_exam_attempts_total_score_nonneg_chk
        CHECK (total_score IS NULL OR total_score >= 0),
      CONSTRAINT elearning_exam_attempts_score_order_chk
        CHECK (auto_score IS NULL OR total_score IS NULL OR auto_score <= total_score),
      CONSTRAINT elearning_exam_attempts_started_no_grade_chk
        CHECK (
          status <> 'started'
          OR (
            auto_score IS NULL AND total_score IS NULL AND passed IS NULL
            AND submitted_at IS NULL AND graded_at IS NULL
          )
        ),
      CONSTRAINT elearning_exam_attempts_submitted_expired_frozen_chk
        CHECK (
          status NOT IN ('submitted', 'expired')
          OR (
            answers IS NOT NULL AND submitted_at IS NOT NULL
            AND auto_score IS NULL AND total_score IS NULL
            AND passed IS NULL AND graded_at IS NULL
          )
        ),
      CONSTRAINT elearning_exam_attempts_graded_complete_chk
        CHECK (
          status <> 'graded'
          OR (
            answers IS NOT NULL AND auto_score IS NOT NULL
            AND total_score IS NOT NULL AND passed IS NOT NULL
            AND submitted_at IS NOT NULL AND graded_at IS NOT NULL
          )
        ),
      CONSTRAINT elearning_exam_attempts_deadline_chk
        CHECK (deadline_at IS NULL OR deadline_at > started_at),
      CONSTRAINT elearning_exam_attempts_expiry_state_chk
        CHECK (
          (expired_at IS NULL AND status <> 'expired')
          OR (
            expired_at IS NOT NULL AND deadline_at IS NOT NULL
            AND submitted_at IS NOT NULL AND expired_at >= deadline_at
            AND status IN ('expired', 'graded')
          )
        )
    )
  `)
  await pool.query(`
    CREATE TABLE elearning_grading_records (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      attempt_id uuid NOT NULL,
      kind text NOT NULL,
      score numeric NOT NULL,
      max_score numeric NOT NULL,
      details jsonb NOT NULL,
      grader_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_grading_records_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_grading_records_org_attempt_kind_uniq
        UNIQUE (org_id, attempt_id, kind),
      CONSTRAINT elearning_grading_records_kind_chk CHECK (kind IN ('auto')),
      CONSTRAINT elearning_grading_records_score_nonneg_chk CHECK (score >= 0),
      CONSTRAINT elearning_grading_records_max_score_nonneg_chk CHECK (max_score >= 0),
      CONSTRAINT elearning_grading_records_score_order_chk CHECK (score <= max_score),
      CONSTRAINT elearning_grading_records_details_chk
        CHECK (jsonb_typeof(details) = 'object'),
      CONSTRAINT elearning_grading_records_attempt_fk
        FOREIGN KEY (org_id, attempt_id)
        REFERENCES elearning_exam_attempts (org_id, id)
        ON DELETE RESTRICT
    )
  `)
  await pool.query(`
    CREATE OR REPLACE FUNCTION elearning_exam_attempts_state_guard()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'started' THEN
          RAISE EXCEPTION 'elearning_exam_attempts must be inserted as started';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'graded' THEN
          RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be deleted';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status = 'graded' THEN
        RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be updated';
      END IF;
      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status = 'started' AND NEW.status IN ('submitted', 'expired') THEN
          RETURN NEW;
        END IF;
        IF OLD.status IN ('submitted', 'expired') AND NEW.status = 'graded' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'illegal status transition';
      END IF;
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
    CREATE OR REPLACE FUNCTION elearning_grading_records_deny_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'elearning_grading_records is append-only';
    END
    $fn$
  `)
  await pool.query(`
    CREATE TRIGGER trg_elearning_grading_records_deny_mutation
    BEFORE UPDATE OR DELETE ON elearning_grading_records
    FOR EACH ROW EXECUTE FUNCTION elearning_grading_records_deny_mutation()
  `)
}

async function seedStartedAttempt(
  pool: Pool,
  orgId = `org-${randomUUID()}`,
): Promise<AttemptFixture> {
  const fixture = {
    attemptId: randomUUID(),
    orgId,
    questionRevisionId: randomUUID(),
  }
  await pool.query(
    `INSERT INTO elearning_question_revisions (id, org_id) VALUES ($1, $2)`,
    [fixture.questionRevisionId, fixture.orgId],
  )
  await pool.query(
    `INSERT INTO elearning_exam_attempts (
       id, org_id, exam_id, course_version_id, course_version_item_id,
       user_id, attempt_no, paper_snapshot, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, '{}'::jsonb, 'started')`,
    [
      fixture.attemptId,
      fixture.orgId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      `user-${randomUUID()}`,
    ],
  )
  return fixture
}

async function gradeLegacyObjective(
  pool: Pool,
  fixture: AttemptFixture,
  total = 4,
): Promise<void> {
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'submitted', answers = '{}'::jsonb, submitted_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2`,
    [fixture.orgId, fixture.attemptId],
  )
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'graded', auto_score = 4, total_score = $3,
            passed = true, graded_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2`,
    [fixture.orgId, fixture.attemptId, total],
  )
  await pool.query(
    `INSERT INTO elearning_grading_records (
       id, org_id, attempt_id, kind, score, max_score, details, grader_id
     ) VALUES ($1, $2, $3, 'auto', 4, 10, '{}'::jsonb, 'system')`,
    [randomUUID(), fixture.orgId, fixture.attemptId],
  )
}

afterAll(async () => {
  await adminPool.end()
})

describe('e-learning manual-grading migration (isolated real PostgreSQL schema)', () => {
  it('preserves objective grades and installs the manual ledger invariants', async () => {
    const harness = await createHarness()
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedStartedAttempt(harness.pool)
      await gradeLegacyObjective(harness.pool, fixture)

      const migrated = await harness.migrator.migrateToLatest()
      expect(migrated.error).toBeUndefined()

      const attempt = await harness.pool.query<{
        manual_score: string
        regraded_at: Date | null
        status: string
        total_score: string
      }>(
        `SELECT manual_score, regraded_at, status, total_score
           FROM elearning_exam_attempts WHERE id = $1`,
        [fixture.attemptId],
      )
      expect(attempt.rows).toEqual([
        {
          manual_score: '0',
          regraded_at: null,
          status: 'graded',
          total_score: '4',
        },
      ])

      const indexes = await harness.pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
      )
      const names = indexes.rows.map((row) => row.indexname)
      expect(names).toContain(ELEARNING_GRADING_RECORD_AUTO_UNIQUE)
      expect(names).toContain(ELEARNING_GRADING_RECORD_REQUEST_UNIQUE)
      expect(names).toContain(ELEARNING_GRADING_RECORD_EFFECTIVE_INDEX)

      await expect(
        harness.pool.query(
          `UPDATE elearning_exam_attempts SET total_score = total_score WHERE id = $1`,
          [fixture.attemptId],
        ),
      ).rejects.toThrow('graded rows require a changed grade outcome')
      await expect(
        harness.pool.query(
          `UPDATE elearning_grading_records SET score = score WHERE attempt_id = $1`,
          [fixture.attemptId],
        ),
      ).rejects.toThrow('append-only')
    } finally {
      await harness.close()
    }
  })

  it('enforces same-org per-question append-only manual grades and regrades', async () => {
    const harness = await createHarness()
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedStartedAttempt(harness.pool)
      const migrated = await harness.migrator.migrateToLatest()
      expect(migrated.error).toBeUndefined()

      await harness.pool.query(
        `UPDATE elearning_exam_attempts
            SET status = 'awaiting_manual', answers = '{"answer":["text"]}'::jsonb,
                auto_score = 2, submitted_at = clock_timestamp()
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.attemptId],
      )
      await harness.pool.query(
        `INSERT INTO elearning_grading_records (
           id, org_id, attempt_id, kind, score, max_score, details, grader_id
         ) VALUES ($1, $2, $3, 'auto', 2, 10, '{}'::jsonb, 'system')`,
        [randomUUID(), fixture.orgId, fixture.attemptId],
      )

      const requestId = randomUUID()
      await harness.pool.query(
        `INSERT INTO elearning_grading_records (
           id, org_id, attempt_id, kind, question_revision_id, request_id, seq,
           score, max_score, details, grader_id
         ) VALUES ($1, $2, $3, 'manual', $4, $5, 2, 3, 8, '{}'::jsonb, 'grader')`,
        [
          randomUUID(),
          fixture.orgId,
          fixture.attemptId,
          fixture.questionRevisionId,
          requestId,
        ],
      )

      await expect(
        harness.pool.query(
          `INSERT INTO elearning_grading_records (
             id, org_id, attempt_id, kind, question_revision_id, request_id, seq,
             score, max_score, details, grader_id
           ) VALUES ($1, $2, $3, 'regrade', $4, $5, 3, 4, 8, '{}'::jsonb, 'grader')`,
          [
            randomUUID(),
            fixture.orgId,
            fixture.attemptId,
            fixture.questionRevisionId,
            requestId,
          ],
        ),
      ).rejects.toMatchObject({
        constraint: ELEARNING_GRADING_RECORD_REQUEST_UNIQUE,
      })

      await expect(
        harness.pool.query(
          `INSERT INTO elearning_grading_records (
             id, org_id, attempt_id, kind, question_revision_id, request_id, seq,
             score, max_score, details, grader_id
           ) VALUES ($1, $2, $3, 'regrade', $4, $5, 2, 4, 8, '{}'::jsonb, 'grader')`,
          [
            randomUUID(),
            fixture.orgId,
            fixture.attemptId,
            fixture.questionRevisionId,
            randomUUID(),
          ],
        ),
      ).rejects.toMatchObject({
        constraint: ELEARNING_GRADING_RECORD_SEQUENCE_UNIQUE,
      })

      await expect(
        harness.pool.query(
          `INSERT INTO elearning_grading_records (
             id, org_id, attempt_id, kind, question_revision_id, seq,
             score, max_score, details, grader_id
           ) VALUES ($1, $2, $3, 'manual', $4, 3, 1, 8, '{}'::jsonb, 'grader')`,
          [
            randomUUID(),
            fixture.orgId,
            fixture.attemptId,
            fixture.questionRevisionId,
          ],
        ),
      ).rejects.toMatchObject({
        constraint: ELEARNING_GRADING_RECORD_KIND_SHAPE_CHECK,
      })

      const foreignQuestionId = randomUUID()
      await harness.pool.query(
        `INSERT INTO elearning_question_revisions (id, org_id) VALUES ($1, $2)`,
        [foreignQuestionId, `other-${randomUUID()}`],
      )
      await expect(
        harness.pool.query(
          `INSERT INTO elearning_grading_records (
             id, org_id, attempt_id, kind, question_revision_id, request_id, seq,
             score, max_score, details, grader_id
           ) VALUES ($1, $2, $3, 'manual', $4, $5, 3, 1, 8, '{}'::jsonb, 'grader')`,
          [
            randomUUID(),
            fixture.orgId,
            fixture.attemptId,
            foreignQuestionId,
            randomUUID(),
          ],
        ),
      ).rejects.toMatchObject({
        constraint: 'elearning_grading_records_question_revision_fk',
      })

      await expect(
        harness.pool.query(
          `UPDATE elearning_exam_attempts SET auto_score = 3 WHERE id = $1`,
          [fixture.attemptId],
        ),
      ).rejects.toThrow('auto_score is immutable while awaiting manual grade')
      await harness.pool.query(
        `UPDATE elearning_exam_attempts SET manual_score = 9 WHERE id = $1`,
        [fixture.attemptId],
      )
      await expect(
        harness.pool.query(
          `UPDATE elearning_exam_attempts
              SET status = 'graded', total_score = 10, passed = true,
                  graded_at = clock_timestamp()
            WHERE id = $1`,
          [fixture.attemptId],
        ),
      ).rejects.toMatchObject({
        constraint: ELEARNING_ATTEMPT_EARNED_SCORE_CAP_CHECK,
      })
      await harness.pool.query(
        `UPDATE elearning_exam_attempts
            SET manual_score = 3
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.attemptId],
      )
      await harness.pool.query(
        `UPDATE elearning_exam_attempts
            SET status = 'graded', total_score = 10, passed = true,
                graded_at = clock_timestamp() - interval '1 second'
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.attemptId],
      )
      await expect(
        harness.pool.query(
          `UPDATE elearning_exam_attempts SET manual_score = 4 WHERE id = $1`,
          [fixture.attemptId],
        ),
      ).rejects.toThrow('regrade must advance regraded_at')
      await harness.pool.query(
        `INSERT INTO elearning_grading_records (
           id, org_id, attempt_id, kind, question_revision_id, request_id, seq,
           score, max_score, details, grader_id
         ) VALUES ($1, $2, $3, 'regrade', $4, $5, 3, 4, 8, '{}'::jsonb, 'grader')`,
        [
          randomUUID(),
          fixture.orgId,
          fixture.attemptId,
          fixture.questionRevisionId,
          randomUUID(),
        ],
      )
      await harness.pool.query(
        `UPDATE elearning_exam_attempts
            SET manual_score = 4, total_score = 10, regraded_at = clock_timestamp()
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.attemptId],
      )

      const final = await harness.pool.query<{
        manual_score: string
        record_count: number
        status: string
        total_score: string
      }>(
        `SELECT a.manual_score, a.status, a.total_score,
                count(g.id)::int AS record_count
           FROM elearning_exam_attempts a
           JOIN elearning_grading_records g
             ON g.org_id = a.org_id AND g.attempt_id = a.id
          WHERE a.org_id = $1 AND a.id = $2
          GROUP BY a.id`,
        [fixture.orgId, fixture.attemptId],
      )
      expect(final.rows).toEqual([
        {
          manual_score: '4',
          record_count: 3,
          status: 'graded',
          total_score: '10',
        },
      ])

      await expect(
        harness.pool.query(
          `UPDATE elearning_exam_attempts
              SET total_score = 11, regraded_at = clock_timestamp() + interval '1 second'
            WHERE id = $1`,
          [fixture.attemptId],
        ),
      ).rejects.toThrow('graded evidence is immutable')
      await expect(
        harness.pool.query(
          `UPDATE elearning_exam_attempts SET answers = '{}'::jsonb WHERE id = $1`,
          [fixture.attemptId],
        ),
      ).rejects.toThrow('graded evidence is immutable')
      await expect(
        harness.pool.query(
          `DELETE FROM elearning_exam_attempts WHERE id = $1`,
          [fixture.attemptId],
        ),
      ).rejects.toThrow('graded rows cannot be deleted')
      await expect(
        harness.pool.query(
          `DELETE FROM elearning_question_revisions WHERE id = $1`,
          [fixture.questionRevisionId],
        ),
      ).rejects.toMatchObject({
        constraint: 'elearning_grading_records_question_revision_fk',
      })
    } finally {
      await harness.close()
    }
  })

  it('rolls back only objective-compatible rows and restores the legacy model', async () => {
    const harness = await createHarness()
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedStartedAttempt(harness.pool)
      await gradeLegacyObjective(harness.pool, fixture)
      expect((await harness.migrator.migrateToLatest()).error).toBeUndefined()

      const rolledBack = await harness.migrator.migrateDown()
      expect(rolledBack.error).toBeUndefined()

      const columns = await harness.pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name IN ('elearning_exam_attempts', 'elearning_grading_records')`,
      )
      const names = columns.rows.map((row) => row.column_name)
      expect(names).not.toContain('manual_score')
      expect(names).not.toContain('regraded_at')
      expect(names).not.toContain('question_revision_id')
      expect(names).not.toContain('request_id')
      expect(names).not.toContain('seq')

      const statusCheck = await harness.pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'elearning_exam_attempts'::regclass
            AND conname = 'elearning_exam_attempts_status_chk'`,
      )
      expect(statusCheck.rows[0]?.definition).not.toContain('awaiting_manual')
    } finally {
      await harness.close()
    }
  })

  it('fails closed before rollback when manual state exists', async () => {
    const harness = await createHarness()
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedStartedAttempt(harness.pool)
      expect((await harness.migrator.migrateToLatest()).error).toBeUndefined()
      await harness.pool.query(
        `UPDATE elearning_exam_attempts
            SET status = 'awaiting_manual', answers = '{}'::jsonb,
                auto_score = 0, submitted_at = clock_timestamp()
          WHERE id = $1`,
        [fixture.attemptId],
      )

      const rolledBack = await harness.migrator.migrateDown()
      expect(rolledBack.error).toBeInstanceOf(Error)
      expect((rolledBack.error as Error).message).toContain(
        ELEARNING_MANUAL_GRADING_DOWN_NONEMPTY,
      )

      const column = await harness.pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'elearning_exam_attempts'
            AND column_name = 'manual_score'`,
      )
      expect(column.rows).toEqual([{ column_name: 'manual_score' }])
    } finally {
      await harness.close()
    }
  })

  it('preserves legacy objective rows where total_score is the maximum available score', async () => {
    const harness = await createHarness()
    try {
      await createLegacySchema(harness.pool)
      const fixture = await seedStartedAttempt(harness.pool)
      await gradeLegacyObjective(harness.pool, fixture, 5)

      const migrated = await harness.migrator.migrateToLatest()
      expect(migrated.error).toBeUndefined()
      const row = await harness.pool.query<{
        manual_score: string
        total_score: string
      }>(
        `SELECT manual_score, total_score
           FROM elearning_exam_attempts
          WHERE id = $1`,
        [fixture.attemptId],
      )
      expect(row.rows).toEqual([{ manual_score: '0', total_score: '5' }])
    } finally {
      await harness.close()
    }
  })
})
