-- 100_create_integration_stock_prep_project_write_lock.sql
-- plugin-integration-core · stock-prep SHEET WRITE LOCK (lease + plan generation), one row per target sheet
--
-- WHY THIS TABLE EXISTS (batch-refresh phase 0 step 1; plan §5.1, §7 G5, §9.2 E01–E04/E07/E08)
-- Two different runs must never write the SAME canonical 备料 sheet at the same time, across processes —
-- and a small-lane run planned BEFORE a newer plan was made must never write afterwards, even sequentially
-- (the large lane only orders approvals against previews; see the module header, R4). The multitable records API offers neither a uniqueness constraint a plugin could
-- lean on nor a write conditional on a plugin row, so both guarantees live HERE, in one row per write
-- scope. The WRITE SCOPE IS THE TARGET SHEET (decision register R-52): the foreign-project guard keeps
-- every sheet to one active project, so a per-sheet row costs no parallelism and closes the race in
-- which two project numbers applied at once to one empty sheet both pass that guard:
--   * the LEASE (lease_id + lease_seq + fencing_epoch + lease_expires_at): acquired by INSERT or by a
--     single-statement CAS, renewed by a CAS immediately before EVERY canonical-sheet write, released by
--     a CAS; a lease that lapsed (expiry + takeover grace) is taken over by a CAS pinned to the exact
--     holder, epoch and seq observed, which records the interruption (last_interrupted_*);
--   * the PLAN GENERATION (generation_token): a UUID replaced on every applicable small preview by a
--     caller who may apply, and on every large approval, by a CAS that requires lease_id IS NULL — so no bump ever commits while a live
--     holder holds the lease. Every token / approved job stores the generation_token it was planned
--     under; a run compares it AFTER acquiring the lease and re-asserts it in every per-write CAS.
--     `generation` is a diagnostic counter only; bindings compare the token, never the integer.
-- See plugins/plugin-integration-core/lib/stock-preparation-project-write-lock.cjs for the protocol and
-- its accepted residual (one host write in flight across a >= TTL+GRACE suspension).
--
-- Rows are NEVER deleted (release clears the lease columns), so a generation can only move forward.
-- Values-free by construction: scope_key is 'spw2:' + sha256 of (namespace, target sheet id);
-- lease ids and generation tokens are UUIDs; purpose / reason / run ids are a closed vocabulary and
-- server-minted ids; tenant_id is the last acquirer / bumper, for audit only (not part of the identity).
-- INTEGER, not BIGINT: node-postgres returns int8 as strings.
--
-- FAIL CLOSED: while this table is missing the plugin refuses (503
-- STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED) every preview with a valid project number, every small
-- apply, every large approval and every large chunk — run migrations before deploying the plugin.

CREATE TABLE IF NOT EXISTS integration_stock_prep_project_write_lock (
  scope_key TEXT PRIMARY KEY,
  tenant_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  generation_token TEXT NOT NULL,
  generation_reason TEXT,
  generation_bumped_at TIMESTAMPTZ,
  fencing_epoch INTEGER NOT NULL DEFAULT 0 CHECK (fencing_epoch >= 0),
  lease_id TEXT,
  lease_seq INTEGER NOT NULL DEFAULT 0 CHECK (lease_seq >= 0),
  lease_purpose TEXT,
  lease_run_id TEXT,
  lease_acquired_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  lease_heartbeat_at TIMESTAMPTZ,
  last_interrupted_run_id TEXT,
  last_interrupted_purpose TEXT,
  last_interrupted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_project_write_lock_lease_shape CHECK (
    (lease_id IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL AND lease_purpose IS NULL)
    OR (lease_id IS NOT NULL AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_purpose IS NOT NULL)
  )
);

COMMENT ON TABLE integration_stock_prep_project_write_lock IS
  'Stock-preparation sheet write lock (batch-refresh phase 0 step 1): one row per TARGET SHEET (scope_key = ''spw2:'' + sha256 of the sheet id; decision register R-52) holding the cross-process write lease and the plan generation. scope_key PRIMARY KEY; never deleted; values-free.';
