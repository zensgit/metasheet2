-- 103_create_integration_stock_prep_refresh_state.sql
-- plugin-integration-core · 备料 batch-refresh step 4 PR-2 — the per-project REFRESH STATE row, the HOLD ledger
-- (挂起 / 待确认) and the EXECUTION ledger (逻辑执行 ID). Sibling of migration 102 (continuations).
--
-- WHY THESE TABLES EXIST (plan §5.2 「保存稳定的逻辑执行 ID、计划及操作身份和可核实结果」, §5.3 「确认状态与执行
-- 状态分开」, §9.1 A11; step-4 design §4.2, §8.4, §9).
--   * integration_stock_prep_refresh_state — ONE row per (sheet, project), created by the first governed
--     computation and never deleted. `decision_version` moves ONLY when a puller decides (confirm / re-confirm /
--     end / change-plan confirm / review complete); every hold reconciliation is a compare-and-set on it, so a
--     computation that straddled a decision never persists a stale hold set (409 STOCK_PREP_PULL_STATE_MOVED).
--     `version` moves on every write (diagnostic). The settled_* columns record the last SETTLED computation —
--     zero pending decisions, no holds — which is what the formal export re-checks (design §9.2, §11).
--   * integration_stock_prep_refresh_hold — what the puller's page shows and what a confirmation binds to.
--     Keyed by a content FINGERPRINT (same hold across computations = same row); `UNIQUE ... WHERE status =
--     'open'` makes two concurrent computations of one project benign. `runbook_only` marks a hold that an
--     owner-approved runbook alone may close (design §8.4 `escalate_special_repair`): a computation never
--     supersedes it, so the project stays suspended.
--   * integration_stock_prep_refresh_execution — the logical execution id minted BEFORE the first main-sheet
--     write, bound to the lease / epoch / generation it ran under. A `running` row whose lease is no longer live
--     is READ as 结果未知 (derived, design §9.1); nothing here is ever deleted.
--
-- STATE IS DERIVED, NOT STORED: the status token (未启用 / 待确认 / 执行中 / 失败待恢复 / ...) is computed by
-- plugins/plugin-integration-core/lib/stock-preparation-refresh-state.cjs from these rows plus the lock row.
--
-- PRIVATE vs VALUES-FREE (design §4.4): `refresh_hold.detail` is PRIVATE (candidates with pairs, seven-item
-- before/after, demand facts, per-field content changes). Everything else is a handle, a closed token, a digest,
-- an integer, a boolean or a server clock. `subject` carries record-id / digest handles only.
--
-- SCOPE: every row names tenant_id, sheet_id, project_no and write_scope_key (the sheet write lock's scope key,
-- migration 100). INTEGER, not BIGINT. Plugin SQL migrations are up-only; there is no down(): see migration
-- 102's rollback / G10 note — the same stop condition covers open holds (`WHERE status = 'open'`), unfinished executions (`WHERE status IN ('running',
-- 'partial', 'failed', 'aborted')`) and, from step 5 on, pending reviews. OWNER GATE Q-B applies to the PRIVATE
-- `detail` column exactly as to migration 102's value columns.

CREATE TABLE IF NOT EXISTS integration_stock_prep_refresh_state (
  id                                       TEXT PRIMARY KEY,
  tenant_id                                TEXT NOT NULL,
  sheet_id                                 TEXT NOT NULL,
  project_no                               TEXT NOT NULL,
  write_scope_key                          TEXT NOT NULL,
  version                                  INTEGER NOT NULL DEFAULT 0,
  decision_version                         INTEGER NOT NULL DEFAULT 0,
  governed_since                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_computation_at                      TIMESTAMPTZ,
  last_computation_lane                    TEXT,
  last_computation_generation_token        TEXT,
  last_computation_source_content_digest   TEXT,
  last_computation_suspended               BOOLEAN,
  hold_set_fingerprint                     TEXT,
  settled_at                               TIMESTAMPTZ,
  settled_execution_id                     TEXT,
  settled_generation_token                 TEXT,
  settled_sheet_machine_digest             TEXT,
  settled_source_content_digest            TEXT,
  reviewed_content_digest                  TEXT,
  reviewed_at                              TIMESTAMPTZ,
  reviewed_by                              TEXT,
  created_at                               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_refresh_state_version_check
    CHECK (version >= 0 AND decision_version >= 0),
  CONSTRAINT integration_stock_prep_refresh_state_lane_check
    CHECK (last_computation_lane IS NULL OR last_computation_lane IN ('small_preview', 'small_apply', 'reconcile', 'mvp_persist'))
);

-- ONE row per (sheet, project): the first-computation race lands here (the store UPSERTs, then locks the row).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_refresh_state_sheet_project
  ON integration_stock_prep_refresh_state (sheet_id, project_no);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_state_project
  ON integration_stock_prep_refresh_state (tenant_id, project_no);

COMMENT ON TABLE integration_stock_prep_refresh_state IS
  'Stock-preparation batch-refresh step 4: one row per (sheet, project) governed by the refresh state machine. decision_version is the CAS every hold reconciliation is keyed on (moved only by puller decisions); settled_* records the last settled computation the formal export re-checks. Values-free; never deleted; no down().';

-- ---------------------------------------------------------------------------------------------------
-- HOLDS
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_refresh_hold (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  sheet_id                  TEXT NOT NULL,
  project_no                TEXT NOT NULL,
  write_scope_key           TEXT NOT NULL,
  kind                      TEXT NOT NULL,
  fingerprint               TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'open',
  confirmable               BOOLEAN NOT NULL,
  not_confirmable_reason    TEXT,
  shape_token               TEXT,
  runbook_only              BOOLEAN NOT NULL DEFAULT false,
  continuation_id           TEXT,
  subject                   JSONB NOT NULL,
  detail                    JSONB NOT NULL,           -- PRIVATE
  evidence_fingerprint      TEXT,
  comparison_fingerprint    TEXT,
  pairing_fingerprint       TEXT,
  opened_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_lane               TEXT,
  opened_generation_token   TEXT,
  last_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at               TIMESTAMPTZ,
  resolved_by               TEXT,
  resolution                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The pure core's HOLD_KINDS (stock-preparation-continuation-pairing.cjs), re-listed in full.
  CONSTRAINT integration_stock_prep_refresh_hold_kind_check
    CHECK (kind IN (
      'continuation_candidate', 'candidate_ambiguous', 'candidate_target_occupied', 'candidate_old_duplicate',
      'candidate_keyless_rows', 'candidate_structure_differs', 'candidate_incomplete_evidence',
      'candidate_content_differs', 'candidate_shape_unresolved', 'dropped_order_head_unresolved',
      'relationship_reconfirm', 'relationship_content_change', 'content_change', 'structure_change'
    )),
  CONSTRAINT integration_stock_prep_refresh_hold_status_check
    CHECK (status IN ('open', 'resolved', 'superseded')),
  -- The pure core's NOT_CONFIRMABLE_REASONS; present exactly when the hold has no confirm control.
  CONSTRAINT integration_stock_prep_refresh_hold_not_confirmable_reason_check
    CHECK (not_confirmable_reason IS NULL OR not_confirmable_reason IN (
      'specialist_repair', 'ambiguous_pairing', 'keyless_rows_present', 'customer_rule_pending',
      'phase_2', 'evidence_incomplete', 'needs_step5', 'reconfirm_not_admissible'
    )),
  CONSTRAINT integration_stock_prep_refresh_hold_confirmable_shape_check
    CHECK (confirmable = (not_confirmable_reason IS NULL)),
  -- The pure core's SHAPE_TOKENS (design §9.4 plus `dropped_other_rule`, errata §23.3).
  CONSTRAINT integration_stock_prep_refresh_hold_shape_token_check
    CHECK (shape_token IS NULL OR shape_token IN (
      'old_root_still_ordered', 'sheet_metal_dual', 'no_dash_hierarchy', 'root_selection_disabled',
      'parent_before_child', 'dropped_other_rule'
    )),
  CONSTRAINT integration_stock_prep_refresh_hold_opened_lane_check
    CHECK (opened_lane IS NULL OR opened_lane IN ('small_preview', 'small_apply', 'reconcile', 'mvp_persist')),
  CONSTRAINT integration_stock_prep_refresh_hold_resolution_check
    CHECK (resolution IS NULL OR resolution IN (
      'continuation_confirmed', 'continuation_ended', 'change_plan_confirmed', 'superseded_by_computation', 'runbook_closed'
    )),
  -- Open holds carry no resolution; closed holds carry a resolution and a clock.
  CONSTRAINT integration_stock_prep_refresh_hold_resolution_shape_check
    CHECK ((status = 'open') = (resolution IS NULL) AND (status = 'open') = (resolved_at IS NULL)),
  -- A runbook-only hold is never confirmable from the page.
  CONSTRAINT integration_stock_prep_refresh_hold_runbook_only_check
    CHECK (runbook_only = false OR confirmable = false)
);

-- Same hold content => same row while open; the concurrent-preview race is benign (design §8.4).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_refresh_hold_open
  ON integration_stock_prep_refresh_hold (sheet_id, project_no, fingerprint) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_hold_scope_status
  ON integration_stock_prep_refresh_hold (tenant_id, sheet_id, project_no, status);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_hold_project_status
  ON integration_stock_prep_refresh_hold (tenant_id, project_no, status);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_hold_continuation
  ON integration_stock_prep_refresh_hold (continuation_id);

COMMENT ON TABLE integration_stock_prep_refresh_hold IS
  'Stock-preparation batch-refresh step 4: the holds (挂起 / 待确认) a governed computation raised, keyed by content fingerprint (one open row per fingerprint per sheet+project). `detail` is PRIVATE (answered only by audited pull-tier routes); every other column is values-free. runbook_only holds are closed only by an owner-approved runbook. Never deleted; no down().';

-- ---------------------------------------------------------------------------------------------------
-- EXECUTIONS (逻辑执行 ID; minimal in step 4, extended by step 6)
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_refresh_execution (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  sheet_id            TEXT NOT NULL,
  project_no          TEXT NOT NULL,
  write_scope_key     TEXT NOT NULL,
  lane                TEXT NOT NULL,
  lease_run_id        TEXT NOT NULL,
  lease_id            TEXT NOT NULL,
  fencing_epoch       INTEGER NOT NULL,
  generation          INTEGER NOT NULL,
  generation_token    TEXT NOT NULL,
  token_revision      TEXT NOT NULL,
  plan_digest         TEXT NOT NULL,
  planned_counts      JSONB NOT NULL,
  refresh_binding     JSONB NOT NULL,
  status              TEXT NOT NULL DEFAULT 'running',
  started_by          TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  written             INTEGER,
  attempted_writes    INTEGER,
  counts              JSONB,
  abort_code          TEXT,
  error_codes         JSONB,
  verified_by         TEXT,
  verified_at         TIMESTAMPTZ,
  verified_result     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Phase 1 supports the small lane only (design D7 / D12): the step-5 controlled update is an ordinary small apply.
  CONSTRAINT integration_stock_prep_refresh_execution_lane_check
    CHECK (lane IN ('small_apply')),
  CONSTRAINT integration_stock_prep_refresh_execution_generation_check
    CHECK (fencing_epoch >= 0 AND generation >= 0),
  CONSTRAINT integration_stock_prep_refresh_execution_status_check
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'aborted', 'verified_closed')),
  CONSTRAINT integration_stock_prep_refresh_execution_counts_check
    CHECK ((written IS NULL OR written >= 0) AND (attempted_writes IS NULL OR attempted_writes >= 0)),
  -- A running row has no finish clock; every other status has one.
  CONSTRAINT integration_stock_prep_refresh_execution_finished_shape_check
    CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT integration_stock_prep_refresh_execution_verified_result_check
    CHECK (verified_result IS NULL OR verified_result IN ('landed', 'nothing_landed', 'mixed', 'unknown')),
  -- Step 6 closes an execution with a verification; the two columns move together.
  CONSTRAINT integration_stock_prep_refresh_execution_verified_shape_check
    CHECK ((status = 'verified_closed') = (verified_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_execution_scope_started
  ON integration_stock_prep_refresh_execution (sheet_id, project_no, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_execution_scope_status
  ON integration_stock_prep_refresh_execution (sheet_id, project_no, status);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_execution_project
  ON integration_stock_prep_refresh_execution (tenant_id, project_no);

COMMENT ON TABLE integration_stock_prep_refresh_execution IS
  'Stock-preparation batch-refresh step 4: the logical execution ledger (one row per small-lane apply run, minted before its first main-sheet write) bound to the lease, fencing epoch and plan generation it ran under. A running row without its live lease is read as unknown-result (derived). Values-free; never deleted; no down().';
