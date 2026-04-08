import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DingTalkNotificationChannel,
  NotificationServiceImpl,
} from '../../src/services/NotificationService'

describe('DingTalk notification channel', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('sends markdown payloads through the dingtalk channel', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    })
    global.fetch = fetchMock as typeof fetch

    const service = new NotificationServiceImpl()
    const result = await service.send({
      channel: 'dingtalk',
      subject: 'Build Alert',
      content: 'Pipeline completed with warnings.',
      recipients: [
        {
          id: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
          type: 'webhook',
        },
      ],
    })

    expect(result.status).toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: {
            title: 'Build Alert',
            text: '### Build Alert\n\nPipeline completed with warnings.',
          },
        }),
      }),
    )
  })

  it('signs dingtalk webhook urls when a secret is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    })
    global.fetch = fetchMock as typeof fetch
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000)

    const service = new NotificationServiceImpl()
    service.registerChannel(new DingTalkNotificationChannel({ secret: 'secret-123' }))

    const result = await service.send({
      channel: 'dingtalk',
      subject: 'Ops Alert',
      content: 'Latency exceeds threshold.',
      recipients: [
        {
          id: 'https://oapi.dingtalk.com/robot/send?access_token=robot-token',
          type: 'group',
        },
      ],
    })

    expect(result.status).toBe('sent')
    const requestUrl = String(fetchMock.mock.calls[0]?.[0] ?? '')
    const parsed = new URL(requestUrl)
    expect(parsed.searchParams.get('access_token')).toBe('robot-token')
    expect(parsed.searchParams.get('timestamp')).toBe('1760000000000')
    expect(parsed.searchParams.get('sign')).toBeTruthy()
  })
})
