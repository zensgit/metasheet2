/**
 * Real-DB branch-local wait suspend/resume for the A6-3-3a runtime (admin-gated v1).
 *
 * Drives AutomationService.executeRule (suspend mid-branch) + resumeExecution (branch-aware
 * resume) against REAL Postgres — proving the wire that mock-db unit tests cannot for a
 * `wait_for_callback` INSIDE a selected `condition_branch`:
 *   - only the selected high-risk branch suspends; the ordinary low branch finishes (scope-gate §6);
 *   - the SUSPENDED job is the branch CHILD (step_key `N.branch.<key>.M`), the parent
 *     `condition_branch` job stays `running` (§4.2), and the suspend descriptor (resume token)
 *     hydrates onto the branch child, never the parent (§7 listByExecution stepKey hydration);
 *   - branch resume settles the wait child, runs the branch tail, settles the parent, then the
 *     top-level tail (§4.3);
 *   - the failure matrix (§5): branch-fingerprint drift → 409 RULE_CHANGED (pre-claim, token kept),
 *     a corrupt non-null resume cursor → 409 SUSPENSION_CURSOR_INVALID (pre-claim, token kept),
 *     a second resume → 409 ALREADY_RESUMED, and a post-resume branch-tail failure writes `skipped`
 *     C1 jobs for the REMAINING branch children AND the REMAINING top-level actions (slice-4 finding),
 *     execution terminal `failed`.
 *
 * Runs only with DATABASE_URL (plugin-tests.yml real-DB job).
 *
 * See docs/development/multitable-automation-a6-3-3-branch-local-wait-scope-gate-20260615.md
 *  and docs/development/multitable-automation-a6-3-3a-branch-local-wait-verification-20260615.md
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'
import { AutomationJobService } from '../../src/multitable/automation-job-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { normalizeWorkflowJob } from '../../src/multitable/workflow-job-contract'
import { db } from '../../src/db/db'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const SHEET = `sheet_blw_${TS}`
const BASE = `base_blw_${TS}`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const jobsRead = new AutomationJobService()
const execIds: string[] = []

/**
 * Real queryFn so update_record actually writes + resumeExecution re-fetches the live record.
 * fetchFn is injected per-scenario: an OK responder for the happy path, a 500 responder for the
 * branch-tail-failure scenario. failFetch returns 500 on EVERY attempt, so send_webhook settles
 * `failed` after its default retries regardless of AUTOMATION_WEBHOOK_MAX_RETRIES — no global env
 * mutation (which would leak into sibling integration files in a shared vitest worker).
 */
function makeService(fetchFn?: typeof fetch): AutomationService {
  return new AutomationService(new EventBus(), db as never, q as never, fetchFn as never)
}

const okFetch = (async () => new Response('OK', { status: 200 })) as unknown as typeof fetch
const failFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch

// HAPPY rule: one condition_branch (low ≤100000 → auto_approved; high >100000 → notify, WAIT,
// approved_after_review), then a top-level update_record so resume settles the top-level tail too.
const LOW_BRANCH_HAPPY = {
  key: 'low_amount',
  label: 'Low',
  conditions: { logic: 'and', conditions: [{ fieldId: 'amount', operator: 'less_or_equal', value: 100000 }] },
  actions: [{ type: 'update_record', config: { fields: { status: 'auto_approved' } } }],
}
const HIGH_BRANCH_HAPPY = {
  key: 'high_amount',
  label: 'High',
  conditions: { logic: 'and', conditions: [{ fieldId: 'amount', operator: 'greater_than', value: 100000 }] },
  actions: [
    { type: 'send_notification', config: { userIds: ['owner-1'], message: 'High amount needs review' } },
    { type: 'wait_for_callback', config: {} },
    { type: 'update_record', config: { fields: { status: 'approved_after_review' } } },
  ],
}
const HAPPY_BRANCH_ACTION = {
  type: 'condition_branch',
  config: { branches: [LOW_BRANCH_HAPPY, HIGH_BRANCH_HAPPY] },
} as const
const HAPPY_RULE_ACTIONS = [
  HAPPY_BRANCH_ACTION,
  { type: 'update_record', config: { fields: { final_step: 'done' } } },
] as const

// TAIL-FAILURE rule: the high branch's post-wait tail has a failing send_webhook that is NOT the
// last branch action, AND there is a top-level action after the condition_branch — so a tail
// failure must skip BOTH the remaining branch child (index 3) AND the remaining top-level (index 1).
const HIGH_BRANCH_FAIL = {
  key: 'high_amount',
  label: 'High',
  conditions: { logic: 'and', conditions: [{ fieldId: 'amount', operator: 'greater_than', value: 100000 }] },
  actions: [
    { type: 'send_notification', config: { userIds: ['owner-1'], message: 'review' } },
    { type: 'wait_for_callback', config: {} },
    { type: 'send_webhook', config: { url: 'https://example.test/fail' } },
    { type: 'update_record', config: { fields: { status: 'should_not_run' } } },
  ],
}
const FAIL_BRANCH_ACTION = {
  type: 'condition_branch',
  config: { branches: [LOW_BRANCH_HAPPY, HIGH_BRANCH_FAIL] },
} as const
const FAIL_RULE_ACTIONS = [
  FAIL_BRANCH_ACTION,
  { type: 'update_record', config: { fields: { final_step: 'should_not_run' } } },
] as const

async function createRule(
  svc: AutomationService,
  suffix: string,
  actions: ReadonlyArray<unknown>,
  branchConfig: unknown,
): Promise<string> {
  const created = await svc.createRule(SHEET, {
    name: `a6-3-3a ${suffix}`,
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'condition_branch',
    actionConfig: branchConfig as never,
    actions: actions as never,
    executionMode: 'workflow_job_v1',
    createdBy: 'u1',
  })
  return created.id
}

function execRuleOf(ruleId: string, actions: ReadonlyArray<unknown>, mode: string | undefined = 'workflow_job_v1') {
  return {
    id: ruleId, name: 'a6-3-3a', sheetId: SHEET,
    trigger: { type: 'record.created', config: {} },
    actions, enabled: true, createdBy: 'u1',
    createdAt: new Date(TS).toISOString(), executionMode: mode,
  }
}

/** Insert a real meta_records row so resume's record re-fetch succeeds + update_record writes land. */
async function seedRecord(recordId: string, data: Record<string, unknown>): Promise<void> {
  await q(
    `INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [recordId, SHEET, JSON.stringify(data)],
  )
}

async function run(
  svc: AutomationService,
  ruleId: string,
  actions: ReadonlyArray<unknown>,
  recordId: string,
  data: Record<string, unknown>,
) {
  const exec = await svc.executeRule(execRuleOf(ruleId, actions) as never, { sheetId: SHEET, recordId, data })
  execIds.push(exec.id)
  return exec
}

async function tokenFor(executionId: string): Promise<string> {
  const r = await q('SELECT resume_token FROM multitable_automation_suspensions WHERE execution_id = $1', [executionId])
  return r.rows[0]?.resume_token as string
}

async function jobRows(executionId: string): Promise<Array<{ step_index: number; step_key: string; action_type: string; status: string }>> {
  const r = await q(
    `SELECT step_index, step_key, action_type, status
       FROM multitable_automation_jobs WHERE execution_id = $1
       ORDER BY step_index ASC, created_at ASC, step_key ASC`,
    [executionId],
  )
  return r.rows as Array<{ step_index: number; step_key: string; action_type: string; status: string }>
}

async function recordStatus(recordId: string): Promise<string | undefined> {
  const r = await q(`SELECT data->>'status' AS status FROM meta_records WHERE id = $1 AND sheet_id = $2`, [recordId, SHEET])
  return r.rows[0]?.status as string | undefined
}

describeIfDatabase('multitable automation branch-local wait (A6-3-3a, real DB)', () => {
  beforeAll(async () => {
    // meta_records.sheet_id → meta_sheets(id) → meta_bases(id): seed the base + sheet so resume's
    // record re-fetch and update_record writes land (the A6-2 suspend-resume test sidesteps this
    // with recordId='', but the branch happy/tail-failure paths need a real record).
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [BASE, 'BLW Base', 'u1'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [SHEET, BASE, 'BLW Sheet'])
    await q('DELETE FROM multitable_automation_jobs WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM multitable_automation_suspensions WHERE sheet_id = $1', [SHEET])
  })
  afterAll(async () => {
    for (const id of execIds) {
      await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id])
    }
    await q('DELETE FROM multitable_automation_suspensions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM multitable_automation_jobs WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM automation_rules WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // §6 step 5 — LOW branch never suspends.
  test('HAPPY-low: amount ≤ 100000 → low branch runs, NO suspension, status auto_approved (§6.5)', async () => {
    const svc = makeService(okFetch)
    const ruleId = await createRule(svc, 'happy-low', HAPPY_RULE_ACTIONS, HAPPY_BRANCH_ACTION.config)
    const recId = `rec_low_${TS}`
    await seedRecord(recId, { amount: 50000 })

    const exec = await run(svc, ruleId, HAPPY_RULE_ACTIONS, recId, { amount: 50000 })

    expect(exec.status).toBe('success')
    const susp = await q('SELECT count(*)::int AS n FROM multitable_automation_suspensions WHERE execution_id = $1', [exec.id])
    expect(susp.rows[0].n).toBe(0)
    const suspendedJobs = (await jobRows(exec.id)).filter((j) => j.status === 'suspended')
    expect(suspendedJobs).toHaveLength(0)
    expect(await recordStatus(recId)).toBe('auto_approved')
  })

  // §6 step 6 — HIGH branch suspends; only the branch child is suspended, the parent stays running.
  test('HAPPY-high suspends: execution running, parent condition_branch RUNNING, branch wait child SUSPENDED, record not yet approved (§4.2/§6.6)', async () => {
    const svc = makeService(okFetch)
    const ruleId = await createRule(svc, 'happy-high', HAPPY_RULE_ACTIONS, HAPPY_BRANCH_ACTION.config)
    const recId = `rec_high_${TS}`
    await seedRecord(recId, { amount: 250000 })

    const exec = await run(svc, ruleId, HAPPY_RULE_ACTIONS, recId, { amount: 250000 })

    // D2: execution stays `running` (suspended state is out-of-band).
    expect(exec.status).toBe('running')

    const susp = await q(
      'SELECT status, step_index, reason, resume_cursor FROM multitable_automation_suspensions WHERE execution_id = $1',
      [exec.id],
    )
    expect(susp.rows).toHaveLength(1)
    expect(susp.rows[0].status).toBe('pending')
    expect(Number(susp.rows[0].step_index)).toBe(0) // parent condition_branch index
    expect(susp.rows[0].reason).toBe('external_event')
    // Branch-local cursor persisted (non-null) → resume re-enters the SELECTED branch.
    const cursor = typeof susp.rows[0].resume_cursor === 'string' ? JSON.parse(susp.rows[0].resume_cursor) : susp.rows[0].resume_cursor
    expect(cursor).toMatchObject({ kind: 'condition_branch', branchKey: 'high_amount', branchActionIndex: 1, stepKey: '0.branch.high_amount.1' })

    // §4.2 job state: parent condition_branch RUNNING; prior branch child (notify) resolved;
    // branch wait child SUSPENDED; later branch action + top-level tail not yet present.
    const rows = await jobRows(exec.id)
    const byKey = new Map(rows.map((r) => [r.step_key, r]))
    expect(byKey.get('0')).toMatchObject({ action_type: 'condition_branch', status: 'running' })
    expect(byKey.get('0.branch.high_amount.0')).toMatchObject({ action_type: 'send_notification', status: 'resolved' })
    expect(byKey.get('0.branch.high_amount.1')).toMatchObject({ action_type: 'wait_for_callback', status: 'suspended' })
    expect(byKey.has('0.branch.high_amount.2')).toBe(false) // later branch action not run yet
    expect(byKey.has('1')).toBe(false) // top-level tail not run yet
    expect(await recordStatus(recId)).not.toBe('approved_after_review') // post-wait update not run yet
  })

  // §7 — descriptor hydrates onto the branch CHILD (stepKey), NEVER the parent condition_branch job.
  test('descriptor-on-stepKey: listByExecution attaches the resume token to the branch child (step_key 0.branch.high_amount.1), never the parent (§7)', async () => {
    const svc = makeService(okFetch)
    const ruleId = await createRule(svc, 'desc-stepkey', HAPPY_RULE_ACTIONS, HAPPY_BRANCH_ACTION.config)
    const recId = `rec_desc_${TS}`
    await seedRecord(recId, { amount: 300000 })
    const exec = await run(svc, ruleId, HAPPY_RULE_ACTIONS, recId, { amount: 300000 })

    const views = await jobsRead.listByExecution(exec.id)
    const parent = views.find((v) => v.stepKey === '0')
    const waitChild = views.find((v) => v.stepKey === '0.branch.high_amount.1')

    // Parent condition_branch job is `running` and carries NO suspend descriptor.
    expect(parent).toMatchObject({ status: 'running' })
    expect((parent as { suspend?: unknown }).suspend).toBeUndefined()

    // Branch wait child is `suspended` and carries a VALID C1 descriptor (passes normalizeWorkflowJob).
    expect(waitChild).toMatchObject({ status: 'suspended', suspend: { reason: 'external_event' } })
    expect((waitChild as { suspend?: { resumeToken?: string } }).suspend?.resumeToken).toBeTruthy()
    expect(() => normalizeWorkflowJob(waitChild)).not.toThrow()
  })

  // The focused disambiguation that actually DISCRIMINATES step_key keying from step_index keying:
  // two `suspended` rows at the SAME step_index with DISTINCT stepKey + token. step_index keying would
  // give both the LAST token; step_key keying gives each its own. (The happy-path placement is
  // vacuously parent-safe because the parent is `running`; this case is the real proof of ③.)
  test('stepKey disambiguation: two suspended jobs at the same step_index get their OWN tokens by step_key (not the last token) (③)', async () => {
    const execId = `axe_blw_disamb_${TS}`
    execIds.push(execId)
    const ruleId = `atr_blw_disamb_${TS}`
    const mk = (stepKey: string, jobId: string) =>
      q(
        `INSERT INTO multitable_automation_jobs
           (id, execution_id, rule_id, sheet_id, step_index, step_key, action_type, status, schema_version, started_at)
         VALUES ($1, $2, $3, $4, 2, $5, 'wait_for_callback', 'suspended', 1, NOW())`,
        [jobId, execId, ruleId, SHEET, stepKey],
      )
    // Two suspended branch-child jobs, same step_index = 2, different branch step_keys.
    await mk('2.branch.b1.0', `${execId}:job:2:branch:b1:0`)
    await mk('2.branch.b2.0', `${execId}:job:2:branch:b2:0`)

    const mkSusp = (token: string, cursorStepKey: string) =>
      q(
        `INSERT INTO multitable_automation_suspensions
           (id, execution_id, rule_id, sheet_id, step_index, resume_token, reason, action_fingerprint, status, resume_cursor)
         VALUES ($1, $2, $3, $4, 2, $5, 'external_event', '{"count":1,"hash":"h"}'::jsonb, 'pending', $6::jsonb)`,
        [
          `asp_${token}`, execId, ruleId, SHEET, token,
          JSON.stringify({
            kind: 'condition_branch', parentStepIndex: 2, branchKey: cursorStepKey.split('.')[2],
            branchActionIndex: 0, stepKey: cursorStepKey,
            parentJobId: `${execId}:job:2`, branchJobId: `${execId}:job:2:branch:${cursorStepKey.split('.')[2]}:0`,
            upstreamJobId: null, branchActionFingerprint: { count: 1, hash: 'h' },
          }),
        ],
      )
    await mkSusp('tok_b1', '2.branch.b1.0')
    await mkSusp('tok_b2', '2.branch.b2.0')

    const views = await jobsRead.listByExecution(execId)
    const v1 = views.find((v) => v.stepKey === '2.branch.b1.0') as { suspend?: { resumeToken?: string } } | undefined
    const v2 = views.find((v) => v.stepKey === '2.branch.b2.0') as { suspend?: { resumeToken?: string } } | undefined
    // Each suspended job keeps ITS OWN token (step_key keying). With step_index keying both would
    // collapse to the last-inserted token (tok_b2) — this assertion fails on the unfixed code.
    expect(v1?.suspend?.resumeToken).toBe('tok_b1')
    expect(v2?.suspend?.resumeToken).toBe('tok_b2')
  })

  // §6 step 7 — branch resume: wait child resolves, branch tail runs, parent settles, top-level tail runs.
  test('HAPPY-high resume: branch wait resolves → branch update runs → parent resolved → top-level tail → success, status approved_after_review (§4.3/§6.7)', async () => {
    const svc = makeService(okFetch)
    const ruleId = await createRule(svc, 'happy-resume', HAPPY_RULE_ACTIONS, HAPPY_BRANCH_ACTION.config)
    const recId = `rec_resume_${TS}`
    await seedRecord(recId, { amount: 400000 })
    const exec = await run(svc, ruleId, HAPPY_RULE_ACTIONS, recId, { amount: 400000 })

    const result = await svc.resumeExecution(await tokenFor(exec.id), 'admin_resume')
    expect('execution' in result).toBe(true)
    if ('execution' in result) {
      expect(result.execution.status).toBe('success')
      expect(result.execution.initiatedBy).toBe('admin_resume')
    }

    const rows = await jobRows(exec.id)
    const byKey = new Map(rows.map((r) => [r.step_key, r.status]))
    expect(byKey.get('0')).toBe('resolved') // parent condition_branch settled
    expect(byKey.get('0.branch.high_amount.0')).toBe('resolved') // notify
    expect(byKey.get('0.branch.high_amount.1')).toBe('resolved') // wait settled
    expect(byKey.get('0.branch.high_amount.2')).toBe('resolved') // post-wait branch update ran
    expect(byKey.get('1')).toBe('resolved') // top-level tail ran

    expect(await recordStatus(recId)).toBe('approved_after_review')
    const susp = await q('SELECT status FROM multitable_automation_suspensions WHERE execution_id = $1', [exec.id])
    expect(susp.rows[0].status).toBe('resumed')
  })

  // §5 — selected branch path changed before resume → 409 RULE_CHANGED (branch fingerprint), pre-claim.
  test('drift guard before claim: mutating the SELECTED branch actions → 409 RULE_CHANGED, token NOT claimed (§5)', async () => {
    const svc = makeService(okFetch)
    const ruleId = await createRule(svc, 'drift', HAPPY_RULE_ACTIONS, HAPPY_BRANCH_ACTION.config)
    const recId = `rec_drift_${TS}`
    await seedRecord(recId, { amount: 500000 })
    const exec = await run(svc, ruleId, HAPPY_RULE_ACTIONS, recId, { amount: 500000 })
    const token = await tokenFor(exec.id)

    // Re-sequence the SELECTED branch's actions only (append one) so the BRANCH fingerprint trips
    // while the top-level fingerprint (['condition_branch','update_record']) stays equal → the branch
    // drift guard (not the top-level guard) is what fires. Persist via the rule jsonb.
    const driftedHigh = {
      ...HIGH_BRANCH_HAPPY,
      actions: [...HIGH_BRANCH_HAPPY.actions, { type: 'update_record', config: { fields: { extra: 1 } } }],
    }
    const driftedActions = JSON.stringify([
      { type: 'condition_branch', config: { branches: [LOW_BRANCH_HAPPY, driftedHigh] } },
      { type: 'update_record', config: { fields: { final_step: 'done' } } },
    ])
    await q('UPDATE automation_rules SET actions = $1::jsonb WHERE id = $2', [driftedActions, ruleId])

    expect(await svc.resumeExecution(token, 'admin_drift')).toMatchObject({ status: 409, code: 'RULE_CHANGED' })
    // Pre-claim guard → token stays pending (recoverable).
    const susp = await q('SELECT status FROM multitable_automation_suspensions WHERE execution_id = $1', [exec.id])
    expect(susp.rows[0].status).toBe('pending')
  })

  // §5 — a corrupt non-null resume cursor must fail closed (never a silent top-level fallback), pre-claim.
  test('invalid cursor: a corrupt non-null resume_cursor → 409 SUSPENSION_CURSOR_INVALID, token NOT claimed (§5)', async () => {
    const svc = makeService(okFetch)
    const ruleId = await createRule(svc, 'invalid', HAPPY_RULE_ACTIONS, HAPPY_BRANCH_ACTION.config)
    const recId = `rec_invalid_${TS}`
    await seedRecord(recId, { amount: 600000 })
    const exec = await run(svc, ruleId, HAPPY_RULE_ACTIONS, recId, { amount: 600000 })
    const token = await tokenFor(exec.id)

    // Corrupt the persisted cursor to a non-null but malformed object (unknown kind) → parseResumeCursor
    // yields `invalid` → resume must 409 fail-closed, NOT fall back to the top-level step_index path.
    await q(
      `UPDATE multitable_automation_suspensions SET resume_cursor = '{"kind":"top_level"}'::jsonb WHERE execution_id = $1`,
      [exec.id],
    )

    expect(await svc.resumeExecution(token, 'admin_invalid')).toMatchObject({ status: 409, code: 'SUSPENSION_CURSOR_INVALID' })
    const susp = await q('SELECT status FROM multitable_automation_suspensions WHERE execution_id = $1', [exec.id])
    expect(susp.rows[0].status).toBe('pending') // token NOT claimed
  })

  // §5 — single-use token: the second resume is rejected.
  test('second resume → 409 ALREADY_RESUMED (single-use token, §5)', async () => {
    const svc = makeService(okFetch)
    const ruleId = await createRule(svc, 'second', HAPPY_RULE_ACTIONS, HAPPY_BRANCH_ACTION.config)
    const recId = `rec_second_${TS}`
    await seedRecord(recId, { amount: 700000 })
    const exec = await run(svc, ruleId, HAPPY_RULE_ACTIONS, recId, { amount: 700000 })
    const token = await tokenFor(exec.id)

    expect('execution' in (await svc.resumeExecution(token, 'admin_second_1'))).toBe(true)
    expect(await svc.resumeExecution(token, 'admin_second_2')).toMatchObject({ status: 409, code: 'ALREADY_RESUMED' })
  })

  // §5 / slice-4 finding — a post-resume branch-tail failure fail-stops BOTH the remaining branch
  // children AND the remaining top-level actions as `skipped`; execution terminal `failed`.
  test('branch-tail failure on resume: remaining branch children AND remaining top-level jobs are skipped, execution failed (§5 + slice-4)', async () => {
    const svc = makeService(failFetch) // the post-wait send_webhook returns 500 → terminal branch-tail failure
    const ruleId = await createRule(svc, 'tail-fail', FAIL_RULE_ACTIONS, FAIL_BRANCH_ACTION.config)
    const recId = `rec_tailfail_${TS}`
    await seedRecord(recId, { amount: 800000 })
    const exec = await run(svc, ruleId, FAIL_RULE_ACTIONS, recId, { amount: 800000 })
    expect(exec.status).toBe('running') // suspended at the branch wait first

    const result = await svc.resumeExecution(await tokenFor(exec.id), 'admin_tailfail')
    expect('execution' in result).toBe(true)
    if ('execution' in result) {
      expect(result.execution.status).toBe('failed') // terminal; no auto-retry (D8)
    }

    const rows = await jobRows(exec.id)
    const byKey = new Map(rows.map((r) => [r.step_key, r.status]))
    expect(byKey.get('0.branch.high_amount.0')).toBe('resolved') // notify
    expect(byKey.get('0.branch.high_amount.1')).toBe('resolved') // wait settled on resume
    expect(byKey.get('0.branch.high_amount.2')).toBe('failed')   // send_webhook (500) failed
    // Remaining BRANCH child after the failed action → skipped (slice-4 finding).
    expect(byKey.get('0.branch.high_amount.3')).toBe('skipped')
    expect(byKey.get('0')).toBe('failed') // parent condition_branch settled failed
    // Remaining TOP-LEVEL action after the condition_branch → skipped (slice-4 finding).
    expect(byKey.get('1')).toBe('skipped')

    // The post-failure branch update must NOT have written the record.
    expect(await recordStatus(recId)).not.toBe('should_not_run')
  })
})
