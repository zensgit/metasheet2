import { describe, expect, it, vi } from 'vitest'

import {
  AfterSalesApprovalBridgeService,
  REFUND_WORKFLOW_KEY,
  type AfterSalesRefundApprovalCommand,
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
})
