import { describe, expect, it, vi } from 'vitest'
import { ApprovalBreachDingTalkChannel } from '../../src/services/breach-channels/dingtalk-channel'
import { createApprovalBreachChannelsFromEnv, type BreachMessage } from '../../src/services/breach-channels'

const VALID_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=abc123'
const VALID_SECRET = 'SECexamplesecret'

function sampleMessage(overrides: Partial<BreachMessage> = {}): BreachMessage {
  return {
    instanceId: 'inst-1',
    title: '审批超时告警 | 请假申请 | 实例 #inst-1',
    body: '- 申请人：张三\n- 启动时间：2026-04-25 08:00:00 UTC\n- SLA 阈值：24 小时',
    link: 'https://app.example.com/approval/inst-1',
    severity: 'warning',
    ...overrides,
  }
}

describe('ApprovalBreachDingTalkChannel', () => {
  it('returns ok:false when no webhook URL is configured', async () => {
    const channel = new ApprovalBreachDingTalkChannel({})
    const result = await channel.send(sampleMessage())
    expect(result.ok).toBe(false)
    expect(result.error).toBe('webhook not configured')
  })

  it('treats an invalid webhook URL as not configured', async () => {
    const channel = new ApprovalBreachDingTalkChannel({ webhookUrl: 'http://insecure.example.com/robot/send?access_token=x' })
    const result = await channel.send(sampleMessage())
    expect(result.ok).toBe(false)
    expect(result.error).toBe('webhook not configured')
  })

  it('posts a markdown payload to the signed webhook URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"errcode":0}',
    } as unknown as Response) as unknown as typeof fetch

    const channel = new ApprovalBreachDingTalkChannel({
      webhookUrl: VALID_WEBHOOK,
      secret: VALID_SECRET,
      fetchFn,
    })
    const message = sampleMessage()
    const result = await channel.send(message)

    expect(result.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = (fetchFn as any).mock.calls[0]
    expect(typeof calledUrl).toBe('string')
    expect(calledUrl).toContain('oapi.dingtalk.com/robot/send')
    expect(calledUrl).toContain('access_token=abc123')
    expect(calledUrl).toContain('timestamp=')
    expect(calledUrl).toContain('sign=')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')

    const payload = JSON.parse(init.body as string)
    expect(payload).toMatchObject({
      msgtype: 'markdown',
      markdown: {
        title: message.title,
      },
    })
    expect(payload.markdown.text).toContain(`### ${message.title}`)
    expect(payload.markdown.text).toContain(message.body)
    expect(payload.markdown.text).toContain(`[查看详情](${message.link})`)
  })

  it('returns the upstream HTTP error when DingTalk returns a non-2xx status', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Error',
      text: async () => 'boom',
    } as unknown as Response) as unknown as typeof fetch

    const channel = new ApprovalBreachDingTalkChannel({ webhookUrl: VALID_WEBHOOK, fetchFn })
    const result = await channel.send(sampleMessage())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 500')
  })

  it('treats a non-zero errcode body as a failure', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"errcode":310000,"errmsg":"keyword not in content"}',
    } as unknown as Response) as unknown as typeof fetch

    const channel = new ApprovalBreachDingTalkChannel({ webhookUrl: VALID_WEBHOOK, fetchFn })
    const result = await channel.send(sampleMessage())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('310000')
    expect(result.error).toContain('keyword not in content')
  })

  it('captures network errors without throwing', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof fetch
    const channel = new ApprovalBreachDingTalkChannel({ webhookUrl: VALID_WEBHOOK, fetchFn })
    const result = await channel.send(sampleMessage())
    expect(result.ok).toBe(false)
    expect(result.error).toBe('connect ECONNREFUSED')
  })
})

describe('createApprovalBreachChannelsFromEnv', () => {
  it('does not register noisy channels when notification env is unset', () => {
    const channels = createApprovalBreachChannelsFromEnv({})
    expect(channels).toEqual([])
  })

  it('registers DingTalk only when a webhook is configured', () => {
    const channels = createApprovalBreachChannelsFromEnv({
      APPROVAL_BREACH_DINGTALK_WEBHOOK: VALID_WEBHOOK,
      APPROVAL_BREACH_DINGTALK_SECRET: VALID_SECRET,
    })
    expect(channels.map((channel) => channel.name)).toEqual(['dingtalk'])
  })

  it('registers the email stub only when both endpoints are explicitly configured', () => {
    expect(createApprovalBreachChannelsFromEnv({ APPROVAL_BREACH_EMAIL_FROM: 'ops@example.com' })).toEqual([])
    const channels = createApprovalBreachChannelsFromEnv({
      APPROVAL_BREACH_EMAIL_FROM: 'ops@example.com',
      APPROVAL_BREACH_EMAIL_TO: 'admin@example.com',
    })
    expect(channels.map((channel) => channel.name)).toEqual(['email'])
  })
})
