import { sql, type Kysely } from 'kysely'

import {
  YIDA_ISSUE_CONFIRM_WRITEBACK_DATED_OUTCOMES as BASELINE_DATED_OUTCOMES,
  YIDA_ISSUE_CONFIRM_WRITEBACK_OUTCOMES as BASELINE_OUTCOMES,
} from './zzzz20261106093100_create_integration_yida_issue_confirm_writeback'

/**
 * YiDa 发料确认日期回写 (issue-confirm date write-back), owner ruling D3-1 (register R-96 ⑦, 2026-11-17): the trace
 * table admits the thirteenth outcome `written_inactive`.
 *
 * WHAT IT CHANGES. Only the two CHECK constraints of `integration_yida_issue_confirm_writeback` (created by
 * zzzz20261106093100, unchanged):
 *   - `integration_yida_issue_confirm_writeback_outcome_check`: the twelve baseline outcomes plus `written_inactive`
 *     (the date was written, under the same empty-cell rule, onto the INACTIVE row the idempotencyKey found), equal to
 *     plugins/plugin-integration-core/lib/yida-issue-confirm-writeback.cjs ISSUE_CONFIRM_WRITEBACK_OUTCOMES (pinned by
 *     tests/unit/yida-issue-confirm-writeback-migration.test.ts);
 *   - `integration_yida_issue_confirm_writeback_date_shape`: `written_inactive` carries its date and zone, like
 *     `written` and `already_set`.
 * No column, row, trigger or other table is touched. Each constraint is dropped (IF EXISTS) and added again in one
 * statement, so up() is replayable and the table never runs without either check. The table stays append-only.
 *
 * down() REFUSES while a `written_inactive` row exists (append-only evidence: the narrower checks could not be added
 * back over it); with none it restores the baseline checks exactly as zzzz20261106093100 wrote them. Static statements
 * only, never a dynamic EXECUTE, so the authorization-input migration judge can read every one of them.
 */

export const YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_OUTCOME = 'written_inactive'
export const YIDA_ISSUE_CONFIRM_WRITEBACK_OUTCOMES_V2 = Object.freeze([...BASELINE_OUTCOMES, YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_OUTCOME])
export const YIDA_ISSUE_CONFIRM_WRITEBACK_DATED_OUTCOMES_V2 = Object.freeze([...BASELINE_DATED_OUTCOMES, YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_OUTCOME])
export const YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_DOWN_REFUSED_CODE = 'YIDA_ISSUE_CONFIRM_WRITEBACK_WRITTEN_INACTIVE_ROWS_PRESENT'

const quoted = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ')

function checksSql(outcomes: readonly string[], dated: readonly string[]): string {
  return `
ALTER TABLE integration_yida_issue_confirm_writeback
  DROP CONSTRAINT IF EXISTS integration_yida_issue_confirm_writeback_outcome_check,
  DROP CONSTRAINT IF EXISTS integration_yida_issue_confirm_writeback_date_shape,
  ADD CONSTRAINT integration_yida_issue_confirm_writeback_outcome_check
    CHECK (outcome IN (${quoted(outcomes)})),
  ADD CONSTRAINT integration_yida_issue_confirm_writeback_date_shape CHECK (
    (outcome IN (${quoted(dated)})) = (written_date IS NOT NULL)
    AND (written_date IS NULL) = (time_zone IS NULL)
  );
`
}

export const YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_UP_SQL = checksSql(YIDA_ISSUE_CONFIRM_WRITEBACK_OUTCOMES_V2, YIDA_ISSUE_CONFIRM_WRITEBACK_DATED_OUTCOMES_V2)

export const YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_DOWN_SQL = `
DO $yida_issue_confirm_written_inactive_down$
BEGIN
  IF to_regclass('integration_yida_issue_confirm_writeback') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM integration_yida_issue_confirm_writeback WHERE outcome = '${YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_OUTCOME}') THEN
      RAISE EXCEPTION '${YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_DOWN_REFUSED_CODE}' USING ERRCODE = '55000';
    END IF;
    ${checksSql(BASELINE_OUTCOMES, BASELINE_DATED_OUTCOMES).trim()}
  END IF;
END;
$yida_issue_confirm_written_inactive_down$;
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_UP_SQL).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_ISSUE_CONFIRM_WRITTEN_INACTIVE_DOWN_SQL).execute(db)
}
