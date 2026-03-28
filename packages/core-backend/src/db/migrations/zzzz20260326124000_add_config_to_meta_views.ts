import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_views
    ADD COLUMN IF NOT EXISTS config jsonb DEFAULT '{}'::jsonb
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_views
    DROP COLUMN IF EXISTS config
  `.execute(db)
}
