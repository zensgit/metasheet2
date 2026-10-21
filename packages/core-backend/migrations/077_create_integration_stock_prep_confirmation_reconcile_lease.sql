-- 077_create_integration_stock_prep_confirmation_reconcile_lease.sql
-- plugin-integration-core · stock-prep confirmation-decision RECONCILE LEASE
--
-- WHY THIS TABLE EXISTS (HG v1.2 §13 PR-A hard requirement)
-- The confirmation-decision ledger rows live in a MetaSheet-managed multitable sheet, which offers
-- no uniqueness constraint or transactional upsert a plugin could lean on. Reconcile therefore
-- needs its single-active-reconciler guarantee HERE, at the database: an in-process lock, or a
-- "single-instance deployment" note, is explicitly NOT a concurrency guarantee. This table IS the
-- durable lease:
--   * scope_key is the PRIMARY KEY — one row per reconcile scope (a hash of staging project +
--     projectNo, never a business value). Fresh acquisition is a plain INSERT, so two concurrent
--     acquirers resolve to exactly one holder at the unique index, inside the database.
--   * takeover of an EXPIRED lease is a single-statement CAS UPDATE guarded by the previous
--     lease_id — of two stealers exactly one updates a row.
--   * release DELETEs only the caller's own (scope_key, lease_id); an unreleased lease simply
--     expires by TTL (expires_at) and becomes stealable.
-- The loser of any race receives the fixed conflict code CONFIRMATION_DECISION_RECONCILE_BUSY and
-- has written nothing; reconcile replay is idempotent, so retrying after the holder finishes is a
-- no-op. See plugins/plugin-integration-core/lib/stock-preparation-confirmation-decisions.cjs
-- (createConfirmationDecisionReconcileLease) for the acquire/steal/release protocol, and the A-04
-- acceptance test in __tests__/stock-preparation-confirmation-decisions.test.cjs for the
-- two-independent-reconcilers proof.
--
-- Values-free by construction: scope_key and lease_id are hashes/uuids, the two timestamps are
-- server clocks. No business value ever lands here.

CREATE TABLE IF NOT EXISTS integration_stock_prep_confirmation_reconcile_lease (
  scope_key TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE integration_stock_prep_confirmation_reconcile_lease IS
  'Durable single-active-reconciler lease for the stock-preparation confirmation-decision ledger (HG v1.2 PR-A). scope_key PRIMARY KEY = the DB-level uniqueness; expired leases are taken over by CAS on lease_id.';
