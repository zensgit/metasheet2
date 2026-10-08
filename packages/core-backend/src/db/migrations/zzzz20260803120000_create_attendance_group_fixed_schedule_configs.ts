import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const TABLE = 'attendance_group_fixed_schedule_configs'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_group_fixed_schedule_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      group_id uuid NOT NULL,
      shift_id uuid NOT NULL,
      start_date date NOT NULL,
      end_date date NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attendance_group_fixed_schedule_configs_org_group_unique
        UNIQUE (org_id, group_id),
      CONSTRAINT attendance_group_fixed_schedule_configs_dates_valid
        CHECK (start_date <= end_date),
      CONSTRAINT attendance_group_fixed_schedule_configs_revision_valid
        CHECK (revision >= 1),
      CONSTRAINT attendance_group_fixed_schedule_configs_group_org_fk
        FOREIGN KEY (group_id, org_id)
        REFERENCES attendance_groups(id, org_id)
        ON DELETE CASCADE,
      CONSTRAINT attendance_group_fixed_schedule_configs_shift_org_fk
        FOREIGN KEY (shift_id, org_id)
        REFERENCES attendance_shifts(id, org_id)
        ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_group_fixed_schedule_configs_org_shift
      ON attendance_group_fixed_schedule_configs(org_id, shift_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
}
