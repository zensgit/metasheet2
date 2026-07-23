import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const GROUP_ORG_UNIQUE = 'attendance_groups_id_org_unique'
const MEMBERSHIP_USER_ORG_TRIGGER = 'attendance_calculation_group_memberships_user_org_guard'
const MEMBERSHIP_USER_ORG_FUNCTION = 'guard_attendance_calculation_group_membership_user_org'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db)

  await sql.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = '${GROUP_ORG_UNIQUE}'
           AND conrelid = 'attendance_groups'::regclass
      ) THEN
        ALTER TABLE attendance_groups
          ADD CONSTRAINT attendance_groups_id_org_unique UNIQUE (id, org_id);
      END IF;
    END $$;
  `).execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_calculation_group_memberships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      group_id uuid NOT NULL,
      effective_from date NOT NULL,
      effective_to date,
      assigned_by text NOT NULL,
      assigned_reason text NOT NULL,
      assigned_correlation_id text NOT NULL,
      closed_by text,
      closed_reason text,
      closed_correlation_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attendance_calc_group_membership_id_org_unique
        UNIQUE (id, org_id),
      CONSTRAINT attendance_calc_group_membership_dates_valid
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
      CONSTRAINT attendance_calc_group_membership_assignment_audit_valid
        CHECK (
          btrim(assigned_by) <> ''
          AND btrim(assigned_reason) <> ''
          AND btrim(assigned_correlation_id) <> ''
        ),
      CONSTRAINT attendance_calc_group_membership_close_audit_valid
        CHECK (
          (closed_by IS NULL AND closed_reason IS NULL AND closed_correlation_id IS NULL)
          OR (
            closed_by IS NOT NULL
            AND closed_reason IS NOT NULL
            AND closed_correlation_id IS NOT NULL
            AND btrim(closed_by) <> ''
            AND btrim(closed_reason) <> ''
            AND btrim(closed_correlation_id) <> ''
          )
        ),
      CONSTRAINT attendance_calc_group_membership_group_org_fk
        FOREIGN KEY (group_id, org_id)
        REFERENCES attendance_groups(id, org_id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_calc_group_memberships_timeline
      ON attendance_calculation_group_memberships(org_id, user_id, effective_from)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_calc_group_memberships_group
      ON attendance_calculation_group_memberships(org_id, group_id)
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'attendance_calc_group_memberships_no_overlap'
           AND conrelid = 'attendance_calculation_group_memberships'::regclass
      ) THEN
        ALTER TABLE attendance_calculation_group_memberships
          ADD CONSTRAINT attendance_calc_group_memberships_no_overlap
          EXCLUDE USING gist (
            org_id WITH =,
            user_id WITH =,
            daterange(
              effective_from,
              COALESCE(effective_to, 'infinity'::date),
              '[]'
            ) WITH &&
          );
      END IF;
    END $$;
  `.execute(db)

  // The trigger validates direct SQL writes without tying historical rows to the
  // lifecycle of user_orgs through a foreign key.
  await sql.raw(`
    CREATE OR REPLACE FUNCTION ${MEMBERSHIP_USER_ORG_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM 1
        FROM users u
        JOIN user_orgs uo
          ON uo.user_id = u.id
         AND uo.org_id = NEW.org_id
       WHERE u.id = NEW.user_id
         AND u.is_active = true
         AND uo.is_active = true
       FOR UPDATE OF u, uo;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'active user and org membership required'
          USING ERRCODE = '23503',
                CONSTRAINT = 'attendance_calc_group_membership_user_org_required';
      END IF;
      RETURN NEW;
    END;
    $$;
  `).execute(db)
  await sql.raw(`
    DROP TRIGGER IF EXISTS ${MEMBERSHIP_USER_ORG_TRIGGER}
      ON attendance_calculation_group_memberships;
    CREATE TRIGGER ${MEMBERSHIP_USER_ORG_TRIGGER}
      BEFORE INSERT OR UPDATE OF org_id, user_id, group_id, effective_from, effective_to
      ON attendance_calculation_group_memberships
      FOR EACH ROW
      EXECUTE FUNCTION ${MEMBERSHIP_USER_ORG_FUNCTION}();
  `).execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_calculation_group_membership_operations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      correlation_id text NOT NULL,
      user_id text NOT NULL,
      target_group_id uuid NOT NULL,
      effective_on date NOT NULL,
      actor_id text NOT NULL,
      reason text NOT NULL,
      result_membership_id uuid NOT NULL,
      result_snapshot jsonb NOT NULL,
      outcome text NOT NULL
        CHECK (outcome IN ('transitioned', 'unchanged')),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attendance_calc_group_membership_operation_audit_valid
        CHECK (
          btrim(correlation_id) <> ''
          AND btrim(actor_id) <> ''
          AND btrim(reason) <> ''
        ),
      CONSTRAINT attendance_calc_group_membership_operation_snapshot_valid
        CHECK (jsonb_typeof(result_snapshot) = 'object'),
      CONSTRAINT attendance_calc_group_membership_operation_group_org_fk
        FOREIGN KEY (target_group_id, org_id)
        REFERENCES attendance_groups(id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT attendance_calc_group_membership_operation_result_org_fk
        FOREIGN KEY (result_membership_id, org_id)
        REFERENCES attendance_calculation_group_memberships(id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT attendance_calc_group_membership_operations_correlation_unique
        UNIQUE (org_id, correlation_id)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_calc_group_membership_operations_user
      ON attendance_calculation_group_membership_operations(org_id, user_id, created_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropTable('attendance_calculation_group_membership_operations')
    .ifExists()
    .execute()
  await sql.raw(`
    DROP TRIGGER IF EXISTS ${MEMBERSHIP_USER_ORG_TRIGGER}
      ON attendance_calculation_group_memberships
  `).execute(db)
  await db.schema
    .dropTable('attendance_calculation_group_memberships')
    .ifExists()
    .execute()
  await sql.raw(`DROP FUNCTION IF EXISTS ${MEMBERSHIP_USER_ORG_FUNCTION}()`).execute(db)
  await sql`
    ALTER TABLE attendance_groups
      DROP CONSTRAINT IF EXISTS attendance_groups_id_org_unique
  `.execute(db)
}
