-- ============================================================================
-- 02-remediate.sql — clear dangling `connection_id`, keeping a rollback receipt
-- ============================================================================
-- *** THIS FILE WRITES. WITH `-v APPLY=1` IT IS A PRODUCTION WRITE AND NEEDS
-- *** OWNER AUTHORISATION (AGENTS.md 决策机制 O 层 ②). WITHOUT IT THE FILE IS A
-- *** DRY RUN THAT ALWAYS ENDS IN `ROLLBACK`.
--
-- WHAT IT DOES, for exactly the rows 01-inventory.sql lists:
--   STEP 1  where `config` is a JSON object and `config->>'dataSourceId'` is
--           absent/blank — i.e. the CANONICAL binding shape, which
--           lib/external-systems.cjs:486 + :548-553 creates by deleting the
--           legacy pointer from `config` before INSERT — write the current
--           `connection_id` into `config.dataSourceId`. That value is the ONLY
--           record of which source this binding pointed at; STEP 2 destroys the
--           column that holds it, so the receipt must be written first, in the
--           same transaction.
--           Rows that ALREADY carry a non-blank `config.dataSourceId` (the
--           legacy/cutover shape) are left alone — the receipt exists.
--   STEP 2  `connection_id = NULL` for those rows. NULL is what MATCH SIMPLE
--           lets through, so this is what makes
--           fk_integration_external_systems_live_connection_id VALIDATE-able.
--   STEP 3  re-count dangling rows from the live table (not from the snapshot)
--           and print it.
--
-- WHY NOT DELETE THE BINDING ROW. The binding carries name, kind, role,
-- capabilities, credentials and its own downstream references
-- (integration_pipelines.source_system_id / target_system_id, ON DELETE
-- RESTRICT — migrations/057_create_integration_core_tables.sql:57,60). Nulling
-- the pointer is the smallest change that satisfies the FK, and it is
-- reversible; deleting is neither.
--
-- WHAT IT REFUSES TO TOUCH. A row whose `config` is not a JSON object cannot
-- receive a receipt without overwriting whatever is there. Such rows are
-- counted, reported as `blocked`, and skipped. With APPLY=1 a non-zero blocked
-- count ABORTS the transaction rather than leaving a half-clean table that 03
-- would then fail on: fail-closed, and the operator gets a named reason.
--
-- WHAT IT DOES NOT CHANGE. `legacy_connection_fallback_eligible` stays exactly
-- as it was — it is server-owned cutover evidence, and a dangling pointer is
-- not evidence of anything. Consequence, deliberately: after STEP 2 the row has
-- a legacy-shaped pointer with the marker still FALSE, so
-- lib/connection-resolver.cjs:206-212 refuses to resolve it
-- (CONNECTION_LEGACY_FALLBACK_DENIED) instead of quietly reading through a
-- deleted source. The binding was already broken; this makes it fail by name.
--
-- TRANSACTION SHAPE. One explicit transaction for the whole file. The snapshot
-- of the target rows lives in a `TEMP TABLE ... ON COMMIT DROP`, so STEP 1 and
-- STEP 2 act on the SAME set of ids and a row that became dangling between the
-- two statements cannot be half-processed. ON_ERROR_STOP (from
-- _preamble-write.sql) plus the explicit BEGIN means any error disconnects with
-- the transaction open and the server rolls everything back.
--
-- NO FK RE-CHECK IS TRIGGERED BY EITHER STEP. STEP 1 does not touch
-- `connection_id`, and PostgreSQL skips the RI check when the referencing key
-- columns are unchanged; STEP 2 sets it to NULL, which MATCH SIMPLE accepts
-- without a lookup. So this file runs cleanly even though every row it touches
-- currently violates the (NOT VALID) constraint.
--
-- RUN WITH:
--   psql "$DATABASE_URL" -f 02-remediate.sql                  # DRY RUN (ROLLBACK)
--   psql "$DATABASE_URL" -v APPLY=1 -f 02-remediate.sql       # WRITES (COMMIT) — owner only
--   psql "$DATABASE_URL" -v schema=public -v lock_timeout=10s -f 02-remediate.sql
-- Only the exact literal `1` turns writing on; `-v APPLY=true`, `APPLY=yes`,
-- `APPLY=0` and an unset APPLY all mean dry run.
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

-- ── Guard: refuse to run against a schema #5896 has not reached ───────────
DO $$
BEGIN
  IF to_regclass('integration_external_systems') IS NULL THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=missing-table:integration_external_systems';
  END IF;
  IF to_regclass('data_sources') IS NULL THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=missing-table:data_sources';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = ANY (current_schemas(false))
       AND table_name = 'data_sources' AND column_name = 'live_id'
  ) THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=missing-column:data_sources.live_id'
      USING HINT = 'run the #5896 migration (zzzz20260920120000) first';
  END IF;
END $$;

-- ── Snapshot: the same predicate 01-inventory.sql reports ─────────────────
CREATE TEMP TABLE h5_dangling ON COMMIT DROP AS
SELECT es.id                AS key_id,
       es.connection_id     AS target_id,
       jsonb_typeof(es.config) = 'object' AS config_object,
       COALESCE(NULLIF(BTRIM(CASE WHEN jsonb_typeof(es.config) = 'object'
                                  THEN es.config->>'dataSourceId' END), ''), '') <> ''
                            AS config_pointer
  FROM integration_external_systems es
 WHERE es.connection_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM data_sources d WHERE d.live_id = es.connection_id
       );

-- Expected output: one row. `dangling` must equal 01's TOTAL.n from the same
-- window; `blocked` > 0 means APPLY=1 will abort at STEP 4 by design.
SELECT 'STEP0_SNAPSHOT'                                          AS step,
       count(*)::int                                             AS dangling,
       count(*) FILTER (WHERE config_object)::int                AS remediable,
       count(*) FILTER (WHERE NOT config_object)::int            AS blocked,
       count(*) FILTER (WHERE config_object AND NOT config_pointer)::int AS needs_receipt,
       count(*) FILTER (WHERE config_object AND config_pointer)::int     AS receipt_already_present
  FROM h5_dangling;

-- ── STEP 1. Write the rollback receipt into config.dataSourceId ───────────
-- Expected output: one row, `rows` == STEP0.needs_receipt.
WITH upd AS (
  UPDATE integration_external_systems es
     SET config = jsonb_set(es.config, '{dataSourceId}', to_jsonb(d.target_id), true),
         updated_at = NOW()
    FROM h5_dangling d
   WHERE es.id = d.key_id
     AND d.config_object
     AND NOT d.config_pointer
  RETURNING es.id
)
SELECT 'STEP1_RECEIPT_WRITTEN' AS step, count(*)::int AS rows FROM upd;

-- ── STEP 2. Clear the dangling pointer ────────────────────────────────────
-- Expected output: one row, `rows` == STEP0.remediable.
WITH upd AS (
  UPDATE integration_external_systems es
     SET connection_id = NULL,
         updated_at = NOW()
    FROM h5_dangling d
   WHERE es.id = d.key_id
     AND d.config_object
  RETURNING es.id
)
SELECT 'STEP2_CONNECTION_CLEARED' AS step, count(*)::int AS rows FROM upd;

-- ── STEP 3. Re-count from the LIVE table, not from the snapshot ───────────
-- Expected output: one row, `rows` == STEP0.blocked (0 on a clean remediation).
-- In a DRY RUN this is still the post-UPDATE number — it is what a COMMIT
-- would leave behind — and the ROLLBACK below throws it away.
SELECT 'STEP3_REMAINING_DANGLING' AS step,
       count(*)::int AS rows
  FROM integration_external_systems es
 WHERE es.connection_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM data_sources d WHERE d.live_id = es.connection_id
       );

-- ── STEP 4. Fail-closed on rows that could not get a receipt ──────────────
-- Only when actually applying: a dry run should still SHOW the blocked count
-- (STEP 0) rather than abort before printing anything useful.
\if :apply_mode
DO $$
DECLARE blocked int;
BEGIN
  SELECT count(*) INTO blocked FROM h5_dangling WHERE NOT config_object;
  IF blocked > 0 THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=non-object-config rows=%', blocked
      USING HINT = 'these bindings cannot hold a rollback receipt; resolve them by hand before APPLY=1';
  END IF;
END $$;
\endif

-- ── Machine-readable outcome (last statement inside the transaction) ──────
SELECT 'REMEDIATE_RESULT file=02-remediate.sql mode=' ||
       CASE WHEN :'apply_mode' = 'on' THEN 'apply' ELSE 'dry-run' END ||
       ' dangling_before=' || (SELECT count(*)::text FROM h5_dangling) ||
       ' remediated=' || (SELECT count(*) FILTER (WHERE config_object)::text FROM h5_dangling) ||
       ' blocked=' || (SELECT count(*) FILTER (WHERE NOT config_object)::text FROM h5_dangling)
       AS remediate_result;

\if :apply_mode
COMMIT;
\echo 'REMEDIATE_TX=committed'
\else
ROLLBACK;
\echo 'REMEDIATE_TX=rolled-back'
\endif
