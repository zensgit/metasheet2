import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning L2 atomic training-plan assignment.
 *
 * A plan-assignment row freezes the published plan version, one normalized
 * audience rule snapshot, and the single resolved member set. Immutable link
 * rows prove which ordinary assignment was created for every plan item.
 */
export const ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE =
  'elearning_training_plan_assignments'
export const ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE =
  'elearning_training_plan_assignment_items'
export const TRAINING_PLAN_ASSIGNMENT_GROUP_GUARD_FN =
  'elearning_training_plan_assignment_group_guard'
export const TRAINING_PLAN_ASSIGNMENT_GROUP_GUARD_TRIGGER =
  'trg_elearning_training_plan_assignment_group_guard'
export const TRAINING_PLAN_ASSIGNMENT_LINK_GUARD_FN =
  'elearning_training_plan_assignment_link_guard'
export const TRAINING_PLAN_ASSIGNMENT_LINK_GUARD_TRIGGER =
  'trg_elearning_training_plan_assignment_link_guard'
export const TRAINING_PLAN_ASSIGNMENT_LINK_IMMUTABLE_FN =
  'elearning_training_plan_assignment_link_immutable'
export const TRAINING_PLAN_ASSIGNMENT_LINK_IMMUTABLE_TRIGGER =
  'trg_elearning_training_plan_assignment_link_immutable'
export const TRAINING_PLAN_CHILD_ASSIGNMENT_DEADLINE_FN =
  'elearning_training_plan_child_assignment_deadline_guard'
export const TRAINING_PLAN_CHILD_ASSIGNMENT_DEADLINE_TRIGGER =
  'trg_elearning_training_plan_child_assignment_deadline_guard'
export const TRAINING_PLAN_CHILD_MEMBER_INSERT_FN =
  'elearning_training_plan_child_member_insert_guard'
export const TRAINING_PLAN_CHILD_MEMBER_INSERT_TRIGGER =
  'trg_elearning_training_plan_child_member_insert_guard'
export const TRAINING_PLAN_CHILD_MEMBER_REVOKE_FN =
  'elearning_training_plan_child_member_revoke_guard'
export const TRAINING_PLAN_CHILD_MEMBER_REVOKE_TRIGGER =
  'trg_elearning_training_plan_child_member_revoke_guard'
export const TRAINING_PLAN_ASSIGNMENT_COMPLETE_FN =
  'elearning_training_plan_assignment_complete'
export const TRAINING_PLAN_ASSIGNMENT_COMPLETE_GROUP_TRIGGER =
  'trg_elearning_training_plan_assignment_complete_group'
export const TRAINING_PLAN_ASSIGNMENT_COMPLETE_LINK_TRIGGER =
  'trg_elearning_training_plan_assignment_complete_link'
export const TRAINING_PLAN_ITEM_LINK_PARENT_UNIQ =
  'elearning_plan_items_org_id_version_course_uniq'
export const TRAINING_PLAN_ASSIGNMENT_SOURCE_UNIQ =
  'elearning_training_plan_assignments_org_source_uniq'
export const TRAINING_PLAN_ASSIGNMENT_DOWN_IN_USE =
  'ELEARNING_TRAINING_PLAN_ASSIGNMENT_DOWN_IN_USE'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    ALTER TABLE elearning_training_plan_items
      ADD CONSTRAINT elearning_plan_items_org_id_version_course_uniq
      UNIQUE (org_id, id, training_plan_version_id, course_version_id)
  `.execute(db)

  await sql`
    CREATE TABLE elearning_training_plan_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      training_plan_id uuid NOT NULL,
      training_plan_version_id uuid NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      deadline timestamptz,
      assigned_by text NOT NULL,
      target_snapshot jsonb NOT NULL,
      member_ids text[] NOT NULL,
      course_count integer NOT NULL,
      member_count integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_training_plan_assignments_org_id_id_uniq
        UNIQUE (org_id, id),
      CONSTRAINT elearning_training_plan_assignments_org_id_version_uniq
        UNIQUE (org_id, id, training_plan_version_id),
      CONSTRAINT elearning_training_plan_assignments_org_source_uniq
        UNIQUE (org_id, source_key),
      CONSTRAINT elearning_training_plan_assignments_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_training_plan_assignments_source_key_chk
        CHECK (btrim(source_key) <> '' AND char_length(source_key) <= 512),
      CONSTRAINT elearning_training_plan_assignments_request_hash_chk
        CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT elearning_training_plan_assignments_hash_version_chk
        CHECK (request_hash_version >= 1),
      CONSTRAINT elearning_training_plan_assignments_assigned_by_chk
        CHECK (btrim(assigned_by) <> ''),
      CONSTRAINT elearning_training_plan_assignments_snapshot_chk
        CHECK (elearning_assignment_target_snapshot_valid(target_snapshot)),
      CONSTRAINT elearning_training_plan_assignments_course_count_chk
        CHECK (course_count BETWEEN 1 AND 100),
      CONSTRAINT elearning_training_plan_assignments_member_count_chk
        CHECK (
          member_count BETWEEN 1 AND 10000
          AND member_count = cardinality(member_ids)
        ),
      CONSTRAINT elearning_training_plan_assignments_plan_version_fk
        FOREIGN KEY (org_id, training_plan_id, training_plan_version_id)
        REFERENCES elearning_training_plan_versions (
          org_id, training_plan_id, id
        )
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_training_plan_assignment_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      training_plan_assignment_id uuid NOT NULL,
      training_plan_version_id uuid NOT NULL,
      training_plan_item_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      assignment_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_training_plan_assignment_items_org_id_id_uniq
        UNIQUE (org_id, id),
      CONSTRAINT elearning_training_plan_assignment_items_group_item_uniq
        UNIQUE (org_id, training_plan_assignment_id, training_plan_item_id),
      CONSTRAINT elearning_training_plan_assignment_items_assignment_uniq
        UNIQUE (org_id, assignment_id),
      CONSTRAINT elearning_training_plan_assignment_items_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_training_plan_assignment_items_group_fk
        FOREIGN KEY (
          org_id, training_plan_assignment_id, training_plan_version_id
        )
        REFERENCES elearning_training_plan_assignments (
          org_id, id, training_plan_version_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT elearning_training_plan_assignment_items_plan_item_fk
        FOREIGN KEY (
          org_id,
          training_plan_item_id,
          training_plan_version_id,
          course_version_id
        )
        REFERENCES elearning_training_plan_items (
          org_id,
          id,
          training_plan_version_id,
          course_version_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT elearning_training_plan_assignment_items_assignment_fk
        FOREIGN KEY (org_id, assignment_id, course_version_id)
        REFERENCES elearning_assignments (org_id, id, course_version_id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_training_plan_assignment_group_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      normalized_member_ids text[];
      plan_status text;
      version_status text;
      active_version_id uuid;
      plan_item_count integer;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'training plan assignments are append-only';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'training plan assignments are immutable';
      END IF;

      SELECT array_agg(member_id ORDER BY member_id)
        INTO normalized_member_ids
        FROM (
          SELECT DISTINCT member_id
          FROM unnest(NEW.member_ids) AS members(member_id)
          WHERE btrim(member_id) <> ''
        ) normalized;
      IF normalized_member_ids IS DISTINCT FROM NEW.member_ids THEN
        RAISE EXCEPTION 'training plan assignment members must be sorted, unique, and non-empty';
      END IF;

      SELECT plan.status, plan.active_version_id, version.status
        INTO plan_status, active_version_id, version_status
        FROM elearning_training_plans plan
        JOIN elearning_training_plan_versions version
          ON version.org_id = plan.org_id
         AND version.training_plan_id = plan.id
         AND version.id = NEW.training_plan_version_id
       WHERE plan.org_id = NEW.org_id
         AND plan.id = NEW.training_plan_id
       FOR SHARE OF plan, version;
      IF NOT FOUND
         OR plan_status IS DISTINCT FROM 'active'
         OR active_version_id IS DISTINCT FROM NEW.training_plan_version_id
         OR version_status IS DISTINCT FROM 'published' THEN
        RAISE EXCEPTION 'training plan assignment requires the active published plan version';
      END IF;

      SELECT count(*)::integer
        INTO plan_item_count
        FROM elearning_training_plan_items item
       WHERE item.org_id = NEW.org_id
         AND item.training_plan_version_id = NEW.training_plan_version_id;
      IF plan_item_count IS DISTINCT FROM NEW.course_count THEN
        RAISE EXCEPTION 'training plan assignment course count must match the pinned plan version';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_assignment_group_guard
      BEFORE INSERT OR UPDATE OR DELETE
      ON elearning_training_plan_assignments
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_assignment_group_guard()
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_training_plan_assignment_link_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      group_deadline timestamptz;
      group_assigned_by text;
      group_snapshot jsonb;
      group_member_ids text[];
      assignment_deadline timestamptz;
      assignment_assigned_by text;
      assignment_snapshot jsonb;
      course_status text;
      version_status text;
      assignment_member_ids text[];
      invalid_member_count integer;
    BEGIN
      SELECT
        plan_assignment.deadline,
        plan_assignment.assigned_by,
        plan_assignment.target_snapshot,
        plan_assignment.member_ids,
        assignment.deadline,
        assignment.assigned_by,
        assignment.target_snapshot,
        course.status,
        course_version.status
      INTO
        group_deadline,
        group_assigned_by,
        group_snapshot,
        group_member_ids,
        assignment_deadline,
        assignment_assigned_by,
        assignment_snapshot,
        course_status,
        version_status
      FROM elearning_training_plan_assignments plan_assignment
      JOIN elearning_training_plan_items plan_item
        ON plan_item.org_id = plan_assignment.org_id
       AND plan_item.id = NEW.training_plan_item_id
       AND plan_item.training_plan_version_id = plan_assignment.training_plan_version_id
       AND plan_item.course_version_id = NEW.course_version_id
      JOIN elearning_assignments assignment
        ON assignment.org_id = plan_assignment.org_id
       AND assignment.id = NEW.assignment_id
       AND assignment.course_version_id = NEW.course_version_id
      JOIN elearning_course_versions course_version
        ON course_version.org_id = assignment.org_id
       AND course_version.id = assignment.course_version_id
      JOIN elearning_courses course
        ON course.org_id = course_version.org_id
       AND course.id = course_version.course_id
      WHERE plan_assignment.org_id = NEW.org_id
        AND plan_assignment.id = NEW.training_plan_assignment_id
        AND plan_assignment.training_plan_version_id = NEW.training_plan_version_id
      FOR SHARE OF plan_assignment, plan_item, assignment, course_version, course;

      IF NOT FOUND
         OR group_deadline IS DISTINCT FROM assignment_deadline
         OR group_assigned_by IS DISTINCT FROM assignment_assigned_by
         OR group_snapshot IS DISTINCT FROM assignment_snapshot
         OR course_status IS DISTINCT FROM 'active'
         OR version_status IS DISTINCT FROM 'published' THEN
        RAISE EXCEPTION 'training plan assignment link is inconsistent';
      END IF;

      SELECT
        array_agg(member.user_id ORDER BY member.user_id),
        count(*) FILTER (
          WHERE member.source IS DISTINCT FROM 'rule'
             OR member.revoked_at IS NOT NULL
        )::integer
      INTO assignment_member_ids, invalid_member_count
      FROM elearning_assignment_members member
      WHERE member.org_id = NEW.org_id
        AND member.assignment_id = NEW.assignment_id
        AND member.course_version_id = NEW.course_version_id;

      IF assignment_member_ids IS DISTINCT FROM group_member_ids
         OR invalid_member_count IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'training plan assignment member set is inconsistent';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_assignment_link_guard
      BEFORE INSERT ON elearning_training_plan_assignment_items
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_assignment_link_guard()
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_training_plan_assignment_link_immutable()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'training plan assignment links are append-only';
      END IF;
      RAISE EXCEPTION 'training plan assignment links are immutable';
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_assignment_link_immutable
      BEFORE UPDATE OR DELETE ON elearning_training_plan_assignment_items
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_assignment_link_immutable()
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_training_plan_child_assignment_deadline_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF NEW.deadline IS DISTINCT FROM OLD.deadline
         AND EXISTS (
           SELECT 1
           FROM elearning_training_plan_assignment_items link
           WHERE link.org_id = OLD.org_id
             AND link.assignment_id = OLD.id
         ) THEN
        RAISE EXCEPTION 'linked training plan assignment deadline is immutable';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_child_assignment_deadline_guard
      BEFORE UPDATE OF deadline ON elearning_assignments
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_child_assignment_deadline_guard()
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_training_plan_child_member_insert_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      expected_member_ids text[];
    BEGIN
      SELECT plan_assignment.member_ids
        INTO expected_member_ids
        FROM elearning_training_plan_assignment_items link
        JOIN elearning_training_plan_assignments plan_assignment
          ON plan_assignment.org_id = link.org_id
         AND plan_assignment.id = link.training_plan_assignment_id
       WHERE link.org_id = NEW.org_id
         AND link.assignment_id = NEW.assignment_id
       FOR SHARE OF link, plan_assignment;
      IF FOUND
         AND (
           NEW.source IS DISTINCT FROM 'rule'
           OR NOT (NEW.user_id = ANY(expected_member_ids))
         ) THEN
        RAISE EXCEPTION 'linked training plan assignment members are frozen';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_child_member_insert_guard
      BEFORE INSERT ON elearning_assignment_members
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_child_member_insert_guard()
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_training_plan_child_member_revoke_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF (
        NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
        OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason
      )
      AND EXISTS (
        SELECT 1
        FROM elearning_training_plan_assignment_items link
        WHERE link.org_id = OLD.org_id
          AND link.assignment_id = OLD.assignment_id
      ) THEN
        RAISE EXCEPTION 'training plan child members require plan-level revocation';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_training_plan_child_member_revoke_guard
      BEFORE UPDATE OF revoked_at, revoked_by, revocation_reason
      ON elearning_assignment_members
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_child_member_revoke_guard()
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_training_plan_assignment_complete()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      group_id uuid;
      expected_count integer;
      actual_count integer;
    BEGIN
      IF TG_TABLE_NAME = 'elearning_training_plan_assignments' THEN
        group_id := NEW.id;
      ELSE
        group_id := (to_jsonb(NEW)->>'training_plan_assignment_id')::uuid;
      END IF;
      SELECT course_count
        INTO expected_count
        FROM elearning_training_plan_assignments
       WHERE org_id = NEW.org_id
         AND id = group_id;
      SELECT count(*)::integer
        INTO actual_count
        FROM elearning_training_plan_assignment_items
       WHERE org_id = NEW.org_id
         AND training_plan_assignment_id = group_id;
      IF expected_count IS NULL OR actual_count IS DISTINCT FROM expected_count THEN
        RAISE EXCEPTION 'training plan assignment must link every plan item exactly once';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE CONSTRAINT TRIGGER trg_elearning_training_plan_assignment_complete_group
      AFTER INSERT ON elearning_training_plan_assignments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_assignment_complete()
  `.execute(db)

  await sql`
    CREATE CONSTRAINT TRIGGER trg_elearning_training_plan_assignment_complete_link
      AFTER INSERT ON elearning_training_plan_assignment_items
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION elearning_training_plan_assignment_complete()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    LOCK TABLE
      elearning_training_plan_assignments,
      elearning_training_plan_assignment_items
    IN SHARE ROW EXCLUSIVE MODE
  `.execute(db)

  await sql`
    DO $fn$
    BEGIN
      IF EXISTS (SELECT 1 FROM elearning_training_plan_assignments) THEN
        RAISE EXCEPTION 'ELEARNING_TRAINING_PLAN_ASSIGNMENT_DOWN_IN_USE';
      END IF;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER trg_elearning_training_plan_assignment_complete_link
      ON elearning_training_plan_assignment_items
  `.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_training_plan_assignment_complete_group
      ON elearning_training_plan_assignments
  `.execute(db)
  await sql`DROP FUNCTION elearning_training_plan_assignment_complete()`.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_training_plan_child_member_revoke_guard
      ON elearning_assignment_members
  `.execute(db)
  await sql`DROP FUNCTION elearning_training_plan_child_member_revoke_guard()`.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_training_plan_child_member_insert_guard
      ON elearning_assignment_members
  `.execute(db)
  await sql`DROP FUNCTION elearning_training_plan_child_member_insert_guard()`.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_training_plan_child_assignment_deadline_guard
      ON elearning_assignments
  `.execute(db)
  await sql`DROP FUNCTION elearning_training_plan_child_assignment_deadline_guard()`.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_training_plan_assignment_link_immutable
      ON elearning_training_plan_assignment_items
  `.execute(db)
  await sql`DROP FUNCTION elearning_training_plan_assignment_link_immutable()`.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_training_plan_assignment_link_guard
      ON elearning_training_plan_assignment_items
  `.execute(db)
  await sql`DROP FUNCTION elearning_training_plan_assignment_link_guard()`.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_training_plan_assignment_group_guard
      ON elearning_training_plan_assignments
  `.execute(db)
  await sql`DROP FUNCTION elearning_training_plan_assignment_group_guard()`.execute(db)
  await sql`DROP TABLE elearning_training_plan_assignment_items`.execute(db)
  await sql`DROP TABLE elearning_training_plan_assignments`.execute(db)
  await sql`
    ALTER TABLE elearning_training_plan_items
      DROP CONSTRAINT elearning_plan_items_org_id_version_course_uniq
  `.execute(db)
}
