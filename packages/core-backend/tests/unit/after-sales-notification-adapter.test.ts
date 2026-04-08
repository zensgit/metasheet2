import { describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = require('../../../../plugins/plugin-after-sales/lib/notification-adapter.cjs') as {
  CHANNEL_TO_RECIPIENT_TYPE: Record<string, string>
  getNotificationTopicSpecs: () => Array<Record<string, unknown>>
  buildNotificationsForTopic: (input: Record<string, unknown>) => Array<Record<string, unknown>>
  sendTopicNotification: (context: Record<string, unknown>, input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
}

describe('after-sales notification adapter', () => {
  it('exposes the fixed channel-to-recipient mapping', () => {
    expect(adapter.CHANNEL_TO_RECIPIENT_TYPE).toEqual({
      feishu: 'user',
      email: 'email',
      webhook: 'webhook',
    })
  })

  it('publishes the four v1 notification topic specs', () => {
    expect(adapter.getNotificationTopicSpecs()).toHaveLength(4)
    expect(adapter.getNotificationTopicSpecs()).toContainEqual(
      expect.objectContaining({
        topic: 'after-sales.approval.pending',
        event: 'approval.pending',
        channels: ['feishu', 'email'],
      }),
    )
  })

  it('builds per-channel notifications with recipient filtering and dedupe', () => {
    const requests = adapter.buildNotificationsForTopic({
      topic: 'after-sales.ticket.overdue',
      payload: {
        title: 'Ticket overdue',
        ticketNo: 'TK-1001',
        assignedTo: { id: 'user_1', type: 'user' },
        assignedSupervisor: { id: 'lead@example.com', type: 'email' },
        overdueWebhook: { id: 'https://example.test/hooks/after-sales', type: 'webhook' },
      },
      roleRecipients: {
        supervisor: [
          { id: 'user_1', type: 'user' },
          { id: 'lead@example.com', type: 'email' },
        ],
      },
    })

    expect(requests).toHaveLength(3)
    expect(requests.find((entry) => entry.channel === 'feishu')?.notification.recipients).toEqual([
      { id: 'user_1', type: 'user' },
    ])
    expect(requests.find((entry) => entry.channel === 'email')?.notification.recipients).toEqual([
      { id: 'lead@example.com', type: 'email' },
    ])
    expect(requests.find((entry) => entry.channel === 'webhook')?.notification.recipients).toEqual([
      { id: 'https://example.test/hooks/after-sales', type: 'webhook' },
    ])
  })

  it('sends one notification per resolved channel', async () => {
    const send = vi.fn(async (notification: Record<string, unknown>) => ({
      id: `sent:${String(notification.channel)}`,
      status: 'sent',
    }))

    const result = await adapter.sendTopicNotification(
      {
        services: {
          notification: {
            send,
          },
        },
      },
      {
        topic: 'after-sales.approval.pending',
        payload: {
          subject: 'Refund approval pending',
        },
        roleRecipients: {
          finance: [{ id: 'finance@example.com', type: 'email' }],
          supervisor: [{ id: 'user_42', type: 'user' }],
        },
      },
    )

    expect(send).toHaveBeenCalledTimes(2)
    expect(result).toEqual([
      expect.objectContaining({
        topic: 'after-sales.approval.pending',
        channel: 'feishu',
        result: expect.objectContaining({ status: 'sent' }),
      }),
      expect.objectContaining({
        topic: 'after-sales.approval.pending',
        channel: 'email',
        result: expect.objectContaining({ status: 'sent' }),
      }),
    ])
  })
})
