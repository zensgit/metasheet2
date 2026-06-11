/**
 * Real-DB round-trip for the A6-1 persistent WorkflowJob plane.
 *
 * Closes the wire-vs-fixture gap for the NEW `multitable_automation_jobs` table:
 * unit tests assert insert/update payloads via a MOCK db, which does NOT prove the
 * migration created the table/columns, the Kysely types allow them, or the row
 * mapper reads them back. This drives AutomationJobService against REAL Postgres
 * (lifecycleFor onStart→onSettled→onSkipped → listByExecution + raw-SQL confirm).
 * Runs only with DATABASE_URL (plugin-tests.yml real-DB job).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationJobService } from '../../src/multitable/automation-job-service'
import { AutomationService } from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { db } from '../../src/db/db'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const EXEC_ID = `axe_jobs_${TS}`
const RULE_ID = `atr_jobs_${TS}`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const jobs = new AutomationJobService()

describeIfDatabase('multitable automation jobs (A6-1, real DB)', () => {
  beforeAll(async () => {
    await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [EXEC_ID])
  })
  afterAll(async () => {
    await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [EXEC_ID])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('lifecycle round-trips through real Postgres: onStart(running) → onSettled(resolved, redacted) → listByExecution(C1)', async () => {
    const lc = jobs.lifecycleFor(EXEC_ID, { id: RULE_ID, sheetId: 'sheet_jobs' })

    // onStart — if the migration/table/columns were missing this insert would throw.
    await lc.onStart(0, { type: 'send_webhook', config: {} } as never)
    let raw = await q('SELECT status, upstream_job_id FROM multitable_automation_jobs WHERE id = $1', [`${EXEC_ID}:job:0`])
    expect(raw.rows[0].status).toBe('running')
    expect(raw.rows[0].upstream_job_id).toBeNull()

    // onSettled — secret-shaped result/error scrubbed before persist (A1 invariant).
    await lc.onSettled(0, { type: 'send_webhook' } as never, {
      actionType: 'send_webhook', status: 'success',
      output: { token: 'LIVE-SECRET', ok: true }, durationMs: 7,
    } as never)
    raw = await q('SELECT status, result, error FROM multitable_automation_jobs WHERE id = $1', [`${EXEC_ID}:job:0`])
    expect(raw.rows[0].status).toBe('resolved') // success → resolved (C1 bridge)
    expect(JSON.stringify(raw.rows[0].result)).not.toContain('LIVE-SECRET') // redactValue (token key masked)

    // second action fails → fail-stop onSkipped for a third
    await lc.onStart(1, { type: 'send_webhook' } as never)
    await lc.onSettled(1, { type: 'send_webhook' } as never, {
      actionType: 'send_webhook', status: 'failed', error: 'boom', durationMs: 2,
    } as never)
    await lc.onSkipped(2, { type: 'send_email' } as never)

    // listByExecution → C1 views in step order, with the right statuses + upstream chain.
    const views = await jobs.listByExecution(EXEC_ID)
    expect(views.map((v) => v.status)).toEqual(['resolved', 'failed', 'skipped'])
    expect(views.map((v) => v.id)).toEqual([`${EXEC_ID}:job:0`, `${EXEC_ID}:job:1`, `${EXEC_ID}:job:2`])
    expect(views[1].upstreamJobId).toBe(`${EXEC_ID}:job:0`)
    expect(views[0].error).toBeUndefined() // resolved → no error key
    expect(views[1].error).toBe('boom')
  })

  test('listByExecution returns [] for an execution with no jobs (legacy fallback signal)', async () => {
    const views = await jobs.listByExecution(`axe_none_${TS}`)
    expect(views).toEqual([])
  })

  // A6-1 enable-writer: the opt-in flag must round-trip through the REAL automation_rules
  // column. Mock-db unit tests assert the INSERT payload; only this proves the migration
  // column exists, Kysely accepts it, and mapRow reads it back (the wire-vs-fixture gap).
  test('enable-writer: createRule persists execution_mode and getRule reads it back; off-path is null', async () => {
    const sheetId = `sheet_enable_${TS}`
    const svc = new AutomationService(
      new EventBus(),
      db as never,
      (async () => ({ rows: [], rowCount: 0 })) as never,
    )
    const createdIds: string[] = []
    try {
      const optIn = await svc.createRule(sheetId, {
        name: 'opt-in', triggerType: 'record.created', triggerConfig: {},
        actionType: 'update_record', actionConfig: { fields: { status: 'done' } },
        executionMode: 'workflow_job_v1',
      })
      createdIds.push(optIn.id)
      expect(optIn.execution_mode).toBe('workflow_job_v1')
      expect((await svc.getRule(optIn.id))?.execution_mode).toBe('workflow_job_v1')

      const legacy = await svc.createRule(sheetId, {
        name: 'legacy', triggerType: 'record.created', triggerConfig: {},
        actionType: 'update_record', actionConfig: { fields: { status: 'done' } },
      })
      createdIds.push(legacy.id)
      expect((await svc.getRule(legacy.id))?.execution_mode).toBeNull()
    } finally {
      for (const id of createdIds) await q('DELETE FROM automation_rules WHERE id = $1', [id])
    }
  })

  // A6-1 acceptance SEAM: prove the full opt-in path end-to-end on real Postgres — a rule with
  // execution_mode='workflow_job_v1' run through executeRule() actually persists a per-action
  // WorkflowJob plane (C1), and a legacy rule writes none. Unit tests mock the executor and the
  // lifecycle test above drives lifecycleFor directly; only this exercises executeRule's
  // job-factory wiring (the one path never run as a single chain). A throwing fetchFn makes any
  // webhook action fail fast; `onStart` writes a job BEFORE the action, so ≥1 job persists
  // regardless of the action outcome.
  test('acceptance seam: executeRule opt-in writes per-action jobs (C1); opt-out writes none', async () => {
    const svc = new AutomationService(
      new EventBus(),
      db as never,
      (async () => ({ rows: [], rowCount: 0 })) as never,
      (async () => {
        throw new Error('network blocked in acceptance seam test')
      }) as never,
    )
    const baseRule = {
      name: 'a6-1 seam',
      sheetId: `sheet_seam_${TS}`,
      trigger: { type: 'record.created', config: {} },
      actions: [{ type: 'send_webhook', config: { url: 'http://127.0.0.1:1/blocked' } }],
      enabled: true,
      createdBy: '',
      createdAt: new Date(TS).toISOString(),
    }
    const event = { sheetId: baseRule.sheetId, recordId: `rec_seam_${TS}`, data: {} }
    const execIds: string[] = []
    try {
      const optIn = await svc.executeRule(
        { ...baseRule, id: `atr_seam_in_${TS}`, executionMode: 'workflow_job_v1' } as never,
        event,
      )
      execIds.push(optIn.id)
      // Deterministic: one send_webhook action + a throwing fetchFn → the action FAILS, so the
      // execution and its single job must both SETTLE to `failed` (onStart → action → onSettled).
      // Asserting the exact failed shape — not ">=1 job / any status" — is the point: a stuck
      // `running` job (executeRule wiring onStart but never settling) would otherwise look green.
      expect(optIn.status).toBe('failed')
      expect(optIn.steps).toHaveLength(1)
      expect(optIn.steps[0]).toMatchObject({ actionType: 'send_webhook', status: 'failed' })
      const jobRows = await q(
        'SELECT status, error FROM multitable_automation_jobs WHERE execution_id = $1',
        [optIn.id],
      )
      expect(jobRows.rows).toHaveLength(1) // exactly one job — settled, not a stuck-running duplicate
      expect(jobRows.rows[0].status).toBe('failed') // settled to failed, NOT left running
      expect(jobRows.rows[0].error).toBeTruthy() // onSettled persisted the failure (redacted), not empty
      const views = await jobs.listByExecution(optIn.id)
      expect(views).toHaveLength(1)
      expect(views[0].status).toBe('failed') // C1 view agrees: failed

      const legacy = await svc.executeRule({ ...baseRule, id: `atr_seam_out_${TS}` } as never, event)
      execIds.push(legacy.id)
      const none = await q(
        'SELECT count(*)::int AS n FROM multitable_automation_jobs WHERE execution_id = $1',
        [legacy.id],
      )
      expect(none.rows[0].n).toBe(0) // legacy rule writes zero job rows (opt-out unchanged)
    } finally {
      for (const id of execIds) {
        await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [id])
        await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id])
      }
    }
  })

  test('A6-3-1 seam: condition_branch persists parent, selected child, and downstream C1 jobs', async () => {
    const urls: string[] = []
    const svc = new AutomationService(
      new EventBus(),
      db as never,
      (async () => ({ rows: [], rowCount: 0 })) as never,
      (async (url: string) => {
        urls.push(url)
        return new Response('OK', { status: 200 })
      }) as never,
    )
    const sheetId = `sheet_branch_${TS}`
    const branchAction = {
      type: 'condition_branch',
      config: {
        branches: [
          {
            key: 'vip',
            label: 'VIP',
            conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
            actions: [{ type: 'send_webhook', config: { url: 'https://example.test/vip' } }],
          },
          {
            key: 'standard',
            conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'standard' }] },
            actions: [{ type: 'send_webhook', config: { url: 'https://example.test/standard' } }],
          },
        ],
      },
    } as const
    const execIds: string[] = []
    const ruleIds: string[] = []
    try {
      const persisted = await svc.createRule(sheetId, {
        name: 'A6-3 branch real DB',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'condition_branch',
        actionConfig: branchAction.config,
        actions: [branchAction],
        executionMode: 'workflow_job_v1',
        createdBy: 'u1',
      })
      ruleIds.push(persisted.id)
      expect(persisted.action_type).toBe('condition_branch')
      expect(persisted.execution_mode).toBe('workflow_job_v1')

      const optIn = await svc.executeRule(
        {
          id: `atr_branch_in_${TS}`,
          name: 'A6-3 branch opt-in',
          sheetId,
          trigger: { type: 'record.created', config: {} },
          actions: [
            branchAction,
            { type: 'send_webhook', config: { url: 'https://example.test/after' } },
          ],
          enabled: true,
          createdBy: 'u1',
          createdAt: new Date(TS).toISOString(),
          executionMode: 'workflow_job_v1',
        } as never,
        { sheetId, recordId: `rec_branch_${TS}`, data: { tier: 'vip' } },
      )
      execIds.push(optIn.id)
      expect(optIn.status).toBe('success')
      expect(optIn.steps[0]).toMatchObject({
        actionType: 'condition_branch',
        status: 'success',
        output: { selectedBranchKey: 'vip', selectedBranchLabel: 'VIP', matched: true },
      })
      expect(urls).toEqual(['https://example.test/vip', 'https://example.test/after'])

      const raw = await q(
        `SELECT id, step_index, step_key, action_type, status, upstream_job_id
           FROM multitable_automation_jobs
          WHERE execution_id = $1
          ORDER BY step_index ASC, step_key ASC`,
        [optIn.id],
      )
      expect(raw.rows).toEqual([
        {
          id: `${optIn.id}:job:0`,
          step_index: 0,
          step_key: '0',
          action_type: 'condition_branch',
          status: 'resolved',
          upstream_job_id: null,
        },
        {
          id: `${optIn.id}:job:0:branch:vip:0`,
          step_index: 0,
          step_key: '0.branch.vip.0',
          action_type: 'send_webhook',
          status: 'resolved',
          upstream_job_id: `${optIn.id}:job:0`,
        },
        {
          id: `${optIn.id}:job:1`,
          step_index: 1,
          step_key: '1',
          action_type: 'send_webhook',
          status: 'resolved',
          upstream_job_id: `${optIn.id}:job:0:branch:vip:0`,
        },
      ])
      const views = await jobs.listByExecution(optIn.id)
      expect(views.map((v) => [v.stepKey, v.status, v.upstreamJobId])).toEqual([
        ['0', 'resolved', null],
        ['0.branch.vip.0', 'resolved', `${optIn.id}:job:0`],
        ['1', 'resolved', `${optIn.id}:job:0:branch:vip:0`],
      ])

      const legacy = await svc.executeRule(
        {
          id: `atr_branch_out_${TS}`,
          name: 'A6-3 branch legacy',
          sheetId,
          trigger: { type: 'record.created', config: {} },
          actions: [branchAction],
          enabled: true,
          createdBy: 'u1',
          createdAt: new Date(TS).toISOString(),
        } as never,
        { sheetId, recordId: `rec_branch_${TS}`, data: { tier: 'vip' } },
      )
      execIds.push(legacy.id)
      expect(legacy.status).toBe('failed')
      const none = await q(
        'SELECT count(*)::int AS n FROM multitable_automation_jobs WHERE execution_id = $1',
        [legacy.id],
      )
      expect(none.rows[0].n).toBe(0)
    } finally {
      for (const id of execIds) {
        await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [id])
        await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id])
      }
      for (const id of ruleIds) {
        await q('DELETE FROM automation_rules WHERE id = $1', [id])
      }
    }
  })

  test('A6-3-4 seam: parallel_branch join_all persists parent, all child jobs, and downstream C1 lineage', async () => {
    const notifications: unknown[] = []
    const bus = new EventBus()
    const svc = new AutomationService(
      bus,
      db as never,
      (async () => ({ rows: [], rowCount: 0 })) as never,
    )
    const subscription = bus.subscribe('automation.notification', (payload) => {
      notifications.push(payload)
    })
    const sheetId = `sheet_parallel_${TS}`
    const parallelAction = {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches: [
          {
            key: 'ops',
            label: 'Ops',
            actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }],
          },
          {
            key: 'notify',
            label: 'Notify',
            actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'ready' } }],
          },
        ],
      },
    } as const
    const execIds: string[] = []
    const ruleIds: string[] = []
    try {
      const persisted = await svc.createRule(sheetId, {
        name: 'A6-3-4 parallel real DB',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'parallel_branch',
        actionConfig: parallelAction.config,
        actions: [parallelAction],
        executionMode: 'workflow_job_v1',
        createdBy: 'u1',
      })
      ruleIds.push(persisted.id)
      expect(persisted.action_type).toBe('parallel_branch')
      expect(persisted.execution_mode).toBe('workflow_job_v1')

      const optIn = await svc.executeRule(
        {
          id: `atr_parallel_in_${TS}`,
          name: 'A6-3-4 parallel opt-in',
          sheetId,
          trigger: { type: 'record.created', config: {} },
          actions: [
            parallelAction,
            { type: 'update_record', config: { fields: { after_parallel: true } } },
          ],
          enabled: true,
          createdBy: 'u1',
          createdAt: new Date(TS).toISOString(),
          executionMode: 'workflow_job_v1',
        } as never,
        { sheetId, recordId: `rec_parallel_${TS}`, data: {} },
      )
      execIds.push(optIn.id)
      expect(optIn.status).toBe('success')
      expect(optIn.steps[0]).toMatchObject({
        actionType: 'parallel_branch',
        status: 'success',
        output: {
          joinMode: 'all',
          resolvedBranchKeys: ['ops', 'notify'],
          failedBranchKeys: [],
          branchStatuses: { ops: 'resolved', notify: 'resolved' },
        },
      })
      expect(notifications).toHaveLength(1)

      const raw = await q(
        `SELECT id, step_index, step_key, action_type, status, upstream_job_id, result
           FROM multitable_automation_jobs
          WHERE execution_id = $1
          ORDER BY step_index ASC, created_at ASC, step_key ASC`,
        [optIn.id],
      )
      expect(raw.rows.map((r) => ({
        id: r.id,
        step_index: r.step_index,
        step_key: r.step_key,
        action_type: r.action_type,
        status: r.status,
        upstream_job_id: r.upstream_job_id,
      }))).toEqual([
        {
          id: `${optIn.id}:job:0`,
          step_index: 0,
          step_key: '0',
          action_type: 'parallel_branch',
          status: 'resolved',
          upstream_job_id: null,
        },
        {
          id: `${optIn.id}:job:0:parallel:ops:0`,
          step_index: 0,
          step_key: '0.parallel.ops.0',
          action_type: 'update_record',
          status: 'resolved',
          upstream_job_id: `${optIn.id}:job:0`,
        },
        {
          id: `${optIn.id}:job:0:parallel:notify:0`,
          step_index: 0,
          step_key: '0.parallel.notify.0',
          action_type: 'send_notification',
          status: 'resolved',
          upstream_job_id: `${optIn.id}:job:0`,
        },
        {
          id: `${optIn.id}:job:1`,
          step_index: 1,
          step_key: '1',
          action_type: 'update_record',
          status: 'resolved',
          upstream_job_id: `${optIn.id}:job:0`,
        },
      ])
      expect(JSON.stringify(raw.rows[0].result)).toContain('childJobIds')

      const views = await jobs.listByExecution(optIn.id)
      expect(views.map((v) => [v.stepKey, v.status, v.upstreamJobId])).toEqual([
        ['0', 'resolved', null],
        ['0.parallel.ops.0', 'resolved', `${optIn.id}:job:0`],
        ['0.parallel.notify.0', 'resolved', `${optIn.id}:job:0`],
        ['1', 'resolved', `${optIn.id}:job:0`],
      ])
    } finally {
      bus.unsubscribe(subscription)
      for (const id of execIds) {
        await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [id])
        await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id])
      }
      for (const id of ruleIds) {
        await q('DELETE FROM automation_rules WHERE id = $1', [id])
      }
    }
  })

  test('A6-3-4 seam: parallel_branch branch failure still runs siblings, skips branch tail and downstream', async () => {
    const notifications: unknown[] = []
    const bus = new EventBus()
    const svc = new AutomationService(
      bus,
      db as never,
      (async () => ({ rows: [], rowCount: 0 })) as never,
    )
    const subscription = bus.subscribe('automation.notification', (payload) => {
      notifications.push(payload)
    })
    const sheetId = `sheet_parallel_fail_${TS}`
    const parallelAction = {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches: [
          {
            key: 'bad',
            actions: [
              { type: 'send_notification', config: { userIds: [], message: 'missing users' } },
              { type: 'update_record', config: { fields: { should_not_run: true } } },
            ],
          },
          {
            key: 'good',
            actions: [{ type: 'send_notification', config: { userIds: ['u2'], message: 'still runs' } }],
          },
        ],
      },
    } as const
    const execIds: string[] = []
    try {
      const exec = await svc.executeRule(
        {
          id: `atr_parallel_fail_${TS}`,
          name: 'A6-3-4 parallel failure',
          sheetId,
          trigger: { type: 'record.created', config: {} },
          actions: [
            parallelAction,
            { type: 'update_record', config: { fields: { after_parallel: true } } },
          ],
          enabled: true,
          createdBy: 'u1',
          createdAt: new Date(TS).toISOString(),
          executionMode: 'workflow_job_v1',
        } as never,
        { sheetId, recordId: `rec_parallel_fail_${TS}`, data: {} },
      )
      execIds.push(exec.id)
      expect(exec.status).toBe('failed')
      expect(exec.steps).toEqual([
        expect.objectContaining({
          actionType: 'parallel_branch',
          status: 'failed',
          output: expect.objectContaining({
            resolvedBranchKeys: ['good'],
            failedBranchKeys: ['bad'],
            branchStatuses: { bad: 'failed', good: 'resolved' },
          }),
        }),
        { actionType: 'update_record', status: 'skipped', durationMs: 0 },
      ])
      expect(notifications).toHaveLength(1) // good sibling still ran

      const raw = await q(
        `SELECT step_key, action_type, status, upstream_job_id
           FROM multitable_automation_jobs
          WHERE execution_id = $1
          ORDER BY step_index ASC, created_at ASC, step_key ASC`,
        [exec.id],
      )
      expect(raw.rows).toEqual([
        { step_key: '0', action_type: 'parallel_branch', status: 'failed', upstream_job_id: null },
        { step_key: '0.parallel.bad.0', action_type: 'send_notification', status: 'failed', upstream_job_id: `${exec.id}:job:0` },
        { step_key: '0.parallel.bad.1', action_type: 'update_record', status: 'skipped', upstream_job_id: `${exec.id}:job:0:parallel:bad:0` },
        { step_key: '0.parallel.good.0', action_type: 'send_notification', status: 'resolved', upstream_job_id: `${exec.id}:job:0` },
        { step_key: '1', action_type: 'update_record', status: 'skipped', upstream_job_id: `${exec.id}:job:0` },
      ])
    } finally {
      bus.unsubscribe(subscription)
      for (const id of execIds) {
        await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [id])
        await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id])
      }
    }
  })
})
