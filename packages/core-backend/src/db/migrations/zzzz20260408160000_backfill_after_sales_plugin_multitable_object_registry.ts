import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Backfills plugin ownership rows for after-sales installs that were created
 * before `plugin_multitable_object_registry` existed.
 *
 * We intentionally scope this migration to plugin-after-sales because its
 * install ledger already records `(project_id, created_objects_json)` and the
 * corresponding sheet ids are deterministic. The migration only inserts rows
 * for sheets that still exist in `meta_sheets`, so it does not create phantom
 * ownership for partially created or later-deleted objects.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    INSERT INTO plugin_multitable_object_registry (
      sheet_id,
      project_id,
      object_id,
      plugin_name
    )
    SELECT
      candidates.sheet_id,
      candidates.project_id,
      candidates.object_id,
      'plugin-after-sales'
    FROM (
      SELECT DISTINCT
        meta_sheets.id AS sheet_id,
        installs.project_id,
        created.object_id
      FROM plugin_after_sales_template_installs AS installs
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(installs.created_objects_json) = 'array'
            THEN installs.created_objects_json
          ELSE '[]'::jsonb
        END
      ) AS created(object_id)
      JOIN meta_sheets
        ON meta_sheets.id = (
          'sheet_' || substr(
            encode(public.digest((installs.project_id || ':' || created.object_id)::text, 'sha1'::text), 'hex'),
            1,
            24
          )
        )
       AND meta_sheets.deleted_at IS NULL
    ) AS candidates
    LEFT JOIN plugin_multitable_object_registry AS existing_sheet
      ON existing_sheet.sheet_id = candidates.sheet_id
    LEFT JOIN plugin_multitable_object_registry AS existing_object
      ON existing_object.project_id = candidates.project_id
     AND existing_object.object_id = candidates.object_id
    WHERE existing_sheet.sheet_id IS NULL
      AND existing_object.sheet_id IS NULL
  `.execute(db)
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally irreversible. This migration only backfills rows that should
  // exist for legacy after-sales installs; removing them would reopen the
  // legacy ownership gap.
}
