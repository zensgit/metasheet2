/**
 * #4196 Class-B outbound two-phase wiring for send_dingtalk_person_message.
 *
 * Person notifications can span several 100-recipient batches. The retry authority is action-wide:
 * once any batch is confirmed sent, retrying the action would duplicate that batch. A first-batch
 * ambiguous response is terminal outcome_unknown; only a provable pre-dispatch non-delivery can retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { __resetDingTalkAppAccessTokenCacheForTests } from '../../src/integrations/dingtalk/client'

const FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'
const ROOT = 'exec_root_classb_dingtalk_person'
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }

type IntentRow = { status: string; attempts: number; last_error: string | null }

interface Harness {
  deps: AutomationDeps
  fetch: ReturnType<typeof vi.fn>
  intent: Map<string, IntentRow>
  intentInserts: number
}

const tokenResponse = () => new Response(JSON.stringify({
  errcode: 0,
  errmsg: 'ok',
  access_token: 'app-access-token',
  expires_in: 7200,
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

const sendOkResponse = () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 778899 }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

const httpErrorResponse = (status: number) => new Response(
  JSON.stringify({ errcode: status, errmsg: 'request rejected' }),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const businessErrorResponse = () => new Response(
  JSON.stringify({ errcode: 400001, errmsg: 'business rejection' }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)

const dnsError = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
})

function makeHarness(
  userIds: string[],
  fetchImpl: (call: number) => Response | Error,
): Harness {
  const intent = new Map<string, IntentRow>()
  let calls = 0
  const fetchSpy = vi.fn(async () => {
    const value = fetchImpl(calls++)
    if (value instanceof Error) throw value
    return value
  })
  const state = { intentInserts: 0 }
  const keyOf = (params: unknown[]) => `${String(params[0])}|${String(params[1])}|${String(params[2])}`
  const queryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
    const statement = String(sql)
    if (/meta_automation_outbound_intent/i.test(statement)) {
      const key = keyOf(params)
      if (/^\s*INSERT INTO/i.test(statement)) {
        if (intent.has(key)) return { rows: [], rowCount: 0 }
        intent.set(key, { status: 'pending', attempts: 0, last_error: null })
        state.intentInserts += 1
        return { rows: [], rowCount: 1 }
      }
      if (/^\s*SELECT status/i.test(statement)) {
        const row = intent.get(key)
        return { rows: row ? [{ status: row.status }] : [], rowCount: row ? 1 : 0 }
      }
      const row = intent.get(key)
      if (!row) return { rows: [], rowCount: 0 }
      const guard = /AND status = '([a-z_]+)'/i.exec(statement)?.[1] ?? null
      if (guard && row.status !== guard) return { rows: [], rowCount: 0 }
      const literal = /SET status = '([a-z_]+)'/i.exec(statement)?.[1]
      row.status = literal ?? (statement.includes('status = $4') ? String(params[3]) : row.status)
      if (/attempts = attempts \+ 1/i.test(statement)) row.attempts += 1
      if (statement.includes('last_error = $5')) row.last_error = (params[4] ?? null) as string | null
      return { rows: [], rowCount: 1 }
    }
    if (/FROM users u/i.test(statement)) {
      const requested = Array.isArray(params[0]) ? params[0].map(String) : []
      const rows = userIds
        .filter((userId) => requested.includes(userId))
        .map((userId) => ({
          local_user_id: userId,
          local_user_active: true,
          dingtalk_user_id: `dt-${userId}`,
          integration_id: 'integration_1',
        }))
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 1 }
  }) as unknown as AutomationDeps['queryFn']

  return {
    deps: { eventBus: new EventBus(), queryFn, fetchFn: fetchSpy as unknown as typeof fetch },
    fetch: fetchSpy,
    intent,
    get intentInserts() { return state.intentInserts },
  } as Harness
}

function personAction(userIds: string[]) {
  return {
    type: 'send_dingtalk_person_message',
    config: { userIds, titleTemplate: 'Title', bodyTemplate: 'Body' },
  }
}

function ruleWith(action: ReturnType<typeof personAction>): AutomationRule {
  return {
    id: 'rule_cb_person',
    name: 'Class-B DingTalk person rule',
    sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

const onlyIntent = (intent: Map<string, IntentRow>) => [...intent.values()][0]

beforeEach(() => {
  delete process.env[FLAG]
  process.env.DINGTALK_APP_KEY = 'dt-app-key'
  process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
  process.env.DINGTALK_AGENT_ID = '123456789'
  __resetDingTalkAppAccessTokenCacheForTests()
})

afterEach(() => {
  delete process.env[FLAG]
  delete process.env.DINGTALK_APP_KEY
  delete process.env.DINGTALK_APP_SECRET
  delete process.env.DINGTALK_AGENT_ID
  vi.restoreAllMocks()
})

describe('flag OFF - legacy DingTalk person send', () => {
  it('sends without creating a two-phase intent', async () => {
    const h = makeHarness(['user_1'], (call) => call === 0 ? tokenResponse() : sendOkResponse())

    const execution = await new AutomationExecutor(h.deps).execute(
      ruleWith(personAction(['user_1'])),
      TRIGGER,
      undefined,
      ROOT,
    )

    expect(execution.steps[0]?.status).toBe('success')
    expect(execution.steps[0]?.alreadyApplied).toBeUndefined()
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.intentInserts).toBe(0)
    expect(h.intent.size).toBe(0)
  })
})

describe('flag ON - Class-B DingTalk person intent/outcome', () => {
  beforeEach(() => { process.env[FLAG] = 'true' })

  it('records sent and skips a retry before token lookup or send', async () => {
    const h = makeHarness(['user_1'], (call) => call === 0 ? tokenResponse() : sendOkResponse())
    const rule = ruleWith(personAction(['user_1']))

    const first = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    const retry = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)

    expect(first.steps[0]?.status).toBe('success')
    expect(onlyIntent(h.intent)).toMatchObject({ status: 'sent', last_error: 'dingtalk_person_sent' })
    expect(retry.steps[0]?.alreadyApplied).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['HTTP 4xx', () => httpErrorResponse(400)],
    ['DingTalk business rejection', businessErrorResponse],
  ])('%s after send starts records outcome_unknown and never resends', async (_label, rejection) => {
    const h = makeHarness(['user_1'], (call) => call === 0 ? tokenResponse() : rejection())
    const rule = ruleWith(personAction(['user_1']))

    const first = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    const retry = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)

    expect(first.steps[0]?.status).toBe('failed')
    expect(onlyIntent(h.intent)).toMatchObject({
      status: 'outcome_unknown',
      last_error: 'dingtalk_person_outcome_unknown',
    })
    expect(retry.steps[0]?.alreadyApplied).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('retries only a definite pre-dispatch DNS failure', async () => {
    const h = makeHarness(
      ['user_1'],
      (call) => call === 0 ? tokenResponse() : call === 1 ? dnsError() : sendOkResponse(),
    )
    const rule = ruleWith(personAction(['user_1']))

    const first = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(onlyIntent(h.intent)).toMatchObject({
      status: 'failed',
      last_error: 'dingtalk_person_definite_non_delivery',
    })

    const retry = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.status).toBe('success')
    expect(onlyIntent(h.intent).status).toBe('sent')
    expect(h.fetch).toHaveBeenCalledTimes(3)
  })

  it('makes a partially delivered multi-batch action terminal sent', async () => {
    const userIds = Array.from({ length: 150 }, (_, index) => `user_${index}`)
    const h = makeHarness(
      userIds,
      (call) => call === 0
        ? tokenResponse()
        : call === 1
          ? sendOkResponse()
          : httpErrorResponse(500),
    )
    const rule = ruleWith(personAction(userIds))

    const first = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(first.steps[0]?.output).toMatchObject({
      notifiedUsers: 100,
      failedRecipientCount: 0,
      deliveryOutcomeUnknown: true,
      outcomeUnknownRecipientCount: 50,
    })
    expect(onlyIntent(h.intent)).toMatchObject({ status: 'sent', last_error: 'dingtalk_person_sent' })

    const retry = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.alreadyApplied).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps ad-hoc runSingleAction outside the two-phase substrate', async () => {
    const h = makeHarness(['user_1'], (call) => call === 0 ? tokenResponse() : sendOkResponse())

    const result = await new AutomationExecutor(h.deps).runSingleAction(personAction(['user_1']) as never, {
      executionId: 'exec_adhoc',
      ruleId: 'rule_adhoc',
      sheetId: 'sheet_1',
      recordId: 'rec_1',
      recordData: {},
      ruleCreatedBy: 'user_1',
      actorId: 'user_1',
      triggerEvent: null,
    })

    expect(result.status).toBe('success')
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.intent.size).toBe(0)
  })
})
