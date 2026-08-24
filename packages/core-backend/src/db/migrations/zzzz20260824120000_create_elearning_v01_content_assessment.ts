import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning V0.1 named-pilot — content + assessment persistence (Part A).
 *
 * Ten org-scoped SoR tables for the unparked closed loop
 * (video metadata → course version items → objective exam → auto-grade audit).
 * Out of scope: scopes, assignments, progress, sessions, evidence, jobs,
 * credits, certificates, stats, upload/API/UI.
 *
 * Discipline (design-lock §4.1 / §4.2 / §4.5 / gate 2):
 *   - org_id TEXT NOT NULL with no database default
 *   - UUID primary keys
 *   - UNIQUE(org_id, id) on every referenced parent
 *   - child FKs are (org_id, ref_id) → parent (org_id, id), ON DELETE RESTRICT, named
 *   - course head pointers are 3-column FKs onto versions(org_id, course_id, id)
 *   - active_version_id may be NULL or a same-org same-course published version
 *   - latest_version_id may still point at a draft
 *   - course_versions / exams: insert as draft; only draft→published→retired
 *   - published content frozen except published→retired; retired irreversible
 *   - draft UPDATE may change business fields only; version/created_by/created_at
 *     (course_versions) and created_by/created_at (exams) are immutable
 *   - items / exam_questions mutate only while the parent is draft; no cross-parent move
 *   - parent-status reads take SELECT ... FOR UPDATE so publish/retire cannot
 *     race a child insert into a frozen parent; retire locks the matching course
 *     FOR UPDATE. The active-pointer trigger reads version status with a plain
 *     SELECT (no FOR UPDATE): set-active already holds the course row, so the
 *     two operations linearize on that row and cannot form a course→version /
 *     version→course deadlock.
 *   - exam draft→published requires ≥1 exam_question
 *   - course_version draft→published requires ≥1 video item, ≥1 exam item,
 *     video media=ready, and exam items published
 *   - exam_attempts insert only as started; identity + paper_snapshot + started_at
 *     frozen after insert; started→submitted|expired freezes answers+submitted_at
 *     (scores empty); submitted|expired answers/submitted_at immutable;
 *     only submitted|expired→graded may fill scores; graded rows refuse UPDATE/DELETE
 *   - question revisions and grading records are append-only (named triggers)
 *   - V0.1 auto-grade idempotency: UNIQUE(org_id, attempt_id, kind)
 *
 * Actor columns (created_by / user_id / grader_id) are TEXT. They are not
 * foreign keys to users.id.
 */

export const ELEARNING_V01_TABLES = [
  'elearning_courses',
  'elearning_course_versions',
  'elearning_media',
  'elearning_questions',
  'elearning_question_revisions',
  'elearning_exams',
  'elearning_exam_questions',
  'elearning_course_version_items',
  'elearning_exam_attempts',
  'elearning_grading_records',
] as const

export const QUESTION_REVISION_DENY_FN = 'elearning_question_revisions_deny_mutation'
export const QUESTION_REVISION_DENY_TRIGGER = 'trg_elearning_question_revisions_deny_mutation'
export const GRADING_RECORD_DENY_FN = 'elearning_grading_records_deny_mutation'
export const GRADING_RECORD_DENY_TRIGGER = 'trg_elearning_grading_records_deny_mutation'
export const GRADING_RECORD_ATTEMPT_KIND_UNIQ = 'elearning_grading_records_org_attempt_kind_uniq'

export const COURSES_ACTIVE_VERSION_FN = 'elearning_courses_active_version_published'
export const COURSES_ACTIVE_VERSION_TRIGGER = 'trg_elearning_courses_active_version_published'
export const COURSE_VERSIONS_STATE_FN = 'elearning_course_versions_state_guard'
export const COURSE_VERSIONS_STATE_TRIGGER = 'trg_elearning_course_versions_state_guard'
export const COURSE_VERSION_ITEMS_DRAFT_FN = 'elearning_course_version_items_draft_parent'
export const COURSE_VERSION_ITEMS_DRAFT_TRIGGER = 'trg_elearning_course_version_items_draft_parent'
export const EXAMS_STATE_FN = 'elearning_exams_state_guard'
export const EXAMS_STATE_TRIGGER = 'trg_elearning_exams_state_guard'
export const EXAM_QUESTIONS_DRAFT_FN = 'elearning_exam_questions_draft_parent'
export const EXAM_QUESTIONS_DRAFT_TRIGGER = 'trg_elearning_exam_questions_draft_parent'
export const EXAM_ATTEMPTS_STATE_FN = 'elearning_exam_attempts_state_guard'
export const EXAM_ATTEMPTS_STATE_TRIGGER = 'trg_elearning_exam_attempts_state_guard'

/**
 * Named immutability / state-machine triggers. The independent whole-file
 * DB gate may DISABLE/ENABLE these by name for fixture cleanup, and MUST
 * re-enable them in `finally`.
 */
export const ELEARNING_V01_IMMUTABILITY_TRIGGERS = [
  { table: 'elearning_grading_records', name: GRADING_RECORD_DENY_TRIGGER, fn: GRADING_RECORD_DENY_FN },
  { table: 'elearning_exam_attempts', name: EXAM_ATTEMPTS_STATE_TRIGGER, fn: EXAM_ATTEMPTS_STATE_FN },
  { table: 'elearning_course_version_items', name: COURSE_VERSION_ITEMS_DRAFT_TRIGGER, fn: COURSE_VERSION_ITEMS_DRAFT_FN },
  { table: 'elearning_exam_questions', name: EXAM_QUESTIONS_DRAFT_TRIGGER, fn: EXAM_QUESTIONS_DRAFT_FN },
  { table: 'elearning_exams', name: EXAMS_STATE_TRIGGER, fn: EXAMS_STATE_FN },
  { table: 'elearning_question_revisions', name: QUESTION_REVISION_DENY_TRIGGER, fn: QUESTION_REVISION_DENY_FN },
  { table: 'elearning_course_versions', name: COURSE_VERSIONS_STATE_TRIGGER, fn: COURSE_VERSIONS_STATE_FN },
  { table: 'elearning_courses', name: COURSES_ACTIVE_VERSION_TRIGGER, fn: COURSES_ACTIVE_VERSION_FN },
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_courses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      title text NOT NULL,
      status text NOT NULL,
      active_version_id uuid,
      latest_version_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_courses_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_courses_status_chk
        CHECK (status IN ('active', 'archived', 'withdrawn')),
      CONSTRAINT elearning_courses_title_nonempty_chk
        CHECK (btrim(title) <> ''),
      CONSTRAINT elearning_courses_created_by_nonempty_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_course_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      course_id uuid NOT NULL,
      version integer NOT NULL,
      status text NOT NULL,
      title text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_course_versions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_course_versions_org_course_id_uniq UNIQUE (org_id, course_id, id),
      CONSTRAINT elearning_course_versions_org_course_version_uniq UNIQUE (org_id, course_id, version),
      CONSTRAINT elearning_course_versions_status_chk
        CHECK (status IN ('draft', 'published', 'retired')),
      CONSTRAINT elearning_course_versions_version_chk
        CHECK (version >= 1),
      CONSTRAINT elearning_course_versions_title_nonempty_chk
        CHECK (btrim(title) <> ''),
      CONSTRAINT elearning_course_versions_created_by_nonempty_chk
        CHECK (btrim(created_by) <> ''),
      CONSTRAINT elearning_course_versions_course_fk
        FOREIGN KEY (org_id, course_id)
        REFERENCES elearning_courses (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_courses_active_version_fk'
           AND conrelid = 'elearning_courses'::regclass
      ) THEN
        ALTER TABLE elearning_courses
          ADD CONSTRAINT elearning_courses_active_version_fk
          FOREIGN KEY (org_id, id, active_version_id)
          REFERENCES elearning_course_versions (org_id, course_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_courses_latest_version_fk'
           AND conrelid = 'elearning_courses'::regclass
      ) THEN
        ALTER TABLE elearning_courses
          ADD CONSTRAINT elearning_courses_latest_version_fk
          FOREIGN KEY (org_id, id, latest_version_id)
          REFERENCES elearning_course_versions (org_id, course_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_media (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      storage_key text NOT NULL,
      mime_type text NOT NULL,
      magic_mime_type text NOT NULL,
      size_bytes bigint NOT NULL,
      sha256 text NOT NULL,
      duration_ms bigint,
      status text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_media_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_media_status_chk
        CHECK (status IN ('uploading', 'probing', 'ready', 'rejected')),
      CONSTRAINT elearning_media_storage_key_nonempty_chk
        CHECK (btrim(storage_key) <> ''),
      CONSTRAINT elearning_media_mime_type_nonempty_chk
        CHECK (btrim(mime_type) <> ''),
      CONSTRAINT elearning_media_magic_mime_type_nonempty_chk
        CHECK (btrim(magic_mime_type) <> ''),
      CONSTRAINT elearning_media_sha256_nonempty_chk
        CHECK (btrim(sha256) <> ''),
      CONSTRAINT elearning_media_size_bytes_chk
        CHECK (size_bytes >= 0),
      CONSTRAINT elearning_media_duration_ms_chk
        CHECK (duration_ms IS NULL OR duration_ms >= 0),
      CONSTRAINT elearning_media_created_by_nonempty_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_questions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_questions_created_by_nonempty_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_question_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      question_id uuid NOT NULL,
      revision integer NOT NULL,
      question_type text NOT NULL,
      prompt text NOT NULL,
      options jsonb NOT NULL,
      answer_key jsonb NOT NULL,
      explanation text,
      points integer NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_question_revisions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_question_revisions_org_question_revision_uniq
        UNIQUE (org_id, question_id, revision),
      CONSTRAINT elearning_question_revisions_type_chk
        CHECK (question_type IN ('single_choice', 'multiple_choice', 'true_false')),
      CONSTRAINT elearning_question_revisions_revision_chk
        CHECK (revision >= 1),
      CONSTRAINT elearning_question_revisions_prompt_nonempty_chk
        CHECK (btrim(prompt) <> ''),
      CONSTRAINT elearning_question_revisions_points_chk
        CHECK (points >= 0),
      CONSTRAINT elearning_question_revisions_options_chk
        CHECK (jsonb_typeof(options) = 'array'),
      CONSTRAINT elearning_question_revisions_answer_key_chk
        CHECK (jsonb_typeof(answer_key) IN ('object', 'array')),
      CONSTRAINT elearning_question_revisions_created_by_nonempty_chk
        CHECK (btrim(created_by) <> ''),
      CONSTRAINT elearning_question_revisions_question_fk
        FOREIGN KEY (org_id, question_id)
        REFERENCES elearning_questions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_question_revisions_deny_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'elearning_question_revisions is append-only: % is not permitted', TG_OP;
    END;
    $$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_question_revisions_deny_mutation
      ON elearning_question_revisions
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_question_revisions_deny_mutation
      BEFORE UPDATE OR DELETE ON elearning_question_revisions
      FOR EACH ROW
      EXECUTE FUNCTION elearning_question_revisions_deny_mutation()
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_exams (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      title text NOT NULL,
      status text NOT NULL,
      pass_score numeric NOT NULL,
      max_attempts integer NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_exams_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_exams_status_chk
        CHECK (status IN ('draft', 'published', 'retired')),
      CONSTRAINT elearning_exams_title_nonempty_chk
        CHECK (btrim(title) <> ''),
      CONSTRAINT elearning_exams_pass_score_chk
        CHECK (pass_score >= 0),
      CONSTRAINT elearning_exams_max_attempts_chk
        CHECK (max_attempts >= 1),
      CONSTRAINT elearning_exams_created_by_nonempty_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_exam_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      exam_id uuid NOT NULL,
      question_revision_id uuid NOT NULL,
      position integer NOT NULL,
      points integer NOT NULL,
      CONSTRAINT elearning_exam_questions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_exam_questions_org_exam_position_uniq
        UNIQUE (org_id, exam_id, position),
      CONSTRAINT elearning_exam_questions_position_chk
        CHECK (position >= 1),
      CONSTRAINT elearning_exam_questions_points_chk
        CHECK (points >= 0),
      CONSTRAINT elearning_exam_questions_exam_fk
        FOREIGN KEY (org_id, exam_id)
        REFERENCES elearning_exams (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_exam_questions_revision_fk
        FOREIGN KEY (org_id, question_revision_id)
        REFERENCES elearning_question_revisions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_course_version_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      course_version_id uuid NOT NULL,
      item_type text NOT NULL,
      position integer NOT NULL,
      media_id uuid,
      exam_id uuid,
      CONSTRAINT elearning_course_version_items_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_course_version_items_org_version_position_uniq
        UNIQUE (org_id, course_version_id, position),
      CONSTRAINT elearning_course_version_items_item_type_chk
        CHECK (item_type IN ('video', 'exam')),
      CONSTRAINT elearning_course_version_items_position_chk
        CHECK (position >= 1),
      CONSTRAINT elearning_course_version_items_item_shape_chk
        CHECK (
          (item_type = 'video' AND media_id IS NOT NULL AND exam_id IS NULL)
          OR
          (item_type = 'exam' AND exam_id IS NOT NULL AND media_id IS NULL)
        ),
      CONSTRAINT elearning_course_version_items_version_fk
        FOREIGN KEY (org_id, course_version_id)
        REFERENCES elearning_course_versions (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_course_version_items_media_fk
        FOREIGN KEY (org_id, media_id)
        REFERENCES elearning_media (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_course_version_items_exam_fk
        FOREIGN KEY (org_id, exam_id)
        REFERENCES elearning_exams (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_exam_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      exam_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
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
      CONSTRAINT elearning_exam_attempts_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_exam_attempts_attempt_uniq
        UNIQUE (org_id, exam_id, user_id, attempt_no),
      CONSTRAINT elearning_exam_attempts_status_chk
        CHECK (status IN ('started', 'submitted', 'graded', 'expired')),
      CONSTRAINT elearning_exam_attempts_attempt_no_chk
        CHECK (attempt_no >= 1),
      CONSTRAINT elearning_exam_attempts_user_id_nonempty_chk
        CHECK (btrim(user_id) <> ''),
      CONSTRAINT elearning_exam_attempts_paper_snapshot_chk
        CHECK (jsonb_typeof(paper_snapshot) = 'object'),
      CONSTRAINT elearning_exam_attempts_answers_chk
        CHECK (answers IS NULL OR jsonb_typeof(answers) = 'object'),
      -- Scores stay NULL while status is started, submitted, or expired.
      -- submitted/expired rows freeze answers + submitted_at and cannot carry scores.
      -- Graded rows require answers, scores, passed, submitted_at, and graded_at.
      CONSTRAINT elearning_exam_attempts_auto_score_nonneg_chk
        CHECK (auto_score IS NULL OR auto_score >= 0),
      CONSTRAINT elearning_exam_attempts_total_score_nonneg_chk
        CHECK (total_score IS NULL OR total_score >= 0),
      CONSTRAINT elearning_exam_attempts_score_order_chk
        CHECK (
          auto_score IS NULL
          OR total_score IS NULL
          OR auto_score <= total_score
        ),
      CONSTRAINT elearning_exam_attempts_started_no_grade_chk
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
      CONSTRAINT elearning_exam_attempts_submitted_expired_frozen_chk
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
      CONSTRAINT elearning_exam_attempts_graded_complete_chk
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
      CONSTRAINT elearning_exam_attempts_exam_fk
        FOREIGN KEY (org_id, exam_id)
        REFERENCES elearning_exams (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_exam_attempts_version_fk
        FOREIGN KEY (org_id, course_version_id)
        REFERENCES elearning_course_versions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_grading_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      attempt_id uuid NOT NULL,
      kind text NOT NULL,
      score numeric NOT NULL,
      max_score numeric NOT NULL,
      details jsonb NOT NULL,
      grader_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_grading_records_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_grading_records_org_attempt_kind_uniq UNIQUE (org_id, attempt_id, kind),
      CONSTRAINT elearning_grading_records_kind_chk
        CHECK (kind IN ('auto')),
      CONSTRAINT elearning_grading_records_score_nonneg_chk
        CHECK (score >= 0),
      CONSTRAINT elearning_grading_records_max_score_nonneg_chk
        CHECK (max_score >= 0),
      CONSTRAINT elearning_grading_records_score_order_chk
        CHECK (score <= max_score),
      CONSTRAINT elearning_grading_records_details_chk
        CHECK (jsonb_typeof(details) = 'object'),
      CONSTRAINT elearning_grading_records_grader_nonempty_chk
        CHECK (btrim(grader_id) <> ''),
      CONSTRAINT elearning_grading_records_attempt_fk
        FOREIGN KEY (org_id, attempt_id)
        REFERENCES elearning_exam_attempts (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_grading_records_deny_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'elearning_grading_records is append-only: % is not permitted', TG_OP;
    END;
    $$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_grading_records_deny_mutation
      ON elearning_grading_records
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_grading_records_deny_mutation
      BEFORE UPDATE OR DELETE ON elearning_grading_records
      FOR EACH ROW
      EXECUTE FUNCTION elearning_grading_records_deny_mutation()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_courses_active_version_published()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      version_status text;
    BEGIN
      IF NEW.active_version_id IS NULL THEN
        RETURN NEW;
      END IF;
      -- Plain SELECT: the SET active_version_id UPDATE already holds the
      -- course row. Row-locking the version here would invert lock order
      -- against retire (version UPDATE then course row lock) and deadlock.
      SELECT status INTO version_status
        FROM elearning_course_versions
       WHERE org_id = NEW.org_id
         AND course_id = NEW.id
         AND id = NEW.active_version_id;
      IF NOT FOUND THEN
        RETURN NEW;
      END IF;
      IF version_status IS DISTINCT FROM 'published' THEN
        RAISE EXCEPTION 'elearning_courses.active_version_id must reference a published course version';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_courses_active_version_published
      ON elearning_courses
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_courses_active_version_published
      BEFORE INSERT OR UPDATE ON elearning_courses
      FOR EACH ROW
      EXECUTE FUNCTION elearning_courses_active_version_published()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_course_versions_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'elearning_course_versions must be inserted as draft';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'elearning_course_versions cannot be deleted after publish';
        END IF;
        RETURN OLD;
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.course_id IS DISTINCT FROM OLD.course_id THEN
        RAISE EXCEPTION 'elearning_course_versions identity fields are immutable';
      END IF;

      IF NEW.version IS DISTINCT FROM OLD.version
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning_course_versions audit fields are immutable';
      END IF;

      IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
        IF OLD.status = 'draft' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'elearning_course_versions in status % are immutable', OLD.status;
      END IF;

      IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM elearning_course_version_items
           WHERE org_id = NEW.org_id
             AND course_version_id = NEW.id
             AND item_type = 'video'
        ) THEN
          RAISE EXCEPTION 'cannot publish course version: at least one video item is required';
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM elearning_course_version_items
           WHERE org_id = NEW.org_id
             AND course_version_id = NEW.id
             AND item_type = 'exam'
        ) THEN
          RAISE EXCEPTION 'cannot publish course version: at least one exam item is required';
        END IF;
        IF EXISTS (
          SELECT 1
            FROM elearning_course_version_items i
            LEFT JOIN elearning_media m
              ON m.org_id = i.org_id AND m.id = i.media_id
           WHERE i.org_id = NEW.org_id
             AND i.course_version_id = NEW.id
             AND i.item_type = 'video'
             AND m.status IS DISTINCT FROM 'ready'
        ) THEN
          RAISE EXCEPTION 'cannot publish course version: video items require media status ready';
        END IF;
        IF EXISTS (
          SELECT 1
            FROM elearning_course_version_items i
            LEFT JOIN elearning_exams e
              ON e.org_id = i.org_id AND e.id = i.exam_id
           WHERE i.org_id = NEW.org_id
             AND i.course_version_id = NEW.id
             AND i.item_type = 'exam'
             AND e.status IS DISTINCT FROM 'published'
        ) THEN
          RAISE EXCEPTION 'cannot publish course version: exam items require exam status published';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'published' AND NEW.status = 'retired' THEN
        IF NEW.title IS DISTINCT FROM OLD.title THEN
          RAISE EXCEPTION 'cannot mutate published course version content when retiring';
        END IF;
        PERFORM 1
          FROM elearning_courses
         WHERE org_id = NEW.org_id
           AND id = NEW.course_id
         FOR UPDATE;
        IF EXISTS (
          SELECT 1
            FROM elearning_courses
           WHERE org_id = NEW.org_id
             AND id = NEW.course_id
             AND active_version_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'cannot retire course version while it is the course active_version_id';
        END IF;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'elearning_course_versions illegal status transition: % -> %', OLD.status, NEW.status;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_course_versions_state_guard
      ON elearning_course_versions
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_course_versions_state_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_course_versions
      FOR EACH ROW
      EXECUTE FUNCTION elearning_course_versions_state_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_course_version_items_draft_parent()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      parent_status text;
      parent_org text;
      parent_id uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        parent_org := OLD.org_id;
        parent_id := OLD.course_version_id;
      ELSE
        parent_org := NEW.org_id;
        parent_id := NEW.course_version_id;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.course_version_id IS DISTINCT FROM OLD.course_version_id THEN
          RAISE EXCEPTION 'elearning_course_version_items cannot move across parents';
        END IF;
      END IF;

      SELECT status INTO parent_status
        FROM elearning_course_versions
       WHERE org_id = parent_org AND id = parent_id
       FOR UPDATE;

      IF parent_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'elearning_course_version_items can only be mutated when the parent course version is draft';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_course_version_items_draft_parent
      ON elearning_course_version_items
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_course_version_items_draft_parent
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_course_version_items
      FOR EACH ROW
      EXECUTE FUNCTION elearning_course_version_items_draft_parent()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_exams_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'elearning_exams must be inserted as draft';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'elearning_exams cannot be deleted after publish';
        END IF;
        RETURN OLD;
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
        RAISE EXCEPTION 'elearning_exams identity fields are immutable';
      END IF;

      IF NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning_exams audit fields are immutable';
      END IF;

      IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
        IF OLD.status = 'draft' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'elearning_exams in status % are immutable', OLD.status;
      END IF;

      IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM elearning_exam_questions
           WHERE org_id = NEW.org_id
             AND exam_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'cannot publish exam: at least one exam question is required';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'published' AND NEW.status = 'retired' THEN
        IF NEW.title IS DISTINCT FROM OLD.title
           OR NEW.pass_score IS DISTINCT FROM OLD.pass_score
           OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts THEN
          RAISE EXCEPTION 'cannot mutate published exam content when retiring';
        END IF;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'elearning_exams illegal status transition: % -> %', OLD.status, NEW.status;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_exams_state_guard
      ON elearning_exams
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_exams_state_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_exams
      FOR EACH ROW
      EXECUTE FUNCTION elearning_exams_state_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_exam_questions_draft_parent()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      parent_status text;
      parent_org text;
      parent_id uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        parent_org := OLD.org_id;
        parent_id := OLD.exam_id;
      ELSE
        parent_org := NEW.org_id;
        parent_id := NEW.exam_id;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.exam_id IS DISTINCT FROM OLD.exam_id THEN
          RAISE EXCEPTION 'elearning_exam_questions cannot move across parents';
        END IF;
      END IF;

      SELECT status INTO parent_status
        FROM elearning_exams
       WHERE org_id = parent_org AND id = parent_id
       FOR UPDATE;

      IF parent_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'elearning_exam_questions can only be mutated when the parent exam is draft';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_exam_questions_draft_parent
      ON elearning_exam_questions
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_exam_questions_draft_parent
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_exam_questions
      FOR EACH ROW
      EXECUTE FUNCTION elearning_exam_questions_draft_parent()
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

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_exam_attempts_state_guard
      ON elearning_exam_attempts
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_exam_attempts_state_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_exam_attempts
      FOR EACH ROW
      EXECUTE FUNCTION elearning_exam_attempts_state_guard()
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_courses_org
      ON elearning_courses (org_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_course_versions_org_course
      ON elearning_course_versions (org_id, course_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_media_org
      ON elearning_media (org_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_questions_org
      ON elearning_questions (org_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_question_revisions_org_question
      ON elearning_question_revisions (org_id, question_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_exams_org
      ON elearning_exams (org_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_exam_questions_org_exam
      ON elearning_exam_questions (org_id, exam_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_course_version_items_org_version
      ON elearning_course_version_items (org_id, course_version_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_exam_attempts_org_exam_user
      ON elearning_exam_attempts (org_id, exam_id, user_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_elearning_grading_records_org_attempt
      ON elearning_grading_records (org_id, attempt_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_grading_records_deny_mutation
      ON elearning_grading_records
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_grading_records_deny_mutation()`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_exam_attempts_state_guard
      ON elearning_exam_attempts
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_exam_attempts_state_guard()`.execute(db)

  await sql`DROP TABLE IF EXISTS elearning_grading_records`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_exam_attempts`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_course_version_items_draft_parent
      ON elearning_course_version_items
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_course_version_items_draft_parent()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_course_version_items`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_exam_questions_draft_parent
      ON elearning_exam_questions
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_exam_questions_draft_parent()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_exam_questions`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_exams_state_guard
      ON elearning_exams
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_exams_state_guard()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_exams`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_question_revisions_deny_mutation
      ON elearning_question_revisions
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_question_revisions_deny_mutation()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_question_revisions`.execute(db)

  await sql`DROP TABLE IF EXISTS elearning_questions`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_media`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_course_versions_state_guard
      ON elearning_course_versions
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_course_versions_state_guard()`.execute(db)

  await sql`
    ALTER TABLE elearning_courses
      DROP CONSTRAINT IF EXISTS elearning_courses_active_version_fk
  `.execute(db)
  await sql`
    ALTER TABLE elearning_courses
      DROP CONSTRAINT IF EXISTS elearning_courses_latest_version_fk
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_courses_active_version_published
      ON elearning_courses
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_courses_active_version_published()`.execute(db)

  await sql`DROP TABLE IF EXISTS elearning_course_versions`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_courses`.execute(db)
}
