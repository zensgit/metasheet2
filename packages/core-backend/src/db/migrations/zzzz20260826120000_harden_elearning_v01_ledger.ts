import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning V0.1 ledger hardening.
 *
 * Adds named SoR guards without rewriting historical migrations:
 *   - elearning_media UPDATE state machine + identity freeze + duration/status CHECK
 *   - append-only course publish requests
 *   - exam draft→published total-points / pass_score guard
 *   - assignment identity freeze + DELETE refuse
 *   - progress-event UPDATE refuse (retention DELETE remains legal)
 *
 * Direct INSERT of any legal status/shape remains allowed. Media DELETE
 * stays on current FKs. Stale reconciler uploading|probing → rejected is
 * a legal transition (duration stays NULL).
 */

export const MEDIA_STATE_FN = 'elearning_media_state_guard'
export const MEDIA_STATE_TRIGGER = 'trg_elearning_media_state_guard'
export const MEDIA_DURATION_STATUS_CHK = 'elearning_media_duration_status_chk'

export const COURSE_PUBLISH_REQUESTS_DENY_FN =
  'elearning_course_publish_requests_deny_mutation'
export const COURSE_PUBLISH_REQUESTS_DENY_TRIGGER =
  'trg_elearning_course_publish_requests_deny_mutation'

export const EXAMS_PUBLISH_POINTS_FN = 'elearning_exams_publish_points_guard'
export const EXAMS_PUBLISH_POINTS_TRIGGER = 'trg_elearning_exams_state_guard_points'

export const ASSIGNMENTS_IDENTITY_FN = 'elearning_assignments_identity_guard'
export const ASSIGNMENTS_IDENTITY_TRIGGER = 'trg_elearning_assignments_identity_guard'
export const ASSIGNMENTS_DENY_DELETE_FN = 'elearning_assignments_deny_delete'
export const ASSIGNMENTS_DENY_DELETE_TRIGGER = 'trg_elearning_assignments_deny_delete'

export const PROGRESS_EVENTS_DENY_UPDATE_FN = 'elearning_progress_events_deny_update'
export const PROGRESS_EVENTS_DENY_UPDATE_TRIGGER =
  'trg_elearning_progress_events_deny_update'

/**
 * Every named trigger installed by this migration. Schema census tests use
 * this full list; cleanup must use the narrower list below.
 */
export const ELEARNING_V01_LEDGER_TRIGGERS = [
  { table: 'elearning_media', name: MEDIA_STATE_TRIGGER, fn: MEDIA_STATE_FN },
  {
    table: 'elearning_course_publish_requests',
    name: COURSE_PUBLISH_REQUESTS_DENY_TRIGGER,
    fn: COURSE_PUBLISH_REQUESTS_DENY_FN,
  },
  {
    table: 'elearning_exams',
    name: EXAMS_PUBLISH_POINTS_TRIGGER,
    fn: EXAMS_PUBLISH_POINTS_FN,
  },
  {
    table: 'elearning_assignments',
    name: ASSIGNMENTS_IDENTITY_TRIGGER,
    fn: ASSIGNMENTS_IDENTITY_FN,
  },
  {
    table: 'elearning_assignments',
    name: ASSIGNMENTS_DENY_DELETE_TRIGGER,
    fn: ASSIGNMENTS_DENY_DELETE_FN,
  },
  {
    table: 'elearning_progress_events',
    name: PROGRESS_EVENTS_DENY_UPDATE_TRIGGER,
    fn: PROGRESS_EVENTS_DENY_UPDATE_FN,
  },
] as const

/**
 * Only triggers that block namespace DELETE cleanup. UPDATE-only state and
 * identity guards stay enabled so one test file cannot weaken another file's
 * business assertions while Vitest shares a database.
 */
export const ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS = [
  {
    table: 'elearning_course_publish_requests',
    name: COURSE_PUBLISH_REQUESTS_DENY_TRIGGER,
    fn: COURSE_PUBLISH_REQUESTS_DENY_FN,
  },
  {
    table: 'elearning_assignments',
    name: ASSIGNMENTS_DENY_DELETE_TRIGGER,
    fn: ASSIGNMENTS_DENY_DELETE_FN,
  },
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_media_duration_status_chk'
           AND conrelid = 'elearning_media'::regclass
      ) THEN
        ALTER TABLE elearning_media
          ADD CONSTRAINT elearning_media_duration_status_chk
          CHECK (
            (status = 'ready' AND duration_ms IS NOT NULL AND duration_ms > 0)
            OR (status IS DISTINCT FROM 'ready' AND duration_ms IS NULL)
          ) NOT VALID;
      END IF;
    END $$
  `.execute(db)

  // Fail closed without blocking rollout on rows accepted by the earlier
  // schema. A ready row without a trustworthy positive server duration is
  // quarantined; stale non-ready duration residue is discarded. Neither case
  // remains publishable as ready media after this migration.
  await sql`
    UPDATE elearning_media
       SET status = 'rejected',
           duration_ms = NULL,
           updated_at = now()
     WHERE status = 'ready'
       AND (duration_ms IS NULL OR duration_ms <= 0)
  `.execute(db)

  await sql`
    UPDATE elearning_media
       SET duration_ms = NULL,
           updated_at = now()
     WHERE status IS DISTINCT FROM 'ready'
       AND duration_ms IS NOT NULL
  `.execute(db)

  // NOT VALID keeps the ADD lock bounded; validation still completes in the
  // same migration after deterministic quarantine/repair.
  await sql`
    ALTER TABLE elearning_media
      VALIDATE CONSTRAINT elearning_media_duration_status_chk
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_media_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
         OR NEW.magic_mime_type IS DISTINCT FROM OLD.magic_mime_type
         OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
         OR NEW.sha256 IS DISTINCT FROM OLD.sha256
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning_media identity fields are immutable after insert';
      END IF;

      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'elearning_media same-status updates are not permitted';
      END IF;

      IF NOT (
        (OLD.status = 'uploading' AND NEW.status IN ('probing', 'rejected'))
        OR (OLD.status = 'probing' AND NEW.status IN ('ready', 'rejected'))
      ) THEN
        RAISE EXCEPTION 'elearning_media illegal status transition: % -> %', OLD.status, NEW.status;
      END IF;

      IF NEW.status = 'ready' THEN
        IF NEW.duration_ms IS NULL OR NEW.duration_ms <= 0 THEN
          RAISE EXCEPTION 'elearning_media ready requires duration_ms > 0';
        END IF;
      ELSE
        IF NEW.duration_ms IS NOT NULL THEN
          RAISE EXCEPTION 'elearning_media non-ready status requires duration_ms NULL';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_media_state_guard
      ON elearning_media
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_media_state_guard
      BEFORE UPDATE ON elearning_media
      FOR EACH ROW
      EXECUTE FUNCTION elearning_media_state_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_course_publish_requests_deny_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'elearning_course_publish_requests is append-only: % is not permitted', TG_OP;
    END;
    $$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_course_publish_requests_deny_mutation
      ON elearning_course_publish_requests
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_course_publish_requests_deny_mutation
      BEFORE UPDATE OR DELETE ON elearning_course_publish_requests
      FOR EACH ROW
      EXECUTE FUNCTION elearning_course_publish_requests_deny_mutation()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_exams_publish_points_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      total_points numeric;
    BEGIN
      IF TG_OP <> 'UPDATE' THEN
        RETURN NEW;
      END IF;
      IF NOT (OLD.status = 'draft' AND NEW.status = 'published') THEN
        RETURN NEW;
      END IF;

      SELECT COALESCE(SUM(points), 0) INTO total_points
        FROM elearning_exam_questions
       WHERE org_id = NEW.org_id
         AND exam_id = NEW.id;

      IF total_points <= 0 THEN
        RAISE EXCEPTION 'cannot publish exam: sum of question points must be greater than 0';
      END IF;
      IF NEW.pass_score > total_points THEN
        RAISE EXCEPTION 'cannot publish exam: pass_score must be <= sum of question points';
      END IF;

      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_exams_state_guard_points
      ON elearning_exams
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_exams_state_guard_points
      BEFORE UPDATE ON elearning_exams
      FOR EACH ROW
      EXECUTE FUNCTION elearning_exams_publish_points_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_assignments_identity_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.course_version_id IS DISTINCT FROM OLD.course_version_id
         OR NEW.source_key IS DISTINCT FROM OLD.source_key
         OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
         OR NEW.request_hash_version IS DISTINCT FROM OLD.request_hash_version
         OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning_assignments identity fields are immutable';
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_assignments_identity_guard
      ON elearning_assignments
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_assignments_identity_guard
      BEFORE UPDATE ON elearning_assignments
      FOR EACH ROW
      EXECUTE FUNCTION elearning_assignments_identity_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_assignments_deny_delete()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'elearning_assignments DELETE is not permitted';
    END;
    $$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_assignments_deny_delete
      ON elearning_assignments
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_assignments_deny_delete
      BEFORE DELETE ON elearning_assignments
      FOR EACH ROW
      EXECUTE FUNCTION elearning_assignments_deny_delete()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_progress_events_deny_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'elearning_progress_events is append-only: UPDATE is not permitted';
    END;
    $$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_progress_events_deny_update
      ON elearning_progress_events
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_progress_events_deny_update
      BEFORE UPDATE ON elearning_progress_events
      FOR EACH ROW
      EXECUTE FUNCTION elearning_progress_events_deny_update()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_progress_events_deny_update
      ON elearning_progress_events
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_progress_events_deny_update()`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_assignments_deny_delete
      ON elearning_assignments
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_assignments_deny_delete()`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_assignments_identity_guard
      ON elearning_assignments
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_assignments_identity_guard()`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_exams_state_guard_points
      ON elearning_exams
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_exams_publish_points_guard()`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_course_publish_requests_deny_mutation
      ON elearning_course_publish_requests
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_course_publish_requests_deny_mutation()`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_media_state_guard
      ON elearning_media
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_media_state_guard()`.execute(db)

  await sql`
    ALTER TABLE elearning_media
      DROP CONSTRAINT IF EXISTS elearning_media_duration_status_chk
  `.execute(db)
}
