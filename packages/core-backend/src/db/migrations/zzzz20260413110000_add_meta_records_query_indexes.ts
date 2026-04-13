/**
 * Add query-performance indexes for meta_records.
 *
 * - Composite (sheet_id, id) covers cursor-based pagination keyset.
 * - Composite (sheet_id, updated_at DESC) supports ORDER BY updated_at.
 * - GIN on JSONB data supports filter predicates.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_records_sheet_id_id ON meta_records(sheet_id, id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_records_sheet_updated ON meta_records(sheet_id, updated_at DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_records_data_gin ON meta_records USING gin(data)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_records_data_gin`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_records_sheet_updated`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_records_sheet_id_id`.execute(db)
}
