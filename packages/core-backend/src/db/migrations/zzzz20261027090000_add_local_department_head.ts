import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// An applied handover hashes each whole membership row. Apply and finish take a SHARE lock
// on this table before their snapshots. Hold the conflicting DDL lock through check and change.
function protectHandover(columnMustExist: boolean) {
  return sql`
    LOCK TABLE directory_account_departments IN ACCESS EXCLUSIVE MODE;
    IF to_regclass('directory_handovers') IS NOT NULL AND
       EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = 'directory_account_departments'::regclass
                  AND attname = 'is_department_head' AND NOT attisdropped) = ${columnMustExist ? sql`TRUE` : sql`FALSE`}
    THEN
      IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
        RAISE EXCEPTION 'Department head migration requires READ COMMITTED to check handovers';
      END IF;
      IF EXISTS (SELECT 1 FROM directory_handovers WHERE state = 'applied') THEN
        RAISE EXCEPTION 'Finish applied directory handovers before changing the department head column';
      END IF;
    END IF;
  `
}

/** Local head authority is independent of the existing direct-manager flag; no provider backfill. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$ BEGIN
    ${protectHandover(false)}
    ALTER TABLE directory_account_departments
      ADD COLUMN IF NOT EXISTS is_department_head boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_directory_account_departments_head_by_dept
      ON directory_account_departments (directory_department_id) WHERE is_department_head;
  END $$`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$ BEGIN
    ${protectHandover(true)}
    DROP INDEX IF EXISTS idx_directory_account_departments_head_by_dept;
    ALTER TABLE directory_account_departments DROP COLUMN IF EXISTS is_department_head;
  END $$`.execute(db)
}
