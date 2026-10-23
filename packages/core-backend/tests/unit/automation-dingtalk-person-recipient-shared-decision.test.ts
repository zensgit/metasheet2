/**
 * 客户反馈 2026-10-21 item 1 (review round 2, 3c): the sender (send_dingtalk_person_message) and the rule
 * editor's preflight share not only the SQL but the row → recipient decision,
 * `resolveDingTalkPersonRecipientRows`. Pinned here by running the real executor with that function
 * wrapped in a spy: the sender must call it with the query rows, and must act on what it returns (a
 * private copy of the decision would ignore the substituted answer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { __resetDingTalkAppAccessTokenCacheForTests } from '../../src/integrations/dingtalk/client'
import * as shared from '../../src/multitable/dingtalk-person-recipient-status'

vi.mock('../../src/multitable/dingtalk-person-recipient-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/dingtalk-person-recipient-status')>()
  return { ...actual, resolveDingTalkPersonRecipientRows: vi.fn(actual.resolveDingTalkPersonRecipientRows) }
})

const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }

function rule(userIds: string[]): AutomationRule {
  return {
    id: 'rule_shared_decision',
    name: 'Shared decision rule',
    sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'send_dingtalk_person_message', config: { userIds, titleTemplate: 'Title', bodyTemplate: 'Body' } } as never],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

// The user exists and is active, but has no DingTalk link: on its own decision the sender skips it.
const UNLINKED_ROW = { local_user_id: 'user_fake_a', local_user_active: true, dingtalk_user_id: null, integration_id: null }

function harness() {
  const fetchFn = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('gettoken') || url.includes('accessToken')) {
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'app-access-token', expires_in: 7200 }), { status: 200 })
    }
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 1 }), { status: 200 })
  })
  const queryFn = vi.fn(async (sql: string) => {
    if (sql === shared.DINGTALK_PERSON_RECIPIENT_STATUS_SQL) return { rows: [UNLINKED_ROW], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }) as unknown as AutomationDeps['queryFn']
  return { deps: { eventBus: new EventBus(), queryFn, fetchFn: fetchFn as unknown as typeof fetch } as AutomationDeps, fetchFn }
}

const spy = vi.mocked(shared.resolveDingTalkPersonRecipientRows)

beforeEach(() => {
  process.env.DINGTALK_APP_KEY = 'dt-app-key'
  process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
  process.env.DINGTALK_AGENT_ID = '123456789'
  __resetDingTalkAppAccessTokenCacheForTests()
  spy.mockClear()
})

afterEach(() => {
  delete process.env.DINGTALK_APP_KEY
  delete process.env.DINGTALK_APP_SECRET
  delete process.env.DINGTALK_AGENT_ID
})

describe('send_dingtalk_person_message uses the shared recipient decision', () => {
  it('calls resolveDingTalkPersonRecipientRows with the recipient query rows and skips what it says is unreachable', async () => {
    const h = harness()
    const execution = await new AutomationExecutor(h.deps).execute(rule(['user_fake_a']), TRIGGER)

    expect(spy).toHaveBeenCalledWith([UNLINKED_ROW])
    expect(execution.steps[0]?.status).toBe('skipped')
    expect(execution.steps[0]?.output).toMatchObject({ notifiedUsers: 0, skippedReasonCounts: { notLinked: 1, inactive: 0, notFound: 0 } })
    expect(h.fetchFn).not.toHaveBeenCalled()
  })

  it('acts on the decision it is given (no private copy): a substituted "reachable" answer is sent to', async () => {
    spy.mockImplementationOnce(() => ({
      activeByUserId: new Map([['user_fake_a', true]]),
      linkedByUserId: new Map([['user_fake_a', true]]),
      reachable: new Map([['user_fake_a', { localUserId: 'user_fake_a', dingtalkUserId: 'dt_fake_a', integrationId: '' }]]),
    }))
    const h = harness()
    const execution = await new AutomationExecutor(h.deps).execute(rule(['user_fake_a']), TRIGGER)

    expect(execution.steps[0]?.status).not.toBe('skipped')
    expect(h.fetchFn).toHaveBeenCalled()
  })
})
