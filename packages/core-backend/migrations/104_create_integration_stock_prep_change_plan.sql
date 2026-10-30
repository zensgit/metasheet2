-- 104_create_integration_stock_prep_change_plan.sql
-- plugin-integration-core · 备料 batch-refresh step 5 PR-8 — the CHANGE PLAN ledger (变更计划确认 / 受控更新 /
-- 变更待复核 / 复核完成). Sibling of migrations 102 (continuations) and 103 (refresh state, holds, executions).
--
-- WHY THIS TABLE EXISTS (plan §3.4 第一期内容变更闭环 five steps, §9.3 C01-C12; step-4 design §4.3, §10.3 (1)-(5)).
--   A pilot project whose existing rows (continued rows included) change ONLY in content (quantity, material, version,
--   name / spec / code with the same part id) is suspended by a content-class hold (migration 103). The puller confirms
--   the WHOLE open content-class hold set as ONE change plan (status `confirmed`); a fresh preview then authorizes
--   exactly those machine-content updates (the controlled update) and its apply writes them (`written`); the change then
--   waits for a person's review (变更待复核, the formal export stays refused) until the review binds the content the
--   sheet holds (`reviewed`). The confirm only approves the machine update; the review is a separate operation.
--
-- THE LIFECYCLE (one row per confirm; rows are never deleted, every status after `confirmed` is terminal except
-- `written`, which leaves only by a review or by ABSORPTION into a later plan's successful write):
--   confirmed   -> written      the controlled update's execution SUCCEEDED (the store, in the execution's finish)
--   confirmed   -> invalidated  a computation's change set no longer equals the plan (`source_changed`) — never while an
--                               execution bound to the plan runs — or the bound execution failed (`execution_failed`)
--   confirmed   -> superseded   a later confirm replaced it before it was executed — DEFENSIVE, product-unreachable
--                               today (pg review V8PG-05a): while a plan is confirmed the planner never emits further
--                               content holds beside the change it matches, and a bound running execution makes a
--                               second confirm 409 RECOVERY_PENDING; only a seeded hold set reaches it
--   written     -> reviewed     the review completed against the content the sheet holds (and nothing else is open)
--   written     -> superseded   a later plan's write ABSORBED every unreviewed field of it (the later plan's review covers
--                               them, against the same review baseline) — a written change never escapes review
-- At most ONE `confirmed` and ONE `written` row per (sheet, project) (the two partial unique indexes below).
--
-- PRIVATE vs VALUES-FREE (design §4.4). `record_set` (record ids, keys and the per-field before / after / baseline
-- cells) and `review_notes` are PRIVATE business values: they are answered only by the audited pull-tier route
-- (GET …/refresh/change-plans/current). Every other column is a handle, a closed token, a digest, an integer or a
-- server clock. The consult's plan summaries carry the values-free columns only; it also reads the `record_set` of
-- the pending written plan, and the REVIEWED-CELL REGISTER below, as its server-held expected content (review fix N3,
-- C06: a reviewed cell the sheet no longer carries is held) — for the planner, never a response body.
--
-- SCOPE: tenant_id, sheet_id, project_no and write_scope_key (the sheet write lock's scope key, migration 100) on every
-- row. INTEGER, not BIGINT.
--
-- FAIL CLOSED. The governance consult reads this table on EVERY consult (pending plans by (tenant, project) and by
-- (sheet, project)), for EVERY project — governed or not, the consult has to read it to know: a plugin build with step
-- 5 on a database without this migration answers 503 STOCK_PREP_REFRESH_STORE_FAILED (`read_change_plans`, 42P01) for
-- every pull and every formal export of EVERY project — deploy this migration WITH the build, never after it.
--
-- ROLLBACK. Plugin SQL migrations are up-only; there is no down(). A rolled-back build cannot run `db:migrate` while 104
-- is recorded (roll back with RunMigrations 0). Rolling the PLUGIN build back to one that does not know change plans is
-- FORBIDDEN while a pending plan exists — the G10 stop condition gains:
--   SELECT count(*) FROM integration_stock_prep_change_plan WHERE status IN ('confirmed', 'written');
-- (zero required), next to migration 102's / 103's checks. Rows always stay.
--
-- OWNER GATE Q-B (design §21 (ii), §23.9). Persisting `record_set` and `review_notes` (and the reviewed-cell register's
-- values, below) on a customer instance, and their retention, is decided with the pilot enable; development and CI are
-- not blocked by it.

CREATE TABLE IF NOT EXISTS integration_stock_prep_change_plan (
  id                            TEXT PRIMARY KEY,
  tenant_id                     TEXT NOT NULL,
  sheet_id                      TEXT NOT NULL,
  project_no                    TEXT NOT NULL,
  write_scope_key               TEXT NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'confirmed',
  plan_fingerprint              TEXT NOT NULL,
  source_content_digest         TEXT NOT NULL,
  planned_content_digest        TEXT NOT NULL,
  record_count                  INTEGER NOT NULL,
  write_record_count            INTEGER NOT NULL,
  record_set                    JSONB NOT NULL,
  absorbed_change_plan_ids      JSONB NOT NULL,
  hold_ids                      JSONB NOT NULL,
  hold_set_fingerprint          TEXT NOT NULL,
  continuation_ids              JSONB NOT NULL,
  review_baseline_digest        TEXT NOT NULL,
  confirmed_by                  TEXT NOT NULL,
  confirmed_at                  TIMESTAMPTZ NOT NULL,
  confirmed_generation          INTEGER NOT NULL,
  confirmed_generation_token    TEXT NOT NULL,
  confirmed_fencing_epoch       INTEGER NOT NULL,
  execution_id                  TEXT,
  written_at                    TIMESTAMPTZ,
  written_content_digest        TEXT,
  reviewed_by                   TEXT,
  reviewed_at                   TIMESTAMPTZ,
  review_conclusion             TEXT,
  review_notes                  TEXT,
  reviewed_content_digest       TEXT,
  invalidated_at                TIMESTAMPTZ,
  invalidated_reason            TEXT,
  superseded_at                 TIMESTAMPTZ,
  superseded_by                 TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_change_plan_status_check
    CHECK (status IN ('confirmed', 'written', 'reviewed', 'invalidated', 'superseded')),
  CONSTRAINT integration_stock_prep_change_plan_invalidated_reason_check
    CHECK (invalidated_reason IS NULL OR invalidated_reason IN ('source_changed', 'execution_failed')),
  CONSTRAINT integration_stock_prep_change_plan_review_conclusion_check
    CHECK (review_conclusion IS NULL OR review_conclusion IN ('handled', 'handled_with_notes')),
  CONSTRAINT integration_stock_prep_change_plan_counts_check
    CHECK (write_record_count >= 1 AND record_count >= write_record_count),
  CONSTRAINT integration_stock_prep_change_plan_generation_check
    CHECK (confirmed_generation >= 0 AND confirmed_fencing_epoch >= 0),
  CONSTRAINT integration_stock_prep_change_plan_review_notes_check
    CHECK (review_notes IS NULL OR char_length(review_notes) <= 2000),
  CONSTRAINT integration_stock_prep_change_plan_written_shape_check
    CHECK ((written_at IS NULL) = (written_content_digest IS NULL) AND (status NOT IN ('written', 'reviewed') OR (written_at IS NOT NULL AND execution_id IS NOT NULL))),
  CONSTRAINT integration_stock_prep_change_plan_reviewed_shape_check
    CHECK ((status = 'reviewed') = (reviewed_at IS NOT NULL) AND (reviewed_at IS NULL) = (reviewed_by IS NULL) AND (reviewed_at IS NULL) = (review_conclusion IS NULL) AND (reviewed_at IS NULL) = (reviewed_content_digest IS NULL)),
  CONSTRAINT integration_stock_prep_change_plan_invalidated_shape_check
    CHECK ((status = 'invalidated') = (invalidated_at IS NOT NULL) AND (invalidated_at IS NULL) = (invalidated_reason IS NULL) AND (invalidated_reason IS DISTINCT FROM 'execution_failed' OR execution_id IS NOT NULL)),
  CONSTRAINT integration_stock_prep_change_plan_superseded_shape_check
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL) AND (superseded_at IS NULL) = (superseded_by IS NULL))
);

-- ONE plan awaiting its controlled update, and ONE written plan awaiting review, per (sheet, project). A second confirm
-- supersedes the confirmed one inside its transaction; a later plan's successful write supersedes the written one
-- (absorbing its unreviewed fields) before it becomes `written` itself. Two concurrent confirms: the loser's INSERT is
-- 23505 here (409 STOCK_PREP_CONTINUATION_CONFIRM_CONFLICT) — they also serialise on the refresh-state row.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_change_plan_confirmed
  ON integration_stock_prep_change_plan (sheet_id, project_no) WHERE status = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_change_plan_written
  ON integration_stock_prep_change_plan (sheet_id, project_no) WHERE status = 'written';
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_change_plan_tenant_project
  ON integration_stock_prep_change_plan (tenant_id, project_no, status);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_change_plan_sheet_project
  ON integration_stock_prep_change_plan (sheet_id, project_no, status);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_change_plan_execution
  ON integration_stock_prep_change_plan (execution_id);

COMMENT ON TABLE integration_stock_prep_change_plan IS
  'Stock-preparation batch-refresh step 5: one row per change-plan confirm (confirmed -> written -> reviewed; invalidated / superseded). record_set and review_notes are PRIVATE (audited pull-tier route only); every other column is values-free. At most one confirmed and one written row per (sheet, project). Never deleted; no down().';

-- THE REVIEWED-CELL REGISTER (review fix N3-b, round 2; plan C06 「复核前后再发生相关变化，旧复核不再有效，重新挂起」).
--   One row per (sheet, project, record key, field) that a review bound: the reviewed value (`reviewed_cell` =
--   { after, afterCanonical }, the raw value and the writer's canonical form), the record id the review bound, and the
--   plan whose review last wrote it. WRITTEN ONLY BY THE REVIEW, in its own transaction under the state-row lock: one
--   UPSERT per cell of the reviewed plan's record set (review-only / absorbed fields included — the review bound them
--   too). A later review of the same key + field OVERWRITES that cell's row; nothing ever deletes a row (a superseded or
--   invalidated plan never touches the register). READ ONLY BY THE CONSULT, in its REPEATABLE READ snapshot, and only once
--   the state row says a review happened (`reviewed_content_digest`, written by the same review transaction) — a project
--   never reviewed, and every not-governed project, reads nothing from it. The consult hands it, with the pending written
--   plan's cells, to the planner as its private expected content: every reviewed cell stays held against a move the
--   source and a host-side write make together, whichever plan reviewed it (the latest-plan-only read missed cells an
--   earlier plan reviewed, delta probe V8D-05).
--   PRIVATE values (owner gate Q-B, like `record_set`); every other column is a handle, a digest, a key or a clock (the
--   key is the record's idempotency key, as `record_set` carries it). BOUNDED by the project's reviewed cells: at most
--   (distinct record keys ever reviewed) x (content-trigger fields); the consult refuses 503 `row_cap` above 100000 rows
--   (fail closed, never "nothing reviewed"). Rows always stay (no down(); the G10 stop condition is unchanged).
--   ADDED IN REVIEW ROUND 2 to this still-unmerged migration: additive (one more table and its unique index, both
--   IF NOT EXISTS; nothing above changed shape). A development database that already recorded the earlier 104 does NOT
--   re-run it — re-create that database.
CREATE TABLE IF NOT EXISTS integration_stock_prep_reviewed_cell (
  id                            TEXT PRIMARY KEY,
  tenant_id                     TEXT NOT NULL,
  sheet_id                      TEXT NOT NULL,
  project_no                    TEXT NOT NULL,
  write_scope_key               TEXT NOT NULL,
  record_key                    TEXT NOT NULL,
  record_key_digest             TEXT NOT NULL,
  field_id                      TEXT NOT NULL,
  record_id                     TEXT NOT NULL,
  reviewed_cell                 JSONB NOT NULL,
  change_plan_id                TEXT NOT NULL,
  reviewed_at                   TIMESTAMPTZ NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ONE entry per reviewed cell: the review's UPSERT conflicts here (the key by its digest — a key is a JSON path and can
-- be long).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_reviewed_cell
  ON integration_stock_prep_reviewed_cell (sheet_id, project_no, record_key_digest, field_id);

COMMENT ON TABLE integration_stock_prep_reviewed_cell IS
  'Stock-preparation batch-refresh step 5 (review fix N3-b): every cell a change review bound, one row per (sheet, project, record key, field); a later review overwrites the cell; never deleted. reviewed_cell is PRIVATE (the consult''s expected content, planner only). No down().';
