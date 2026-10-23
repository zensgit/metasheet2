-- 102_create_integration_stock_prep_continuation.sql
-- plugin-integration-core · 备料 batch-refresh step 4 PR-2 — the persisted 沿用关系 (CONTINUATION): one header
-- row per confirmed relationship, one MEMBER row per paired (old row, new position).
--
-- WHY THESE TABLES EXIST (plan docs/development/takeover-beiliao-20260821/batch-refresh-merge-plan-20261022.md
-- §4 「沿用关系必须持续参与规划」, §3.1.2, §9.1 A02/A03/A08; step-4 design §4.1). A puller confirms that an
-- independently prepared subtree (the old S rows, first pulled on their own order) IS the same demand as the
-- same component now nested under a new parent (P). From then on EVERY pull must know which new positions are
-- served by which existing records: the planner builds "do not ADD these new keys" and "do not sweep these old
-- rows" from the SAME member rows (one projection, design §6.2), and that must survive the third pull, a
-- restart, a second host and a plugin upgrade. A multitable record cannot arbitrate the claims below, so the
-- relationship lives HERE, in plugin SQL, the way the registry (087) and the write lock (100) do.
--
-- THE CLAIMS ARE DB FACTS (plan §3.1.2 「同一旧行集合不能同时抵两笔独立需求」, A08). Partial UNIQUE indexes
-- over `claim_active` rows make it impossible for two confirmations to COMMIT a claim on one old record, one
-- old key or one new position: the loser's 23505 is turned into 409 STOCK_PREP_CONTINUATION_CONFIRM_CONFLICT
-- by the store (plugins/plugin-integration-core/lib/stock-preparation-continuation-store.cjs). `claim_active`
-- is a CHECKed mirror of `status <> 'ended'` on the header, so ending a relationship (a status, never a DELETE)
-- is what releases its claims; member rows mirror their header inside the same transaction.
--
-- PRIVATE vs VALUES-FREE (design §4.4). Columns marked PRIVATE carry customer values (keys, paths, component
-- ids, quantities, the basis text) and are answered ONLY by audited pull-tier routes (a later PR). Everything
-- else is a handle (tenant / sheet / project / record ids), a closed token, a sha256 digest, an integer or a
-- server clock — the only columns a public surface, an error, an audit row or a log line may carry.
--
-- SCOPE: every row names tenant_id, sheet_id and project_no (trimmed exactly as `normalizeActionParameters`
-- trims the pull parameter) and `write_scope_key` = the sheet write lock's scope key ('spw2:' + sha256, R-52),
-- the values-free join handle to the lock row (migration 100). Rows are NEVER deleted.
--
-- ROLLBACK / G10. Plugin SQL migrations are up-only (packages/core-backend/src/db/migration-provider.ts); there
-- is no down(). The tables are additive and must OUTLIVE the feature (plan §7 「回退不得丢失关系后恢复旧扫尾」):
-- a plugin build that does not recognise continuations would ADD a copy and INACTIVE the old rows the next
-- time it refreshed a governed project. Rolling the PLUGIN build back is therefore FORBIDDEN while any
-- `claim_active` continuation, open hold, unfinished execution or pending review exists — the G10 handbook
-- check is `SELECT count(*) FROM integration_stock_prep_continuation WHERE claim_active` (and its siblings in
-- migration 103) with the stop condition "do not run pulls on governed projects under a pre-step-4 build".
-- Tables and rows always stay.
--
-- OWNER GATE (Q-B): persisting business values in the PRIVATE columns on the customer host, and their
-- retention, needs the owner's approval before this migration is DEPLOYED there. Development and CI are
-- not blocked by that gate. INTEGER, not BIGINT: node-postgres returns int8 as strings.
--
-- FAIL CLOSED: while these tables are missing, the governance reader answers 503
-- STOCK_PREP_REFRESH_STORE_FAILED for every consult — never "no continuation" — run migrations before deploying
-- a build whose lanes consult it (step 4 PR-3).

CREATE TABLE IF NOT EXISTS integration_stock_prep_continuation (
  id                              TEXT PRIMARY KEY,
  tenant_id                       TEXT NOT NULL,
  sheet_id                        TEXT NOT NULL,
  project_no                      TEXT NOT NULL,
  write_scope_key                 TEXT NOT NULL,
  status                          TEXT NOT NULL DEFAULT 'active',
  status_reason                   TEXT,
  revision                        INTEGER NOT NULL DEFAULT 1,
  old_root_record_id              TEXT NOT NULL,
  old_root_key                    TEXT NOT NULL,            -- PRIVATE
  old_root_component_source_id    TEXT NOT NULL,            -- PRIVATE
  new_parent_component_source_id  TEXT NOT NULL,            -- PRIVATE
  new_root_path_tokens            JSONB NOT NULL,           -- PRIVATE (new keys are recomputed from these)
  new_root_key                    TEXT NOT NULL,            -- PRIVATE
  new_root_key_digest             TEXT NOT NULL,
  parent_edge_usage               NUMERIC,                  -- PRIVATE, display only (never written to a row)
  external_system_id              TEXT NOT NULL,
  source_scope_digest             TEXT NOT NULL,
  read_plan_digest                TEXT NOT NULL,
  pairing_fingerprint             TEXT NOT NULL,
  comparison_fingerprint          TEXT NOT NULL,
  evidence_fingerprint            TEXT NOT NULL,
  evidence_history_status         TEXT NOT NULL DEFAULT 'history_unknown',
  evidence_snapshot               JSONB NOT NULL,           -- PRIVATE
  demand_basis                    TEXT NOT NULL,
  basis_note                      TEXT,                     -- PRIVATE
  applicability_scope             TEXT NOT NULL DEFAULT 'this_project_this_position',
  confirmed_by                    TEXT NOT NULL,
  confirmed_at                    TIMESTAMPTZ NOT NULL,
  confirmed_generation            INTEGER NOT NULL,
  confirmed_generation_token      TEXT NOT NULL,
  confirmed_fencing_epoch         INTEGER NOT NULL,
  executed_execution_id           TEXT,
  last_verified_at                TIMESTAMPTZ,
  last_verdict                    TEXT,
  last_verified_generation_token  TEXT,
  ended_by                        TEXT,
  ended_at                        TIMESTAMPTZ,
  ended_outcome                   TEXT,
  ended_note                      TEXT,                     -- PRIVATE
  claim_active                    BOOLEAN NOT NULL DEFAULT true,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_continuation_status_check
    CHECK (status IN ('active', 'needs_reconfirmation', 'ended')),
  -- The closed status_reason vocabulary (design §9.4; the pure core's CONTINUATION_VERDICTS minus `valid` and
  -- minus `content_changed`, which raises a relationship_content_change hold and never moves the status).
  CONSTRAINT integration_stock_prep_continuation_status_reason_check
    CHECK (status_reason IS NULL OR status_reason IN (
      'source_scope_changed', 'new_position_removed', 'new_position_occupied',
      'old_record_missing', 'old_record_inactive', 'old_record_replaced', 'old_subtree_duplicate',
      'structure_changed', 'demand_changed', 'evidence_changed', 'evidence_incomplete'
    )),
  -- NULL while active; required while needs_reconfirmation; kept as a fact once ended.
  CONSTRAINT integration_stock_prep_continuation_status_reason_shape_check
    CHECK ((status <> 'active' OR status_reason IS NULL) AND (status <> 'needs_reconfirmation' OR status_reason IS NOT NULL)),
  CONSTRAINT integration_stock_prep_continuation_revision_check
    CHECK (revision >= 1),
  CONSTRAINT integration_stock_prep_continuation_generation_check
    CHECK (confirmed_generation >= 0 AND confirmed_fencing_epoch >= 0),
  CONSTRAINT integration_stock_prep_continuation_evidence_history_check
    CHECK (evidence_history_status IN ('history_unknown', 'relationship_snapshot', 'demand_evidence_store')),
  -- Phase-1 closed vocabularies: a customer-rule basis / a wider scope is a later token added WITH its config.
  CONSTRAINT integration_stock_prep_continuation_demand_basis_check
    CHECK (demand_basis IN ('puller_confirmed_same_demand')),
  CONSTRAINT integration_stock_prep_continuation_applicability_scope_check
    CHECK (applicability_scope IN ('this_project_this_position')),
  CONSTRAINT integration_stock_prep_continuation_basis_note_check
    CHECK (basis_note IS NULL OR char_length(basis_note) <= 2000),
  -- The verification callback's last verdict (the pure core's CONTINUATION_VERDICTS, `valid` included).
  CONSTRAINT integration_stock_prep_continuation_last_verdict_check
    CHECK (last_verdict IS NULL OR last_verdict IN (
      'valid', 'source_scope_changed', 'new_position_removed', 'new_position_occupied',
      'old_record_missing', 'old_record_inactive', 'old_record_replaced', 'old_subtree_duplicate',
      'structure_changed', 'demand_changed', 'evidence_changed', 'evidence_incomplete', 'content_changed'
    )),
  CONSTRAINT integration_stock_prep_continuation_ended_outcome_check
    CHECK (ended_outcome IS NULL OR ended_outcome IN ('superseded_by_new_confirmation', 'release_to_normal_refresh', 'escalate_special_repair')),
  -- Ending is a status with an actor, a clock and an outcome — all three or none (design §4.1).
  CONSTRAINT integration_stock_prep_continuation_ended_shape_check
    CHECK ((status = 'ended') = (ended_at IS NOT NULL) AND (status = 'ended') = (ended_outcome IS NOT NULL) AND (status = 'ended') = (ended_by IS NOT NULL)),
  -- The claim mirror is a DB fact, not a store promise: a row cannot be ended and still claim, nor claim-free while live.
  CONSTRAINT integration_stock_prep_continuation_claim_active_check
    CHECK (claim_active = (status <> 'ended'))
);

-- A08 / plan §3.1.2: one new position is served by at most ONE live relationship on a sheet ...
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_continuation_new_root
  ON integration_stock_prep_continuation (tenant_id, sheet_id, new_root_key_digest) WHERE claim_active;

-- ... and one old root serves at most ONE demand (two independent demands cannot both claim it).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_continuation_old_root
  ON integration_stock_prep_continuation (tenant_id, sheet_id, old_root_record_id) WHERE claim_active;

-- The two reads the governance consult makes: by (tenant, project) AND by sheet (design §5.1).
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_continuation_project
  ON integration_stock_prep_continuation (tenant_id, project_no);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_continuation_sheet
  ON integration_stock_prep_continuation (sheet_id);

COMMENT ON TABLE integration_stock_prep_continuation IS
  'Stock-preparation batch-refresh step 4: one persisted continuation (沿用关系) per confirmed "old subtree = new position" relationship, per (tenant, sheet, project). Status lifecycle active / needs_reconfirmation / ended; claim_active mirrors status <> ended and drives the partial unique claims (A08). PRIVATE value columns are answered only by audited pull-tier routes. Never deleted; no down().';

-- ---------------------------------------------------------------------------------------------------
-- The MEMBERS: 逐行配对 — the projection's source of truth. Position 0 is the subtree root (relative path []).
-- Identity columns are never UPDATEd by the store (only claim_active mirrors the header), so no trigger is needed.
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_continuation_member (
  id                       TEXT PRIMARY KEY,
  continuation_id          TEXT NOT NULL REFERENCES integration_stock_prep_continuation (id),
  tenant_id                TEXT NOT NULL,
  sheet_id                 TEXT NOT NULL,
  project_no               TEXT NOT NULL,
  write_scope_key          TEXT NOT NULL,
  position                 INTEGER NOT NULL,
  relative_path_tokens     JSONB NOT NULL,           -- PRIVATE; [] for the root
  component_source_id      TEXT NOT NULL,            -- PRIVATE
  old_record_id            TEXT NOT NULL,
  old_key                  TEXT NOT NULL,            -- PRIVATE
  old_key_digest           TEXT NOT NULL,
  new_key                  TEXT NOT NULL,            -- PRIVATE
  new_key_digest           TEXT NOT NULL,
  old_row_content_digest   TEXT NOT NULL,
  claim_active             BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_continuation_member_position_check
    CHECK (position >= 0),
  CONSTRAINT uniq_integration_stock_prep_continuation_member_position
    UNIQUE (continuation_id, position)
);

-- The DB form of plan §3.1.2 and A08, per row: an old record, an old key and a new position are each claimed by
-- at most ONE live member on a sheet. The loser of a concurrent confirm gets 23505 -> 409 CONFIRM_CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_continuation_member_old_record
  ON integration_stock_prep_continuation_member (sheet_id, old_record_id) WHERE claim_active;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_continuation_member_old_key
  ON integration_stock_prep_continuation_member (sheet_id, old_key_digest) WHERE claim_active;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_continuation_member_new_key
  ON integration_stock_prep_continuation_member (sheet_id, new_key_digest) WHERE claim_active;

CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_continuation_member_continuation
  ON integration_stock_prep_continuation_member (continuation_id);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_continuation_member_project
  ON integration_stock_prep_continuation_member (tenant_id, project_no);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_continuation_member_sheet
  ON integration_stock_prep_continuation_member (sheet_id);

COMMENT ON TABLE integration_stock_prep_continuation_member IS
  'Stock-preparation batch-refresh step 4: the per-row pairing of one continuation (old record id + old key -> new key at a relative path). claim_active mirrors the header inside the same transaction; three partial unique indexes make a double claim (A08) impossible to commit. PRIVATE value columns are answered only by audited pull-tier routes. Never deleted; no down().';
