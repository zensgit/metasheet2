import { sql, type Kysely } from 'kysely'

/**
 * Enforce the target half of the link relation with a real FK. `NOT VALID` deliberately leaves
 * historical dangling rows for the existing repair-on-read path, while PostgreSQL still checks all
 * new writes and serializes target deletes with concurrent inserts. `ON DELETE CASCADE` also closes
 * direct/plugin/future delete paths without relying on each caller's hand-written cleanup order.
 */
export const LIVE_TARGET_CONSTRAINT = 'meta_links_foreign_record_id_fkey'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
         FROM pg_constraint
         WHERE conrelid = 'meta_links'::regclass
           AND conname = 'meta_links_foreign_record_id_fkey'
      ) THEN
        ALTER TABLE meta_links
          ADD CONSTRAINT ${sql.raw(LIVE_TARGET_CONSTRAINT)}
          FOREIGN KEY (foreign_record_id)
          REFERENCES meta_records(id)
          ON DELETE CASCADE
          NOT VALID;
      END IF;
    END
    $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_links
    DROP CONSTRAINT IF EXISTS ${sql.raw(LIVE_TARGET_CONSTRAINT)}
  `.execute(db)
}
