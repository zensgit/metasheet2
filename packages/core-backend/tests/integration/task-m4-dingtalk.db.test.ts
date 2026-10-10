import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { DingTalkBusinessError, DingTalkRequestError, DingTalkTimeoutError } from '../../src/integrations/dingtalk/client'
import { createTask } from '../../src/services/task-records'
import { DingTalkTaskDeliveryChannel, TASK_DINGTALK_CHANNEL_CODES } from '../../src/services/task-notification-dingtalk'
import {
  createTaskDeliveryChannelsFromEnv,
  TaskNotificationDeliveryWorker,
} from '../../src/services/task-notification-delivery-worker'
import { TASK_DELIVERY_PREPARE_BUDGET_MS, TASK_DINGTALK_REQUEST_TIMEOUT_MS } from '../../src/tasks/task-delivery-protocol'
import { planTaskEventDeliveries, TASK_NOTIFICATION_CHANNEL_DINGTALK } from '../../src/tasks/task-notifications'
import {
  dropTaskM4Fixtures,
  runSourceMutant,
  seedDirectoryBinding,
  seedOrgDingTalkIntegration,
  seedOrgMembers,
  seedOutboxRow,
  steppedClock,
} from '../helpers/task-m4-fixtures'

/**
 * M4 PR-3b S6 (design task-m4-pr3b-backend-design-20261001.md §8, §11.7; candidate rows M4-a…M4-d
 * are not in the lock yet, so these cells are candidates, not scored).
 *
 * The DingTalk channel with the delivery worker on a real database: the org-bound identity and its
 * branches, the configuration of the identity's own integration row, the outbound base URL, the
 * re-check after the token, the classification of the send, the timeouts, the fence before the send,
 * the redaction of `last_error`, and registration from the environment. The token request and the
 * send are doubles: no network (the global fetch is replaced by one that fails the cell if called).
 *
 * ASSUMPTION(task-m4): [D4] [own-3b-18] the identity branches, [own-3b-19] the configuration
 * source, [own-3b-21] the base URL allowlist.
 *
 * Row isolation: the claim is cross-org, so every cell starts with an empty
 * `task_notification_deliveries` and asserts only on its own rows.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-dingtalk.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4dtalk_'
const CHANNEL = TASK_NOTIFICATION_CHANNEL_DINGTALK
const WORKER_ON: NodeJS.ProcessEnv = { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' }
const CONFIG = { appKey: 'appkey-X-0001', appSecret: 'secret-X-0001', workNotificationAgentId: '4000000001' }
const codes = TASK_DINGTALK_CHANNEL_CODES
const MINUTE = 60_000
const seededUsers: string[] = []

const WORKER_FILE = new URL('../../src/services/task-notification-delivery-worker.ts', import.meta.url).pathname
const DINGTALK_FILE = new URL('../../src/services/task-notification-dingtalk.ts', import.meta.url).pathname
const ORG_NEEDLE = 'AND i.org_id = $2'

const realFetch = globalThis.fetch
const fetchCalls: string[] = []

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input))
    throw new Error('no network in task-m4-dingtalk')
  }) as typeof fetch
})

beforeEach(async () => {
  fetchCalls.length = 0
  await poolManager.get().query('DELETE FROM task_notification_deliveries')
})

afterEach(() => {
  expect(fetchCalls).toEqual([])
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await poolManager.get().query('DELETE FROM task_notification_deliveries WHERE left(org_id, length($1)) = $1', [ORG_PREFIX])
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers })
})

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

async function databaseNow(): Promise<Date> {
  return new Date((await poolManager.get().query('SELECT now() AS now')).rows[0].now as Date)
}

interface Fixture {
  orgId: string
  stamp: string
  creator: string
  recipient: string
  taskId: string
}

/** An org with a creator and a recipient (an assignee), both active members, and one task. No integration yet. */
async function fixture(label: string): Promise<Fixture> {
  const stamp = stampOf()
  const orgId = `${ORG_PREFIX}${label}_${stamp}`
  const creator = `usrC_${label}_${stamp}`
  const recipient = `usrR_${label}_${stamp}`
  await seedOrgMembers(orgId, [creator, recipient])
  seededUsers.push(creator, recipient)
  const task = await createTask({ orgId, creatorId: creator, title: '季度备料复核', assignees: [recipient], completionMode: 'all' })
  return { orgId, stamp, creator, recipient, taskId: task.id }
}

/** One due `commented` row for the recipient (the producer's row shape). */
async function dueRow(f: Fixture, recipient = f.recipient): Promise<string> {
  const [plan] = planTaskEventDeliveries({
    orgId: f.orgId,
    taskId: f.taskId,
    eventId: `tev_s6${stampOf()}`,
    event: 'commented',
    actorId: f.creator,
    recipients: [{ userId: recipient, recipientRole: 'assignee' }],
    channels: [CHANNEL],
  })
  return seedOutboxRow({
    orgId: plan.orgId, sourceType: plan.sourceType, sourceId: plan.sourceId, sourceKey: plan.sourceKey,
    recipientUserId: plan.recipientUserId, recipientRole: plan.recipientRole, channel: plan.channel,
    payload: plan.payload as unknown as Record<string, unknown>,
  })
}

interface Outbound {
  tokens: Array<{ config: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal; logUpstreamMessage?: boolean }>
  sends: Array<{ token: string; userIds: string[]; title: string; content: string; config: Record<string, unknown>; timeoutMs?: number; logUpstreamMessage?: boolean; statusAtSend?: string }>
}

function channelWith(behaviour: {
  token?: (calls: Outbound) => Promise<string>
  send?: (calls: Outbound) => Promise<{ taskId?: string; raw: Record<string, unknown> }>
  watchRow?: string
} = {}): { channel: DingTalkTaskDeliveryChannel; calls: Outbound } {
  const calls: Outbound = { tokens: [], sends: [] }
  const channel = new DingTalkTaskDeliveryChannel({
    fetchAccessToken: async (config, options) => {
      calls.tokens.push({ config: { ...config }, timeoutMs: options?.timeoutMs, signal: options?.signal, logUpstreamMessage: options?.logUpstreamMessage })
      return behaviour.token ? behaviour.token(calls) : 'token-T-0001'
    },
    sendWorkNotification: async (token, input, config, options) => {
      let statusAtSend: string | undefined
      if (behaviour.watchRow) {
        statusAtSend = String((await poolManager.get().query('SELECT status FROM task_notification_deliveries WHERE id = $1::uuid', [behaviour.watchRow])).rows[0]?.status)
      }
      calls.sends.push({
        token, userIds: [...input.userIds], title: input.title, content: input.content, config: { ...config },
        timeoutMs: options?.timeoutMs, logUpstreamMessage: options?.logUpstreamMessage, statusAtSend,
      })
      return behaviour.send ? behaviour.send(calls) : { taskId: '880001', raw: {} }
    },
  })
  return { channel, calls }
}

async function deliver(channel: DingTalkTaskDeliveryChannel): Promise<void> {
  const worker = new TaskNotificationDeliveryWorker({
    channels: [channel],
    now: steppedClock(new Date((await databaseNow()).getTime() + 1000)).now,
    env: WORKER_ON,
  })
  await worker.runBatch()
}

async function rowOf(id: string): Promise<{ status: string; last_error: string | null; attempt_count: number; redelivery_safe: boolean }> {
  const result = await poolManager.get().query(
    'SELECT status, last_error, attempt_count, redelivery_safe FROM task_notification_deliveries WHERE id = $1::uuid',
    [id],
  )
  return result.rows[0] as { status: string; last_error: string | null; attempt_count: number; redelivery_safe: boolean }
}

// ── Identity (design §8.2 step 1) ────────────────────────────────────────────────────────────────

describe('the recipient\'s DingTalk identity (ASSUMPTION(task-m4): [D4] [own-3b-18]; design §8.2, §11.7)', () => {
  it('no integration ⇒ skipped / org_integration_missing; only an inactive one ⇒ skipped / org_integration_inactive (no retry); an active one without this user ⇒ skipped / recipient_not_bound; nothing is requested', async () => {
    const none = await fixture('none')
    const inactive = await fixture('inact')
    await seedDirectoryBinding({ orgId: inactive.orgId, userId: inactive.recipient, externalUserId: 'dt-inact', integrationStatus: 'inactive', config: CONFIG })
    const unbound = await fixture('unbound')
    await seedOrgDingTalkIntegration(unbound.orgId, { config: CONFIG })
    const ids = [await dueRow(none), await dueRow(inactive), await dueRow(unbound)]
    const { channel, calls } = channelWith()
    await deliver(channel)
    expect(await rowOf(ids[0])).toMatchObject({ status: 'skipped', last_error: codes.orgIntegrationMissing, attempt_count: 1 })
    expect(await rowOf(ids[1])).toMatchObject({ status: 'skipped', last_error: codes.orgIntegrationInactive, attempt_count: 1 })
    expect(await rowOf(ids[2])).toMatchObject({ status: 'skipped', last_error: codes.recipientNotBound, attempt_count: 1 })
    expect(calls).toEqual({ tokens: [], sends: [] })
  })

  it('two bindings in the org ⇒ failed / recipient_ambiguous; a blank DingTalk id ⇒ skipped / recipient_not_bound', async () => {
    const two = await fixture('two')
    await seedDirectoryBinding({ orgId: two.orgId, userId: two.recipient, externalUserId: 'dt-two-a', config: CONFIG })
    await seedDirectoryBinding({ orgId: two.orgId, userId: two.recipient, externalUserId: 'dt-two-b', config: CONFIG })
    const blank = await fixture('blank')
    await seedDirectoryBinding({ orgId: blank.orgId, userId: blank.recipient, externalUserId: '  ', config: CONFIG })
    const ids = [await dueRow(two), await dueRow(blank)]
    const { channel, calls } = channelWith()
    await deliver(channel)
    expect(await rowOf(ids[0])).toMatchObject({ status: 'failed', last_error: codes.recipientAmbiguous })
    expect(await rowOf(ids[1])).toMatchObject({ status: 'skipped', last_error: codes.recipientNotBound })
    expect(calls).toEqual({ tokens: [], sends: [] })
  })

  it('the identity is bound to the row\'s org: a user bound only in org B is not bound in org A; negative control: the join without its org clause sends org A\'s row through org B\'s binding', async () => {
    const a = await fixture('orga')
    const orgB = `${ORG_PREFIX}orgb_${a.stamp}`
    await poolManager.get().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [a.recipient, orgB])
    await seedOrgDingTalkIntegration(a.orgId, { config: CONFIG })
    await seedDirectoryBinding({ orgId: orgB, userId: a.recipient, externalUserId: 'dt-in-b', config: { ...CONFIG, appKey: 'appkey-B' } })
    const id = await dueRow(a)
    const { channel, calls } = channelWith()
    await deliver(channel)
    expect(await rowOf(id)).toMatchObject({ status: 'skipped', last_error: codes.recipientNotBound })
    expect(calls).toEqual({ tokens: [], sends: [] })

    await poolManager.get().query(
      `UPDATE task_notification_deliveries SET status = 'pending', attempt_count = 0, last_error = NULL WHERE id = $1::uuid`,
      [id],
    )
    const nowMs = (await databaseNow()).getTime() + 1000
    runSourceMutant(DINGTALK_FILE, ORG_NEEDLE, 'AND $2::text IS NOT NULL', `
      const { TaskNotificationDeliveryWorker } = await import(${JSON.stringify(WORKER_FILE)})
      const { DingTalkTaskDeliveryChannel } = await import(${JSON.stringify(DINGTALK_FILE)})
      const sent = []
      const channel = new DingTalkTaskDeliveryChannel({
        fetchAccessToken: async () => 'token-child',
        sendWorkNotification: async (token, input, config) => { sent.push({ userIds: input.userIds, appKey: config.appKey }); return { taskId: '1', raw: {} } },
      })
      const worker = new TaskNotificationDeliveryWorker({ channels: [channel], now: () => new Date(${nowMs}), env: ${JSON.stringify(WORKER_ON)} })
      await worker.runBatch()
      console.log(JSON.stringify({ ncIdentityOrg: 'red', sent }))
      process.exit(sent.length === 1 && sent[0].appKey === 'appkey-B' ? 0 : 1)
    `, {}, { unique: true })
  }, 60000)
})

// ── Configuration, base URL, re-check ────────────────────────────────────────────────────────────

describe('configuration, base URL and the re-check after the token (ASSUMPTION(task-m4): [own-3b-19] [own-3b-21]; design §8.2)', () => {
  it('the send uses the identity\'s own integration row, not an app configured in the process environment', async () => {
    const saved = { key: process.env.DINGTALK_APP_KEY, secret: process.env.DINGTALK_APP_SECRET, agent: process.env.DINGTALK_AGENT_ID }
    process.env.DINGTALK_APP_KEY = 'appkey-ENV-Y'
    process.env.DINGTALK_APP_SECRET = 'secret-ENV-Y'
    process.env.DINGTALK_AGENT_ID = '7007007'
    try {
      const f = await fixture('cfg')
      await seedDirectoryBinding({ orgId: f.orgId, userId: f.recipient, externalUserId: 'dt-cfg', config: CONFIG })
      const id = await dueRow(f)
      const { channel, calls } = channelWith()
      await deliver(channel)
      expect(await rowOf(id)).toMatchObject({ status: 'sent' })
      expect(calls.tokens.map((call) => call.config)).toEqual([{ appKey: CONFIG.appKey, appSecret: CONFIG.appSecret, agentId: CONFIG.workNotificationAgentId, baseUrl: 'https://oapi.dingtalk.com' }])
      expect(calls.sends.map((call) => [call.userIds, call.config.appKey, call.config.agentId])).toEqual([[['dt-cfg'], CONFIG.appKey, CONFIG.workNotificationAgentId]])
    } finally {
      if (saved.key === undefined) delete process.env.DINGTALK_APP_KEY
      else process.env.DINGTALK_APP_KEY = saved.key
      if (saved.secret === undefined) delete process.env.DINGTALK_APP_SECRET
      else process.env.DINGTALK_APP_SECRET = saved.secret
      if (saved.agent === undefined) delete process.env.DINGTALK_AGENT_ID
      else process.env.DINGTALK_AGENT_ID = saved.agent
    }
  })

  it('an integration row without an agent id ⇒ retrying / config_unavailable, no token request', async () => {
    const f = await fixture('noagent')
    await seedDirectoryBinding({ orgId: f.orgId, userId: f.recipient, externalUserId: 'dt-noagent', config: { appKey: 'k', appSecret: 's' } })
    const id = await dueRow(f)
    const { channel, calls } = channelWith()
    await deliver(channel)
    expect(await rowOf(id)).toMatchObject({ status: 'retrying', last_error: codes.configUnavailable, attempt_count: 1 })
    expect(calls).toEqual({ tokens: [], sends: [] })
  })

  it('base URL http:// or another host ⇒ failed / base_url_rejected with nothing requested; the default, a blank one and https://oapi.dingtalk.com are sent', async () => {
    const outcomes: Array<[string | undefined, string]> = [
      ['http://oapi.dingtalk.com', 'failed'],
      ['https://evil.example', 'failed'],
      [undefined, 'sent'],
      ['', 'sent'],
      ['https://oapi.dingtalk.com', 'sent'],
    ]
    for (const [baseUrl, status] of outcomes) {
      const f = await fixture('url')
      const config = baseUrl === undefined ? CONFIG : { ...CONFIG, baseUrl }
      await seedDirectoryBinding({ orgId: f.orgId, userId: f.recipient, externalUserId: `dt-url-${f.stamp}`, config })
      const id = await dueRow(f)
      const { channel, calls } = channelWith()
      await deliver(channel)
      const row = await rowOf(id)
      expect(row.status, String(baseUrl)).toBe(status)
      if (status === 'failed') {
        expect(row).toMatchObject({ last_error: codes.baseUrlRejected, redelivery_safe: true })
        expect(calls).toEqual({ tokens: [], sends: [] })
      } else {
        expect(calls.sends.map((call) => call.config.baseUrl)).toEqual(['https://oapi.dingtalk.com'])
      }
    }
  })

  it('the binding changes while the token is fetched ⇒ retrying / destination_changed, nothing is sent', async () => {
    const f = await fixture('moved')
    const binding = await seedDirectoryBinding({ orgId: f.orgId, userId: f.recipient, externalUserId: 'dt-before', config: CONFIG })
    const id = await dueRow(f)
    const { channel, calls } = channelWith({
      token: async () => {
        await poolManager.get().query(`UPDATE directory_accounts SET external_user_id = 'dt-after' WHERE id = $1::uuid`, [binding.accountId])
        return 'token-T-0001'
      },
    })
    await deliver(channel)
    expect(await rowOf(id)).toMatchObject({ status: 'retrying', last_error: codes.destinationChanged })
    expect(calls.tokens).toHaveLength(1)
    expect(calls.sends).toEqual([])
  })
})

// ── The send ─────────────────────────────────────────────────────────────────────────────────────

describe('the one send: timeouts, the fence before it, how it ends, what last_error keeps (design §8.2–§8.5)', () => {
  it('the token request carries the request timeout and no signal (the prepare budget is raced inside the channel), the send the request timeout; neither call has its upstream message logged; the row is already sending when the send starts', async () => {
    const f = await fixture('timeout')
    await seedDirectoryBinding({ orgId: f.orgId, userId: f.recipient, externalUserId: 'dt-timeout', config: CONFIG })
    const id = await dueRow(f)
    const timeouts = vi.spyOn(AbortSignal, 'timeout')
    try {
      const { channel, calls } = channelWith({ watchRow: id })
      await deliver(channel)
      expect(calls.tokens.map((call) => [call.timeoutMs, call.signal, call.logUpstreamMessage])).toEqual([[TASK_DINGTALK_REQUEST_TIMEOUT_MS, undefined, false]])
      expect(timeouts).toHaveBeenCalledWith(TASK_DELIVERY_PREPARE_BUDGET_MS)
      expect(calls.sends.map((call) => [call.timeoutMs, call.logUpstreamMessage, call.statusAtSend, call.title])).toEqual([[TASK_DINGTALK_REQUEST_TIMEOUT_MS, false, 'sending', '任务动态']])
      expect(await rowOf(id)).toMatchObject({ status: 'sent', attempt_count: 1 })
    } finally {
      timeouts.mockRestore()
    }
  })

  it('a failed token ⇒ retrying; a timed-out send ⇒ outcome_unknown; errcode 90018 (under errcode or code) ⇒ retrying; a 408 ⇒ retrying; a 4xx ⇒ failed; a plain error after the fence ⇒ outcome_unknown; no task id ⇒ outcome_unknown', async () => {
    const marked = Object.defineProperty(new DingTalkTimeoutError(TASK_DINGTALK_REQUEST_TIMEOUT_MS), 'outcomeUnknown', { value: true })
    const cases: Array<[string, Parameters<typeof channelWith>[0], { status: string; error: string | RegExp; redelivery_safe?: boolean }]> = [
      ['token', { token: async () => { throw new Error('gettoken failed') } }, { status: 'retrying', error: codes.tokenUnavailable }],
      ['timeout', { send: async () => { throw marked } }, { status: 'outcome_unknown', error: /^dingtalk_send_outcome_unknown/ }],
      ['90018', { send: async () => { throw new DingTalkBusinessError('quota', { errcode: 90018, errmsg: 'quota' }) } }, { status: 'retrying', error: /^dingtalk_business_error_90018/ }],
      ['90018 under code', { send: async () => { throw new DingTalkBusinessError('quota', { code: 90018, errmsg: 'quota' }) } }, { status: 'retrying', error: /^dingtalk_business_error_90018/ }],
      ['408', { send: async () => { throw new DingTalkRequestError('request timeout', 408, null) } }, { status: 'retrying', error: /^dingtalk_request_408/ }],
      ['4xx', { send: async () => { throw new DingTalkRequestError('forbidden', 403, null) } }, { status: 'failed', error: /^dingtalk_request_403/, redelivery_safe: true }],
      ['plain', { send: async () => { throw new Error('socket hang up') } }, { status: 'outcome_unknown', error: /^dingtalk_send_unclassified/, redelivery_safe: false }],
      ['no task id', { send: async () => ({ raw: {} }) }, { status: 'outcome_unknown', error: codes.sendResponseInvalid }],
    ]
    for (const [label, behaviour, expected] of cases) {
      const f = await fixture('cls')
      await seedDirectoryBinding({ orgId: f.orgId, userId: f.recipient, externalUserId: `dt-cls-${f.stamp}`, config: CONFIG })
      const id = await dueRow(f)
      const { channel } = channelWith(behaviour)
      await deliver(channel)
      const row = await rowOf(id)
      expect(row.status, label).toBe(expected.status)
      if (typeof expected.error === 'string') expect(row.last_error, label).toBe(expected.error)
      else expect(row.last_error ?? '', label).toMatch(expected.error)
      if (expected.redelivery_safe !== undefined) expect(row.redelivery_safe, label).toBe(expected.redelivery_safe)
    }
  })

  it('last_error after a rejected send keeps the code and a redacted detail: no token, secret, URL, DingTalk id or task text', async () => {
    const f = await fixture('redact')
    await seedDirectoryBinding({ orgId: f.orgId, userId: f.recipient, externalUserId: 'dt-redact-77', config: CONFIG })
    const id = await dueRow(f)
    const leak = [
      'rejected token-T-0001 for dt-redact-77 using appkey-X-0001 / secret-X-0001',
      'at https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=token-T-0001',
      'content 任务「季度备料复核」有新评论',
    ].join('\n')
    const { channel } = channelWith({ send: async () => { throw new DingTalkBusinessError(leak, { errcode: 40035, errmsg: 'invalid' }) } })
    await deliver(channel)
    const row = await rowOf(id)
    expect(row.status).toBe('failed')
    expect(row.last_error?.startsWith('dingtalk_business_error_40035: ')).toBe(true)
    for (const value of ['token-T-0001', 'dt-redact-77', 'appkey-X-0001', 'secret-X-0001', 'oapi.dingtalk.com', 'https://', '季度备料复核', '\n']) {
      expect(row.last_error, value).not.toContain(value)
    }
    expect((row.last_error ?? '').length).toBeLessThanOrEqual('dingtalk_business_error_40035: '.length + 240)
  })
})

// ── Registration from the environment ────────────────────────────────────────────────────────────

describe('registration from the environment (design §8.1; the flag alone decides)', () => {
  it('only TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED exactly true registers the channel; the registered channel ends a row of an org without an integration as skipped, with no request', async () => {
    for (const value of [undefined, '', 'TRUE', '1', ' true', 'false']) {
      expect(createTaskDeliveryChannelsFromEnv({ ...WORKER_ON, TASKS_SCHEDULER_ENABLED: 'true', TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: value }), String(value)).toEqual([])
    }
    const registered = createTaskDeliveryChannelsFromEnv({ TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true' })
    expect(registered.map((channel) => [channel.name, channel instanceof DingTalkTaskDeliveryChannel])).toEqual([[CHANNEL, true]])
    const f = await fixture('env')
    const id = await dueRow(f)
    const now = steppedClock(new Date((await databaseNow()).getTime() + MINUTE)).now
    await new TaskNotificationDeliveryWorker({ channels: registered, now, env: WORKER_ON }).runBatch()
    expect(await rowOf(id)).toMatchObject({ status: 'skipped', last_error: codes.orgIntegrationMissing })
  })
})
