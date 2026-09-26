/**
 * One-shot backfill of `integration_external_systems.connection_id` for the residual LEGACY
 * binding shape (`connection_id IS NULL`, pointer in `config->>'dataSourceId'`) — restricted to
 * `kind = 'data-source:sql-readonly'`. Follow-up to #5896 (live_id FK); deploy AFTER it.
 *
 * WHY ONLY sql-readonly. The plugin write path is the evidence (plugin-integration-core,
 * lib/external-systems.cjs, main @ 5edf4c3e1):
 *   * a NEW sql-readonly binding always writes `connection_id` and drops `config.dataSourceId`
 *     before INSERT (`requestedConnectionId` :547-560, insert branch :862-879, `baseRow` :758) —
 *     so the legacy shape has ZERO creation paths left. (It is residue, but one MAINTENANCE path
 *     exists: a config-only PATCH on a row whose `connection_id` is already NULL skips the canonical
 *     branch — `existing.connection_id ?? null` :536-537 and the `connectionId !== null` guard :812 —
 *     so the row keeps its pointer, NULL connection_id and FALSE marker. That path needs a NULL row to
 *     start from, and a backfilled row is inherited as-is by :537, so it neither creates the legacy
 *     shape nor reverts this migration's work.)
 *   * every OTHER kind that carries `config.dataSourceId` (`data-source:sql-write-gated`, …) is the
 *     opposite: `requestedConnectionId` REJECTS `connectionId` for them (:526-534) and returns
 *     null, `baseRow` copies that null into `connection_id` (:758) and `updateRow` spreads it on
 *     every update (:774). A backfilled `connection_id` on such a row would be silently reset to
 *     NULL by the next save. They are NOT touched here; the census (scripts/ops/
 *     readonly-inventory-20260916/05-legacy-binding-census.sql) lists them for the owner.
 *
 * WHICH ROWS (predicates 1-8 and the marker predicate are all required, see the structural test):
 *   1. `b.kind = 'data-source:sql-readonly'`
 *   2. `b.connection_id IS NULL`                             — legacy shape
 *   3. `b.config->>'dataSourceId' = ds.id`                   — the pointer resolves
 *   4. `b.config->>'dataSourceOwnerId' = ds.owner_id`        — the server stamp names THAT
 *      source's owner; this is the same predicate the delete guard counts by
 *      (DataSourceManager.countExternalSystemReferences, src/data-adapters/DataSourceManager.ts
 *      :713-718) and the cutover migration backfilled by (zzzz20260902120000 :97-106). Without it
 *      a foreign pin would be promoted into a canonical reference.
 *   5. `ds.deleted_at IS NULL`                               — since #5896 the FK targets
 *      `data_sources(live_id)` (NULL once soft-deleted) and is NOT VALID: every UPDATE is checked
 *      row by row, so one pointer at a soft-deleted source would raise 23503 and abort the whole
 *      migration. Equivalent to `ds.live_id IS NOT NULL`; spelled on `deleted_at` so the predicate
 *      does not depend on #5896 having run (it must have, by deploy order, but the row filter is
 *      correct either way).
 *   6. `ds.tenant_id = b.tenant_id`                          — the canonical resolver refuses a
 *      registration whose tenant differs from the binding's (connection-resolver.cjs
 *      `assertRegistration` :113-121). The unconfirmed-tenant allowance exists on BOTH branches —
 *      unconditionally in `resolveLegacy` (:258-265) and in `resolveCanonical` only when
 *      `runAs === 'user'` (:184-191 `ownerUserCompatibility`) — so this predicate is stricter than
 *      the resolver: it can only leave a `tenant-unproven` row alone, never admit one.
 *      `data_sources.tenant_id` is nullable and pre-existing rows stay NULL until proven
 *      (zzzz20260902120000 header), so a NULL-tenant source is NOT backfilled: the census reports it
 *      as "tenant unproven" for the owner rather than this migration guessing.
 *   + `b.legacy_connection_fallback_eligible IS NOT TRUE`   — a row with marker TRUE and
 *      `connection_id` NULL is the cutover's deliberate ROLLBACK shape (its own idempotence clause
 *      keeps it: zzzz20260902120000 header, "a later rollback that nulls connection_id is not
 *      undone by replaying this migration"), and it still resolves through `resolveLegacy`
 *      (connection-resolver.cjs :205-263). Re-canonicalising it would undo an operator decision, so
 *      it is left alone and reported by the census. The rows this migration DOES take are the ones
 *      neither resolver branch accepts today (`resolveLegacy` denies marker FALSE at :205-216).
 *
 *   Predicates 7 and 8 (added with owner consent after the CONNECTION_CANONICAL_UNAVAILABLE
 *   diagnosis, docs/development/takeover-beiliao-20260821/
 *   stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §3 conclusion 2, states S2b /
 *   S2c): a promoted row is resolved by `resolveCanonical`, which rewrites ANY facade failure into
 *   CONNECTION_CANONICAL_UNAVAILABLE (connection-resolver.cjs :166-183). A source the host never
 *   loaded fails there, so promoting a row that points at one would only swap today's
 *   CONNECTION_LEGACY_FALLBACK_DENIED for that code. Such rows are left alone and counted by the
 *   census (`source-inactive`, `source-type-unsupported`).
 *   7. `ds.is_active = TRUE`                                 — the host loads only
 *      `is_active = true AND deleted_at IS NULL` rows (src/data-adapters/DataSourceManager.ts
 *      `loadFromDatabase` :324-325); an unloaded id gets the uniform not-found from `assertAccess`
 *      (:621-631), which the facade passes on (data-source-plugin-facade.ts :507-513).
 *   8. `lower(ds.type) IN (SQL_READONLY_CONNECTION_TYPES)`  — the type must be one the canonical
 *      path can both LOAD and ACCEPT. The set is DERIVED from the two runtime checks (the unit test
 *      re-derives it from those modules and fails on drift):
 *        * LOAD: keys of `DEFAULT_ADAPTER_REGISTRY` (DataSourceManager.ts :193-200 — postgresql,
 *          postgres, http, sqlserver, mysql, plm), registered by `registerDefaultAdapters`
 *          (:453-459) through `registerAdapterType`, which lowercases the key (:461-462); `git grep`
 *          finds no other `registerAdapterType(` call in source code (only an example in
 *          docs/DATA_SOURCE_ADAPTERS.md). The loader tests
 *          `record.type.toLowerCase()` (:331-333) — lowercased, NOT trimmed.
 *        * ACCEPT: `DEFAULT_SQL_CONNECTION_TYPES` (plugin-integration-core/lib/
 *          connection-resolver.cjs :8 — mysql, postgres, postgresql, sqlserver); the plugin does
 *          not override it (index.cjs :308-314 passes no `allowedSqlConnectionTypes`).
 *          `assertRegistration` trims and lowercases the registration type (:125-126, `nonBlankString`
 *          :24-26), and that type is the raw persisted column (facade :584 `adapter.getType()` ->
 *          BaseAdapter.ts :555-557 -> `recordToConfig` DataSourceManager.ts :415).
 *        * Intersection: mysql, postgres, postgresql, sqlserver. Compared as `lower(ds.type)`,
 *          untrimmed: case-insensitive like both runtime checks, and a type with surrounding
 *          whitespace fails the (untrimmed) loader, so it is not taken either. A loadable non-SQL
 *          type (http, plm) would be promoted into CONNECTION_TYPE_UNSUPPORTED instead
 *          (connection-resolver.cjs :125-132); an unloadable one into CONNECTION_CANONICAL_UNAVAILABLE.
 *      The four targets are plain ASCII letters; for them PostgreSQL `lower()` and JavaScript
 *      `toLowerCase()` pick out the same strings (checked code point by code point in the
 *      verification note, §11).
 *   What 7 and 8 still cannot see: a source whose credentials fail to decrypt (diagnosis state
 *   S2d, the loader skips it per row) and the deployment states S1 / S2e are invisible to SQL, so a
 *   promoted row can still meet CONNECTION_CANONICAL_UNAVAILABLE for those reasons.
 *
 * TARGET SHAPE = the insert path's shape (external-systems.cjs :862-879): `connection_id` set,
 * `config` WITHOUT `dataSourceId`, `config.dataSourceOwnerId` KEPT. The stamp is kept on purpose:
 * `withoutLegacyDataSourcePointer` (:483-488) drops only the pointer, and the insert branch
 * re-stamps `dataSourceOwnerId` from the proven principal right after. Predicate 4 has just proven
 * the identical fact (stamp == the source's owner), so the stamp stays and the row is
 * indistinguishable from one created canonically. The marker stays FALSE (it already is, by the
 * extra predicate).
 *
 * REVERSIBILITY — a separate ledger table, not a marker inside `config`. `config` is client-visible
 * and PATCH-merged on every save (external-systems.cjs `resolveUpdatedConfig`), server-owned keys
 * inside it are stripped at the normalize choke point (`SERVER_OWNED_CONFIG_KEYS` :33), and any
 * new key there would surface in the workbench edit form. A ledger row per backfilled binding
 * (binding id, tenant id, the connection id written, the legacy pointer removed) is values-free,
 * invisible to the API, and lets `down()` restore EXACTLY the rows this migration changed and
 * nothing the cutover or a human touched. The ledger is written from the UPDATE's RETURNING, in
 * one statement, so "rows recorded" and "rows changed" cannot drift apart — a candidate the
 * UPDATE skipped (see CONCURRENCY in `up()`) is never recorded.
 *
 * CLASSIFICATION: DDL (the ledger table, CREATE TABLE IF NOT EXISTS) + DML (the backfill).
 *
 * IDEMPOTENT: predicate 2 makes a replay a no-op (0 rows, 0 ledger inserts). `down()` restores
 * only ledger rows whose binding still carries the connection id, tenant and owner stamp the ledger
 * recorded and has not regained a pointer, deletes those ledger rows, and drops the ledger only when it is empty — a
 * binding re-bound by a human after the backfill is left as the human left it, with its ledger
 * row kept as evidence.
 *
 * NOT TOUCHED: `legacy_connection_fallback_eligible`, credentials, capabilities, every other kind,
 * every row whose pointer does not resolve, every row whose source is inactive or of a type outside
 * SQL_READONLY_CONNECTION_TYPES, and data_sources itself (read and share-locked only).
 * `updated_at` is not SET by this migration, but the table's own BEFORE UPDATE trigger
 * `trg_integration_external_systems_updated_at` (packages/core-backend/migrations/
 * 057_create_integration_core_tables.sql :182-195) stamps NOW() on every row an UPDATE writes. On a
 * schema built by the full migration chain the backfilled rows (and the rows down() restores)
 * therefore carry the migration time in `updated_at`; rows the statement skips keep theirs.
 */
import { sql, type Kysely } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

const MIGRATION_NAME = 'zzzz20260920150000_backfill_sql_readonly_legacy_connection_id'
const LEDGER_TABLE = 'integration_external_system_connection_backfills'
const SQL_READONLY_KIND = 'data-source:sql-readonly'
// Predicate 8: DEFAULT_ADAPTER_REGISTRY keys (DataSourceManager.ts :193-200) INTERSECT
// DEFAULT_SQL_CONNECTION_TYPES (connection-resolver.cjs :8), both compared lowercased at runtime.
// Derivation and path:line evidence in the header; the unit test re-derives it from both modules.
const SQL_READONLY_CONNECTION_TYPES = ['mysql', 'postgres', 'postgresql', 'sqlserver']

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'integration_external_systems'))) return
  if (!(await checkTableExists(db, 'data_sources'))) return
  // The cutover migration (zzzz20260902120000) owns these columns; without them there is no
  // legacy/canonical distinction to backfill and nothing to do.
  if (!(await checkColumnExists(db, 'integration_external_systems', 'connection_id'))) return
  if (!(await checkColumnExists(db, 'integration_external_systems', 'legacy_connection_fallback_eligible'))) return
  if (!(await checkColumnExists(db, 'data_sources', 'tenant_id'))) return

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.raw(LEDGER_TABLE)} (
      binding_id                  TEXT PRIMARY KEY,
      tenant_id                   TEXT NOT NULL,
      connection_id               TEXT NOT NULL,
      legacy_data_source_id       TEXT NOT NULL,
      legacy_data_source_owner_id TEXT NOT NULL,
      migration_name              TEXT NOT NULL,
      backfilled_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  // ONE statement: candidate set, UPDATE and ledger INSERT. The ledger is fed ONLY by the UPDATE's
  // RETURNING, so it can never name a row the UPDATE did not change (and vice versa).
  //
  // CONCURRENCY (F1 of the window-8 review). Under READ COMMITTED the `hit` candidates come from the
  // statement snapshot. A concurrent writer may commit a change to a candidate between that
  // snapshot and the UPDATE — e.g. a legitimate legacy -> canonical rebind to another source. Two
  // guards make the write re-prove every predicate against the CURRENT rows:
  //   * binding side (predicates 1, 2, 3, 4, 6 and the marker): repeated in the UPDATE's own WHERE,
  //     against `b` = the row being written. When the UPDATE waits on a writer's row lock,
  //     PostgreSQL re-evaluates this WHERE on the committed new row version (EvalPlanQual), so a
  //     row that was rebound, re-kinded, re-pointed, re-stamped, moved tenant or flagged in between
  //     is SKIPPED, not overwritten. (The `hit` columns are frozen CTE values; they are compared
  //     against the live row, never written blindly.)
  //   * source side (predicates 3-8 on `ds`): `FOR SHARE OF ds` locks every joined source for the
  //     rest of the transaction and, if a source was being changed, re-evaluates the join against
  //     the committed new version. A concurrent soft-delete / owner change / tenant change /
  //     deactivation / type change of the source therefore either finishes first (and the
  //     candidate drops out) or waits until the backfill commits.
  //     These source-side predicates are deliberately NOT repeated in the UPDATE: the UPDATE does
  //     not lock data_sources, and a data_sources predicate there (join or sub-select) is evaluated
  //     against the statement snapshot, not the newest committed version — it cannot see a
  //     deactivation the CTE's lock wait has already seen. The CTE's locked re-check is the one
  //     that holds, and from it until COMMIT the share lock keeps the source rows unchanged.
  //     (Executed evidence: moving predicate 7 or 8 out of the CTE into an UPDATE sub-select lets
  //     the concurrent deactivation / type change through — the race suite reds exactly that case.)
  //
  // LOCKING COST (operator note). The share lock on every candidate source is held until the
  // migrate batch COMMITS; for that whole time UPDATE/DELETE on those data_sources rows (edit,
  // soft-delete, owner transfer) blocks. With several candidates the lock order is interleaved per
  // row (ds1 -> b1 -> ds2 -> b2 ...), so a concurrent writer that takes the same rows in any order
  // other than "source first, then binding" can deadlock with it (SQLSTATE 40P01). PostgreSQL then
  // aborts one side; if it is the migration, the whole transaction rolls back — including the
  // ledger table, which is created in the same transaction — and simply re-running migrate is safe.
  //
  // LEDGER UPSERT (Sf7, deliberate). `ON CONFLICT (binding_id) DO UPDATE` overwrites a ledger row
  // that an earlier down() kept as evidence (binding changed by a human after the backfill) when a
  // later up() backfills that binding again. The ledger must describe the data as it now is, so
  // down() can restore exactly this backfill; the older evidence is intentionally replaced.
  await sql`
    WITH hit AS (
      SELECT
        b.id                            AS binding_id,
        b.tenant_id                     AS tenant_id,
        ds.id                           AS connection_id,
        b.config->>'dataSourceId'       AS legacy_data_source_id,
        b.config->>'dataSourceOwnerId'  AS legacy_data_source_owner_id
      FROM integration_external_systems AS b
      JOIN data_sources AS ds
        ON b.config->>'dataSourceId' = ds.id
       AND b.config->>'dataSourceOwnerId' = ds.owner_id
       AND ds.deleted_at IS NULL
       AND ds.tenant_id = b.tenant_id
       AND ds.is_active = TRUE
       AND lower(ds.type) IN (${sql.join(SQL_READONLY_CONNECTION_TYPES)})
      WHERE b.kind = ${SQL_READONLY_KIND}
        AND b.connection_id IS NULL
        AND b.legacy_connection_fallback_eligible IS NOT TRUE
      FOR SHARE OF ds
    ),
    upd AS (
      UPDATE integration_external_systems AS b
      SET connection_id = hit.connection_id,
          config = b.config - 'dataSourceId'
      FROM hit
      WHERE b.id = hit.binding_id
        AND b.kind = ${SQL_READONLY_KIND}
        AND b.connection_id IS NULL
        AND b.legacy_connection_fallback_eligible IS NOT TRUE
        AND b.tenant_id = hit.tenant_id
        AND b.config->>'dataSourceId' = hit.legacy_data_source_id
        AND b.config->>'dataSourceOwnerId' = hit.legacy_data_source_owner_id
      RETURNING b.id                 AS binding_id,
                b.tenant_id          AS tenant_id,
                b.connection_id      AS connection_id,
                hit.legacy_data_source_id,
                b.config->>'dataSourceOwnerId' AS legacy_data_source_owner_id
    )
    INSERT INTO ${sql.raw(LEDGER_TABLE)} (
      binding_id, tenant_id, connection_id, legacy_data_source_id, legacy_data_source_owner_id, migration_name
    )
    SELECT upd.binding_id, upd.tenant_id, upd.connection_id,
           upd.legacy_data_source_id, upd.legacy_data_source_owner_id, ${MIGRATION_NAME}
    FROM upd
    ON CONFLICT (binding_id) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id,
          connection_id = EXCLUDED.connection_id,
          legacy_data_source_id = EXCLUDED.legacy_data_source_id,
          legacy_data_source_owner_id = EXCLUDED.legacy_data_source_owner_id,
          migration_name = EXCLUDED.migration_name,
          backfilled_at = NOW()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, LEDGER_TABLE))) return
  if (await checkTableExists(db, 'integration_external_systems')) {
    // Restore ONLY rows this migration changed and that still look the way it left them:
    // same connection id, no pointer regained, still sql-readonly, still the SAME tenant and the
    // SAME owner stamp the ledger recorded (mirrors up()'s re-checks: a binding moved to another
    // tenant, or re-stamped to another owner, after the backfill must not be turned back into a
    // legacy pointer at the old tenant's / old owner's source). Anything a human changed in between
    // is left alone (its ledger row stays as evidence and keeps the table from dropping). These are
    // all predicates on `b`, so they are re-evaluated on the committed row if down() waits on a
    // concurrent writer's row lock.
    await sql`
      WITH restored AS (
        UPDATE integration_external_systems AS b
        SET connection_id = NULL,
            config = b.config || jsonb_build_object('dataSourceId', l.legacy_data_source_id)
        FROM ${sql.raw(LEDGER_TABLE)} AS l
        WHERE b.id = l.binding_id
          AND b.kind = ${SQL_READONLY_KIND}
          AND b.connection_id = l.connection_id
          AND b.tenant_id = l.tenant_id
          AND b.config->>'dataSourceOwnerId' = l.legacy_data_source_owner_id
          AND NOT (b.config ? 'dataSourceId')
          AND l.migration_name = ${MIGRATION_NAME}
        RETURNING b.id AS binding_id
      )
      DELETE FROM ${sql.raw(LEDGER_TABLE)} AS l
      WHERE l.binding_id IN (SELECT binding_id FROM restored)
    `.execute(db)
  }
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM ${sql.raw(LEDGER_TABLE)}) THEN
        DROP TABLE ${sql.raw(LEDGER_TABLE)};
      END IF;
    END $$
  `.execute(db)
}
