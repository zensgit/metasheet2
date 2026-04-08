import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Registers ownership of multitable objects provisioned through plugin-scoped
 * CoreAPI wrappers.
 *
 * The registry lets the runtime enforce sheet-level access for
 * `context.api.multitable.records.*`, which otherwise only receive `sheetId`
 * and cannot infer which plugin originally provisioned that object.
 *
 * Compatibility note:
 * - Missing registry rows are treated as legacy/unscoped and allowed at
 *   runtime to avoid breaking installs created before this table existed.
 * - New installs write rows via plugin-scoped `provisioning.ensureObject`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS plugin_multitable_object_registry (
      sheet_id text PRIMARY KEY REFERENCES meta_sheets(id) ON DELETE CASCADE,
      project_id text NOT NULL,
      object_id text NOT NULL,
      plugin_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_multitable_object_registry_project_object
    ON plugin_multitable_object_registry(project_id, object_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_plugin_multitable_object_registry_plugin_name
    ON plugin_multitable_object_registry(plugin_name)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_plugin_multitable_object_registry_plugin_name`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_plugin_multitable_object_registry_project_object`.execute(db)
  await sql`DROP TABLE IF EXISTS plugin_multitable_object_registry`.execute(db)
}
