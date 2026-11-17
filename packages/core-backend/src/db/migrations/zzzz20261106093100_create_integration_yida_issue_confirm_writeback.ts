import { sql, type Kysely } from 'kysely'

/**
 * YiDa 发料确认日期回写 (issue-confirm date write-back; design baseline v2.3 §7.3, frozen ⑦.4 plan §3,
 * slice Y9a): the write-back TRACE table.
 *
 * WHAT IT ADDS. `integration_yida_issue_confirm_writeback`: at most ONE row per delivery ledger row
 * (PRIMARY KEY (ledger_id), a foreign key to integration_yida_delivery_ledger), recording the terminal outcome
 * of the write-back for that row. Written only by plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs
 * with INSERT … ON CONFLICT (ledger_id) DO NOTHING, so two attempts that decided the same row converge on one
 * row. Retryable cases (lease busy, host 5xx, the switch turned off mid-run) insert nothing.
 *   - `outcome` CHECK: the twelve baseline outcomes, equal to the module's ISSUE_CONFIRM_WRITEBACK_OUTCOMES
 *     (pinned by tests/unit/yida-issue-confirm-writeback-migration.test.ts);
 *   - `written_date` / `time_zone`: set exactly for `written` and `already_set` (shape CHECK);
 *   - `sheet_id`: NULL when the outcome was decided before a sheet was known (payload_unmapped,
 *     project_absent, source_unbound);
 *   - values-free: ids, the outcome, the date and the zone — no project number, key or other business value.
 * APPEND-ONLY: a trigger refuses UPDATE and DELETE, another refuses TRUNCATE (the 090 audit-guard pattern);
 * `created_at` is stamped by the database on INSERT.
 *
 * WHAT IT DOES NOT DO. It touches no existing table: the delivery ledger, its audit and the send approvals
 * are unchanged (the write-back never writes them; the send path never reads this table). No switch: the
 * write-back runs only behind INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED (exact 'true', default OFF),
 * which is not wired to any route yet (slice Y9).
 *
 * Replayable: every statement is IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS first.
 * down() REFUSES while any trace row exists (append-only evidence; the precedent is
 * zzzz20261105033000's down). With no row it drops the triggers, the functions and the table.
 */

export const YIDA_ISSUE_CONFIRM_WRITEBACK_TABLE = 'integration_yida_issue_confirm_writeback'
export const YIDA_ISSUE_CONFIRM_WRITEBACK_OUTCOMES = Object.freeze([
  'written',
  'already_set',
  'kept_existing',
  'row_absent',
  'duplicate_key',
  'project_absent',
  'project_archived',
  'project_mismatch',
  'payload_unmapped',
  'sheet_mismatch',
  'permission_revoked',
  'source_unbound',
] as const)
export const YIDA_ISSUE_CONFIRM_WRITEBACK_DATED_OUTCOMES = Object.freeze(['written', 'already_set'] as const)
export const YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_REFUSED_CODE = 'YIDA_ISSUE_CONFIRM_WRITEBACK_ROWS_PRESENT'
export const YIDA_ISSUE_CONFIRM_WRITEBACK_IMMUTABLE_CODE = 'YIDA_ISSUE_CONFIRM_WRITEBACK_IMMUTABLE'

const quoted = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ')

export const YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL = `
CREATE TABLE IF NOT EXISTS integration_yida_issue_confirm_writeback (
  ledger_id TEXT PRIMARY KEY REFERENCES integration_yida_delivery_ledger(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 128),
  sheet_id TEXT CHECK (sheet_id IS NULL OR length(sheet_id) BETWEEN 1 AND 128),
  outcome TEXT NOT NULL CONSTRAINT integration_yida_issue_confirm_writeback_outcome_check
    CHECK (outcome IN (${quoted(YIDA_ISSUE_CONFIRM_WRITEBACK_OUTCOMES)})),
  written_date DATE,
  time_zone TEXT CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_yida_issue_confirm_writeback_date_shape CHECK (
    (outcome IN (${quoted(YIDA_ISSUE_CONFIRM_WRITEBACK_DATED_OUTCOMES)})) = (written_date IS NOT NULL)
    AND (written_date IS NULL) = (time_zone IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_integration_yida_issue_confirm_writeback_owner
  ON integration_yida_issue_confirm_writeback (tenant_id, owner_id, created_at);

CREATE OR REPLACE FUNCTION integration_yida_issue_confirm_writeback_guard() RETURNS trigger
LANGUAGE plpgsql AS $yida_issue_confirm_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '${YIDA_ISSUE_CONFIRM_WRITEBACK_IMMUTABLE_CODE}' USING ERRCODE = '55000';
END;
$yida_issue_confirm_guard$;
DROP TRIGGER IF EXISTS trg_integration_yida_issue_confirm_writeback_guard ON integration_yida_issue_confirm_writeback;
CREATE TRIGGER trg_integration_yida_issue_confirm_writeback_guard
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_issue_confirm_writeback
  FOR EACH ROW EXECUTE FUNCTION integration_yida_issue_confirm_writeback_guard();

CREATE OR REPLACE FUNCTION integration_yida_issue_confirm_writeback_truncate_guard() RETURNS trigger
LANGUAGE plpgsql AS $yida_issue_confirm_truncate$
BEGIN
  RAISE EXCEPTION '${YIDA_ISSUE_CONFIRM_WRITEBACK_IMMUTABLE_CODE}' USING ERRCODE = '55000';
END;
$yida_issue_confirm_truncate$;
DROP TRIGGER IF EXISTS trg_integration_yida_issue_confirm_writeback_truncate ON integration_yida_issue_confirm_writeback;
CREATE TRIGGER trg_integration_yida_issue_confirm_writeback_truncate
  BEFORE TRUNCATE ON integration_yida_issue_confirm_writeback
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_issue_confirm_writeback_truncate_guard();
`

export const YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_SQL = `
DO $yida_issue_confirm_down$
BEGIN
  IF to_regclass('integration_yida_issue_confirm_writeback') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM integration_yida_issue_confirm_writeback) THEN
      RAISE EXCEPTION '${YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_REFUSED_CODE}' USING ERRCODE = '55000';
    END IF;
    DROP TRIGGER IF EXISTS trg_integration_yida_issue_confirm_writeback_truncate ON integration_yida_issue_confirm_writeback;
    DROP TRIGGER IF EXISTS trg_integration_yida_issue_confirm_writeback_guard ON integration_yida_issue_confirm_writeback;
    DROP TABLE integration_yida_issue_confirm_writeback;
  END IF;
  DROP FUNCTION IF EXISTS integration_yida_issue_confirm_writeback_truncate_guard();
  DROP FUNCTION IF EXISTS integration_yida_issue_confirm_writeback_guard();
END;
$yida_issue_confirm_down$;
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_ISSUE_CONFIRM_WRITEBACK_DOWN_SQL).execute(db)
}
