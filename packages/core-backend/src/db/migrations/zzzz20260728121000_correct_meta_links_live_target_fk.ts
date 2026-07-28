import { sql, type Kysely } from 'kysely'

import { LIVE_TARGET_CONSTRAINT } from './zzzz20260721120000_guard_meta_links_live_targets'

/**
 * Upgrade deployments that already recorded the first live-target migration with ON DELETE CASCADE.
 *
 * Only the exact known legacy shape is replaced. A same-name constraint with any other column,
 * target, action, or deferrability is operator-owned drift and fails loudly.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      existing_oid oid;
      current_delete_action "char";
      shape_matches boolean;
    BEGIN
      SELECT
        c.oid,
        c.confdeltype,
        c.contype = 'f'
          AND c.conkey = ARRAY[(
            SELECT source_column.attnum
              FROM pg_attribute source_column
             WHERE source_column.attrelid = 'meta_links'::regclass
               AND source_column.attname = 'foreign_record_id'
               AND NOT source_column.attisdropped
          )]::smallint[]
          AND c.confrelid = 'meta_records'::regclass
          AND c.confkey = ARRAY[(
            SELECT target_column.attnum
              FROM pg_attribute target_column
             WHERE target_column.attrelid = 'meta_records'::regclass
               AND target_column.attname = 'id'
               AND NOT target_column.attisdropped
          )]::smallint[]
          AND c.condeferrable
          AND NOT c.condeferred
        INTO existing_oid, current_delete_action, shape_matches
        FROM pg_constraint c
       WHERE c.conrelid = 'meta_links'::regclass
         AND c.conname = '${sql.raw(LIVE_TARGET_CONSTRAINT)}';

      IF existing_oid IS NULL THEN
        ALTER TABLE meta_links
          ADD CONSTRAINT ${sql.raw(LIVE_TARGET_CONSTRAINT)}
          FOREIGN KEY (foreign_record_id)
          REFERENCES meta_records(id)
          ON DELETE NO ACTION
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;
      ELSIF NOT shape_matches OR current_delete_action NOT IN ('a', 'c') THEN
        RAISE EXCEPTION
          USING
            ERRCODE = '55000',
            MESSAGE = 'existing constraint ${sql.raw(LIVE_TARGET_CONSTRAINT)} has unexpected definition';
      ELSIF current_delete_action = 'c' THEN
        ALTER TABLE meta_links
          DROP CONSTRAINT ${sql.raw(LIVE_TARGET_CONSTRAINT)};
        ALTER TABLE meta_links
          ADD CONSTRAINT ${sql.raw(LIVE_TARGET_CONSTRAINT)}
          FOREIGN KEY (foreign_record_id)
          REFERENCES meta_records(id)
          ON DELETE NO ACTION
          DEFERRABLE INITIALLY IMMEDIATE
          NOT VALID;
      END IF;
    END
    $$
  `.execute(db)
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Safety rollback: never restore the silent target-side CASCADE.
}
