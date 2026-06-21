/**
 * W6 full-HTTP-path operator seam (in-process).
 *
 * Extends the W6-1 service-seam coverage in `multitable-automation-start-approval.test.ts`
 * by driving the APPROVAL step over the REAL HTTP route instead of a direct service call:
 *
 *   AutomationService.executeRule(start_approval) -> suspended C1 job + pending approval
 *   -> HTTP POST /api/approvals/:id/actions {approve}  (real router: authenticate + rbacGuard
 *      + ApprovalProductService.dispatchAction)
 *   -> emitApprovalCompletionEvent -> singleton eventBus
 *   -> AutomationService resumes the suspended tail in the SAME process.
 *
 * This proves the cross-runtime resume fires through the real HTTP approval boundary (auth +
 * route + service), not only a direct `dispatchAction()` call. It is the in-process realization
 * of the "HTTP 审批 -> 同进程 resume" seam in the W6 operator path.
 *
 * It COMPLEMENTS, and does NOT replace, the deployed operator smoke (#2480), which still
 * validates real host routing / `/api` co-tenancy / browser UI. Owner acceptance of the
 * service-seam vs. keeping #2480 as the gate is a separate decision; this test only adds the
 * in-process HTTP coverage.
 *
 * Single AutomationService by design: the suspended job is created by this test's `svc`, and
 * only `svc` is subscribed to resume, so the fetch-mocked tail (`calls`) is the one that runs.
 */
import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { db } from '../../src/db/db'
import { eventBus } from '../../src/integration/events/event-bus'
import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { approvalsRouter } from '../../src/routes/approvals'
import { authRouter } from '../../src/routes/auth'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// tests/setup.ts stubs global `fetch` with vi.fn() inside its beforeAll (which runs after this
// module loads but before the tests). Capture the real fetch at module-load time so this
// real-HTTP test actually hits the mounted server instead of the stub.
const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_w6http_${TS}`
const SHEET = `sheet_w6http_${TS}`
const RECORD = `rec_w6http_${TS}`
const REQUESTER = `w6http_requester_${TS}`
const APPROVER = `w6http_approver_${TS}`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const executionIds: string[] = []
const ruleIds: string[] = []
const templateIds: string[] = []
const approvalIds: string[] = []

function makeAutomationService(fetchFn?: typeof fetch): AutomationService {
  const svc = new AutomationService(eventBus, db as never, q as never, fetchFn as never)
  svc.init()
  return svc
}

async function seedUsers(): Promise<void> {
  await q(
    `INSERT INTO permissions (code, name, description)
     VALUES ('approvals:write', 'Approvals Write', 'W6 HTTP seam test'),
            ('approvals:act', 'Approvals Act', 'W6 HTTP seam test')
     ON CONFLICT (code) DO NOTHING`,
  )
  for (const id of [REQUESTER, APPROVER]) {
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE, email = EXCLUDED.email, name = EXCLUDED.name`,
      [id, `${id}@example.test`],
    )
  }
  await q(
    `INSERT INTO user_permissions (user_id, permission_code)
     VALUES ($1, 'approvals:write')
     ON CONFLICT DO NOTHING`,
    [REQUESTER],
  )
  await q(
    `INSERT INTO user_permissions (user_id, permission_code)
     VALUES ($1, 'approvals:act')
     ON CONFLICT DO NOTHING`,
    [APPROVER],
  )
}

let templateSeq = 0
function approvalTemplateRequest() {
  templateSeq += 1
  return {
    key: `w6-http-${TS}-${templateSeq}`,
    name: 'W6 HTTP Approval',
    visibilityScope: { type: 'all', ids: [] },
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Approver',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

async function createPublishedTemplate(): Promise<string> {
  const approvals = new ApprovalProductService()
  const template = await approvals.createTemplate(approvalTemplateRequest() as never)
  templateIds.push(template.id)
  await approvals.publishTemplate(template.id, { policy: { allowRevoke: true } } as never)
  return template.id
}

function startApprovalActions(templateId: string) {
  return [
    {
      type: 'start_approval',
      config: {
        templateId,
        formDataMapping: { summary: 'Record {{record.title}} needs approval' },
        requester: { mode: 'trigger_actor' },
      },
    },
    { type: 'send_webhook', config: { url: 'https://example.test/w6-http-tail' } },
  ] as const
}

async function seedSheetRecord(title: string): Promise<void> {
  await q(`INSERT INTO meta_bases (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [BASE, 'W6 HTTP Base'])
  await q(`INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [SHEET, BASE, 'W6 HTTP Sheet'])
  await q(
    `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
     VALUES ($1, $2, $3::jsonb, 1, $4)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [RECORD, SHEET, JSON.stringify({ title }), REQUESTER],
  )
}

async function waitForExecutionStatus(svc: AutomationService, id: string, status: string) {
  await vi.waitFor(async () => {
    const execution = await svc.logs.getById(id)
    expect(execution?.status, JSON.stringify(execution)).toBe(status)
  }, { timeout: 5000, interval: 50 })
  return (await svc.logs.getById(id))!
}

describeIfDatabase('W6 start_approval full HTTP approve -> same-process resume (real DB)', () => {
  let server: Server | undefined
  let base = ''

  beforeAll(async () => {
    await ensureApprovalSchemaReady()
    await seedUsers()
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    app.use(approvalsRouter())
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server?.address()
    if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    for (const id of executionIds) {
      await q('DELETE FROM multitable_automation_approval_bridges WHERE execution_id = $1', [id])
      await q('DELETE FROM multitable_automation_suspensions WHERE execution_id = $1', [id])
      await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [id])
      await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id])
    }
    for (const id of approvalIds) {
      await q('DELETE FROM approval_records WHERE instance_id = $1', [id])
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [id])
      await q('DELETE FROM approval_instances WHERE id = $1', [id])
    }
    for (const id of ruleIds) await q('DELETE FROM automation_rules WHERE id = $1', [id])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET])
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE])
    for (const id of templateIds) {
      await q('DELETE FROM approval_published_definitions WHERE template_id = $1::uuid', [id])
      await q('DELETE FROM approval_template_versions WHERE template_id = $1::uuid', [id])
      await q('DELETE FROM approval_templates WHERE id = $1::uuid', [id])
    }
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[REQUESTER, APPROVER]])
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[REQUESTER, APPROVER]])
  })

  async function devToken(userId: string): Promise<string> {
    // Least-privilege actor: a non-admin user whose ONLY permission is approvals:act
    // (plus the DB grant in seedUsers). This makes the positive case exercise the specific
    // approvals:act rbacGuard path rather than an admin/`*:*` bypass.
    const res = await realFetch(
      `${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=user&perms=${encodeURIComponent('approvals:act')}`,
    )
    const body = (await res.json()) as { token?: string; data?: { token?: string } }
    const token = body.token ?? body.data?.token
    if (!token) throw new Error(`dev-token failed (${res.status}): ${JSON.stringify(body)}`)
    return token
  }

  async function suspendOnApproval(svc: AutomationService): Promise<{ executionId: string; approvalInstanceId: string }> {
    const templateId = await createPublishedTemplate()
    const created = await svc.createRule(SHEET, {
      name: 'W6 HTTP start approval',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: startApprovalActions(templateId)[0].config,
      actions: startApprovalActions(templateId) as never,
      executionMode: 'workflow_job_v1',
      createdBy: REQUESTER,
    })
    ruleIds.push(created.id)
    await seedSheetRecord('Q4 plan')
    const execRule = {
      id: created.id,
      name: 'W6 HTTP start approval',
      sheetId: SHEET,
      trigger: { type: 'record.created', config: {} },
      actions: startApprovalActions(templateId),
      enabled: true,
      createdBy: REQUESTER,
      createdAt: new Date(TS).toISOString(),
      executionMode: 'workflow_job_v1',
    }
    const execution = await svc.executeRule(execRule as never, {
      sheetId: SHEET,
      recordId: RECORD,
      data: { title: 'Q4 plan' },
      actorId: REQUESTER,
    })
    executionIds.push(execution.id)
    expect(execution.status).toBe('running')
    const bridge = await q(
      `SELECT status, approval_instance_id FROM multitable_automation_approval_bridges WHERE execution_id = $1`,
      [execution.id],
    )
    expect(bridge.rows).toHaveLength(1)
    expect(bridge.rows[0].status).toBe('pending')
    const approvalInstanceId = bridge.rows[0].approval_instance_id as string
    approvalIds.push(approvalInstanceId)
    return { executionId: execution.id, approvalInstanceId }
  }

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('unauthenticated HTTP approve is rejected and does NOT resume the tail', async () => {
    const calls: string[] = []
    const svc = makeAutomationService((async (url: string) => {
      calls.push(url)
      return new Response('OK', { status: 200 })
    }) as never)
    try {
      const { executionId, approvalInstanceId } = await suspendOnApproval(svc)
      const res = await realFetch(`${base}/api/approvals/${approvalInstanceId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', comment: 'no token' }),
      })
      expect(res.status).toBe(401)
      // tail must not have run; execution stays suspended-running
      expect(calls).toEqual([])
      const exec = await svc.logs.getById(executionId)
      expect(exec?.status).toBe('running')
      const bridge = await q('SELECT status FROM multitable_automation_approval_bridges WHERE execution_id = $1', [executionId])
      expect(bridge.rows[0].status).toBe('pending')
    } finally {
      svc.shutdown()
    }
  })

  test('HTTP approve (authenticated) drives same-process resume of the suspended tail', async () => {
    const calls: string[] = []
    const svc = makeAutomationService((async (url: string) => {
      calls.push(url)
      return new Response('OK', { status: 200 })
    }) as never)
    try {
      const { executionId, approvalInstanceId } = await suspendOnApproval(svc)

      // tail has NOT run while suspended
      expect(calls).toEqual([])

      // approve over the REAL HTTP route as the assigned approver
      const token = await devToken(APPROVER)
      const res = await realFetch(`${base}/api/approvals/${approvalInstanceId}/actions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', comment: 'go via http' }),
      })
      expect(res.status).toBe(200)

      // same-process resume fired from the HTTP approval completion event
      const resumed = await waitForExecutionStatus(svc, executionId, 'success')
      expect(resumed.steps.map((s) => [s.actionType, s.status])).toEqual([
        ['start_approval', 'success'],
        ['send_webhook', 'success'],
      ])
      expect(resumed.steps[0].output).toMatchObject({ approvalInstanceId, outcome: 'approved' })

      // the tail ran exactly once, in THIS process, only after the HTTP approve
      expect(calls).toEqual(['https://example.test/w6-http-tail'])

      const finalBridge = await q(
        'SELECT status, outcome, resumed_at FROM multitable_automation_approval_bridges WHERE execution_id = $1',
        [executionId],
      )
      expect(finalBridge.rows[0]).toMatchObject({ status: 'resumed', outcome: 'approved' })
      expect(finalBridge.rows[0].resumed_at).toBeTruthy()
    } finally {
      svc.shutdown()
    }
  })
})
