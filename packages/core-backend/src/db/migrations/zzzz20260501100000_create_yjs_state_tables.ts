import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_record_yjs_states (
      record_id TEXT NOT NULL PRIMARY KEY,
      state_vector BYTEA,
      doc_state BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_record_yjs_updates (
      id BIGSERIAL PRIMARY KEY,
      record_id TEXT NOT NULL,
      update_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_yjs_updates_record
    ON meta_record_yjs_updates(record_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_record_yjs_updates`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_record_yjs_states`.execute(db)
}
