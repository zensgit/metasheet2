import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => {
    throw new Error('the worker under test must use its injected query')
  }),
  transaction: vi.fn(async () => {
    throw new Error('the worker under test must not open a transaction')
  }),
  pool: null,
}))

import { registry } from '../../src/metrics/metrics'
import { DingTalkTaskDeliveryChannel } from '../../src/services/task-notification-dingtalk'
import {
  createTaskDeliveryChannelsFromEnv,
  TaskNotificationDeliveryWorker,
  type TaskDeliveryChannel,
  type TaskDeliveryChannelResult,
  type TaskDeliveryCounter,
  type TaskDeliveryPrepared,
  type TaskDeliveryQuery,
} from '../../src/services/task-notification-delivery-worker'
import type { Row } from '../../src/services/task-records'
import {
  TASK_DELIVERY_BATCH_SIZE_DEFAULT,
  TASK_DELIVERY_LEASE_MS_DEFAULT,
  TASK_DELIVERY_LEASE_MS_MAX,
  TASK_DELIVERY_LEASE_MS_MIN,
  TASK_DELIVERY_OUTCOMES,
  TASK_DELIVERY_ROW_BUDGET_MS,
  TASK_DELIVERY_SEND_LEASE_MS,
} from '../../src/tasks/task-delivery-protocol'
import type { TaskDeliveryMessage } from '../../src/tasks/task-notification-text'
import { TASK_NOTIFICATION_CHANNEL_DINGTALK } from '../../src/tasks/task-notifications'
import { TASK_REMINDER_FLOOR_EVENT_TYPES } from '../../src/tasks/task-reminders'

/**
 * M4 PR-3b S4 (design task-m4-pr3b-backend-design-20261001.md §3.3, §7.2): the delivery worker on a
 * scripted query. Pins what a database run cannot show directly: that a switched-off worker sends
 * no statement at all, the statement texts and their binds, the order of the steps of one row
 * (materialisation before and after prepare; fence after the last materialisation read, before
 * the send; terminal write after it), that a thrown error is recorded as a fixed code, the stop
 * signal and the row budget handing the rest of a batch back while a row is in flight, and the
 * outcome counter. The database behaviour is tests/integration/task-m4-delivery.db.test.ts.
 */

const ON: NodeJS.ProcessEnv = { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' }
const NOW = new Date('2026-10-08T03:00:00.000Z')
const ROW_ID = '3f9a1c2e-1111-4aaa-8bbb-0123456789ab'
const ORG = 'org_unit_worker'
const TASK = 'tsk_unit_worker'
const RECIPIENT = 'usr_unit_follower'
/** A reminder moment five minutes before NOW, written an hour before that. */
const REMIND_AT = new Date(NOW.getTime() - 5 * 60_000)
const REMIND_FLOOR = new Date(REMIND_AT.getTime() - 60 * 60_000)

interface Recorded {
  sql: string
  params: unknown[]
}

interface Script {
  claimed?: Row[]
  sweptUnknown?: number
  sweptExhausted?: number
  /** The fence finds no row (lease lost). */
  fenceLost?: boolean
  /** The fence statement throws (a connection or server failure inside a row). */
  fenceThrows?: string
  /** The terminal write finds no row (lease lost). */
  terminalLost?: boolean
  /** The task read throws (a materialisation failure). */
  taskReadThrows?: string
  /** The recipient is not an active member. */
  inactive?: boolean
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

interface Deferred { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

function scriptedQuery(script: Script = {}): { query: TaskDeliveryQuery; log: Recorded[] } {
  const log: Recorded[] = []
  const query: TaskDeliveryQuery = async (sql, params = []) => {
    const text = oneLine(sql)
    log.push({ sql: text, params })
    const ids = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `swept-${i}` }))
    if (text.includes("last_error = 'lease_expired_after_send_started'")) return { rows: ids(script.sweptUnknown ?? 0) }
    if (text.includes("last_error = 'attempts_exhausted'")) return { rows: ids(script.sweptExhausted ?? 0) }
    if (text.startsWith('WITH claim AS')) return { rows: script.claimed ?? [] }
    if (text.includes('FROM unnest($2::uuid[], $3::int[])')) return { rows: (params[1] as string[]).map((id) => ({ id })) }
    if (text.includes("SET status = 'sending'")) {
      if (script.fenceThrows) throw Object.assign(new Error(script.fenceThrows), { code: '57P01' })
      return { rows: script.fenceLost ? [] : [{ id: params[1] }] }
    }
    if (text.startsWith('UPDATE task_notification_deliveries SET status =')) return { rows: script.terminalLost ? [] : [{ id: params[0] }] }
    if (text.includes('FROM user_orgs uo')) return { rows: script.inactive ? [] : [{ user_id: RECIPIENT }] }
    if (text.startsWith('SELECT tasks.title, tasks.created_by FROM tasks WHERE')) {
      if (script.taskReadThrows) throw new Error(script.taskReadThrows)
      return { rows: [{ title: '备料复核', created_by: 'usr_unit_creator' }] }
    }
    if (text.startsWith('SELECT tasks.title, tasks.status, tasks.created_by, tasks.deleted_at, tasks.remind_at')) {
      return { rows: [{ title: '到点复核', status: 'open', created_by: RECIPIENT, deleted_at: null, remind_at: REMIND_AT, due_date: null, due_time: null, time_zone: null }] }
    }
    if (text.startsWith('SELECT max(occurred_at) AS floor FROM task_events')) return { rows: [{ floor: REMIND_FLOOR }] }
    if (text.includes('FROM task_assignees WHERE task_id')) return { rows: [] }
    if (text.includes('FROM task_followers WHERE task_id')) return { rows: [{ user_id: RECIPIENT }] }
    if (text.includes('FROM task_list_items tli')) return { rows: [] }
    throw new Error(`unexpected statement: ${text}`)
  }
  return { query, log }
}

function claimedEventRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ROW_ID,
    org_id: ORG,
    source_type: 'task_event',
    source_id: TASK,
    source_key: `task_event:${TASK}:tev_unit:recipient:${RECIPIENT}:channel:${TASK_NOTIFICATION_CHANNEL_DINGTALK}`,
    recipient_user_id: RECIPIENT,
    recipient_role: 'follower',
    channel: TASK_NOTIFICATION_CHANNEL_DINGTALK,
    attempt_count: 1,
    payload: { kind: 'task_event', event: 'commented', taskId: TASK, eventId: 'tev_unit', actorId: 'usr_unit_actor' },
    next_attempt_at: new Date(NOW.getTime() - 60_000),
    created_at: new Date(NOW.getTime() - 60_000),
    claim_expires_at: new Date(NOW.getTime() + TASK_DELIVERY_LEASE_MS_DEFAULT),
    ...overrides,
  }
}

interface ChannelScript {
  prepare?: () => Promise<TaskDeliveryPrepared>
  send?: () => Promise<TaskDeliveryChannelResult>
}

function recordingChannel(log: Recorded[], script: ChannelScript = {}): TaskDeliveryChannel & { prepares: number; sends: number; messages: TaskDeliveryMessage[] } {
  const channel = {
    name: TASK_NOTIFICATION_CHANNEL_DINGTALK,
    prepares: 0,
    sends: 0,
    messages: [] as TaskDeliveryMessage[],
    async prepare(): Promise<TaskDeliveryPrepared> {
      channel.prepares += 1
      log.push({ sql: '<prepare>', params: [] })
      if (script.prepare) return script.prepare()
      return {
        ok: true,
        send: async (message: TaskDeliveryMessage) => {
          channel.sends += 1
          channel.messages.push(message)
          log.push({ sql: '<send>', params: [] })
          return script.send ? script.send() : { ok: true }
        },
      }
    },
  }
  return channel
}

/** `base` with `hook` run before each statement (its statement index among those matching `match`), for gates and clock moves inside a row. */
function hooked(
  base: TaskDeliveryQuery,
  match: (sql: string) => boolean,
  hook: (index: number) => Promise<void> | void,
): TaskDeliveryQuery {
  let seen = 0
  return async (sql, params) => {
    if (match(oneLine(sql))) {
      const index = seen
      seen += 1
      await hook(index)
    }
    return base(sql, params)
  }
}

const isMembershipRead = (sql: string): boolean => sql.includes('FROM user_orgs uo')
const isTaskRead = (sql: string): boolean => sql.startsWith('SELECT tasks.title, tasks.created_by FROM tasks WHERE')

function recordingCounter(): TaskDeliveryCounter & { counts: Record<string, number> } {
  const counts: Record<string, number> = {}
  return {
    counts,
    inc(labels, value = 1) {
      counts[labels.outcome] = (counts[labels.outcome] ?? 0) + value
    },
  }
}

const silent = { info: () => undefined, warn: () => undefined }

function worker(query: TaskDeliveryQuery, channel: TaskDeliveryChannel, extra: Partial<ConstructorParameters<typeof TaskNotificationDeliveryWorker>[0]> = {}) {
  return new TaskNotificationDeliveryWorker({
    channels: [channel],
    query,
    now: () => NOW,
    workerId: 'w-unit',
    logger: silent,
    metrics: recordingCounter(),
    env: ON,
    ...extra,
  })
}

const SAVED_SWITCH = process.env.TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED
const SAVED_TASKS = process.env.TASKS_ENABLED

afterEach(() => {
  if (SAVED_SWITCH === undefined) delete process.env.TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED
  else process.env.TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED = SAVED_SWITCH
  if (SAVED_TASKS === undefined) delete process.env.TASKS_ENABLED
  else process.env.TASKS_ENABLED = SAVED_TASKS
})

describe('the worker switch (ASSUMPTION(task-m4): [own-3b-26] [own-3b-06])', () => {
  const table: Array<[NodeJS.ProcessEnv, boolean]> = [
    [{}, false],
    [{ TASKS_ENABLED: 'true' }, false],
    [{ TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' }, false],
    [{ TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'TRUE' }, false],
    [{ TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: ' true' }, false],
    [{ TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true ' }, false],
    [{ TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: '1' }, false],
    [{ TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'false' }, false],
    [{ TASKS_ENABLED: 'TRUE', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' }, false],
    [{ TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' }, true],
  ]

  it('enabled only when TASKS_ENABLED and the worker switch are both exactly true (read once, at construction)', () => {
    for (const [env, expected] of table) {
      const { query } = scriptedQuery()
      expect(worker(query, recordingChannel([]), { env }).enabled, JSON.stringify(env)).toBe(expected)
    }
  })

  it('switched off: runBatch and runUntilIdle send no statement, call no channel and return zeros', async () => {
    for (const [env, expected] of table) {
      if (expected) continue
      const { query, log } = scriptedQuery({ claimed: [claimedEventRow()], sweptUnknown: 1, sweptExhausted: 1 })
      const channel = recordingChannel(log)
      const w = worker(query, channel, { env })
      expect(await w.runBatch()).toEqual({
        claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0, outcomeUnknown: 0, lostLease: 0, released: 0,
        swept: { outcomeUnknown: 0, exhausted: 0 },
      })
      const idle = await w.runUntilIdle({ budgetMs: 60_000 })
      expect(idle.batches).toBe(0)
      expect(Object.values(idle.totals).every((n) => n === 0)).toBe(true)
      expect(log).toEqual([])
      expect(channel.prepares).toBe(0)
    }
  })

  it('the default environment is process.env, read when the worker is built', () => {
    const { query } = scriptedQuery()
    process.env.TASKS_ENABLED = 'true'
    process.env.TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED = 'true'
    const built = new TaskNotificationDeliveryWorker({ channels: [], query, now: () => NOW, logger: silent })
    expect(built.enabled).toBe(true)
    delete process.env.TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED
    // Turning the variable off later does not change a built worker; a new one reads it again.
    expect(built.enabled).toBe(true)
    expect(new TaskNotificationDeliveryWorker({ channels: [], query, now: () => NOW, logger: silent }).enabled).toBe(false)
  })

  it('stopping already true, or a batch of this worker still running: no statement', async () => {
    const { query, log } = scriptedQuery({ claimed: [claimedEventRow()] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const channel = recordingChannel(log, {
      prepare: async () => {
        await gate
        return { ok: false, result: { ok: false, retryable: false, skip: true, error: 'not_bound' } }
      },
    })
    const w = worker(query, channel)
    expect((await w.runBatch({ stopping: () => true })).claimed).toBe(0)
    expect(log).toEqual([])
    const running = w.runBatch()
    await vi.waitFor(() => expect(channel.prepares).toBe(1))
    const before = log.length
    expect((await w.runBatch()).claimed).toBe(0)
    expect(log).toHaveLength(before)
    release()
    expect((await running).skipped).toBe(1)
  })
})

describe('construction', () => {
  const { query } = scriptedQuery()

  it('defaults and clamps: batch 50 in [1, 200], lease 60 s in [60 s, 600 s]; a default worker id per process', async () => {
    expect(worker(query, recordingChannel([])).batchSize).toBe(TASK_DELIVERY_BATCH_SIZE_DEFAULT)
    expect(worker(query, recordingChannel([]), { batchSize: 0 }).batchSize).toBe(1)
    expect(worker(query, recordingChannel([]), { batchSize: 500 }).batchSize).toBe(200)
    const built = new TaskNotificationDeliveryWorker({ channels: [], query, logger: silent, env: ON })
    expect(built.workerId).toMatch(new RegExp(`^task-delivery:${process.pid}:[0-9a-f]{8}$`))
    // The clamped lease is the claim's bind $6.
    const cases: Array<[number, number]> = [
      [1, TASK_DELIVERY_LEASE_MS_MIN],
      [TASK_DELIVERY_LEASE_MS_DEFAULT, TASK_DELIVERY_LEASE_MS_DEFAULT],
      [10 ** 9, TASK_DELIVERY_LEASE_MS_MAX],
    ]
    for (const [leaseMs, bound] of cases) {
      const { query: q, log } = scriptedQuery()
      await worker(q, recordingChannel(log), { leaseMs }).runBatch()
      expect(log.find((entry) => entry.sql.startsWith('WITH claim AS'))?.params[5]).toBe(bound)
    }
  })

  it('refuses a malformed channel list, a channel registered twice, a bad maxAttempts, sendLeaseMs or workerId', () => {
    const channel = recordingChannel([])
    expect(() => new TaskNotificationDeliveryWorker({ channels: 'x' as never, query })).toThrow(TypeError)
    expect(() => new TaskNotificationDeliveryWorker({ channels: [{ name: 'x' } as never], query })).toThrow(TypeError)
    expect(() => new TaskNotificationDeliveryWorker({ channels: [channel, recordingChannel([])], query })).toThrow(/twice/)
    for (const maxAttempts of [0, -1, 1.5, Number.NaN]) {
      expect(() => worker(query, channel, { maxAttempts })).toThrow(TypeError)
    }
    for (const sendLeaseMs of [0, 1.5, TASK_DELIVERY_LEASE_MS_DEFAULT, TASK_DELIVERY_LEASE_MS_DEFAULT + 1]) {
      expect(() => worker(query, channel, { sendLeaseMs })).toThrow(TypeError)
    }
    expect(() => worker(query, channel, { workerId: '' })).toThrow(TypeError)
  })

  it('the environment registers the DingTalk channel when its own flag is exactly true and nothing otherwise; the other switches do not matter (design §8.1)', () => {
    for (const value of [undefined, '', 'TRUE', '1', ' true', 'true ', 'false']) {
      expect(createTaskDeliveryChannelsFromEnv({
        ...ON, TASKS_SCHEDULER_ENABLED: 'true', TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: value,
      }), String(value)).toEqual([])
    }
    expect(createTaskDeliveryChannelsFromEnv({})).toEqual([])
    const channels = createTaskDeliveryChannelsFromEnv({ TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true' })
    expect(channels).toHaveLength(1)
    expect(channels[0]).toBeInstanceOf(DingTalkTaskDeliveryChannel)
    expect(channels[0].name).toBe(TASK_NOTIFICATION_CHANNEL_DINGTALK)
  })
})

describe('statements and the steps of one row (design §7.2)', () => {
  it('sweeps, claim, materialisation reads, prepare, materialisation reads again, fence, send, terminal write — in that order; the fence follows the last read', async () => {
    const { query, log } = scriptedQuery({ claimed: [claimedEventRow()] })
    const counter = recordingCounter()
    const result = await worker(query, recordingChannel(log), { metrics: counter }).runBatch()
    expect(result).toMatchObject({ claimed: 1, sent: 1, lostLease: 0, released: 0 })
    const steps = log.map((entry) => {
      if (entry.sql.includes('lease_expired_after_send_started')) return 'sweep-unknown'
      if (entry.sql.includes('attempts_exhausted')) return 'sweep-exhausted'
      if (entry.sql.startsWith('WITH claim AS')) return 'claim'
      if (entry.sql.includes("SET status = 'sending'")) return 'fence'
      if (entry.sql.startsWith("UPDATE task_notification_deliveries SET status = 'sent'")) return 'terminal-sent'
      if (entry.sql === '<prepare>' || entry.sql === '<send>') return entry.sql
      return 'read'
    })
    expect(steps).toEqual([
      'sweep-unknown', 'sweep-exhausted', 'claim',
      'read', 'read', 'read', 'read', 'read',
      '<prepare>',
      'read', 'read', 'read', 'read', 'read',
      'fence', '<send>', 'terminal-sent',
    ])
    expect(counter.counts).toEqual({ sent: 1 })
  })

  it('a row that materialisation skips never calls the channel: no prepare, the skip written before any channel call', async () => {
    const { query, log } = scriptedQuery({ claimed: [claimedEventRow()], inactive: true })
    const channel = recordingChannel(log)
    expect(await worker(query, channel).runBatch()).toMatchObject({ claimed: 1, skipped: 1 })
    expect(channel.prepares).toBe(0)
    expect(log.some((entry) => entry.sql === '<prepare>')).toBe(false)
  })

  it('the reminder family: the send-time floor statement counts only the floor event types, bound from TASK_REMINDER_FLOOR_EVENT_TYPES (RULED(2026-10-07): [R06])', async () => {
    const row = claimedEventRow({
      source_type: 'task_reminder',
      source_key: `task_reminder:${TASK}:${REMIND_AT.toISOString()}:recipient:${RECIPIENT}:channel:${TASK_NOTIFICATION_CHANNEL_DINGTALK}`,
      recipient_role: 'creator',
      payload: { kind: 'task_reminder', taskId: TASK, remindAt: REMIND_AT.toISOString() },
    })
    const { query, log } = scriptedQuery({ claimed: [row] })
    const channel = recordingChannel(log)
    expect(await worker(query, channel).runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    const floors = log.filter((entry) => entry.sql.startsWith('SELECT max(occurred_at) AS floor'))
    expect(floors).toHaveLength(2)
    for (const floor of floors) {
      expect(floor.sql).toBe('SELECT max(occurred_at) AS floor FROM task_events WHERE task_id = $1 AND event_type = ANY($2::text[])')
      expect(floor.params).toEqual([TASK, ['created', 'remind_changed']])
      expect(floor.params[1]).toEqual([...TASK_REMINDER_FLOOR_EVENT_TYPES])
    }
    expect(channel.sends).toBe(1)
  })

  it('the claim: one statement under a batch lease, registered channels only, windowed families first, FOR UPDATE SKIP LOCKED', async () => {
    const { query, log } = scriptedQuery()
    await worker(query, recordingChannel(log), { batchSize: 7, maxAttempts: 4 }).runBatch()
    const claim = log.find((entry) => entry.sql.startsWith('WITH claim AS')) as Recorded
    for (const piece of [
      "WHERE status IN ('pending','retrying') AND next_attempt_at <= $1 AND attempt_count < $2",
      'AND (claim_expires_at IS NULL OR claim_expires_at <= $1) AND channel = ANY($5::text[])',
      'ORDER BY (source_type = ANY($7::text[])) DESC, next_attempt_at ASC, created_at ASC, id ASC LIMIT $3 FOR UPDATE SKIP LOCKED',
      "SET claim_worker_id = $4, claimed_at = $1, claim_expires_at = $1::timestamptz + ($6::int * interval '1 millisecond'), attempt_count = d.attempt_count + 1",
    ]) {
      expect(claim.sql).toContain(piece)
    }
    expect(claim.sql.includes('status =')).toBe(false)
    expect(claim.params).toEqual([NOW, 4, 7, 'w-unit', [TASK_NOTIFICATION_CHANNEL_DINGTALK], TASK_DELIVERY_LEASE_MS_DEFAULT, ['task_reminder', 'task_daily']])
  })

  it('the fence: held by this worker at this attempt, still pending / retrying, inside the batch lease; the lease renewed to the send lease', async () => {
    const { query, log } = scriptedQuery({ claimed: [claimedEventRow({ attempt_count: 3 })] })
    await worker(query, recordingChannel(log)).runBatch()
    const fence = log.find((entry) => entry.sql.includes("SET status = 'sending'")) as Recorded
    expect(fence.sql).toBe(
      "UPDATE task_notification_deliveries SET status = 'sending', last_attempt_at = $1, updated_at = $1, " +
        "claim_expires_at = $1::timestamptz + ($5::int * interval '1 millisecond') " +
        "WHERE id = $2::uuid AND claim_worker_id = $3 AND attempt_count = $4 AND status IN ('pending','retrying') " +
        'AND claim_expires_at > $1 RETURNING id',
    )
    expect(fence.params).toEqual([NOW, ROW_ID, 'w-unit', 3, TASK_DELIVERY_SEND_LEASE_MS])
  })

  it('terminal writes: after the fence from sending only; before it from pending / retrying only; both held by worker and attempt', async () => {
    const after = scriptedQuery({ claimed: [claimedEventRow()] })
    await worker(after.query, recordingChannel(after.log)).runBatch()
    const sent = after.log.find((entry) => entry.sql.startsWith("UPDATE task_notification_deliveries SET status = 'sent'")) as Recorded
    expect(sent.sql).toContain('WHERE id = $1::uuid AND claim_worker_id = $2 AND attempt_count = $3 AND status = ANY($4::text[])')
    expect(sent.params.slice(0, 4)).toEqual([ROW_ID, 'w-unit', 1, ['sending']])

    const before = scriptedQuery({ claimed: [claimedEventRow()], inactive: true })
    await worker(before.query, recordingChannel(before.log)).runBatch()
    const skipped = before.log.find((entry) => entry.sql.startsWith("UPDATE task_notification_deliveries SET status = 'skipped'")) as Recorded
    expect(skipped.params).toEqual([ROW_ID, 'w-unit', 1, ['pending', 'retrying'], NOW, 'recipient_inactive_in_org'])
    expect(before.log.some((entry) => entry.sql.includes("SET status = 'sending'"))).toBe(false)
  })

  it('a thrown prepare, materialisation or send is recorded as a fixed code; the exception text reaches no statement', async () => {
    const secret = 'boom token=abc123'
    const cases: Array<{ script: Script; channel: ChannelScript; code: string; status: string }> = [
      { script: {}, channel: { prepare: async () => { throw new Error(secret) } }, code: 'prepare_failed', status: 'retrying' },
      { script: { taskReadThrows: secret }, channel: {}, code: 'materialize_failed', status: 'retrying' },
      { script: {}, channel: { send: async () => { throw new Error(secret) } }, code: 'send_unclassified', status: 'outcome_unknown' },
    ]
    for (const { script, channel, code, status } of cases) {
      const { query, log } = scriptedQuery({ ...script, claimed: [claimedEventRow()] })
      await worker(query, recordingChannel(log, channel)).runBatch()
      const terminal = log.find((entry) =>
        entry.sql.startsWith(`UPDATE task_notification_deliveries SET status = '${status}'`) && entry.sql.includes('WHERE id = $1::uuid')) as Recorded
      expect(terminal, code).toBeDefined()
      expect(terminal.params).toContain(code)
      expect(JSON.stringify(log.map((entry) => entry.params))).not.toContain('abc123')
    }
  })

  it('the unstarted rows go back with the attempt the claim spent: the hand-back is held by worker and attempt', async () => {
    const rows = [claimedEventRow(), claimedEventRow({ id: '3f9a1c2e-2222-4aaa-8bbb-0123456789ab', attempt_count: 2 })]
    const { query, log } = scriptedQuery({ claimed: rows })
    const result = await worker(query, recordingChannel(log)).runBatch({ deadline: NOW.getTime() })
    expect(result).toMatchObject({ claimed: 2, released: 2, sent: 0 })
    const release = log.find((entry) => entry.sql.includes('FROM unnest($2::uuid[], $3::int[])')) as Recorded
    expect(release.sql).toContain('attempt_count = d.attempt_count - 1')
    expect(release.sql).toContain("WHERE d.id = r.id AND d.claim_worker_id = $4 AND d.attempt_count = r.n AND d.status IN ('pending','retrying')")
    expect(release.params).toEqual([NOW, [rows[0].id, rows[1].id], [1, 2], 'w-unit'])
  })

  it('a channel error longer than 1000 characters is stored cut to 1000', async () => {
    const { query, log } = scriptedQuery({ claimed: [claimedEventRow()] })
    const channel = recordingChannel(log, { send: async () => ({ ok: false, retryable: false, error: 'e'.repeat(1500) }) })
    expect(await worker(query, channel).runBatch()).toMatchObject({ failed: 1 })
    const terminal = log.find((entry) =>
      entry.sql.startsWith("UPDATE task_notification_deliveries SET status = 'failed'") && entry.sql.includes('WHERE id = $1::uuid')) as Recorded
    expect(terminal.params[5]).toBe('e'.repeat(1000))
  })

  it('the text sent is the second materialisation\'s: a title that changed between the two reads is sent as it is at the fence (ASSUMPTION(task-m4): [own-3b-37])', async () => {
    const base = scriptedQuery({ claimed: [claimedEventRow()] })
    let taskReads = 0
    const query: TaskDeliveryQuery = async (sql, params) => {
      if (isTaskRead(oneLine(sql))) {
        taskReads += 1
        if (taskReads === 2) return { rows: [{ title: '改名之后', created_by: 'usr_unit_creator' }] }
      }
      return base.query(sql, params)
    }
    const channel = recordingChannel(base.log)
    expect(await worker(query, channel).runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    expect(taskReads).toBe(2)
    expect(channel.messages).toHaveLength(1)
    expect(channel.messages[0].content).toContain('「改名之后」')
    expect(channel.messages[0].content).not.toContain('备料复核')
  })

  it('a statement that throws inside a row: the batch rejects with that error, the rows behind it are handed back once, the budget timer is cleared', async () => {
    const SECOND = '3f9a1c2e-2222-4aaa-8bbb-0123456789ab'
    const THIRD = '3f9a1c2e-3333-4aaa-8bbb-0123456789ab'
    const { query, log } = scriptedQuery({ claimed: [claimedEventRow(), claimedEventRow({ id: SECOND, attempt_count: 2 }), claimedEventRow({ id: THIRD })], fenceThrows: 'fence refused by the test' })
    const timers: Array<{ cleared: boolean }> = []
    const timer = {
      set: () => {
        const entry = { cleared: false }
        timers.push(entry)
        return entry
      },
      clear: (handle: unknown) => {
        if (handle) (handle as { cleared: boolean }).cleared = true
      },
    }
    const channel = recordingChannel(log)
    await expect(worker(query, channel, { timers: timer }).runBatch()).rejects.toThrow('fence refused by the test')
    const releases = log.filter((entry) => entry.sql.includes('FROM unnest($2::uuid[], $3::int[])'))
    expect(releases).toHaveLength(1)
    expect(releases[0].params).toEqual([NOW, [SECOND, THIRD], [2, 1], 'w-unit'])
    expect(timers).toEqual([{ cleared: true }])
    expect(channel.sends).toBe(0)
  }, 3000)
})

describe('the stop signal and the row budget while a row is in flight (design §6.6, §7.2; ASSUMPTION(task-m4): [own-3b-36])', () => {
  const SECOND = '3f9a1c2e-2222-4aaa-8bbb-0123456789ab'
  const THIRD = '3f9a1c2e-3333-4aaa-8bbb-0123456789ab'
  const threeRows = (): Row[] => [claimedEventRow(), claimedEventRow({ id: SECOND, attempt_count: 2 }), claimedEventRow({ id: THIRD })]
  const releases = (log: Recorded[]): Recorded[] => log.filter((entry) => entry.sql.includes('FROM unnest($2::uuid[], $3::int[])'))
  const fenced = (log: Recorded[]): boolean => log.some((entry) => entry.sql.includes("SET status = 'sending'"))

  it('a stop while the first row is in prepare: the other rows go back before prepare returns; the row in flight goes back when it returns, unfenced (through runUntilIdle)', async () => {
    const { query, log } = scriptedQuery({ claimed: threeRows() })
    const gate = deferred()
    const channel = recordingChannel(log, {
      prepare: async () => {
        await gate.promise
        return { ok: true, send: async () => ({ ok: true }) }
      },
    })
    const controller = new AbortController()
    const run = worker(query, channel).runUntilIdle({ budgetMs: 60_000, stopSignal: controller.signal })
    await vi.waitFor(() => expect(channel.prepares).toBe(1))
    expect(releases(log)).toHaveLength(0)
    controller.abort()
    await vi.waitFor(() => expect(releases(log)).toHaveLength(1))
    expect(releases(log)[0].params).toEqual([NOW, [SECOND, THIRD], [2, 1], 'w-unit'])
    gate.resolve()
    const { batches, totals } = await run
    expect(batches).toBe(1)
    expect(totals).toMatchObject({ claimed: 3, released: 3, sent: 0, lostLease: 0 })
    expect(releases(log)).toHaveLength(2)
    expect(releases(log)[1].params).toEqual([NOW, [ROW_ID], [1], 'w-unit'])
    expect(fenced(log)).toBe(false)
    // The row in flight is handed back right after prepare returns: the state is not read a second time.
    expect(log.filter((entry) => isMembershipRead(entry.sql))).toHaveLength(1)
  })

  it('a stop while the first row is in its first materialisation: no channel call is started; the row is handed back when its read returns', async () => {
    const base = scriptedQuery({ claimed: threeRows() })
    const gate = deferred()
    const inRead = deferred()
    const query = hooked(base.query, isMembershipRead, async (index) => {
      if (index === 0) {
        inRead.resolve()
        await gate.promise
      }
    })
    const channel = recordingChannel(base.log)
    const controller = new AbortController()
    const run = worker(query, channel).runBatch({ stopSignal: controller.signal })
    await inRead.promise
    controller.abort()
    await vi.waitFor(() => expect(releases(base.log)).toHaveLength(1))
    expect(releases(base.log)[0].params).toEqual([NOW, [SECOND, THIRD], [2, 1], 'w-unit'])
    gate.resolve()
    expect(await run).toMatchObject({ claimed: 3, released: 3, sent: 0, lostLease: 0 })
    expect(channel.prepares).toBe(0)
    expect(releases(base.log)).toHaveLength(2)
    expect(releases(base.log)[1].params).toEqual([NOW, [ROW_ID], [1], 'w-unit'])
    expect(fenced(base.log)).toBe(false)
  })

  it('an interrupt while the last row of the batch is in flight sends no hand-back statement for the rows behind it (there are none); the row itself goes back once', async () => {
    const { query, log } = scriptedQuery({ claimed: [claimedEventRow()] })
    const gate = deferred()
    const channel = recordingChannel(log, {
      prepare: async () => {
        await gate.promise
        return { ok: true, send: async () => ({ ok: true }) }
      },
    })
    const controller = new AbortController()
    const run = worker(query, channel).runBatch({ stopSignal: controller.signal })
    await vi.waitFor(() => expect(channel.prepares).toBe(1))
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(releases(log)).toHaveLength(0)
    gate.resolve()
    expect(await run).toMatchObject({ claimed: 1, released: 1, sent: 0 })
    expect(releases(log)).toHaveLength(1)
    expect(releases(log)[0].params).toEqual([NOW, [ROW_ID], [1], 'w-unit'])
    for (const release of releases(log)) expect((release.params[1] as string[]).length).toBeGreaterThan(0)
  })

  it('a stop while the first row is in its send, past the fence: the other rows go back at once; the row finishes as sent', async () => {
    const { query, log } = scriptedQuery({ claimed: threeRows() })
    const gate = deferred()
    const channel = recordingChannel(log, {
      send: async () => {
        await gate.promise
        return { ok: true }
      },
    })
    const controller = new AbortController()
    const run = worker(query, channel).runBatch({ stopSignal: controller.signal })
    await vi.waitFor(() => expect(channel.sends).toBe(1))
    expect(releases(log)).toHaveLength(0)
    controller.abort()
    await vi.waitFor(() => expect(releases(log)).toHaveLength(1))
    expect(releases(log)[0].params).toEqual([NOW, [SECOND, THIRD], [2, 1], 'w-unit'])
    gate.resolve()
    expect(await run).toMatchObject({ claimed: 3, sent: 1, released: 2, lostLease: 0 })
    expect(releases(log)).toHaveLength(1)
  })

  it('an already aborted stop signal: no statement at all', async () => {
    const { query, log } = scriptedQuery({ claimed: threeRows() })
    const controller = new AbortController()
    controller.abort()
    expect((await worker(query, recordingChannel(log)).runBatch({ stopSignal: controller.signal })).claimed).toBe(0)
    expect((await worker(query, recordingChannel(log)).runUntilIdle({ budgetMs: 60_000, stopSignal: controller.signal })).batches).toBe(0)
    expect(log).toEqual([])
  })

  it('the row budget: while a row is over it the rest goes back on the timer; the row itself is not fenced and ends retrying / row_budget_exceeded', async () => {
    const { query, log } = scriptedQuery({ claimed: threeRows() })
    const gate = deferred()
    const channel = recordingChannel(log, {
      prepare: async () => {
        await gate.promise
        return { ok: true, send: async () => ({ ok: true }) }
      },
    })
    const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
    const timer = {
      set: (callback: () => void, ms: number) => {
        const entry = { callback, ms, cleared: false }
        timers.push(entry)
        return entry
      },
      clear: (handle: unknown) => {
        if (handle) (handle as { cleared: boolean }).cleared = true
      },
    }
    let at = NOW
    const run = worker(query, channel, { timers: timer, now: () => at }).runBatch()
    await vi.waitFor(() => expect(channel.prepares).toBe(1))
    expect(timers.map((entry) => entry.ms)).toEqual([TASK_DELIVERY_ROW_BUDGET_MS])
    expect(TASK_DELIVERY_ROW_BUDGET_MS).toBe(15_000)
    expect(releases(log)).toHaveLength(0)
    timers[0].callback()
    await vi.waitFor(() => expect(releases(log)).toHaveLength(1))
    expect(releases(log)[0].params).toEqual([NOW, [SECOND, THIRD], [2, 1], 'w-unit'])
    at = new Date(NOW.getTime() + TASK_DELIVERY_ROW_BUDGET_MS + 1)
    gate.resolve()
    expect(await run).toMatchObject({ claimed: 3, retrying: 1, released: 2, sent: 0, lostLease: 0 })
    const terminal = log.find((entry) => entry.sql.startsWith("UPDATE task_notification_deliveries SET status = 'retrying'")) as Recorded
    expect(terminal.params.slice(0, 3)).toEqual([ROW_ID, 'w-unit', 1])
    expect(terminal.params).toContain('row_budget_exceeded')
    expect(fenced(log)).toBe(false)
    expect(channel.sends).toBe(0)
    expect(releases(log)).toHaveLength(1)
  })

  it('a row that settles inside its budget: one timer per row, set for the budget and cleared when the row settles, never fired; no abort listener is left on the stop signal', async () => {
    const { query, log } = scriptedQuery({ claimed: threeRows() })
    const timers: Array<{ ms: number; cleared: boolean; fired: boolean }> = []
    const timer = {
      set: (_callback: () => void, ms: number) => {
        const entry = { ms, cleared: false, fired: false }
        timers.push(entry)
        return entry
      },
      clear: (handle: unknown) => {
        if (handle) (handle as { cleared: boolean }).cleared = true
      },
    }
    const controller = new AbortController()
    expect(await worker(query, recordingChannel(log), { timers: timer }).runBatch({ stopSignal: controller.signal })).toMatchObject({ claimed: 3, sent: 3, released: 0 })
    expect(timers).toEqual([
      { ms: TASK_DELIVERY_ROW_BUDGET_MS, cleared: true, fired: false },
      { ms: TASK_DELIVERY_ROW_BUDGET_MS, cleared: true, fired: false },
      { ms: TASK_DELIVERY_ROW_BUDGET_MS, cleared: true, fired: false },
    ])
    // The stop signal lives as long as the process: each settled row has taken its listener off it.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  describe('each of the three budget checks on its own (ASSUMPTION(task-m4): [own-3b-36])', () => {
    const over = new Date(NOW.getTime() + TASK_DELIVERY_ROW_BUDGET_MS + 1)
    const terminalRetrying = (log: Recorded[]): Recorded | undefined =>
      log.find((entry) => entry.sql.startsWith("UPDATE task_notification_deliveries SET status = 'retrying'"))

    it('over budget after the first materialisation: the channel is never called, retrying / row_budget_exceeded, not fenced', async () => {
      const base = scriptedQuery({ claimed: [claimedEventRow()] })
      let at = NOW
      const query = hooked(base.query, isMembershipRead, (index) => {
        if (index === 0) at = over
      })
      const channel = recordingChannel(base.log)
      expect(await worker(query, channel, { now: () => at }).runBatch()).toMatchObject({ claimed: 1, retrying: 1, sent: 0 })
      expect(channel.prepares).toBe(0)
      expect(terminalRetrying(base.log)?.params).toContain('row_budget_exceeded')
      expect(fenced(base.log)).toBe(false)
    })

    it('over budget after prepare: the prepared closure is dropped and the state is not read again, retrying / row_budget_exceeded, not fenced', async () => {
      const { query, log } = scriptedQuery({ claimed: [claimedEventRow()] })
      let at = NOW
      const channel = recordingChannel(log, {
        prepare: async () => {
          at = over
          return { ok: true, send: async () => ({ ok: true }) }
        },
      })
      expect(await worker(query, channel, { now: () => at }).runBatch()).toMatchObject({ claimed: 1, retrying: 1, sent: 0 })
      expect(channel.prepares).toBe(1)
      expect(channel.sends).toBe(0)
      expect(log.filter((entry) => isMembershipRead(entry.sql))).toHaveLength(1)
      expect(terminalRetrying(log)?.params).toContain('row_budget_exceeded')
      expect(fenced(log)).toBe(false)
    })

    it('over budget after the second materialisation: not fenced, nothing sent, retrying / row_budget_exceeded', async () => {
      const base = scriptedQuery({ claimed: [claimedEventRow()] })
      let at = NOW
      const query = hooked(base.query, isMembershipRead, (index) => {
        if (index === 1) at = over
      })
      const channel = recordingChannel(base.log)
      expect(await worker(query, channel, { now: () => at }).runBatch()).toMatchObject({ claimed: 1, retrying: 1, sent: 0 })
      expect(channel.prepares).toBe(1)
      expect(channel.sends).toBe(0)
      expect(base.log.filter((entry) => isMembershipRead(entry.sql))).toHaveLength(2)
      expect(terminalRetrying(base.log)?.params).toContain('row_budget_exceeded')
      expect(fenced(base.log)).toBe(false)
    })
  })
})

describe('the outcome counter (ASSUMPTION(task-m4): [own-3b-11])', () => {
  it('one increment per terminal write, the sweeps by their row counts, nothing for a lost lease', async () => {
    const counter = recordingCounter()
    const { query, log } = scriptedQuery({ claimed: [claimedEventRow()], sweptUnknown: 2, sweptExhausted: 3, terminalLost: true })
    const result = await worker(query, recordingChannel(log), { metrics: counter }).runBatch()
    expect(result).toMatchObject({ lostLease: 1, sent: 0, swept: { outcomeUnknown: 2, exhausted: 3 } })
    expect(counter.counts).toEqual({ outcome_unknown: 2, failed: 3 })
  })

  it('tasks_notification_deliveries_total is registered with a zero sample for each of the five outcomes', async () => {
    const metric = (await registry.getMetricsAsJSON()).find((entry) => entry.name === 'tasks_notification_deliveries_total')
    expect(metric?.type).toBe('counter')
    const outcomes = (metric?.values ?? []).map((value) => value.labels.outcome).sort()
    expect(outcomes).toEqual([...TASK_DELIVERY_OUTCOMES].sort())
  })
})
