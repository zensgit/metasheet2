import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const TABLE = 'attendance_org_resolution_shadow'

/**
 * SHADOW audit table for `plugins/plugin-attendance/lib/attendance-org-resolution-shadow.cjs`
 * (env `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1=shadow`, POST /api/attendance/punch only).
 * One row per punch ATTEMPT that reaches that route's shadow call site on that posture (written
 * before geofence/validation/DML, so this counts attempts, not only successful punches — see
 * the module's doc comment), comparing the org the route actually used against what a
 * claim/membership-driven resolution would independently have picked. Never read by the punch
 * route itself and never gates anything.
 *
 * Two indexes support the read patterns an operator/analyst actually needs once `shadow` is on
 * anywhere (chronological scan; per-user chronological scan) — not exercised by the plugin
 * itself, which never reads this table. No retention/pruning policy exists yet for this table;
 * that is an explicit owner item, out of scope for this shadow-only PR.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_org_resolution_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      user_id text NOT NULL,
      route text NOT NULL,
      org_legacy text NOT NULL,
      org_claim text,
      request_org_supplied boolean NOT NULL,
      membership_count integer NOT NULL,
      non_default_membership_count integer NOT NULL,
      org_chosen text,
      agree boolean NOT NULL,
      rule text NOT NULL
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_org_resolution_shadow_created_at
      ON attendance_org_resolution_shadow (created_at)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_org_resolution_shadow_user_id_created_at
      ON attendance_org_resolution_shadow (user_id, created_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
}
