import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_timezone_context_companions (
      record_id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      work_date date NOT NULL,
      schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
      timezone text NOT NULL CHECK (btrim(timezone) <> '' AND timezone = btrim(timezone)),
      absolute_start_at timestamptz NOT NULL CHECK (isfinite(absolute_start_at)),
      absolute_end_at timestamptz NOT NULL CHECK (isfinite(absolute_end_at)),
      attribution_start_at timestamptz NOT NULL CHECK (isfinite(attribution_start_at)),
      attribution_end_at timestamptz NOT NULL CHECK (isfinite(attribution_end_at)),
      context_fingerprint text NOT NULL CHECK (context_fingerprint ~ '^[0-9a-f]{64}$'),
      original_freeze_fingerprint text NOT NULL CHECK (original_freeze_fingerprint ~ '^[0-9a-f]{64}$'),
      original_calculation_id uuid,
      frame_snapshot jsonb NOT NULL CHECK (jsonb_typeof(frame_snapshot) = 'object'),
      original_freeze_snapshot jsonb NOT NULL CHECK (jsonb_typeof(original_freeze_snapshot) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, user_id, work_date),
      FOREIGN KEY (record_id, org_id) REFERENCES attendance_records(id, org_id),
      FOREIGN KEY (original_calculation_id, record_id, org_id)
        REFERENCES attendance_record_calculations(id, attendance_record_id, org_id),
      CHECK (absolute_end_at > absolute_start_at),
      CHECK (attribution_start_at = absolute_start_at AND attribution_end_at >= absolute_end_at)
    );
    CREATE INDEX IF NOT EXISTS attendance_timezone_context_open_lookup
      ON attendance_timezone_context_companions (org_id, user_id, attribution_start_at, attribution_end_at);
    CREATE OR REPLACE FUNCTION attendance_timezone_context_companion_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      PERFORM 1 FROM attendance_records r
       WHERE r.id = NEW.record_id AND r.org_id = NEW.org_id
         AND r.user_id = NEW.user_id AND r.work_date = NEW.work_date
         AND r.timezone = NEW.timezone FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_FROZEN_REFERENCE_INVALID' USING ERRCODE = '23503';
      END IF;
      IF NEW.original_calculation_id IS NOT NULL THEN
        PERFORM 1 FROM attendance_record_calculations c
         WHERE c.id = NEW.original_calculation_id AND c.attendance_record_id = NEW.record_id AND c.org_id = NEW.org_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_FROZEN_REFERENCE_INVALID' USING ERRCODE = '23503';
        END IF;
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS attendance_timezone_context_companion_immutable ON attendance_timezone_context_companions;
    CREATE TRIGGER attendance_timezone_context_companion_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON attendance_timezone_context_companions
      FOR EACH ROW EXECUTE FUNCTION attendance_timezone_context_companion_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM attendance_timezone_context_companions) THEN
        RAISE EXCEPTION 'ATTENDANCE_TIMEZONE_FROZEN_DOWN_DATA_PRESENT' USING ERRCODE = '23514';
      END IF;
    END $$;
    DROP TABLE attendance_timezone_context_companions;
    DROP FUNCTION attendance_timezone_context_companion_guard()
  `.execute(db)
}
