import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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
