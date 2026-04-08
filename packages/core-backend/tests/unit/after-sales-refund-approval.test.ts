import { describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = require('../../../../plugins/plugin-after-sales/lib/refund-approval.cjs') as {
  REFUND_APPROVAL_BRIDGE_ID: string
  buildRefundApprovalCommand: (input: Record<string, unknown>) => Record<string, unknown>
  getRefundApproval: (context: Record<string, unknown>, input: Record<string, unknown>) => Promise<unknown>
  submitRefundApproval: (context: Record<string, unknown>, input: Record<string, unknown>) => Promise<unknown>
  submitRefundApprovalDecision: (context: Record<string, unknown>, input: Record<string, unknown>) => Promise<unknown>
}

describe('after-sales refund approval adapter', () => {
  it('builds a stable refund approval command', () => {
    const command = adapter.buildRefundApprovalCommand({
      projectId: 'tenant_42:after-sales',
      ticketId: 'ticket_001',
      ticketNo: 'TK-1001',
      title: 'Refund request for damaged part',
      requesterId: 'user_42',
      requesterName: 'Alice',
      refundAmount: 88.5,
      reason: 'Part arrived damaged',
    })

    expect(command).toMatchObject({
      bridge: 'after-sales-refund',
      sourceSystem: 'after-sales',
      topic: 'ticket.refundRequested',
      businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
      requester: {
        id: 'user_42',
        name: 'Alice',
      },
      subject: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        refundAmount: 88.5,
      },
      policy: {
        sourceOfTruth: 'after-sales',
        rejectCommentRequired: true,
      },
    })
  })

  it('throws a validation error when required fields are missing', () => {
    expect(() => adapter.buildRefundApprovalCommand({
      ticketId: 'ticket_001',
      refundAmount: 99,
    })).toThrow(/projectId is required/)
  })

  it('forwards the approval command through the plugin communication seam', async () => {
    const call = vi.fn(async (_plugin: string, _method: string, command: Record<string, unknown>) => ({
      ok: true,
      bridge: command.bridge,
    }))

    const result = await adapter.submitRefundApproval(
      {
        communication: {
          call,
        },
      },
      {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Refund request',
        requesterId: 'user_42',
        refundAmount: 99,
      },
    )

    expect(call).toHaveBeenCalledWith(
      'after-sales-approval-bridge',
      'submitRefundApproval',
      expect.objectContaining({
        bridge: adapter.REFUND_APPROVAL_BRIDGE_ID,
        businessKey: 'after-sales:tenant_42:after-sales:ticket:ticket_001:refund',
        subject: expect.objectContaining({
          ticketId: 'ticket_001',
          ticketNo: 'TK-1001',
        }),
      }),
    )
    expect(result).toEqual({
      ok: true,
      bridge: adapter.REFUND_APPROVAL_BRIDGE_ID,
    })
  })

  it('queries refund approval status through the plugin communication seam', async () => {
    const call = vi.fn(async (_plugin: string, _method: string, payload: Record<string, unknown>) => ({
      ok: true,
      approvalId: 'approval_001',
      payload,
    }))

    const result = await adapter.getRefundApproval(
      {
        communication: {
          call,
        },
      },
      {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
      },
    )

    expect(call).toHaveBeenCalledWith(
      'after-sales-approval-bridge',
      'getRefundApproval',
      {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        businessKey: undefined,
      },
    )
    expect(result).toEqual({
      ok: true,
      approvalId: 'approval_001',
      payload: {
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        businessKey: undefined,
      },
    })
  })

  it('submits refund approval decisions through the plugin communication seam', async () => {
    const call = vi.fn(async (_plugin: string, _method: string, payload: Record<string, unknown>) => ({
      ok: true,
      decision: 'approved',
      payload,
    }))

    const result = await adapter.submitRefundApprovalDecision(
      {
        communication: {
          call,
        },
      },
      {
        ticketId: 'ticket_001',
        action: 'approve',
        actorId: 'finance_1',
        actorName: 'Finance One',
        comment: 'approved',
      },
    )

    expect(call).toHaveBeenCalledWith(
      'after-sales-approval-bridge',
      'submitRefundApprovalDecision',
      {
        ticketId: 'ticket_001',
        businessKey: undefined,
        action: 'approve',
        actorId: 'finance_1',
        actorName: 'Finance One',
        comment: 'approved',
      },
    )
    expect(result).toEqual({
      ok: true,
      decision: 'approved',
      payload: {
        ticketId: 'ticket_001',
        businessKey: undefined,
        action: 'approve',
        actorId: 'finance_1',
        actorName: 'Finance One',
        comment: 'approved',
      },
    })
  })
})
