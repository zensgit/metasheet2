/**
 * W7-B PR-B (#5784 owner reservation ②, second cut): make the BINDING side of a
 * data-source delete participate in the lock protocol, at the only place both
 * sides actually meet — the database.
 *
 * THE HOLE PR-A LEFT OPEN. PR-A (#5889) put the delete's reference count and its
 * soft delete into ONE transaction opened by `SELECT ... FOR UPDATE` on the
 * `data_sources` row. `fk_integration_external_systems_connection_id` already
 * makes PostgreSQL take a KEY SHARE lock on that same row inside a binding
 * INSERT/UPDATE, and KEY SHARE conflicts with FOR UPDATE, so the two sides DO
 * serialize. But a SOFT delete writes only `deleted_at` / `is_active`, which are
 * NOT part of any key the FK references. When the blocked bind resumes, the FK
 * re-check asks only "does a row with this id exist?" — and it still does. The
 * reference lands on a deleted source anyway. Reproduced on PostgreSQL 16.9:
 * delete holds FOR UPDATE, concurrent insert waits, delete commits, insert then
 * succeeds and the terminal state holds a binding pointing at a soft-deleted
 * source ("timing A" in the design note).
 *
 * WHAT THIS MIGRATION CHANGES. `live_id` is a STORED generated column that is
 * the row's own id while the row is live and NULL once it is soft-deleted, with
 * a UNIQUE index so it can be an FK target. The FK is re-pointed at `live_id`.
 * Two consequences, both of them the point:
 *   1. A soft delete now UPDATES a key column, so it is a key update and takes a
 *      lock that conflicts with the FK's KEY SHARE — the binding side is a real
 *      participant without the plugin ever reading `data_sources` (its db helper
 *      is scoped to `integration_*` and MUST NOT be widened to reach this table).
 *   2. A bind that was waiting on an in-flight delete fails its FK re-check when
 *      it resumes, because `live_id` is gone (SQLSTATE 23503 on this
 *      constraint). Same reproduction as above now ends with the insert refused
 *      and zero dangling rows.
 *   3. A soft delete of a source that still has a canonical binding is refused
 *      by the database itself (23503 on this constraint, raised against the
 *      UPDATE of `data_sources`), whatever the application layer decided. This
 *      is what made `force=true` impossible; the owner ruled (2026-09-20,
 *      option ①) that force is RETIRED rather than re-designed: a referenced
 *      source cannot be deleted, unbind first. The application no longer sends
 *      a force bypass; this constraint is the backstop behind that rule.
 *
 * WHY `NOT VALID`. Databases that already contain bindings pointing at
 * soft-deleted sources (exactly the corruption this closes, accumulated before
 * it existed — including every force delete performed before this migration)
 * would make a validating ADD CONSTRAINT fail and block deploy. NOT VALID skips
 * only the scan of EXISTING rows; every INSERT and UPDATE from here on is
 * checked, and takes the lock, in full. Pre-existing dangling rows are left for
 * a separate, owner-visible cleanup rather than silently rewritten here.
 *
 * NOT A WIDENING. ON DELETE RESTRICT is preserved. A HARD delete of a live,
 * referenced source is still refused by the database exactly as before. A hard
 * delete of an ALREADY soft-deleted source no longer trips RESTRICT (its
 * `live_id` is NULL, so nothing references it) — which matches the application:
 * such a source is already gone, and its stale bindings are the pre-existing rows
 * NOT VALID deliberately tolerates.
 *
 * NOT COVERED (registered, not closed): the legacy binding shape
 * (`connection_id IS NULL`, pointer in `config->>'dataSourceId'`) has no FK and
 * is untouched by this migration; other tables that hold a data-source pointer
 * but are not counted by the delete guard (e.g. integration_stock_prep_source_binding)
 * are likewise outside this constraint.
 *
 * Idempotent: guarded ADD COLUMN / CREATE INDEX / constraint-existence checks.
 * Deploy order: migrate first, then release the application build that stops
 * sending force (an old build against the new schema only loses its force path,
 * which the database refuses with 23503 -> mapped 409; a new build against the
 * old schema keeps PR-A's guarantees and simply lacks the timing-A backstop).
 */
import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

const LIVE_FK = 'fk_integration_external_systems_live_connection_id'
const LEGACY_FK = 'fk_integration_external_systems_connection_id'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'data_sources'))) return

  // The generated column. `id` is the primary key and never updated, so the
  // expression is immutable in the sense PostgreSQL requires.
  await sql`
    ALTER TABLE data_sources
      ADD COLUMN IF NOT EXISTS live_id TEXT
      GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN id END) STORED
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_data_sources_live_id
      ON data_sources (live_id)
  `.execute(db)

  if (!(await checkTableExists(db, 'integration_external_systems'))) return

  // Re-point the FK. The new constraint is added before the old one is dropped,
  // inside the migration's single transaction, so there is no window in which
  // the column is unreferenced.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = ${sql.lit(LIVE_FK)}
          AND conrelid = 'integration_external_systems'::regclass
      ) THEN
        ALTER TABLE integration_external_systems
          ADD CONSTRAINT ${sql.raw(LIVE_FK)}
          FOREIGN KEY (connection_id) REFERENCES data_sources(live_id)
          ON DELETE RESTRICT
          NOT VALID;
      END IF;
    END $$
  `.execute(db)

  await sql`
    ALTER TABLE integration_external_systems
      DROP CONSTRAINT IF EXISTS ${sql.raw(LEGACY_FK)}
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'integration_external_systems')) {
    await sql`
      ALTER TABLE integration_external_systems
        DROP CONSTRAINT IF EXISTS ${sql.raw(LIVE_FK)}
    `.execute(db)

    // Restore the id-targeted FK. NOT VALID here too: rows that reference a
    // soft-deleted source would make a validating ADD CONSTRAINT fail, and a
    // down() must not fail on data the up() deliberately tolerated. New writes
    // are checked exactly as the original (validated) constraint checked them.
    if (await checkTableExists(db, 'data_sources')) {
      await sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = ${sql.lit(LEGACY_FK)}
              AND conrelid = 'integration_external_systems'::regclass
          ) THEN
            ALTER TABLE integration_external_systems
              ADD CONSTRAINT ${sql.raw(LEGACY_FK)}
              FOREIGN KEY (connection_id) REFERENCES data_sources(id)
              ON DELETE RESTRICT
              NOT VALID;
          END IF;
        END $$
      `.execute(db)
    }
  }

  if (await checkTableExists(db, 'data_sources')) {
    await sql`DROP INDEX IF EXISTS uq_data_sources_live_id`.execute(db)
    await sql`ALTER TABLE data_sources DROP COLUMN IF EXISTS live_id`.execute(db)
  }
}
