import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDingTalkWorkNotificationRuntimeStatus,
  readDingTalkMessageConfig,
  sendDingTalkWorkNotification,
} from '../../src/integrations/dingtalk/client'

describe('dingtalk work notification client', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('requires an agent id when reading work notification config', () => {
    vi.stubEnv('DINGTALK_APP_KEY', 'dt-app-key')
    vi.stubEnv('DINGTALK_APP_SECRET', 'dt-app-secret')

    expect(() => readDingTalkMessageConfig()).toThrow('DINGTALK_AGENT_ID or DINGTALK_NOTIFY_AGENT_ID is not configured')
  })

  it('reports redaction-safe work notification runtime status', () => {
    vi.stubEnv('DINGTALK_APP_KEY', 'dt-app-key')
    vi.stubEnv('DINGTALK_APP_SECRET', 'dt-app-secret')

    expect(getDingTalkWorkNotificationRuntimeStatus()).toEqual({
      configured: false,
      available: false,
      unavailableReason: 'missing_agent_id',
      requirements: {
        appKey: {
          configured: true,
          selectedKey: 'DINGTALK_APP_KEY',
        },
        appSecret: {
          configured: true,
          selectedKey: 'DINGTALK_APP_SECRET',
        },
        agentId: {
          configured: false,
          selectedKey: null,
        },
        baseUrl: {
          configured: false,
          selectedKey: null,
        },
      },
    })
  })

  it('reports legacy alias readiness for work notification runtime status', () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'dt-client-id')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'dt-client-secret')
    vi.stubEnv('DINGTALK_NOTIFY_AGENT_ID', '987654321')
    vi.stubEnv('DINGTALK_BASE_URL', 'https://oapi.dingtalk.com')

    const status = getDingTalkWorkNotificationRuntimeStatus()

    expect(status.configured).toBe(true)
    expect(status.available).toBe(true)
    expect(status.unavailableReason).toBeNull()
    expect(status.requirements.appKey.selectedKey).toBe('DINGTALK_CLIENT_ID')
    expect(status.requirements.appSecret.selectedKey).toBe('DINGTALK_CLIENT_SECRET')
    expect(status.requirements.agentId.selectedKey).toBe('DINGTALK_NOTIFY_AGENT_ID')
    expect(status.requirements.baseUrl.selectedKey).toBe('DINGTALK_BASE_URL')
    expect(JSON.stringify(status)).not.toContain('dt-client-secret')
  })

  it('sends work notifications to DingTalk user ids', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        task_id: 778899,
        request_id: 'req_1',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendDingTalkWorkNotification(
      'app-access-token',
      {
        userIds: ['dt-user-1', 'dt-user-2'],
        title: 'Ticket rec_1 ready',
        content: 'Please review the latest changes.',
      },
      {
        appKey: 'dt-app-key',
        appSecret: 'dt-app-secret',
        agentId: '123456789',
      },
    )

    expect(result.taskId).toBe('778899')
    expect(result.requestId).toBe('req_1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/topapi/message/corpconversation/asyncsend_v2?access_token=app-access-token')
    const payload = JSON.parse(String(init.body))
    expect(payload.agent_id).toBe(123456789)
    expect(payload.userid_list).toBe('dt-user-1,dt-user-2')
    expect(payload.msg.markdown.title).toBe('Ticket rec_1 ready')
    expect(payload.msg.markdown.text).toContain('Please review the latest changes.')
  })
})
