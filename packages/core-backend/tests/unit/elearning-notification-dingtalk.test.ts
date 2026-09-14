import { describe, expect, it, vi } from 'vitest'

import {
  DingTalkBusinessError,
  DingTalkRequestError,
  type DingTalkMessageConfig,
  type DingTalkWorkNotificationInput,
} from '../../src/integrations/dingtalk/client'
import {
  prepareElearningDingTalkNotification,
  type ElearningDingTalkNotificationQuery,
} from '../../src/services/elearning-notification-dingtalk'

const ORG_ID = 'org-elearning-notification'
const RECIPIENT_USER_ID = 'user-elearning-notification'
const DINGTALK_USER_ID = 'dingtalk-user-notification'
const INTEGRATION_ID = 'integration-elearning-notification'

function dbResult(rows: Array<Record<string, unknown>>) {
  return { rows, rowCount: rows.length }
}

function recipientRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    integration_id: INTEGRATION_ID,
    dingtalk_user_id: DINGTALK_USER_ID,
    integration_config: {
      appKey: 'app-key',
      appSecret: 'app-secret',
      workNotificationAgentId: '123456789',
      baseUrl: 'https://oapi.dingtalk.test',
    },
    ...overrides,
  }
}

function queryReturning(
  rows: Array<Record<string, unknown>>,
): ElearningDingTalkNotificationQuery {
  return vi.fn(async () => dbResult(rows))
}

function validInput() {
  return {
    orgId: ORG_ID,
    recipientUserId: RECIPIENT_USER_ID,
    kind: 'assignment_reminder' as const,
  }
}

describe('e-learning DingTalk notification adapter', () => {
  it('preflights one same-org active mapping and obtains the token before returning prepared', async () => {
    const order: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      order.push('query')
      expect(params).toEqual([ORG_ID, RECIPIENT_USER_ID])
      expect(sql).toContain('membership.org_id = $1')
      expect(sql).toContain('membership.user_id = $2')
      expect(sql).toContain('membership.is_active = TRUE')
      expect(sql).toContain('local_user.is_active = TRUE')
      expect(sql).toContain("link.link_status = 'linked'")
      expect(sql).toContain("account.provider = 'dingtalk'")
      expect(sql).toContain('account.is_active = TRUE')
      expect(sql).toContain('integration.org_id = membership.org_id')
      expect(sql).toContain("integration.status = 'active'")
      expect(sql).toContain('LIMIT 2')
      return dbResult([recipientRow()])
    })
    const fetchAccessToken = vi.fn(async (config: DingTalkMessageConfig) => {
      order.push('token')
      expect(config).toEqual({
        appKey: 'app-key',
        appSecret: 'app-secret',
        agentId: '123456789',
        baseUrl: 'https://oapi.dingtalk.test',
      })
      return 'access-token'
    })
    const sendWorkNotification = vi.fn(async () => ({
      taskId: 'task-1',
      raw: { errcode: 0, task_id: 1 },
    }))

    const prepared = await prepareElearningDingTalkNotification(
      query,
      validInput(),
      { fetchAccessToken, sendWorkNotification },
    )

    expect(prepared.outcome).toBe('prepared')
    expect(order).toEqual(['query', 'token', 'query'])
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it('fails preparation without sending when a delayed token exposes a rebind', async () => {
    let releaseToken: ((token: string) => void) | undefined
    const token = new Promise<string>((resolve) => {
      releaseToken = resolve
    })
    let lookupCount = 0
    const query = vi.fn(async () => {
      lookupCount += 1
      return dbResult([
        lookupCount === 1
          ? recipientRow()
          : recipientRow({ dingtalk_user_id: 'rebound-user' }),
      ])
    })
    const sendWorkNotification = vi.fn(async () => ({
      taskId: 'task-1',
      raw: { errcode: 0, task_id: 1 },
    }))
    const preparing = prepareElearningDingTalkNotification(query, validInput(), {
      fetchAccessToken: async () => token,
      sendWorkNotification,
    })
    await vi.waitFor(() => expect(lookupCount).toBe(1))
    releaseToken?.('access-token')

    await expect(preparing).resolves.toEqual({
      outcome: 'failed',
      code: 'RECIPIENT_IDENTITY_CHANGED',
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it('fails without HTTP when the destination is rebound between prepare and send', async () => {
    let lookupCount = 0
    const query = vi.fn(async () => {
      lookupCount += 1
      return dbResult([
        lookupCount < 3
          ? recipientRow()
          : recipientRow({ integration_id: 'rebound-integration' }),
      ])
    })
    const sendWorkNotification = vi.fn(async () => ({
      taskId: 'task-1',
      raw: { errcode: 0, task_id: 1 },
    }))
    const prepared = await prepareElearningDingTalkNotification(
      query,
      validInput(),
      { fetchAccessToken: async () => 'access-token', sendWorkNotification },
    )
    if (prepared.outcome !== 'prepared') throw new Error('expected prepared')

    await expect(prepared.send()).resolves.toEqual({
      outcome: 'failed',
      code: 'RECIPIENT_IDENTITY_CHANGED',
    })
    expect(query).toHaveBeenCalledTimes(3)
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it('sends one constant values-free individual notification', async () => {
    const sendWorkNotification = vi.fn(async (
      _token: string,
      _message: DingTalkWorkNotificationInput,
      _config: DingTalkMessageConfig,
    ) => ({ taskId: 'task-1', raw: { errcode: 0, task_id: 1 } }))
    const prepared = await prepareElearningDingTalkNotification(
      queryReturning([recipientRow()]),
      validInput(),
      {
        fetchAccessToken: async () => 'access-token',
        sendWorkNotification,
      },
    )
    if (prepared.outcome !== 'prepared') throw new Error('expected prepared')

    await expect(prepared.send()).resolves.toEqual({ outcome: 'sent' })
    expect(sendWorkNotification).toHaveBeenCalledTimes(1)
    expect(sendWorkNotification).toHaveBeenCalledWith(
      'access-token',
      {
        userIds: [DINGTALK_USER_ID],
        title: 'MetaSheet 学习提醒',
        content: '你有待完成的学习任务，请前往 MetaSheet 学习中心查看。',
      },
      expect.objectContaining({ agentId: '123456789' }),
    )
    const serializedMessage = JSON.stringify(sendWorkNotification.mock.calls[0]?.[1])
    expect(serializedMessage).not.toContain(ORG_ID)
    expect(serializedMessage).not.toContain(RECIPIENT_USER_ID)
    expect(serializedMessage).not.toContain('score')
    expect(serializedMessage).not.toContain('answer')
    expect(serializedMessage).not.toContain('http')
  })

  it.each([
    [
      'training_available',
      '你有新的培训任务/报名课程，请前往 MetaSheet 学习中心查看。',
    ],
    [
      'result_published',
      '考试成绩已公布，请登录学习中心查看成绩及通过情况。',
    ],
  ] as const)('uses the closed generic message for %s', async (kind, content) => {
    const sendWorkNotification = vi.fn(async () => ({
      taskId: 'task-1',
      raw: { errcode: 0, task_id: 1 },
    }))
    const prepared = await prepareElearningDingTalkNotification(
      queryReturning([recipientRow()]),
      { ...validInput(), kind },
      {
        fetchAccessToken: async () => 'access-token',
        sendWorkNotification,
      },
    )
    if (prepared.outcome !== 'prepared') throw new Error('expected prepared')

    await expect(prepared.send()).resolves.toEqual({ outcome: 'sent' })
    expect(sendWorkNotification.mock.calls[0]?.[1]).toEqual({
      userIds: [DINGTALK_USER_ID],
      title: 'MetaSheet 学习提醒',
      content,
    })
  })

  it('rejects unsupported kinds without an implicit fallback or query', async () => {
    const query = queryReturning([recipientRow()])
    const result = await prepareElearningDingTalkNotification(
      query,
      { ...validInput(), kind: 'exam_start' as 'assignment_reminder' },
    )

    expect(result).toEqual({ outcome: 'failed', code: 'INVALID_INPUT' })
    expect(query).not.toHaveBeenCalled()
  })

  it('returns a non-retryable identity failure for no active mapping', async () => {
    await expect(prepareElearningDingTalkNotification(
      queryReturning([]),
      validInput(),
    )).resolves.toEqual({
      outcome: 'failed',
      code: 'RECIPIENT_IDENTITY_UNAVAILABLE',
    })
  })

  it('returns a non-retryable identity failure for ambiguous mappings', async () => {
    await expect(prepareElearningDingTalkNotification(
      queryReturning([
        recipientRow(),
        recipientRow({ dingtalk_user_id: 'other-dingtalk-user' }),
      ]),
      validInput(),
    )).resolves.toEqual({
      outcome: 'failed',
      code: 'RECIPIENT_IDENTITY_AMBIGUOUS',
    })
  })

  it('returns retryable when the directory query, pinned config, or token is unavailable', async () => {
    const queryFailure: ElearningDingTalkNotificationQuery = vi.fn(async () => {
      throw new Error('database detail must not escape')
    })
    await expect(prepareElearningDingTalkNotification(
      queryFailure,
      validInput(),
    )).resolves.toEqual({ outcome: 'retryable', code: 'DIRECTORY_UNAVAILABLE' })

    await expect(prepareElearningDingTalkNotification(
      queryReturning([recipientRow({ integration_config: {} })]),
      validInput(),
    )).resolves.toEqual({ outcome: 'retryable', code: 'DINGTALK_CONFIG_UNAVAILABLE' })
    await expect(prepareElearningDingTalkNotification(
      queryReturning([recipientRow({ integration_config: '{invalid' })]),
      validInput(),
    )).resolves.toEqual({ outcome: 'retryable', code: 'DINGTALK_CONFIG_UNAVAILABLE' })

    const sendWorkNotification = vi.fn(async () => ({
      taskId: 'task-1',
      raw: { errcode: 0, task_id: 1 },
    }))
    await expect(prepareElearningDingTalkNotification(
      queryReturning([recipientRow()]),
      validInput(),
      {
        fetchAccessToken: async () => {
          throw new Error('token detail must not escape')
        },
        sendWorkNotification,
      },
    )).resolves.toEqual({ outcome: 'retryable', code: 'DINGTALK_TOKEN_UNAVAILABLE' })
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it('rechecks the external-write gate after the final destination read', async () => {
    let enabled = true
    let lookups = 0
    const query = vi.fn(async () => {
      lookups += 1
      if (lookups === 3) enabled = false
      return dbResult([recipientRow()])
    })
    const sendWorkNotification = vi.fn(async () => ({ taskId: 'synthetic-task', raw: {} }))
    const prepared = await prepareElearningDingTalkNotification(query, validInput(), {
      fetchAccessToken: async () => 'synthetic-token', sendWorkNotification,
    })
    if (prepared.outcome !== 'prepared') throw new Error('expected prepared')
    expect(await prepared.send(() => enabled)).toEqual({ outcome: 'failed', code: 'NOTIFICATION_DISABLED' })
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it('maps definite DingTalk rejections to failed', async () => {
    for (const error of [
      new DingTalkBusinessError('rejected detail', { errcode: 40035 }),
      new DingTalkRequestError('rejected detail', 400, null),
    ]) {
      const sendWorkNotification = vi.fn(async () => {
        throw error
      })
      const prepared = await prepareElearningDingTalkNotification(
        queryReturning([recipientRow()]),
        validInput(),
        {
          fetchAccessToken: async () => 'access-token',
          sendWorkNotification,
        },
      )
      if (prepared.outcome !== 'prepared') throw new Error('expected prepared')

      await expect(prepared.send()).resolves.toEqual({
        outcome: 'failed',
        code: 'DINGTALK_SEND_REJECTED',
      })
      expect(sendWorkNotification).toHaveBeenCalledTimes(1)
    }
  })

  it('maps uncertain send failures to outcome_unknown and never retries', async () => {
    for (const error of [
      Object.assign(new Error('network detail'), { outcomeUnknown: true }),
      new DingTalkRequestError('server detail', 503, null),
      new Error('unclassified send detail'),
    ]) {
      const sendWorkNotification = vi.fn(async () => {
        throw error
      })
      const prepared = await prepareElearningDingTalkNotification(
        queryReturning([recipientRow()]),
        validInput(),
        {
          fetchAccessToken: async () => 'access-token',
          sendWorkNotification,
        },
      )
      if (prepared.outcome !== 'prepared') throw new Error('expected prepared')

      await expect(prepared.send()).resolves.toEqual({
        outcome: 'outcome_unknown',
        code: 'DINGTALK_SEND_OUTCOME_UNKNOWN',
      })
      expect(sendWorkNotification).toHaveBeenCalledTimes(1)
    }
  })

  it('does not report sent when the client response has no task id', async () => {
    const sendWorkNotification = vi.fn(async () => ({ raw: { errcode: 0 } }))
    const prepared = await prepareElearningDingTalkNotification(
      queryReturning([recipientRow()]),
      validInput(),
      {
        fetchAccessToken: async () => 'access-token',
        sendWorkNotification,
      },
    )
    if (prepared.outcome !== 'prepared') throw new Error('expected prepared')

    await expect(prepared.send()).resolves.toEqual({
      outcome: 'outcome_unknown',
      code: 'DINGTALK_SEND_RESPONSE_INVALID',
    })
    expect(sendWorkNotification).toHaveBeenCalledTimes(1)
  })
})
