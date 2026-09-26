-- ============================================================================
-- 01-inventory.sql — READ-ONLY census of dangling 073 sealed-export bindings
-- ============================================================================
-- WHY THIS FILE EXISTS. Migration
--   packages/core-backend/src/db/migrations/zzzz20260926140000_sealed_export_binding_live_external_system_fk.ts
-- adds to integration_sealed_export_stock_prep_bindings (073) a STORED
-- generated column
--   live_external_system_id = CASE WHEN status = 'ACTIVE' THEN external_system_id END
-- and the FK
--   fk_sealed_export_stock_prep_binding_live_external_system
--   (live_external_system_id) -> integration_external_systems(id)
--   ON DELETE RESTRICT NOT VALID
-- NOT VALID means every INSERT / key-changing UPDATE from that migration on is
-- checked in full, while an ACTIVE binding that was ALREADY pointing at a
-- deleted system when it ran is tolerated and never scanned. Until such rows
-- are gone the constraint cannot be VALIDATEd, and "no ACTIVE binding points
-- at a deleted system" is a promise about future writes, not a fact.
--
-- This file answers, read-only and VALUES-FREE: HOW MANY such rows exist, plus
-- the counts an owner needs before approving 02 / 03. It prints NO id, NO
-- tenant and NO row value — counts and booleans only.
--
-- WHAT COUNTS AS DANGLING — exactly what VALIDATE will check (MATCH SIMPLE on
-- the generated column), spelled over the BASE columns so the census also runs
-- BEFORE the migration (to size the problem ahead of a deploy):
--   status = 'ACTIVE'
--   AND NOT EXISTS (SELECT 1 FROM integration_external_systems s
--                    WHERE s.id = b.external_system_id)
-- RETIRED rows are history: the generated column is NULL for them, the FK
-- never looks at them, and the delete guard never counts them
-- (plugins/plugin-integration-core/lib/external-systems.cjs,
-- LIVE_SEALED_EXPORT_BINDING_STATUS). They are counted here for context only.
--
-- ONE STATEMENT, ONE CTE. Every count in the Q2 block is a FILTER over ONE
-- `classified` CTE — not several statements that each repeat a predicate
-- (the #5786 F4 lesson: a count and its breakdown computed from two
-- predicates can disagree). When the generated column exists, Q3 re-counts
-- the dangling rows THROUGH that column, the way the FK itself sees them; the
-- two numbers must agree (verify/run-verify.mjs asserts it), which is what
-- proves the column's definition has not drifted from the rule the census
-- and the delete guard use.
--
-- RUN WITH (the only supported form):
--   psql "$DATABASE_URL" -f 01-inventory.sql
--   psql "$DATABASE_URL" -v schema=public -f 01-inventory.sql
-- Read-only: every statement is a SELECT and the session is pinned
-- default_transaction_read_only = on by the preamble.
-- ============================================================================

\ir _preamble.sql


-- ── Q1. Schema probe + dispatch ───────────────────────────────────────────
-- Resolution: current_schemas(false) — the exact schemas Q2/Q3 resolve through.
SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'integration_sealed_export_stock_prep_bindings'
       ) AS has_bindings,
       EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'integration_external_systems'
       ) AS has_systems,
       EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'integration_sealed_export_stock_prep_runs'
       ) AS has_runs,
       EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('integration_sealed_export_stock_prep_bindings')
            AND attname = 'live_external_system_id'
            AND attgenerated = 's'
            AND NOT attisdropped
       ) AS has_live_column,
       EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('integration_sealed_export_stock_prep_bindings')
            AND attname = 'live_external_system_id'
            AND NOT attisdropped
       ) AS has_any_live_column,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_sealed_export_stock_prep_binding_live_external_system'
            AND conrelid = to_regclass('integration_sealed_export_stock_prep_bindings')
       ) AS has_live_fk,
       COALESCE((
         SELECT convalidated FROM pg_constraint
          WHERE conname = 'fk_sealed_export_stock_prep_binding_live_external_system'
            AND conrelid = to_regclass('integration_sealed_export_stock_prep_bindings')
       ), false) AS live_fk_validated
\gset

\echo '-- generated column present / live FK present / already validated (false = still NOT VALID):'
\echo :has_live_column :has_live_fk :live_fk_validated


\if :has_bindings
\if :has_systems
\if :has_runs

-- ── Q2. THE census — one statement, one `classified` CTE ───────────────────
-- Expected output: EXACTLY ONE row, printed even when every count is 0.
-- Columns:
--   active_total              ACTIVE bindings. S6-A is single-customer
--                             (073 uniq_..._single_customer: at most ONE
--                             ACTIVE row in the whole table), so 0 or 1.
--   dangling_active           ACTIVE bindings whose system row is ABSENT —
--                             what VALIDATE fails on. 0 = go straight to 03.
--   tenant_mismatch_active    ACTIVE bindings whose system row EXISTS but under
--                             another tenant. NOT a VALIDATE blocker (the FK is
--                             on id alone, like 057's pipeline FKs), but the
--                             delete guard's tenant-scoped count cannot see such
--                             a row, so deleting that system is refused by the
--                             database with a raw 23503 — README §1.
--   retired_total             RETIRED bindings (history; the FK ignores them).
--   retired_system_absent     RETIRED bindings whose system row is absent
--                             (history; context only, never a blocker).
--   inflight_runs_on_dangling runs (073 runs table) in a non-terminal status
--                             (anything but CAPTURE_FAILED / COMPLETED) that
--                             reference a dangling binding. Retiring (02) does
--                             not touch runs; such a run could not resume
--                             anyway, because its system is gone. Shown so an
--                             owner approving 02 knows the number.
WITH classified AS (
  SELECT b.status = 'ACTIVE' AS active,
         EXISTS (
           SELECT 1 FROM integration_external_systems s
            WHERE s.id = b.external_system_id
         ) AS system_present,
         EXISTS (
           SELECT 1 FROM integration_external_systems s
            WHERE s.id = b.external_system_id AND s.tenant_id = b.tenant_id
         ) AS system_same_tenant,
         (
           SELECT count(*) FROM integration_sealed_export_stock_prep_runs r
            WHERE r.binding_id = b.binding_id
              AND r.status NOT IN ('CAPTURE_FAILED', 'COMPLETED')
         ) AS inflight_runs
    FROM integration_sealed_export_stock_prep_bindings b
)
SELECT count(*) FILTER (WHERE active)::int                                          AS active_total,
       count(*) FILTER (WHERE active AND NOT system_present)::int                   AS dangling_active,
       count(*) FILTER (WHERE active AND system_present AND NOT system_same_tenant)::int
                                                                                     AS tenant_mismatch_active,
       count(*) FILTER (WHERE NOT active)::int                                      AS retired_total,
       count(*) FILTER (WHERE NOT active AND NOT system_present)::int               AS retired_system_absent,
       COALESCE(sum(inflight_runs) FILTER (WHERE active AND NOT system_present), 0)::int
                                                                                     AS inflight_runs_on_dangling
  FROM classified;

\if :has_live_column
-- ── Q3. Cross-check THROUGH the generated column (post-migration only) ─────
-- Expected output: EXACTLY ONE row.
--   generated_drift        rows whose live_external_system_id differs from
--                          CASE WHEN status='ACTIVE' THEN external_system_id END.
--                          MUST be 0 — anything else means the column is not
--                          the one the migration defines.
--   dangling_by_fk_column  the dangling count as the FK itself computes it.
--                          MUST equal Q2.dangling_active.
SELECT count(*) FILTER (
         WHERE b.live_external_system_id IS DISTINCT FROM
               (CASE WHEN b.status = 'ACTIVE' THEN b.external_system_id END)
       )::int AS generated_drift,
       count(*) FILTER (
         WHERE b.live_external_system_id IS NOT NULL
           AND NOT EXISTS (
                 SELECT 1 FROM integration_external_systems s
                  WHERE s.id = b.live_external_system_id
               )
       )::int AS dangling_by_fk_column
  FROM integration_sealed_export_stock_prep_bindings b;
\else
\echo '-- live_external_system_id (generated) absent — migration zzzz20260926140000 not applied here; Q3 skipped, Q2 is still valid.'
\endif

\else
\echo '-- integration_sealed_export_stock_prep_runs absent — Q2/Q3 skipped.'
\endif
\else
\echo '-- integration_external_systems absent — Q2/Q3 skipped.'
\endif
\else
\echo '-- integration_sealed_export_stock_prep_bindings absent (migration 073 not applied here) — Q2/Q3 skipped.'
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- A run WITHOUT this line is incomplete, whatever else it printed.
-- `live_column=missing` is NOT incomplete: the Q2 census is spelled over base
-- columns and is valid before the migration too. A column of that NAME that is
-- NOT a stored generated column is incomplete — the FK would then not carry the
-- ACTIVE-only rule, and the migration itself refuses to continue over it.
SELECT 'INVENTORY_RESULT file=01-inventory.sql status=' ||
       CASE
         WHEN NOT p.has_bindings THEN 'incomplete reason=missing-table:integration_sealed_export_stock_prep_bindings'
         WHEN NOT p.has_systems  THEN 'incomplete reason=missing-table:integration_external_systems'
         WHEN NOT p.has_runs     THEN 'incomplete reason=missing-table:integration_sealed_export_stock_prep_runs'
         WHEN p.has_any_live_column AND NOT p.has_live_column
                                 THEN 'incomplete reason=live-column-not-generated'
         ELSE 'complete live_column=' || CASE WHEN p.has_live_column THEN 'present' ELSE 'missing' END ||
              ' live_fk=' || CASE WHEN p.has_live_fk THEN 'present' ELSE 'missing' END ||
              ' validated=' || CASE WHEN p.live_fk_validated THEN 'yes' ELSE 'no' END
       END AS inventory_result
  FROM (
    SELECT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'integration_sealed_export_stock_prep_bindings') AS has_bindings,
           EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'integration_external_systems') AS has_systems,
           EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = ANY (current_schemas(false))
                      AND table_name = 'integration_sealed_export_stock_prep_runs') AS has_runs,
           EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = to_regclass('integration_sealed_export_stock_prep_bindings')
                      AND attname = 'live_external_system_id'
                      AND attgenerated = 's'
                      AND NOT attisdropped) AS has_live_column,
           EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = to_regclass('integration_sealed_export_stock_prep_bindings')
                      AND attname = 'live_external_system_id'
                      AND NOT attisdropped) AS has_any_live_column,
           EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'fk_sealed_export_stock_prep_binding_live_external_system'
                      AND conrelid = to_regclass('integration_sealed_export_stock_prep_bindings')) AS has_live_fk,
           COALESCE((SELECT convalidated FROM pg_constraint
                      WHERE conname = 'fk_sealed_export_stock_prep_binding_live_external_system'
                        AND conrelid = to_regclass('integration_sealed_export_stock_prep_bindings')), false)
             AS live_fk_validated
  ) p;
