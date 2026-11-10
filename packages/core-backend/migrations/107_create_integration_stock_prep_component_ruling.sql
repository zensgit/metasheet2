-- 107_create_integration_stock_prep_component_ruling.sql
-- plugin-integration-core · 备料 batch-refresh step 6d-1b (S6-5; register row R-91) — the COMPONENT RULING ledger: an
-- admin's recorded acknowledgement that a doubled-sheet "item-10" remnant (design §6.1 D2: a component whose old root row
-- is inactive, with no active root row and at least one active nested copy) is not separately ordered any more
-- (`remnant_acknowledged`, basis `head_not_ordered`), and — reserved for the CONDITIONAL step 6d-2b (S6-7; nothing in
-- this build writes it) — a scoped dropped-head ruling (`dropped_head_included`). Step-6 design §6.3, §6.5, §6.7, §7.3,
-- as amended by the 2026-11-09 rebaseline (B-8: readiness v5 carries ONLY the remnant check).
--
-- WHY (plan §6, §8 step A; design §6.3). A D2 project is pilotable only with the customer's Q1 answer for that component:
-- either S is no longer separately ordered (H0 — this table, kind `remnant_acknowledged`) or a scoped ruling (H1, S6-7).
-- Readiness v5 check `no_unacknowledged_inactive_root_remnant` reads this table: the project's D2 component handles minus
-- those with an ACTIVE `remnant_acknowledged` row must be empty. The acknowledgement is recorded only on the customer's
-- Q1 answer relayed by the owner (O6-5); the code enforces stock-prep:admin, a re-proof of the remnant shape on a fresh
-- project-scoped read, and a runbookRef. A WRONG acknowledgement fails closed: the first governed pilot computation
-- observes S's order head and suspends `dropped_order_head_unresolved` (design §6.3).
--
-- VALUES. `component_digest` is the census handle `sha256(tenant ':' project ':' componentSourceId)`, first 24 hex
-- (lib/stock-preparation-sheet-census.cjs componentHandle) — a digest of business values that can be brute-forced, so it
-- is PRIVATE: it is answered only to an authenticated stock-prep admin and never travels to an audit row, an issue or a
-- PR body (RD G4). No component id, part number, quantity or free-text note is stored. `runbook_ref` /
-- `revoked_runbook_ref` are values-free ticket handles (`^[A-Za-z0-9._:-]{1,64}$`, the close-unverified precedent).
-- `project_no` is a customer value, exactly as the project registry (087) already stores it. Owner gate Q-B is not
-- widened.
--
-- SHAPE.
--   * kind `remnant_acknowledged`: basis `head_not_ordered`, rules NULL, position_fingerprint NULL;
--   * kind `dropped_head_included` (S6-7): basis NULL, rules a JSON array, position_fingerprint 64 lowercase hex;
--   * status `active` (no revoke columns) | `revoked` (revoked_by, revoked_at and revoked_runbook_ref all present);
--   * at most ONE active row per (sheet, project, component, kind) — the partial UNIQUE index (23505 on a second one).
-- Rows are never deleted; a revoke is a status change.
--
-- AUDIT: no vocabulary change. Acknowledge / revoke append `exception_resolve` (066) with the closed modes
-- `remnant_acknowledged` / `remnant_acknowledgement_revoked` IN THE SAME TRANSACTION as the row (the D9 precedent,
-- stock-preparation-refresh-decisions.cjs REFRESH_DECISION_AUDIT); the census reads append `project_board_read` (086)
-- mode `sheet_census_read`, counts only.
--
-- DEPLOY SHAPE (design §7.4). Without this table the census routes still answer (their acknowledgement counts read
-- null), the acknowledgement routes answer 503, and readiness v5's remnant check is `ok: false` for EVERY project (no
-- enable). Deploy it WITH the build.
--
-- RUNBOOK: the plugin runtime role needs SELECT, INSERT and UPDATE on integration_stock_prep_component_ruling.
--
-- ROLLBACK. Plugin SQL migrations are up-only; there is no down(). Roll back with the older build and RunMigrations 0;
-- the table then stays, inert (no older build reads it). Informational pre-rollback count (design §7.5; not blocking):
--   SELECT kind, count(*) FROM integration_stock_prep_component_ruling WHERE status = 'active' GROUP BY kind;
--
-- SCOPE: every row names tenant_id, sheet_id and project_no. CREATE … IF NOT EXISTS, so a re-run over a populated table
-- changes nothing. Later vocabulary changes use migration 101's `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pattern.

CREATE TABLE IF NOT EXISTS integration_stock_prep_component_ruling (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  sheet_id              TEXT NOT NULL,
  project_no            TEXT NOT NULL,
  component_digest      TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  basis                 TEXT,
  rules                 JSONB,
  position_fingerprint  TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  runbook_ref           TEXT NOT NULL,
  recorded_by           TEXT NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by            TEXT,
  revoked_at            TIMESTAMPTZ,
  revoked_runbook_ref   TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_component_ruling_kind_check
    CHECK (kind IN ('remnant_acknowledged','dropped_head_included')),
  CONSTRAINT integration_stock_prep_component_ruling_basis_check
    CHECK (basis IS NULL OR basis IN ('head_not_ordered')),
  CONSTRAINT integration_stock_prep_component_ruling_status_check
    CHECK (status IN ('active','revoked')),
  CONSTRAINT integration_stock_prep_component_ruling_digest_shape_check
    CHECK (component_digest ~ '^[0-9a-f]{24}$'),
  CONSTRAINT integration_stock_prep_component_ruling_runbook_ref_shape_check
    CHECK (runbook_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  CONSTRAINT integration_stock_prep_component_ruling_kind_shape_check CHECK (
    (kind = 'remnant_acknowledged' AND basis IS NOT NULL AND basis = 'head_not_ordered' AND rules IS NULL AND position_fingerprint IS NULL)
    OR (kind = 'dropped_head_included' AND basis IS NULL AND rules IS NOT NULL AND jsonb_typeof(rules) = 'array'
        AND position_fingerprint IS NOT NULL AND position_fingerprint ~ '^[0-9a-f]{64}$')),
  CONSTRAINT integration_stock_prep_component_ruling_revoked_shape_check CHECK (
    (status = 'active' AND revoked_by IS NULL AND revoked_at IS NULL AND revoked_runbook_ref IS NULL)
    OR (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoked_runbook_ref IS NOT NULL
        AND revoked_runbook_ref ~ '^[A-Za-z0-9._:-]{1,64}$'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_component_ruling_active
  ON integration_stock_prep_component_ruling (sheet_id, project_no, component_digest, kind)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_component_ruling_scope
  ON integration_stock_prep_component_ruling (tenant_id, sheet_id, project_no);
