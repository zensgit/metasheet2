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
 * WHICH ROWS (all six predicates are required, see the structural test):
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
 * only ledger rows whose binding still carries the connection id the ledger recorded and has not
 * regained a pointer, deletes those ledger rows, and drops the ledger only when it is empty — a
 * binding re-bound by a human after the backfill is left as the human left it, with its ledger
 * row kept as evidence.
 *
 * NOT TOUCHED: `updated_at` (this is not a user edit), `legacy_connection_fallback_eligible`,
 * credentials, capabilities, every other kind, every row whose pointer does not resolve.
 */
import { sql, type Kysely } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

const MIGRATION_NAME = 'zzzz20260920150000_backfill_sql_readonly_legacy_connection_id'
const LEDGER_TABLE = 'integration_external_system_connection_backfills'
const SQL_READONLY_KIND = 'data-source:sql-readonly'

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
  // guards make the write re-prove all seven predicates against the CURRENT rows:
  //   * binding side (predicates 1, 2, 3, 4, 6 and the marker): repeated in the UPDATE's own WHERE,
  //     against `b` = the row being written. When the UPDATE waits on a writer's row lock,
  //     PostgreSQL re-evaluates this WHERE on the committed new row version (EvalPlanQual), so a
  //     row that was rebound, re-kinded, re-pointed, re-stamped, moved tenant or flagged in between
  //     is SKIPPED, not overwritten. (The `hit` columns are frozen CTE values; they are compared
  //     against the live row, never written blindly.)
  //   * source side (predicates 3-6 on `ds`): `FOR SHARE OF ds` locks every joined source for the
  //     rest of the transaction and, if a source was being changed, re-evaluates the join against
  //     the committed new version. A concurrent soft-delete / owner change / tenant change of the
  //     source therefore either finishes first (and the candidate drops out) or waits until the
  //     backfill commits.
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
    // same connection id, no pointer regained, still sql-readonly. Anything a human re-bound in
    // between is left alone (its ledger row stays as evidence and keeps the table from dropping).
    await sql`
      WITH restored AS (
        UPDATE integration_external_systems AS b
        SET connection_id = NULL,
            config = b.config || jsonb_build_object('dataSourceId', l.legacy_data_source_id)
        FROM ${sql.raw(LEDGER_TABLE)} AS l
        WHERE b.id = l.binding_id
          AND b.kind = ${SQL_READONLY_KIND}
          AND b.connection_id = l.connection_id
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
