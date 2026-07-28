import { sql, type Kysely } from 'kysely'

/**
 * Enforce the target half of the link relation with a real FK. `NOT VALID` deliberately leaves
 * historical dangling rows for the existing repair-on-read path, while PostgreSQL still checks all
 * new writes. Target deletion is NO ACTION: callers must capture and remove authoritative link rows
 * explicitly instead of allowing the database to erase them silently.
 */
export const LIVE_TARGET_CONSTRAINT = 'meta_links_foreign_record_id_fkey'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      existing_definition text;
    BEGIN
      SELECT pg_get_constraintdef(c.oid, true)
        INTO existing_definition
        FROM pg_constraint c
       WHERE c.conrelid = 'meta_links'::regclass
         AND c.conname = 'meta_links_foreign_record_id_fkey';

      IF existing_definition IS NULL THEN
        ALTER TABLE meta_links
          ADD CONSTRAINT ${sql.raw(LIVE_TARGET_CONSTRAINT)}
          FOREIGN KEY (foreign_record_id)
          REFERENCES meta_records(id)
          ON DELETE NO ACTION
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;
      ELSIF NOT EXISTS (
        SELECT 1
          FROM pg_constraint c
          JOIN pg_attribute source_column
            ON source_column.attrelid = c.conrelid
           AND source_column.attname = 'foreign_record_id'
           AND NOT source_column.attisdropped
          JOIN pg_attribute target_column
            ON target_column.attrelid = c.confrelid
           AND target_column.attname = 'id'
           AND NOT target_column.attisdropped
         WHERE c.conrelid = 'meta_links'::regclass
           AND c.conname = 'meta_links_foreign_record_id_fkey'
           AND c.contype = 'f'
           AND c.conkey = ARRAY[source_column.attnum]::smallint[]
           AND c.confrelid = 'meta_records'::regclass
           AND c.confkey = ARRAY[target_column.attnum]::smallint[]
           AND c.confdeltype = 'a'
           AND c.condeferrable
           AND NOT c.condeferred
      ) THEN
        RAISE EXCEPTION
          USING
            ERRCODE = '55000',
            MESSAGE = format(
              'existing constraint %s has unexpected definition: %s',
              '${sql.raw(LIVE_TARGET_CONSTRAINT)}',
              existing_definition
            );
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
