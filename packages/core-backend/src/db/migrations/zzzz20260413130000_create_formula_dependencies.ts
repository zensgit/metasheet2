import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS formula_dependencies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      field_id text NOT NULL,
      depends_on_field_id text NOT NULL,
      depends_on_sheet_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_formula_dep UNIQUE (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_formula_dep_reverse
    ON formula_dependencies (depends_on_field_id, depends_on_sheet_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS formula_dependencies`.execute(db)
}
