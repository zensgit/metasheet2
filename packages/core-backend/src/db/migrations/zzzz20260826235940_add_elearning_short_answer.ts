import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning L3 short-answer authoring prerequisite.
 *
 * The existing non-null JSON columns keep one closed storage shape:
 * short_answer rows use options=[] and answer_key={}. Runtime validation owns
 * that shape. Timed mixed attempts may retain expired_at while awaiting manual
 * grading, so this migration also closes that existing state-check gap.
 */
export const ELEARNING_QUESTION_REVISION_TYPE_CHECK =
  'elearning_question_revisions_type_chk'
export const ELEARNING_SHORT_ANSWER_EXPIRY_STATE_CHECK =
  'elearning_exam_attempts_expiry_state_chk'
export const ELEARNING_SHORT_ANSWER_DOWN_NONEMPTY =
  'cannot roll back short answer support while dependent state exists'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE elearning_question_revisions
      DROP CONSTRAINT elearning_question_revisions_type_chk,
      ADD CONSTRAINT elearning_question_revisions_type_chk
        CHECK (
          question_type IN (
            'single_choice',
            'multiple_choice',
            'true_false',
            'short_answer'
          )
        )
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      DROP CONSTRAINT elearning_exam_attempts_expiry_state_chk,
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
            AND status IN ('expired', 'awaiting_manual', 'graded')
          )
        )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    LOCK TABLE elearning_question_revisions, elearning_exam_attempts
      IN ACCESS EXCLUSIVE MODE
  `.execute(db)

  await sql`
    DO $fn$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM elearning_question_revisions
         WHERE question_type = 'short_answer'
      ) OR EXISTS (
        SELECT 1
          FROM elearning_exam_attempts
         WHERE status = 'awaiting_manual'
           AND expired_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION ${sql.raw(`'${ELEARNING_SHORT_ANSWER_DOWN_NONEMPTY}'`)};
      END IF;
    END;
    $fn$
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      DROP CONSTRAINT elearning_exam_attempts_expiry_state_chk,
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
    ALTER TABLE elearning_question_revisions
      DROP CONSTRAINT elearning_question_revisions_type_chk,
      ADD CONSTRAINT elearning_question_revisions_type_chk
        CHECK (
          question_type IN (
            'single_choice',
            'multiple_choice',
            'true_false'
          )
        )
  `.execute(db)
}
