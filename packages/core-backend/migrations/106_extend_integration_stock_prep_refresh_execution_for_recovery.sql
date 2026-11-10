-- 106_extend_integration_stock_prep_refresh_execution_for_recovery.sql
-- plugin-integration-core · 备料 batch-refresh step 6a-1 (S6-1; register row R-91) — the EXECUTION INTENT JOURNAL, the
-- close shape of a verified execution, the SETTLEMENT SUBJECT flag, the pull-batch source digest of a stamping run, and
-- the recovered-from link of a recovery-written change plan. Extends migrations 103 (the execution ledger) and 104 (the
-- change plan). Step-6 design §3.2-§3.4 / §7.2, as amended by the 2026-11-09 rebaseline (items S6-1, C-3).
--
-- WHY (plan §5.2 「中途失败 / 提交后响应丢失 → 恢复后结果核对一致」; step-4 F-16). Before this migration nothing stored what
-- an execution INTENDED to write, so a recompute alone could not tell 「未写」 from 「已写且可核实」 from 「被后来操作改变」,
-- and every unfinished execution wedged its project 失败待恢复 until an owner-approved DB operation. 106 adds:
--   * integration_stock_prep_refresh_execution_intent — the JOURNAL: written in the SAME transaction as the execution
--     row, before the first sheet write. One row per chunk of at most 2000 entries; one entry per ADD / UPDATE /
--     INACTIVE decision of the in-lease plan: the decision index and kind, a key DIGEST, the expected record id and
--     version, an index into the chunk's field sets, and two 32-hex band digests (before / after). VALUES-FREE: digests,
--     record-id handles, schema field ids and integers only — never a cell value, a key or a part number.
--   * on the execution row: intent_version / intent_digest / intent_entry_count (NULL together; a legacy row begun
--     before 106 carries none and is never self-verified or recovered by a puller), the close shape of a
--     `verified_closed` row (closed_mode, pre_close_status, verify_summary, verify_lease_run_id, verify_fencing_epoch,
--     runbook_ref — written by the self-verifying finish now and by the recovery close of S6-2), settlement_subject,
--     and pull_batch_source_digest.
--   * settlement_subject (BOOLEAN NOT NULL DEFAULT true): false ONLY for a TRANSPARENT close — `verified_closed` with
--     `nothing_landed` of an execution not bound to a change plan (nothing landed and no confirmation was consumed, so
--     the project's derived state is exactly what it was before the attempt). Every existing row reads true (fail safe:
--     a legacy row is never transparent). The consult reads the newest settlement subjects per scope, so a subject is
--     never pushed out of the consult window by transparent closes behind it.
--   * pull_batch_source_digest: the 批次标识 digest (scheme stock-preparation-pull-batch-source/v1, 32 lowercase hex, NO
--     lane prefix — register R-65) of a run that stamped, NULL otherwise (the switch off, or the sheet not ready). S6-2's
--     recovery close hands it, unprefixed, to the pull-batch store's close hook. Not the step-4 source-content digest
--     (its scheme differs; the rebaseline item C-3 drops the design's `source_content_digest` column).
--   * change_plan.recovered_from_change_plan_id: the confirmed plan a recovery-written plan (S6-2, design §3.7 RW) was
--     carved from. NULL on every row this build writes.
--
-- VALUES. Every new column and the whole intent table are values-free (handles, closed tokens, digests, integers,
-- server clocks). verify_summary holds counts and closed tokens only.
--
-- LEGACY BACKFILL (design §7.2, OQ-14 default). Step-4 F-16 allowed an owner-approved runbook DB operation to close a
-- stuck execution before step 6. 102-105 are on no customer host before a main-based package (step-4 §23.9), so such
-- rows can exist only on dev / CI / test databases. They get an explicit legacy shape so every CHECK below VALIDATES; a
-- legacy row stays a settlement subject.
--
-- FAIL CLOSED / DEPLOY SHAPE. The governance consult reads settlement_subject on EVERY consult, for EVERY project — a
-- plugin build with step 6a-1 on a database without this migration answers 503 STOCK_PREP_REFRESH_STORE_FAILED
-- (`read_executions`, 42703) for every pull and every formal export: the 104 posture. Deploy this migration WITH the
-- build, never after it. A governed apply without the intent table refuses before any write (the begin is one
-- transaction: no execution row, no write).
--
-- RUNBOOK: the plugin runtime role needs SELECT and INSERT on integration_stock_prep_refresh_execution_intent, and (as
-- before) SELECT, INSERT and UPDATE on integration_stock_prep_refresh_execution and integration_stock_prep_change_plan.
--
-- ROLLBACK. Plugin SQL migrations are up-only; there is no down(). Roll back with the older build and RunMigrations 0.
-- An older build ignores every new column and the intent table, but it derives the RAW newest execution, and a
-- `verified_closed` one as 已完成 — so a transparent close newer than an unsettled `succeeded` or `verified_closed`
-- subject hides that subject from it. Before rolling back, settle every governed project whose newest settlement
-- subject is not named by settled_execution_id (zero required; an unfinished subject is already 失败待恢复 in both
-- builds and is covered by the 102 / 103 / 104 stop conditions):
--   SELECT count(*) FROM integration_stock_prep_refresh_state s
--    WHERE EXISTS (SELECT 1 FROM integration_stock_prep_refresh_execution e
--                   WHERE e.sheet_id = s.sheet_id AND e.project_no = s.project_no AND e.settlement_subject
--                     AND e.status IN ('succeeded', 'verified_closed') AND e.id IS DISTINCT FROM s.settled_execution_id
--                     AND e.started_at = (SELECT max(e2.started_at) FROM integration_stock_prep_refresh_execution e2
--                                          WHERE e2.sheet_id = s.sheet_id AND e2.project_no = s.project_no AND e2.settlement_subject));
-- next to the 102 / 103 / 104 stop conditions. Rows always stay.

ALTER TABLE integration_stock_prep_refresh_execution
  ADD COLUMN IF NOT EXISTS intent_version INTEGER,
  ADD COLUMN IF NOT EXISTS intent_digest TEXT,
  ADD COLUMN IF NOT EXISTS intent_entry_count INTEGER,
  ADD COLUMN IF NOT EXISTS pull_batch_source_digest TEXT,
  ADD COLUMN IF NOT EXISTS pre_close_status TEXT,
  ADD COLUMN IF NOT EXISTS closed_mode TEXT,
  ADD COLUMN IF NOT EXISTS verify_summary JSONB,
  ADD COLUMN IF NOT EXISTS verify_lease_run_id TEXT,
  ADD COLUMN IF NOT EXISTS verify_fencing_epoch INTEGER,
  ADD COLUMN IF NOT EXISTS runbook_ref TEXT,
  ADD COLUMN IF NOT EXISTS settlement_subject BOOLEAN NOT NULL DEFAULT true;

UPDATE integration_stock_prep_refresh_execution
   SET closed_mode = 'legacy_runbook',
       pre_close_status = 'unrecorded',
       verified_result = COALESCE(verified_result, 'unknown')
 WHERE status = 'verified_closed' AND closed_mode IS NULL;

-- The intent columns move together; a version is a positive integer; an empty plan journals zero entries.
ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_intent_shape_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_intent_shape_check
    CHECK ((intent_version IS NULL) = (intent_digest IS NULL) AND (intent_digest IS NULL) = (intent_entry_count IS NULL) AND (intent_version IS NULL OR intent_version >= 1) AND (intent_entry_count IS NULL OR intent_entry_count >= 0));

-- 批次标识's digest scheme (register R-65): 32 lowercase hex, no lane prefix; only on a journaled execution.
ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_batch_digest_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_batch_digest_check
    CHECK (pull_batch_source_digest IS NULL OR (pull_batch_source_digest ~ '^[0-9a-f]{32}$' AND intent_version IS NOT NULL));

ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_pre_close_status_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_pre_close_status_check
    CHECK (pre_close_status IS NULL OR pre_close_status IN ('running', 'partial', 'failed', 'aborted', 'unrecorded'));

ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_closed_mode_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_closed_mode_check
    CHECK (closed_mode IS NULL OR closed_mode IN ('self_verified', 'puller_verified', 'runbook', 'legacy_runbook'));

-- A verified_closed row says how it was closed, from which status, and with which result; no other row says any of it.
ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_close_shape_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_close_shape_check
    CHECK ((status = 'verified_closed') = (closed_mode IS NOT NULL) AND (status = 'verified_closed') = (pre_close_status IS NOT NULL) AND (status <> 'verified_closed' OR verified_result IS NOT NULL));

ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_runbook_shape_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_runbook_shape_check
    CHECK (COALESCE(closed_mode, '') <> 'runbook' OR (runbook_ref IS NOT NULL AND verified_result = 'unknown'));

-- A self-verified close proved nothing landed (zero confirmed writes AND zero attempted host writes).
ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_self_verified_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_self_verified_check
    CHECK (COALESCE(closed_mode, '') <> 'self_verified' OR (verified_result = 'nothing_landed' AND written = 0 AND attempted_writes = 0 AND intent_version IS NOT NULL));

-- Only a transparent close is not a settlement subject: verified_closed, nothing_landed, bound to no change plan.
ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_subject_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_subject_check
    CHECK (settlement_subject OR (status = 'verified_closed' AND verified_result = 'nothing_landed' AND (refresh_binding ->> 'changePlanId') IS NULL));

CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_execution_subject
  ON integration_stock_prep_refresh_execution (sheet_id, project_no, started_at DESC) WHERE settlement_subject;
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_execution_subject_project
  ON integration_stock_prep_refresh_execution (tenant_id, project_no, started_at DESC) WHERE settlement_subject;

-- ---------------------------------------------------------------------------------------------------
-- THE INTENT JOURNAL (one row per chunk; never deleted; written only by the execution begin)
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_refresh_execution_intent (
  id                TEXT PRIMARY KEY,
  execution_id      TEXT NOT NULL,
  chunk_index       INTEGER NOT NULL,
  tenant_id         TEXT NOT NULL,
  sheet_id          TEXT NOT NULL,
  project_no        TEXT NOT NULL,
  write_scope_key   TEXT NOT NULL,
  entry_count       INTEGER NOT NULL,
  entries           JSONB NOT NULL,
  fieldsets         JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_refresh_execution_intent_chunk_unique
    UNIQUE (execution_id, chunk_index),
  CONSTRAINT integration_stock_prep_refresh_execution_intent_chunk_check
    CHECK (chunk_index >= 0 AND entry_count BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_execution_intent_scope
  ON integration_stock_prep_refresh_execution_intent (sheet_id, project_no);

COMMENT ON TABLE integration_stock_prep_refresh_execution_intent IS
  'Stock-preparation batch-refresh step 6a-1: the values-free execution intent journal (key digests, record-id handles, schema field ids, band digests) written in the same transaction as its execution row, before the first sheet write. One row per chunk of at most 2000 entries. Never deleted; no down().';

ALTER TABLE integration_stock_prep_change_plan
  ADD COLUMN IF NOT EXISTS recovered_from_change_plan_id TEXT;
