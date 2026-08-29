-- 078_create_integration_b2a_operation_claim.sql
-- plugin-integration-core · B2a ONE-SOURCE-READ-OPERATION CLAIM
--
-- WHY THIS TABLE EXISTS (HG v1.2 §6.1 / §13 PR-C, closing PR-C's own self-disclosed gap)
-- `sourceReadOperationLimit` is 1: one B2a registration authorizes exactly ONE source-read
-- operation, and a different Run presenting the same registration must be refused. Until this
-- migration that limit was enforced over the plugin key-value storage contract, whose `set` is an
-- UNCONDITIONAL upsert (INSERT … ON CONFLICT DO UPDATE, see
-- packages/core-backend/src/plugins/plugin-durable-storage.ts) with no compare-and-set and no
-- transaction. `claimReadOperation` therefore did get -> set -> read back and verify. On ONE process
-- that is exact; on a store shared by several processes two writers interleaving between the
-- read-back and the set could BOTH conclude they won. An in-process read-then-write is explicitly
-- NOT a one-shot guarantee, and neither is a "single-instance deployment" note.
--
-- This table IS the guarantee, at the database, in the same shape migration 077 uses for the
-- confirmation-decision reconcile lease:
--   * claim_key is the PRIMARY KEY — one row per (registration id, registration version, scope
--     digest). Claiming is a plain INSERT, so two concurrent claimers for the same operation resolve
--     to exactly one holder at the unique index, inside the database. The loser reads the row back
--     and either CONTINUES on it (same run_id — bounded paging inside one operation, and the
--     large-BOM job that legitimately re-enters the guard for its own job id) or is refused with the
--     fixed code B2A_AUTHORIZATION_INVALID / reason `operation_already_consumed`.
--   * there is deliberately NO TTL and NO steal path, and that is the whole difference from 077. A
--     lease is a temporary right that must be recoverable when its holder dies; an operation claim
--     is PERMANENT — the registration's one authorization is spent, and a second source-read Run
--     needs a second registration and a second one-time human authorization. A claim that could
--     expire would be a renewable one-shot, which is a contradiction.
--   * rows are never UPDATEd or DELETEd by the runtime. Retiring an operation means writing a new
--     registration (a visible edit to a reviewed file), never clearing a row here.
--
-- The plugin_kv record under `integration:b2a:operation-claim:` survives as a values-free
-- PROJECTION only (it carries the `pageReads` re-entry counter that evidence stanzas report). It is
-- no longer the authority for who holds the operation: this row is.
--
-- See plugins/plugin-integration-core/lib/b2a-trial-registry.cjs (createB2aOperationClaim /
-- claimReadOperation) for the claim protocol, and the R-03/M78 cases in
-- __tests__/b2a-trial-registry.test.cjs for the two-concurrent-claimers proof.
--
-- Values-free by construction: claim_key and operation_digest are hashes plus a deployment-authored
-- registration slug, run_id is a server-composed Run identity, claimed_at is a server clock. No
-- business value, no credential and no customer identifier in the clear ever lands here.

CREATE TABLE IF NOT EXISTS integration_b2a_operation_claim (
  claim_key TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL,
  registration_version INTEGER NOT NULL,
  operation_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE integration_b2a_operation_claim IS
  'Durable one-shot source-read operation claim for B2a trial registrations (HG v1.2 PR-C). claim_key PRIMARY KEY = the DB-level uniqueness that makes sourceReadOperationLimit=1 real across processes; claims are permanent (no TTL, no steal, no runtime UPDATE/DELETE).';
