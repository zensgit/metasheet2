/**
 * #4196 Class-B outbound two-phase wiring for send_dingtalk_group_message.
 *
 * A group action can target multiple destinations. Its durable outcome is therefore action-wide:
 * any confirmed destination success makes the action terminal `sent`, any post-dispatch ambiguity
 * with no confirmed success is `outcome_unknown`, and only all-definite pre-dispatch failures are
 * retryable `failed`. Retrying a partially delivered action would duplicate the successful send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'

const FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'
const ROOT = 'exec_root_classb_dingtalk_group'
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }

type IntentRow = { status: string; attempts: number; last_error: string | null }

interface Harness {
  deps: AutomationDeps
  fetch: ReturnType<typeof vi.fn>
  intent: Map<string, IntentRow>
  intentInserts: number
}

const okResponse = () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

const httpErrorResponse = (status: number) => new Response(
  JSON.stringify({ errcode: status, errmsg: 'request rejected' }),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const businessErrorResponse = () => new Response(
  JSON.stringify({ errcode: 310000, errmsg: 'business error' }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)

const dnsError = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
})

function makeHarness(
  destinationIds: string[],
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
    if (/FROM dingtalk_group_destinations/i.test(statement)) {
      const requested = Array.isArray(params[0]) ? params[0].map(String) : []
      return {
        rows: destinationIds
          .filter((id) => requested.includes(id))
          .map((id) => ({
            id,
            name: `Destination ${id}`,
            webhook_url: `https://oapi.dingtalk.com/robot/send?access_token=token-${id}`,
            secret: null,
            enabled: true,
          })),
        rowCount: destinationIds.length,
      }
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

function groupAction(destinationIds: string[]) {
  return {
    type: 'send_dingtalk_group_message',
    config: { destinationIds, titleTemplate: 'Title', bodyTemplate: 'Body' },
  }
}

function ruleWith(action: ReturnType<typeof groupAction>): AutomationRule {
  return {
    id: 'rule_cb_group',
    name: 'Class-B DingTalk group rule',
    sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

const onlyIntent = (intent: Map<string, IntentRow>) => [...intent.values()][0]

beforeEach(() => { delete process.env[FLAG] })
afterEach(() => { delete process.env[FLAG]; vi.restoreAllMocks() })

describe('flag OFF - legacy DingTalk group send', () => {
  it('sends without creating a two-phase intent', async () => {
    const h = makeHarness(['dest_1'], okResponse)

    const execution = await new AutomationExecutor(h.deps).execute(
      ruleWith(groupAction(['dest_1'])),
      TRIGGER,
      undefined,
      ROOT,
    )

    expect(execution.steps[0]?.status).toBe('success')
    expect(execution.steps[0]?.alreadyApplied).toBeUndefined()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.intentInserts).toBe(0)
    expect(h.intent.size).toBe(0)
  })
})

describe('flag ON - Class-B DingTalk group intent/outcome', () => {
  beforeEach(() => { process.env[FLAG] = 'true' })

  it('records sent and skips a retry without a duplicate send', async () => {
    const h = makeHarness(['dest_1'], okResponse)
    const rule = ruleWith(groupAction(['dest_1']))

    const first = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    const retry = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)

    expect(first.steps[0]?.status).toBe('success')
    expect(onlyIntent(h.intent)).toMatchObject({ status: 'sent', last_error: 'dingtalk_group_sent' })
    expect(retry.steps[0]?.alreadyApplied).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['HTTP rejection', () => httpErrorResponse(404)],
    ['DingTalk business rejection', businessErrorResponse],
  ])('%s records outcome_unknown and never resends', async (_label, responseFactory) => {
    const h = makeHarness(['dest_1'], responseFactory)
    const rule = ruleWith(groupAction(['dest_1']))

    const first = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    const retry = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)

    expect(first.steps[0]?.status).toBe('failed')
    expect(onlyIntent(h.intent)).toMatchObject({
      status: 'outcome_unknown',
      last_error: 'dingtalk_group_outcome_unknown',
    })
    expect(retry.steps[0]?.alreadyApplied).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('retries only a definite pre-dispatch DNS failure', async () => {
    const h = makeHarness(['dest_1'], (call) => call === 0 ? dnsError() : okResponse())
    const rule = ruleWith(groupAction(['dest_1']))

    const first = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(onlyIntent(h.intent)).toMatchObject({
      status: 'failed',
      last_error: 'dingtalk_group_definite_non_delivery',
    })

    const retry = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.status).toBe('success')
    expect(onlyIntent(h.intent).status).toBe('sent')
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('makes a partially delivered multi-destination action terminal sent', async () => {
    const h = makeHarness(
      ['dest_1', 'dest_2'],
      (call) => call === 0 ? okResponse() : httpErrorResponse(500),
    )
    const rule = ruleWith(groupAction(['dest_1', 'dest_2']))

    const first = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(first.steps[0]?.output).toMatchObject({ sentCount: 1, failedDestinationIds: ['dest_2'] })
    expect(onlyIntent(h.intent)).toMatchObject({ status: 'sent', last_error: 'dingtalk_group_sent' })

    const retry = await new AutomationExecutor(h.deps).execute(rule, TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.alreadyApplied).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps ad-hoc runSingleAction outside the two-phase substrate', async () => {
    const h = makeHarness(['dest_1'], okResponse)

    const result = await new AutomationExecutor(h.deps).runSingleAction(groupAction(['dest_1']) as never, {
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
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.intent.size).toBe(0)
  })
})
