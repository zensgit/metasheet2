import { describe, expect, it, vi } from 'vitest'

import {
  AfterSalesApprovalBridgeService,
  REFUND_WORKFLOW_KEY,
  type AfterSalesRefundApprovalCommand,
  type AfterSalesRefundApprovalCallbacks,
  type AfterSalesRefundApprovalDecisionInput,
} from '../../src/services/AfterSalesApprovalBridgeService'

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
      const [instanceId, assigneeId, sourceStep, metadata] = params as [string, string, number, string]
      assignments.push({
        instance_id: instanceId,
        assignment_type: 'role',
        assignee_id: assigneeId,
        source_step: sourceStep,
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
    expect(getApproval).toHaveBeenCalledWith(result.approvalId)
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
    expect(getApproval).toHaveBeenCalledWith('afs:lookup')
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
    expect(onDecision).toHaveBeenCalledWith(
      approval,
      expect.objectContaining({
        ticketId: 'ticket_001',
        action: 'approve',
        actorId: 'finance_1',
      }),
    )
    expect(onApproved).toHaveBeenCalledWith(
      approval,
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
    })
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
    expect(onDecision).toHaveBeenCalledWith(
      approval,
      expect.objectContaining({
        businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
        action: 'reject',
        actorId: 'finance_1',
      }),
    )
    expect(onRejected).toHaveBeenCalledWith(
      approval,
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
    })
  })
})
