-- ============================================================================
-- 02-remediate.sql — RETIRE ACTIVE 073 bindings whose external system is gone
-- ============================================================================
-- *** THIS FILE WRITES. WITH `-v APPLY=1` IT IS A PRODUCTION WRITE AND NEEDS
-- *** OWNER AUTHORISATION (AGENTS.md 决策机制 O 层 ②). WITHOUT IT THE FILE IS A
-- *** DRY RUN THAT ALWAYS ENDS IN `ROLLBACK`.
--
-- WHAT IT DOES, for exactly the rows 01-inventory.sql counts as
-- `dangling_active`:
--   STEP 1  status = 'RETIRED'. That turns the generated column
--           live_external_system_id to NULL, which MATCH SIMPLE lets through,
--           so this is what makes
--           fk_sealed_export_stock_prep_binding_live_external_system
--           VALIDATE-able. Nothing else in the row changes: every other column
--           of a 073 binding is an immutable anchor
--           (073 trg_integration_sealed_export_stock_prep_binding_anchors_immutable),
--           and `updated_at` is stamped by 073's own BEFORE UPDATE trigger.
--   STEP 2  re-count dangling rows from the LIVE table (not from the snapshot)
--           and print it.
--   STEP 3  (APPLY=1 only) abort if STEP 2 is not 0 — the file commits only a
--           table with zero dangling ACTIVE bindings, or nothing at all.
--
-- WHY RETIRE, NOT DELETE, NOT RE-POINT.
--   * RETIRED is the state 073 already defines for "no longer live", the
--     state the delete guard already treats as history, and the state the FK
--     already ignores. It is the smallest change that satisfies the FK.
--   * DELETE is refused by 073's own runs FK (runs.binding_id ->
--     bindings.binding_id ON DELETE RESTRICT) whenever the binding has runs,
--     and would erase the history those runs anchor to.
--   * Re-pointing is impossible: external_system_id is an immutable anchor.
--
-- WHAT A RETIRED ROW MEANS AFTERWARDS. The S6-A runtime reads only ACTIVE
-- bindings (stock-preparation-runtime-store.cjs loadActiveBinding), so the
-- stock-prep sealed-export path for that tenant refuses with
-- SEALED_EXPORT_BINDING_UNQUALIFIED instead of failing later on a missing
-- system — it was already unusable (its system row is gone). 073's
-- single-customer index is freed, so a fresh provisioning can create a new
-- ACTIVE binding, which the FK now requires to name a LIVE system.
-- Runs are NOT touched (01 prints `inflight_runs_on_dangling`).
--
-- TRANSACTION SHAPE. One explicit transaction for the whole file. The target
-- rows are snapshotted into a `TEMP TABLE ... ON COMMIT DROP` so STEP 1 acts on
-- a fixed candidate list. ON_ERROR_STOP (from _preamble-write.sql) plus the
-- explicit BEGIN means any error disconnects with the transaction open and the
-- server rolls everything back.
--
-- THE SNAPSHOT IS A CANDIDATE LIST, NEVER AN AUTHORISATION. STEP 1 re-states
-- the whole dangling predicate on the row it updates (still ACTIVE, still the
-- same system id, system still absent), so a row that another session retired
-- in the meantime is skipped rather than rewritten. With the FK in place (this
-- file REQUIRES it — see the guard) no NEW dangling ACTIVE row can appear while
-- the file runs: an INSERT or RETIRED->ACTIVE flip naming an absent system is
-- refused 23503, and a DELETE of a system an ACTIVE binding names is refused
-- 23503. Registered, not guarded: a system row RE-CREATED with the same id
-- after STEP 1's statement snapshot is not seen by STEP 1's sub-select, so that
-- binding is retired anyway — the conservative direction (it must then be
-- re-provisioned; README §3).
--
-- NO FK RE-CHECK CAN FAIL IN THIS FILE. STEP 1 moves the referencing key from
-- a value to NULL; MATCH SIMPLE accepts NULL without a lookup. So the file runs
-- cleanly although every row it touches currently violates the NOT VALID FK.
--
-- VALUES-FREE. Output is counts only — no binding id, no system id, no tenant.
--
-- RUN WITH:
--   psql "$DATABASE_URL" -f 02-remediate.sql                  # DRY RUN (ROLLBACK)
--   psql "$DATABASE_URL" -v APPLY=1 -f 02-remediate.sql       # WRITES (COMMIT) — owner only
--   psql "$DATABASE_URL" -v schema=public -v lock_timeout=10s -f 02-remediate.sql
-- Only the exact literal `1` turns writing on; `-v APPLY=true`, `APPLY=yes`,
-- `APPLY=on`, `APPLY=0` and an unset APPLY all mean dry run.
-- The role running it needs UPDATE on the 073 bindings table (the table owner
-- has it; 073 revoked everything from PUBLIC).
-- ============================================================================

\ir _preamble-write.sql

-- ── Apply-mode gate: exact literal `1`, decided BEFORE the transaction ─────
\set apply_mode off
\if :{?APPLY}
SELECT CASE WHEN :'APPLY' = '1' THEN 'on' ELSE 'off' END AS apply_mode \gset
\endif

\echo '-- 02-remediate apply_mode (on = will COMMIT, off = dry run):'
\echo :apply_mode


BEGIN;

-- ── Guard: refuse to run against a schema the migration has not reached ───
-- Without the FK, a remediation is pointless (a new dangling row can land the
-- moment it commits) and the concurrency argument in the header does not hold.
DO $$
BEGIN
  IF to_regclass('integration_sealed_export_stock_prep_bindings') IS NULL THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=missing-table:integration_sealed_export_stock_prep_bindings';
  END IF;
  IF to_regclass('integration_external_systems') IS NULL THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=missing-table:integration_external_systems';
  END IF;
  IF to_regclass('integration_sealed_export_stock_prep_runs') IS NULL THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=missing-table:integration_sealed_export_stock_prep_runs';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_sealed_export_stock_prep_binding_live_external_system'
       AND conrelid = to_regclass('integration_sealed_export_stock_prep_bindings')
  ) THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=missing-constraint:fk_sealed_export_stock_prep_binding_live_external_system'
      USING HINT = 'run migration zzzz20260926140000 first';
  END IF;
END $$;

-- ── Snapshot: the same predicate 01-inventory.sql counts as dangling_active ─
CREATE TEMP TABLE s073_dangling ON COMMIT DROP AS
SELECT b.binding_id         AS key_id,
       b.external_system_id AS target_id
  FROM integration_sealed_export_stock_prep_bindings b
 WHERE b.status = 'ACTIVE'
   AND NOT EXISTS (
         SELECT 1 FROM integration_external_systems s
          WHERE s.id = b.external_system_id
       );

-- Expected output: one row. `dangling` must equal 01's dangling_active from the
-- same window; `inflight_runs` must equal 01's inflight_runs_on_dangling.
SELECT 'STEP0_SNAPSHOT' AS step,
       (SELECT count(*) FROM s073_dangling)::int AS dangling,
       (SELECT count(*)
          FROM integration_sealed_export_stock_prep_runs r
          JOIN s073_dangling d ON d.key_id = r.binding_id
         WHERE r.status NOT IN ('CAPTURE_FAILED', 'COMPLETED'))::int AS inflight_runs;

-- ── STEP 1. Retire the dangling ACTIVE bindings ───────────────────────────
-- Expected output: one row, `rows` == STEP0.dangling on a quiet table.
WITH upd AS (
  UPDATE integration_sealed_export_stock_prep_bindings b
     SET status = 'RETIRED'
    FROM s073_dangling d
   WHERE b.binding_id = d.key_id
     AND b.status = 'ACTIVE'
     AND b.external_system_id = d.target_id
     AND NOT EXISTS (
           SELECT 1 FROM integration_external_systems s
            WHERE s.id = b.external_system_id
         )
  RETURNING b.binding_id
)
SELECT 'STEP1_RETIRED' AS step, count(*)::int AS rows FROM upd;

-- ── STEP 2. Re-count from the LIVE table, not from the snapshot ───────────
-- Expected output: one row, `rows` = 0. In a DRY RUN this is still the
-- post-UPDATE number — what a COMMIT would leave behind — and the ROLLBACK
-- below throws it away.
SELECT 'STEP2_REMAINING_DANGLING' AS step,
       count(*)::int AS rows
  FROM integration_sealed_export_stock_prep_bindings b
 WHERE b.status = 'ACTIVE'
   AND NOT EXISTS (
         SELECT 1 FROM integration_external_systems s
          WHERE s.id = b.external_system_id
       );

-- ── STEP 3. Fail-closed: commit a clean table or nothing ──────────────────
-- Only when actually applying: a dry run should still SHOW the counts rather
-- than abort before printing anything useful.
\if :apply_mode
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining
    FROM integration_sealed_export_stock_prep_bindings b
   WHERE b.status = 'ACTIVE'
     AND NOT EXISTS (
           SELECT 1 FROM integration_external_systems s
            WHERE s.id = b.external_system_id
         );
  IF remaining > 0 THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=still-dangling rows=%', remaining
      USING HINT = 'nothing is committed — re-run 01-inventory.sql, then 02 again';
  END IF;
END $$;
\endif

-- ── Machine-readable outcome (last statement inside the transaction) ──────
-- `retired` counts snapshot rows that are RETIRED now, i.e. what STEP 1 (or a
-- concurrent session) actually left retired — never what it hoped to retire.
SELECT 'REMEDIATE_RESULT file=02-remediate.sql mode=' ||
       CASE WHEN :'apply_mode' = 'on' THEN 'apply' ELSE 'dry-run' END ||
       ' dangling_before=' || (SELECT count(*) FROM s073_dangling)::text ||
       ' retired=' || (
         SELECT count(*)
           FROM s073_dangling d
           JOIN integration_sealed_export_stock_prep_bindings b ON b.binding_id = d.key_id
          WHERE b.status = 'RETIRED'
       )::text ||
       ' remaining=' || (
         SELECT count(*)
           FROM integration_sealed_export_stock_prep_bindings b
          WHERE b.status = 'ACTIVE'
            AND NOT EXISTS (
                  SELECT 1 FROM integration_external_systems s
                   WHERE s.id = b.external_system_id
                )
       )::text
       AS remediate_result;

\if :apply_mode
COMMIT;
\echo 'REMEDIATE_TX=committed'
\else
ROLLBACK;
\echo 'REMEDIATE_TX=rolled-back'
\endif
