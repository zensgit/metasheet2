import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Creates the plugin-owned logical ledger table for after-sales template installs.
 *
 * Design source: docs/development/platform-object-model-and-template-installer-design-20260407.md §4
 * and docs/development/platform-project-builder-and-template-architecture-design-20260407.md §5.2.1 / §11.5
 *
 * Ownership: This table is logically owned by plugin-after-sales (prefix
 * `plugin_after_sales_*` keeps it out of the multitable `meta_*` namespace).
 * It is, however, created by a core migration file because the repository does
 * not have a plugin-side migration runner (v1 non-goal). The plugin accesses it
 * at runtime via `context.api.database.query` and does NOT register its types
 * in `packages/core-backend/src/db/types.ts` (multi-line conflict hotspot).
 *
 * Lifecycle: The table only ever records terminal install states
 * (`installed` | `partial` | `failed`) — no intermediate `pending` or
 * `installing` rows. The installer orchestrator only UPSERTs a row after the
 * 11-step install flow completes, so a crash mid-install leaves no row and
 * callers can safely retry with `mode='enable'`.
 *
 * Audit note: the `mode` column captures the last attempted install mode
 * (`enable` or `reinstall`) at the time that row was written. It should not be
 * interpreted as a durable statement of what the next caller intends to do.
 *
 * v1 uniqueness: one row per (tenant_id, app_id). The `project_id` column is
 * already present and populated with the pseudo value `${tenantId}:${appId}`
 * so the v2 migration can simply swap the unique index to
 * (tenant_id, project_id) without any data backfill.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS plugin_after_sales_template_installs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id text NOT NULL,
      app_id text NOT NULL,
      project_id text NOT NULL,
      template_id text NOT NULL,
      template_version text NOT NULL,
      -- Records the last attempted install mode written with this terminal row.
      mode text NOT NULL CHECK (mode IN ('enable', 'reinstall')),
      status text NOT NULL CHECK (status IN ('installed', 'partial', 'failed')),
      created_objects_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_views_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      display_name text NOT NULL DEFAULT '',
      config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_install_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_after_sales_template_installs_tenant_app
    ON plugin_after_sales_template_installs(tenant_id, app_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_plugin_after_sales_template_installs_status
    ON plugin_after_sales_template_installs(status)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_plugin_after_sales_template_installs_status`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_plugin_after_sales_template_installs_tenant_app`.execute(db)
  await sql`DROP TABLE IF EXISTS plugin_after_sales_template_installs`.execute(db)
}
