import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning L3 manual-grading schema preparation.
 *
 * This migration is additive infrastructure only. It does not add short-answer
 * authoring, grading routes, or learner disclosure. Existing objective-only
 * attempts keep manual_score = 0 and retain their current submit/grade path.
 *
 * Manual and regrade records are append-only. The attempt row stores the
 * current aggregate, while seq provides a deterministic per-attempt ordering
 * for reconstructing the effective question grade from the immutable ledger.
 * total_score keeps its existing meaning: maximum available points. Earned
 * points are auto_score + manual_score and may not exceed that maximum.
 * request_id identifies one per-question grade command; a batch UI issues one
 * command per question so replay and payload-conflict handling stay exact.
 *
 * This preparation slice intentionally keeps every graded attempt immutable.
 * The grading-service slice must couple an appended regrade record to the
 * aggregate update before it unlocks graded rows, including aggregate-neutral
 * regrades that only advance regraded_at.
 */
export const ELEARNING_ATTEMPT_MANUAL_STATUS_CHECK =
  'elearning_exam_attempts_status_chk'
export const ELEARNING_ATTEMPT_MANUAL_SCORE_CHECK =
  'elearning_exam_attempts_manual_score_nonneg_chk'
export const ELEARNING_ATTEMPT_AWAITING_MANUAL_CHECK =
  'elearning_exam_attempts_awaiting_manual_chk'
export const ELEARNING_ATTEMPT_EARNED_SCORE_CAP_CHECK =
  'elearning_exam_attempts_earned_score_cap_chk'
export const ELEARNING_ATTEMPT_REGRADE_CHECK =
  'elearning_exam_attempts_regraded_at_chk'
export const ELEARNING_GRADING_RECORD_KIND_CHECK =
  'elearning_grading_records_kind_chk'
export const ELEARNING_GRADING_RECORD_KIND_SHAPE_CHECK =
  'elearning_grading_records_kind_shape_chk'
export const ELEARNING_GRADING_RECORD_SEQUENCE_CHECK =
  'elearning_grading_records_seq_chk'
export const ELEARNING_GRADING_RECORD_SEQUENCE_UNIQUE =
  'elearning_grading_records_org_attempt_seq_uniq'
export const ELEARNING_GRADING_RECORD_QUESTION_FK =
  'elearning_grading_records_question_revision_fk'
export const ELEARNING_GRADING_RECORD_AUTO_UNIQUE =
  'idx_elearning_grading_records_one_auto'
export const ELEARNING_GRADING_RECORD_REQUEST_UNIQUE =
  'idx_elearning_grading_records_request_id'
export const ELEARNING_GRADING_RECORD_EFFECTIVE_INDEX =
  'idx_elearning_grading_records_effective_question'
export const ELEARNING_MANUAL_GRADING_DOWN_NONEMPTY =
  'cannot roll back manual grading while manual state or ledger data exists'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE elearning_exam_attempts
      DROP CONSTRAINT elearning_exam_attempts_status_chk,
      DROP CONSTRAINT elearning_exam_attempts_started_no_grade_chk,
      DROP CONSTRAINT elearning_exam_attempts_submitted_expired_frozen_chk,
      DROP CONSTRAINT elearning_exam_attempts_graded_complete_chk,
      DROP CONSTRAINT elearning_exam_attempts_score_order_chk,
      ADD COLUMN manual_score numeric NOT NULL DEFAULT 0,
      ADD COLUMN regraded_at timestamptz
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      ADD CONSTRAINT elearning_exam_attempts_status_chk
        CHECK (status IN ('started', 'submitted', 'awaiting_manual', 'graded', 'expired')),
      ADD CONSTRAINT elearning_exam_attempts_manual_score_nonneg_chk
        CHECK (manual_score >= 0),
      ADD CONSTRAINT elearning_exam_attempts_started_no_grade_chk
        CHECK (
          status <> 'started'
          OR (
            auto_score IS NULL
            AND manual_score = 0
            AND total_score IS NULL
            AND passed IS NULL
            AND submitted_at IS NULL
            AND graded_at IS NULL
            AND regraded_at IS NULL
          )
        ),
      ADD CONSTRAINT elearning_exam_attempts_submitted_expired_frozen_chk
        CHECK (
          status NOT IN ('submitted', 'expired')
          OR (
            answers IS NOT NULL
            AND submitted_at IS NOT NULL
            AND auto_score IS NULL
            AND manual_score = 0
            AND total_score IS NULL
            AND passed IS NULL
            AND graded_at IS NULL
            AND regraded_at IS NULL
          )
        ),
      ADD CONSTRAINT elearning_exam_attempts_awaiting_manual_chk
        CHECK (
          status <> 'awaiting_manual'
          OR (
            answers IS NOT NULL
            AND submitted_at IS NOT NULL
            AND auto_score IS NOT NULL
            AND total_score IS NULL
            AND passed IS NULL
            AND graded_at IS NULL
            AND regraded_at IS NULL
          )
        ),
      ADD CONSTRAINT elearning_exam_attempts_graded_complete_chk
        CHECK (
          status <> 'graded'
          OR (
            answers IS NOT NULL
            AND auto_score IS NOT NULL
            AND total_score IS NOT NULL
            AND passed IS NOT NULL
            AND submitted_at IS NOT NULL
            AND graded_at IS NOT NULL
          )
        ),
      ADD CONSTRAINT elearning_exam_attempts_earned_score_cap_chk
        CHECK (
          status <> 'graded'
          OR auto_score + manual_score <= total_score
        ),
      ADD CONSTRAINT elearning_exam_attempts_regraded_at_chk
        CHECK (
          regraded_at IS NULL
          OR (
            status = 'graded'
            AND graded_at IS NOT NULL
            AND regraded_at >= graded_at
          )
        )
  `.execute(db)

  await sql`
    ALTER TABLE elearning_grading_records
      DROP CONSTRAINT elearning_grading_records_org_attempt_kind_uniq,
      DROP CONSTRAINT elearning_grading_records_kind_chk,
      ADD COLUMN question_revision_id uuid,
      ADD COLUMN request_id uuid,
      ADD COLUMN seq integer NOT NULL DEFAULT 1
  `.execute(db)

  await sql`
    ALTER TABLE elearning_grading_records
      ADD CONSTRAINT elearning_grading_records_kind_chk
        CHECK (kind IN ('auto', 'manual', 'regrade')),
      ADD CONSTRAINT elearning_grading_records_kind_shape_chk
        CHECK (
          (
            kind = 'auto'
            AND question_revision_id IS NULL
            AND request_id IS NULL
            AND seq = 1
          )
          OR (
            kind IN ('manual', 'regrade')
            AND question_revision_id IS NOT NULL
            AND request_id IS NOT NULL
            AND seq >= 2
          )
        ),
      ADD CONSTRAINT elearning_grading_records_seq_chk
        CHECK (seq >= 1),
      ADD CONSTRAINT elearning_grading_records_org_attempt_seq_uniq
        UNIQUE (org_id, attempt_id, seq),
      ADD CONSTRAINT elearning_grading_records_question_revision_fk
        FOREIGN KEY (org_id, question_revision_id)
        REFERENCES elearning_question_revisions (org_id, id)
        ON DELETE RESTRICT
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX idx_elearning_grading_records_one_auto
      ON elearning_grading_records (org_id, attempt_id)
      WHERE kind = 'auto'
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX idx_elearning_grading_records_request_id
      ON elearning_grading_records (org_id, attempt_id, request_id)
      WHERE request_id IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_grading_records_effective_question
      ON elearning_grading_records (
        org_id,
        attempt_id,
        question_revision_id,
        seq DESC
      )
      WHERE question_revision_id IS NOT NULL
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
        IF OLD.status = 'awaiting_manual' THEN
          RAISE EXCEPTION 'elearning_exam_attempts awaiting manual rows cannot be deleted';
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

      IF OLD.expired_at IS NOT NULL
         AND NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
        RAISE EXCEPTION 'elearning_exam_attempts expired_at is immutable once set';
      END IF;

      IF OLD.status = 'graded' THEN
        RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be updated';
      END IF;

      IF OLD.status IN ('submitted', 'awaiting_manual', 'expired') THEN
        IF NEW.answers IS DISTINCT FROM OLD.answers
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
          RAISE EXCEPTION 'elearning_exam_attempts answers and submitted_at are immutable after submit/expire';
        END IF;
      END IF;

      IF OLD.status = 'awaiting_manual'
         AND NEW.auto_score IS DISTINCT FROM OLD.auto_score THEN
        RAISE EXCEPTION 'elearning_exam_attempts auto_score is immutable while awaiting manual grade';
      END IF;

      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status = 'started' AND NEW.status IN ('submitted', 'expired') THEN
          RETURN NEW;
        END IF;
        IF OLD.status IN ('submitted', 'expired')
           AND NEW.status IN ('awaiting_manual', 'graded') THEN
          IF NEW.status = 'graded' AND NEW.regraded_at IS NOT NULL THEN
            RAISE EXCEPTION 'elearning_exam_attempts initial grade cannot set regraded_at';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.status = 'awaiting_manual' AND NEW.status = 'graded' THEN
          IF NEW.regraded_at IS NOT NULL THEN
            RAISE EXCEPTION 'elearning_exam_attempts initial grade cannot set regraded_at';
          END IF;
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
    LOCK TABLE elearning_exam_attempts, elearning_grading_records
      IN ACCESS EXCLUSIVE MODE
  `.execute(db)

  await sql`
    DO $fn$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM elearning_exam_attempts
         WHERE status = 'awaiting_manual'
            OR manual_score <> 0
            OR regraded_at IS NOT NULL
      ) OR EXISTS (
        SELECT 1
          FROM elearning_grading_records
         WHERE kind <> 'auto'
            OR question_revision_id IS NOT NULL
            OR request_id IS NOT NULL
            OR seq <> 1
      ) THEN
        RAISE EXCEPTION ${sql.raw(`'${ELEARNING_MANUAL_GRADING_DOWN_NONEMPTY}'`)};
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

  await sql`DROP INDEX IF EXISTS idx_elearning_grading_records_effective_question`.execute(
    db,
  )
  await sql`DROP INDEX IF EXISTS idx_elearning_grading_records_request_id`.execute(
    db,
  )
  await sql`DROP INDEX IF EXISTS idx_elearning_grading_records_one_auto`.execute(
    db,
  )

  await sql`
    ALTER TABLE elearning_grading_records
      DROP CONSTRAINT elearning_grading_records_question_revision_fk,
      DROP CONSTRAINT elearning_grading_records_org_attempt_seq_uniq,
      DROP CONSTRAINT elearning_grading_records_seq_chk,
      DROP CONSTRAINT elearning_grading_records_kind_shape_chk,
      DROP CONSTRAINT elearning_grading_records_kind_chk,
      DROP COLUMN question_revision_id,
      DROP COLUMN request_id,
      DROP COLUMN seq,
      ADD CONSTRAINT elearning_grading_records_kind_chk
        CHECK (kind IN ('auto')),
      ADD CONSTRAINT elearning_grading_records_org_attempt_kind_uniq
        UNIQUE (org_id, attempt_id, kind)
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      DROP CONSTRAINT elearning_exam_attempts_regraded_at_chk,
      DROP CONSTRAINT elearning_exam_attempts_earned_score_cap_chk,
      DROP CONSTRAINT elearning_exam_attempts_graded_complete_chk,
      DROP CONSTRAINT elearning_exam_attempts_awaiting_manual_chk,
      DROP CONSTRAINT elearning_exam_attempts_submitted_expired_frozen_chk,
      DROP CONSTRAINT elearning_exam_attempts_started_no_grade_chk,
      DROP CONSTRAINT elearning_exam_attempts_manual_score_nonneg_chk,
      DROP CONSTRAINT elearning_exam_attempts_status_chk,
      DROP COLUMN regraded_at,
      DROP COLUMN manual_score
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      ADD CONSTRAINT elearning_exam_attempts_status_chk
        CHECK (status IN ('started', 'submitted', 'graded', 'expired')),
      ADD CONSTRAINT elearning_exam_attempts_score_order_chk
        CHECK (
          auto_score IS NULL
          OR total_score IS NULL
          OR auto_score <= total_score
        ),
      ADD CONSTRAINT elearning_exam_attempts_started_no_grade_chk
        CHECK (
          status <> 'started'
          OR (
            auto_score IS NULL
            AND total_score IS NULL
            AND passed IS NULL
            AND submitted_at IS NULL
            AND graded_at IS NULL
          )
        ),
      ADD CONSTRAINT elearning_exam_attempts_submitted_expired_frozen_chk
        CHECK (
          status NOT IN ('submitted', 'expired')
          OR (
            answers IS NOT NULL
            AND submitted_at IS NOT NULL
            AND auto_score IS NULL
            AND total_score IS NULL
            AND passed IS NULL
            AND graded_at IS NULL
          )
        ),
      ADD CONSTRAINT elearning_exam_attempts_graded_complete_chk
        CHECK (
          status <> 'graded'
          OR (
            answers IS NOT NULL
            AND auto_score IS NOT NULL
            AND total_score IS NOT NULL
            AND passed IS NOT NULL
            AND submitted_at IS NOT NULL
            AND graded_at IS NOT NULL
          )
        )
  `.execute(db)
}
