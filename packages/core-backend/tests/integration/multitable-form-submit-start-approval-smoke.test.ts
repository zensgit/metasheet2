/**
 * W6 operator-smoke — IN-PROCESS seam for the `form.submitted → start_approval` chain (#1, 2026-06-29).
 *
 * The existing W6 seam (#2974, `multitable-automation-start-approval-http.test.ts`) proves
 * `record.created → start_approval → approval → HTTP approve → resume`. THE GAP this closes: the operator's
 * actual entry point is a FORM SUBMIT (#3336 `form.submitted` trigger + #3339 `start_approval` action,
 * editor-exposed), which no single test chains end-to-end to a real approval + the approver's todo.
 *
 * Real event chain over the real HTTP submit boundary + real Postgres:
 *   POST /api/multitable/views/:id/submit  →  eventBus 'multitable.form.submitted'
 *     →  AutomationService subscription  →  matchesTrigger('form.submitted')  →  executeRule(start_approval)
 *       →  a pending approval instance + the bridge linkage  →  the approver's ACTIVE assignment (the todo).
 *
 * Asserts the operator scenario: submit a form → an approval instance is created → the approver has a
 * pending todo. The DEPLOYED browser/operator path (cross-process, /api co-tenancy) stays the #2480 runbook;
 * this is the automatable, CI-wired in-process proof that backs the operator-smoke acceptance record.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_fsa_${TS}`
const SHEET_ID = `sheet_fsa_${TS}`
const VIEW_ID = `view_fsa_${TS}`
const FLD_VALUE = `fld_fsa_value_${TS}`
const REQUESTER = `u_fsa_req_${TS}`
const APPROVER = `u_fsa_appr_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const queryFn = ((sql: string, params?: unknown[]) => poolManager.get().query(sql, params)) as never

let app: Express
let svc: AutomationService
let ruleId = ''
let templateId = ''

function approvalTemplateRequest() {
  return {
    key: `fsa-${TS}`,
    name: 'Form-submit Start-approval Smoke',
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Approver',
          config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] },
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

async function bridgeFor(rid: string): Promise<{ status: string; approval_instance_id: string } | undefined> {
  const r = await q(
    `SELECT b.status, b.approval_instance_id
       FROM multitable_automation_approval_bridges b
       JOIN multitable_automation_executions e ON e.id = b.execution_id
      WHERE e.rule_id = $1
      ORDER BY b.created_at DESC LIMIT 1`,
    [rid],
  )
  return (r.rows as Array<{ status: string; approval_instance_id: string }>)[0]
}

describeIfDatabase('W6 form.submitted → start_approval → approval instance → approver todo (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { user: unknown }).user = { id: REQUESTER, roles: ['member'], perms: ['multitable:write'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'FSA Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'FSA Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VALUE, SHEET_ID, 'Value', 'number', '{}', 1])
    await q('INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)', [VIEW_ID, SHEET_ID, 'Form', 'form', JSON.stringify({})])

    // start_approval resolves the requester (trigger actor) + the static approver against the users table —
    // both must be real + active; the requester also needs `approvals:write` to start, the approver
    // `approvals:act` (mirrors the W6 seam #2974). Else: "requester user not found" / "lacks approvals:write".
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:write', 'Approvals Write', 'FSA smoke'), ('approvals:act', 'Approvals Act', 'FSA smoke')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [REQUESTER, APPROVER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
        [uid, `${uid}@fsa.test`],
      )
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    const approvals = new ApprovalProductService()
    const template = await approvals.createTemplate(approvalTemplateRequest() as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)

    svc = new AutomationService(integrationEventBus, db as never, queryFn)
    svc.init()
    // Editor-exposed shape: form.submitted trigger → start_approval action (#3336 + #3339).
    const rule = await svc.createRule(SHEET_ID, {
      name: 'on form submit start approval',
      triggerType: 'form.submitted',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: {
        templateId,
        formDataMapping: { summary: 'Approval for form submission {{recordId}}' },
        requester: { mode: 'trigger_actor' },
      },
      // start_approval is a suspend/resume job action — requires the job runtime (same as #2974).
      executionMode: 'workflow_job_v1',
    } as never)
    ruleId = (rule as { id: string }).id
  })

  afterAll(async () => {
    try { svc?.shutdown() } catch { /* noop */ }
    // Operators capturing acceptance evidence can set SMOKE_KEEP=1 to leave the seeded
    // rule/template/instance/bridge in place for inspection (IDs are otherwise ephemeral).
    if (process.env.SMOKE_KEEP) return
    const inst = await bridgeFor(ruleId)
    if (inst?.approval_instance_id) {
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [inst.approval_instance_id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [inst.approval_instance_id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [inst.approval_instance_id]).catch(() => {})
    }
    await q('DELETE FROM multitable_automation_approval_bridges WHERE execution_id IN (SELECT id FROM multitable_automation_executions WHERE rule_id = $1)', [ruleId]).catch(() => {})
    await q('DELETE FROM multitable_automation_executions WHERE rule_id = $1', [ruleId]).catch(() => {})
    await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
    if (templateId) await q('DELETE FROM approval_templates WHERE id = $1', [templateId]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE id = $1', [VIEW_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[REQUESTER, APPROVER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[REQUESTER, APPROVER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('operator scenario: form submit → start_approval → a pending approval instance + the approver todo', async () => {
    // 1) Submit the form over the real HTTP boundary → emits form.submitted.
    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { [FLD_VALUE]: 5 } })
    expect(res.status).toBe(200)

    // 2) The form.submitted rule fired → an execution row, and start_approval opened a PENDING bridge.
    let bridge: { status: string; approval_instance_id: string } | undefined
    await (async () => {
      const deadline = Date.now() + 6000
      for (;;) {
        bridge = await bridgeFor(ruleId)
        if (bridge?.approval_instance_id) return
        if (Date.now() > deadline) return
        await new Promise((r) => setTimeout(r, 50))
      }
    })()
    expect(bridge, 'start_approval should have created an approval bridge from the form.submitted rule').toBeTruthy()
    expect(bridge!.status).toBe('pending')

    // 3) A real approval INSTANCE was created and is non-terminal (the operator's "approval instance generated").
    const instId = bridge!.approval_instance_id
    const inst = await q('SELECT status FROM approval_instances WHERE id = $1', [instId])
    expect((inst.rows as Array<{ status: string }>).length).toBe(1)
    expect(['pending', 'running', 'in_progress', 'active']).toContain((inst.rows[0] as { status: string }).status)

    // 4) The approver has an ACTIVE assignment for this instance — the "待办出现" (todo appears).
    const todo = await q(
      `SELECT 1 FROM approval_assignments WHERE instance_id = $1 AND assignee_id = $2 AND is_active = true`,
      [instId, APPROVER],
    )
    expect((todo.rows as unknown[]).length, 'the approver should have an active pending todo').toBeGreaterThanOrEqual(1)
  })
})
