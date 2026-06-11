/**
 * Real-DB W6-1 start_approval seam.
 *
 * Drives the actual chain:
 * AutomationService.executeRule(start_approval) -> ApprovalProductService.createApproval
 * -> bridge row + suspended C1 job -> ApprovalProductService.dispatchAction(approve)
 * -> approval completion event -> AutomationService continues the tail.
 *
 * This is intentionally real Postgres + real approval compile/runtime. It proves the two
 * runtimes are wired through the shared event bus and the durable bridge table, not merely
 * through hand-built fixtures.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { db } from '../../src/db/db'
import { eventBus } from '../../src/integration/events/event-bus'
import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'
import { normalizeWorkflowJob } from '../../src/multitable/workflow-job-contract'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_w6_start_${TS}`
const SHEET = `sheet_w6_start_${TS}`
const RECORD = `rec_w6_${TS}`
const REQUESTER = `w6_requester_${TS}`
const APPROVER = `w6_approver_${TS}`
const NO_APPROVAL_PERMISSION = `w6_no_approval_${TS}`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const executionIds: string[] = []
const ruleIds: string[] = []
const templateIds: string[] = []
const approvalIds: string[] = []
let templateSeq = 0

function makeAutomationService(fetchFn?: typeof fetch): AutomationService {
  const svc = new AutomationService(eventBus, db as never, q as never, fetchFn as never)
  svc.init()
  return svc
}

async function seedUsers(): Promise<void> {
  await q(
    `INSERT INTO permissions (code, name, description)
     VALUES ('approvals:write', 'Approvals Write', 'Start approvals from automation tests')
     ON CONFLICT (code) DO NOTHING`,
  )
  for (const [id, email] of [
    [REQUESTER, `${REQUESTER}@example.test`],
    [APPROVER, `${APPROVER}@example.test`],
    [NO_APPROVAL_PERMISSION, `${NO_APPROVAL_PERMISSION}@example.test`],
  ]) {
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE
          SET is_active = TRUE,
              email = EXCLUDED.email,
              name = EXCLUDED.name`,
      [id, email],
    )
  }
  await q(
    `INSERT INTO user_permissions (user_id, permission_code)
     VALUES ($1, 'approvals:write')
     ON CONFLICT DO NOTHING`,
    [REQUESTER],
  )
}

function approvalTemplateRequest() {
  templateSeq += 1
  return {
    key: `w6-start-${TS}-${templateSeq}`,
    name: 'W6 Start Approval',
    visibilityScope: { type: 'all', ids: [] },
    formSchema: {
      fields: [
        { id: 'summary', type: 'text', label: 'Summary', required: true },
      ],
    },
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

function autoApproveTemplateRequest() {
  templateSeq += 1
  return {
    key: `w6-auto-${TS}-${templateSeq}`,
    name: 'W6 Auto Approval',
    visibilityScope: { type: 'all', ids: [] },
    formSchema: {
      fields: [
        { id: 'summary', type: 'text', label: 'Summary', required: true },
      ],
    },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Auto',
          config: {
            assigneeSources: [{ kind: 'requester' }],
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

async function createPublishedTemplate(
  request: Record<string, unknown> = approvalTemplateRequest(),
  policy: Record<string, unknown> = { allowRevoke: true },
): Promise<string> {
  const approvals = new ApprovalProductService()
  const template = await approvals.createTemplate(request as never)
  templateIds.push(template.id)
  await approvals.publishTemplate(template.id, { policy } as never)
  return template.id
}

async function createStartApprovalRule(svc: AutomationService, templateId: string): Promise<string> {
  const startApproval = {
    type: 'start_approval',
    config: {
      templateId,
      formDataMapping: {
        summary: 'Record {{record.title}} needs approval',
      },
      requester: { mode: 'trigger_actor' },
    },
  } as const
  const created = await svc.createRule(SHEET, {
    name: 'W6 start approval',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'start_approval',
    actionConfig: startApproval.config,
    actions: [
      startApproval,
      { type: 'send_webhook', config: { url: 'https://example.test/w6-tail' } },
    ] as never,
    executionMode: 'workflow_job_v1',
    createdBy: REQUESTER,
  })
  ruleIds.push(created.id)
  return created.id
}

async function seedSheetRecord(title: string): Promise<void> {
  await q(
    `INSERT INTO meta_bases (id, name)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [BASE, 'W6 Base'],
  )
  await q(
    `INSERT INTO meta_sheets (id, base_id, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [SHEET, BASE, 'W6 Sheet'],
  )
  await q(
    `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
     VALUES ($1, $2, $3::jsonb, 1, $4)
     ON CONFLICT (id) DO UPDATE
        SET data = EXCLUDED.data,
            updated_at = NOW()`,
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

describeIfDatabase('multitable automation start_approval bridge (W6-1, real DB)', () => {
  beforeAll(async () => {
    await ensureApprovalSchemaReady()
    await seedUsers()
  })

  afterAll(async () => {
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
    for (const id of ruleIds) {
      await q('DELETE FROM automation_rules WHERE id = $1', [id])
    }
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET])
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE])
    for (const id of templateIds) {
      await q('DELETE FROM approval_published_definitions WHERE template_id = $1::uuid', [id])
      await q('DELETE FROM approval_template_versions WHERE template_id = $1::uuid', [id])
      await q('DELETE FROM approval_templates WHERE id = $1::uuid', [id])
    }
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[REQUESTER, APPROVER]])
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[REQUESTER, APPROVER, NO_APPROVAL_PERMISSION]])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('pending approval suspends the job, then approval.approved resumes the automation tail', async () => {
    const calls: string[] = []
    const svc = makeAutomationService((async (url: string) => {
      calls.push(url)
      return new Response('OK', { status: 200 })
    }) as never)
    try {
      const templateId = await createPublishedTemplate()
      const ruleId = await createStartApprovalRule(svc, templateId)
      await seedSheetRecord('Q4 plan')
      const execRule = {
        id: ruleId,
        name: 'W6 start approval',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [
          {
            type: 'start_approval',
            config: {
              templateId,
              formDataMapping: { summary: 'Record {{record.title}} needs approval' },
              requester: { mode: 'trigger_actor' },
            },
          },
          { type: 'send_webhook', config: { url: 'https://example.test/w6-tail' } },
        ],
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
      expect(execution.steps).toEqual([])
      expect(calls).toEqual([])

      const bridge = await q(
        `SELECT status, approval_instance_id, approval_template_id, step_index, trigger_event
           FROM multitable_automation_approval_bridges
          WHERE execution_id = $1`,
        [execution.id],
      )
      expect(bridge.rows).toHaveLength(1)
      expect(bridge.rows[0].status).toBe('pending')
      expect(bridge.rows[0].approval_instance_id).toBeTruthy()
      expect(bridge.rows[0].approval_template_id).toBe(templateId)
      expect(bridge.rows[0].step_index).toBe(0)
      expect(JSON.stringify(bridge.rows[0].trigger_event)).toContain('Q4 plan')
      approvalIds.push(bridge.rows[0].approval_instance_id)

      const jobs = await svc.jobs.listByExecution(execution.id)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({
        status: 'suspended',
        stepKey: '0',
        suspend: { reason: 'manual_task', resumeToken: bridge.rows[0].approval_instance_id },
      })
      expect(() => normalizeWorkflowJob(jobs[0])).not.toThrow()

      const approvals = new ApprovalProductService()
      const approvalAfterAction = await approvals.dispatchAction(
        bridge.rows[0].approval_instance_id,
        { action: 'approve', comment: 'go' },
        { userId: APPROVER, userName: APPROVER },
      )
      expect(approvalAfterAction.status).toBe('approved')

      const resumed = await waitForExecutionStatus(svc, execution.id, 'success')
      expect(resumed.steps.map((step) => [step.actionType, step.status])).toEqual([
        ['start_approval', 'success'],
        ['send_webhook', 'success'],
      ])
      expect(resumed.steps[0].output).toMatchObject({
        approvalInstanceId: bridge.rows[0].approval_instance_id,
        outcome: 'approved',
      })
      expect(calls).toEqual(['https://example.test/w6-tail'])

      const finalBridge = await q(
        'SELECT status, outcome, resumed_at FROM multitable_automation_approval_bridges WHERE execution_id = $1',
        [execution.id],
      )
      expect(finalBridge.rows[0]).toMatchObject({ status: 'resumed', outcome: 'approved' })
      expect(finalBridge.rows[0].resumed_at).toBeTruthy()

      const finalJobs = await svc.jobs.listByExecution(execution.id)
      expect(finalJobs.map((job) => job.status)).toEqual(['resolved', 'resolved'])
      expect(finalJobs[0].result).toMatchObject({ outcome: 'approved' })
      finalJobs.forEach((job) => expect(() => normalizeWorkflowJob(job)).not.toThrow())
    } finally {
      svc.shutdown()
    }
  })

  test('rejected approval fails the automation and does not run the tail', async () => {
    const calls: string[] = []
    const svc = makeAutomationService((async (url: string) => {
      calls.push(url)
      return new Response('OK', { status: 200 })
    }) as never)
    try {
      const templateId = await createPublishedTemplate()
      const ruleId = await createStartApprovalRule(svc, templateId)
      await seedSheetRecord('Rejected path')
      const execRule = {
        id: ruleId,
        name: 'W6 rejected approval',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [
          {
            type: 'start_approval',
            config: {
              templateId,
              formDataMapping: { summary: 'Record {{record.title}} needs approval' },
              requester: { mode: 'trigger_actor' },
            },
          },
          { type: 'send_webhook', config: { url: 'https://example.test/w6-rejected-tail' } },
        ],
        enabled: true,
        createdBy: REQUESTER,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }

      const execution = await svc.executeRule(execRule as never, {
        sheetId: SHEET,
        recordId: RECORD,
        data: { title: 'Rejected path' },
        actorId: REQUESTER,
      })
      executionIds.push(execution.id)
      const bridge = await q(
        `SELECT approval_instance_id
           FROM multitable_automation_approval_bridges
          WHERE execution_id = $1`,
        [execution.id],
      )
      approvalIds.push(bridge.rows[0].approval_instance_id)

      const approvals = new ApprovalProductService()
      const approvalAfterAction = await approvals.dispatchAction(
        bridge.rows[0].approval_instance_id,
        { action: 'reject', comment: 'no' },
        { userId: APPROVER, userName: APPROVER },
      )
      expect(approvalAfterAction.status).toBe('rejected')

      const failed = await waitForExecutionStatus(svc, execution.id, 'failed')
      expect(failed.steps).toHaveLength(2)
      expect(failed.steps[0]).toMatchObject({
        actionType: 'start_approval',
        status: 'failed',
        error: 'Approval completed with rejected',
      })
      expect(failed.steps[1]).toMatchObject({
        actionType: 'send_webhook',
        status: 'skipped',
      })
      expect(calls).toEqual([])

      const finalBridge = await q(
        'SELECT status, outcome FROM multitable_automation_approval_bridges WHERE execution_id = $1',
        [execution.id],
      )
      expect(finalBridge.rows[0]).toMatchObject({ status: 'resumed', outcome: 'rejected' })

      const jobs = await svc.jobs.listByExecution(execution.id)
      expect(jobs).toHaveLength(2)
      expect(jobs[0]).toMatchObject({ status: 'failed', error: 'Approval completed with rejected' })
      expect(jobs[1]).toMatchObject({ status: 'skipped' })
      jobs.forEach((job) => expect(() => normalizeWorkflowJob(job)).not.toThrow())
    } finally {
      svc.shutdown()
    }
  })

  test('retry is allowed after createApproval fails before any approval instance exists', async () => {
    const svc = makeAutomationService()
    try {
      const missingTemplateId = `00000000-0000-4000-8000-${String(TS).slice(-12).padStart(12, '0')}`
      const created = await svc.createRule(SHEET, {
        name: 'W6 missing approval template',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'start_approval',
        actionConfig: {
          templateId: missingTemplateId,
          formDataMapping: { summary: 'Record {{record.title}} needs approval' },
          requester: { mode: 'trigger_actor' },
        },
        actions: [
          {
            type: 'start_approval',
            config: {
              templateId: missingTemplateId,
              formDataMapping: { summary: 'Record {{record.title}} needs approval' },
              requester: { mode: 'trigger_actor' },
            },
          },
          { type: 'send_webhook', config: { url: 'https://example.test/w6-missing-template-tail' } },
        ] as never,
        executionMode: 'workflow_job_v1',
        createdBy: REQUESTER,
      })
      ruleIds.push(created.id)
      await seedSheetRecord('Missing template')

      const execution = await svc.executeRule({
        id: created.id,
        name: 'W6 missing approval template',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: created.actions,
        enabled: true,
        createdBy: REQUESTER,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      } as never, {
        sheetId: SHEET,
        recordId: RECORD,
        data: { title: 'Missing template' },
        actorId: REQUESTER,
      })
      executionIds.push(execution.id)
      expect(execution.status).toBe('failed')

      const failedBridge = await q(
        `SELECT status, approval_instance_id, idempotency_key
           FROM multitable_automation_approval_bridges
          WHERE execution_id = $1`,
        [execution.id],
      )
      expect(failedBridge.rows).toHaveLength(1)
      expect(failedBridge.rows[0]).toMatchObject({ status: 'failed', approval_instance_id: null })

      const retry = await svc.retryExecution(execution.id, REQUESTER)
      expect('execution' in retry).toBe(true)
      if (!('execution' in retry)) throw new Error(`retry was rejected: ${JSON.stringify(retry)}`)
      executionIds.push(retry.execution.id)
      expect(retry.execution.status).toBe('failed')

      const retryBridge = await q(
        `SELECT status, approval_instance_id, idempotency_key
           FROM multitable_automation_approval_bridges
          WHERE execution_id = $1`,
        [retry.execution.id],
      )
      expect(retryBridge.rows).toHaveLength(1)
      expect(retryBridge.rows[0]).toMatchObject({ status: 'failed', approval_instance_id: null })
      expect(retryBridge.rows[0].idempotency_key).toBe(failedBridge.rows[0].idempotency_key)
    } finally {
      svc.shutdown()
    }
  })

  test('retry lineage guard blocks re-running a root after a child retry creates an approval', async () => {
    const svc = makeAutomationService()
    try {
      const templateId = await createPublishedTemplate()
      const ruleId = await createStartApprovalRule(svc, templateId)
      await seedSheetRecord('Retry root')
      const rootId = `axe_w6_root_${TS}`
      await svc.logs.record({
        id: rootId,
        ruleId,
        triggeredBy: 'event',
        triggeredAt: new Date().toISOString(),
        status: 'failed',
        steps: [{ actionType: 'send_webhook', status: 'failed', error: 'seed failure', durationMs: 1 }],
        error: 'seed failure',
        sheetId: SHEET,
        triggerEvent: {
          sheetId: SHEET,
          recordId: RECORD,
          data: { title: 'Retry root' },
          actorId: REQUESTER,
        },
      })
      executionIds.push(rootId)

      const firstRetry = await svc.retryExecution(rootId, REQUESTER)
      expect('execution' in firstRetry).toBe(true)
      if (!('execution' in firstRetry)) throw new Error('retry did not create execution')
      executionIds.push(firstRetry.execution.id)
      expect(firstRetry.execution.status).toBe('running')

      const bridge = await q(
        `SELECT root_execution_id, approval_instance_id
           FROM multitable_automation_approval_bridges
          WHERE execution_id = $1`,
        [firstRetry.execution.id],
      )
      expect(bridge.rows).toHaveLength(1)
      expect(bridge.rows[0].root_execution_id).toBe(rootId)
      approvalIds.push(bridge.rows[0].approval_instance_id)

      const secondRetry = await svc.retryExecution(rootId, REQUESTER)
      expect(secondRetry).toMatchObject({
        status: 409,
        code: 'START_APPROVAL_ALREADY_CREATED',
      })
    } finally {
      svc.shutdown()
    }
  })

  test('requester without approvals:write fails closed before creating approval or bridge rows', async () => {
    const calls: string[] = []
    const svc = makeAutomationService((async (url: string) => {
      calls.push(url)
      return new Response('OK', { status: 200 })
    }) as never)
    try {
      const templateId = await createPublishedTemplate()
      const ruleId = await createStartApprovalRule(svc, templateId)
      await seedSheetRecord('No approval permission')
      const execRule = {
        id: ruleId,
        name: 'W6 permission denied',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [
          {
            type: 'start_approval',
            config: {
              templateId,
              formDataMapping: { summary: 'Record {{record.title}} needs approval' },
              requester: { mode: 'trigger_actor' },
            },
          },
          { type: 'send_webhook', config: { url: 'https://example.test/w6-denied-tail' } },
        ],
        enabled: true,
        createdBy: REQUESTER,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }

      const execution = await svc.executeRule(execRule as never, {
        sheetId: SHEET,
        recordId: RECORD,
        data: { title: 'No approval permission' },
        actorId: NO_APPROVAL_PERMISSION,
      })
      executionIds.push(execution.id)

      expect(execution.status).toBe('failed')
      expect(execution.error).toContain('start_approval requester lacks approvals:write')
      expect(execution.steps).toEqual([])
      expect(calls).toEqual([])

      const bridges = await q(
        `SELECT id FROM multitable_automation_approval_bridges WHERE execution_id = $1`,
        [execution.id],
      )
      expect(bridges.rows).toHaveLength(0)
      const approvals = await q(
        `SELECT id FROM approval_instances WHERE template_id = $1::uuid`,
        [templateId],
      )
      expect(approvals.rows).toHaveLength(0)
    } finally {
      svc.shutdown()
    }
  })

  test('bridge keeps approval id and fails execution when suspended job finalization fails', async () => {
    const svc = makeAutomationService()
    const writeSuspendedSpy = vi
      .spyOn(svc.jobs, 'writeSuspendedJob')
      .mockRejectedValueOnce(new Error('job write failed'))
    try {
      const templateId = await createPublishedTemplate()
      const ruleId = await createStartApprovalRule(svc, templateId)
      await seedSheetRecord('Bridge finalization')
      const execRule = {
        id: ruleId,
        name: 'W6 bridge finalization failure',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [
          {
            type: 'start_approval',
            config: {
              templateId,
              formDataMapping: { summary: 'Record {{record.title}} needs approval' },
              requester: { mode: 'trigger_actor' },
            },
          },
          { type: 'send_webhook', config: { url: 'https://example.test/w6-finalization-tail' } },
        ],
        enabled: true,
        createdBy: REQUESTER,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }

      const execution = await svc.executeRule(execRule as never, {
        sheetId: SHEET,
        recordId: RECORD,
        data: { title: 'Bridge finalization' },
        actorId: REQUESTER,
      })
      executionIds.push(execution.id)

      expect(writeSuspendedSpy).toHaveBeenCalledOnce()
      expect(execution.status).toBe('failed')
      expect(execution.error).toContain('job write failed')
      expect(execution.steps).toEqual([])

      const bridge = await q(
        `SELECT status, approval_instance_id
           FROM multitable_automation_approval_bridges
          WHERE execution_id = $1`,
        [execution.id],
      )
      expect(bridge.rows).toHaveLength(1)
      expect(bridge.rows[0].status).toBe('failed')
      expect(bridge.rows[0].approval_instance_id).toBeTruthy()
      approvalIds.push(bridge.rows[0].approval_instance_id)

      const jobs = await svc.jobs.listByExecution(execution.id)
      expect(jobs).toEqual([])
    } finally {
      writeSuspendedSpy.mockRestore()
      svc.shutdown()
    }
  })

  test('resumed wait_for_callback tail can create a pending start_approval bridge', async () => {
    const calls: string[] = []
    const svc = makeAutomationService((async (url: string) => {
      calls.push(url)
      return new Response('OK', { status: 200 })
    }) as never)
    try {
      const templateId = await createPublishedTemplate()
      const waitAction = { type: 'wait_for_callback', config: {} } as const
      const startApproval = {
        type: 'start_approval',
        config: {
          templateId,
          formDataMapping: {
            summary: 'Record {{record.title}} needs approval after wait',
          },
          requester: { mode: 'trigger_actor' },
        },
      } as const
      const tailAction = { type: 'send_webhook', config: { url: 'https://example.test/w6-wait-approval-tail' } } as const
      const created = await svc.createRule(SHEET, {
        name: 'W6 wait then start approval',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'wait_for_callback',
        actionConfig: waitAction.config,
        actions: [waitAction, startApproval, tailAction] as never,
        executionMode: 'workflow_job_v1',
        createdBy: REQUESTER,
      })
      ruleIds.push(created.id)
      await seedSheetRecord('Wait then approval')

      const execRule = {
        id: created.id,
        name: 'W6 wait then start approval',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [waitAction, startApproval, tailAction],
        enabled: true,
        createdBy: REQUESTER,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }

      const execution = await svc.executeRule(execRule as never, {
        sheetId: SHEET,
        recordId: RECORD,
        data: { title: 'Wait then approval' },
        actorId: REQUESTER,
      })
      executionIds.push(execution.id)
      expect(execution.status).toBe('running')

      const suspension = await q(
        `SELECT resume_token
           FROM multitable_automation_suspensions
          WHERE execution_id = $1`,
        [execution.id],
      )
      expect(suspension.rows).toHaveLength(1)

      const resumed = await svc.resumeExecution(suspension.rows[0].resume_token, REQUESTER)
      expect('execution' in resumed).toBe(true)
      if (!('execution' in resumed)) throw new Error(`resume failed: ${resumed.code}`)
      expect(resumed.execution.status).toBe('running')
      expect(calls).toEqual([])

      const bridge = await q(
        `SELECT status, root_execution_id, approval_instance_id, step_index
           FROM multitable_automation_approval_bridges
          WHERE execution_id = $1`,
        [execution.id],
      )
      expect(bridge.rows).toHaveLength(1)
      expect(bridge.rows[0]).toMatchObject({
        status: 'pending',
        root_execution_id: execution.id,
        step_index: 1,
      })
      expect(bridge.rows[0].approval_instance_id).toBeTruthy()
      approvalIds.push(bridge.rows[0].approval_instance_id)

      const jobsAfterResume = await svc.jobs.listByExecution(execution.id)
      expect(jobsAfterResume.map((job) => job.status)).toEqual(['resolved', 'suspended'])
      jobsAfterResume.forEach((job) => expect(() => normalizeWorkflowJob(job)).not.toThrow())

      const approvals = new ApprovalProductService()
      await approvals.dispatchAction(
        bridge.rows[0].approval_instance_id,
        { action: 'approve', comment: 'resume tail' },
        { userId: APPROVER, userName: APPROVER },
      )

      const completed = await waitForExecutionStatus(svc, execution.id, 'success')
      expect(completed.steps.map((step) => [step.actionType, step.status])).toEqual([
        ['wait_for_callback', 'success'],
        ['start_approval', 'success'],
        ['send_webhook', 'success'],
      ])
      expect(calls).toEqual(['https://example.test/w6-wait-approval-tail'])
    } finally {
      svc.shutdown()
    }
  })

  test('auto-approved approvals continue immediately without missing the create-time completion event', async () => {
    const calls: string[] = []
    const svc = makeAutomationService((async (url: string) => {
      calls.push(url)
      return new Response('OK', { status: 200 })
    }) as never)
    try {
      const templateId = await createPublishedTemplate(autoApproveTemplateRequest() as never, {
        allowRevoke: true,
        autoApproval: { mergeWithRequester: true },
      })
      const ruleId = await createStartApprovalRule(svc, templateId)
      const execRule = {
        id: ruleId,
        name: 'W6 auto approval',
        sheetId: SHEET,
        trigger: { type: 'record.created', config: {} },
        actions: [
          {
            type: 'start_approval',
            config: {
              templateId,
              formDataMapping: { summary: 'Record {{record.title}} needs approval' },
              requester: { mode: 'trigger_actor' },
            },
          },
          { type: 'send_webhook', config: { url: 'https://example.test/w6-auto-tail' } },
        ],
        enabled: true,
        createdBy: REQUESTER,
        createdAt: new Date(TS).toISOString(),
        executionMode: 'workflow_job_v1',
      }

      const execution = await svc.executeRule(execRule as never, {
        sheetId: SHEET,
        recordId: '',
        data: { title: 'Auto path' },
        actorId: REQUESTER,
      })
      executionIds.push(execution.id)

      expect(execution.status).toBe('success')
      expect(execution.steps.map((step) => [step.actionType, step.status])).toEqual([
        ['start_approval', 'success'],
        ['send_webhook', 'success'],
      ])
      expect(calls).toEqual(['https://example.test/w6-auto-tail'])

      const bridge = await q(
        `SELECT status, outcome, approval_instance_id
           FROM multitable_automation_approval_bridges
          WHERE execution_id = $1`,
        [execution.id],
      )
      expect(bridge.rows).toHaveLength(1)
      expect(bridge.rows[0]).toMatchObject({ status: 'resumed', outcome: 'approved' })
      approvalIds.push(bridge.rows[0].approval_instance_id)

      const jobs = await svc.jobs.listByExecution(execution.id)
      expect(jobs.map((job) => job.status)).toEqual(['resolved', 'resolved'])
      jobs.forEach((job) => expect(() => normalizeWorkflowJob(job)).not.toThrow())
    } finally {
      svc.shutdown()
    }
  })
})
