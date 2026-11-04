/**
 * Executor wiring of the integration-scoped DingTalk credentials switch
 * (DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED), each ON row next to its OFF contrast.
 *
 *  - send_dingtalk_person_message, switch ON: the configuration of EVERY recipient group is resolved
 *    before the first send, so a configuration failure in any group sends to nobody (every recipient
 *    `failed`, the intent `failed` and re-attemptable). OFF keeps the per-group lazy resolution: an
 *    earlier group is sent before a later group's configuration fails.
 *  - send_dingtalk_approval_card, switch ON: the public URL comes from env or from the ASSIGNEE's own
 *    active integration (never the URL another integration stores), checked after the assignee is
 *    known; the OA card credentials are resolved before the outbound claim and the card-delivery row,
 *    so a configuration failure leaves neither. OFF keeps the URL first, the latest-integration pick,
 *    and the in-send resolution that records the failure on the card row.
 *  - send_dingtalk_approval_card, switch ON: an assignee bound to an integration that is missing or not
 *    active gets no card on either path (interactive card or OA card), whether or not an env URL is set:
 *    no claim, no card row, no DingTalk call. OFF sends exactly as before.
 *
 * Nothing here talks to DingTalk: deps.fetchFn is a mock, db/pg (the credential resolver's module-level
 * query) is a mock, and deps.queryFn dispatches by SQL substring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: dbMocks.query,
}))

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { __resetDingTalkAppAccessTokenCacheForTests } from '../../src/integrations/dingtalk/client'
import {
  isApprovalCardAssigneeIntegrationActive,
  resolveApprovalCardPublicAppUrlForIntegration,
} from '../../src/integrations/dingtalk/approval-card-config'

const SWITCH = 'DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED'
const CLASSB = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'

// Synthetic labels only.
const APP_A_KEY = 'app-a-key-label'
const APP_A_SECRET = 'app-a-secret-label'
const APP_A_AGENT = '101010'
const APP_B_KEY = 'app-b-key-label'
const APP_B_SECRET = 'app-b-secret-label'
const APP_B_AGENT = '202020'
const URL_A = 'https://a.example.test'
const URL_B = 'https://b.example.test'
const URL_LATEST = 'https://latest.example.test'

type IntegrationFixture = { status: string; config: Record<string, unknown> }

/** directory_integrations rows by id, shared by db/pg (resolver) and deps.queryFn (card URL lookups). */
let integrations: Map<string, IntegrationFixture>

function integrationA(overrides: Partial<IntegrationFixture> = {}): IntegrationFixture {
  return {
    status: 'active',
    config: {
      appKey: APP_A_KEY,
      appSecret: normalizeStoredSecretValue(APP_A_SECRET),
      workNotificationAgentId: normalizeStoredSecretValue(APP_A_AGENT),
      approvalCardPublicAppUrl: URL_A,
    },
    ...overrides,
  }
}

function integrationB(overrides: Partial<IntegrationFixture> = {}): IntegrationFixture {
  return {
    status: 'active',
    config: {
      appKey: APP_B_KEY,
      appSecret: normalizeStoredSecretValue(APP_B_SECRET),
      workNotificationAgentId: normalizeStoredSecretValue(APP_B_AGENT),
      approvalCardPublicAppUrl: URL_B,
    },
    ...overrides,
  }
}

function integrationRow(id: string) {
  const fixture = integrations.get(id)
  if (!fixture) return null
  return { id, name: `Directory ${id}`, status: fixture.status, config: fixture.config, updated_at: '2026-05-08T00:00:00.000Z' }
}

// Each app gets its OWN mock access token, issued only for its own key+secret pair, so a send that used the
// other app's credentials (or a token fetched with a mixed key/secret) is visible in the send URL.
const TOKEN_A = 'token-for-app-a'
const TOKEN_B = 'token-for-app-b'
const TOKEN_BY_KEY_AND_SECRET = new Map([
  [`${APP_A_KEY}|${APP_A_SECRET}`, TOKEN_A],
  [`${APP_B_KEY}|${APP_B_SECRET}`, TOKEN_B],
])
const tokenResponse = (url: string) => {
  const params = new URL(url).searchParams
  const token = TOKEN_BY_KEY_AND_SECRET.get(`${params.get('appkey')}|${params.get('appsecret')}`) ?? 'token-for-unknown-pair'
  return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: token, expires_in: 7200 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
const interactiveOkResponse = () => new Response(JSON.stringify({ success: true, result: { deliverResults: [{ success: true }] } }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})
const sendOkResponse = () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 778899 }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})

type IntentRow = { status: string; attempts: number; last_error: string | null }
type PersonDelivery = { localUserId: string; status: string; errorMessage: string | null }

interface Harness {
  deps: AutomationDeps
  fetch: ReturnType<typeof vi.fn>
  intent: Map<string, IntentRow>
  personDeliveries: PersonDelivery[]
  cardInserts: number
  cardFailedMarks: number
  /** 'config:<id>' for every resolver row read, 'fetch' for every DingTalk call — in order. */
  timeline: string[]
}

function makeHarness(options: {
  recipients?: Array<{ userId: string; integrationId: string }>
  assignee?: { integrationId: string | null; linked: boolean }
}): Harness {
  const intent = new Map<string, IntentRow>()
  const personDeliveries: PersonDelivery[] = []
  const timeline: string[] = []
  const state = { cardInserts: 0, cardFailedMarks: 0 }
  const fetchSpy = vi.fn(async (url: unknown) => {
    timeline.push('fetch')
    const target = String(url)
    if (target.includes('gettoken')) return tokenResponse(target)
    return target.includes('createAndDeliver') ? interactiveOkResponse() : sendOkResponse()
  })
  dbMocks.query.mockImplementation(async (_sql: string, params: unknown[] = []) => {
    const id = String(params[0])
    timeline.push(`config:${id}`)
    const row = integrationRow(id)
    return { rows: row ? [row] : [] }
  })
  const keyOf = (p: unknown[]) => `${String(p[0])}|${String(p[1])}|${String(p[2])}`
  const queryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = String(sql)
    if (/meta_automation_outbound_intent/i.test(s)) {
      const key = keyOf(params)
      if (/^\s*INSERT INTO/i.test(s)) {
        if (intent.has(key)) return { rows: [], rowCount: 0 }
        intent.set(key, { status: 'pending', attempts: 0, last_error: null })
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
    if (/INSERT INTO dingtalk_person_deliveries/i.test(s)) {
      personDeliveries.push({ localUserId: String(params[1]), status: String(params[7]), errorMessage: (params[10] ?? null) as string | null })
      return { rows: [], rowCount: 1 }
    }
    if (/FROM approval_instances/i.test(s)) {
      return { rows: [{ title: 'Leave request', request_no: 'R1' }], rowCount: 1 }
    }
    if (/FROM users u/i.test(s) && Array.isArray(params[0])) {
      const requested = (params[0] as unknown[]).map(String)
      const rows = (options.recipients ?? [])
        .filter((r) => requested.includes(r.userId))
        .map((r) => ({ local_user_id: r.userId, local_user_active: true, dingtalk_user_id: `dt-${r.userId}`, integration_id: r.integrationId }))
      return { rows, rowCount: rows.length }
    }
    if (/directory_account_links/i.test(s)) {
      const assignee = options.assignee ?? { integrationId: 'intg_b', linked: true }
      return {
        rows: [{
          local_user_id: 'assignee_1',
          local_user_active: true,
          dingtalk_user_id: assignee.linked ? 'dtu_1' : null,
          integration_id: assignee.linked ? assignee.integrationId : null,
        }],
        rowCount: 1,
      }
    }
    if (/INSERT INTO dingtalk_approval_card_deliveries/i.test(s)) {
      state.cardInserts += 1
      return { rows: [{ id: 'del_1' }], rowCount: 1 }
    }
    if (/dingtalk_approval_card_deliveries/i.test(s)) {
      if (/SET send_status = 'failed'/i.test(s)) state.cardFailedMarks += 1
      return { rows: [{ id: 'del_1' }], rowCount: 1 }
    }
    if (/FROM directory_integrations/i.test(s) && /WHERE id = \$1/i.test(s)) {
      const row = integrationRow(String(params[0]))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (/FROM directory_integrations/i.test(s) && /ORDER BY CASE WHEN status/i.test(s)) {
      // The legacy "latest active integration" pick: a third integration storing its own URL.
      return { rows: [{ config: { approvalCardPublicAppUrl: URL_LATEST } }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }) as unknown as AutomationDeps['queryFn']
  return {
    deps: { eventBus: new EventBus(), queryFn, fetchFn: fetchSpy as unknown as typeof fetch },
    fetch: fetchSpy,
    intent,
    personDeliveries,
    timeline,
    get cardInserts() { return state.cardInserts },
    get cardFailedMarks() { return state.cardFailedMarks },
  } as Harness
}

/** Every work-notification send, as the exact (token, agent, recipients) triple DingTalk would receive. */
function workNotificationSends(h: Harness): Array<{ token: string | null; agentId: unknown; userIds: string }> {
  return h.fetch.mock.calls
    .filter((call) => String(call[0]).includes('/topapi/message/corpconversation/asyncsend_v2'))
    .map((call) => {
      const body = JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as { agent_id?: unknown; userid_list?: string }
      return {
        token: new URL(String(call[0])).searchParams.get('access_token'),
        agentId: body.agent_id,
        userIds: String(body.userid_list ?? ''),
      }
    })
}

/** App A -> token A -> recipient group of intg_a; app B -> token B -> recipient group of intg_b. */
const EXPECTED_TWO_APP_SENDS = [
  { token: TOKEN_A, agentId: Number(APP_A_AGENT), userIds: 'dt-user_a' },
  { token: TOKEN_B, agentId: Number(APP_B_AGENT), userIds: 'dt-user_b' },
]

const PERSON_TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }
const CARD_TRIGGER = {
  recordId: 'rec_1',
  sheetId: 'sheet_1',
  actorId: 'user_1',
  data: {},
  eventType: 'approval.task_created',
  approval: { instanceId: 'inst_1', requestNo: 'R1', templateId: 'tpl_1' },
  task: { nodeKey: 'node_1', entryEpoch: 1, assigneeUserId: 'assignee_1', sourceStep: 1 },
}

function personRule(userIds: string[]): AutomationRule {
  return {
    id: 'rule_scoped_person', name: 'Scoped person rule', sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'send_dingtalk_person_message', config: { userIds, titleTemplate: 'Title', bodyTemplate: 'Body' } } as never],
    enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

function cardRule(): AutomationRule {
  return {
    id: 'rule_scoped_card', name: 'Scoped card rule', sheetId: 'sheet_1',
    trigger: { type: 'approval.task_created', config: {} },
    actions: [{ type: 'send_dingtalk_approval_card', config: {} } as never],
    enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

const ENV_KEYS = [
  SWITCH, CLASSB, 'PUBLIC_APP_URL', 'APP_BASE_URL', 'APPROVAL_CARD_LINK_SECRET',
  'DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET', 'DINGTALK_AGENT_ID', 'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET',
  'DINGTALK_NOTIFY_AGENT_ID', 'DINGTALK_BASE_URL',
  'DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED', 'DINGTALK_INTERACTIVE_CARD_CLIENT_ID', 'DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET',
  'DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID', 'DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID',
]

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.APPROVAL_CARD_LINK_SECRET = 'link-secret-label'
  integrations = new Map([['intg_a', integrationA()], ['intg_b', integrationB()]])
  dbMocks.query.mockReset()
  __resetDingTalkAppAccessTokenCacheForTests()
})

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  vi.restoreAllMocks()
})

const TWO_GROUPS = [
  { userId: 'user_a', integrationId: 'intg_a' },
  { userId: 'user_b', integrationId: 'intg_b' },
]

describe('send_dingtalk_person_message — configuration of every group before the first send', () => {
  it('switch OFF: groups resolve lazily, so the first group is sent before the second group fails (unchanged)', async () => {
    // env carries app A key/secret only; integration B is missing → OFF resolves A, sends, then fails B.
    process.env.DINGTALK_APP_KEY = APP_A_KEY
    process.env.DINGTALK_APP_SECRET = APP_A_SECRET
    integrations.delete('intg_b')
    const h = makeHarness({ recipients: TWO_GROUPS })
    const exec = await new AutomationExecutor(h.deps).execute(personRule(['user_a', 'user_b']), PERSON_TRIGGER)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(h.timeline.indexOf('fetch')).toBeLessThan(h.timeline.indexOf('config:intg_b'))
    expect(h.personDeliveries).toEqual([
      expect.objectContaining({ localUserId: 'user_a', status: 'success' }),
      expect.objectContaining({ localUserId: 'user_b', status: 'failed' }),
    ])
  })

  describe('switch ON', () => {
    beforeEach(() => { process.env[SWITCH] = 'true' })

    it('every group resolves before any DingTalk call; both groups sent with their own app', async () => {
      const h = makeHarness({ recipients: TWO_GROUPS })
      const exec = await new AutomationExecutor(h.deps).execute(personRule(['user_a', 'user_b']), PERSON_TRIGGER)
      expect(exec.steps[0]?.status).toBe('success')
      expect(h.timeline.slice(0, 2)).toEqual(['config:intg_a', 'config:intg_b'])
      expect(h.timeline.filter((e) => e.startsWith('config:'))).toHaveLength(2)
      const sendBodies = h.fetch.mock.calls.map((call) => String((call[1] as RequestInit | undefined)?.body ?? ''))
      expect(sendBodies.some((b) => b.includes(APP_A_AGENT))).toBe(true)
      expect(sendBodies.some((b) => b.includes(APP_B_AGENT))).toBe(true)
      // Exact mapping per send: a swap of token, agent or recipient group between the two apps fails here.
      expect(workNotificationSends(h)).toEqual(EXPECTED_TWO_APP_SENDS)
    })

    it('a configuration failure in the LAST group sends to nobody: every recipient failed with the typed sentence', async () => {
      integrations.set('intg_b', integrationB({ status: 'paused' }))
      const h = makeHarness({ recipients: TWO_GROUPS })
      const exec = await new AutomationExecutor(h.deps).execute(personRule(['user_a', 'user_b']), PERSON_TRIGGER)
      expect(exec.steps[0]?.status).toBe('failed')
      expect(exec.steps[0]?.error).toContain('intg_b')
      expect(exec.steps[0]?.error).toContain('not active')
      expect(h.fetch).not.toHaveBeenCalled()
      expect(h.personDeliveries.map((d) => [d.localUserId, d.status])).toEqual([['user_a', 'failed'], ['user_b', 'failed']])
      expect(exec.steps[0]?.output).toMatchObject({ notifiedUsers: 0 })
    })

    it('with the outbound ledger on: the intent is `failed` (re-attemptable) and the retry after the fix sends every group', async () => {
      process.env[CLASSB] = 'true'
      integrations.delete('intg_b')
      const h = makeHarness({ recipients: TWO_GROUPS })
      const first = await new AutomationExecutor(h.deps).execute(personRule(['user_a', 'user_b']), PERSON_TRIGGER, undefined, 'exec_root_scoped_person')
      expect(first.steps[0]?.status).toBe('failed')
      expect(h.fetch).not.toHaveBeenCalled()
      expect([...h.intent.values()][0]).toMatchObject({ status: 'failed' })

      integrations.set('intg_b', integrationB())
      const retry = await new AutomationExecutor(h.deps).execute(personRule(['user_a', 'user_b']), PERSON_TRIGGER, undefined, 'exec_root_scoped_person')
      expect(retry.steps[0]?.status).toBe('success')
      expect([...h.intent.values()][0]).toMatchObject({ status: 'sent' })
      expect(h.personDeliveries.filter((d) => d.status === 'success').map((d) => d.localUserId).sort()).toEqual(['user_a', 'user_b'])
      expect(workNotificationSends(h)).toEqual(EXPECTED_TWO_APP_SENDS)
    })
  })
})

const PAUSED_SENTENCE = "The assignee's DingTalk integration (intg_b) is missing or not active; the approval card was not sent"

describe('send_dingtalk_approval_card — public URL from the assignee integration (switch ON)', () => {
  it("switch OFF: no env URL → the latest-integration pick's URL, checked before the assignee (unchanged)", async () => {
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    process.env.DINGTALK_APP_KEY = APP_B_KEY
    process.env.DINGTALK_APP_SECRET = APP_B_SECRET
    process.env.DINGTALK_AGENT_ID = APP_B_AGENT
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER)
    expect(exec.steps[0]?.status).toBe('success')
    const sendBody = String((h.fetch.mock.calls[1][1] as RequestInit).body)
    expect(sendBody).toContain(`${URL_LATEST}/m/approval-decision`)
  })

  it('switch OFF: no URL anywhere + unbound assignee → the URL error first, no skipped row (unchanged order)', async () => {
    const h = makeHarness({ assignee: { integrationId: null, linked: false } })
    const orig = h.deps.queryFn
    h.deps.queryFn = (async (sql: string, params: unknown[] = []) => {
      if (/ORDER BY CASE WHEN status/i.test(sql)) return { rows: [], rowCount: 0 }
      return orig(sql, params)
    }) as AutomationDeps['queryFn']
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER)
    expect(exec.steps[0]?.error).toBe('PUBLIC_APP_URL or APP_BASE_URL (or the stored approval-card public app URL) is required for the approval decision link')
    expect(h.personDeliveries).toEqual([])
  })

  describe('switch ON', () => {
    beforeEach(() => { process.env[SWITCH] = 'true' })

    it("no env URL → the assignee integration's stored URL, never the latest-integration pick", async () => {
      const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
      const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER)
      expect(exec.steps[0]?.status).toBe('success')
      const sendBody = String((h.fetch.mock.calls[1][1] as RequestInit).body)
      expect(sendBody).toContain(`${URL_B}/m/approval-decision`)
      expect(sendBody).not.toContain(URL_LATEST)
      expect(sendBody).toContain(APP_B_AGENT)
    })

    it('env URL still wins over the stored one', async () => {
      process.env.PUBLIC_APP_URL = 'https://env.example.test'
      const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
      await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER)
      expect(String((h.fetch.mock.calls[1][1] as RequestInit).body)).toContain('https://env.example.test/m/approval-decision')
    })

    it.each([
      ['stores no URL', () => integrationB({ config: { ...integrationB().config, approvalCardPublicAppUrl: undefined } }), "assignee's active DingTalk integration (intg_b)"],
      ['is paused', () => integrationB({ status: 'paused' }), PAUSED_SENTENCE],
    ])('assignee integration %s → fail-closed naming that integration, before any claim, card row or DingTalk call', async (_label, make, sentence) => {
      process.env[CLASSB] = 'true'
      integrations.set('intg_b', make())
      const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
      const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_scoped_card')
      expect(exec.steps[0]?.status).toBe('failed')
      expect(exec.steps[0]?.error).toContain(sentence)
      expect(h.cardInserts).toBe(0)
      expect(h.intent.size).toBe(0)
      expect(h.fetch).not.toHaveBeenCalled()
    })

    it('no URL anywhere + unbound assignee → the skipped row and the not-linked error (URL is checked after the assignee)', async () => {
      const h = makeHarness({ assignee: { integrationId: null, linked: false } })
      const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER)
      expect(exec.steps[0]?.error).toBe('Recipient has no linked, active DingTalk account (skipped — mappings are never guessed)')
      expect(h.personDeliveries).toEqual([expect.objectContaining({ localUserId: 'assignee_1', status: 'skipped' })])
    })
  })
})

describe('send_dingtalk_approval_card — OA card credentials resolved before the claim and the card row (switch ON)', () => {
  // Env carries app A's key/secret only; the assignee is bound under integration B with no Agent ID stored.
  beforeEach(() => {
    process.env.PUBLIC_APP_URL = 'https://env.example.test'
    process.env.DINGTALK_APP_KEY = APP_A_KEY
    process.env.DINGTALK_APP_SECRET = APP_A_SECRET
    process.env[CLASSB] = 'true'
    integrations.set('intg_b', integrationB({ config: { ...integrationB().config, workNotificationAgentId: undefined } }))
  })

  it('switch OFF: the configuration failure is recorded on the card row inside the send (unchanged)', async () => {
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_scoped_oa_off')
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toBe('DINGTALK_AGENT_ID, DINGTALK_NOTIFY_AGENT_ID, or directory workNotificationAgentId is not configured')
    expect(h.cardInserts).toBe(1)
    expect(h.cardFailedMarks).toBe(1)
    expect([...h.intent.values()][0]).toMatchObject({ status: 'failed' })
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('switch ON: typed failure before the claim — no intent row, no card row, no DingTalk call', async () => {
    process.env[SWITCH] = 'true'
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_scoped_oa_on')
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toContain('intg_b')
    expect(exec.steps[0]?.error).toContain('missing: agentId')
    for (const label of [APP_A_KEY, APP_A_SECRET, APP_B_KEY, APP_B_SECRET, APP_B_AGENT]) {
      expect(exec.steps[0]?.error).not.toContain(label)
    }
    expect(h.cardInserts).toBe(0)
    expect(h.intent.size).toBe(0)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('switch ON, configuration fine: the pre-resolved credentials are the ones sent (one resolver read)', async () => {
    process.env[SWITCH] = 'true'
    integrations.set('intg_b', integrationB())
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_scoped_oa_ok')
    expect(exec.steps[0]?.status).toBe('success')
    expect(h.timeline.filter((e) => e.startsWith('config:'))).toEqual(['config:intg_b'])
    expect(String((h.fetch.mock.calls[1][1] as RequestInit).body)).toContain(APP_B_AGENT)
    // Env carries app A's key/secret here: the card must still go out with app B's token and agent.
    expect(workNotificationSends(h)).toEqual([{ token: TOKEN_B, agentId: Number(APP_B_AGENT), userIds: 'dtu_1' }])
  })
})

describe('send_dingtalk_approval_card — assignee integration not active (switch ON), interactive and OA paths', () => {
  // Env URL set (so the URL check cannot be what stops the card), outbound ledger on, assignee bound under
  // intg_b. The interactive-card Stream app is bound to intg_b, so the interactive path is the one chosen.
  function enableInteractiveCardForIntgB() {
    process.env.DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED = 'true'
    process.env.DINGTALK_INTERACTIVE_CARD_CLIENT_ID = 'stream-client-label'
    process.env.DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET = 'stream-secret-label'
    process.env.DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID = 'card-template-label'
    process.env.DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID = 'intg_b'
  }
  beforeEach(() => {
    process.env.PUBLIC_APP_URL = 'https://env.example.test'
    process.env[CLASSB] = 'true'
    integrations.set('intg_b', integrationB({ status: 'paused' }))
  })

  it('switch OFF, interactive card bound to the paused integration: still sent (unchanged)', async () => {
    enableInteractiveCardForIntgB()
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_paused_interactive_off')
    expect(exec.steps[0]?.status).toBe('success')
    expect(h.cardInserts).toBe(1)
    expect([...h.intent.values()][0]).toMatchObject({ status: 'sent' })
    expect(h.fetch.mock.calls.some((call) => String(call[0]).includes('createAndDeliver'))).toBe(true)
  })

  it('switch ON, interactive card bound to the paused integration: no claim, no card row, no DingTalk call', async () => {
    process.env[SWITCH] = 'true'
    enableInteractiveCardForIntgB()
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_paused_interactive_on')
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toBe(PAUSED_SENTENCE)
    expect(h.cardInserts).toBe(0)
    expect(h.intent.size).toBe(0)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('switch ON, interactive card, integration row missing: same fail-closed result', async () => {
    process.env[SWITCH] = 'true'
    enableInteractiveCardForIntgB()
    integrations.delete('intg_b')
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_missing_interactive_on')
    expect(exec.steps[0]?.error).toBe(PAUSED_SENTENCE)
    expect(h.cardInserts).toBe(0)
    expect(h.intent.size).toBe(0)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('switch ON, OA card for the paused integration: no claim, no card row, no DingTalk call', async () => {
    process.env[SWITCH] = 'true'
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_paused_oa_on')
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toBe(PAUSED_SENTENCE)
    expect(h.cardInserts).toBe(0)
    expect(h.intent.size).toBe(0)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('switch ON, interactive card, integration active: sent (the check does not block an active integration)', async () => {
    process.env[SWITCH] = 'true'
    enableInteractiveCardForIntgB()
    integrations.set('intg_b', integrationB())
    const h = makeHarness({ assignee: { integrationId: 'intg_b', linked: true } })
    const exec = await new AutomationExecutor(h.deps).execute(cardRule(), CARD_TRIGGER, undefined, 'exec_root_active_interactive_on')
    expect(exec.steps[0]?.status).toBe('success')
    expect(h.cardInserts).toBe(1)
    expect(h.fetch.mock.calls.some((call) => String(call[0]).includes('createAndDeliver'))).toBe(true)
  })
})

describe('isApprovalCardAssigneeIntegrationActive (fail-closed edges)', () => {
  it('true only for an existing active row; missing, paused, empty id or a failing query are false', async () => {
    const active = vi.fn(async () => ({ rows: [{ id: 'intg_b', name: 'B', status: 'active', config: {} }] }))
    await expect(isApprovalCardAssigneeIntegrationActive('intg_b', active)).resolves.toBe(true)
    expect(active.mock.calls[0][1]).toEqual(['intg_b', 'dingtalk'])
    await expect(isApprovalCardAssigneeIntegrationActive('intg_b', vi.fn(async () => ({ rows: [] })))).resolves.toBe(false)
    await expect(isApprovalCardAssigneeIntegrationActive('intg_b', vi.fn(async () => ({ rows: [{ id: 'intg_b', name: 'B', status: 'paused', config: {} }] })))).resolves.toBe(false)
    const unused = vi.fn(async () => ({ rows: [] }))
    await expect(isApprovalCardAssigneeIntegrationActive('  ', unused)).resolves.toBe(false)
    expect(unused).not.toHaveBeenCalled()
    await expect(isApprovalCardAssigneeIntegrationActive('intg_b', vi.fn(async () => { throw new Error('query failed') }))).resolves.toBe(false)
  })
})

describe('resolveApprovalCardPublicAppUrlForIntegration (fail-closed edges)', () => {
  const byId = (rows: unknown[]) => vi.fn(async () => ({ rows }))

  it('env wins without a query; an empty integration id is env-or-null without a query', async () => {
    process.env.APP_BASE_URL = 'https://env-base.example.test'
    const q1 = byId([])
    await expect(resolveApprovalCardPublicAppUrlForIntegration('intg_b', q1)).resolves.toBe('https://env-base.example.test/')
    expect(q1).not.toHaveBeenCalled()
    delete process.env.APP_BASE_URL
    const q2 = byId([])
    await expect(resolveApprovalCardPublicAppUrlForIntegration('  ', q2)).resolves.toBeNull()
    expect(q2).not.toHaveBeenCalled()
  })

  it('reads only the named integration; missing row, paused row or a failing query resolve to null', async () => {
    const q = byId([{ id: 'intg_b', name: 'B', status: 'active', config: { approvalCardPublicAppUrl: URL_B } }])
    await expect(resolveApprovalCardPublicAppUrlForIntegration('intg_b', q)).resolves.toBe(`${URL_B}/`)
    expect(q.mock.calls[0][1]).toEqual(['intg_b', 'dingtalk'])
    await expect(resolveApprovalCardPublicAppUrlForIntegration('intg_b', byId([]))).resolves.toBeNull()
    await expect(resolveApprovalCardPublicAppUrlForIntegration('intg_b', byId([{ id: 'intg_b', name: 'B', status: 'paused', config: { approvalCardPublicAppUrl: URL_B } }]))).resolves.toBeNull()
    await expect(resolveApprovalCardPublicAppUrlForIntegration('intg_b', vi.fn(async () => { throw new Error('query failed') }))).resolves.toBeNull()
  })
})
