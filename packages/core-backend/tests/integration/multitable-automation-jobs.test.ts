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
})
