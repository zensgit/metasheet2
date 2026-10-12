import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { setTaskListArchived } from '../../src/services/task-list-records'
import {
  createTaskDeliveryChannelsFromEnv,
  TaskNotificationDeliveryWorker,
  type TaskDeliveryBatchResult,
  type TaskDeliveryChannelResult,
  type TaskDeliveryQuery,
  type TaskDeliveryTimers,
} from '../../src/services/task-notification-delivery-worker'
import { insertTaskNotificationDeliveries } from '../../src/services/task-notification-producer'
import { completeTask, createTask } from '../../src/services/task-records'
import { deleteTaskById, leaveTask } from '../../src/services/task-structure'
import { viewerToday } from '../../src/tasks/task-dates'
import {
  TASK_DELIVERY_BACKOFF_LADDER_MS,
  TASK_DELIVERY_LEASE_MS_DEFAULT,
  TASK_DELIVERY_ROW_BUDGET_MS,
  TASK_DELIVERY_SEND_LEASE_MS,
} from '../../src/tasks/task-delivery-protocol'
import { TASK_DIGEST_MAX_ITEMS } from '../../src/tasks/task-notification-text'
import {
  planTaskDailyDigestDelivery,
  planTaskEventDeliveries,
  planTaskListEventDeliveries,
  planTaskReminderDeliveries,
  TASK_NOTIFICATION_CHANNEL_DINGTALK,
  type TaskNotifiableEvent,
  type TaskNotificationDeliveryPlan,
  type TaskNotificationRecipientRole,
} from '../../src/tasks/task-notifications'
import { computeDailyDigestSendAt, TASK_REMINDER_SCAN_WINDOW_MS } from '../../src/tasks/task-reminders'
import {
  deferred,
  dropTaskM4Fixtures,
  FakeTaskDeliveryChannel,
  runSourceMutant,
  seedOrgDingTalkIntegration,
  seedOrgMembers,
  seedOutboxRow,
  steppedClock,
  type FakeDeliveryCall,
  type FakeTaskDeliveryChannelOptions,
  type SeedOutboxRowInput,
  type SteppedClock,
} from '../helpers/task-m4-fixtures'

/**
 * M4 PR-3b S4 (design task-m4-pr3b-backend-design-20261001.md §7, §11.2, §11.4–§11.6; candidate
 * rows M4-a, M4-c, M4-d and the gate 1 M4 subset; the rows R01 numbers are not in the lock yet, so
 * these cells are candidates, not scored).
 *
 * The delivery worker on a real database with fake channels (one per worker, recording every
 * prepare / send with the delivery id) and stepped clocks: no sleep anywhere. Rows are seeded
 * through the four planners (the producer's row shape) or written by the producer itself; the
 * worker is the only reader under test.
 *
 * ASSUMPTION(task-m4): [own-3b-04] effect fence and hand-back, [own-3b-05] the skip codes,
 * [own-3b-08] the constants, [own-3b-14] 24 h freshness, [own-3b-16] windowed families first,
 * [own-3b-17] the any-state by-id builder, [own-3b-26] the switches read at construction,
 * [own-3b-27] a payload belongs to its row, [own-3b-28] a reminder without a floor is not sent,
 * [own-3b-36] the row budget and the hand-back of the rows behind a row that runs over it,
 * [own-3b-37] materialisation before prepare (a skipped row never calls the channel).
 * RULED(2026-10-07): [R17] send-time membership, [R06] reminder skips, [R07] one skipped row for an
 * empty digest, [R05] [D13] who keeps receiving an event.
 *
 * Row isolation: claim and both sweeps are cross-org, so every cell starts with an empty
 * `task_notification_deliveries` (design §11.1: the lane runs files one at a time) and asserts only
 * on the rows it seeded or produced.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-delivery.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4deliv_'
const CHANNEL = TASK_NOTIFICATION_CHANNEL_DINGTALK
const WORKER_ON: NodeJS.ProcessEnv = { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' }
const seededUsers: string[] = []

const WORKER_FILE = new URL('../../src/services/task-notification-delivery-worker.ts', import.meta.url).pathname
const ACCESS_FILE = new URL('../../src/tasks/task-access.ts', import.meta.url).pathname
const LIST_ACCESS_FILE = new URL('../../src/tasks/task-list-access.ts', import.meta.url).pathname

const PRODUCER_SWITCHES = [
  'TASKS_SCHEDULER_ENABLED',
  'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED',
  'TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED',
] as const

const ZERO_BATCH: TaskDeliveryBatchResult = {
  claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0, outcomeUnknown: 0, lostLease: 0, released: 0,
  swept: { outcomeUnknown: 0, exhausted: 0 },
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Runs `write` with the three producer switches on, then turns them off again. */
async function withProducerOn<T>(write: () => Promise<T>): Promise<T> {
  for (const key of PRODUCER_SWITCHES) process.env[key] = 'true'
  try {
    return await write()
  } finally {
    for (const key of PRODUCER_SWITCHES) delete process.env[key]
  }
}

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

function ago(at: Date, ms: number): Date {
  return new Date(at.getTime() - ms)
}

function later(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms)
}

async function members(orgId: string, ...userIds: string[]): Promise<void> {
  await seedOrgMembers(orgId, userIds)
  seededUsers.push(...userIds)
}

async function databaseNow(): Promise<Date> {
  const result = await poolManager.get().query('SELECT now() AS now')
  return new Date(result.rows[0].now as Date)
}

/**
 * A worker clock one second after the database clock: later than every `next_attempt_at` the
 * preceding writes took from `now()`. (A JS Date keeps milliseconds only, so the database clock read
 * in the same millisecond as such a write can sort before it.)
 */
async function clockAfterWrites(): Promise<SteppedClock> {
  return steppedClock(later(await databaseNow(), 1000))
}

interface TaskFixture {
  orgId: string
  stamp: string
  creator: string
  assignee: string
  follower: string
  taskId: string
}

/** An org with an active creator, assignee and follower, and one `all`-mode task. */
async function taskFixture(label: string, opts: { title?: string } = {}): Promise<TaskFixture> {
  const stamp = stampOf()
  const orgId = orgOf(label, stamp)
  const creator = `usrC_${label}_${stamp}`
  const assignee = `usrA_${label}_${stamp}`
  const follower = `usrF_${label}_${stamp}`
  await members(orgId, creator, assignee, follower)
  const task = await createTask({ orgId, creatorId: creator, title: opts.title ?? '备料复核', assignees: [assignee], completionMode: 'all' })
  await follow(task.id, follower)
  return { orgId, stamp, creator, assignee, follower, taskId: task.id }
}

async function follow(taskId: string, ...userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [taskId, userId])
  }
}

async function seedList(orgId: string, createdBy: string, listMembers: Array<[string, 'read' | 'edit' | 'owner']>, taskIds: string[]): Promise<string> {
  const db = poolManager.get()
  const listId = newTaskListId()
  await db.query('INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)', [listId, orgId, '月度备料', createdBy])
  for (const [userId, role] of listMembers) {
    await db.query('INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)', [listId, userId, role])
  }
  for (const taskId of taskIds) {
    await db.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, taskId, orgId])
  }
  return listId
}

type SeedExtra = Partial<Omit<SeedOutboxRowInput, 'orgId' | 'sourceType' | 'sourceId' | 'sourceKey' | 'recipientUserId' | 'recipientRole' | 'channel'>>

async function seedPlan(plan: TaskNotificationDeliveryPlan, extra: SeedExtra = {}): Promise<string> {
  return seedOutboxRow({
    orgId: plan.orgId,
    sourceType: plan.sourceType,
    sourceId: plan.sourceId,
    sourceKey: plan.sourceKey,
    recipientUserId: plan.recipientUserId,
    recipientRole: plan.recipientRole,
    channel: plan.channel,
    payload: plan.payload as unknown as Record<string, unknown>,
    ...extra,
  })
}

/** One `task_event` row through the planner (a fresh event id unless given). */
async function seedEventRow(
  target: { orgId: string; taskId: string },
  recipient: string,
  opts: { event?: TaskNotifiableEvent; role?: TaskNotificationRecipientRole; actorId?: string; eventId?: string } & SeedExtra = {},
): Promise<string> {
  const { event, role, actorId, eventId, ...extra } = opts
  const [plan] = planTaskEventDeliveries({
    orgId: target.orgId,
    taskId: target.taskId,
    eventId: eventId ?? `tev_s4${stampOf()}`,
    event: event ?? 'commented',
    actorId: actorId ?? 'usr_s4_actor',
    recipients: [{ userId: recipient, recipientRole: role ?? 'follower' }],
    channels: [CHANNEL],
  })
  return seedPlan(plan, extra)
}

/** One `task_list_event` (archived) row for the list's creator `recipient`. */
async function seedListRow(orgId: string, listId: string, recipient: string, actorId: string, extra: SeedExtra = {}): Promise<string> {
  const [plan] = planTaskListEventDeliveries({
    orgId, listId, eventId: `tlev_s4${stampOf()}`, event: 'archived', listCreatorId: recipient, actorId, channels: [CHANNEL],
  })
  return seedPlan(plan, extra)
}

interface WorkerKit {
  worker: TaskNotificationDeliveryWorker
  channel: FakeTaskDeliveryChannel
}

function makeWorker(
  label: string,
  clock: SteppedClock,
  opts: Omit<FakeTaskDeliveryChannelOptions, 'label' | 'clock'> & { batchSize?: number; maxAttempts?: number; env?: NodeJS.ProcessEnv; timers?: TaskDeliveryTimers } = {},
): WorkerKit {
  const { batchSize, maxAttempts, env, timers, ...fake } = opts
  const channel = new FakeTaskDeliveryChannel({ label, clock, ...fake })
  const worker = new TaskNotificationDeliveryWorker({
    channels: [channel],
    now: clock.now,
    workerId: `w-${label}-${stampOf()}`,
    batchSize,
    maxAttempts,
    env: env ?? WORKER_ON,
    timers,
  })
  return { worker, channel }
}

/** Polls `check` every 25 ms until it returns true or the deadline passes. */
async function until(check: () => Promise<boolean>, deadlineMs: number, what: string): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

interface DeliveryRow {
  id: string
  org_id: string
  source_type: string
  source_id: string
  recipient_user_id: string
  recipient_role: string
  status: string
  attempt_count: number
  next_attempt_at: Date
  last_attempt_at: Date | null
  claimed_at: Date | null
  claim_expires_at: Date | null
  claim_worker_id: string | null
  delivered_at: Date | null
  last_error: string | null
  payload: Record<string, unknown>
  payload_text: string
  redelivery_safe: boolean
}

async function rowOf(id: string): Promise<DeliveryRow> {
  const result = await poolManager.get().query<DeliveryRow>(
    `SELECT id::text AS id, org_id, source_type, source_id, recipient_user_id, recipient_role, status, attempt_count,
            next_attempt_at, last_attempt_at, claimed_at, claim_expires_at, claim_worker_id, delivered_at, last_error,
            payload, payload::text AS payload_text, redelivery_safe
       FROM task_notification_deliveries WHERE id = $1::uuid`,
    [id],
  )
  expect(result.rows, `outbox row ${id}`).toHaveLength(1)
  return result.rows[0]
}

/** Every column of each row as JSON text: equal text = the row was not touched. */
async function rowTexts(ids: string[]): Promise<string[]> {
  const out: string[] = []
  for (const id of ids) {
    const result = await poolManager.get().query<{ t: string }>(
      'SELECT row_to_json(d)::text AS t FROM task_notification_deliveries d WHERE id = $1::uuid',
      [id],
    )
    out.push(result.rows[0].t)
  }
  return out
}

async function rowsOfSource(sourceId: string): Promise<DeliveryRow[]> {
  const result = await poolManager.get().query<{ id: string }>(
    `SELECT id::text AS id FROM task_notification_deliveries WHERE source_id = $1 ORDER BY recipient_user_id COLLATE "C"`,
    [sourceId],
  )
  const rows: DeliveryRow[] = []
  for (const row of result.rows) rows.push(await rowOf(row.id))
  return rows
}

function sends(calls: FakeDeliveryCall[]): string[] {
  return calls.filter((call) => call.phase === 'send').map((call) => call.deliveryId)
}

function tag(id: string): string {
  return `编号 ${id.slice(0, 8)}`
}

beforeEach(async () => {
  await poolManager.get().query('DELETE FROM task_notification_deliveries')
})

afterAll(async () => {
  for (const key of PRODUCER_SWITCHES) delete process.env[key]
  await poolManager.get().query('DELETE FROM task_notification_deliveries WHERE left(org_id, length($1)) = $1', [ORG_PREFIX])
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers })
})

// ── The worker switch ────────────────────────────────────────────────────────────────────────────

describe('the worker switch (ASSUMPTION(task-m4): [own-3b-26] [own-3b-06])', () => {
  it('unless TASKS_ENABLED and the worker switch are both exactly true the worker sends no statement: an expired sending row, a spent row and a due row stay as they are; both on ⇒ all three move', async () => {
    const f = await taskFixture('off')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const at = ago(base, MINUTE)
    const expired = await seedEventRow(f, f.follower, {
      status: 'sending', attemptCount: 1, claimExpiresAt: ago(base, MINUTE), claimWorkerId: 'w-gone', nextAttemptAt: ago(base, 2 * MINUTE),
    })
    const spent = await seedEventRow(f, f.creator, { role: 'creator', attemptCount: 5, nextAttemptAt: at })
    const due = await seedEventRow(f, f.assignee, { role: 'assignee', nextAttemptAt: at })
    const before = await rowTexts([expired, spent, due])
    const offEnvs: NodeJS.ProcessEnv[] = [
      {},
      { TASKS_ENABLED: 'true' },
      { TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' },
      { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'TRUE' },
      { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: ' true' },
      { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: '1' },
      { TASKS_ENABLED: 'TRUE', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' },
    ]
    for (const env of offEnvs) {
      const { worker, channel } = makeWorker('off', clock, { env })
      expect(worker.enabled, JSON.stringify(env)).toBe(false)
      expect(await worker.runBatch()).toEqual(ZERO_BATCH)
      expect((await worker.runUntilIdle({ budgetMs: MINUTE })).batches).toBe(0)
      expect(channel.calls).toEqual([])
    }
    // The default reads process.env, where the lane sets TASKS_ENABLED and never the worker switch.
    expect(process.env.TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED).toBeUndefined()
    const byDefault = new TaskNotificationDeliveryWorker({ channels: [new FakeTaskDeliveryChannel({ label: 'default' })], now: clock.now })
    expect(byDefault.enabled).toBe(false)
    expect(await byDefault.runBatch()).toEqual(ZERO_BATCH)
    expect(await rowTexts([expired, spent, due])).toEqual(before)

    const on = makeWorker('on', clock)
    expect(on.worker.enabled).toBe(true)
    const result = await on.worker.runBatch()
    expect(result).toEqual({ ...ZERO_BATCH, claimed: 1, sent: 1, swept: { outcomeUnknown: 1, exhausted: 1 } })
    expect(await rowOf(expired)).toMatchObject({ status: 'outcome_unknown', last_error: 'lease_expired_after_send_started' })
    expect(await rowOf(spent)).toMatchObject({ status: 'failed', last_error: 'attempts_exhausted', redelivery_safe: true })
    expect(await rowOf(due)).toMatchObject({ status: 'sent', attempt_count: 1 })
  })

  it('the worker switch on but the DingTalk channel flag not exactly true: no channel is registered, a claim selects nothing and a due row keeps attempt 0 and no lease (with the flag on the channel is registered)', async () => {
    const all = { ...WORKER_ON, TASKS_SCHEDULER_ENABLED: 'true', TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'TRUE' }
    expect(createTaskDeliveryChannelsFromEnv(all)).toEqual([])
    expect(createTaskDeliveryChannelsFromEnv({})).toEqual([])
    expect(createTaskDeliveryChannelsFromEnv({ ...all, TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true' }).map((channel) => channel.name)).toEqual([CHANNEL])
    const f = await taskFixture('nochan')
    const base = await databaseNow()
    const due = await seedEventRow(f, f.follower, { nextAttemptAt: ago(base, MINUTE) })
    const before = await rowTexts([due])
    const worker = new TaskNotificationDeliveryWorker({ channels: createTaskDeliveryChannelsFromEnv(all), now: steppedClock(base).now, env: all })
    expect(worker.enabled).toBe(true)
    expect(await worker.runBatch()).toEqual(ZERO_BATCH)
    expect(await rowTexts([due])).toEqual(before)
  })
})

// ── Claim, fence, terminal write ─────────────────────────────────────────────────────────────────

describe('claim, fence and terminal write (design §7.2, §11.6)', () => {
  it('one due row: claimed, prepared, fenced to sending with the send lease, sent once, then sent with its columns', async () => {
    const f = await taskFixture('one', { title: '季度备料复核' })
    const base = await databaseNow()
    const clock = steppedClock(base)
    const id = await seedEventRow(f, f.follower, { event: 'completed', nextAttemptAt: ago(base, MINUTE) })
    let atSend: DeliveryRow | undefined
    const { worker, channel } = makeWorker('one', clock, {
      onSend: async () => {
        atSend = await rowOf(id)
        return { ok: true }
      },
    })
    expect(await worker.runBatch()).toEqual({ ...ZERO_BATCH, claimed: 1, sent: 1 })
    expect(channel.calls.map((call) => [call.phase, call.deliveryId, call.orgId, call.recipientUserId])).toEqual([
      ['prepare', id, f.orgId, f.follower],
      ['send', id, f.orgId, f.follower],
    ])
    // At the send the row is fenced: sending, held by this worker, lease renewed to exactly one send.
    expect(atSend).toMatchObject({ status: 'sending', claim_worker_id: worker.workerId, attempt_count: 1 })
    expect(atSend?.claim_expires_at?.getTime()).toBe(base.getTime() + TASK_DELIVERY_SEND_LEASE_MS)
    expect(atSend?.last_attempt_at?.getTime()).toBe(base.getTime())
    const row = await rowOf(id)
    expect(row).toMatchObject({
      status: 'sent', attempt_count: 1, claim_worker_id: null, claim_expires_at: null, last_error: null, redelivery_safe: false,
    })
    expect(row.delivered_at?.getTime()).toBe(base.getTime())
    expect(row.claimed_at?.getTime()).toBe(base.getTime())
    expect(channel.calls[1].title).toBe('任务动态')
    expect(channel.calls[1].content).toBe(`任务「季度备料复核」已完成\n\n${tag(id)}`)
  })

  it('the text sent is read after prepare: a title renamed while the row is in prepare is sent new (ASSUMPTION(task-m4): [own-3b-37])', async () => {
    const f = await taskFixture('retitle', { title: '改名之前' })
    const base = await databaseNow()
    const id = await seedEventRow(f, f.follower, { event: 'completed', nextAttemptAt: ago(base, MINUTE) })
    const { worker, channel } = makeWorker('retitle', steppedClock(base), {
      onPrepare: async () => {
        await poolManager.get().query('UPDATE tasks SET title = $2 WHERE id = $1', [f.taskId, '改名之后'])
      },
    })
    expect(await worker.runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    const call = channel.calls.find((c) => c.phase === 'send')
    expect(call?.content).toBe(`任务「改名之后」已完成\n\n${tag(id)}`)
    expect(await rowOf(id)).toMatchObject({ status: 'sent' })
  })

  it('a statement that throws inside a row (the fence, here): the batch rejects, the row behind it is handed back unspent and sent by another worker; the row itself keeps its claim until the lease runs out, then another worker sends it on its next attempt', async () => {
    const f = await taskFixture('throws')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const at = ago(base, MINUTE)
    const first = await seedEventRow(f, f.follower, { nextAttemptAt: at, createdAt: at })
    const second = await seedEventRow(f, f.creator, { role: 'creator', nextAttemptAt: at, createdAt: later(at, 1000) })
    const channel = new FakeTaskDeliveryChannel({ label: 'throws', clock })
    const query: TaskDeliveryQuery = async (sql, params) => {
      if (sql.includes("SET status = 'sending'") && params?.[1] === first) {
        throw Object.assign(new Error('fence refused by the test'), { code: '57P01' })
      }
      const result = await poolManager.get().query(sql, params)
      return { rows: result.rows }
    }
    const worker = new TaskNotificationDeliveryWorker({ channels: [channel], query, now: clock.now, workerId: `w-throws-${stampOf()}`, env: WORKER_ON })
    await expect(worker.runBatch()).rejects.toThrow('fence refused by the test')
    expect(channel.sentIds()).toEqual([])
    expect(await rowOf(second)).toMatchObject({ status: 'pending', attempt_count: 0, claim_worker_id: null, claim_expires_at: null })
    expect(await rowOf(first)).toMatchObject({ status: 'pending', attempt_count: 1, claim_worker_id: worker.workerId })
    const other = makeWorker('throwsB', clock)
    expect(await other.worker.runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    expect(await rowOf(second)).toMatchObject({ status: 'sent', attempt_count: 1 })
    expect(await rowOf(first)).toMatchObject({ status: 'pending', attempt_count: 1, claim_worker_id: worker.workerId })
    clock.advance(TASK_DELIVERY_LEASE_MS_DEFAULT + 1000)
    expect(await other.worker.runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    expect(await rowOf(first)).toMatchObject({ status: 'sent', attempt_count: 2 })
    expect(other.channel.sentIds()).toEqual([second, first])
  }, 10000)

  it('two workers interleaved: each claims its own five rows, every row is sent exactly once, no lease is lost', async () => {
    const f = await taskFixture('pair')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const at = ago(base, MINUTE)
    const ids: string[] = []
    for (let i = 0; i < 10; i += 1) ids.push(await seedEventRow(f, f.follower, { nextAttemptAt: at, createdAt: at }))
    const sorted = [...ids].sort()
    const calls: FakeDeliveryCall[] = []
    const d1 = deferred()
    const atPrepare1 = deferred()
    const d2 = deferred()
    const atSend2 = deferred()
    const w1 = makeWorker('w1', clock, {
      calls,
      batchSize: 5,
      onPrepare: async (_target, index) => {
        if (index === 0) {
          atPrepare1.resolve()
          await d1.promise
        }
      },
    })
    const w2 = makeWorker('w2', clock, {
      calls,
      batchSize: 5,
      onSend: async (_call, index) => {
        if (index === 0) {
          atSend2.resolve()
          await d2.promise
        }
        return { ok: true }
      },
    })
    // ① worker 1 claims five rows and stalls in the first prepare.
    const first = w1.worker.runBatch()
    await atPrepare1.promise
    // ② worker 2 claims the other five and stalls in its first send, past the fence.
    const second = w2.worker.runBatch()
    await atSend2.promise
    // ③ worker 1 finishes, ④ then worker 2.
    d1.resolve()
    const r1 = await first
    d2.resolve()
    const r2 = await second
    expect(r1).toMatchObject({ claimed: 5, sent: 5, lostLease: 0, released: 0 })
    expect(r2).toMatchObject({ claimed: 5, sent: 5, lostLease: 0, released: 0 })
    expect([...w1.channel.sentIds()].sort()).toEqual(sorted.slice(0, 5))
    expect([...w2.channel.sentIds()].sort()).toEqual(sorted.slice(5))
    expect(sends(calls).sort()).toEqual(sorted)
    for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sent', attempt_count: 1 })
  })

  it('a row whose prepare outlives its budget (and the batch lease) is not fenced by that worker: retrying / row_budget_exceeded, the attempt spent; after the back-off the next claim sends it once', async () => {
    const f = await taskFixture('late')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const id = await seedEventRow(f, f.follower, { nextAttemptAt: ago(base, MINUTE) })
    const d = deferred()
    const atPrepare = deferred()
    const w1 = makeWorker('w1', clock, {
      onPrepare: async (_target, index) => {
        if (index === 0) {
          atPrepare.resolve()
          await d.promise
        }
      },
    })
    const first = w1.worker.runBatch()
    await atPrepare.promise
    clock.advance(TASK_DELIVERY_LEASE_MS_DEFAULT + 1000)
    d.resolve()
    expect(await first).toMatchObject({ claimed: 1, sent: 0, retrying: 1, lostLease: 0, released: 0 })
    expect(w1.channel.sentIds()).toEqual([])
    const row = await rowOf(id)
    expect(row).toMatchObject({ status: 'retrying', attempt_count: 1, last_error: 'row_budget_exceeded', claim_worker_id: null, claim_expires_at: null })
    expect(row.next_attempt_at.getTime()).toBe(clock.now().getTime() + TASK_DELIVERY_BACKOFF_LADDER_MS[0])
    const w2 = makeWorker('w2', clock)
    expect((await w2.worker.runBatch()).claimed).toBe(0)
    clock.set(row.next_attempt_at)
    expect(await w2.worker.runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempt_count: 2 })
    expect(w2.channel.sentIds()).toEqual([id])
  })

  it('the fence trusts the row’s lease, not the worker’s: a lease rewritten to the past under a row in prepare (the worker inside its budget) ⇒ the fence refuses, lost lease, no send; the next claim sends it once', async () => {
    const f = await taskFixture('lostlease')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const id = await seedEventRow(f, f.follower, { nextAttemptAt: ago(base, MINUTE) })
    const d = deferred()
    const atPrepare = deferred()
    const w1 = makeWorker('w1', clock, {
      onPrepare: async (_target, index) => {
        if (index === 0) {
          atPrepare.resolve()
          await d.promise
        }
      },
    })
    const first = w1.worker.runBatch()
    await atPrepare.promise
    await poolManager.get().query('UPDATE task_notification_deliveries SET claim_expires_at = $2 WHERE id = $1::uuid', [id, ago(base, 1000)])
    d.resolve()
    expect(await first).toMatchObject({ claimed: 1, sent: 0, lostLease: 1, retrying: 0, released: 0 })
    expect(w1.channel.sentIds()).toEqual([])
    expect(await rowOf(id)).toMatchObject({ status: 'pending', attempt_count: 1, claim_worker_id: w1.worker.workerId })
    const w2 = makeWorker('w2', clock)
    expect(await w2.worker.runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempt_count: 2 })
    expect(w2.channel.sentIds()).toEqual([id])
  })

  it('crash before the fence: worker 1 stalls in prepare past its lease, worker 2 claims and sends; worker 1 then finds nothing to fence', async () => {
    const f = await taskFixture('before')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const id = await seedEventRow(f, f.follower, { nextAttemptAt: ago(base, MINUTE) })
    const d = deferred()
    const atPrepare = deferred()
    const w1 = makeWorker('w1', clock, {
      onPrepare: async (_target, index) => {
        if (index === 0) {
          atPrepare.resolve()
          await d.promise
        }
      },
    })
    const first = w1.worker.runBatch()
    await atPrepare.promise
    clock.advance(TASK_DELIVERY_LEASE_MS_DEFAULT + 1000)
    const w2 = makeWorker('w2', clock)
    expect(await w2.worker.runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    d.resolve()
    expect(await first).toMatchObject({ claimed: 1, sent: 0, lostLease: 1 })
    expect([...w1.channel.sentIds(), ...w2.channel.sentIds()]).toEqual([id])
    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempt_count: 2 })
  })

  it('crash after the fence: worker 1’s send outlives the send lease, worker 2’s sweep writes outcome_unknown and sends nothing, worker 1’s terminal write then finds nothing; the row is never claimed again', async () => {
    const f = await taskFixture('after')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const id = await seedEventRow(f, f.follower, { nextAttemptAt: ago(base, MINUTE) })
    const d = deferred<TaskDeliveryChannelResult>()
    const atSend = deferred()
    const w1 = makeWorker('w1', clock, {
      onSend: async () => {
        atSend.resolve()
        return d.promise
      },
    })
    const first = w1.worker.runBatch()
    await atSend.promise
    clock.advance(TASK_DELIVERY_SEND_LEASE_MS + 1000)
    const w2 = makeWorker('w2', clock)
    expect(await w2.worker.runBatch()).toEqual({ ...ZERO_BATCH, swept: { outcomeUnknown: 1, exhausted: 0 } })
    const swept = await rowOf(id)
    expect(swept).toMatchObject({
      status: 'outcome_unknown', last_error: 'lease_expired_after_send_started', claim_expires_at: null,
      claim_worker_id: w1.worker.workerId, attempt_count: 1, redelivery_safe: false,
    })
    d.resolve({ ok: true })
    expect(await first).toMatchObject({ claimed: 1, sent: 0, lostLease: 1 })
    expect(await rowOf(id)).toMatchObject({ status: 'outcome_unknown', delivered_at: null })
    clock.advance(24 * HOUR)
    expect(await w2.worker.runBatch()).toEqual(ZERO_BATCH)
    expect([...w1.channel.sentIds(), ...w2.channel.sentIds()]).toEqual([id])
  })

  it('a slow channel does not use up attempts: 12 rows, batches of 5, every send 12 s; rows the lease cannot cover go back and every row is sent at attempt 1', async () => {
    const f = await taskFixture('slow')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const at = ago(base, MINUTE)
    const ids: string[] = []
    for (let i = 0; i < 12; i += 1) ids.push(await seedEventRow(f, f.follower, { nextAttemptAt: at, createdAt: at }))
    const { worker, channel } = makeWorker('slow', clock, { batchSize: 5, advanceMsPerSend: 12_000 })
    const { batches, totals } = await worker.runUntilIdle({ budgetMs: 10 * MINUTE })
    expect(totals).toMatchObject({ sent: 12, failed: 0, lostLease: 0, sweptExhausted: 0 })
    expect(totals.released).toBe(6)
    expect(batches).toBe(4)
    expect([...channel.sentIds()].sort()).toEqual([...ids].sort())
    for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sent', attempt_count: 1 })
  })

  it('a row over its budget (ASSUMPTION(task-m4): [own-3b-36]): the row behind it goes back when the budget timer fires, before the slow row returns; another worker sends it on its own attempt; the slow row is not fenced and ends retrying / row_budget_exceeded', async () => {
    const f = await taskFixture('budget')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const at = ago(base, MINUTE)
    const slow = await seedEventRow(f, f.follower, { nextAttemptAt: at, createdAt: at })
    // Claimed behind the slow row, at its last attempt.
    const queued = await seedEventRow(f, f.creator, { role: 'creator', attemptCount: 4, nextAttemptAt: at, createdAt: later(at, 1000) })
    const gate = deferred()
    const atPrepare = deferred()
    const fired: Array<() => void> = []
    const timers: TaskDeliveryTimers = { set: (callback) => { fired.push(callback); return callback }, clear: () => undefined }
    const a = makeWorker('budgetA', clock, {
      timers,
      onPrepare: async (_target, index) => {
        if (index === 0) {
          atPrepare.resolve()
          await gate.promise
        }
      },
    })
    const run = a.worker.runBatch()
    await atPrepare.promise
    expect(await rowOf(queued)).toMatchObject({ status: 'pending', attempt_count: 5, claim_worker_id: a.worker.workerId })
    expect(fired).toHaveLength(1)
    // The slow row's budget runs out: the queued row goes back, attempt returned, while the slow row is still in prepare.
    fired[0]()
    await until(async () => (await rowOf(queued)).claim_worker_id === null, 5000, 'the queued row to be handed back')
    expect(await rowOf(queued)).toMatchObject({ status: 'pending', attempt_count: 4, claim_worker_id: null, claim_expires_at: null, claimed_at: null })
    expect(await rowOf(slow)).toMatchObject({ status: 'pending', attempt_count: 1, claim_worker_id: a.worker.workerId })
    // Another worker: nothing to sweep; it claims the handed-back row at attempt 5 and sends it.
    const b = makeWorker('budgetB', clock)
    expect(await b.worker.runBatch()).toMatchObject({ claimed: 1, sent: 1, swept: { outcomeUnknown: 0, exhausted: 0 } })
    expect(await rowOf(queued)).toMatchObject({ status: 'sent', attempt_count: 5 })
    expect(b.channel.sentIds()).toEqual([queued])
    // The slow row returns after its budget: not fenced, the attempt spent, a bounded retry.
    clock.advance(TASK_DELIVERY_ROW_BUDGET_MS + 1000)
    gate.resolve()
    expect(await run).toMatchObject({ claimed: 2, retrying: 1, released: 1, sent: 0, lostLease: 0 })
    expect(await rowOf(slow)).toMatchObject({ status: 'retrying', attempt_count: 1, last_error: 'row_budget_exceeded', claim_worker_id: null })
    expect(a.channel.sentIds()).toEqual([])
  })

  it('windowed families first (ASSUMPTION(task-m4): [own-3b-16]): a reminder due after 60 earlier event rows is in the first batch of 50 and is sent first', async () => {
    const f = await taskFixture('prio')
    const base = await databaseNow()
    const remindAt = later(base, 5 * MINUTE)
    const reminderTask = await createTask({
      orgId: f.orgId, creatorId: f.creator, title: '到点复核', assignees: [f.assignee], completionMode: 'all', remindAt: remindAt.toISOString(),
    })
    const events: string[] = []
    for (let i = 0; i < 60; i += 1) events.push(await seedEventRow(f, f.follower, { nextAttemptAt: ago(base, 10 * MINUTE) }))
    const [plan] = planTaskReminderDeliveries({
      orgId: f.orgId, taskId: reminderTask.id, remindAt, creatorId: f.creator,
      assignees: [{ userId: f.assignee, completedAt: null }], channels: [CHANNEL],
    })
    const reminder = await seedPlan(plan, { nextAttemptAt: ago(base, MINUTE) })
    const { worker, channel } = makeWorker('prio', steppedClock(later(remindAt, MINUTE)))
    expect(await worker.runBatch()).toMatchObject({ claimed: 50, sent: 50 })
    expect(channel.sentIds()[0]).toBe(reminder)
    expect(await rowOf(reminder)).toMatchObject({ status: 'sent' })
    let eventsSent = 0
    for (const id of events) if ((await rowOf(id)).status === 'sent') eventsSent += 1
    expect(eventsSent).toBe(49)
  })

  it('event freshness (ASSUMPTION(task-m4): [own-3b-14]): an event or list row older than 24 h ⇒ skipped / event_stale with no send; 23 h old ⇒ sent', async () => {
    const f = await taskFixture('fresh')
    const base = await databaseNow()
    const at = ago(base, MINUTE)
    const staleEvent = await seedEventRow(f, f.follower, { createdAt: ago(base, 25 * HOUR), nextAttemptAt: at })
    const freshEvent = await seedEventRow(f, f.follower, { createdAt: ago(base, 23 * HOUR), nextAttemptAt: at })
    const listId = await seedList(f.orgId, f.follower, [[f.follower, 'owner']], [])
    const staleList = await seedListRow(f.orgId, listId, f.follower, f.creator, { createdAt: ago(base, 25 * HOUR), nextAttemptAt: at })
    const freshList = await seedListRow(f.orgId, listId, f.follower, f.creator, { createdAt: ago(base, 23 * HOUR), nextAttemptAt: at })
    const { worker, channel } = makeWorker('fresh', steppedClock(base))
    await worker.runBatch()
    for (const id of [staleEvent, staleList]) expect(await rowOf(id)).toMatchObject({ status: 'skipped', last_error: 'event_stale', delivered_at: null })
    for (const id of [freshEvent, freshList]) expect(await rowOf(id)).toMatchObject({ status: 'sent' })
    expect([...channel.sentIds()].sort()).toEqual([freshEvent, freshList].sort())
  })

  it('stopping (design §6.6): after the fenced row finishes the rest go back unspent; a row in prepare when stopping turns true does not pass the fence', async () => {
    const f = await taskFixture('stop')
    const base = await databaseNow()
    const clock = steppedClock(base)
    const at = ago(base, MINUTE)
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) ids.push(await seedEventRow(f, f.follower, { nextAttemptAt: at }))
    let stopping = false
    const d = deferred()
    const atSend = deferred()
    const a = makeWorker('stopA', clock, {
      onSend: async (_call, index) => {
        if (index === 0) {
          atSend.resolve()
          await d.promise
        }
        return { ok: true }
      },
    })
    const run = a.worker.runUntilIdle({ budgetMs: 10 * MINUTE, stopping: () => stopping })
    await atSend.promise
    stopping = true
    d.resolve()
    const { batches, totals } = await run
    expect(batches).toBe(1)
    expect(totals).toMatchObject({ claimed: 4, sent: 1, released: 3 })
    expect(a.channel.preparedIds()).toHaveLength(1)
    const [sentId] = a.channel.sentIds()
    const rest = ids.filter((id) => id !== sentId)
    expect(await rowOf(sentId)).toMatchObject({ status: 'sent', attempt_count: 1 })
    for (const id of rest) {
      expect(await rowOf(id)).toMatchObject({ status: 'pending', attempt_count: 0, claim_worker_id: null, claim_expires_at: null, claimed_at: null })
    }

    stopping = false
    const d2 = deferred()
    const atPrepare = deferred()
    const b = makeWorker('stopB', clock, {
      onPrepare: async (_target, index) => {
        if (index === 0) {
          atPrepare.resolve()
          await d2.promise
        }
      },
    })
    const pending = b.worker.runBatch({ stopping: () => stopping })
    await atPrepare.promise
    stopping = true
    d2.resolve()
    expect(await pending).toMatchObject({ claimed: 3, sent: 0, released: 3, lostLease: 0 })
    expect(b.channel.sentIds()).toEqual([])
    for (const id of rest) expect(await rowOf(id)).toMatchObject({ status: 'pending', attempt_count: 0, claim_worker_id: null })
  })
})

// ── Second tenant ────────────────────────────────────────────────────────────────────────────────

/** A child script: one batch with an inline channel; exit 0 when every id in `ids` was sent. */
function sendDueRowsScript(ids: string[], nowMs: number): string {
  return `
    const { TaskNotificationDeliveryWorker } = await import(${JSON.stringify(WORKER_FILE)})
    const sent = []
    const channel = {
      name: ${JSON.stringify(CHANNEL)},
      prepare: async (target) => ({ ok: true, send: async () => { sent.push(target.deliveryId); return { ok: true } } }),
    }
    const worker = new TaskNotificationDeliveryWorker({
      channels: [channel],
      now: () => new Date(${nowMs}),
      env: { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' },
    })
    await worker.runBatch()
    const wanted = ${JSON.stringify(ids)}
    console.log(JSON.stringify({ ncSecondTenant: 'red', sent }))
    process.exit(wanted.every((id) => sent.includes(id)) ? 0 : 1)
  `
}

async function resetRows(ids: string[]): Promise<void> {
  await poolManager.get().query(
    `UPDATE task_notification_deliveries
        SET status = 'pending', attempt_count = 0, last_error = NULL, claim_worker_id = NULL, claim_expires_at = NULL,
            claimed_at = NULL, last_attempt_at = NULL, delivered_at = NULL, redelivery_safe = false
      WHERE id = ANY($1::uuid[])`,
    [ids],
  )
}

describe('second tenant (gate 1 M4 subset, candidate; design §10 item 1, §11.6)', () => {
  it('an org-A row whose source id names an org-B task (live event, deleted event) or an org-B list is not sent; the same rows in org B are; negative controls: the gate 1 org clause and the list org clause made always-true send them', async () => {
    const stamp = stampOf()
    const orgA = orgOf('tenA', stamp)
    const orgB = orgOf('tenB', stamp)
    const recipient = `usrR_ten_${stamp}`
    const ownerB = `usrO_ten_${stamp}`
    await members(orgA, recipient)
    await members(orgB, ownerB)
    await poolManager.get().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [recipient, orgB])
    const live = await createTask({ orgId: orgB, creatorId: ownerB, title: '乙方任务', assignees: [recipient], completionMode: 'all' })
    const gone = await createTask({ orgId: orgB, creatorId: ownerB, title: '乙方已删', assignees: [recipient], completionMode: 'all' })
    await deleteTaskById({ orgId: orgB, actorId: ownerB, taskId: gone.id })
    const listB = await seedList(orgB, recipient, [[recipient, 'owner']], [])
    const base = await databaseNow()
    const at = ago(base, MINUTE)
    const seedTrio = async (orgId: string) => ({
      live: await seedEventRow({ orgId, taskId: live.id }, recipient, { event: 'completed', role: 'assignee', actorId: ownerB, nextAttemptAt: at }),
      gone: await seedEventRow({ orgId, taskId: gone.id }, recipient, { event: 'deleted', role: 'assignee', actorId: ownerB, nextAttemptAt: at }),
      list: await seedListRow(orgId, listB, recipient, ownerB, { nextAttemptAt: at }),
    })
    const inA = await seedTrio(orgA)
    const inB = await seedTrio(orgB)
    const { worker, channel } = makeWorker('ten', steppedClock(base))
    await worker.runBatch()
    expect(await rowOf(inA.live)).toMatchObject({ status: 'skipped', last_error: 'task_missing' })
    expect(await rowOf(inA.gone)).toMatchObject({ status: 'skipped', last_error: 'task_missing' })
    expect(await rowOf(inA.list)).toMatchObject({ status: 'skipped', last_error: 'list_missing' })
    for (const id of [inB.live, inB.gone, inB.list]) expect(await rowOf(id)).toMatchObject({ status: 'sent' })
    expect([...channel.sentIds()].sort()).toEqual([inB.live, inB.gone, inB.list].sort())

    // Negative control 1: gate 1's single org clause of task-access.ts made always-true. Both task
    // builders (live and any-state) go through it, so both org-A task rows are now sent.
    await resetRows([inA.live, inA.gone])
    runSourceMutant(ACCESS_FILE, '(tasks.org_id = ${ORG_PLACEHOLDER}) AND ', '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ',
      sendDueRowsScript([inA.live, inA.gone], base.getTime()), {}, { unique: true })
    // Negative control 2: the list org clause of task-list-access.ts made always-true.
    await resetRows([inA.list])
    runSourceMutant(LIST_ACCESS_FILE, '(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ', '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ',
      sendDueRowsScript([inA.list], base.getTime()), {}, { unique: true })
  }, 240000)
})

// ── Poison rows, back-off, terminal results ──────────────────────────────────────────────────────

describe('attempts, back-off and terminal results (design §7.3)', () => {
  it('poison rows: spent attempts ⇒ failed / attempts_exhausted with redelivery_safe; a payload that is not an object, names an unknown kind or does not belong to its row ⇒ failed at once, before any prepare, never retried', async () => {
    const f = await taskFixture('poison')
    const other = await createTask({ orgId: f.orgId, creatorId: f.creator, title: '另一任务', assignees: [f.assignee], completionMode: 'all' })
    const base = await databaseNow()
    const clock = steppedClock(base)
    const at = ago(base, MINUTE)
    const spent = await seedEventRow(f, f.follower, { attemptCount: 5, nextAttemptAt: at })
    const held = await seedEventRow(f, f.creator, {
      role: 'creator', attemptCount: 5, nextAttemptAt: at, claimExpiresAt: later(base, MINUTE), claimWorkerId: 'w-other',
    })
    const keyOf = (n: string): string => `task_event:${f.taskId}:tev_s4bad${n}${f.stamp}:recipient:${f.follower}:channel:${CHANNEL}`
    const notObject = await seedOutboxRow({
      orgId: f.orgId, sourceType: 'task_event', sourceId: f.taskId, sourceKey: keyOf('1'), recipientUserId: f.follower,
      recipientRole: 'follower', channel: CHANNEL, payloadJson: '"x"', nextAttemptAt: at,
    })
    const unknownKind = await seedOutboxRow({
      orgId: f.orgId, sourceType: 'task_event', sourceId: f.taskId, sourceKey: keyOf('2'), recipientUserId: f.follower,
      recipientRole: 'follower', channel: CHANNEL, payload: { kind: 'task_bogus', taskId: f.taskId }, nextAttemptAt: at,
    })
    // A well-formed payload for a task its recipient can view, on a row of another task.
    const [foreign] = planTaskEventDeliveries({
      orgId: f.orgId, taskId: other.id, eventId: `tev_s4bad3${f.stamp}`, event: 'commented', actorId: f.creator,
      recipients: [{ userId: f.assignee, recipientRole: 'assignee' }], channels: [CHANNEL],
    })
    const mismatched = await seedOutboxRow({
      orgId: f.orgId, sourceType: 'task_event', sourceId: f.taskId, sourceKey: foreign.sourceKey, recipientUserId: f.assignee,
      recipientRole: 'assignee', channel: CHANNEL, payload: foreign.payload as unknown as Record<string, unknown>, nextAttemptAt: at,
    })
    // A list row whose payload names another list of the same org, and a digest row whose source id is not its recipient.
    const ownList = await seedList(f.orgId, f.creator, [[f.creator, 'owner']], [])
    const otherList = await seedList(f.orgId, f.creator, [[f.creator, 'owner']], [])
    const [foreignList] = planTaskListEventDeliveries({
      orgId: f.orgId, listId: otherList, eventId: `tlev_s4bad4${f.stamp}`, event: 'archived', listCreatorId: f.creator, actorId: f.assignee, channels: [CHANNEL],
    })
    const listMismatched = await seedOutboxRow({
      orgId: f.orgId, sourceType: 'task_list_event', sourceId: ownList, sourceKey: foreignList.sourceKey, recipientUserId: f.creator,
      recipientRole: 'list_member', channel: CHANNEL, payload: foreignList.payload as unknown as Record<string, unknown>, nextAttemptAt: at,
    })
    const [digest] = planTaskDailyDigestDelivery({ orgId: f.orgId, userId: f.creator, date: '2030-01-01', timeZone: 'Asia/Shanghai', channels: [CHANNEL] })
    const digestMismatched = await seedOutboxRow({
      orgId: f.orgId, sourceType: 'task_daily', sourceId: f.assignee, sourceKey: digest.sourceKey, recipientUserId: f.creator,
      recipientRole: 'assignee', channel: CHANNEL, payload: digest.payload as unknown as Record<string, unknown>, nextAttemptAt: at,
    })
    const heldBefore = await rowTexts([held])
    const { worker, channel } = makeWorker('poison', clock)
    expect(await worker.runBatch()).toEqual({ ...ZERO_BATCH, claimed: 5, failed: 5, swept: { outcomeUnknown: 0, exhausted: 1 } })
    expect(await rowOf(spent)).toMatchObject({
      status: 'failed', last_error: 'attempts_exhausted', redelivery_safe: true, attempt_count: 5, claim_worker_id: null,
    })
    expect(await rowTexts([held])).toEqual(heldBefore)
    expect(await rowOf(notObject)).toMatchObject({ status: 'failed', last_error: 'payload_invalid', attempt_count: 1, redelivery_safe: true })
    expect(await rowOf(unknownKind)).toMatchObject({ status: 'failed', last_error: 'unknown_kind', attempt_count: 1 })
    expect(await rowOf(mismatched)).toMatchObject({ status: 'failed', last_error: 'payload_invalid', attempt_count: 1 })
    expect(await rowOf(listMismatched)).toMatchObject({ status: 'failed', last_error: 'payload_invalid', attempt_count: 1 })
    expect(await rowOf(digestMismatched)).toMatchObject({ status: 'failed', last_error: 'payload_invalid', attempt_count: 1 })
    expect(channel.calls).toEqual([])
    clock.advance(24 * HOUR)
    // A day later the held row's lease has long run out: it is spent too, its dead holder cleared; nothing else moves.
    expect(await worker.runBatch()).toEqual({ ...ZERO_BATCH, swept: { outcomeUnknown: 0, exhausted: 1 } })
    expect(await rowOf(held)).toMatchObject({
      status: 'failed', last_error: 'attempts_exhausted', redelivery_safe: true, attempt_count: 5, claim_worker_id: null, claim_expires_at: null,
    })
    expect(channel.calls).toEqual([])
  })

  it('a channel error text longer than 1000 characters is stored cut to 1000 (the worker’s own cap)', async () => {
    const f = await taskFixture('cap')
    const base = await databaseNow()
    const id = await seedEventRow(f, f.follower, { nextAttemptAt: ago(base, MINUTE) })
    const { worker } = makeWorker('cap', steppedClock(base), { onSend: () => ({ ok: false, retryable: false, error: 'e'.repeat(1500) }) })
    expect(await worker.runBatch()).toMatchObject({ claimed: 1, failed: 1 })
    expect((await rowOf(id)).last_error).toBe('e'.repeat(1000))
  })

  it('back-off: a retryable rejection is retried after 1 min, 5 min, 15 min and 1 h and is failed with redelivery_safe on the fifth attempt; outcomeUnknown ⇒ outcome_unknown, never claimed again; a skip from prepare ⇒ skipped with no send; a send that throws ⇒ outcome_unknown with a fixed code', async () => {
    const f = await taskFixture('backoff')
    const extra = `usrX_backoff_${f.stamp}`
    await members(f.orgId, extra)
    await follow(f.taskId, extra)
    const base = await databaseNow()
    const clock = steppedClock(base)
    const at = ago(base, MINUTE)
    const retry = await seedEventRow(f, f.follower, { nextAttemptAt: at })
    const unknown = await seedEventRow(f, f.creator, { role: 'creator', nextAttemptAt: at })
    const skip = await seedEventRow(f, f.assignee, { role: 'assignee', nextAttemptAt: at })
    const thrown = await seedEventRow(f, extra, { nextAttemptAt: at })
    const { worker, channel } = makeWorker('backoff', clock, {
      onPrepare: (target) => (target.deliveryId === skip ? { ok: false, retryable: false, skip: true, error: 'recipient_not_bound' } : null),
      onSend: (call) => {
        if (call.deliveryId === retry) return { ok: false, retryable: true, error: 'rate_limited' }
        if (call.deliveryId === unknown) return { ok: false, retryable: false, outcomeUnknown: true, error: 'request_timeout' }
        if (call.deliveryId === thrown) throw new Error('socket closed while sending')
        return { ok: true }
      },
    })
    expect(await worker.runBatch()).toMatchObject({ claimed: 4, retrying: 1, outcomeUnknown: 2, skipped: 1, sent: 0 })
    expect(await rowOf(unknown)).toMatchObject({ status: 'outcome_unknown', last_error: 'request_timeout', redelivery_safe: false, claim_worker_id: null })
    expect(await rowOf(thrown)).toMatchObject({ status: 'outcome_unknown', last_error: 'send_unclassified', redelivery_safe: false })
    expect(await rowOf(skip)).toMatchObject({ status: 'skipped', last_error: 'recipient_not_bound', attempt_count: 1 })
    let row = await rowOf(retry)
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(row).toMatchObject({ status: 'retrying', attempt_count: attempt, last_error: 'rate_limited', claim_worker_id: null })
      expect(row.next_attempt_at.getTime()).toBe(clock.now().getTime() + TASK_DELIVERY_BACKOFF_LADDER_MS[attempt - 1])
      // One millisecond early: not due yet.
      clock.set(new Date(row.next_attempt_at.getTime() - 1))
      expect((await worker.runBatch()).claimed).toBe(0)
      clock.set(row.next_attempt_at)
      expect((await worker.runBatch()).claimed).toBe(1)
      row = await rowOf(retry)
    }
    expect(row).toMatchObject({ status: 'failed', attempt_count: 5, last_error: 'rate_limited', redelivery_safe: true })
    clock.advance(7 * 24 * HOUR)
    expect(await worker.runBatch()).toEqual(ZERO_BATCH)
    expect(sends(channel.calls).filter((id) => id === retry)).toHaveLength(5)
    expect(sends(channel.calls).filter((id) => id === unknown)).toHaveLength(1)
    expect(sends(channel.calls).filter((id) => id === thrown)).toHaveLength(1)
    expect(sends(channel.calls).filter((id) => id === skip)).toHaveLength(0)
  })
})

// ── Send-time checks ─────────────────────────────────────────────────────────────────────────────

describe('send-time checks (design §4.6, §7.4)', () => {
  it('RULED(2026-10-07): [R17] a recipient who is no longer an active member of the row’s org (membership or account inactive) ⇒ skipped / recipient_inactive_in_org, nothing sent', async () => {
    const f = await taskFixture('r17')
    const base = await databaseNow()
    const at = ago(base, MINUTE)
    const inactiveMembership = await seedEventRow(f, f.follower, { nextAttemptAt: at })
    const inactiveAccount = await seedEventRow(f, f.assignee, { role: 'assignee', nextAttemptAt: at })
    const active = await seedEventRow(f, f.creator, { role: 'creator', nextAttemptAt: at })
    await poolManager.get().query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [f.follower, f.orgId])
    await poolManager.get().query('UPDATE users SET is_active = false WHERE id = $1', [f.assignee])
    const { worker, channel } = makeWorker('r17', steppedClock(base))
    await worker.runBatch()
    for (const id of [inactiveMembership, inactiveAccount]) {
      expect(await rowOf(id)).toMatchObject({ status: 'skipped', last_error: 'recipient_inactive_in_org' })
    }
    expect(await rowOf(active)).toMatchObject({ status: 'sent' })
    expect(channel.sentIds()).toEqual([active])
  })

  it('end to end: a completion’s rows (creator, follower, list reader) are each sent once, the title escaped; each payload names the completed event', async () => {
    const f = await taskFixture('e2e', { title: '[备料](复核) # 标题' })
    await seedOrgDingTalkIntegration(f.orgId)
    const reader = `usrL_e2e_${f.stamp}`
    await members(f.orgId, reader)
    await seedList(f.orgId, f.creator, [[f.creator, 'owner'], [reader, 'read']], [f.taskId])
    await withProducerOn(() => completeTask({ orgId: f.orgId, actorId: f.assignee, taskId: f.taskId }))
    const event = await poolManager.get().query<{ id: string }>(
      `SELECT id FROM task_events WHERE task_id = $1 AND event_type = 'completed'`,
      [f.taskId],
    )
    expect(event.rows).toHaveLength(1)
    const produced = await rowsOfSource(f.taskId)
    expect(produced.map((row) => [row.recipient_user_id, row.recipient_role]).sort()).toEqual(
      [[f.creator, 'creator'], [f.follower, 'follower'], [reader, 'list_member']].sort(),
    )
    for (const row of produced) expect(row.payload).toMatchObject({ kind: 'task_event', event: 'completed', eventId: event.rows[0].id })
    const { worker, channel } = makeWorker('e2e', await clockAfterWrites())
    expect(await worker.runBatch()).toMatchObject({ claimed: 3, sent: 3 })
    for (const row of produced) {
      const call = channel.calls.find((c) => c.phase === 'send' && c.deliveryId === row.id)
      expect(call?.content).toBe(`任务「［备料］（复核） ＃ 标题」已完成\n\n${tag(row.id)}`)
      expect(call?.content?.includes('](')).toBe(false)
      expect(await rowOf(row.id)).toMatchObject({ status: 'sent' })
    }
  })

  it('RULED(2026-10-07): [R05] [D13] a recipient who lost every role by send time ⇒ recipient_lost_access; one who keeps a role is sent', async () => {
    const f = await taskFixture('lost')
    const reader = `usrL_lost_${f.stamp}`
    await members(f.orgId, reader)
    const listId = await seedList(f.orgId, f.creator, [[f.creator, 'owner'], [reader, 'read']], [f.taskId])
    const base = await databaseNow()
    const at = ago(base, MINUTE)
    const follower = await seedEventRow(f, f.follower, { actorId: f.creator, nextAttemptAt: at })
    const listReader = await seedEventRow(f, reader, { role: 'list_member', actorId: f.creator, nextAttemptAt: at })
    const assignee = await seedEventRow(f, f.assignee, { role: 'assignee', actorId: f.creator, nextAttemptAt: at })
    await leaveTask({ orgId: f.orgId, actorId: f.follower, taskId: f.taskId })
    await poolManager.get().query('DELETE FROM task_list_members WHERE list_id = $1 AND user_id = $2', [listId, reader])
    const { worker, channel } = makeWorker('lost', steppedClock(base))
    await worker.runBatch()
    for (const id of [follower, listReader]) expect(await rowOf(id)).toMatchObject({ status: 'skipped', last_error: 'recipient_lost_access' })
    expect(await rowOf(assignee)).toMatchObject({ status: 'sent' })
    expect(channel.sentIds()).toEqual([assignee])
  })

  it('after a soft delete the deleted event’s rows are sent (any-state read, ASSUMPTION(task-m4): [own-3b-17]); an earlier event’s unsent row ⇒ task_missing', async () => {
    const f = await taskFixture('del')
    await seedOrgDingTalkIntegration(f.orgId)
    const base = await databaseNow()
    const earlier = await seedEventRow(f, f.follower, { actorId: f.creator, nextAttemptAt: ago(base, MINUTE) })
    await withProducerOn(() => deleteTaskById({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId }))
    const deleted = (await rowsOfSource(f.taskId)).filter((row) => row.payload.event === 'deleted')
    expect(deleted.map((row) => row.recipient_user_id).sort()).toEqual([f.assignee, f.follower].sort())
    const { worker, channel } = makeWorker('del', await clockAfterWrites())
    await worker.runBatch()
    expect(await rowOf(earlier)).toMatchObject({ status: 'skipped', last_error: 'task_missing' })
    for (const row of deleted) {
      expect(await rowOf(row.id)).toMatchObject({ status: 'sent' })
      const call = channel.calls.find((c) => c.phase === 'send' && c.deliveryId === row.id)
      expect(call?.content).toBe(`任务「备料复核」已被删除\n\n${tag(row.id)}`)
    }
    expect(channel.sentIds()).toHaveLength(2)
  })

  it('the list family: an archive’s row is sent to the list’s creator with the list name; a recipient who is not the creator ⇒ recipient_lost_access; a list that is gone ⇒ list_missing', async () => {
    const f = await taskFixture('list')
    await seedOrgDingTalkIntegration(f.orgId)
    const listId = await seedList(f.orgId, f.follower, [[f.follower, 'owner'], [f.creator, 'edit']], [])
    await withProducerOn(() => setTaskListArchived({ orgId: f.orgId, actorId: f.creator, listId, archived: true }))
    const produced = await rowsOfSource(listId)
    expect(produced.map((row) => [row.recipient_user_id, row.source_type])).toEqual([[f.follower, 'task_list_event']])
    const base = await databaseNow()
    const at = ago(base, MINUTE)
    const notCreator = await seedListRow(f.orgId, listId, f.creator, f.assignee, { nextAttemptAt: at })
    const missing = await seedListRow(f.orgId, newTaskListId(), f.follower, f.creator, { nextAttemptAt: at })
    const { worker, channel } = makeWorker('list', steppedClock(later(base, 1000)))
    await worker.runBatch()
    expect(await rowOf(produced[0].id)).toMatchObject({ status: 'sent' })
    const call = channel.calls.find((c) => c.phase === 'send' && c.deliveryId === produced[0].id)
    expect(call?.title).toBe('清单动态')
    expect(call?.content).toBe(`清单「月度备料」已归档\n\n${tag(produced[0].id)}`)
    expect(await rowOf(notCreator)).toMatchObject({ status: 'skipped', last_error: 'recipient_lost_access' })
    expect(await rowOf(missing)).toMatchObject({ status: 'skipped', last_error: 'list_missing' })
    expect(channel.sentIds()).toEqual([produced[0].id])
  })
})

// ── Reminders (M4-c, worker half) ────────────────────────────────────────────────────────────────

describe('reminder rows at send time (RULED(2026-10-07): [R06]; design §7.4, §11.4)', () => {
  it('sent to an incomplete assignee or, without assignees, the creator; done, deleted or rescheduled ⇒ reminder_stale; a completed assignee ⇒ recipient_lost_access; later than the window ⇒ reminder_window_elapsed', async () => {
    const f = await taskFixture('rem')
    const second = `usrB_rem_${f.stamp}`
    await members(f.orgId, second)
    const base = await databaseNow()
    const remindAt = later(base, 5 * MINUTE)
    const create = (title: string, assignees: string[], extra: Record<string, unknown> = {}) =>
      createTask({ orgId: f.orgId, creatorId: f.creator, title, assignees, completionMode: 'all', remindAt: remindAt.toISOString(), ...extra })
    const dueTask = await create('到点复核', [f.assignee], { dueDate: '2030-01-15', dueTime: '09:30', timeZone: 'Asia/Shanghai' })
    const doneTask = await create('已完成', [f.assignee])
    const movedTask = await create('已改期', [f.assignee])
    const goneTask = await create('已删除', [f.assignee])
    const pairTask = await create('两人负责', [f.assignee, second])
    const soloTask = await create('无人负责', [])
    const lateTask = await create('迟到', [f.assignee])
    const reminderRows = async (taskId: string, assignees: string[], nextAttemptAt: Date): Promise<Map<string, string>> => {
      const plans = planTaskReminderDeliveries({
        orgId: f.orgId, taskId, remindAt, creatorId: f.creator,
        assignees: assignees.map((userId) => ({ userId, completedAt: null })), channels: [CHANNEL],
      })
      const ids = new Map<string, string>()
      for (const plan of plans) ids.set(plan.recipientUserId, await seedPlan(plan, { nextAttemptAt }))
      return ids
    }
    const at = ago(base, MINUTE)
    const due = await reminderRows(dueTask.id, [f.assignee], at)
    const done = await reminderRows(doneTask.id, [f.assignee], at)
    const moved = await reminderRows(movedTask.id, [f.assignee], at)
    const gone = await reminderRows(goneTask.id, [f.assignee], at)
    const pair = await reminderRows(pairTask.id, [f.assignee, second], at)
    const solo = await reminderRows(soloTask.id, [], at)
    // The late row only becomes due after the window has passed.
    const late = await reminderRows(lateTask.id, [f.assignee], later(remindAt, TASK_REMINDER_SCAN_WINDOW_MS))
    await completeTask({ orgId: f.orgId, actorId: f.assignee, taskId: doneTask.id })
    await poolManager.get().query(`UPDATE tasks SET remind_at = remind_at + interval '1 hour' WHERE id = $1`, [movedTask.id])
    await deleteTaskById({ orgId: f.orgId, actorId: f.creator, taskId: goneTask.id })
    await completeTask({ orgId: f.orgId, actorId: f.assignee, taskId: pairTask.id })
    const clock = steppedClock(later(remindAt, MINUTE))
    const { worker, channel } = makeWorker('rem', clock)
    await worker.runBatch()
    const dueId = due.get(f.assignee) as string
    expect(await rowOf(dueId)).toMatchObject({ status: 'sent' })
    const dueCall = channel.calls.find((c) => c.phase === 'send' && c.deliveryId === dueId)
    expect(dueCall?.title).toBe('任务提醒')
    expect(dueCall?.content).toBe(`任务「到点复核」的提醒时间已到\n\n截止：2030-01-15 09:30（Asia/Shanghai）\n\n${tag(dueId)}`)
    for (const rows of [done, moved, gone]) {
      expect(await rowOf(rows.get(f.assignee) as string)).toMatchObject({ status: 'skipped', last_error: 'reminder_stale' })
    }
    expect(await rowOf(pair.get(f.assignee) as string)).toMatchObject({ status: 'skipped', last_error: 'recipient_lost_access' })
    expect(await rowOf(pair.get(second) as string)).toMatchObject({ status: 'sent' })
    expect(solo.size).toBe(1)
    expect(await rowOf(solo.get(f.creator) as string)).toMatchObject({ status: 'sent', recipient_role: 'creator' })
    expect(await rowOf(late.get(f.assignee) as string)).toMatchObject({ status: 'pending', attempt_count: 0 })
    // The worker comes back after the window (2 h after the reminder moment, plus 1 s).
    clock.set(later(remindAt, TASK_REMINDER_SCAN_WINDOW_MS + 1000))
    await worker.runBatch()
    expect(await rowOf(late.get(f.assignee) as string)).toMatchObject({ status: 'skipped', last_error: 'reminder_window_elapsed' })
    expect([...channel.sentIds()].sort()).toEqual([dueId, pair.get(second) as string, solo.get(f.creator) as string].sort())
  })

  it('the send-time floor counts only the floor event types: a comment, or another assignee completing their own row, after the moment does not move it, and the due reminder is sent (RULED(2026-10-07): [R06])', async () => {
    const f = await taskFixture('floor')
    const second = `usrB_floor_${f.stamp}`
    await members(f.orgId, second)
    const base = await databaseNow()
    const remindAt = later(base, 5 * MINUTE)
    const create = (title: string, assignees: string[]) =>
      createTask({ orgId: f.orgId, creatorId: f.creator, title, assignees, completionMode: 'all', remindAt: remindAt.toISOString() })
    const commented = await create('评论之后仍提醒', [f.assignee])
    const selfDone = await create('他人自完成之后仍提醒', [f.assignee, second])
    const db = poolManager.get()
    const afterMoment = later(remindAt, 30_000)
    await db.query(
      `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at) VALUES ($1, $2, $3, 'commented', $4)`,
      [`tev_s4fl1${f.stamp}`, commented.id, f.creator, afterMoment],
    )
    await db.query(
      `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at) VALUES ($1, $2, $3, 'self_completed', $4)`,
      [`tev_s4fl2${f.stamp}`, selfDone.id, second, afterMoment],
    )
    await db.query('UPDATE task_assignees SET completed_at = $3 WHERE task_id = $1 AND user_id = $2', [selfDone.id, second, afterMoment])
    const ids: string[] = []
    for (const task of [commented, selfDone]) {
      const [plan] = planTaskReminderDeliveries({
        orgId: f.orgId, taskId: task.id, remindAt, creatorId: f.creator, assignees: [{ userId: f.assignee, completedAt: null }], channels: [CHANNEL],
      })
      ids.push(await seedPlan(plan, { nextAttemptAt: ago(base, MINUTE) }))
    }
    // The worker comes two minutes after the moment, after both non-floor events.
    const { worker, channel } = makeWorker('floor', steppedClock(later(remindAt, 2 * MINUTE)))
    expect(await worker.runBatch()).toMatchObject({ claimed: 2, sent: 2, skipped: 0 })
    for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sent', last_error: null })
    expect([...channel.sentIds()].sort()).toEqual([...ids].sort())
  })
})

// ── Daily digest (M4-c, worker half) ─────────────────────────────────────────────────────────────

/**
 * The digest's content query reads the database clock, and the worker's window check reads the
 * injected clock; both must agree on the recipient's local date and on being inside the 09:00 + W
 * window. The cells pick a fixed-offset zone in which the database's current time is 09:MM, so the
 * injected clock is simply the database clock read just before the worker runs (always later than
 * any row's default `next_attempt_at`), with more than an hour left in the window and no local
 * midnight nearby.
 */
async function digestZone(): Promise<{ tz: string; today: string; sendAt: Date }> {
  const now = await databaseNow()
  let offset = 9 - now.getUTCHours()
  if (offset < -12) offset += 24
  const tz = offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`
  const today = viewerToday(now, tz)
  return { tz, today, sendAt: computeDailyDigestSendAt(today, tz) }
}

async function digestUser(orgId: string, userId: string, tz: string): Promise<void> {
  await members(orgId, userId)
  await poolManager.get().query(
    'INSERT INTO task_user_settings (user_id, org_id, daily_reminder_enabled, time_zone) VALUES ($1, $2, true, $3)',
    [userId, orgId, tz],
  )
}

/** A task assigned to `assignees`, all-day, due `days` after the recipient's local today (database clock). */
async function dueTask(orgId: string, creator: string, assignees: string[], title: string, tz: string, days: number): Promise<string> {
  const task = await createTask({ orgId, creatorId: creator, title, assignees, completionMode: 'all' })
  await poolManager.get().query(
    `UPDATE tasks SET due_date = ((now() AT TIME ZONE $2)::date + $3::int), due_time = NULL, due_at = NULL, time_zone = $2 WHERE id = $1`,
    [task.id, tz, days],
  )
  return task.id
}

async function dueDateText(taskId: string): Promise<string> {
  const result = await poolManager.get().query<{ d: string }>('SELECT due_date::text AS d FROM tasks WHERE id = $1', [taskId])
  return result.rows[0].d
}

describe('daily digest rows at send time (RULED(2026-10-07): [R07]; design §6.3, §7.4, §11.5)', () => {
  it('a digest is sent with the overdue, today and tomorrow items in due order; not the day after, not one I completed, not a done task', async () => {
    const { tz, today, sendAt } = await digestZone()
    const stamp = stampOf()
    const orgId = orgOf('dig', stamp)
    const me = `usrD_dig_${stamp}`
    const other = `usrO_dig_${stamp}`
    await digestUser(orgId, me, tz)
    await members(orgId, other)
    const overdue = await dueTask(orgId, other, [me], '逾期项', tz, -3)
    const todayTask = await dueTask(orgId, other, [me], '今天项', tz, 0)
    const tomorrow = await dueTask(orgId, other, [me], '明天项', tz, 1)
    await dueTask(orgId, other, [me], '后天项', tz, 2)
    const mine = await dueTask(orgId, other, [me, other], '我已完成', tz, 0)
    await completeTask({ orgId, actorId: me, taskId: mine })
    const done = await dueTask(orgId, other, [me], '已结束', tz, 0)
    await completeTask({ orgId, actorId: me, taskId: done })
    const [plan] = planTaskDailyDigestDelivery({ orgId, userId: me, date: today, timeZone: tz, channels: [CHANNEL] })
    const id = await seedPlan(plan, { nextAttemptAt: sendAt })
    const { worker, channel } = makeWorker('dig', await clockAfterWrites())
    expect(await worker.runBatch()).toMatchObject({ claimed: 1, sent: 1 })
    const call = channel.calls.find((c) => c.phase === 'send')
    expect(call?.title).toBe('今日任务')
    const lines = [
      `- 「逾期项」（${await dueDateText(overdue)}，${tz}）`,
      `- 「今天项」（${await dueDateText(todayTask)}，${tz}）`,
      `- 「明天项」（${await dueDateText(tomorrow)}，${tz}）`,
    ]
    expect(call?.content).toBe(`${lines.join('\n')}\n\n${tag(id)}`)
  })

  it('an empty digest is one skipped row with empty_digest and no channel call at all (the row shape); a task due later the same day writes no second row and nothing is sent', async () => {
    const { tz, today } = await digestZone()
    const stamp = stampOf()
    const orgId = orgOf('empty', stamp)
    const me = `usrD_empty_${stamp}`
    const other = `usrO_empty_${stamp}`
    await digestUser(orgId, me, tz)
    await members(orgId, other)
    const plans = planTaskDailyDigestDelivery({ orgId, userId: me, date: today, timeZone: tz, channels: [CHANNEL] })
    // The scheduler's scan writes through the producer's single INSERT; this cell writes the same way.
    expect(await insertTaskNotificationDeliveries(poolManager.get(), plans)).toBe(1)
    const [row] = await rowsOfSource(me)
    const first = makeWorker('empty', await clockAfterWrites())
    expect(await first.worker.runBatch()).toEqual({ ...ZERO_BATCH, claimed: 1, skipped: 1 })
    // ASSUMPTION(task-m4): [own-3b-37] the skip is decided before prepare: the channel is never called.
    expect(first.channel.calls).toEqual([])
    const shaped = await rowOf(row.id)
    expect(shaped).toMatchObject({
      source_type: 'task_daily', source_id: me, recipient_user_id: me, recipient_role: 'assignee', status: 'skipped',
      last_error: 'empty_digest', delivered_at: null, redelivery_safe: false, attempt_count: 1,
    })
    expect(shaped.payload).toEqual({ kind: 'task_daily', date: today, timeZone: tz })
    expect(first.channel.sentIds()).toEqual([])
    // Later the same day a task falls due; the next scan's write meets the day's row and adds none.
    await dueTask(orgId, other, [me], '后到的今天项', tz, 0)
    expect(await insertTaskNotificationDeliveries(poolManager.get(), plans)).toBe(0)
    const second = makeWorker('empty2', await clockAfterWrites())
    expect(await second.worker.runBatch()).toEqual(ZERO_BATCH)
    expect(second.channel.calls).toEqual([])
    expect((await rowsOfSource(me)).map((r) => [r.id, r.status])).toEqual([[row.id, 'skipped']])
  })

  it('settings switched off or the zone changed after the row was written ⇒ digest_settings_changed; a worker past the window or on another date ⇒ digest_window_elapsed', async () => {
    const { tz, today, sendAt } = await digestZone()
    const stamp = stampOf()
    const orgId = orgOf('digset', stamp)
    const other = `usrO_digset_${stamp}`
    await members(orgId, other)
    const users = ['off', 'zone', 'late', 'date'].map((label) => `usrD_${label}_${stamp}`)
    const ids = new Map<string, string>()
    for (const userId of users) {
      await digestUser(orgId, userId, tz)
      await dueTask(orgId, other, [userId], '今天项', tz, 0)
      const date = userId.startsWith('usrD_date_') ? '2001-01-01' : today
      const [plan] = planTaskDailyDigestDelivery({ orgId, userId, date, timeZone: tz, channels: [CHANNEL] })
      ids.set(userId, await seedPlan(plan, { nextAttemptAt: sendAt }))
    }
    const [off, zone, late, onDate] = users
    await poolManager.get().query('UPDATE task_user_settings SET daily_reminder_enabled = false WHERE user_id = $1', [off])
    await poolManager.get().query(`UPDATE task_user_settings SET time_zone = 'UTC' WHERE user_id = $1`, [zone])
    const now = await databaseNow()
    const { worker, channel } = makeWorker('digset', steppedClock(now))
    // The late row is claimed by a worker running after the window instead.
    await poolManager.get().query('UPDATE task_notification_deliveries SET next_attempt_at = $2 WHERE id = $1::uuid', [
      ids.get(late), later(sendAt, TASK_REMINDER_SCAN_WINDOW_MS),
    ])
    await worker.runBatch()
    expect(await rowOf(ids.get(off) as string)).toMatchObject({ status: 'skipped', last_error: 'digest_settings_changed' })
    expect(await rowOf(ids.get(zone) as string)).toMatchObject({ status: 'skipped', last_error: 'digest_settings_changed' })
    expect(await rowOf(ids.get(onDate) as string)).toMatchObject({ status: 'skipped', last_error: 'digest_window_elapsed' })
    expect(await rowOf(ids.get(late) as string)).toMatchObject({ status: 'pending' })
    const lateWorker = makeWorker('diglate', steppedClock(later(sendAt, TASK_REMINDER_SCAN_WINDOW_MS)))
    await lateWorker.worker.runBatch()
    expect(await rowOf(ids.get(late) as string)).toMatchObject({ status: 'skipped', last_error: 'digest_window_elapsed' })
    expect([...channel.calls, ...lateWorker.channel.calls].filter((c) => c.phase === 'send')).toEqual([])
  })

  it(`more than TASK_DIGEST_MAX_ITEMS items: the first ${TASK_DIGEST_MAX_ITEMS} lines and 另有 3 项`, async () => {
    const { tz, today, sendAt } = await digestZone()
    const stamp = stampOf()
    const orgId = orgOf('digmax', stamp)
    const me = `usrD_digmax_${stamp}`
    const other = `usrO_digmax_${stamp}`
    await digestUser(orgId, me, tz)
    await members(orgId, other)
    for (let i = 0; i < TASK_DIGEST_MAX_ITEMS + 3; i += 1) await dueTask(orgId, other, [me], `事项${i}`, tz, 0)
    const [plan] = planTaskDailyDigestDelivery({ orgId, userId: me, date: today, timeZone: tz, channels: [CHANNEL] })
    const id = await seedPlan(plan, { nextAttemptAt: sendAt })
    const { worker, channel } = makeWorker('digmax', await clockAfterWrites())
    expect(await worker.runBatch()).toMatchObject({ sent: 1 })
    const content = channel.calls.find((c) => c.phase === 'send')?.content ?? ''
    const [items, overflow, last] = content.split('\n\n')
    expect(items.split('\n')).toHaveLength(TASK_DIGEST_MAX_ITEMS)
    expect(overflow).toBe('另有 3 项')
    expect(last).toBe(tag(id))
  })
})
