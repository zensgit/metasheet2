import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

// S2 outdoor-punch-photo design-lock (2026-07-10), AMENDMENT (Fix 2): bridge migration for the `files`
// table. The legacy SQL migration `035_create_files.sql` is in migration-provider.ts's
// SUPERSEDED_LEGACY_SQL_MIGRATIONS list, so it is replayed as a no-op on fresh installs and the table
// is therefore NEVER created on a freshly-migrated DB — leaving core POST /api/files/upload's new
// INSERT (and the plugin-side ownership/content-type verification) with no table to write to or read
// from. This migration is the modern successor: it mirrors 035's table + index exactly (id/url/owner_id/
// meta/created_at + idx_files_owner) and is byte-exact no-op on any DB that already has the table
// (old DBs where 035 ran before it was superseded). It does NOT touch the SUPERSEDED list.
//
// Idempotency contract: up() early-returns when `files` already exists (a true no-op that touches no
// bytes of an existing table) and additionally guards every DDL with IF NOT EXISTS; down() drops the
// index then the table with IF EXISTS. Both directions are safely re-runnable.

export async function up(db: Kysely<unknown>): Promise<void> {
  // Byte-exact no-op on any DB that already has the table (e.g. an old DB where 035 created it before
  // it was superseded). Fresh DBs — where 035 replays as a no-op — fall through and create it.
  const exists = await checkTableExists(db, 'files')
  if (exists) {
    return
  }

  await sql`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      url TEXT NULL,
      owner_id TEXT NULL,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_files_owner`.execute(db)
  await sql`DROP TABLE IF EXISTS files`.execute(db)
}
