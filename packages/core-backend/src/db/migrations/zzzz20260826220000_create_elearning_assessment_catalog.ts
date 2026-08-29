import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning L3 assessment-catalog foundation.
 *
 * This migration adds one-bank-per-question catalog ownership and reusable,
 * fixed papers whose ordered items pin immutable question revisions. Existing
 * V0.1 inline questions remain valid with question_bank_id = NULL. Random
 * composition, exam binding, HTTP routes, and grading changes are deliberately
 * outside this inert slice.
 */
export const ELEARNING_QUESTION_BANKS_TABLE = 'elearning_question_banks'
export const ELEARNING_PAPERS_TABLE = 'elearning_papers'
export const ELEARNING_PAPER_QUESTIONS_TABLE = 'elearning_paper_questions'

export const ELEARNING_PAPER_STATE_FN = 'elearning_papers_state_guard'
export const ELEARNING_PAPER_STATE_TRIGGER = 'trg_elearning_papers_state_guard'
export const ELEARNING_PAPER_QUESTION_DRAFT_FN =
  'elearning_paper_questions_draft_guard'
export const ELEARNING_PAPER_QUESTION_DRAFT_TRIGGER =
  'trg_elearning_paper_questions_draft_guard'

export const ELEARNING_ASSESSMENT_CATALOG_TRIGGERS = [
  { table: ELEARNING_PAPERS_TABLE, name: ELEARNING_PAPER_STATE_TRIGGER },
  {
    table: ELEARNING_PAPER_QUESTIONS_TABLE,
    name: ELEARNING_PAPER_QUESTION_DRAFT_TRIGGER,
  },
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE elearning_question_banks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      title text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_question_banks_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_question_banks_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_question_banks_title_chk
        CHECK (btrim(title) <> '' AND char_length(title) <= 200),
      CONSTRAINT elearning_question_banks_created_by_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    ALTER TABLE elearning_questions
      ADD COLUMN question_bank_id uuid
  `.execute(db)
  await sql`
    ALTER TABLE elearning_questions
      ADD CONSTRAINT elearning_questions_question_bank_fk
      FOREIGN KEY (org_id, question_bank_id)
      REFERENCES elearning_question_banks (org_id, id)
      ON DELETE RESTRICT
  `.execute(db)
  await sql`
    ALTER TABLE elearning_question_revisions
      ADD CONSTRAINT elearning_question_revisions_org_question_id_uniq
      UNIQUE (org_id, question_id, id)
  `.execute(db)

  await sql`
    CREATE TABLE elearning_papers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      title text NOT NULL,
      composition_mode text NOT NULL,
      status text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_papers_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_papers_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_papers_title_chk
        CHECK (btrim(title) <> '' AND char_length(title) <= 200),
      CONSTRAINT elearning_papers_composition_mode_chk
        CHECK (composition_mode = 'fixed'),
      CONSTRAINT elearning_papers_status_chk
        CHECK (status IN ('draft', 'published', 'retired')),
      CONSTRAINT elearning_papers_created_by_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_paper_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      paper_id uuid NOT NULL,
      question_id uuid NOT NULL,
      question_revision_id uuid NOT NULL,
      position integer NOT NULL,
      points integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_paper_questions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_paper_questions_org_paper_position_uniq
        UNIQUE (org_id, paper_id, position),
      CONSTRAINT elearning_paper_questions_org_paper_question_uniq
        UNIQUE (org_id, paper_id, question_id),
      CONSTRAINT elearning_paper_questions_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_paper_questions_position_chk
        CHECK (position >= 1),
      CONSTRAINT elearning_paper_questions_points_chk
        CHECK (points >= 0),
      CONSTRAINT elearning_paper_questions_paper_fk
        FOREIGN KEY (org_id, paper_id)
        REFERENCES elearning_papers (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_paper_questions_revision_fk
        FOREIGN KEY (org_id, question_id, question_revision_id)
        REFERENCES elearning_question_revisions (org_id, question_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_papers_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      item_count integer;
      min_position integer;
      max_position integer;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'elearning_papers must be inserted as draft';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'elearning_papers cannot be deleted after publish';
        END IF;
        RETURN OLD;
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning_papers identity and audit fields are immutable';
      END IF;

      IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
        IF OLD.status = 'draft' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'elearning_papers are immutable after publish';
      END IF;

      IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        SELECT count(*), min(position), max(position)
          INTO item_count, min_position, max_position
          FROM elearning_paper_questions
         WHERE org_id = NEW.org_id
           AND paper_id = NEW.id;
        IF item_count < 1 THEN
          RAISE EXCEPTION 'elearning_papers require at least one question';
        END IF;
        IF min_position IS DISTINCT FROM 1
           OR max_position IS DISTINCT FROM item_count THEN
          RAISE EXCEPTION 'elearning_paper_questions positions must be dense';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'published' AND NEW.status = 'retired' THEN
        IF NEW.title IS DISTINCT FROM OLD.title
           OR NEW.composition_mode IS DISTINCT FROM OLD.composition_mode THEN
          RAISE EXCEPTION 'elearning_papers content is immutable when retiring';
        END IF;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'elearning_papers illegal status transition: % -> %', OLD.status, NEW.status;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_papers_state_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_papers
      FOR EACH ROW
      EXECUTE FUNCTION elearning_papers_state_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_paper_questions_draft_guard()
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
        parent_id := OLD.paper_id;
      ELSE
        parent_org := NEW.org_id;
        parent_id := NEW.paper_id;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.paper_id IS DISTINCT FROM OLD.paper_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'elearning_paper_questions cannot move across parents';
        END IF;
      END IF;

      SELECT status INTO parent_status
        FROM elearning_papers
       WHERE org_id = parent_org
         AND id = parent_id
       FOR UPDATE;

      IF parent_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'elearning_paper_questions require a draft parent';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_paper_questions_draft_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_paper_questions
      FOR EACH ROW
      EXECUTE FUNCTION elearning_paper_questions_draft_guard()
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_question_banks_org
      ON elearning_question_banks (org_id, created_at, id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_questions_org_bank
      ON elearning_questions (org_id, question_bank_id, created_at, id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_papers_org_status
      ON elearning_papers (org_id, status, created_at, id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_paper_questions_org_paper
      ON elearning_paper_questions (org_id, paper_id, position)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_paper_questions_draft_guard
      ON elearning_paper_questions
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_paper_questions_draft_guard()`.execute(db)
  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_papers_state_guard
      ON elearning_papers
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_papers_state_guard()`.execute(db)

  await sql`DROP TABLE IF EXISTS elearning_paper_questions`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_papers`.execute(db)

  await sql`
    ALTER TABLE elearning_question_revisions
      DROP CONSTRAINT IF EXISTS elearning_question_revisions_org_question_id_uniq
  `.execute(db)
  await sql`
    ALTER TABLE elearning_questions
      DROP CONSTRAINT IF EXISTS elearning_questions_question_bank_fk
  `.execute(db)
  await sql`DROP INDEX IF EXISTS idx_elearning_questions_org_bank`.execute(db)
  await sql`
    ALTER TABLE elearning_questions
      DROP COLUMN IF EXISTS question_bank_id
  `.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_question_banks`.execute(db)
}
