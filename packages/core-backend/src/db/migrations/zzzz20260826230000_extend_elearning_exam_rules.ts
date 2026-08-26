import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * E-learning L3 paper-bound exam rules.
 *
 * Existing V0.1 exams remain inline-question exams. New paper-bound exams pin
 * an immutable published paper by id. The content source is chosen at INSERT
 * and cannot be switched, which keeps the DB guard race-free without adding a
 * second mutable binding table.
 *
 * This slice stores rules only. Attempt-time enforcement and learner-facing
 * disclosure remain outside this migration. The runtime contract is to cap an
 * attempt at min(started_at + duration, window_ends_at), persist the realized
 * shuffled order in paper_snapshot, and never expose answer keys in learner
 * DTOs.
 */
export const ELEARNING_EXAM_PAPER_FK = "elearning_exams_paper_fk";
export const ELEARNING_EXAM_WINDOW_CHECK = "elearning_exams_window_chk";
export const ELEARNING_EXAM_DURATION_CHECK = "elearning_exams_duration_chk";
export const ELEARNING_EXAM_DISCLOSURE_CHECK = "elearning_exams_disclosure_chk";
export const ELEARNING_EXAM_AFTER_WINDOW_CHECK =
  "elearning_exams_after_window_requires_end_chk";
export const ELEARNING_EXAM_PAPER_INDEX = "idx_elearning_exams_org_paper";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE elearning_exams
      ADD COLUMN paper_id uuid,
      ADD COLUMN window_starts_at timestamptz,
      ADD COLUMN window_ends_at timestamptz,
      ADD COLUMN duration_seconds integer,
      ADD COLUMN shuffle_questions boolean NOT NULL DEFAULT false,
      ADD COLUMN shuffle_options boolean NOT NULL DEFAULT false,
      ADD COLUMN disclosure_policy text NOT NULL DEFAULT 'no_review'
  `.execute(db);

  await sql`
    ALTER TABLE elearning_exams
      ADD CONSTRAINT elearning_exams_paper_fk
        FOREIGN KEY (org_id, paper_id)
        REFERENCES elearning_papers (org_id, id)
        ON DELETE RESTRICT,
      ADD CONSTRAINT elearning_exams_window_chk
        CHECK (
          (window_starts_at IS NULL AND window_ends_at IS NULL)
          OR (
            window_starts_at IS NOT NULL
            AND window_ends_at IS NOT NULL
            AND window_starts_at < window_ends_at
          )
        ),
      ADD CONSTRAINT elearning_exams_duration_chk
        CHECK (duration_seconds IS NULL OR duration_seconds >= 1),
      ADD CONSTRAINT elearning_exams_disclosure_chk
        CHECK (
          disclosure_policy IN (
            'no_review',
            'correctness_after_submit',
            'wrong_items_after_submit',
            'correctness_after_window'
          )
        ),
      ADD CONSTRAINT elearning_exams_after_window_requires_end_chk
        CHECK (
          disclosure_policy <> 'correctness_after_window'
          OR window_ends_at IS NOT NULL
        )
  `.execute(db);

  await sql`
    CREATE INDEX idx_elearning_exams_org_paper
      ON elearning_exams (org_id, paper_id)
      WHERE paper_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION elearning_exams_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      inline_count integer;
      paper_status text;
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
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.paper_id IS DISTINCT FROM OLD.paper_id THEN
        RAISE EXCEPTION 'elearning_exams identity and content-source fields are immutable';
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
        SELECT count(*) INTO inline_count
          FROM elearning_exam_questions
         WHERE org_id = NEW.org_id
           AND exam_id = NEW.id;

        IF NEW.paper_id IS NULL AND inline_count < 1 THEN
          RAISE EXCEPTION 'cannot publish exam: exactly one content source is required';
        END IF;
        IF NEW.paper_id IS NOT NULL AND inline_count > 0 THEN
          RAISE EXCEPTION 'cannot publish exam: exactly one content source is required';
        END IF;

        IF NEW.paper_id IS NOT NULL THEN
          SELECT status INTO paper_status
            FROM elearning_papers
           WHERE org_id = NEW.org_id
             AND id = NEW.paper_id
           FOR SHARE;
          IF paper_status IS DISTINCT FROM 'published' THEN
            RAISE EXCEPTION 'cannot publish exam: paper must be published';
          END IF;
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'published' AND NEW.status = 'retired' THEN
        IF NEW.title IS DISTINCT FROM OLD.title
           OR NEW.paper_id IS DISTINCT FROM OLD.paper_id
           OR NEW.pass_score IS DISTINCT FROM OLD.pass_score
           OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
           OR NEW.window_starts_at IS DISTINCT FROM OLD.window_starts_at
           OR NEW.window_ends_at IS DISTINCT FROM OLD.window_ends_at
           OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
           OR NEW.shuffle_questions IS DISTINCT FROM OLD.shuffle_questions
           OR NEW.shuffle_options IS DISTINCT FROM OLD.shuffle_options
           OR NEW.disclosure_policy IS DISTINCT FROM OLD.disclosure_policy THEN
          RAISE EXCEPTION 'cannot mutate published exam content when retiring';
        END IF;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'elearning_exams illegal status transition: % -> %', OLD.status, NEW.status;
    END;
    $fn$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION elearning_exam_questions_draft_parent()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      parent_status text;
      parent_paper_id uuid;
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

      SELECT status, paper_id INTO parent_status, parent_paper_id
        FROM elearning_exams
       WHERE org_id = parent_org AND id = parent_id
       FOR UPDATE;

      IF parent_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'elearning_exam_questions can only be mutated when the parent exam is draft';
      END IF;
      IF parent_paper_id IS NOT NULL THEN
        RAISE EXCEPTION 'elearning_exam_questions cannot be added to a paper-bound exam';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db);

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

      IF NEW.paper_id IS NULL THEN
        SELECT COALESCE(SUM(points), 0) INTO total_points
          FROM elearning_exam_questions
         WHERE org_id = NEW.org_id
           AND exam_id = NEW.id;
      ELSE
        SELECT COALESCE(SUM(points), 0) INTO total_points
          FROM elearning_paper_questions
         WHERE org_id = NEW.org_id
           AND paper_id = NEW.paper_id;
      END IF;

      IF total_points <= 0 THEN
        RAISE EXCEPTION 'cannot publish exam: sum of question points must be greater than 0';
      END IF;
      IF NEW.pass_score > total_points THEN
        RAISE EXCEPTION 'cannot publish exam: pass_score must be <= sum of question points';
      END IF;

      RETURN NEW;
    END;
    $fn$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $fn$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM elearning_exams
         WHERE paper_id IS NOT NULL
            OR window_starts_at IS NOT NULL
            OR window_ends_at IS NOT NULL
            OR duration_seconds IS NOT NULL
            OR shuffle_questions
            OR shuffle_options
            OR disclosure_policy <> 'no_review'
      ) THEN
        RAISE EXCEPTION 'cannot roll back paper-bound exam rules while configured rows exist';
      END IF;
    END;
    $fn$
  `.execute(db);

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
  `.execute(db);

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
  `.execute(db);

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
  `.execute(db);

  await sql`DROP INDEX IF EXISTS idx_elearning_exams_org_paper`.execute(db);
  await sql`
    ALTER TABLE elearning_exams
      DROP CONSTRAINT IF EXISTS elearning_exams_after_window_requires_end_chk,
      DROP CONSTRAINT IF EXISTS elearning_exams_disclosure_chk,
      DROP CONSTRAINT IF EXISTS elearning_exams_duration_chk,
      DROP CONSTRAINT IF EXISTS elearning_exams_window_chk,
      DROP CONSTRAINT IF EXISTS elearning_exams_paper_fk,
      DROP COLUMN IF EXISTS disclosure_policy,
      DROP COLUMN IF EXISTS shuffle_options,
      DROP COLUMN IF EXISTS shuffle_questions,
      DROP COLUMN IF EXISTS duration_seconds,
      DROP COLUMN IF EXISTS window_ends_at,
      DROP COLUMN IF EXISTS window_starts_at,
      DROP COLUMN IF EXISTS paper_id
  `.execute(db);
}
