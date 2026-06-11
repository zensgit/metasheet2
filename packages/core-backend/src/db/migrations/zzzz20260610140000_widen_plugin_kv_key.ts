import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Large-BOM C3/C4 job keys include tenant/workspace/action/job scope. The
 * existing plugin KV table is the right durable backing store, but its original
 * varchar(255) key is too tight for these fully-scoped runtime keys. Some fresh
 * install paths do not replay the legacy SQL plugin migration, so this migration
 * also creates the host KV table when it is absent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS plugin_kv (
      plugin varchar(255) NOT NULL,
      key text NOT NULL,
      value jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (plugin, key)
    )
  `.execute(db)
  await sql`ALTER TABLE plugin_kv ALTER COLUMN key TYPE text`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_kv_plugin ON plugin_kv(plugin)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_kv_updated_at ON plugin_kv(updated_at)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE IF EXISTS plugin_kv ALTER COLUMN key TYPE varchar(255)`.execute(db)
}
