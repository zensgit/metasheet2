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
--   STEP 2b count the snapshot rows the stale-snapshot guard REFUSED to touch
--           (see "THE SNAPSHOT IS A CANDIDATE LIST" below). 0 on a quiet table.
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
-- not evidence of anything. WHICH FAILURE the row then produces depends on THAT
-- marker, and it is NOT one story for all rows. 01-inventory.sql prints it as
-- `legacy_fallback` precisely so the operator knows, per id, which branch this
-- row will take BEFORE approving APPLY=1. With `connection_id` NULL,
-- lib/connection-resolver.cjs:269-288 routes the binding to `resolveLegacy`:
--   marker FALSE → the first gate (:206-215) refuses it outright:
--           CONNECTION_LEGACY_FALLBACK_DENIED.
--   marker TRUE  → that first gate PASSES. This is the MAJORITY of what this
--           pack cleans: the back-fill in
--           zzzz20260902120000_add_integration_connection_binding.ts:97-106 is a
--           single UPDATE that sets `connection_id` AND the marker to TRUE while
--           leaving `config.dataSourceId` in place, so those rows come out of it
--           with pointer present + marker TRUE. They fail LATER in the same
--           branch instead: the legacy pointer is resolved through the SAME
--           facade call the canonical path uses (:235 vs :172), a soft-deleted
--           source is "not found" to that facade
--           (packages/core-backend/src/data-adapters/data-source-plugin-facade.ts:507-513)
--           → CONNECTION_LEGACY_UNAVAILABLE (:244-250); a source that does
--           resolve but is not owner-only → CONNECTION_LEGACY_FALLBACK_DENIED
--           (:251-257); and the branch additionally requires runAs='user'
--           (:217-223), i.e. it is strictly NARROWER than canonical.
-- NEITHER branch reads through a deleted source. The binding was already
-- broken; this makes it fail by name.
--
-- TRANSACTION SHAPE. One explicit transaction for the whole file. The snapshot
-- of the target rows lives in a `TEMP TABLE ... ON COMMIT DROP`, so STEP 1 and
-- STEP 2 act on the SAME set of ids and a row that became dangling between the
-- two statements cannot be half-processed. ON_ERROR_STOP (from
-- _preamble-write.sql) plus the explicit BEGIN means any error disconnects with
-- the transaction open and the server rolls everything back.
--
-- THE SNAPSHOT IS A CANDIDATE LIST, NEVER AN AUTHORISATION. The CTAS below
-- takes ACCESS SHARE only — it does NOT lock the rows it lists (no FOR UPDATE,
-- on purpose: holding row locks on a production table for the whole transaction
-- is a bigger footprint than this job is worth). So the OTHER direction of the
-- race is real: under READ COMMITTED a concurrent session can re-bind one of
-- these ids to a LIVE source, or restore its soft-deleted target, and commit
-- while STEP 1 is still running. STEP 1 / STEP 2 would then block on the row
-- lock, re-check their qual against the NEW row version (EPQ) and — if that qual
-- only said `es.id = d.key_id` — happily NULL a brand-new, perfectly valid
-- binding and stamp it with a receipt pointing at the old, deleted source.
-- Both statements therefore carry the same two extra predicates, which are what
-- EPQ re-evaluates:
--   AND es.connection_id IS NOT DISTINCT FROM d.target_id   (still the same target)
--   AND NOT EXISTS (… data_sources ds WHERE ds.live_id = es.connection_id)
--                                                           (still dangling)
-- A row that moved is SKIPPED, not silently rewritten; STEP 2b counts the
-- skips and STEP 4 makes APPLY=1 abort on any of them, so the operator re-runs
-- 01 + 02 on a fresh snapshot instead of committing a half-stale remediation.
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
-- Expected output: one row, `rows` == STEP0.needs_receipt (LESS any row a
-- concurrent session moved out from under the snapshot — see STEP 2b).
-- The two `es.connection_id` predicates are the stale-snapshot guard described
-- in the header: they are re-evaluated against the committed row version when
-- this UPDATE has to wait for a concurrent writer's row lock.
WITH upd AS (
  UPDATE integration_external_systems es
     SET config = jsonb_set(es.config, '{dataSourceId}', to_jsonb(d.target_id), true),
         updated_at = NOW()
    FROM h5_dangling d
   WHERE es.id = d.key_id
     AND d.config_object
     AND NOT d.config_pointer
     AND es.connection_id IS NOT DISTINCT FROM d.target_id
     AND NOT EXISTS (
           SELECT 1 FROM data_sources ds WHERE ds.live_id = es.connection_id
         )
  RETURNING es.id
)
SELECT 'STEP1_RECEIPT_WRITTEN' AS step, count(*)::int AS rows FROM upd;

-- ── STEP 2. Clear the dangling pointer ────────────────────────────────────
-- Expected output: one row, `rows` == STEP0.remediable (LESS the STEP 2b
-- skips). Same stale-snapshot guard as STEP 1 — without it this statement is
-- the one that destroys a concurrently re-bound pointer.
WITH upd AS (
  UPDATE integration_external_systems es
     SET connection_id = NULL,
         updated_at = NOW()
    FROM h5_dangling d
   WHERE es.id = d.key_id
     AND d.config_object
     AND es.connection_id IS NOT DISTINCT FROM d.target_id
     AND NOT EXISTS (
           SELECT 1 FROM data_sources ds WHERE ds.live_id = es.connection_id
         )
  RETURNING es.id
)
SELECT 'STEP2_CONNECTION_CLEARED' AS step, count(*)::int AS rows FROM upd;

-- ── STEP 2b. How many snapshot rows the guard refused to touch ────────────
-- Expected output: one row, `rows` = 0 on a quiet table. A remediable snapshot
-- row still holding a NON-NULL connection_id after STEP 2 is exactly a row the
-- guard skipped: it was re-bound elsewhere, or its target came back to life,
-- between STEP 0 and STEP 2. (A row deleted meanwhile drops out of the join and
-- is not counted — nothing was written to it either.)
-- This also catches the narrow mixed case — a row that passed STEP 1's guard and
-- then moved before STEP 2 — which would otherwise be left with a receipt that
-- no longer matches its `connection_id` (and would then fail resolution with
-- CONNECTION_BINDING_MISMATCH, lib/connection-resolver.cjs:193-200). The STEP 4
-- abort rolls that receipt back with everything else.
-- `rows` > 0 makes APPLY=1 abort at STEP 4: re-run 01, then 02 again.
SELECT 'STEP2_SKIPPED_STALE' AS step,
       count(*)::int AS rows
  FROM h5_dangling d
  JOIN integration_external_systems es ON es.id = d.key_id
 WHERE d.config_object
   AND es.connection_id IS NOT NULL;

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

-- ── STEP 4. Fail-closed: no receipt possible, or a stale snapshot ─────────
-- Only when actually applying: a dry run should still SHOW both counts
-- (STEP 0, STEP 2b) rather than abort before printing anything useful.
\if :apply_mode
DO $$
DECLARE blocked int;
DECLARE stale   int;
BEGIN
  SELECT count(*) INTO blocked FROM h5_dangling WHERE NOT config_object;
  IF blocked > 0 THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=non-object-config rows=%', blocked
      USING HINT = 'these bindings cannot hold a rollback receipt; resolve them by hand before APPLY=1';
  END IF;
  SELECT count(*) INTO stale
    FROM h5_dangling d
    JOIN integration_external_systems es ON es.id = d.key_id
   WHERE d.config_object
     AND es.connection_id IS NOT NULL;
  IF stale > 0 THEN
    RAISE EXCEPTION 'REMEDIATE_ABORT reason=stale-snapshot rows=%', stale
      USING HINT = 'these bindings were re-bound (or their target restored) while this run was in flight; nothing is committed — re-run 01-inventory.sql, then 02 again';
  END IF;
END $$;
\endif

-- ── Machine-readable outcome (last statement inside the transaction) ──────
-- `remediated` is the snapshot's remediable count MINUS the STEP 2b skips, so
-- it is what STEP 2 actually cleared, never what it hoped to clear.
WITH snap AS (
  SELECT count(*)::int                                     AS dangling,
         count(*) FILTER (WHERE config_object)::int        AS remediable,
         count(*) FILTER (WHERE NOT config_object)::int    AS blocked
    FROM h5_dangling
), stale AS (
  SELECT count(*)::int AS n
    FROM h5_dangling d
    JOIN integration_external_systems es ON es.id = d.key_id
   WHERE d.config_object
     AND es.connection_id IS NOT NULL
)
SELECT 'REMEDIATE_RESULT file=02-remediate.sql mode=' ||
       CASE WHEN :'apply_mode' = 'on' THEN 'apply' ELSE 'dry-run' END ||
       ' dangling_before=' || snap.dangling::text ||
       ' remediated=' || (snap.remediable - stale.n)::text ||
       ' blocked=' || snap.blocked::text ||
       ' stale_skipped=' || stale.n::text
       AS remediate_result
  FROM snap, stale;

\if :apply_mode
COMMIT;
\echo 'REMEDIATE_TX=committed'
\else
ROLLBACK;
\echo 'REMEDIATE_TX=rolled-back'
\endif
