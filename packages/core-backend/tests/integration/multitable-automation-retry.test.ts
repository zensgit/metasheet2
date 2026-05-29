/**
 * Real-DB round-trip for the A5 retry provenance columns (#2039 design-lock).
 *
 * Closes the wire-vs-fixture gap: the unit tests assert the insert payload via a
 * MOCK db, which does NOT prove the migration created the columns, the Kysely DB
 * types allow them, or the row mapper reads them back. This test writes + reads
 * `rerun_of_execution_id` + `initiated_by` through the REAL Postgres wire
 * (AutomationLogService.record → getById), plus a raw-SQL check that the values
 * actually persisted. Runs only with DATABASE_URL (plugin-tests.yml real-DB job).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationLogService } from '../../src/multitable/automation-log-service'
import type { AutomationExecution } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const ORIG_ID = `axe_retry_orig_${TS}`
const NEW_ID = `axe_retry_new_${TS}`
const RULE_ID = `atr_retry_${TS}`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const logs = new AutomationLogService()

function exec(over: Partial<AutomationExecution> = {}): AutomationExecution {
  return {
    id: NEW_ID,
    ruleId: RULE_ID,
    triggeredBy: 'event',
    triggeredAt: new Date().toISOString(),
    status: 'success',
    steps: [],
    ...over,
  }
}

describeIfDatabase('multitable automation retry provenance (real DB)', () => {
  beforeAll(async () => {
    await q('DELETE FROM multitable_automation_executions WHERE id = ANY($1)', [[ORIG_ID, NEW_ID]])
  })
  afterAll(async () => {
    await q('DELETE FROM multitable_automation_executions WHERE id = ANY($1)', [[ORIG_ID, NEW_ID]])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('record() persists rerun_of_execution_id + initiated_by; getById() maps them back', async () => {
    // record() with the A5 provenance set — if the migration/columns/types were missing
    // this insert would throw (the column names must exist on the real table).
    await logs.record(exec({ rerunOfExecutionId: ORIG_ID, initiatedBy: `admin_${TS}` }))

    // Mapper reads the new columns back through the real wire.
    const got = await logs.getById(NEW_ID)
    expect(got).toBeTruthy()
    expect(got?.rerunOfExecutionId).toBe(ORIG_ID)
    expect(got?.initiatedBy).toBe(`admin_${TS}`)

    // Raw-SQL confirmation that the values actually landed in the columns.
    const raw = await q('SELECT rerun_of_execution_id, initiated_by FROM multitable_automation_executions WHERE id = $1', [NEW_ID])
    expect(raw.rows[0].rerun_of_execution_id).toBe(ORIG_ID)
    expect(raw.rows[0].initiated_by).toBe(`admin_${TS}`)
  })

  test('a normal (non-retry) run leaves both columns NULL', async () => {
    await logs.record(exec({ id: ORIG_ID }))
    const got = await logs.getById(ORIG_ID)
    expect(got?.rerunOfExecutionId).toBeUndefined()
    expect(got?.initiatedBy).toBeUndefined()
    const raw = await q('SELECT rerun_of_execution_id, initiated_by FROM multitable_automation_executions WHERE id = $1', [ORIG_ID])
    expect(raw.rows[0].rerun_of_execution_id).toBeNull()
    expect(raw.rows[0].initiated_by).toBeNull()
  })
})
