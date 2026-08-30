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
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import { db } from '../../src/db/db'
import { AutomationLogService } from '../../src/multitable/automation-log-service'
import { AutomationService } from '../../src/multitable/automation-service'
import type { AutomationExecution } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const ORIG_ID = `axe_retry_orig_${TS}`
const NEW_ID = `axe_retry_new_${TS}`
const ROOT_ID = `axe_retry_root_${TS}`
const CHILD_ID = `axe_retry_child_${TS}`
const TEST_RUN_ID = `axe_retry_test_run_${TS}`
const RULE_ID = `atr_retry_${TS}`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const logs = new AutomationLogService()

function realService(): AutomationService {
  return new AutomationService(new EventBus(), db as never, q as never)
}

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
    await q('DELETE FROM multitable_automation_executions WHERE id = ANY($1)', [[ORIG_ID, NEW_ID, ROOT_ID, CHILD_ID, TEST_RUN_ID]])
    await q("DELETE FROM meta_automation_action_applied WHERE kind = 'execution' AND root_execution_id = $1", [ROOT_ID])
    await q("DELETE FROM meta_automation_outbound_intent WHERE kind = 'execution' AND root_execution_id = $1", [ROOT_ID])
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.AUTOMATION_CLASSA_CLAIM_ENABLED
    delete process.env.AUTOMATION_CLASSB_OUTBOUND_ENABLED
    await q("DELETE FROM meta_automation_action_applied WHERE kind = 'execution' AND root_execution_id = $1", [ROOT_ID])
    await q("DELETE FROM meta_automation_outbound_intent WHERE kind = 'execution' AND root_execution_id = $1", [ROOT_ID])
    await q('DELETE FROM multitable_automation_executions WHERE id = ANY($1)', [[ROOT_ID, CHILD_ID, TEST_RUN_ID]])
  })
  afterAll(async () => {
    await q('DELETE FROM multitable_automation_executions WHERE id = ANY($1)', [[ORIG_ID, NEW_ID, ROOT_ID, CHILD_ID, TEST_RUN_ID]])
    await q("DELETE FROM meta_automation_action_applied WHERE kind = 'execution' AND root_execution_id = $1", [ROOT_ID])
    await q("DELETE FROM meta_automation_outbound_intent WHERE kind = 'execution' AND root_execution_id = $1", [ROOT_ID])
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

  test('#4196 §2.2: a persisted manual test run cannot enter the live retry namespace', async () => {
    await logs.record(exec({
      id: TEST_RUN_ID,
      triggeredBy: 'manual_test',
      status: 'failed',
      triggerEvent: { recordId: `rec_test_run_${TS}`, data: {} },
    }))
    const service = realService()
    const getRule = vi.spyOn(service, 'getRule')
    const execute = vi.spyOn(service, 'executeRule')

    await expect(service.retryExecution(TEST_RUN_ID, `admin_${TS}`)).resolves.toMatchObject({
      status: 409,
      code: 'TEST_RUN_NOT_RETRYABLE',
    })
    expect(getRule).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    const raw = await q(
      'SELECT first_retry_attempted_at FROM multitable_automation_executions WHERE id = $1',
      [TEST_RUN_ID],
    )
    expect(raw.rows[0].first_retry_attempted_at).toBeNull()
  })

  test('#4196 V5: a non-first Class-A retry fails closed on zero root evidence and proceeds with an applied row', async () => {
    process.env.AUTOMATION_CLASSA_CLAIM_ENABLED = 'true'
    const service = realService()
    const root = exec({ id: ROOT_ID, status: 'failed' })
    const child = exec({
      id: CHILD_ID,
      status: 'failed',
      rerunOfExecutionId: ROOT_ID,
      triggerEvent: { recordId: `rec_retry_${TS}`, data: {} },
    })
    await logs.record(root)
    await logs.record(child)
    vi.spyOn(service.logs, 'getById').mockImplementation(async (id) => id === CHILD_ID ? child : root)
    vi.spyOn(service, 'getRule').mockResolvedValue({
      id: RULE_ID,
      sheet_id: 'sheet_retry',
      name: 'Retry rule',
      trigger_type: 'record.created',
      trigger_config: {},
      action_type: 'update_record',
      action_config: { fields: { status: 'done' } },
      enabled: true,
      actions: null,
      conditions: null,
    } as never)
    const execute = vi.spyOn(service, 'executeRule').mockResolvedValue(exec({ id: `axe_retry_result_${TS}` }))

    await expect(service.retryExecution(CHILD_ID, `admin_${TS}`)).resolves.toMatchObject({
      status: 409,
      code: 'RETRY_LEDGER_EVIDENCE_MISSING',
    })
    expect(execute).not.toHaveBeenCalled()

    await q(
      `INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key, action_type)
       VALUES ('execution', $1, $2, 'update_record')`,
      [ROOT_ID, `action_${TS}`],
    )
    await expect(service.retryExecution(CHILD_ID, `admin_${TS}`)).resolves.toHaveProperty('execution')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('#4196 V5: Class-B requires its enabled-family evidence; an unrelated Class-A row cannot mask loss', async () => {
    process.env.AUTOMATION_CLASSB_OUTBOUND_ENABLED = 'true'
    const service = realService()
    const root = exec({ id: ROOT_ID, status: 'failed' })
    const child = exec({
      id: CHILD_ID,
      status: 'failed',
      rerunOfExecutionId: ROOT_ID,
      triggerEvent: { recordId: `rec_retry_${TS}`, data: {} },
    })
    await logs.record(root)
    await logs.record(child)
    vi.spyOn(service.logs, 'getById').mockImplementation(async (id) => id === CHILD_ID ? child : root)
    vi.spyOn(service, 'getRule').mockResolvedValue({
      id: RULE_ID,
      sheet_id: 'sheet_retry',
      name: 'Retry rule',
      trigger_type: 'record.created',
      trigger_config: {},
      action_type: 'send_webhook',
      action_config: { url: 'https://example.invalid' },
      enabled: true,
      actions: null,
      conditions: null,
    } as never)
    const execute = vi.spyOn(service, 'executeRule').mockResolvedValue(exec({ id: `axe_retry_result_${TS}` }))
    await q(
      `INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key, action_type)
       VALUES ('execution', $1, $2, 'update_record')`,
      [ROOT_ID, `unrelated_${TS}`],
    )

    await expect(service.retryExecution(CHILD_ID, `admin_${TS}`)).resolves.toMatchObject({
      status: 409,
      code: 'RETRY_LEDGER_EVIDENCE_MISSING',
    })
    expect(execute).not.toHaveBeenCalled()

    await q(
      `INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key, status)
       VALUES ('execution', $1, $2, 'failed')`,
      [ROOT_ID, `outbound_${TS}`],
    )
    await expect(service.retryExecution(CHILD_ID, `admin_${TS}`)).resolves.toHaveProperty('execution')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
