import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const TABLE = 'attendance_org_resolution_shadow'

/**
 * SHADOW audit table for `plugins/plugin-attendance/lib/attendance-org-resolution-shadow.cjs`
 * (env `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1=shadow`, POST /api/attendance/punch only).
 * One row per punch on that posture, comparing the org the route actually used against what a
 * claim/membership-driven resolution would independently have picked. Never read by the punch
 * route itself and never gates anything — see that module's doc comment for the full contract.
 * Exactly the columns the module writes; no CHECK/index/uniqueness beyond what it needs today.
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
}
