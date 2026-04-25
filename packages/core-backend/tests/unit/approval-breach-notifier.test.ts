import { describe, expect, it, vi } from 'vitest'
import { ApprovalBreachNotifier } from '../../src/services/ApprovalBreachNotifier'
import type { ApprovalBreachContext } from '../../src/services/ApprovalMetricsService'
import type { BreachNotificationChannel } from '../../src/services/breach-channels'

function ctx(id: string, overrides: Partial<ApprovalBreachContext> = {}): ApprovalBreachContext {
  return {
    instanceId: id,
    templateId: 'tmpl-1',
    templateName: '请假申请',
    currentNodeKey: 'manager',
    requesterName: '张三',
    startedAt: '2026-04-25T08:00:00Z',
    slaHours: 24,
    breachedAt: '2026-04-26T08:00:00Z',
    ...overrides,
  }
}

function makeMetrics(contexts: ApprovalBreachContext[] = []) {
  const listBreachContextByIds = vi.fn().mockResolvedValue(contexts)
  const markBreachNotified = vi.fn().mockResolvedValue(undefined)
  return {
    metrics: { listBreachContextByIds, markBreachNotified } as any,
    listBreachContextByIds,
    markBreachNotified,
  }
}

describe('ApprovalBreachNotifier', () => {
  it('returns an empty result when no ids are supplied', async () => {
    const channel: BreachNotificationChannel = {
      name: 'noop',
      send: vi.fn().mockResolvedValue({ ok: true }),
    }
    const { metrics, listBreachContextByIds } = makeMetrics()
    const notifier = new ApprovalBreachNotifier({ channels: [channel], metrics })
    const result = await notifier.notifyBreaches([])
    expect(result.requested).toBe(0)
    expect(result.notified).toBe(0)
    expect(listBreachContextByIds).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('dispatches each instance to every configured channel in parallel', async () => {
    const dingtalkSend = vi.fn().mockResolvedValue({ ok: true })
    const emailSend = vi.fn().mockResolvedValue({ ok: true })
    const channels: BreachNotificationChannel[] = [
      { name: 'dingtalk', send: dingtalkSend },
      { name: 'email', send: emailSend },
    ]
    const { metrics } = makeMetrics([ctx('inst-1'), ctx('inst-2')])
    const notifier = new ApprovalBreachNotifier({
      channels,
      metrics,
      appBaseUrl: 'https://app.example.com',
      now: () => new Date('2026-04-26T10:00:00Z'),
    })

    const result = await notifier.notifyBreaches(['inst-1', 'inst-2'])

    expect(dingtalkSend).toHaveBeenCalledTimes(2)
    expect(emailSend).toHaveBeenCalledTimes(2)
    expect(result.requested).toBe(2)
    expect(result.notified).toBe(2)
    expect(result.sent).toBe(4)
    expect(result.failed).toBe(0)
    expect(result.perChannel).toEqual([
      { channel: 'dingtalk', sent: 2, failed: 0, errors: [] },
      { channel: 'email', sent: 2, failed: 0, errors: [] },
    ])
    const firstMessage = dingtalkSend.mock.calls[0][0]
    expect(firstMessage.title).toContain('审批超时告警')
    expect(firstMessage.title).toContain('请假申请')
    expect(firstMessage.body).toContain('张三')
    expect(firstMessage.body).toContain('manager')
    expect(firstMessage.link).toBe('https://app.example.com/approval/inst-1')
  })

  it('isolates channel failures so siblings still dispatch', async () => {
    const flaky: BreachNotificationChannel = {
      name: 'dingtalk',
      send: vi.fn().mockRejectedValue(new Error('webhook 5xx')),
    }
    const healthy: BreachNotificationChannel = {
      name: 'email',
      send: vi.fn().mockResolvedValue({ ok: true }),
    }
    const { metrics } = makeMetrics([ctx('inst-1')])
    const notifier = new ApprovalBreachNotifier({ channels: [flaky, healthy], metrics })

    const result = await notifier.notifyBreaches(['inst-1'])

    expect(flaky.send).toHaveBeenCalledTimes(1)
    expect(healthy.send).toHaveBeenCalledTimes(1)
    expect(result.notified).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    const dingtalkBucket = result.perChannel.find((entry) => entry.channel === 'dingtalk')
    expect(dingtalkBucket?.failed).toBe(1)
    expect(dingtalkBucket?.errors).toEqual(['webhook 5xx'])
  })

  it('treats `ok:false` channel responses as failures without throwing', async () => {
    const channel: BreachNotificationChannel = {
      name: 'dingtalk',
      send: vi.fn().mockResolvedValue({ ok: false, error: 'webhook not configured' }),
    }
    const { metrics } = makeMetrics([ctx('inst-1')])
    const notifier = new ApprovalBreachNotifier({ channels: [channel], metrics })
    const result = await notifier.notifyBreaches(['inst-1'])
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.notified).toBe(0)
    expect(result.perChannel[0].errors).toEqual(['webhook not configured'])
  })

  it('persists dedupe via markBreachNotified after at-least-one-channel success', async () => {
    const channel: BreachNotificationChannel = {
      name: 'dingtalk',
      send: vi.fn().mockResolvedValue({ ok: true }),
    }
    const { metrics, markBreachNotified } = makeMetrics([ctx('inst-1'), ctx('inst-2')])
    const notifier = new ApprovalBreachNotifier({
      channels: [channel],
      metrics,
      now: () => new Date('2026-04-26T10:00:00Z'),
    })

    const result = await notifier.notifyBreaches(['inst-1', 'inst-2'])
    expect(result.notified).toBe(2)
    expect(channel.send).toHaveBeenCalledTimes(2)
    expect(markBreachNotified).toHaveBeenCalledTimes(1)
    const [ids, when] = markBreachNotified.mock.calls[0]
    expect(ids).toEqual(['inst-1', 'inst-2'])
    expect(when.toISOString()).toBe('2026-04-26T10:00:00.000Z')
  })

  it('does not call markBreachNotified when every channel fails for an instance', async () => {
    const channel: BreachNotificationChannel = {
      name: 'dingtalk',
      send: vi.fn().mockResolvedValue({ ok: false, error: 'webhook 5xx' }),
    }
    const { metrics, markBreachNotified } = makeMetrics([ctx('inst-1')])
    const notifier = new ApprovalBreachNotifier({ channels: [channel], metrics })

    const result = await notifier.notifyBreaches(['inst-1'])
    expect(result.notified).toBe(0)
    expect(result.failed).toBe(1)
    expect(markBreachNotified).not.toHaveBeenCalled()
  })

  it('marks only the instances whose channels reported at least one success', async () => {
    const channel: BreachNotificationChannel = {
      name: 'dingtalk',
      send: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: 'fail-once' })
        .mockResolvedValueOnce({ ok: true }),
    }
    const { metrics, markBreachNotified } = makeMetrics([ctx('inst-1'), ctx('inst-2')])
    const notifier = new ApprovalBreachNotifier({ channels: [channel], metrics })

    const result = await notifier.notifyBreaches(['inst-1', 'inst-2'])
    expect(result.notified).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    expect(markBreachNotified).toHaveBeenCalledTimes(1)
    expect(markBreachNotified.mock.calls[0][0]).toEqual(['inst-2'])
  })

  it('mixed-channel partial success still marks the instance as notified', async () => {
    const goodSend = vi.fn().mockResolvedValue({ ok: true })
    const badSend = vi.fn().mockResolvedValue({ ok: false, error: 'down' })
    const { metrics, markBreachNotified } = makeMetrics([ctx('inst-1')])
    const notifier = new ApprovalBreachNotifier({
      channels: [
        { name: 'dingtalk', send: badSend },
        { name: 'email', send: goodSend },
      ],
      metrics,
    })

    const result = await notifier.notifyBreaches(['inst-1'])
    expect(result.notified).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    expect(markBreachNotified).toHaveBeenCalledTimes(1)
    expect(markBreachNotified.mock.calls[0][0]).toEqual(['inst-1'])
  })

  it('does not throw when listBreachContextByIds rejects, and skips marking', async () => {
    const channel: BreachNotificationChannel = {
      name: 'dingtalk',
      send: vi.fn().mockResolvedValue({ ok: true }),
    }
    const { metrics, markBreachNotified } = makeMetrics()
    metrics.listBreachContextByIds = vi.fn().mockRejectedValue(new Error('db down'))
    const notifier = new ApprovalBreachNotifier({ channels: [channel], metrics })

    const result = await notifier.notifyBreaches(['inst-1', 'inst-2'])
    expect(result.requested).toBe(2)
    expect(result.skipped).toBe(2)
    expect(result.notified).toBe(0)
    expect(channel.send).not.toHaveBeenCalled()
    expect(markBreachNotified).not.toHaveBeenCalled()
  })

  it('swallows markBreachNotified failures so the notifier still resolves cleanly', async () => {
    const channel: BreachNotificationChannel = {
      name: 'dingtalk',
      send: vi.fn().mockResolvedValue({ ok: true }),
    }
    const { metrics, markBreachNotified } = makeMetrics([ctx('inst-1')])
    markBreachNotified.mockRejectedValueOnce(new Error('db blip'))
    const notifier = new ApprovalBreachNotifier({ channels: [channel], metrics })

    const result = await notifier.notifyBreaches(['inst-1'])
    expect(result.notified).toBe(1)
    expect(result.sent).toBe(1)
    expect(markBreachNotified).toHaveBeenCalledTimes(1)
  })

  it('returns a graceful empty result when no channels are configured', async () => {
    const { metrics, listBreachContextByIds } = makeMetrics()
    const notifier = new ApprovalBreachNotifier({ channels: [], metrics })
    const result = await notifier.notifyBreaches(['inst-1'])
    expect(result.requested).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.notified).toBe(0)
    expect(listBreachContextByIds).not.toHaveBeenCalled()
  })

  it('still composes a usable message when context lookup returns nothing', async () => {
    const channel: BreachNotificationChannel = {
      name: 'dingtalk',
      send: vi.fn().mockResolvedValue({ ok: true }),
    }
    const { metrics } = makeMetrics([])
    const notifier = new ApprovalBreachNotifier({ channels: [channel], metrics, appBaseUrl: 'https://app.example.com' })
    const result = await notifier.notifyBreaches(['orphan-1'])
    expect(result.notified).toBe(1)
    const message = (channel.send as any).mock.calls[0][0]
    expect(message.title).toContain('审批超时告警')
    expect(message.title).toContain('未命名模板')
    expect(message.body).toContain('未知申请人')
    expect(message.body).toContain('未知节点')
    expect(message.link).toBe('https://app.example.com/approval/orphan-1')
  })
})
