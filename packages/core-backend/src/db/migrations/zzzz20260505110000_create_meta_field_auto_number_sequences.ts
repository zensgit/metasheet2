import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_field_auto_number_sequences (
      field_id text PRIMARY KEY REFERENCES meta_fields(id) ON DELETE CASCADE,
      sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
      next_value bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (next_value >= 1)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_field_auto_number_sequences_sheet
    ON meta_field_auto_number_sequences(sheet_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_field_auto_number_sequences_sheet`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_field_auto_number_sequences`.execute(db)
}
