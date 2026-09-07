import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const TABLE = 'attendance_report_projection_anchors'
const IMMUTABLE_GUARD = 'attendance_report_projection_anchor_identity_guard'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_report_projection_anchors (
      projection_record_id text PRIMARY KEY
        REFERENCES meta_records(id) ON DELETE CASCADE ON UPDATE RESTRICT,
      org_id text NOT NULL CHECK (org_id = btrim(org_id) AND org_id <> ''),
      canonical_record_id uuid NOT NULL,
      source_selector text NOT NULL
        CHECK (source_selector IN ('current_calculation', 'latest_completed_calculation')),
      source_calculation_id uuid NOT NULL,
      source_calculation_version integer NOT NULL CHECK (source_calculation_version >= 1),
      canonical_source_digest char(64) NOT NULL
        CHECK (canonical_source_digest ~ '^[0-9a-f]{64}$'),
      source_fingerprint char(40) NOT NULL
        CHECK (source_fingerprint ~ '^[0-9a-f]{40}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_attendance_report_projection_anchor_canonical
        UNIQUE (org_id, canonical_record_id),
      CONSTRAINT fk_attendance_report_projection_anchor_record
        FOREIGN KEY (canonical_record_id, org_id)
        REFERENCES attendance_records(id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_attendance_report_projection_anchor_calculation
        FOREIGN KEY (source_calculation_id, canonical_record_id, org_id)
        REFERENCES attendance_record_calculations(id, attendance_record_id, org_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(IMMUTABLE_GUARD)}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF NEW.projection_record_id IS DISTINCT FROM OLD.projection_record_id
        OR NEW.org_id IS DISTINCT FROM OLD.org_id
        OR NEW.canonical_record_id IS DISTINCT FROM OLD.canonical_record_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'ATTENDANCE_CLEANING_ANCHOR_IDENTITY_IMMUTABLE';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_attendance_report_projection_anchor_identity ON ${sql.table(TABLE)}`.execute(db)
  await sql`
    CREATE TRIGGER trg_attendance_report_projection_anchor_identity
      BEFORE UPDATE ON ${sql.table(TABLE)}
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(IMMUTABLE_GUARD)}()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const present = await sql<{ present: boolean }>`SELECT to_regclass(${TABLE}) IS NOT NULL AS present`.execute(db)
  if (!present.rows[0]?.present) return
  const count = await sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql.table(TABLE)}`.execute(db)
  if (count.rows[0]?.count !== '0') throw new Error('ATTENDANCE_CLEANING_ANCHOR_DOWN_IN_USE')
  await sql`DROP TRIGGER IF EXISTS trg_attendance_report_projection_anchor_identity ON ${sql.table(TABLE)}`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(IMMUTABLE_GUARD)}()`.execute(db)
  await sql`DROP TABLE ${sql.table(TABLE)}`.execute(db)
}
