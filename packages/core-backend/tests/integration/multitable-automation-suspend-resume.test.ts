/**
 * Real-DB suspend/resume for the A6-2 runtime (admin-gated v1).
 *
 * Drives AutomationService.executeRule (suspend) + resumeExecution (resume) against REAL
 * Postgres — proving the wire that mock-db unit tests cannot: the suspension row, the
 * out-of-band `suspended` C1 job (D2), the single-use token claim (D8), the re-derive +
 * tail continuation (D4), the rule-drift fingerprint guard (D4b), and the fail-closed edges.
 * Runs only with DATABASE_URL (plugin-tests.yml real-DB job).
 *
 * See docs/development/multitable-automation-a6-2-suspend-resume-design-20260603.md
 */
import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { normalizeWorkflowJob } from '../../src/multitable/workflow-job-contract'
import { db } from '../../src/db/db'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const SHEET = `sheet_susp_${TS}`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const execIds: string[] = []

// Real queryFn so update_record actually writes + resumeExecution re-fetches the live record.
function makeService(fetchFn?: typeof fetch): AutomationService {
  return new AutomationService(new EventBus(), db as never, q as never, fetchFn as never)
}

const WAIT_ACTIONS = [
  { type: 'update_record', config: { fields: { a6_2_step: 'one' } } },
  { type: 'wait_for_callback', config: {} },
  { type: 'update_record', config: { fields: { a6_2_step: 'two' } } },
]

/** Persist a rule (so resume's getRule + fingerprint resolve) and return its id. */
async function createWaitRule(svc: AutomationService, suffix: string): Promise<string> {
  const created = await svc.createRule(SHEET, {
    name: `a6-2 ${suffix}`,
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'update_record',
    actionConfig: {},
    actions: WAIT_ACTIONS as never,
    executionMode: 'workflow_job_v1',
  })
  return created.id
}

/** Inline executor rule matching the persisted rule's actions (types → same fingerprint). */
function execRuleOf(ruleId: string, mode: string | undefined = 'workflow_job_v1') {
  return {
    id: ruleId, name: 'a6-2', sheetId: SHEET,
    trigger: { type: 'record.created', config: {} },
    actions: WAIT_ACTIONS, enabled: true, createdBy: '',
    createdAt: new Date(TS).toISOString(), executionMode: mode,
  }
}

async function suspend(svc: AutomationService, ruleId: string, recordId = '', data: Record<string, unknown> = {}) {
  const exec = await svc.executeRule(execRuleOf(ruleId) as never, { sheetId: SHEET, recordId, data })
  execIds.push(exec.id)
  return exec
}

async function tokenFor(executionId: string): Promise<string> {
  const r = await q('SELECT resume_token FROM multitable_automation_suspensions WHERE execution_id = $1', [executionId])
  return r.rows[0]?.resume_token as string
}

describeIfDatabase('multitable automation suspend/resume (A6-2, real DB)', () => {
  afterAll(async () => {
    for (const id of execIds) {
      await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id])
    }
    await q('DELETE FROM multitable_automation_suspensions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM multitable_automation_jobs WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM automation_rules WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('T1: opt-in [update, wait, update] suspends — execution running, suspension pending, job[1] suspended, job[2] absent', async () => {
    const svc = makeService()
    const ruleId = await createWaitRule(svc, 't1')
    const exec = await suspend(svc, ruleId)

    // D2: execution stays `running` while suspended; only the first action ran (no wait/tail step).
    expect(exec.status).toBe('running')
    expect(exec.steps).toHaveLength(1)
    expect(exec.steps[0]).toMatchObject({ actionType: 'update_record', status: 'success' })

    const susp = await q(
      'SELECT status, resume_token, step_index, reason FROM multitable_automation_suspensions WHERE execution_id = $1',
      [exec.id],
    )
    expect(susp.rows).toHaveLength(1)
    expect(susp.rows[0].status).toBe('pending')
    expect(susp.rows[0].resume_token).toBeTruthy()
    expect(susp.rows[0].step_index).toBe(1)
    expect(susp.rows[0].reason).toBe('external_event')

    // Out-of-band suspended state: job[0] resolved, job[1] suspended, job[2] absent (tail not run).
    const jr = await q('SELECT step_index, status FROM multitable_automation_jobs WHERE execution_id = $1 ORDER BY step_index', [exec.id])
    expect(jr.rows.map((r) => [r.step_index, r.status])).toEqual([[0, 'resolved'], [1, 'suspended']])

    // READ path while suspended: listByExecution surfaces the `suspended` job view — and (B1) it is a
    // VALID C1 WorkflowJob: it carries the suspend descriptor and PASSES normalizeWorkflowJob (rather
    // than a descriptor-less shape that only resembles C1 and would be rejected by the normalizer).
    const views = await svc.jobs.listByExecution(exec.id)
    expect(views.map((v) => v.status)).toEqual(['resolved', 'suspended'])
    expect(views[1]).toMatchObject({ status: 'suspended', suspend: { reason: 'external_event' } })
    expect((views[1] as { suspend?: { resumeToken?: string } }).suspend?.resumeToken).toBeTruthy()
    expect(() => normalizeWorkflowJob(views[1])).not.toThrow() // valid C1 contract shape
  })

  test('T2: resume continues the tail — execution success, all jobs resolved, suspension resumed', async () => {
    const svc = makeService()
    const ruleId = await createWaitRule(svc, 't2')
    const exec = await suspend(svc, ruleId)
    const result = await svc.resumeExecution(await tokenFor(exec.id), 'admin_t2')

    expect('execution' in result).toBe(true)
    if ('execution' in result) {
      expect(result.execution.status).toBe('success')
      expect(result.execution.steps).toHaveLength(3) // update, wait(resolved), update
      expect(result.execution.initiatedBy).toBe('admin_t2')
    }
    const jr = await q('SELECT step_index, status FROM multitable_automation_jobs WHERE execution_id = $1 ORDER BY step_index', [exec.id])
    expect(jr.rows.map((r) => [r.step_index, r.status])).toEqual([[0, 'resolved'], [1, 'resolved'], [2, 'resolved']])
    const susp = await q('SELECT status FROM multitable_automation_suspensions WHERE execution_id = $1', [exec.id])
    expect(susp.rows[0].status).toBe('resumed')
  })

  test('T3: double resume → second is 409 ALREADY_RESUMED (single-use token, D8)', async () => {
    const svc = makeService()
    const ruleId = await createWaitRule(svc, 't3')
    const exec = await suspend(svc, ruleId)
    const token = await tokenFor(exec.id)
    expect('execution' in (await svc.resumeExecution(token, 'admin_t3'))).toBe(true)
    expect(await svc.resumeExecution(token, 'admin_t3')).toMatchObject({ status: 409, code: 'ALREADY_RESUMED' })
  })

  test('T4: resume with an unknown token → 404 NOT_FOUND', async () => {
    expect(await makeService().resumeExecution(`nope_${TS}`, 'admin_t4')).toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  test('T5: legacy rule (no execution_mode) with wait_for_callback → fail-closed, no suspension (D7)', async () => {
    const svc = makeService()
    // 'legacy' (not 'workflow_job_v1') → the service supplies no job lifecycle → the executor
    // gets no onSuspend → wait_for_callback fails closed. (Passing `undefined` would trigger
    // execRuleOf's default and accidentally test the opt-in path.)
    const exec = await svc.executeRule(
      execRuleOf(`atr_t5_${TS}`, 'legacy') as never,
      { sheetId: SHEET, recordId: '', data: {} },
    )
    execIds.push(exec.id)
    expect(exec.status).toBe('failed')
    const waitStep = exec.steps.find((s) => s.actionType === 'wait_for_callback')
    expect(waitStep?.status).toBe('failed')
    expect(waitStep?.error).toContain('workflow_job_v1')
    const susp = await q('SELECT count(*)::int AS n FROM multitable_automation_suspensions WHERE execution_id = $1', [exec.id])
    expect(susp.rows[0].n).toBe(0)
  })

  test('T6: stored trigger_event is A1-redacted (secret-shaped values scrubbed, D4)', async () => {
    const svc = makeService()
    const ruleId = await createWaitRule(svc, 't6')
    const exec = await suspend(svc, ruleId, '', { token: 'SUSPEND-SECRET-XYZ', label: 'ok' })
    const susp = await q('SELECT trigger_event FROM multitable_automation_suspensions WHERE execution_id = $1', [exec.id])
    expect(JSON.stringify(susp.rows[0].trigger_event)).not.toContain('SUSPEND-SECRET-XYZ')
  })

  test('T7: rule disabled between suspend and resume → 409 (re-derive uses CURRENT rule); token NOT consumed', async () => {
    const svc = makeService()
    const ruleId = await createWaitRule(svc, 't7')
    const exec = await suspend(svc, ruleId)
    const token = await tokenFor(exec.id)
    await q('UPDATE automation_rules SET enabled = false WHERE id = $1', [ruleId])
    expect(await svc.resumeExecution(token, 'admin_t7')).toMatchObject({ status: 409, code: 'RULE_MISSING_OR_DISABLED' })
    // Validation failure precedes the claim → suspension stays pending (recoverable).
    const susp = await q('SELECT status FROM multitable_automation_suspensions WHERE execution_id = $1', [exec.id])
    expect(susp.rows[0].status).toBe('pending')
  })

  test('T8: rule actions changed between suspend and resume → 409 RULE_CHANGED (D4b fingerprint)', async () => {
    const svc = makeService()
    const ruleId = await createWaitRule(svc, 't8')
    const exec = await suspend(svc, ruleId)
    const token = await tokenFor(exec.id)
    // Re-sequence the rule's actions (tail type changes) → fingerprint mismatch.
    const changed = JSON.stringify([
      { type: 'update_record', config: {} },
      { type: 'wait_for_callback', config: {} },
      { type: 'send_webhook', config: {} },
    ])
    await q('UPDATE automation_rules SET actions = $1::jsonb WHERE id = $2', [changed, ruleId])
    expect(await svc.resumeExecution(token, 'admin_t8')).toMatchObject({ status: 409, code: 'RULE_CHANGED' })
  })

  test('T9: record missing at resume (deleted during the wait) → 404 RECORD_GONE', async () => {
    const svc = makeService()
    // A recordId not present in meta_records at resume time — the same code path as a record
    // deleted mid-wait: resume re-fetches the live record → 0 rows → fail closed 404, no crash.
    const ruleId = await createWaitRule(svc, 't9')
    const exec = await suspend(svc, ruleId, `rec_gone_${TS}`)
    const token = await tokenFor(exec.id)
    expect(await svc.resumeExecution(token, 'admin_t9')).toMatchObject({ status: 404, code: 'RECORD_GONE' })
  })
})
