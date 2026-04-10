import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS plugin_field_policy_registry (
      tenant_id text NOT NULL,
      plugin_id text NOT NULL,
      app_id text NOT NULL,
      project_id text NOT NULL,
      object_id text NOT NULL,
      field_name text NOT NULL,
      role_slug text NOT NULL,
      visibility text NOT NULL,
      editability text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_field_policy_registry_scope
    ON plugin_field_policy_registry(
      tenant_id, plugin_id, app_id, project_id, object_id, field_name, role_slug
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_plugin_field_policy_registry_project
    ON plugin_field_policy_registry(project_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_plugin_field_policy_registry_project`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_plugin_field_policy_registry_scope`.execute(db)
  await sql`DROP TABLE IF EXISTS plugin_field_policy_registry`.execute(db)
}
