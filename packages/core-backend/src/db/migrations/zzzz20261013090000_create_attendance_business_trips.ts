import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const priorTypes = "'missed_check_in','missed_check_out','time_correction','leave','overtime','outdoor_punch','shift_swap','schedule_dispatch'"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db)
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT attendance_requests_type_check`.execute(db)
  await sql.raw(`ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_type_check CHECK (request_type IN (${priorTypes},'business_trip'))`).execute(db)
  await sql`
    CREATE TABLE attendance_business_trip_requests (
      request_id uuid PRIMARY KEY REFERENCES attendance_requests(id),
      org_id text NOT NULL,
      user_id text NOT NULL REFERENCES users(id),
      approval_instance_id text NOT NULL REFERENCES approval_instances(id),
      destination_timezone text NOT NULL,
      start_at timestamptz NOT NULL,
      end_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (request_id, org_id, user_id),
      CHECK (isfinite(start_at) AND isfinite(end_at) AND start_at < end_at)
    )
  `.execute(db)
  await sql`
    CREATE TABLE attendance_business_trip_arrangements (
      request_id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      destination_timezone text NOT NULL,
      start_at timestamptz NOT NULL,
      end_at timestamptz NOT NULL,
      effective_end_at timestamptz NOT NULL,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      published_at timestamptz NOT NULL DEFAULT now(),
      cancelled_at timestamptz,
      FOREIGN KEY (request_id, org_id, user_id) REFERENCES attendance_business_trip_requests(request_id, org_id, user_id),
      CHECK (isfinite(start_at) AND isfinite(end_at) AND isfinite(effective_end_at)
        AND start_at < end_at AND effective_end_at >= start_at AND effective_end_at <= end_at),
      EXCLUDE USING gist (org_id WITH =, user_id WITH =, tstzrange(start_at,effective_end_at,'[)') WITH &&)
    )
  `.execute(db)
  await sql`
    CREATE FUNCTION attendance_business_trip_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE request_row attendance_requests%ROWTYPE;
      detail_row attendance_business_trip_requests%ROWTYPE;
      instance_row approval_instances%ROWTYPE;
    BEGIN
      IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'ATTENDANCE_TRIP_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
      IF TG_TABLE_NAME = 'attendance_business_trip_requests' AND TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'ATTENDANCE_TRIP_DETAIL_IMMUTABLE' USING ERRCODE='23514';
      END IF;
      SELECT * INTO request_row FROM attendance_requests WHERE id=NEW.request_id;
      IF NOT FOUND OR request_row.org_id IS DISTINCT FROM NEW.org_id
        OR request_row.user_id IS DISTINCT FROM NEW.user_id OR request_row.request_type <> 'business_trip' THEN
        RAISE EXCEPTION 'ATTENDANCE_TRIP_REQUEST_BINDING' USING ERRCODE='23514';
      END IF;
      SELECT * INTO instance_row FROM approval_instances WHERE id=request_row.approval_instance_id;
      IF NOT FOUND OR instance_row.org_id IS DISTINCT FROM NEW.org_id
        OR instance_row.workflow_key IS DISTINCT FROM 'attendance.request' THEN
        RAISE EXCEPTION 'ATTENDANCE_TRIP_APPROVAL_BINDING' USING ERRCODE='23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.destination_timezone)
        OR NEW.destination_timezone <> btrim(NEW.destination_timezone) THEN
        RAISE EXCEPTION 'ATTENDANCE_TRIP_INVALID_ZONE' USING ERRCODE='23514';
      END IF;
      IF TG_TABLE_NAME = 'attendance_business_trip_requests' THEN
        IF NEW.approval_instance_id IS DISTINCT FROM request_row.approval_instance_id OR request_row.status <> 'pending'
          OR instance_row.status <> 'pending' THEN
          RAISE EXCEPTION 'ATTENDANCE_TRIP_APPROVAL_BINDING' USING ERRCODE='23514';
        END IF;
      ELSE
        SELECT * INTO detail_row FROM attendance_business_trip_requests WHERE request_id=NEW.request_id;
        IF (NEW.org_id,NEW.user_id,NEW.destination_timezone,NEW.start_at,NEW.end_at)
          IS DISTINCT FROM (detail_row.org_id,detail_row.user_id,detail_row.destination_timezone,detail_row.start_at,detail_row.end_at) THEN
          RAISE EXCEPTION 'ATTENDANCE_TRIP_DETAIL_BINDING' USING ERRCODE='23514';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF request_row.status <> 'approved' OR instance_row.status <> 'approved' OR NEW.version <> 1
            OR NEW.effective_end_at <> NEW.end_at OR NEW.cancelled_at IS NOT NULL THEN
            RAISE EXCEPTION 'ATTENDANCE_TRIP_FINAL_APPROVAL_REQUIRED' USING ERRCODE='23514';
          END IF;
        ELSE
          IF (NEW.request_id,NEW.org_id,NEW.user_id,NEW.destination_timezone,NEW.start_at,NEW.end_at,NEW.published_at)
            IS DISTINCT FROM (OLD.request_id,OLD.org_id,OLD.user_id,OLD.destination_timezone,OLD.start_at,OLD.end_at,OLD.published_at)
            OR OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL
            OR NEW.effective_end_at > OLD.effective_end_at OR NEW.version <> OLD.version + 1
            OR request_row.status <> 'cancelled' OR instance_row.status <> 'cancelled' THEN
            RAISE EXCEPTION 'ATTENDANCE_TRIP_CANCELLATION_REQUIRED' USING ERRCODE='23514';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $fn$
  `.execute(db)
  await sql`
    CREATE FUNCTION attendance_business_trip_request_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.request_type = 'business_trip' OR NEW.request_type = 'business_trip' THEN
        IF (NEW.id,NEW.org_id,NEW.user_id,NEW.request_type,NEW.work_date,
            NEW.requested_in_at,NEW.requested_out_at,NEW.approval_instance_id,NEW.approval_workflow_key)
          IS DISTINCT FROM
           (OLD.id,OLD.org_id,OLD.user_id,OLD.request_type,OLD.work_date,
            OLD.requested_in_at,OLD.requested_out_at,OLD.approval_instance_id,OLD.approval_workflow_key) THEN
          RAISE EXCEPTION 'ATTENDANCE_TRIP_REQUEST_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $fn$
  `.execute(db)
  await sql`CREATE TRIGGER attendance_business_trip_request_identity_guard
    BEFORE UPDATE ON attendance_requests FOR EACH ROW
    EXECUTE FUNCTION attendance_business_trip_request_identity_guard()`.execute(db)
  for (const table of ['attendance_business_trip_requests', 'attendance_business_trip_arrangements']) {
    await sql.raw(`CREATE TRIGGER ${table}_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION attendance_business_trip_guard()`).execute(db)
    await sql.raw(`CREATE TRIGGER ${table}_truncate_guard BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION attendance_business_trip_guard()`).execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $fn$ BEGIN
    IF EXISTS (SELECT 1 FROM attendance_requests WHERE request_type='business_trip')
      OR EXISTS (SELECT 1 FROM attendance_business_trip_requests)
      OR EXISTS (SELECT 1 FROM attendance_business_trip_arrangements) THEN
      RAISE EXCEPTION 'ATTENDANCE_TRIP_ROLLBACK_BLOCKED';
    END IF;
  END $fn$`.execute(db)
  await sql`DROP TRIGGER attendance_business_trip_request_identity_guard ON attendance_requests`.execute(db)
  await sql`DROP FUNCTION attendance_business_trip_request_identity_guard()`.execute(db)
  await sql`DROP TABLE attendance_business_trip_arrangements`.execute(db)
  await sql`DROP TABLE attendance_business_trip_requests`.execute(db)
  await sql`DROP FUNCTION attendance_business_trip_guard()`.execute(db)
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT attendance_requests_type_check`.execute(db)
  await sql.raw(`ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_type_check CHECK (request_type IN (${priorTypes}))`).execute(db)
}
