/**
 * Per-user import-template field-picker memory (attendance-import-template-prefs
 * design-lock §1, RATIFIED 2026-07-07): remembers which fields a user last
 * selected in the "选择字段，生成导入模板" picker, server-side so it follows the
 * user across browsers/devices.
 *
 * Governance (mirrors multitable personal-views lock §7 Q1): `user_id` is ALWAYS
 * the authenticated actor — never a client-supplied value. Stores targetField
 * keys only (no display copy), so vocabulary evolution is absorbed by the
 * frontend intersection, never by data migration.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_import_template_prefs (
      org_id text NOT NULL,
      user_id text NOT NULL,
      selected_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, user_id)
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS attendance_import_template_prefs`.execute(db)
}
