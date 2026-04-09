import { describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = require('../../../../plugins/plugin-after-sales/lib/workflow-adapter.cjs') as {
  computeSlaDueAt: (priority: string, config: Record<string, unknown>, now?: Date) => string
  createWorkflowRuntime: (context: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, (payload?: Record<string, unknown>) => Promise<unknown>>
  registerAfterSalesWorkflowHandlers: (context: Record<string, unknown>, options?: Record<string, unknown>) => {
    subscriptions: string[]
  }
}

function createContext(queryImpl?: (sql: string, params?: unknown[]) => Promise<unknown[]>) {
  return {
    api: {
      database: {
        query: vi.fn(queryImpl || (async () => [])),
      },
      events: {
        emit: vi.fn(),
        on: vi.fn((eventName: string) => `sub:${eventName}`),
        off: vi.fn(),
      },
    },
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  }
}

describe('after-sales workflow adapter', () => {
  it('computes SLA due time from template defaults and urgent override', () => {
    const now = new Date('2026-04-07T00:00:00.000Z')

    expect(
      adapter.computeSlaDueAt('normal', { defaultSlaHours: 24, urgentSlaHours: 4 }, now),
    ).toBe('2026-04-08T00:00:00.000Z')
    expect(
      adapter.computeSlaDueAt('urgent', { defaultSlaHours: 24, urgentSlaHours: 4 }, now),
    ).toBe('2026-04-07T04:00:00.000Z')
  })

  it('ticket-triage emits ticket.assigned with computed SLA and resolved assignee', async () => {
    const context = createContext()
    const runtime = adapter.createWorkflowRuntime(context, {
      loadCurrent: vi.fn(async () => ({
        status: 'installed',
        projectId: 'tenant_42:after-sales',
        config: {
          defaultSlaHours: 24,
          urgentSlaHours: 4,
          enableRefundApproval: true,
        },
      })),
      now: () => new Date('2026-04-07T00:00:00.000Z'),
    })

    const result = await runtime.onTicketCreated({
      tenantId: 'tenant_42',
      ticketNo: 'TK-1001',
      title: 'Broken compressor',
      ticket: {
        id: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
        assigneeCandidates: [
          { id: 'tech_001', type: 'user', supervisor: { id: 'lead_001', type: 'user' } },
        ],
      },
    })

    expect(context.api.events.emit).toHaveBeenCalledWith(
      'ticket.assigned',
      expect.objectContaining({
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        ticketNo: 'TK-1001',
        ticket: expect.objectContaining({
          assignedTo: 'tech_001',
          assignedSupervisor: 'lead_001',
          slaDueAt: '2026-04-07T04:00:00.000Z',
        }),
      }),
    )
    expect(result).toEqual(
      expect.objectContaining({
        workflowId: 'ticket-triage',
        emittedEvent: 'ticket.assigned',
      }),
    )
  })

  it('refund-approval submits bridge command and emits approval.pending', async () => {
    const context = createContext()
    const submitRefundApproval = vi.fn(async () => ({
      created: true,
      approvalId: 'afs:1',
      approval: {
        id: 'afs:1',
        title: 'Refund approval for TK-1001',
        assignments: [],
      },
    }))

    const runtime = adapter.createWorkflowRuntime(context, {
      loadCurrent: vi.fn(async () => ({
        status: 'installed',
        projectId: 'tenant_42:after-sales',
        config: {
          enableRefundApproval: true,
          defaultSlaHours: 24,
          urgentSlaHours: 4,
        },
      })),
      submitRefundApproval,
    })

    const result = await runtime.onTicketRefundRequested({
      tenantId: 'tenant_42',
      ticket: {
        id: 'ticket_001',
        ticketNo: 'TK-1001',
        title: 'Refund request for damaged part',
        requestedBy: 'user_42',
        requestedByName: 'Alice',
        refundAmount: 88.5,
      },
    })

    expect(submitRefundApproval).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        ticketNo: 'TK-1001',
        requesterId: 'user_42',
        requesterName: 'Alice',
        refundAmount: 88.5,
      }),
    )
    expect(context.api.events.emit).toHaveBeenCalledWith(
      'approval.pending',
      expect.objectContaining({
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        approval: expect.objectContaining({
          id: 'afs:1',
          bridge: 'after-sales-refund',
          ticketId: 'ticket_001',
        }),
      }),
    )
    expect(result).toEqual(
      expect.objectContaining({
        workflowId: 'refund-approval',
      }),
    )
  })

  it('resolves supervisor and finance role recipients before sending notifications', async () => {
    const context = createContext(async () => [
      { role_id: 'supervisor', user_id: 'lead_001', email: 'lead@example.com' },
      { role_id: 'finance', user_id: 'fin_001', email: 'finance@example.com' },
    ])
    const sendTopicNotification = vi.fn(async () => [{ status: 'sent' }])
    const runtime = adapter.createWorkflowRuntime(context, {
      sendTopicNotification,
    })

    await runtime.onTicketAssigned({
      ticketNo: 'TK-1001',
      ticket: {
        assignedTo: 'tech_001',
        assignedSupervisor: 'lead_001',
      },
    })

    await runtime.onServiceRecorded({
      serviceRecord: {
        id: 'sr_001',
        ticketNo: 'TK-1001',
      },
    })

    await runtime.onApprovalPending({
      approval: {
        id: 'afs:1',
      },
      ticket: {
        id: 'ticket_001',
      },
    })

    await runtime.onTicketOverdue({
      ticketNo: 'TK-1001',
      ticket: {
        id: 'ticket_001',
        assignedTo: 'tech_001',
        assignedSupervisor: 'lead_001',
      },
      overdueWebhook: {
        id: 'https://hooks.example.com/after-sales-overdue',
        type: 'webhook',
      },
    })

    await runtime.onFollowUpDue({
      ticketNo: 'TK-1001',
      followUpOwner: {
        id: 'owner_001',
        type: 'user',
      },
    })

    expect(sendTopicNotification).toHaveBeenNthCalledWith(
      1,
      context,
      expect.objectContaining({
        topic: 'after-sales.ticket.assigned',
        roleRecipients: {
          supervisor: [
            { id: 'lead_001', type: 'user' },
            { id: 'lead@example.com', type: 'email' },
          ],
        },
      }),
    )
    expect(sendTopicNotification).toHaveBeenNthCalledWith(
      2,
      context,
      expect.objectContaining({
        topic: 'after-sales.service.recorded',
        payload: expect.objectContaining({
          ticketNo: 'TK-1001',
        }),
        roleRecipients: {
          supervisor: [
            { id: 'lead_001', type: 'user' },
            { id: 'lead@example.com', type: 'email' },
          ],
        },
      }),
    )
    expect(sendTopicNotification).toHaveBeenNthCalledWith(
      3,
      context,
      expect.objectContaining({
        topic: 'after-sales.approval.pending',
        roleRecipients: {
          finance: [
            { id: 'fin_001', type: 'user' },
            { id: 'finance@example.com', type: 'email' },
          ],
          supervisor: [
            { id: 'lead_001', type: 'user' },
            { id: 'lead@example.com', type: 'email' },
          ],
        },
      }),
    )
    expect(sendTopicNotification).toHaveBeenNthCalledWith(
      4,
      context,
      expect.objectContaining({
        topic: 'after-sales.ticket.overdue',
        roleRecipients: {
          supervisor: [
            { id: 'lead_001', type: 'user' },
            { id: 'lead@example.com', type: 'email' },
          ],
        },
      }),
    )
    expect(sendTopicNotification).toHaveBeenNthCalledWith(
      5,
      context,
      expect.objectContaining({
        topic: 'after-sales.followup.due',
        roleRecipients: {},
      }),
    )
  })

  it('registers the seven v1 workflow event handlers', () => {
    const context = createContext()

    const result = adapter.registerAfterSalesWorkflowHandlers(context)

    expect(context.api.events.on).toHaveBeenCalledWith('ticket.created', expect.any(Function))
    expect(context.api.events.on).toHaveBeenCalledWith('ticket.assigned', expect.any(Function))
    expect(context.api.events.on).toHaveBeenCalledWith('service.recorded', expect.any(Function))
    expect(context.api.events.on).toHaveBeenCalledWith('ticket.overdue', expect.any(Function))
    expect(context.api.events.on).toHaveBeenCalledWith('ticket.refundRequested', expect.any(Function))
    expect(context.api.events.on).toHaveBeenCalledWith('approval.pending', expect.any(Function))
    expect(context.api.events.on).toHaveBeenCalledWith('followup.due', expect.any(Function))
    expect(result.subscriptions).toEqual([
      'sub:ticket.created',
      'sub:ticket.assigned',
      'sub:service.recorded',
      'sub:ticket.overdue',
      'sub:ticket.refundRequested',
      'sub:approval.pending',
      'sub:followup.due',
    ])
  })
})
