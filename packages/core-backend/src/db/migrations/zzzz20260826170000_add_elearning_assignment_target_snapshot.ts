import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export const ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_COLUMN = 'target_snapshot'
export const ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_CHECK =
  'elearning_assignments_target_snapshot_chk'
export const ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_VALID_FN =
  'elearning_assignment_target_snapshot_valid'
export const ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_GUARD_FN =
  'elearning_assignment_target_snapshot_guard'
export const ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_GUARD_TRIGGER =
  'trg_elearning_assignment_target_snapshot_guard'
export const ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_DOWN_IN_USE =
  'ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_DOWN_IN_USE'

/**
 * Adds the immutable audience-rule snapshot used by L2 batch assignments.
 * Existing/direct assignments remain NULL. Batch writers persist a non-empty,
 * normalized array and materialize members separately.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE elearning_assignments IN SHARE ROW EXCLUSIVE MODE`.execute(db)

  await sql`
    CREATE FUNCTION elearning_assignment_target_snapshot_valid(snapshot jsonb)
    RETURNS boolean
    LANGUAGE plpgsql
    IMMUTABLE
    STRICT
    AS $$
    DECLARE
      item jsonb;
      subject_type text;
      include_children boolean;
    BEGIN
      IF jsonb_typeof(snapshot) <> 'array'
         OR jsonb_array_length(snapshot) < 1
         OR jsonb_array_length(snapshot) > 100 THEN
        RETURN FALSE;
      END IF;

      FOR item IN SELECT value FROM jsonb_array_elements(snapshot)
      LOOP
        IF jsonb_typeof(item) <> 'object'
           OR NOT (item ?& ARRAY['subjectType', 'subjectRef', 'includeChildren'])
           OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 3
           OR jsonb_typeof(item->'subjectType') <> 'string'
           OR jsonb_typeof(item->'includeChildren') <> 'boolean' THEN
          RETURN FALSE;
        END IF;

        subject_type := item->>'subjectType';
        include_children := (item->>'includeChildren')::boolean;
        IF subject_type NOT IN ('all', 'department', 'position', 'user') THEN
          RETURN FALSE;
        END IF;

        IF subject_type = 'all' THEN
          IF item->'subjectRef' <> 'null'::jsonb OR include_children THEN
            RETURN FALSE;
          END IF;
        ELSE
          IF jsonb_typeof(item->'subjectRef') <> 'string'
             OR btrim(item->>'subjectRef') = ''
             OR (subject_type <> 'department' AND include_children) THEN
            RETURN FALSE;
          END IF;
          IF subject_type = 'department'
             AND (item->>'subjectRef') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RETURN FALSE;
          END IF;
        END IF;
      END LOOP;
      RETURN TRUE;
    END;
    $$
  `.execute(db)

  await sql`ALTER TABLE elearning_assignments ADD COLUMN target_snapshot jsonb`.execute(db)
  await sql`
    ALTER TABLE elearning_assignments
      ADD CONSTRAINT elearning_assignments_target_snapshot_chk
      CHECK (
        target_snapshot IS NULL
        OR elearning_assignment_target_snapshot_valid(target_snapshot)
      )
  `.execute(db)
  await sql`
    CREATE FUNCTION elearning_assignment_target_snapshot_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.target_snapshot IS DISTINCT FROM OLD.target_snapshot THEN
        RAISE EXCEPTION 'elearning_assignments target snapshot is immutable';
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_assignment_target_snapshot_guard
      BEFORE UPDATE ON elearning_assignments
      FOR EACH ROW
      EXECUTE FUNCTION elearning_assignment_target_snapshot_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE elearning_assignments IN SHARE ROW EXCLUSIVE MODE`.execute(db)
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM elearning_assignments WHERE target_snapshot IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'ELEARNING_ASSIGNMENT_TARGET_SNAPSHOT_DOWN_IN_USE';
      END IF;
    END;
    $$
  `.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_assignment_target_snapshot_guard
      ON elearning_assignments
  `.execute(db)
  await sql`DROP FUNCTION elearning_assignment_target_snapshot_guard()`.execute(db)
  await sql`
    ALTER TABLE elearning_assignments
      DROP CONSTRAINT elearning_assignments_target_snapshot_chk,
      DROP COLUMN target_snapshot
  `.execute(db)
  await sql`DROP FUNCTION elearning_assignment_target_snapshot_valid(jsonb)`.execute(db)
}
