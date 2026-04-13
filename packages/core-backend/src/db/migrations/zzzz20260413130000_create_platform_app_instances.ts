import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS platform_app_instances (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id text NOT NULL,
      workspace_id text NOT NULL,
      app_id text NOT NULL,
      plugin_id text NOT NULL,
      instance_key text NOT NULL DEFAULT 'primary',
      project_id text NOT NULL,
      display_name text NOT NULL DEFAULT '',
      status text NOT NULL CHECK (status IN ('active', 'inactive', 'failed')),
      config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_app_instances_workspace_app_key
    ON platform_app_instances(workspace_id, app_id, instance_key)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_app_instances_tenant
    ON platform_app_instances(tenant_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_app_instances_plugin
    ON platform_app_instances(plugin_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_platform_app_instances_plugin`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_platform_app_instances_tenant`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_platform_app_instances_workspace_app_key`.execute(db)
  await sql`DROP TABLE IF EXISTS platform_app_instances`.execute(db)
}
