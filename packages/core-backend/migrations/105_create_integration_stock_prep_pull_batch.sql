-- 105_create_integration_stock_prep_pull_batch.sql
-- plugin-integration-core · 备料 批次标识 (pull batch; batch-identifier design BI-1a, register R-65) — the LEDGER behind
-- the two sheet columns 首次批次 (firstPullBatch) and 本次拉取 (pullBatch), and the PAGE SETTINGS of the owner's
-- 2026-11-07 configuration request. Dormant: no build reads or writes these tables yet (BI-1b wires stamping, BI-2
-- the install, BI-7 the settings routes; every one of them sits behind STOCK_PREP_PULL_BATCH_ENABLED, default OFF).
--
-- OWNER DECISIONS. 2026-10-27: 批次标识 goes to ALL stock-prep projects. 首次批次 = the first batch in which this
-- material appeared in the project; 本次拉取 = the batch of the pull that CREATED this row (UPDATE / INACTIVE never
-- restamp a band cell). Approved example: S-01 有效=否 首次=第1批 本次=第1批; S-01 有效=是 首次=第1批 本次=第2批;
-- P-07 有效=是 首次=第2批 本次=第2批. 2026-11-07: 「批次就按系统中的批次设计方案」 (the design as written) and
-- 「能否也做个页面配置项，默认就按我们10-27的方案…」 — four page settings whose built-in defaults ARE the 10-27 design.
--
-- WHY THESE TABLES EXIST (plan §5.2 「拉取批次按一次已批准的逻辑拉取标识新增物料 … 执行 ID 和批次关联在第一笔写入前
-- 持久保存，跨块、重试、进程接管均复用 … 后续无新增的刷新不产生新的物料批次」).
--   * integration_stock_prep_pull_batch_settings — ONE row per tenant: the tenant DEFAULT of the four page settings.
--     No row = the built-in defaults (the 10-27 design). A default is only ever COPIED into a sheet row when the sheet
--     is born or installed; changing it never moves a sheet that already captured its settings. The tenant default
--     placement never waives STOCK_PREP_PULL_BATCH_PLACEMENT_REQUIRED (an install whose views would lose their frozen
--     columns still has to name a placement itself).
--   * integration_stock_prep_pull_batch_sheet — ONE row per (sheet, project): readiness, install state, the persisted
--     history plan, and the sheet's CAPTURED settings. A sheet stamps only once its history is resolved (`born_empty`
--     / `backfilled`); `installing` makes every pull lane refuse (409 STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS).
--   * integration_stock_prep_pull_batch — one row per batch, numbered per (sheet, project) in opening order, opened
--     ONLY by an execution that actually creates a row (lazy allocation, before the first create carrying its label).
--     `open` until an execution finishes `succeeded`; a later execution with the SAME content digest joins it. `void`
--     is a status (rows are never deleted). No stored counter: a batch's row count is the sum of its links'
--     `created_row_count`, computed when read (one finisher per link, counts set by value).
--   * integration_stock_prep_pull_batch_execution — the execution <-> batch link, keyed by the execution
--     (`small:<lease run id>` / `large:<apply job id>`, UNIQUE), so every chunk, resume and takeover of one logical
--     execution reuses the batch it opened.
--
-- THE SETTINGS VOCABULARY (coordinator ruling C2, register R-65). Every IN-list below is EXACTLY the pure module's
-- token set (plugins/plugin-integration-core/lib/stock-preparation-pull-batch.cjs); a hermetic test reads this file
-- and pins the two to each other (stock-preparation-pull-batch-vocabulary-migration.test.cjs). First = default:
--   first_pull_batch_rule  'material' (按物料) | 'predecessor_suffix' (按位置)    locked when the sheet first stamps
--   label_format           'ordinal_date' (第N批（YYYY-MM-DD）) | 'ordinal' (第N批) locked when the sheet first stamps
--   landing_mode           'promote_prep_fill' | 'keep_current'                   locked once applied
--   band_placement         'left' | 'right'                                       locked once applied
-- Not configurable (fixed facts, never stored): 本次拉取 means the CREATING pull; the formal export excludes the band;
-- trashed rows are never 首次 evidence.
--
-- THE LOCK. `settings_locked_at` is set by the first live allocation (or the install's Txn A) in the same transaction
-- that hands out a label: from that commit on the sheet's rule and format are fixed, so no sheet ever carries labels of
-- two meanings. It is NEVER cleared, with ONE exception (ruling C7, design §8.2 permanence rule): aborting a FIRST
-- install (`installing` -> `pending`) clears it iff no row carries a label of the persisted plan and the project has no
-- live batch. landing_mode / band_placement are NULL until the step that applies them ran; non-NULL = locked.
--
-- NOT `snapshotBatchId`. The mvp archive's batch (stock-preparation-batch-identity.cjs) is a different concept;
-- nothing here reads, writes or renames it.
--
-- PRIVACY: `project_no` is a customer value, exactly as the project registry (087) already stores it. Nothing else here
-- is: ids, closed tokens, integers, server clocks, digests and the label (an ordinal, a server calendar day and a
-- closed marker). No material id, key, path or quantity is stored, so owner gate Q-B is not widened.
--
-- AUDIT: no vocabulary change. Settings writes are audited under the EXISTING action `project_fields_update` (088)
-- with closed modes (`pull_batch_settings_tenant_updated` / `pull_batch_settings_sheet_updated`), the D9 precedent
-- (stock-preparation-refresh-decisions.cjs REFRESH_DECISION_AUDIT); install modes ride `project_target_create`.
--
-- SCOPE: every ledger row names tenant_id, sheet_id and project_no. INTEGER, not BIGINT. No write_scope_key: the R
-- maintenance line has no sheet write lock, and this file is byte-identical on both lines. CREATE … IF NOT EXISTS.
-- Later vocabulary changes use migration 101's `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pattern.
--
-- ROLLBACK: up-only, there is no down(). A rolled-back build cannot `db:migrate` with 105 recorded (the O-20 class),
-- so a rollback uses `RunMigrations 0`; the four tables then stay, inert (no older build reads them). Once any sheet
-- carries the band, the line is forward-fix only (design §12.4).
--
-- RUNBOOK: the plugin runtime role needs SELECT, INSERT and UPDATE on all four tables.

CREATE TABLE IF NOT EXISTS integration_stock_prep_pull_batch_settings (
  tenant_id              TEXT PRIMARY KEY,
  first_pull_batch_rule  TEXT NOT NULL,
  label_format           TEXT NOT NULL,
  landing_mode           TEXT NOT NULL,
  band_placement         TEXT NOT NULL,
  version                INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_pull_batch_settings_rule_check
    CHECK (first_pull_batch_rule IN ('material','predecessor_suffix')),
  CONSTRAINT integration_stock_prep_pull_batch_settings_format_check
    CHECK (label_format IN ('ordinal_date','ordinal')),
  CONSTRAINT integration_stock_prep_pull_batch_settings_landing_check
    CHECK (landing_mode IN ('promote_prep_fill','keep_current')),
  CONSTRAINT integration_stock_prep_pull_batch_settings_placement_check
    CHECK (band_placement IN ('left','right')),
  CONSTRAINT integration_stock_prep_pull_batch_settings_version_check
    CHECK (version >= 0)
);

CREATE TABLE IF NOT EXISTS integration_stock_prep_pull_batch_sheet (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  sheet_id               TEXT NOT NULL,
  project_no             TEXT NOT NULL,
  history_status         TEXT NOT NULL,
  label_locale           TEXT NOT NULL,
  first_pull_batch_rule  TEXT NOT NULL,
  label_format           TEXT NOT NULL,
  band_placement         TEXT,
  landing_mode           TEXT,
  settings_locked_at     TIMESTAMPTZ,
  history_mode           TEXT,
  history_batch_count    INTEGER,
  history_plan           JSONB,
  history_plan_digest    TEXT,
  approval_ref           TEXT,
  installed_at           TIMESTAMPTZ,
  installed_by           TEXT,
  resolved_at            TIMESTAMPTZ,
  resolved_by            TEXT,
  version                INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_status_check
    CHECK (history_status IN ('pending','installing','born_empty','backfilled')),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_locale_check
    CHECK (label_locale IN ('en','zh-CN')),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_rule_check
    CHECK (first_pull_batch_rule IN ('material','predecessor_suffix')),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_format_check
    CHECK (label_format IN ('ordinal_date','ordinal')),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_placement_check
    CHECK (band_placement IS NULL OR band_placement IN ('left','right')),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_landing_check
    CHECK (landing_mode IS NULL OR landing_mode IN ('promote_prep_fill','keep_current')),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_lock_check
    CHECK (history_status NOT IN ('installing','backfilled') OR settings_locked_at IS NOT NULL),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_mode_check
    CHECK (history_mode IS NULL OR history_mode IN ('inferred','unknown')),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_count_check
    CHECK (history_batch_count IS NULL OR history_batch_count >= 0),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_version_check
    CHECK (version >= 0),
  CONSTRAINT integration_stock_prep_pull_batch_sheet_resolved_check CHECK (
    (history_status = 'pending' AND resolved_at IS NULL)
    OR (history_status IN ('born_empty','backfilled') AND resolved_at IS NOT NULL
        AND history_batch_count IS NOT NULL AND history_mode IS NOT NULL)
    OR history_status = 'installing')
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_pull_batch_sheet
  ON integration_stock_prep_pull_batch_sheet (sheet_id, project_no);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_pull_batch_sheet_tenant
  ON integration_stock_prep_pull_batch_sheet (tenant_id);

CREATE TABLE IF NOT EXISTS integration_stock_prep_pull_batch (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  sheet_id       TEXT NOT NULL,
  project_no     TEXT NOT NULL,
  batch_no       INTEGER NOT NULL CHECK (batch_no >= 1),
  origin         TEXT NOT NULL,
  status         TEXT NOT NULL,
  label          TEXT NOT NULL,
  display_day    DATE NOT NULL,
  source_digest  TEXT,
  evidence       TEXT,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  closed_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_pull_batch_origin_check
    CHECK (origin IN ('live','backfill_inferred')),
  CONSTRAINT integration_stock_prep_pull_batch_status_check
    CHECK (status IN ('open','closed','void')),
  CONSTRAINT integration_stock_prep_pull_batch_closed_reason_check
    CHECK (closed_reason IS NULL OR closed_reason IN ('execution_succeeded','completed_by_later_execution','superseded_by_new_source','void_no_rows','backfill','recovery_verified')),
  CONSTRAINT integration_stock_prep_pull_batch_closed_check
    CHECK ((status = 'open') = (closed_at IS NULL)),
  CONSTRAINT integration_stock_prep_pull_batch_inferred_check
    CHECK (origin = 'live' OR status = 'closed'),
  CONSTRAINT integration_stock_prep_pull_batch_digest_check
    CHECK ((origin = 'live') = (source_digest IS NOT NULL)),
  CONSTRAINT integration_stock_prep_pull_batch_evidence_check
    CHECK (((origin = 'backfill_inferred') = (evidence IS NOT NULL))
           AND (evidence IS NULL OR evidence IN ('plan_time','created_at')))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_pull_batch_no
  ON integration_stock_prep_pull_batch (sheet_id, project_no, batch_no) WHERE status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_pull_batch_open
  ON integration_stock_prep_pull_batch (sheet_id, project_no) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_pull_batch_project
  ON integration_stock_prep_pull_batch (tenant_id, project_no);

CREATE TABLE IF NOT EXISTS integration_stock_prep_pull_batch_execution (
  id                    TEXT PRIMARY KEY,
  batch_id              TEXT NOT NULL REFERENCES integration_stock_prep_pull_batch(id),
  tenant_id             TEXT NOT NULL,
  sheet_id              TEXT NOT NULL,
  project_no            TEXT NOT NULL,
  execution_ref         TEXT NOT NULL,
  lane                  TEXT NOT NULL,
  refresh_execution_id  TEXT,
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  writer_status         TEXT,
  verified_outcome      TEXT,
  created_row_count     INTEGER CHECK (created_row_count IS NULL OR created_row_count >= 0),
  CONSTRAINT integration_stock_prep_pull_batch_execution_lane_check
    CHECK (lane IN ('small_apply','large_apply')),
  CONSTRAINT integration_stock_prep_pull_batch_execution_writer_status_check
    CHECK (writer_status IS NULL OR writer_status IN ('succeeded','partial','failed','aborted')),
  CONSTRAINT integration_stock_prep_pull_batch_execution_outcome_check
    CHECK (verified_outcome IS NULL OR verified_outcome IN ('verified_landed','verified_mixed','verified_nothing_landed','verified_unknown'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_pull_batch_execution_ref
  ON integration_stock_prep_pull_batch_execution (execution_ref);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_pull_batch_execution_batch
  ON integration_stock_prep_pull_batch_execution (batch_id);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_pull_batch_execution_refresh
  ON integration_stock_prep_pull_batch_execution (refresh_execution_id) WHERE refresh_execution_id IS NOT NULL;
