/**
 * #4196 Class-B outbound two-phase — executor wiring (unit) for send_dingtalk_approval_card (follow-up to
 * send_webhook / send_email).
 *
 * The approval card is a SINGLE-recipient, SINGLE send (the recipient is FIXED from the trigger event), so it
 * fits the at-most-once substrate. It reuses the DingTalk transport's own send-tier signal: a returned send is
 * `sent`; a throw carrying isDingTalkOutcomeUnknown is `outcome_unknown` (the card may have reached the
 * recipient — never auto-resent); a definite throw (HTTP 429 / 4xx / business error) is `failed`
 * (re-attemptable). The claim (Tx A) is committed BEFORE the card-delivery ledger row is inserted, so a replay
 * short-circuits with NO card row and NO send. Flag OFF ⇒ the pre-existing card-delivery path is byte-identical.
 *
 * Harness: env supplies the public URL + link secret + DingTalk work-notification credentials so the config
 * resolvers bypass the DB; deps.queryFn dispatches by SQL substring (approval_instances, the recipient
 * directory lateral, the card-deliveries table, and the meta_automation_outbound_intent two-phase table);
 * deps.fetchFn returns the gettoken then asyncsend envelopes (or rejects the send for the ambiguous case).
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
const ROOT = 'exec_root_classb_card'
const CARD = { type: 'send_dingtalk_approval_card', config: {} }
const TRIGGER = {
  recordId: 'rec_1',
  sheetId: 'sheet_1',
  actorId: 'user_1',
  data: {},
  eventType: 'approval.task_created',
  approval: { instanceId: 'inst_1', requestNo: 'R1', templateId: 'tpl_1' },
  task: { nodeKey: 'node_1', entryEpoch: 1, assigneeUserId: 'assignee_1', sourceStep: 1 },
}

type IntentRow = { status: string; attempts: number; last_error: string | null }

interface Harness {
  deps: AutomationDeps
  fetch: ReturnType<typeof vi.fn>
  intent: Map<string, IntentRow>
  intentInserts: number
}

const tokenResponse = () =>
  new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'app-access-token' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
const asyncSendOk = () =>
  new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 778899 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })

/**
 * @param fetchImpl called per fetch invocation. Return a Response (or an Error to reject). The DingTalk
 *   work-notification path fetches gettoken FIRST (call 0), then asyncsend (call 1). The token cache is
 *   reset before every test so call 0 always fires.
 */
function makeHarness(fetchImpl: (call: number) => Response | Error): Harness {
  const intent = new Map<string, IntentRow>()
  let calls = 0
  const fetchSpy = vi.fn(async () => {
    const out = fetchImpl(calls++)
    if (out instanceof Error) throw out
    return out
  })
  const state = { intentInserts: 0 }
  const keyOf = (p: unknown[]) => `${String(p[0])}|${String(p[1])}|${String(p[2])}`
  const queryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = String(sql)
    if (/meta_automation_outbound_intent/i.test(s)) {
      const key = keyOf(params)
      if (/^\s*INSERT INTO/i.test(s)) {
        if (intent.has(key)) return { rows: [], rowCount: 0 }
        intent.set(key, { status: 'pending', attempts: 0, last_error: null })
        state.intentInserts++
        return { rows: [], rowCount: 1 }
      }
      if (/^\s*SELECT status/i.test(s)) {
        const r = intent.get(key)
        return { rows: r ? [{ status: r.status }] : [], rowCount: r ? 1 : 0 }
      }
      const r = intent.get(key)
      if (!r) return { rows: [], rowCount: 0 }
      const guard = /AND status = '([a-z_]+)'/i.exec(s)?.[1] ?? null
      if (guard && r.status !== guard) return { rows: [], rowCount: 0 }
      const literal = /SET status = '([a-z_]+)'/i.exec(s)?.[1]
      r.status = literal ?? (s.includes('status = $4') ? String(params[3]) : r.status)
      if (/attempts = attempts \+ 1/i.test(s)) r.attempts += 1
      if (s.includes('last_error = $5')) r.last_error = (params[4] ?? null) as string | null
      return { rows: [], rowCount: 1 }
    }
    if (/FROM approval_instances/i.test(s)) {
      return { rows: [{ title: 'Leave request', request_no: 'R1' }], rowCount: 1 }
    }
    if (/directory_account_links/i.test(s)) {
      // Recipient: linked + active DingTalk account bound under integration intg_1.
      return { rows: [{ local_user_id: 'assignee_1', local_user_active: true, dingtalk_user_id: 'dtu_1', integration_id: 'intg_1' }], rowCount: 1 }
    }
    if (/INSERT INTO dingtalk_approval_card_deliveries/i.test(s)) {
      return { rows: [{ id: 'del_1' }], rowCount: 1 }
    }
    if (/dingtalk_approval_card_deliveries/i.test(s)) {
      // markSent / markSendFailed / markSendOutcomeUnknown — UPDATE ... RETURNING.
      return { rows: [{ id: 'del_1' }], rowCount: 1 }
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

function ruleWith(action: { type: string; config: Record<string, unknown> }): AutomationRule {
  return {
    id: 'rule_cb_card', name: 'Class-B card rule', sheetId: 'sheet_1',
    trigger: { type: 'approval.task_created', config: {} },
    actions: [action as never], enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}
const only = (m: Map<string, IntentRow>) => [...m.values()][0]

beforeEach(() => {
  delete process.env[FLAG]
  process.env.PUBLIC_APP_URL = 'https://app.test'
  process.env.APPROVAL_CARD_LINK_SECRET = 'link-secret'
  process.env.DINGTALK_APP_KEY = 'dt-app-key'
  process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
  process.env.DINGTALK_AGENT_ID = '123456789'
  __resetDingTalkAppAccessTokenCacheForTests()
})
afterEach(() => {
  delete process.env[FLAG]
  delete process.env.PUBLIC_APP_URL
  delete process.env.APPROVAL_CARD_LINK_SECRET
  delete process.env.DINGTALK_APP_KEY
  delete process.env.DINGTALK_APP_SECRET
  delete process.env.DINGTALK_AGENT_ID
  vi.restoreAllMocks()
})

describe('flag OFF — byte-identical legacy send_dingtalk_approval_card (no intent row)', () => {
  it('sent: card delivered, success step, NO intent SQL written', async () => {
    const h = makeHarness((call) => (call === 0 ? tokenResponse() : asyncSendOk()))
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(CARD), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('success')
    expect(exec.steps[0]?.alreadyApplied).toBeUndefined()
    expect(exec.steps[0]?.output).toMatchObject({ deliveryId: 'del_1', taskId: '778899' })
    expect(h.intentInserts).toBe(0) // the two-phase table was never touched
    expect(h.intent.size).toBe(0)
  })
})

describe('flag ON — two-phase intent/outcome', () => {
  beforeEach(() => { process.env[FLAG] = 'true' })

  it('proceed → sent: card delivered once, success step, intent row = sent', async () => {
    const h = makeHarness((call) => (call === 0 ? tokenResponse() : asyncSendOk()))
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(CARD), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('success')
    expect(only(h.intent).status).toBe('sent')
    // gettoken + asyncsend = 2 fetches; exactly one asyncsend (one card delivered).
    expect(h.fetch.mock.calls.filter((c) => String(c[0] ?? '').includes('asyncsend'))).toHaveLength(1)
  })

  it('retry after sent → skip_sent: alreadyApplied, NO second send', async () => {
    const h = makeHarness((call) => (call === 0 ? tokenResponse() : asyncSendOk()))
    await new AutomationExecutor(h.deps).execute(ruleWith(CARD), TRIGGER, undefined, ROOT) // first: sent
    const asyncBefore = h.fetch.mock.calls.filter((c) => String(c[0] ?? '').includes('asyncsend')).length
    const second = await new AutomationExecutor(h.deps).execute(ruleWith(CARD), TRIGGER, undefined, ROOT) // retry
    expect(second.steps[0]?.status).toBe('success')
    expect(second.steps[0]?.alreadyApplied).toBe(true)
    expect(only(h.intent).status).toBe('sent')
    const asyncAfter = h.fetch.mock.calls.filter((c) => String(c[0] ?? '').includes('asyncsend')).length
    expect(asyncAfter).toBe(asyncBefore) // NOT re-sent
  })

  // MUTATION-PROOF for the catch's `sendReturned → 'sent'` leg: the ONLY scenario where that leg DECIDES the
  // durable outcome is a Tx-B failure AFTER a successful send — the success-path recordOutboundOutcome('sent')
  // throws, so the intent is still `pending` when the catch writes. Under the mutant (classify the DB error
  // instead), the catch records the retryable `failed` for a DELIVERED card → a retry re-sends = duplicate.
  it('Tx-B throw AFTER a successful send → catch records SENT (never failed); retry skips, no duplicate card', async () => {
    const h = makeHarness((call) => (call === 0 ? tokenResponse() : asyncSendOk()))
    const orig = h.deps.queryFn
    let injected = false
    // Throw ONCE on the first outcome-UPDATE that records 'sent' (recordOutboundOutcome's `SET status = $4`);
    // the claim's literal-SQL flips (`SET status = 'outcome_unknown'` / `'pending'`) are untouched.
    h.deps.queryFn = (async (sql: string, params: unknown[] = []) => {
      const s = String(sql)
      if (!injected && /meta_automation_outbound_intent/i.test(s) && /SET status = \$4/i.test(s) && params?.[3] === 'sent') {
        injected = true
        throw new Error('injected Tx-B outcome-write failure')
      }
      return (orig as (sql: string, params?: unknown[]) => Promise<unknown>)(sql, params)
    }) as AutomationDeps['queryFn']

    const first = await new AutomationExecutor(h.deps).execute(ruleWith(CARD), TRIGGER, undefined, ROOT)
    expect(injected).toBe(true) // the success-path Tx B genuinely failed
    // The card WAS delivered; the catch (sendReturned) must still terminalize the intent as `sent`.
    expect(only(h.intent).status).toBe('sent')
    expect(first.steps[0]?.status).toBe('failed') // the step surfaces the bookkeeping failure honestly

    // And a retry must SKIP (skip_sent) — never a duplicate card for the delivered send.
    const asyncBefore = h.fetch.mock.calls.filter((c) => String(c[0] ?? '').includes('asyncsend')).length
    const retry = await new AutomationExecutor(h.deps).execute(ruleWith(CARD), TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.alreadyApplied).toBe(true)
    const asyncAfter = h.fetch.mock.calls.filter((c) => String(c[0] ?? '').includes('asyncsend')).length
    expect(asyncAfter).toBe(asyncBefore)
  })

  // MUTATION-PROOF for the catch outcome MAPPING (`… : outcomeUnknown ? 'outcome_unknown' : 'failed'`):
  // mutating the 'outcome_unknown' branch to 'failed' makes the intent terminal `failed` (retryable), so BOTH
  // the intent-status assertion AND the retry-skip assertion (a `failed` intent would retry_failed → re-send)
  // fail.
  it('ambiguous send (network reject → transport outcome_unknown) → outcome_unknown, NEVER failed; retry → skip_unknown, no resend', async () => {
    const h = makeHarness((call) => (call === 0 ? tokenResponse() : new TypeError('fetch failed')))
    const first = await new AutomationExecutor(h.deps).execute(ruleWith(CARD), TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(only(h.intent).status).toBe('outcome_unknown') // fail-closed: never the retryable `failed`
    expect(only(h.intent).last_error).toBe('dingtalk_send_outcome_unknown')

    const asyncBefore = h.fetch.mock.calls.filter((c) => String(c[0] ?? '').includes('asyncsend')).length
    const retry = await new AutomationExecutor(h.deps).execute(ruleWith(CARD), TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.alreadyApplied).toBe(true) // skip_unknown → alreadyApplied
    const asyncAfter = h.fetch.mock.calls.filter((c) => String(c[0] ?? '').includes('asyncsend')).length
    expect(asyncAfter).toBe(asyncBefore) // TERMINAL: never a second send
  })

  it('no identity (runSingleAction ad-hoc dispatch) → no intent even with the flag ON', async () => {
    const h = makeHarness((call) => (call === 0 ? tokenResponse() : asyncSendOk()))
    const result = await new AutomationExecutor(h.deps).runSingleAction(CARD as never, {
      executionId: 'x', ruleId: 'r', sheetId: 'sheet_1', recordId: 'rec_1', recordData: {}, ruleCreatedBy: 'user_1', actorId: 'user_1', triggerEvent: TRIGGER,
    })
    expect(result.status).toBe('success')
    expect(h.intent.size).toBe(0) // ad-hoc dispatch has no lineage → no intent
  })
})
