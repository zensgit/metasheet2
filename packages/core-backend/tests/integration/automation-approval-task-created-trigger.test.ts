/**
 * A-2a `approval.task_created` automation trigger — real-DB integration (one-tap lock #3594
 * implementation decision, owner-ratified 2026-07-05).
 *
 * Real event chain over real Postgres + the real in-process eventBus:
 *   ApprovalProductService (create / transfer / add-sign / return) → insertAssignments collector
 *     → emitApprovalTaskCreatedEventsPostCommit (is_active re-checked post-commit)
 *       → AutomationService subscription → handleApprovalTaskCreatedTrigger (template-routed)
 *         → T2-6 ledger claim (`approval.task_created:{eventId}`) → executeRule (record-less)
 *           → send_notification → eventBus 'automation.notification' (fixture-free oracle).
 *
 * Owner review matrix: per-recipient granularity (NOT per-node) · eventId quad
 * instanceId+nodeKey+entryEpoch+assigneeUserId · same-eventId replay = no-op ·
 * templateId-null out-of-contract · save-time hidden-template reject + post-save scope flip =
 * fire-skip · record-write/start_approval/delete_record/conditions rejected at create AND update ·
 * transfer/add-sign/return re-round paths fire · deactivated (acted) assignments never re-fire.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import type { ApprovalTaskCreatedEventV1 } from '../../src/services/ApprovalTaskCreatedEvent'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_atc_${TS}`
const SHEET_ID = `sheet_atc_${TS}`
const CREATOR = `u_atc_creator_${TS}`
const REQUESTER = `u_atc_req_${TS}`
const APPROVER_1 = `u_atc_appr1_${TS}`
const APPROVER_2 = `u_atc_appr2_${TS}`
const TRANSFEREE = `u_atc_transferee_${TS}`
const OUTSIDER = `u_atc_out_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)
const queryFn = ((sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)) as never

let svc: AutomationService
let approvals: ApprovalProductService
let templateId = ''
const ruleIds: string[] = []
const taskEvents: ApprovalTaskCreatedEventV1[] = []
const notifications: Array<{ userIds: string[]; message: string }> = []

function approvalTemplateRequest() {
  return {
    key: `atc-${TS}`,
    name: 'approval.task_created Trigger Template',
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'First',
          config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER_1] }] },
        },
        {
          key: 'approval_2',
          type: 'approval',
          name: 'Second',
          config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER_2] }] },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval_1-approval_2', source: 'approval_1', target: 'approval_2' },
        { key: 'edge-approval_2-end', source: 'approval_2', target: 'end' },
      ],
    },
  }
}

const requesterActor = () => ({ userId: REQUESTER, userName: REQUESTER })
const approver1Actor = () => ({ userId: APPROVER_1, userName: APPROVER_1 })
const approver2Actor = () => ({ userId: APPROVER_2, userName: APPROVER_2 })

async function startApprovalInstance(): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId, formData: { summary: 'task trigger test' } },
    requesterActor(),
  )
  return (dto as { id: string }).id
}

async function executionCount(ruleId: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS count FROM multitable_automation_executions WHERE rule_id = $1', [ruleId])
  return (r.rows[0] as { count: number }).count
}

async function waitForExecutionCount(ruleId: string, expected: number, timeoutMs = 6000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = await executionCount(ruleId)
    if (count >= expected || Date.now() > deadline) return count
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describeIfDatabase('A-2a approval.task_created automation trigger (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'ATC Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'ATC Sheet'])
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read', 'Approvals Read', 'ATC test'),
              ('approvals:write', 'Approvals Write', 'ATC test'),
              ('approvals:act', 'Approvals Act', 'ATC test')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [CREATOR, REQUESTER, APPROVER_1, APPROVER_2, TRANSFEREE, OUTSIDER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
        [uid, `${uid}@atc.test`],
      )
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    for (const uid of [APPROVER_1, APPROVER_2]) {
      await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:act') ON CONFLICT DO NOTHING`, [uid])
    }

    approvals = new ApprovalProductService()
    const template = await approvals.createTemplate(approvalTemplateRequest() as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)

    integrationEventBus.subscribe('approval.task_created', (payload) => {
      taskEvents.push(payload as ApprovalTaskCreatedEventV1)
    })
    integrationEventBus.subscribe('automation.notification', (payload) => {
      notifications.push(payload as (typeof notifications)[number])
    })

    svc = new AutomationService(integrationEventBus, db as never, queryFn)
    svc.init()
  })

  afterAll(async () => {
    try { svc?.shutdown() } catch { /* noop */ }
    const instances = await q('SELECT id FROM approval_instances WHERE template_id = $1', [templateId]).catch(() => ({ rows: [] as unknown[] }))
    for (const row of instances.rows as Array<{ id: string }>) {
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
    }
    if (ruleIds.length > 0) {
      await q('DELETE FROM meta_automation_event_fires WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = ANY($1::text[])', [ruleIds]).catch(() => {})
    }
    await q('DELETE FROM approval_templates WHERE id = $1', [templateId]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER_1, APPROVER_2, TRANSFEREE, OUTSIDER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER_1, APPROVER_2, TRANSFEREE, OUTSIDER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('save gate (create + update): templateId / actions / conditions / creator legs all fail-closed', async () => {
    const base = {
      name: 'approval task rule',
      triggerType: 'approval.task_created',
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'new task' },
      createdBy: CREATOR,
    }
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: {} } as never))
      .rejects.toThrow(/templateId is required/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId: '00000000-0000-4000-8000-000000000000' } } as never))
      .rejects.toThrow(/must reference an existing approval template/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId }, actionType: 'update_record', actionConfig: { fieldId: 'x', value: 1 } } as never))
      .rejects.toThrow(/not allowed on approval.task_created rules/)
    // start_approval is structurally rejected before the allowlist (execution-mode gate, then its own
    // config validation) — any of these throws keeps it off the trigger; the allowlist itself is
    // exercised directly by the update_record case above and the update-time cases below.
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId }, actionType: 'start_approval', actionConfig: { templateId } } as never))
      .rejects.toThrow(/requires execution_mode workflow_job_v1|formDataMapping is required|not allowed on approval.task_created rules/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId }, actionType: 'delete_record', actionConfig: {} } as never))
      .rejects.toThrow(/not allowed on approval.task_created rules|delete_record/)
    await expect(svc.createRule(SHEET_ID, {
      ...base,
      triggerConfig: { templateId },
      conditions: { logic: 'and', conditions: [{ fieldId: 'x', operator: 'equals', value: 1 }] },
    } as never)).rejects.toThrow(/cannot carry conditions/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId }, createdBy: OUTSIDER } as never))
      .rejects.toThrow(/approvals:read/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId }, createdBy: null } as never))
      .rejects.toThrow(/authenticated creator/)

    // update-time resulting-shape gate: a valid rule cannot smuggle a disallowed shape via partial edits
    const rule = await svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId } } as never)
    ruleIds.push(rule.id)
    await expect(svc.updateRule(rule.id, SHEET_ID, {
      conditions: { logic: 'and', conditions: [{ fieldId: 'x', operator: 'equals', value: 1 }] },
    } as never)).rejects.toThrow(/cannot carry conditions/)
    await expect(svc.updateRule(rule.id, SHEET_ID, {
      actionType: 'update_record',
      actionConfig: { fieldId: 'x', value: 1 },
    } as never)).rejects.toThrow(/not allowed on approval.task_created rules/)
    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('fires per NEW recipient with the quad eventId; ledger claim + replay no-op; acted assignment never re-fires', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'notify on new approval task',
      triggerType: 'approval.task_created',
      triggerConfig: { templateId },
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'task for {{approval.instanceId}}' },
      createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    taskEvents.length = 0
    const instanceId = await startApprovalInstance()
    expect(await waitForExecutionCount(rule.id, 1)).toBe(1)

    // per-recipient event with the locked quad eventId
    const created = taskEvents.find((e) => e.approval.instanceId === instanceId && e.task.nodeKey === 'approval_1')
    expect(created).toBeTruthy()
    expect(created!.task.assigneeUserId).toBe(APPROVER_1)
    expect(created!.eventId).toBe(
      `approval-task:${instanceId}:approval_1:${String(created!.task.entryEpoch)}:${APPROVER_1}`,
    )
    // T2-6 ledger row carries the namespaced key
    const fire = await q('SELECT dedup_key FROM meta_automation_event_fires WHERE rule_id = $1 ORDER BY 1', [rule.id])
    expect((fire.rows as Array<{ dedup_key: string }>).some((r) => r.dedup_key === `approval.task_created:${created!.eventId}`)).toBe(true)

    // same-eventId replay → dedup no-op
    integrationEventBus.emit('approval.task_created', created!)
    await settle()
    expect(await executionCount(rule.id)).toBe(1)

    // advance: approver_1 acts — their assignment deactivates (never re-fires), approver_2's NEW task fires
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approver1Actor())
    expect(await waitForExecutionCount(rule.id, 2)).toBe(2)
    const second = taskEvents.find((e) => e.approval.instanceId === instanceId && e.task.nodeKey === 'approval_2')
    expect(second?.task.assigneeUserId).toBe(APPROVER_2)

    // return to approval_1 → fresh round (new entryEpoch) → fires again with a DIFFERENT eventId
    await approvals.dispatchAction(instanceId, { action: 'return', targetNodeKey: 'approval_1' } as never, approver2Actor())
    expect(await waitForExecutionCount(rule.id, 3)).toBe(3)
    const returned = taskEvents.filter((e) => e.approval.instanceId === instanceId && e.task.nodeKey === 'approval_1')
    // Emission is at-least-once BY CONTRACT (the T2-6 ledger is the exactly-once layer): assert two
    // DISTINCT rounds (create-round + return-round eventIds/epochs) and that any duplicate emits of
    // the same round were dedup-absorbed (execution count stayed exactly 3).
    const distinctIds = [...new Set(returned.map((e) => e.eventId))]
    expect(distinctIds.length).toBe(2)
    const epochs = [...new Set(returned.map((e) => String(e.task.entryEpoch)))]
    expect(epochs.length).toBe(2)
    expect(await executionCount(rule.id)).toBe(3)
    const returnRound = returned[returned.length - 1]
    expect(returnRound.eventId).not.toBe(returned[0].eventId)

    // transfer within the round → transferee gets a NEW task event (same epoch, different assignee)
    await approvals.dispatchAction(instanceId, { action: 'transfer', targetUserId: TRANSFEREE, comment: 'over to you' } as never, approver1Actor())
    expect(await waitForExecutionCount(rule.id, 4)).toBe(4)
    const transferred = taskEvents.find((e) => e.approval.instanceId === instanceId && e.task.assigneeUserId === TRANSFEREE)
    expect(transferred?.task.nodeKey).toBe('approval_1')
    expect(String(transferred?.task.entryEpoch)).toBe(String(returnRound.task.entryEpoch))

    // add-sign → added approver gets a NEW task event in the same round
    await approvals.dispatchAction(instanceId, { action: 'add_sign', targetUserIds: [APPROVER_2], addSignMode: 'parallel' } as never, { userId: TRANSFEREE, userName: TRANSFEREE })
    expect(await waitForExecutionCount(rule.id, 5)).toBe(5)
    const added = taskEvents.find((e) => e.approval.instanceId === instanceId && e.task.assigneeUserId === APPROVER_2 && e.task.nodeKey === 'approval_1')
    expect(added).toBeTruthy()

    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('templateId-null pending event is v1 out-of-contract: no match, no execution', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'null-template guard',
      triggerType: 'approval.task_created',
      triggerConfig: { templateId },
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'x' },
      createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)
    const before = await executionCount(rule.id)
    integrationEventBus.emit('approval.task_created', {
      version: 1,
      eventId: `approval-task:synthetic:${TS}:null:nobody`,
      eventType: 'approval.task_created',
      occurredAt: new Date().toISOString(),
      source: 'approval-product',
      approval: { instanceId: 'synthetic', requestNo: null, templateId: null, templateVersionId: null, publishedDefinitionId: null, businessKey: null, workflowKey: null },
      task: { nodeKey: 'approval_1', entryEpoch: 1, assigneeUserId: 'nobody', sourceStep: 1 },
      requester: { id: null },
    } satisfies ApprovalTaskCreatedEventV1)
    await settle()
    expect(await executionCount(rule.id)).toBe(before)
    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('post-save visibility flip = fire-skip (no hidden-template task leak)', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'scope flip guard',
      triggerType: 'approval.task_created',
      triggerConfig: { templateId },
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'x' },
      createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)
    const before = await executionCount(rule.id)
    // Flip the template out of the creator's sight AFTER save (restore the ORIGINAL value — the
    // column is NOT NULL). The engine hides a dept-scoped template from the requester too, so the
    // fire-skip leg is exercised with a well-formed SYNTHETIC event straight at the dispatch layer —
    // exactly what a still-live emitter would deliver for a now-hidden template.
    const original = await q('SELECT visibility_scope FROM approval_templates WHERE id = $1', [templateId])
    const originalScope = JSON.stringify((original.rows[0] as { visibility_scope: unknown }).visibility_scope)
    await q(`UPDATE approval_templates SET visibility_scope = '{"type":"dept","ids":["dept_never"]}'::jsonb WHERE id = $1`, [templateId])
    try {
      integrationEventBus.emit('approval.task_created', {
        version: 1,
        eventId: `approval-task:scope-flip:${TS}:1:${APPROVER_1}`,
        eventType: 'approval.task_created',
        occurredAt: new Date().toISOString(),
        source: 'approval-product',
        approval: { instanceId: 'scope-flip', requestNo: null, templateId, templateVersionId: null, publishedDefinitionId: null, businessKey: null, workflowKey: null },
        task: { nodeKey: 'approval_1', entryEpoch: 1, assigneeUserId: APPROVER_1, sourceStep: 1 },
        requester: { id: REQUESTER },
      } satisfies ApprovalTaskCreatedEventV1)
      await settle(600)
      expect(await executionCount(rule.id)).toBe(before) // fire-skip: creator can no longer see the template
    } finally {
      await q(`UPDATE approval_templates SET visibility_scope = $2::jsonb WHERE id = $1`, [templateId, originalScope])
      await svc.deleteRule(rule.id, SHEET_ID)
    }
  })
})
