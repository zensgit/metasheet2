import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db)
  await sql`
    ALTER TABLE attendance_rules ADD COLUMN IF NOT EXISTS timezone_version integer
      NOT NULL DEFAULT 1 CHECK (timezone_version > 0)
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_timezone_rule_revision_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.timezone_version <> 1 THEN
          RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_INVALID_REVISION' USING ERRCODE = '23514';
        END IF;
      ELSE
        IF NEW.timezone_version <> OLD.timezone_version THEN
          RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_INVALID_REVISION' USING ERRCODE = '23514';
        END IF;
        IF NEW.timezone IS DISTINCT FROM OLD.timezone THEN
          NEW.timezone_version := OLD.timezone_version + 1;
        END IF;
      END IF;
      RETURN NEW;
    END; $$
  `.execute(db)
  await sql`
    DROP TRIGGER IF EXISTS attendance_timezone_rule_revision ON attendance_rules;
    CREATE TRIGGER attendance_timezone_rule_revision BEFORE INSERT OR UPDATE ON attendance_rules
      FOR EACH ROW EXECUTE FUNCTION attendance_timezone_rule_revision_guard()
  `.execute(db)
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_timezone_policies (
      org_id text PRIMARY KEY CHECK (btrim(org_id) <> ''),
      enabled boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS attendance_employee_timezone_overrides (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL CHECK (btrim(org_id) <> ''),
      user_id text NOT NULL CHECK (btrim(user_id) <> ''),
      timezone text NOT NULL CHECK (btrim(timezone) <> '' AND timezone = btrim(timezone)),
      effective_from timestamptz NOT NULL CHECK (isfinite(effective_from)),
      effective_to timestamptz CHECK (isfinite(effective_to)),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_by text NOT NULL CHECK (btrim(created_by) <> ''),
      updated_by text NOT NULL CHECK (btrim(updated_by) <> ''),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attendance_employee_timezone_bounds_valid
        CHECK (effective_to IS NULL OR effective_to > effective_from),
      CONSTRAINT attendance_employee_timezone_no_overlap
        EXCLUDE USING gist (
          org_id WITH =, user_id WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        )
    );
    CREATE TABLE IF NOT EXISTS attendance_timezone_policy_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL CHECK (btrim(org_id) <> ''),
      actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
      action text NOT NULL CHECK (action IN ('policy_set', 'override_created', 'override_closed')),
      reference_id text NOT NULL CHECK (btrim(reference_id) <> ''),
      version integer NOT NULL CHECK (version > 0),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_timezone_policy_revision_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (TG_OP = 'INSERT' AND NEW.version <> 1)
        OR (TG_OP = 'UPDATE' AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.version <> OLD.version + 1)) THEN
        RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_INVALID_REVISION' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS attendance_timezone_policy_revision ON attendance_timezone_policies;
    CREATE TRIGGER attendance_timezone_policy_revision BEFORE INSERT OR UPDATE
      ON attendance_timezone_policies FOR EACH ROW
      EXECUTE FUNCTION attendance_timezone_policy_revision_guard()
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_employee_timezone_member_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.version <> 1 THEN
          RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_INVALID_REVISION' USING ERRCODE = '23514';
        END IF;
      ELSE
        IF NEW.version <> OLD.version + 1
          OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
          OR NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
          OR NEW.created_by IS DISTINCT FROM OLD.created_by
          OR (OLD.effective_to IS NOT NULL AND (NEW.effective_to IS NULL OR NEW.effective_to > OLD.effective_to)) THEN
          RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_IMMUTABLE_OVERRIDE' USING ERRCODE = '23514';
        END IF;
      END IF;
      PERFORM 1 FROM users u JOIN user_orgs uo ON uo.user_id = u.id
       WHERE u.id = NEW.user_id AND uo.org_id = NEW.org_id
         AND u.is_active = true AND uo.is_active = true
       FOR UPDATE OF u, uo;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED'
          USING ERRCODE = '23503', CONSTRAINT = 'attendance_employee_timezone_member_required';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
        RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_INVALID_ZONE' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END; $$
  `.execute(db)
  await sql`
    DROP TRIGGER IF EXISTS attendance_employee_timezone_member ON attendance_employee_timezone_overrides;
    CREATE TRIGGER attendance_employee_timezone_member BEFORE INSERT OR UPDATE
      ON attendance_employee_timezone_overrides FOR EACH ROW
      EXECUTE FUNCTION attendance_employee_timezone_member_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rollback must not silently delete configuration or governed source revisions.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM attendance_timezone_policies)
        OR EXISTS (SELECT 1 FROM attendance_employee_timezone_overrides)
        OR EXISTS (SELECT 1 FROM attendance_timezone_policy_audit)
        OR EXISTS (SELECT 1 FROM attendance_rules WHERE timezone_version > 1) THEN
        RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_ROLLBACK_BLOCKED' USING ERRCODE = '55000';
      END IF;
    END; $$
  `.execute(db)
  await sql`
    DROP TABLE attendance_timezone_policy_audit;
    DROP TABLE attendance_employee_timezone_overrides;
    DROP TABLE attendance_timezone_policies;
    DROP FUNCTION attendance_timezone_policy_revision_guard();
    DROP FUNCTION attendance_employee_timezone_member_guard();
    DROP TRIGGER attendance_timezone_rule_revision ON attendance_rules;
    DROP FUNCTION attendance_timezone_rule_revision_guard();
    ALTER TABLE attendance_rules DROP COLUMN timezone_version
  `.execute(db)
}
