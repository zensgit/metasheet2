/**
 * #6076 residual R-073, owner ruling "option 1": make the WRITER side of the 073 sealed-export
 * stock-prep binding participate in the external-system delete protocol at the only place both
 * sides can meet without touching the frozen S6-A package — the database.
 *
 * THE HOLE. `integration_sealed_export_stock_prep_bindings.external_system_id` (073) points at
 * `integration_external_systems.id` as a plain TEXT reference with no foreign key. The delete
 * guard (`plugins/plugin-integration-core/lib/external-systems.cjs` `deleteExternalSystem`) counts
 * ACTIVE 073 rows before it deletes, but the only writer of those rows —
 * `sealed-export-lifecycle-provisioning.cjs` `provisionInitialStockPreparationBinding`, a FROZEN
 * S6-A module pinned in `s6a-package-provenance-pins.json` — takes no lock on the system row, and
 * cannot: it runs as the provisioning role, to which 073/074/075 grant nothing on
 * `integration_external_systems` (a locking clause needs UPDATE privilege on some column). So
 * "delete counts zero -> provisioning inserts an ACTIVE binding -> delete commits" (and the
 * mirror order on a build without #6076's delete transaction) leaves an ACTIVE binding pointing
 * at a deleted system. #6076 pins that dangle as R-073.
 *
 * WHAT THIS MIGRATION CHANGES.
 *   * `live_external_system_id` — a STORED generated column that equals `external_system_id` while
 *     the binding is ACTIVE and is NULL otherwise (073's status vocabulary is exactly ACTIVE /
 *     RETIRED, `073:32`). RETIRED rows are history, exactly as the delete guard already reads
 *     them (it counts only `status = 'ACTIVE'`), so they must not keep a system undeletable.
 *   * `fk_sealed_export_stock_prep_binding_live_external_system` — FOREIGN KEY on that column ->
 *     `integration_external_systems(id)` (the table's whole primary key; it carries no tenant, so
 *     the key is single-column), ON DELETE RESTRICT, NOT VALID.
 *   Consequences, all at the database layer:
 *     1. An INSERT of an ACTIVE binding (and a RETIRED -> ACTIVE flip) takes PostgreSQL's RI
 *        `FOR KEY SHARE` on the system row. That conflicts with the delete's `FOR UPDATE` (#6076)
 *        and with the DELETE itself, so the two sides now serialize.
 *     2. A provisioning whose system is gone — or whose system's delete committed while it waited
 *        on that lock — is refused with SQLSTATE 23503 on this constraint. The frozen module's
 *        boundary rolls the whole transaction back and reports its fixed
 *        SEALED_EXPORT_INTERNAL_ERROR (values-free); nothing is written.
 *     3. A DELETE of a system that an ACTIVE binding still names is refused with 23503 on this
 *        constraint, whatever the application counted.
 *   The RI queries run with the table owner's identity (PostgreSQL switches to the owner of the
 *   queried table for RI checks), so the provisioning role needs NO new privilege, and the frozen
 *   module and its pin are untouched: it names its columns on INSERT, its reads go through
 *   `rowMatchesExpected` / `normalizeBinding`, which read only the columns they name, and its
 *   `RETURNING *` / `SELECT *` are covered by the table-level SELECT 073 already grants.
 *
 * WHY `NOT VALID`. A database that already holds an ACTIVE binding pointing at a deleted system
 * (the very corruption this closes) would make a validating ADD CONSTRAINT fail and block deploy.
 * NOT VALID skips only the scan of EXISTING rows; every INSERT and every UPDATE that changes the
 * generated key from here on is checked, and takes the lock, in full. Pre-existing dangling rows
 * are left for the owner-run inventory / remediation / VALIDATE pack
 * (`scripts/ops/sealed-export-binding-live-fk-validate-20260926/`), never rewritten here.
 *
 * NOT COVERED (registered, not closed here): the delete path's own reaction to a 23503 from this
 * constraint. A tenant-mismatched binding (binding tenant != system tenant) is invisible to the
 * delete guard's tenant-scoped count, so such a delete now fails with the raw 23503 instead of
 * silently dangling (the system is kept). Translating that into the guard's 409 belongs in
 * `external-systems.cjs`, which #6076 is rewriting; see
 * docs/development/sealed-export-binding-live-external-system-fk-20260926.md §4.
 *
 * Idempotent: guarded ADD COLUMN / constraint-existence check. `down()` drops the constraint and
 * the column only — it never touches a binding row, so it is safe with any data present.
 * Locks while it runs: ADD COLUMN ... STORED rewrites the (single-customer, tiny) binding table
 * under ACCESS EXCLUSIVE; ADD CONSTRAINT ... NOT VALID takes SHARE ROW EXCLUSIVE on both tables
 * without scanning either.
 */
import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

const BINDINGS_TABLE = 'integration_sealed_export_stock_prep_bindings'
const EXTERNAL_SYSTEMS_TABLE = 'integration_external_systems'
const LIVE_EXTERNAL_SYSTEM_FK = 'fk_sealed_export_stock_prep_binding_live_external_system'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, BINDINGS_TABLE))) return

  // The generated column. `status` and `external_system_id` are plain columns of the same row, so
  // the expression is immutable in the sense PostgreSQL requires. `external_system_id` is also one
  // of 073's immutable anchors (trg_..._binding_anchors_immutable), so the only way this column
  // changes after INSERT is a status flip.
  await sql`
    ALTER TABLE integration_sealed_export_stock_prep_bindings
      ADD COLUMN IF NOT EXISTS live_external_system_id TEXT
      GENERATED ALWAYS AS (CASE WHEN status = 'ACTIVE' THEN external_system_id END) STORED
  `.execute(db)

  // ADD COLUMN IF NOT EXISTS is silent when a column of that name already exists with ANY
  // definition. A plain (non-generated) column there would carry the FK below without carrying
  // the ACTIVE-only rule, so refuse to continue rather than constrain the wrong thing.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'integration_sealed_export_stock_prep_bindings'::regclass
          AND attname = 'live_external_system_id'
          AND attgenerated = 's'
          AND NOT attisdropped
      ) THEN
        RAISE EXCEPTION 'integration_sealed_export_stock_prep_bindings.live_external_system_id exists but is not a stored generated column'
          USING ERRCODE = '55000';
      END IF;
    END $$
  `.execute(db)

  if (!(await checkTableExists(db, EXTERNAL_SYSTEMS_TABLE))) return

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = ${sql.lit(LIVE_EXTERNAL_SYSTEM_FK)}
          AND conrelid = 'integration_sealed_export_stock_prep_bindings'::regclass
      ) THEN
        ALTER TABLE integration_sealed_export_stock_prep_bindings
          ADD CONSTRAINT ${sql.raw(LIVE_EXTERNAL_SYSTEM_FK)}
          FOREIGN KEY (live_external_system_id)
          REFERENCES integration_external_systems(id)
          ON DELETE RESTRICT
          NOT VALID;
      END IF;
    END $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, BINDINGS_TABLE))) return

  // The constraint goes before the column it is defined on. Neither statement reads or writes a
  // binding row, so a table full of ACTIVE, RETIRED and pre-existing dangling rows rolls back the
  // same way an empty one does.
  await sql`
    ALTER TABLE integration_sealed_export_stock_prep_bindings
      DROP CONSTRAINT IF EXISTS ${sql.raw(LIVE_EXTERNAL_SYSTEM_FK)}
  `.execute(db)
  await sql`
    ALTER TABLE integration_sealed_export_stock_prep_bindings
      DROP COLUMN IF EXISTS live_external_system_id
  `.execute(db)
}
