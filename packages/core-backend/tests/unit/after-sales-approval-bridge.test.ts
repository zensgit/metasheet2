import { describe, expect, it, vi } from 'vitest'

import {
  AfterSalesApprovalBridgeService,
  AFTER_SALES_NO_VIEWER,
  REFUND_WORKFLOW_KEY,
  toAfterSalesApprovalSummary,
  type AfterSalesRefundApprovalCommand,
  type AfterSalesRefundApprovalCallbacks,
  type AfterSalesRefundApprovalDecisionInput,
} from '../../src/services/AfterSalesApprovalBridgeService'
import type { UnifiedApprovalDTO } from '../../src/services/approval-bridge-types'

type ApprovalInstanceRow = {
  id: string
  status: string
  source_system: string
  workflow_key: string
  business_key: string
  title: string
  requester_snapshot: Record<string, unknown>
  subject_snapshot: Record<string, unknown>
  policy_snapshot: Record<string, unknown>
  metadata: Record<string, unknown>
  current_step: number
  total_steps: number
}

type ApprovalAssignmentRow = {
  instance_id: string
  assignment_type: string
  assignee_id: string
  source_step: number
  node_key: string | null
  is_active: boolean
  metadata: Record<string, unknown>
}

type ApprovalDto = {
  id: string
  sourceSystem: string
  externalApprovalId: string | null
  workflowKey: string
  businessKey: string
  title: string
  status: string
  requester: Record<string, unknown> | null
  subject: Record<string, unknown> | null
  policy: Record<string, unknown> | null
  currentStep: number
  totalSteps: number
  assignments: Array<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

function createCommand(overrides: Partial<AfterSalesRefundApprovalCommand> = {}): AfterSalesRefundApprovalCommand {
  return {
    bridge: REFUND_WORKFLOW_KEY,
    sourceSystem: 'after-sales',
    topic: 'ticket.refundRequested',
    title: 'Refund approval for TK-1001',
    businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
    requester: {
      id: 'user_42',
      name: 'Alice',
    },
    subject: {
      projectId: 'tenant_42:after-sales',
      ticketId: 'ticket_001',
      ticketNo: 'TK-1001',
      title: 'Refund request',
      refundAmount: 99,
      currency: 'CNY',
    },
    policy: {
      sourceOfTruth: 'after-sales',
      rejectCommentRequired: true,
    },
    metadata: {
      projectId: 'tenant_42:after-sales',
      ticketId: 'ticket_001',
    },
    assignmentRoles: ['finance', 'supervisor'],
    ...overrides,
  }
}

function createDbFixture(existingPendingId?: string) {
  const instances: ApprovalInstanceRow[] = []
  const assignments: ApprovalAssignmentRow[] = []

  const rootQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('SELECT id FROM approval_instances')) {
      if (normalized.includes("status = 'pending'")) {
        if (existingPendingId) {
          return { rows: [{ id: existingPendingId }], rowCount: 1 }
        }
        const [, businessKey] = params as [string, string]
        const row = instances.find(
          (item) =>
            item.workflow_key === REFUND_WORKFLOW_KEY &&
            item.business_key === businessKey &&
            item.status === 'pending',
        )
        return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
      }
      const [, selector] = params as [string, string]
      const row = instances.find(
        (item) =>
          item.workflow_key === REFUND_WORKFLOW_KEY &&
          (item.id === selector ||
            item.business_key === selector ||
            item.subject_snapshot?.ticketId === selector ||
            item.metadata?.ticketId === selector),
      )
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
    }
    throw new Error(`Unhandled root query: ${normalized}`)
  })

  const txQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('INSERT INTO approval_instances')) {
      const [
        id,
        sourceSystem,
        workflowKey,
        businessKey,
        title,
        requesterSnapshot,
        subjectSnapshot,
        policySnapshot,
        metadata,
        totalSteps,
      ] = params as [string, string, string, string, string, string, string, string, string, number]
      instances.push({
        id,
        status: 'pending',
        source_system: sourceSystem,
        workflow_key: workflowKey,
        business_key: businessKey,
        title,
        requester_snapshot: JSON.parse(requesterSnapshot),
        subject_snapshot: JSON.parse(subjectSnapshot),
        policy_snapshot: JSON.parse(policySnapshot),
        metadata: JSON.parse(metadata),
        current_step: 1,
        total_steps: totalSteps,
      })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('INSERT INTO approval_assignments')) {
      const [instanceId, assigneeId, sourceStep, nodeKey, metadata] = params as [string, string, number, string, string]
      assignments.push({
        instance_id: instanceId,
        assignment_type: 'role',
        assignee_id: assigneeId,
        source_step: sourceStep,
        node_key: nodeKey,
        is_active: true,
        metadata: JSON.parse(metadata),
      })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('UPDATE approval_assignments')) {
      const [instanceId, assigneeId, sourceStep, metadata] = params as [string, string, number, string]
      let updated = 0
      for (const assignment of assignments) {
        if (
          assignment.instance_id === instanceId
          && assignment.assignment_type === 'role'
          && assignment.assignee_id === assigneeId
          && assignment.is_active
        ) {
          assignment.source_step = sourceStep
          assignment.is_active = true
          assignment.metadata = JSON.parse(metadata)
          updated += 1
        }
      }
      return { rows: [], rowCount: updated }
    }
    throw new Error(`Unhandled transaction query: ${normalized}`)
  })

  return {
    db: {
      query: rootQuery,
      connect: vi.fn(async () => ({
        query: txQuery,
        release: vi.fn(),
      })),
    },
    instances,
    assignments,
    rootQuery,
    txQuery,
  }
}

function createApprovalDto(id: string, status: string = 'pending'): ApprovalDto {
  return {
    id,
    sourceSystem: 'after-sales',
    externalApprovalId: null,
    workflowKey: REFUND_WORKFLOW_KEY,
    businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
    title: 'Refund approval for TK-1001',
    status,
    requester: { id: 'user_42', name: 'Alice' },
    subject: {
      projectId: 'tenant_42:after-sales',
      ticketId: 'ticket_001',
      ticketNo: 'TK-1001',
      title: 'Refund request',
      refundAmount: 99,
      currency: 'CNY',
    },
    policy: { sourceOfTruth: 'after-sales' },
    currentStep: 1,
    totalSteps: 2,
    assignments: [],
    createdAt: '2026-04-07T00:00:00.000Z',
    updatedAt: '2026-04-07T00:00:00.000Z',
  }
}

describe('AfterSalesApprovalBridgeService', () => {
  it('creates a local after-sales refund approval and role assignments', async () => {
    const fixture = createDbFixture()
    const getApproval = vi.fn(async (approvalId: string) => ({
      id: approvalId,
      sourceSystem: 'after-sales',
      externalApprovalId: null,
      workflowKey: REFUND_WORKFLOW_KEY,
      businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      title: 'Refund approval for TK-1001',
      status: 'pending',
      requester: { id: 'user_42', name: 'Alice' },
      subject: { ticketId: 'ticket_001', refundAmount: 99 },
      policy: { sourceOfTruth: 'after-sales' },
      currentStep: 1,
      totalSteps: 2,
      assignments: [],
      createdAt: '2026-04-07T00:00:00.000Z',
      updatedAt: '2026-04-07T00:00:00.000Z',
    }))

    const service = new AfterSalesApprovalBridgeService(
      fixture.db as never,
      { getApproval } as never,
    )

    const result = await service.submitRefundApproval(createCommand())

    expect(result.created).toBe(true)
    expect(result.approvalId).toMatch(/^afs:/)
    // Explicit no-viewer sentinel — never omit viewerUserId (would be ambiguous).
    expect(getApproval).toHaveBeenCalledWith(result.approvalId, AFTER_SALES_NO_VIEWER)
    expect(result.approval).toMatchObject({
      id: result.approvalId,
      status: 'pending',
      subject: expect.objectContaining({ ticketId: 'ticket_001' }),
    })
    // Plugin return is the narrow summary — no form surface.
    expect(result.approval).not.toHaveProperty('formSnapshot')
    expect(result.approval).not.toHaveProperty('formSchema')
    expect(JSON.stringify(result.approval)).not.toContain('formSnapshot')
    expect(fixture.instances).toHaveLength(1)
    expect(fixture.instances[0]).toMatchObject({
      source_system: 'after-sales',
      workflow_key: REFUND_WORKFLOW_KEY,
      business_key: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      current_step: 1,
      total_steps: 2,
    })
    expect(fixture.assignments).toEqual([
      expect.objectContaining({
        instance_id: result.approvalId,
        assignee_id: 'finance',
        source_step: 1,
        is_active: true,
      }),
      expect.objectContaining({
        instance_id: result.approvalId,
        assignee_id: 'supervisor',
        source_step: 2,
        is_active: true,
      }),
    ])
  })

  it('reuses an existing pending approval for the same business key', async () => {
    const fixture = createDbFixture('afs:existing')
    const getApproval = vi.fn(async () => ({
      id: 'afs:existing',
      sourceSystem: 'after-sales',
      externalApprovalId: null,
      workflowKey: REFUND_WORKFLOW_KEY,
      businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      title: 'Refund approval for TK-1001',
      status: 'pending',
      requester: { id: 'user_42' },
      subject: { ticketId: 'ticket_001' },
      policy: {},
      currentStep: 1,
      totalSteps: 2,
      assignments: [],
      createdAt: '2026-04-07T00:00:00.000Z',
      updatedAt: '2026-04-07T00:00:00.000Z',
    }))

    const service = new AfterSalesApprovalBridgeService(
      fixture.db as never,
      { getApproval } as never,
    )

    const result = await service.submitRefundApproval(createCommand())

    expect(result).toMatchObject({
      created: false,
      approvalId: 'afs:existing',
    })
    expect(fixture.db.connect).not.toHaveBeenCalled()
    expect(fixture.instances).toHaveLength(0)
  })

  it('loads a refund approval status by ticket id', async () => {
    const fixture = createDbFixture()
    fixture.instances.push({
      id: 'afs:lookup',
      status: 'pending',
      source_system: 'after-sales',
      workflow_key: REFUND_WORKFLOW_KEY,
      business_key: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      title: 'Refund approval for TK-1001',
      requester_snapshot: { id: 'user_42', name: 'Alice' },
      subject_snapshot: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Refund request',
        refundAmount: 99,
        currency: 'CNY',
      },
      policy_snapshot: { sourceOfTruth: 'after-sales' },
      metadata: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
      },
      current_step: 1,
      total_steps: 2,
    })

    const getApproval = vi.fn(async (approvalId: string) => createApprovalDto(approvalId))
    const service = new AfterSalesApprovalBridgeService(
      fixture.db as never,
      { getApproval } as never,
    )

    const approval = await service.getRefundApproval('ticket_001')

    expect(approval).toMatchObject({
      id: 'afs:lookup',
      status: 'pending',
      businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
    })
    expect(getApproval).toHaveBeenCalledWith('afs:lookup', AFTER_SALES_NO_VIEWER)
    expect(approval).not.toHaveProperty('formSnapshot')
    expect(approval).not.toHaveProperty('formSchema')
  })

  it('P2: plugin/callback summary never serializes recordId / formSnapshot / formSchema', async () => {
    // Construct a full UnifiedApprovalDTO as if the instance already used a record-link form
    // AND a legacy/malformed subject_snapshot carrying leak keys. Plugin only gets the closed
    // AfterSalesRefundSubjectSummary — prove leak fields cannot appear even on subject.
    const fullDto: UnifiedApprovalDTO = {
      id: 'afs:leak-probe',
      sourceSystem: 'after-sales',
      externalApprovalId: null,
      workflowKey: REFUND_WORKFLOW_KEY,
      businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      title: 'Refund with linked record',
      status: 'approved',
      requester: { id: 'user_42', name: 'Alice' },
      subject: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Refund request',
        refundAmount: 99,
        currency: 'CNY',
        // Malformed extras that a wholesale subject spread would leak:
        recordId: 'rec-secret-in-subject',
        formSnapshot: { nested: { recordId: 'nested-secret' } },
        extraNested: { formSchema: { fields: [] }, recordId: 'extra-secret' },
      } as UnifiedApprovalDTO['subject'],
      policy: { sourceOfTruth: 'after-sales' },
      currentStep: 2,
      totalSteps: 2,
      formSnapshot: {
        linked: { recordId: 'rec-secret-should-not-leak' },
        note: 'ok',
      },
      formSchema: {
        fields: [{
          id: 'linked',
          type: 'record-link',
          label: '关联',
          props: { baseId: 'base-1', sheetId: 'sheet-1' },
        }],
      },
      assignments: [{
        id: 'asg-1',
        type: 'role',
        assigneeId: 'finance',
        sourceStep: 1,
        isActive: true,
        metadata: {},
      }],
      createdAt: '2026-04-07T00:00:00.000Z',
      updatedAt: '2026-04-07T01:00:00.000Z',
    }

    const summary = toAfterSalesApprovalSummary(fullDto)
    const summaryJson = JSON.stringify(summary)

    expect(summary).toEqual({
      id: 'afs:leak-probe',
      sourceSystem: 'after-sales',
      workflowKey: REFUND_WORKFLOW_KEY,
      businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      title: 'Refund with linked record',
      status: 'approved',
      subject: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Refund request',
        refundAmount: 99,
        currency: 'CNY',
      },
      currentStep: 2,
      totalSteps: 2,
      updatedAt: '2026-04-07T01:00:00.000Z',
    })
    // Closed subject: exactly the six named fields — no open index / spread residue.
    expect(Object.keys(summary.subject ?? {}).sort()).toEqual([
      'currency',
      'projectId',
      'refundAmount',
      'ticketId',
      'ticketNo',
      'title',
    ])
    expect(summaryJson).not.toContain('recordId')
    expect(summaryJson).not.toContain('rec-secret-should-not-leak')
    expect(summaryJson).not.toContain('rec-secret-in-subject')
    expect(summaryJson).not.toContain('nested-secret')
    expect(summaryJson).not.toContain('extra-secret')
    expect(summaryJson).not.toContain('formSnapshot')
    expect(summaryJson).not.toContain('formSchema')
    expect(summaryJson).not.toContain('extraNested')
    expect(summary).not.toHaveProperty('formSnapshot')
    expect(summary).not.toHaveProperty('formSchema')
    expect(summary).not.toHaveProperty('requester')
    expect(summary).not.toHaveProperty('assignments')
    expect(summary).not.toHaveProperty('policy')

    // End-to-end: getRefundApproval / decision callbacks receive only the summary.
    const fixture = createDbFixture()
    fixture.instances.push({
      id: 'afs:leak-probe',
      status: 'pending',
      source_system: 'after-sales',
      workflow_key: REFUND_WORKFLOW_KEY,
      business_key: fullDto.businessKey!,
      title: fullDto.title!,
      requester_snapshot: { id: 'user_42' },
      subject_snapshot: fullDto.subject as Record<string, unknown>,
      policy_snapshot: {},
      metadata: { ticketId: 'ticket_001' },
      current_step: 1,
      total_steps: 2,
    })

    const getApproval = vi.fn(async () => fullDto)
    const dispatchAction = vi.fn(async () => fullDto)
    const onDecision = vi.fn(async () => undefined)
    const onApproved = vi.fn(async () => undefined)

    const service = new AfterSalesApprovalBridgeService(
      fixture.db as never,
      { getApproval, dispatchAction } as never,
      { onDecision, onApproved },
    )

    const loaded = await service.getRefundApproval({ approvalId: 'afs:leak-probe' })
    expect(getApproval).toHaveBeenCalledWith('afs:leak-probe', AFTER_SALES_NO_VIEWER)
    const loadedJson = JSON.stringify(loaded)
    expect(loadedJson).not.toContain('recordId')
    expect(loadedJson).not.toContain('rec-secret-should-not-leak')
    expect(loadedJson).not.toContain('rec-secret-in-subject')
    expect(loadedJson).not.toContain('formSnapshot')
    expect(loadedJson).not.toContain('formSchema')
    expect(loadedJson).not.toContain('extraNested')
    expect(loaded?.subject).toEqual({
      projectId: 'tenant_42:after-sales',
      ticketId: 'ticket_001',
      ticketNo: 'TK-1001',
      title: 'Refund request',
      refundAmount: 99,
      currency: 'CNY',
    })

    await service.submitRefundApprovalDecision({
      approvalId: 'afs:leak-probe',
      action: 'approve',
      actorId: 'finance_1',
    })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onApproved).toHaveBeenCalledTimes(1)
    const cbApproval = onDecision.mock.calls[0][0]
    const cbJson = JSON.stringify(cbApproval)
    expect(cbJson).not.toContain('recordId')
    expect(cbJson).not.toContain('rec-secret-should-not-leak')
    expect(cbJson).not.toContain('rec-secret-in-subject')
    expect(cbJson).not.toContain('formSnapshot')
    expect(cbJson).not.toContain('formSchema')
    expect(cbJson).not.toContain('extraNested')
    expect(cbApproval).toMatchObject({
      id: 'afs:leak-probe',
      status: 'approved',
      subject: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Refund request',
        refundAmount: 99,
        currency: 'CNY',
      },
    })
    expect(Object.keys(cbApproval.subject ?? {}).sort()).toEqual([
      'currency',
      'projectId',
      'refundAmount',
      'ticketId',
      'ticketNo',
      'title',
    ])
  })

  it('dispatches an approved refund decision and invokes the approved callback', async () => {
    const fixture = createDbFixture()
    fixture.instances.push({
      id: 'afs:decision',
      status: 'pending',
      source_system: 'after-sales',
      workflow_key: REFUND_WORKFLOW_KEY,
      business_key: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      title: 'Refund approval for TK-1001',
      requester_snapshot: { id: 'user_42', name: 'Alice' },
      subject_snapshot: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Refund request',
        refundAmount: 99,
        currency: 'CNY',
      },
      policy_snapshot: { sourceOfTruth: 'after-sales' },
      metadata: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
      },
      current_step: 1,
      total_steps: 2,
    })

    const approval = createApprovalDto('afs:decision', 'approved')
    const dispatchAction = vi.fn(async () => approval)
    const onDecision = vi.fn(async () => undefined)
    const onApproved = vi.fn(async () => undefined)
    const onRejected = vi.fn(async () => undefined)

    const service = new AfterSalesApprovalBridgeService(
      fixture.db as never,
      { getApproval: vi.fn(), dispatchAction } as never,
      {
        onDecision,
        onApproved,
        onRejected,
      } satisfies AfterSalesRefundApprovalCallbacks,
    )

    const result = await service.submitRefundApprovalDecision({
      ticketId: 'ticket_001',
      action: 'approve',
      actorId: 'finance_1',
      actorName: 'Finance One',
      comment: 'approved',
    })

    expect(dispatchAction).toHaveBeenCalledWith(
      'afs:decision',
      {
        action: 'approve',
        comment: 'approved',
      },
      expect.objectContaining({
        userId: 'finance_1',
        userName: 'Finance One',
      }),
    )
    const expectedSummary = toAfterSalesApprovalSummary(approval as never)
    expect(onDecision).toHaveBeenCalledWith(
      expectedSummary,
      expect.objectContaining({
        ticketId: 'ticket_001',
        action: 'approve',
        actorId: 'finance_1',
      }),
    )
    expect(onApproved).toHaveBeenCalledWith(
      expectedSummary,
      expect.objectContaining({
        ticketId: 'ticket_001',
        action: 'approve',
        actorId: 'finance_1',
      }),
    )
    expect(onRejected).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      approvalId: 'afs:decision',
      decision: 'approved',
      approval: expectedSummary,
    })
    expect(JSON.stringify(result.approval)).not.toContain('formSnapshot')
  })

  it('dispatches a rejected refund decision and invokes the rejected callback', async () => {
    const fixture = createDbFixture()
    fixture.instances.push({
      id: 'afs:decision-reject',
      status: 'pending',
      source_system: 'after-sales',
      workflow_key: REFUND_WORKFLOW_KEY,
      business_key: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      title: 'Refund approval for TK-1001',
      requester_snapshot: { id: 'user_42', name: 'Alice' },
      subject_snapshot: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Refund request',
        refundAmount: 99,
        currency: 'CNY',
      },
      policy_snapshot: { sourceOfTruth: 'after-sales' },
      metadata: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
      },
      current_step: 1,
      total_steps: 2,
    })

    const approval = createApprovalDto('afs:decision-reject', 'rejected')
    const dispatchAction = vi.fn(async () => approval)
    const onDecision = vi.fn(async () => undefined)
    const onApproved = vi.fn(async () => undefined)
    const onRejected = vi.fn(async () => undefined)

    const service = new AfterSalesApprovalBridgeService(
      fixture.db as never,
      { getApproval: vi.fn(), dispatchAction } as never,
      {
        onDecision,
        onApproved,
        onRejected,
      } satisfies AfterSalesRefundApprovalCallbacks,
    )

    const result = await service.submitRefundApprovalDecision({
      businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      action: 'reject',
      actorId: 'finance_1',
      comment: 'not enough evidence',
    })

    expect(dispatchAction).toHaveBeenCalledWith(
      'afs:decision-reject',
      {
        action: 'reject',
        comment: 'not enough evidence',
      },
      expect.objectContaining({
        userId: 'finance_1',
        userName: undefined,
      }),
    )
    const expectedRejectSummary = toAfterSalesApprovalSummary(approval as never)
    expect(onDecision).toHaveBeenCalledWith(
      expectedRejectSummary,
      expect.objectContaining({
        businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
        action: 'reject',
        actorId: 'finance_1',
      }),
    )
    expect(onRejected).toHaveBeenCalledWith(
      expectedRejectSummary,
      expect.objectContaining({
        businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
        action: 'reject',
        actorId: 'finance_1',
      }),
    )
    expect(onApproved).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      approvalId: 'afs:decision-reject',
      decision: 'rejected',
      approval: expectedRejectSummary,
    })
  })
})
