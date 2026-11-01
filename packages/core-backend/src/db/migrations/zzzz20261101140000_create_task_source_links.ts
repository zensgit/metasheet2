/**
 * The structured link from a task to the multitable record it was dispatched from. Draft migration:
 * do not apply from this PR, do not run against a shared DB.
 *
 * Lock: docs/development/task-feature-design-lock-20260917.md §4 (naming, `down()` in strict reverse).
 *
 * One row per task; a task has at most one source. The row holds ids only, no value from the record.
 * `sheet_id` and `record_id` have no FK: a record link outlives the record, and the read that shows
 * it goes through the record's own gate. `dispatch_key` is the client's retry key for one dispatch;
 * `uq_tsrc_dispatch_key` makes it unique per org and dispatcher, and keyless rows stay out of the
 * index. Every id column carries the same printable CHECK as the other task tables. A soft-deleted
 * task keeps its row; a hard delete cascades.
 *
 * Ordering: Kysely runs migrations in full-filename order. The full filename sorts after
 * `zzzz20261009130000_create_task_m4_tables` (the composite FK targets its `tasks_id_org_id_key`) and
 * after every migration on main at merge time (lock §4 naming rule); recheck the prefix against main
 * before merging.
 */
import { sql, type Kysely } from 'kysely'

export const TASK_SOURCE_LINKS_DOWN_BLOCKED_CODE = 'TASK_SOURCE_LINKS_DOWN_BLOCKED'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE task_source_links (
      task_id text PRIMARY KEY,
      org_id text NOT NULL,
      source_type text NOT NULL,
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      view_id text,
      base_id text,
      created_by text NOT NULL,
      dispatch_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_source_links_task_fk FOREIGN KEY (task_id, org_id)
        REFERENCES tasks (id, org_id) ON DELETE CASCADE,
      CONSTRAINT task_source_links_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_source_links_source_type_chk CHECK (source_type IN ('multitable_record')),
      CONSTRAINT task_source_links_sheet_id_printable_chk CHECK (sheet_id ~ '^[!-~]+$'),
      CONSTRAINT task_source_links_record_id_printable_chk CHECK (record_id ~ '^[!-~]+$'),
      CONSTRAINT task_source_links_view_id_printable_chk CHECK (view_id IS NULL OR view_id ~ '^[!-~]+$'),
      CONSTRAINT task_source_links_base_id_printable_chk CHECK (base_id IS NULL OR base_id ~ '^[!-~]+$'),
      CONSTRAINT task_source_links_created_by_printable_chk CHECK (created_by ~ '^[!-~]+$'),
      CONSTRAINT task_source_links_dispatch_key_chk CHECK (dispatch_key IS NULL OR dispatch_key ~ '^[A-Za-z0-9_-]{8,64}$')
    )
  `.execute(db)
  await sql`
    CREATE INDEX idx_tsrc_record ON task_source_links (sheet_id, record_id, org_id)
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX uq_tsrc_dispatch_key ON task_source_links (org_id, created_by, dispatch_key)
      WHERE dispatch_key IS NOT NULL
  `.execute(db)
}

// The table is the only record of each dispatched task's source and of each retry key, so a table
// with rows is kept: rolling the service back leaves it in place, and the previous release does not
// read it. The existence check and the count are two statements because Postgres resolves every
// relation named in a statement before evaluating it, so one statement with a CASE guard answers
// 42P01 on a half-applied `up()`.
export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ e: boolean }>`
    SELECT to_regclass('public.task_source_links') IS NOT NULL AS e
  `.execute(db)
  if (exists.rows[0]?.e) {
    const result = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM task_source_links
    `.execute(db)
    const rows = Number(result.rows[0]?.n ?? 0)
    if (rows > 0) {
      const error = new Error(
        `${TASK_SOURCE_LINKS_DOWN_BLOCKED_CODE}: [zzzz20261101140000_create_task_source_links] down() refused: ${rows} row(s) in task_source_links; dropping the table removes every dispatched task's source link and retry key and cannot be undone. Nothing was changed. Leave the table in place and roll back the application build; on a disposable database, delete the rows first and run the rollback again.`,
      )
      ;(error as Error & { code?: string }).code = TASK_SOURCE_LINKS_DOWN_BLOCKED_CODE
      throw error
    }
  }
  await sql`DROP INDEX IF EXISTS uq_tsrc_dispatch_key`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tsrc_record`.execute(db)
  await sql`DROP TABLE IF EXISTS task_source_links`.execute(db)
}
