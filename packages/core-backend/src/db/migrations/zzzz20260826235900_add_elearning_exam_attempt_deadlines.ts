import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning L3 timed-attempt deadline snapshot.
 *
 * The API remains the correctness boundary: every timed attempt freezes one
 * database-clock deadline, and late save/submit paths synchronously expire and
 * grade the last accepted answers. The plugin job is only an asynchronous
 * materializer for attempts that receive no later learner request.
 *
 * V1 has zero grace seconds. A future non-zero grace policy requires a
 * design-lock amendment and an immutable attempt-time snapshot column.
 */
export const ELEARNING_ATTEMPT_DEADLINE_CHECK =
  'elearning_exam_attempts_deadline_chk'
export const ELEARNING_ATTEMPT_EXPIRY_STATE_CHECK =
  'elearning_exam_attempts_expiry_state_chk'
export const ELEARNING_ATTEMPT_DUE_INDEX =
  'idx_elearning_exam_attempts_started_deadline'
export const ELEARNING_ATTEMPT_DOWN_NONEMPTY =
  'cannot roll back timed attempts while deadline snapshots exist'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE elearning_exam_attempts
      ADD COLUMN deadline_at timestamptz,
      ADD COLUMN expired_at timestamptz
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      ADD CONSTRAINT elearning_exam_attempts_deadline_chk
        CHECK (deadline_at IS NULL OR deadline_at > started_at),
      ADD CONSTRAINT elearning_exam_attempts_expiry_state_chk
        CHECK (
          (
            expired_at IS NULL
            AND status <> 'expired'
          )
          OR
          (
            expired_at IS NOT NULL
            AND deadline_at IS NOT NULL
            AND submitted_at IS NOT NULL
            AND expired_at >= deadline_at
            AND status IN ('expired', 'graded')
          )
        )
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_exam_attempts_started_deadline
      ON elearning_exam_attempts (deadline_at, org_id, id)
      WHERE status = 'started' AND deadline_at IS NOT NULL
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_exam_attempts_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
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

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.exam_id IS DISTINCT FROM OLD.exam_id
         OR NEW.course_version_id IS DISTINCT FROM OLD.course_version_id
         OR NEW.course_version_item_id IS DISTINCT FROM OLD.course_version_item_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
         OR NEW.paper_snapshot IS DISTINCT FROM OLD.paper_snapshot
         OR NEW.started_at IS DISTINCT FROM OLD.started_at
         OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
        RAISE EXCEPTION 'elearning_exam_attempts identity fields are immutable after insert';
      END IF;

      IF OLD.status = 'graded' THEN
        RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be updated';
      END IF;

      IF OLD.expired_at IS NOT NULL
         AND NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
        RAISE EXCEPTION 'elearning_exam_attempts expired_at is immutable once set';
      END IF;

      IF OLD.status IN ('submitted', 'expired') THEN
        IF NEW.answers IS DISTINCT FROM OLD.answers
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
          RAISE EXCEPTION 'elearning_exam_attempts answers and submitted_at are immutable after submit/expire';
        END IF;
      END IF;

      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status = 'started' AND NEW.status IN ('submitted', 'expired') THEN
          RETURN NEW;
        END IF;
        IF OLD.status IN ('submitted', 'expired') AND NEW.status = 'graded' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'elearning_exam_attempts illegal status transition: % -> %', OLD.status, NEW.status;
      END IF;

      RETURN NEW;
    END;
    $fn$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $fn$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM elearning_exam_attempts
         WHERE deadline_at IS NOT NULL
            OR expired_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION ${sql.raw(`'${ELEARNING_ATTEMPT_DOWN_NONEMPTY}'`)};
      END IF;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_exam_attempts_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
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

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.exam_id IS DISTINCT FROM OLD.exam_id
         OR NEW.course_version_id IS DISTINCT FROM OLD.course_version_id
         OR NEW.course_version_item_id IS DISTINCT FROM OLD.course_version_item_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
         OR NEW.paper_snapshot IS DISTINCT FROM OLD.paper_snapshot
         OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION 'elearning_exam_attempts identity fields are immutable after insert';
      END IF;

      IF OLD.status = 'graded' THEN
        RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be updated';
      END IF;

      IF OLD.status IN ('submitted', 'expired') THEN
        IF NEW.answers IS DISTINCT FROM OLD.answers
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
          RAISE EXCEPTION 'elearning_exam_attempts answers and submitted_at are immutable after submit/expire';
        END IF;
      END IF;

      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status = 'started' AND NEW.status IN ('submitted', 'expired') THEN
          RETURN NEW;
        END IF;
        IF OLD.status IN ('submitted', 'expired') AND NEW.status = 'graded' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'elearning_exam_attempts illegal status transition: % -> %', OLD.status, NEW.status;
      END IF;

      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP INDEX IF EXISTS idx_elearning_exam_attempts_started_deadline`.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      DROP CONSTRAINT IF EXISTS elearning_exam_attempts_expiry_state_chk,
      DROP CONSTRAINT IF EXISTS elearning_exam_attempts_deadline_chk,
      DROP COLUMN IF EXISTS expired_at,
      DROP COLUMN IF EXISTS deadline_at
  `.execute(db)
}
