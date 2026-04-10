import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS plugin_automation_rule_registry (
      tenant_id text NOT NULL,
      plugin_id text NOT NULL,
      app_id text NOT NULL,
      project_id text NOT NULL,
      template_id text NOT NULL,
      rule_id text NOT NULL,
      trigger_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      conditions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      actions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      enabled boolean NOT NULL DEFAULT TRUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_automation_rule_registry_scope
    ON plugin_automation_rule_registry(tenant_id, plugin_id, app_id, project_id, rule_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_plugin_automation_rule_registry_project
    ON plugin_automation_rule_registry(project_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_plugin_automation_rule_registry_project`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_plugin_automation_rule_registry_scope`.execute(db)
  await sql`DROP TABLE IF EXISTS plugin_automation_rule_registry`.execute(db)
}
