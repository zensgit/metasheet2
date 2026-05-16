import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    ALTER TABLE meta_records
    ADD COLUMN IF NOT EXISTS created_by text
  `.execute(db)

  await sql`
    ALTER TABLE meta_records
    ADD COLUMN IF NOT EXISTS modified_by text
  `.execute(db)

  await sql`
    UPDATE meta_records
    SET modified_by = created_by
    WHERE modified_by IS NULL AND created_by IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_records_created_by
    ON meta_records(sheet_id, created_by)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_records_modified_by
    ON meta_records(modified_by)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_record_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      version integer NOT NULL,
      action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
      source text NOT NULL DEFAULT 'rest',
      actor_id text,
      changed_field_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
      patch jsonb NOT NULL DEFAULT '{}'::jsonb,
      snapshot jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_sheet_record_version
    ON meta_record_revisions(sheet_id, record_id, version DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_record_created_at
    ON meta_record_revisions(record_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_actor_created_at
    ON meta_record_revisions(actor_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION __metasheet_add_required_field_validation(input jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
    DECLARE
      prop jsonb := CASE WHEN jsonb_typeof(input) = 'object' THEN input ELSE '{}'::jsonb END;
      rules jsonb := CASE WHEN jsonb_typeof(prop->'validation') = 'array' THEN prop->'validation' ELSE '[]'::jsonb END;
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(rules) AS rule
        WHERE rule->>'type' = 'required'
      ) THEN
        RETURN jsonb_set(prop, '{validation}', rules, true);
      END IF;

      RETURN jsonb_set(prop, '{validation}', rules || '[{"type":"required"}]'::jsonb, true);
    END
    $$;
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.meta_fields') IS NOT NULL
        AND to_regclass('public.plugin_multitable_object_registry') IS NOT NULL
      THEN
        UPDATE meta_fields AS f
        SET property = __metasheet_add_required_field_validation(f.property)
        FROM plugin_multitable_object_registry AS r
        WHERE f.sheet_id = r.sheet_id
          AND r.plugin_name = 'plugin-integration-core'
          AND (
            (r.object_id = 'plm_raw_items' AND f.name IN ('Source System', 'Object Type', 'Source ID'))
            OR (r.object_id = 'standard_materials' AND f.name IN ('Material Code', 'Material Name', 'Status'))
            OR (r.object_id = 'bom_cleanse' AND f.name IN ('Parent Code', 'Child Code', 'Quantity', 'Status'))
            OR (r.object_id = 'integration_exceptions' AND f.name IN ('Pipeline ID', 'Run ID', 'Error Code', 'Error Message', 'Status'))
            OR (r.object_id = 'integration_run_log' AND f.name IN ('Pipeline ID', 'Run ID', 'Mode', 'Triggered By', 'Status'))
          );
      END IF;
    END
    $$;
  `.execute(db)

  await sql`DROP FUNCTION IF EXISTS __metasheet_add_required_field_validation(jsonb)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS __metasheet_add_required_field_validation(jsonb)`.execute(db)
}
