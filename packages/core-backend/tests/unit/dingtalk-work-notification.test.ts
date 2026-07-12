import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDingTalkWorkNotificationRuntimeStatus,
  readDingTalkMessageConfig,
  sendDingTalkInteractiveApprovalCard,
  sendDingTalkWorkNotification,
  updateDingTalkInteractiveApprovalCard,
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

  it('B-2 sends the official create-and-deliver shape and returns the carrier id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        outTrackId: 'delivery-1',
        deliverResults: [{
          success: true,
          spaceType: 'IM_ROBOT',
          spaceId: 'dt-user-1',
          carrierId: 'carrier-1',
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendDingTalkInteractiveApprovalCard(
      'app-access-token',
      {
        userId: 'dt-user-1',
        robotCode: 'ding-app-key',
        cardTemplateId: 'template-1',
        outTrackId: 'delivery-1',
        title: '审批待办：差旅申请',
        requestNo: 'REQ-1',
        nodeName: '部门审批',
        statusText: '等待你处理',
        rejectUrl: 'https://ms.example.test/m/approval-decision?d=delivery-1&t=token',
      },
      { openApiBaseUrl: 'https://api.dingtalk.test/' },
    )

    expect(result.taskId).toBe('carrier-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.dingtalk.test/v1.0/card/instances/createAndDeliver')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': 'app-access-token',
    })
    expect(JSON.parse(String(init.body))).toEqual({
      userId: 'dt-user-1',
      userIdType: 1,
      cardTemplateId: 'template-1',
      outTrackId: 'delivery-1',
      callbackType: 'STREAM',
      callbackRouteKey: 'approval_card',
      cardData: {
        cardParamMap: {
          title: '审批待办：差旅申请',
          requestNo: 'REQ-1',
          nodeName: '部门审批',
          statusText: '等待你处理',
          approveText: '同意',
          rejectText: '驳回',
          rejectUrl: 'https://ms.example.test/m/approval-decision?d=delivery-1&t=token',
        },
      },
      openSpaceId: 'dtv1.card//IM_ROBOT.dt-user-1',
      imRobotOpenSpaceModel: { supportForward: false },
      imRobotOpenDeliverModel: { robotCode: 'ding-app-key', spaceType: 'IM_ROBOT' },
    })
  })

  it('B-2 fails closed when create-and-deliver returns HTTP 200 with a failed delivery', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        outTrackId: 'delivery-1',
        deliverResults: [{ success: false, errorMsg: 'template unpublished' }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendDingTalkInteractiveApprovalCard(
      'app-access-token',
      {
        userId: 'dt-user-1',
        robotCode: 'ding-app-key',
        cardTemplateId: 'template-1',
        outTrackId: 'delivery-1',
        title: '审批待办',
        nodeName: '审批',
        statusText: '等待你处理',
        rejectUrl: 'https://ms.example.test/m/approval-decision?d=delivery-1&t=token',
      },
    )).rejects.toThrow('template unpublished')
  })

  it('B-2 fails closed on top-level success=false even when nested delivery looks successful', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      message: 'create-and-deliver rejected',
      result: {
        outTrackId: 'delivery-1',
        deliverResults: [{ success: true, carrierId: 'misleading-carrier' }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendDingTalkInteractiveApprovalCard(
      'app-access-token',
      {
        userId: 'dt-user-1',
        robotCode: 'ding-app-key',
        cardTemplateId: 'template-1',
        outTrackId: 'delivery-1',
        title: '审批待办',
        nodeName: '审批',
        statusText: '等待你处理',
        rejectUrl: 'https://ms.example.test/m/approval-decision?d=delivery-1&t=token',
      },
    )).rejects.toThrow('create-and-deliver rejected')
  })

  it('B-4 sends the official card-instances update shape (statusText only, update-by-key)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateDingTalkInteractiveApprovalCard(
      'app-access-token',
      {
        outTrackId: 'delivery-1',
        statusText: '已由 张审批 同意 · 2026/07/10 14:30',
      },
      { openApiBaseUrl: 'https://api.dingtalk.test/' },
    )

    expect(result.raw).toEqual({ success: true, result: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.dingtalk.test/v1.0/card/instances')
    expect(init.method).toBe('PUT')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': 'app-access-token',
    })
    // Values-free fence (B-2 §5 / B-4): the update carries statusText ONLY — no form values, no
    // extra params can ride the terminal update.
    expect(JSON.parse(String(init.body))).toEqual({
      outTrackId: 'delivery-1',
      cardData: {
        cardParamMap: {
          statusText: '已由 张审批 同意 · 2026/07/10 14:30',
        },
      },
      cardUpdateOptions: { updateCardDataByKey: true },
    })
  })

  it('B-4 update fails closed when the API returns HTTP 200 with success=false', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      message: 'card instance not found',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(updateDingTalkInteractiveApprovalCard(
      'app-access-token',
      { outTrackId: 'delivery-1', statusText: '已同意' },
    )).rejects.toThrow('card instance not found')
  })

  it('B-4 update fails closed on HTTP-200 with a missing success flag (never assume success)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      result: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(updateDingTalkInteractiveApprovalCard(
      'app-access-token',
      { outTrackId: 'delivery-1', statusText: '已同意' },
    )).rejects.toThrow(/update failed/)
  })

  it('B-4 update surfaces HTTP errors as typed request failures', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: 'invalid token',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(updateDingTalkInteractiveApprovalCard(
      'app-access-token',
      { outTrackId: 'delivery-1', statusText: '已同意' },
    )).rejects.toThrow('invalid token')
  })

  it('B-4 update refuses empty token / outTrackId / statusText without calling the API', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(updateDingTalkInteractiveApprovalCard('', { outTrackId: 'delivery-1', statusText: '已同意' }))
      .rejects.toThrow('access token is required')
    await expect(updateDingTalkInteractiveApprovalCard('token', { outTrackId: '  ', statusText: '已同意' }))
      .rejects.toThrow('outTrackId is required')
    await expect(updateDingTalkInteractiveApprovalCard('token', { outTrackId: 'delivery-1', statusText: ' ' }))
      .rejects.toThrow('status text is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('B-2 fails closed when create-and-deliver omits delivery results', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: { outTrackId: 'delivery-1', deliverResults: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendDingTalkInteractiveApprovalCard(
      'app-access-token',
      {
        userId: 'dt-user-1',
        robotCode: 'ding-app-key',
        cardTemplateId: 'template-1',
        outTrackId: 'delivery-1',
        title: '审批待办',
        nodeName: '审批',
        statusText: '等待你处理',
        rejectUrl: 'https://ms.example.test/m/approval-decision?d=delivery-1&t=token',
      },
    )).rejects.toThrow('contained no delivery result')
  })
})
