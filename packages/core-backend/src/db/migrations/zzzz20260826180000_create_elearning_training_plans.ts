import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning L2 training-plan foundation.
 *
 * A plan has a stable head plus immutable published versions. Each version
 * pins ordered course_version_id values; retiring a course version later does
 * not rewrite existing plan history. Publish requests form an append-only,
 * org-scoped idempotency ledger.
 */
export const ELEARNING_TRAINING_PLANS_TABLE = 'elearning_training_plans'
export const ELEARNING_TRAINING_PLAN_VERSIONS_TABLE = 'elearning_training_plan_versions'
export const ELEARNING_TRAINING_PLAN_ITEMS_TABLE = 'elearning_training_plan_items'
export const ELEARNING_TRAINING_PLAN_PUBLISH_REQUESTS_TABLE =
  'elearning_training_plan_publish_requests'

export const TRAINING_PLAN_ACTIVE_VERSION_FN =
  'elearning_training_plans_active_version_guard'
export const TRAINING_PLAN_ACTIVE_VERSION_TRIGGER =
  'trg_elearning_training_plans_active_version_guard'
export const TRAINING_PLAN_VERSION_STATE_FN =
  'elearning_training_plan_versions_state_guard'
export const TRAINING_PLAN_VERSION_STATE_TRIGGER =
  'trg_elearning_training_plan_versions_state_guard'
export const TRAINING_PLAN_ITEM_DRAFT_FN =
  'elearning_training_plan_items_draft_guard'
export const TRAINING_PLAN_ITEM_DRAFT_TRIGGER =
  'trg_elearning_training_plan_items_draft_guard'
export const TRAINING_PLAN_REQUEST_APPEND_ONLY_FN =
  'elearning_training_plan_requests_append_only'
export const TRAINING_PLAN_REQUEST_APPEND_ONLY_TRIGGER =
  'trg_elearning_training_plan_requests_append_only'
export const TRAINING_PLAN_REQUEST_SOURCE_KEY_UNIQ =
  'elearning_training_plan_requests_org_source_uniq'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_training_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      title text NOT NULL,
      status text NOT NULL,
      active_version_id uuid,
      latest_version_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_training_plans_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_training_plans_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_training_plans_title_chk
        CHECK (btrim(title) <> '' AND char_length(title) <= 200),
      CONSTRAINT elearning_training_plans_status_chk
        CHECK (status IN ('active', 'archived')),
      CONSTRAINT elearning_training_plans_created_by_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_training_plan_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      training_plan_id uuid NOT NULL,
      version integer NOT NULL,
      status text NOT NULL,
      title text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_training_plan_versions_org_id_id_uniq
        UNIQUE (org_id, id),
      CONSTRAINT elearning_plan_versions_org_plan_id_uniq
        UNIQUE (org_id, training_plan_id, id),
      CONSTRAINT elearning_plan_versions_org_plan_version_uniq
        UNIQUE (org_id, training_plan_id, version),
      CONSTRAINT elearning_training_plan_versions_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_training_plan_versions_version_chk
        CHECK (version >= 1),
      CONSTRAINT elearning_training_plan_versions_status_chk
        CHECK (status IN ('draft', 'published', 'retired')),
      CONSTRAINT elearning_training_plan_versions_title_chk
        CHECK (btrim(title) <> '' AND char_length(title) <= 200),
      CONSTRAINT elearning_training_plan_versions_created_by_chk
        CHECK (btrim(created_by) <> ''),
      CONSTRAINT elearning_training_plan_versions_plan_fk
        FOREIGN KEY (org_id, training_plan_id)
        REFERENCES elearning_training_plans (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    ALTER TABLE elearning_training_plans
      ADD CONSTRAINT elearning_training_plans_active_version_fk
      FOREIGN KEY (org_id, id, active_version_id)
      REFERENCES elearning_training_plan_versions (org_id, training_plan_id, id)
      ON DELETE RESTRICT
  `.execute(db)

  await sql`
    ALTER TABLE elearning_training_plans
      ADD CONSTRAINT elearning_training_plans_latest_version_fk
      FOREIGN KEY (org_id, id, latest_version_id)
      REFERENCES elearning_training_plan_versions (org_id, training_plan_id, id)
      ON DELETE RESTRICT
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_training_plan_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      training_plan_version_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      position integer NOT NULL,
      required boolean NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_training_plan_items_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_plan_items_org_version_position_uniq
        UNIQUE (org_id, training_plan_version_id, position),
      CONSTRAINT elearning_plan_items_org_version_course_uniq
        UNIQUE (org_id, training_plan_version_id, course_version_id),
      CONSTRAINT elearning_training_plan_items_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_training_plan_items_position_chk
        CHECK (position >= 1),
      CONSTRAINT elearning_training_plan_items_version_fk
        FOREIGN KEY (org_id, training_plan_version_id)
        REFERENCES elearning_training_plan_versions (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_training_plan_items_course_version_fk
        FOREIGN KEY (org_id, course_version_id)
        REFERENCES elearning_course_versions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_training_plan_publish_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      training_plan_id uuid NOT NULL,
      training_plan_version_id uuid NOT NULL,
      item_count integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_training_plan_requests_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_training_plan_requests_org_source_uniq
        UNIQUE (org_id, source_key),
      CONSTRAINT elearning_training_plan_requests_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_training_plan_requests_source_key_chk
        CHECK (btrim(source_key) <> ''),
      CONSTRAINT elearning_training_plan_requests_hash_chk
        CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT elearning_training_plan_requests_hash_version_chk
        CHECK (request_hash_version >= 1),
      CONSTRAINT elearning_training_plan_requests_item_count_chk
        CHECK (item_count BETWEEN 1 AND 100),
      CONSTRAINT elearning_training_plan_requests_plan_fk
        FOREIGN KEY (org_id, training_plan_id)
        REFERENCES elearning_training_plans (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_training_plan_requests_version_fk
        FOREIGN KEY (org_id, training_plan_id, training_plan_version_id)
        REFERENCES elearning_training_plan_versions (org_id, training_plan_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_training_plans_active_version_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      version_status text;
    BEGIN
      IF NEW.active_version_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT status INTO version_status
        FROM elearning_training_plan_versions
       WHERE org_id = NEW.org_id
         AND training_plan_id = NEW.id
         AND id = NEW.active_version_id;
      IF FOUND AND version_status IS DISTINCT FROM 'published' THEN
        RAISE EXCEPTION 'active training plan version must be published';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plans_active_version_guard
      BEFORE INSERT OR UPDATE ON elearning_training_plans
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plans_active_version_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_training_plan_versions_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      item_count integer;
      min_position integer;
      max_position integer;
      valid_count integer;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'training plan versions must be inserted as draft';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION 'published training plan versions cannot be deleted';
        END IF;
        RETURN OLD;
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.training_plan_id IS DISTINCT FROM OLD.training_plan_id
         OR NEW.version IS DISTINCT FROM OLD.version
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'training plan version identity and audit fields are immutable';
      END IF;

      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        IF OLD.status = 'draft' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'published training plan versions are immutable';
      END IF;

      IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        SELECT count(*), min(position), max(position)
          INTO item_count, min_position, max_position
          FROM elearning_training_plan_items
         WHERE org_id = NEW.org_id
           AND training_plan_version_id = NEW.id;
        IF item_count < 1 OR item_count > 100 THEN
          RAISE EXCEPTION 'training plan version requires between 1 and 100 items';
        END IF;
        IF min_position IS DISTINCT FROM 1
           OR max_position IS DISTINCT FROM item_count THEN
          RAISE EXCEPTION 'training plan item positions must be dense from 1 through item count';
        END IF;

        PERFORM cv.id
          FROM elearning_training_plan_items i
          JOIN elearning_course_versions cv
            ON cv.org_id = i.org_id AND cv.id = i.course_version_id
          JOIN elearning_courses c
            ON c.org_id = cv.org_id AND c.id = cv.course_id
         WHERE i.org_id = NEW.org_id
           AND i.training_plan_version_id = NEW.id
           AND cv.status = 'published'
           AND c.status = 'active'
         FOR SHARE OF cv, c;
        GET DIAGNOSTICS valid_count = ROW_COUNT;
        IF valid_count IS DISTINCT FROM item_count THEN
          RAISE EXCEPTION 'training plan items require active courses and published versions';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'published' AND NEW.status = 'retired' THEN
        IF NEW.title IS DISTINCT FROM OLD.title THEN
          RAISE EXCEPTION 'training plan version content is immutable when retiring';
        END IF;
        PERFORM 1
          FROM elearning_training_plans
         WHERE org_id = NEW.org_id
           AND id = NEW.training_plan_id
         FOR UPDATE;
        IF EXISTS (
          SELECT 1
            FROM elearning_training_plans
           WHERE org_id = NEW.org_id
             AND id = NEW.training_plan_id
             AND active_version_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'active training plan version cannot be retired';
        END IF;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'illegal training plan version status transition';
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_versions_state_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_training_plan_versions
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_versions_state_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_training_plan_items_draft_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      parent_org text;
      parent_id uuid;
      parent_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        parent_org := OLD.org_id;
        parent_id := OLD.training_plan_version_id;
      ELSE
        parent_org := NEW.org_id;
        parent_id := NEW.training_plan_version_id;
      END IF;

      IF TG_OP = 'UPDATE' AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.org_id IS DISTINCT FROM OLD.org_id
        OR NEW.training_plan_version_id IS DISTINCT FROM OLD.training_plan_version_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      ) THEN
        RAISE EXCEPTION 'training plan item identity and parent are immutable';
      END IF;

      SELECT status INTO parent_status
        FROM elearning_training_plan_versions
       WHERE org_id = parent_org AND id = parent_id
       FOR UPDATE;
      IF parent_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'training plan items require a draft parent';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_items_draft_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_training_plan_items
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_items_draft_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_training_plan_requests_append_only()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'training plan publish requests are append-only';
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_requests_append_only
      BEFORE UPDATE OR DELETE ON elearning_training_plan_publish_requests
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_requests_append_only()
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_training_plan_items_version
      ON elearning_training_plan_items (org_id, training_plan_version_id, position)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_training_plan_requests_append_only
      ON elearning_training_plan_publish_requests
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_training_plan_requests_append_only()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_training_plan_publish_requests`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_training_plan_items_draft_guard
      ON elearning_training_plan_items
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_training_plan_items_draft_guard()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_training_plan_items`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_training_plan_versions_state_guard
      ON elearning_training_plan_versions
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_training_plan_versions_state_guard()`.execute(db)

  await sql`
    ALTER TABLE elearning_training_plans
      DROP CONSTRAINT IF EXISTS elearning_training_plans_active_version_fk
  `.execute(db)
  await sql`
    ALTER TABLE elearning_training_plans
      DROP CONSTRAINT IF EXISTS elearning_training_plans_latest_version_fk
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_training_plans_active_version_guard
      ON elearning_training_plans
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_training_plans_active_version_guard()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_training_plan_versions`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_training_plans`.execute(db)
}
