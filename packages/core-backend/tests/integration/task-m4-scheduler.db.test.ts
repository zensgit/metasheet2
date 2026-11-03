import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import pg from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireTasksSchedulerLeaderLock } from '../../src/db/task-advisory-locks'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  createTaskDeliveryChannelsFromEnv,
  TaskNotificationDeliveryWorker,
  type TaskDeliveryQuery,
} from '../../src/services/task-notification-delivery-worker'
import { completeTask, createTask } from '../../src/services/task-records'
import {
  resolveTaskDailyDigestJob,
  resolveTaskNotificationDeliveryJob,
  resolveTaskReminderJob,
  runTaskDailyDigestScan,
  runTaskReminderScan,
  startTaskScheduler,
  stopTaskScheduler,
  TaskScheduler,
  type LeaderClient,
  type TaskSchedulerJob,
  type TaskSchedulerJobContext,
  type TaskSchedulerOptions,
} from '../../src/services/task-scheduler'
import { viewerToday } from '../../src/tasks/task-dates'
import { tasksSchedulerLeaderLockKey } from '../../src/tasks/task-lock-keys'
import { planTaskEventDeliveries, TASK_NOTIFICATION_CHANNEL_DINGTALK } from '../../src/tasks/task-notifications'
import {
  buildTaskDailyDigestCondition,
  computeDailyDigestSendAt,
  isInDailyDigest,
  TASK_REMINDER_SCAN_WINDOW_MS,
} from '../../src/tasks/task-reminders'
import {
  deferred,
  dropTaskM4Fixtures,
  FakeTaskDeliveryChannel,
  runSourceMutant,
  seedOrgDingTalkIntegration,
  seedOrgMembers,
  seedOutboxRow,
  steppedClock,
} from '../helpers/task-m4-fixtures'

/**
 * M4 PR-3b S5 (design task-m4-pr3b-backend-design-20261001.md §6, §11.4–§11.6; candidate rows M4-c
 * and M4-d, gate 25; the rows R01 numbers are not in the lock yet, so these cells are candidates,
 * not scored).
 *
 * The task scheduler on a real database: the leader lock and its bounded wait, one leader per
 * tick, the leader connection terminated mid-tick, the server-side bound on a leader whose socket
 * stops responding and the heartbeat that keeps an alive leader inside it, the reminder and daily
 * digest scans, start-up with the switches off, stop() (also with a delivery row in flight), and
 * the backlog gauge. Ticks are driven by `runTick()` (no timer); the scans' clock is injected
 * (far-future instants, so no other file's rows fall in a window), and concurrency is fixed with
 * deferred promises. The waits poll for a state the database or the driver reports (an ungranted
 * lock, a failed connection, an ended backend), bounded by a deadline; the two idle-bound cells
 * also hold a scan open for a few seconds of real time, because the bound they prove is a
 * wall-clock one the server enforces.
 *
 * ASSUMPTION(task-m4): [own-3b-01] scans write nothing while the pipeline is off, [own-3b-06] the
 * start-up switches, [own-3b-07] delivery after the commit, [own-3b-13] the org precondition,
 * [own-3b-15] the keyset paging, [own-3b-23] the leader client's listener, [own-3b-30]…[own-3b-33],
 * [own-3b-35] the leader session bound and heartbeat, [own-3b-38] the digest scan's membership test.
 * RULED(2026-10-07): [R06] the reminder window and floor, [R07] the 09:00 digest in the recipient's
 * zone, one row per recipient and local date.
 *
 * Row isolation: the scans, the claim and the backlog read are cross-org, so every cell starts with
 * an empty `task_notification_deliveries` and ends by removing its own tasks, settings and
 * integrations (the lane runs files one at a time).
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-scheduler.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4sched_'
const CHANNEL = TASK_NOTIFICATION_CHANNEL_DINGTALK
const PIPELINE_ON: NodeJS.ProcessEnv = {
  TASKS_ENABLED: 'true',
  TASKS_SCHEDULER_ENABLED: 'true',
  TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true',
  TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true',
}
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const W = TASK_REMINDER_SCAN_WINDOW_MS
/** Far from any real clock: no other file's reminder or digest falls inside a window built on it. */
const BASE_MS = Date.UTC(2031, 2, 10, 1, 30, 0)
const seededUsers: string[] = []

const SCHEDULER_FILE = new URL('../../src/services/task-scheduler.ts', import.meta.url).pathname
const LOCKS_FILE = new URL('../../src/db/task-advisory-locks.ts', import.meta.url).pathname
const POOL_FILE = new URL('../../src/integration/db/connection-pool.ts', import.meta.url).pathname
const LOCK_KEYS_FILE = new URL('../../src/tasks/task-lock-keys.ts', import.meta.url).pathname
const LISTENER_NEEDLE = "    client.on('error', onError)\n"
const LOCK_NEEDLE = "  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [tasksSchedulerLeaderLockKey()])"

const quiet = { info: () => undefined, warn: () => undefined }

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

function at(ms: number): Date {
  return new Date(ms)
}

function ctxAt(now: Date, flags: { stopping?: () => boolean; leaderLost?: () => boolean } = {}): TaskSchedulerJobContext {
  return { now: () => now, stopping: flags.stopping ?? (() => false), leaderLost: flags.leaderLost ?? (() => false) }
}

async function members(orgId: string, ...userIds: string[]): Promise<void> {
  await seedOrgMembers(orgId, userIds)
  seededUsers.push(...userIds)
}

async function databaseNow(): Promise<Date> {
  return new Date((await poolManager.get().query('SELECT now() AS now')).rows[0].now as Date)
}

function connectLeaderClient(): Promise<LeaderClient> {
  return poolManager.get().getInternalPool().connect() as unknown as Promise<LeaderClient>
}

async function rawClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  return client
}

/** A connection of its own holding the leader lock, taken with the plain statement (not the helper). */
async function holdLeaderLock(): Promise<pg.Client> {
  const holder = await rawClient()
  await holder.query('BEGIN')
  await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tasksSchedulerLeaderLockKey()])
  return holder
}

function recordingGauge(): { gauge: { labels(labels: Record<string, string>): { set(value: number): void } }; values: Map<string, number>; state: () => string | null } {
  const values = new Map<string, number>()
  return {
    values,
    gauge: { labels: (labels) => ({ set: (value: number) => { values.set(Object.values(labels)[0], value) } }) },
    state: () => [...values.entries()].find(([, value]) => value === 1)?.[0] ?? null,
  }
}

function countingJob(name: string): TaskSchedulerJob & { runs: number } {
  const job = {
    name,
    runs: 0,
    run: async () => {
      job.runs += 1
      return { counted: job.runs }
    },
  }
  return job
}

function scheduler(overrides: Partial<TaskSchedulerOptions> = {}): TaskScheduler {
  return new TaskScheduler({ scanJobs: [], connectLeaderClient, logger: quiet, ...overrides })
}

/** Polls `check` every 25 ms until it returns a value or the deadline passes. */
async function settle<T>(check: () => Promise<T | null> | T | null, deadlineMs: number, what: string): Promise<T> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = await check()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A TCP relay in front of the database that can be frozen: once frozen it forwards nothing in
 * either direction and does not propagate a close, so to each side the peer has simply gone quiet
 * (a host that is gone, a network partition), while the sockets themselves stay open.
 */
interface FrozenRelay {
  url: string
  freeze: () => void
  close: () => Promise<void>
}

async function frozenRelay(): Promise<FrozenRelay> {
  const target = new URL(process.env.DATABASE_URL as string)
  const sockets: net.Socket[] = []
  let frozen = false
  let closed = false
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname)
    sockets.push(client, upstream)
    client.on('data', (chunk) => { if (!frozen) upstream.write(chunk) })
    upstream.on('data', (chunk) => { if (!frozen) client.write(chunk) })
    client.on('error', () => undefined)
    upstream.on('error', () => undefined)
    client.on('close', () => { if (!frozen) upstream.destroy() })
    upstream.on('close', () => { if (!frozen) client.destroy() })
  })
  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()))
  const url = new URL(target.toString())
  url.hostname = 'localhost'
  url.port = String((server.address() as net.AddressInfo).port)
  return {
    url: url.toString(),
    freeze: () => { frozen = true },
    close: async () => {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** A leader client of its own on `url` (not the pool), reporting its backend pid. */
function leaderClientOn(url: string, onPid: (pid: number) => void): () => Promise<LeaderClient> {
  return async () => {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    onPid(Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid))
    return {
      query: (sql, params) => client.query(sql, params as unknown[]),
      on: (event, listener) => client.on(event, listener),
      removeListener: (event, listener) => client.removeListener(event, listener),
      release: () => { void client.end().catch(() => undefined) },
    }
  }
}

async function backendAlive(observer: pg.Client, pid: number): Promise<boolean> {
  return (await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0].n > 0
}

/** The ungranted waits on the leader lock in this database, as `pg_stat_activity` reports them. */
async function leaderLockWaits(observer: pg.Client): Promise<Array<{ pid: number; wait_event_type: string; wait_event: string }>> {
  const result = await observer.query(
    `SELECT l.pid, a.wait_event_type, a.wait_event
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext($1)::bigint`,
    [tasksSchedulerLeaderLockKey()],
  )
  return result.rows
}

async function activeIntegration(orgId: string): Promise<void> {
  await seedOrgDingTalkIntegration(orgId)
}

/** An org with an active integration, a creator and one assignee, all active members. */
async function orgWithMembers(label: string): Promise<{ orgId: string; stamp: string; creator: string; assignee: string }> {
  const stamp = stampOf()
  const orgId = orgOf(label, stamp)
  const creator = `usrC_${label}_${stamp}`
  const assignee = `usrA_${label}_${stamp}`
  await members(orgId, creator, assignee)
  await activeIntegration(orgId)
  return { orgId, stamp, creator, assignee }
}

async function reminderTask(orgId: string, creator: string, assignees: string[], remindAt: Date, title = '到点提醒'): Promise<string> {
  const task = await createTask({ orgId, creatorId: creator, title, assignees, completionMode: 'all', remindAt: remindAt.toISOString() })
  return task.id
}

async function remindChanged(taskId: string, actorId: string, occurredAt: Date): Promise<void> {
  await poolManager.get().query(
    `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at) VALUES ($1, $2, $3, 'remind_changed', $4)`,
    [`tev_s5rc${stampOf()}`, taskId, actorId, occurredAt],
  )
}

interface OutboxRow {
  id: string
  org_id: string
  source_type: string
  source_id: string
  source_key: string
  recipient_user_id: string
  recipient_role: string
  status: string
  last_error: string | null
  attempt_count: number
  payload: Record<string, unknown>
}

async function outboxOfOrg(orgId: string): Promise<OutboxRow[]> {
  const result = await poolManager.get().query<OutboxRow>(
    `SELECT id::text AS id, org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, status,
            last_error, attempt_count, payload
       FROM task_notification_deliveries WHERE org_id = $1 ORDER BY source_key COLLATE "C"`,
    [orgId],
  )
  return result.rows
}

async function outboxOfPrefix(): Promise<OutboxRow[]> {
  const result = await poolManager.get().query<OutboxRow>(
    `SELECT id::text AS id, org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, status,
            last_error, attempt_count, payload
       FROM task_notification_deliveries WHERE left(org_id, length($1)) = $1 ORDER BY source_key COLLATE "C"`,
    [ORG_PREFIX],
  )
  return result.rows
}

/** A statement runner that counts every statement it forwards to the pool. */
function countingQuery(): { query: TaskDeliveryQuery; count: () => number } {
  let n = 0
  return {
    query: async (sql, params) => {
      n += 1
      const result = await poolManager.get().query(sql, params)
      return { rows: result.rows }
    },
    count: () => n,
  }
}

beforeEach(async () => {
  await poolManager.get().query('DELETE FROM task_notification_deliveries')
})

afterEach(async () => {
  await stopTaskScheduler()
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX })
})

afterAll(async () => {
  await poolManager.get().query('DELETE FROM task_notification_deliveries WHERE left(org_id, length($1)) = $1', [ORG_PREFIX])
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers })
})

// ── One leader per tick (M4-d, gate 25 candidate) ────────────────────────────────────────────────

describe('one leader per tick (gate 25 candidate; design §6.1, §11.6)', () => {
  it('lock_timeout bounds the wait for the leader lock: a second connection fails with 55P03 within the timeout plus 1 s', async () => {
    const holder = await holdLeaderLock()
    const waiter = await rawClient()
    try {
      await waiter.query('BEGIN')
      await waiter.query("SET LOCAL lock_timeout = '1500ms'")
      const started = Date.now()
      const failure = await acquireTasksSchedulerLeaderLock((sql, params) => waiter.query(sql, params)).then(() => null, (error) => error)
      const elapsed = Date.now() - started
      expect(failure).toMatchObject({ code: '55P03' })
      expect(elapsed).toBeLessThanOrEqual(1500 + 1000)
      await waiter.query('ROLLBACK')
    } finally {
      await holder.query('ROLLBACK')
      await Promise.all([holder.end(), waiter.end()])
    }
  })

  it('while a connection holds the leader lock a tick waits on it (an ungranted advisory lock, wait event Lock / advisory), then ends lock_busy with no job run; after the holder commits the next tick leads and each job runs once', async () => {
    const holder = await holdLeaderLock()
    const observer = await rawClient()
    const scan = countingJob('count-scan')
    const delivery = countingJob('count-delivery')
    const gauge = recordingGauge()
    const s = scheduler({ scanJobs: [scan], deliveryJob: delivery, lockTimeoutMs: 1500, leaderStateGauge: gauge.gauge })
    try {
      const started = Date.now()
      const tick = s.runTick()
      const waits = await settle(async () => {
        const rows = await leaderLockWaits(observer)
        // The ungranted lock row is visible a moment before the backend reports its wait event; wait for both.
        return rows.length > 0 && rows.every((row) => row.wait_event_type !== null) ? rows : null
      }, 1400, 'the tick to wait on the leader lock')
      expect(waits).toHaveLength(1)
      expect(waits[0]).toMatchObject({ wait_event_type: 'Lock', wait_event: 'advisory' })
      expect(await tick).toEqual({ leader: false, reason: 'lock_busy' })
      expect(Date.now() - started).toBeLessThanOrEqual(1500 + 1000)
      expect([scan.runs, delivery.runs]).toEqual([0, 0])
      expect(gauge.state()).toBe('follower')
      expect(await leaderLockWaits(observer)).toEqual([])
    } finally {
      await holder.query('COMMIT')
      await holder.end()
    }
    try {
      const next = await s.runTick()
      expect(next.leader).toBe(true)
      expect(next.reason).toBeUndefined()
      expect([scan.runs, delivery.runs]).toEqual([1, 1])
      expect(gauge.state()).toBe('leader')
    } finally {
      await observer.end()
    }
  })

  it('two schedulers tick at the same time: exactly one holds the lock and runs; the other is a follower and runs nothing; the delivery loop runs after the commit, when the lock is free again', async () => {
    const gate = deferred()
    const inScan = deferred()
    const firstScan = countingJob('first-scan')
    const secondScan = countingJob('second-scan')
    const secondDelivery = countingJob('second-delivery')
    const second = scheduler({ scanJobs: [secondScan], deliveryJob: secondDelivery, lockTimeoutMs: 1000 })
    let duringDelivery: unknown
    const first = scheduler({
      scanJobs: [{
        name: 'first-scan',
        run: async (ctx) => {
          inScan.resolve()
          await gate.promise
          return firstScan.run(ctx)
        },
      }],
      // While the first scheduler delivers, the second one's tick takes the lock: delivery runs
      // outside the leader transaction (ASSUMPTION(task-m4): [own-3b-07]).
      deliveryJob: { name: 'first-delivery', run: async () => { duringDelivery = await second.runTick() } },
    })
    const firstTick = first.runTick()
    await inScan.promise
    expect(await second.runTick()).toEqual({ leader: false, reason: 'lock_busy' })
    expect([secondScan.runs, secondDelivery.runs]).toEqual([0, 0])
    gate.resolve()
    const firstResult = await firstTick
    expect(firstResult.leader).toBe(true)
    expect(firstScan.runs).toBe(1)
    expect(duringDelivery).toMatchObject({ leader: true })
    expect([secondScan.runs, secondDelivery.runs]).toEqual([1, 1])
  })

  it('negative control: with the leader lock helper made a no-op, a tick leads while another connection holds the lock (the cell above would turn red)', () => {
    runSourceMutant(LOCKS_FILE, LOCK_NEEDLE, '  void query\n  void tasksSchedulerLeaderLockKey', `
      const { TaskScheduler } = await import(${JSON.stringify(SCHEDULER_FILE)})
      const { poolManager } = await import(${JSON.stringify(POOL_FILE)})
      const { tasksSchedulerLeaderLockKey } = await import(${JSON.stringify(LOCK_KEYS_FILE)})
      const pool = poolManager.get().getInternalPool()
      const holder = await pool.connect()
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tasksSchedulerLeaderLockKey()])
      let scans = 0
      const scheduler = new TaskScheduler({
        scanJobs: [{ name: 'count', run: async () => { scans += 1 } }],
        connectLeaderClient: () => pool.connect(),
        lockTimeoutMs: 1500,
        logger: { info() {}, warn() {} },
      })
      const result = await scheduler.runTick()
      await holder.query('ROLLBACK')
      holder.release()
      console.log(JSON.stringify({ ncLeaderLock: 'red', leader: result.leader, scans }))
      process.exit(result.leader === true && scans === 1 ? 0 : 1)
    `, {}, { unique: true })
  }, 60000)
})

// ── The leader connection fails ──────────────────────────────────────────────────────────────────

function terminationScript(): string {
  return `
    const { TaskScheduler } = await import(${JSON.stringify(SCHEDULER_FILE)})
    const { poolManager } = await import(${JSON.stringify(POOL_FILE)})
    process.on('uncaughtException', (error) => {
      console.log(JSON.stringify({ ncLeaderListener: 'uncaught', code: error && error.code }))
      process.exit(42)
    })
    const pool = poolManager.get().getInternalPool()
    let leaderPid = null
    let open
    const gate = new Promise((resolve) => { open = resolve })
    let entered
    const inScan = new Promise((resolve) => { entered = resolve })
    const states = []
    const scheduler = new TaskScheduler({
      scanJobs: [{ name: 'hold', run: async (ctx) => { entered(); await gate; return { sawLost: ctx.leaderLost() } } }],
      connectLeaderClient: async () => {
        const client = await pool.connect()
        leaderPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        return client
      },
      leaderStateGauge: { labels: ({ state }) => ({ set: (value) => { if (value === 1) states.push(state) } }) },
      logger: { info() {}, warn() {} },
    })
    const tick = scheduler.runTick()
    await inScan
    const killer = await pool.connect()
    await killer.query('SELECT pg_terminate_backend($1)', [leaderPid])
    killer.release()
    const deadline = Date.now() + 5000
    while (!states.includes('relinquished')) {
      if (Date.now() > deadline) { console.log(JSON.stringify({ ncLeaderListener: 'never-relinquished' })); process.exit(3) }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    open()
    const result = await tick
    console.log(JSON.stringify({ ncLeaderListener: 'handled', reason: result.reason }))
    process.exit(result.reason === 'leader_client_lost' ? 0 : 4)
  `
}

describe('the leader connection is terminated during a scan (ASSUMPTION(task-m4): [own-3b-23]; design §6.1, §11.6)', () => {
  it('the tick ends leader_client_lost, the scan saw leaderLost(), the gauge is relinquished, no delivery runs, the process sees no unhandled error; the next tick leads again', async () => {
    const gate = deferred()
    const inScan = deferred()
    const gauge = recordingGauge()
    const delivery = countingJob('delivery')
    let leaderPid: number | null = null
    const s = scheduler({
      scanJobs: [{
        name: 'hold',
        run: async (ctx) => {
          inScan.resolve()
          await gate.promise
          return { sawLost: ctx.leaderLost() }
        },
      }],
      deliveryJob: delivery,
      leaderStateGauge: gauge.gauge,
      connectLeaderClient: async () => {
        const client = await connectLeaderClient()
        leaderPid = Number(((await client.query('SELECT pg_backend_pid() AS pid')) as { rows: Array<{ pid: number }> }).rows[0].pid)
        return client
      },
    })
    const tick = s.runTick()
    await inScan.promise
    const killer = await rawClient()
    try {
      expect((await killer.query('SELECT pg_terminate_backend($1) AS ok', [leaderPid])).rows[0].ok).toBe(true)
    } finally {
      await killer.end()
    }
    await settle(() => (gauge.state() === 'relinquished' ? true : null), 5000, 'the leader connection error')
    gate.resolve()
    expect(await tick).toEqual({ leader: true, reason: 'leader_client_lost', jobs: { hold: { sawLost: true } } })
    expect(delivery.runs).toBe(0)
    const next = await s.runTick()
    expect(next.leader).toBe(true)
    expect(next.reason).toBeUndefined()
    expect(delivery.runs).toBe(1)
    expect(gauge.state()).toBe('leader')
  })

  it('the probe tells the two apart: the same scenario in a child exits 0 with the listener, and dies on the unhandled error (exit 42) without it', () => {
    // Positive control: the source as it is (the needle replaced by itself).
    runSourceMutant(SCHEDULER_FILE, LISTENER_NEEDLE, LISTENER_NEEDLE, terminationScript(), {}, { unique: true })
    // Negative control: no listener on the leader client.
    let status: unknown
    try {
      runSourceMutant(SCHEDULER_FILE, LISTENER_NEEDLE, '', terminationScript(), {}, { unique: true })
    } catch (error) {
      status = (error as { status?: unknown }).status
    }
    expect(status).toBe(42)
  }, 120000)
})

// ── The leader session bound ─────────────────────────────────────────────────────────────────────

describe('the leader session bound (design §6.1; ASSUMPTION(task-m4): [own-3b-35])', () => {
  it('a leader whose socket stops responding without closing loses its backend, and the lock, within the idle bound; another instance leads at its next tick; the stalled tick ends leader_client_lost once its socket is gone', async () => {
    const relay = await frozenRelay()
    const observer = await rawClient()
    const gauge = recordingGauge()
    let leaderPid = 0
    const gate = deferred()
    const inScan = deferred()
    const a = scheduler({
      scanJobs: [{ name: 'hold', run: async (ctx) => { inScan.resolve(); await gate.promise; return { lost: ctx.leaderLost() } } }],
      connectLeaderClient: leaderClientOn(relay.url, (pid) => { leaderPid = pid }),
      leaderIdleTimeoutMs: 1500,
      leaderStateGauge: gauge.gauge,
    })
    const scan = countingJob('other-scan')
    const b = scheduler({ scanJobs: [scan], lockTimeoutMs: 1000 })
    try {
      const tickA = a.runTick()
      await inScan.promise
      expect(await backendAlive(observer, leaderPid)).toBe(true)
      relay.freeze()
      const frozenAt = Date.now()
      // A's backend still holds the lock: the other instance is a follower.
      expect(await b.runTick()).toEqual({ leader: false, reason: 'lock_busy' })
      expect(scan.runs).toBe(0)
      // The server ends the idle session within the bound; nothing on the client side did it.
      await settle(async () => ((await backendAlive(observer, leaderPid)) ? null : true), 1500 + 3000, 'the server to end the stalled leader session')
      expect(Date.now() - frozenAt).toBeLessThanOrEqual(1500 + 3000)
      const next = await b.runTick()
      expect(next.leader).toBe(true)
      expect(next.reason).toBeUndefined()
      expect(scan.runs).toBe(1)
      // The stalled instance: once its socket is gone for good the listener marks the leader lost; the tick commits nothing.
      await relay.close()
      await settle(() => (gauge.state() === 'relinquished' ? true : null), 5000, 'the stalled leader to notice its connection')
      gate.resolve()
      expect(await tickA).toEqual({ leader: true, reason: 'leader_client_lost', jobs: { hold: { lost: true } } })
    } finally {
      gate.resolve()
      await relay.close()
      await observer.end()
    }
  }, 30000)

  it('an alive leader whose scan outlasts the idle bound is kept by the heartbeats it sends between pages; a scan that sends none is ended by the server and the tick is leader_client_lost', async () => {
    const beating = scheduler({
      leaderIdleTimeoutMs: 1500,
      scanJobs: [{
        name: 'long',
        run: async (ctx) => {
          for (let i = 0; i < 6; i += 1) {
            await wait(500)
            await ctx.leaderHeartbeat?.()
          }
          return { lost: ctx.leaderLost() }
        },
      }],
    })
    expect(await beating.runTick()).toEqual({ leader: true, jobs: { long: { lost: false } } })

    const silent = scheduler({
      leaderIdleTimeoutMs: 1500,
      scanJobs: [{
        name: 'long-silent',
        run: async (ctx) => {
          const started = Date.now()
          await settle(() => (ctx.leaderLost() ? true : null), 1500 + 3000, 'the idle bound to end the leader session')
          return { lost: ctx.leaderLost(), afterAtLeastMs: Date.now() - started >= 1000 }
        },
      }],
    })
    expect(await silent.runTick()).toEqual({ leader: true, reason: 'leader_client_lost', jobs: { 'long-silent': { lost: true, afterAtLeastMs: true } } })
    // After either tick the lock is free: a plain tick leads.
    const after = countingJob('after')
    expect((await scheduler({ scanJobs: [after] }).runTick()).leader).toBe(true)
    expect(after.runs).toBe(1)
  }, 30000)

  it('the digest scan\'s per-org phase outlasting the idle bound: the heartbeats inside the phase keep the leader\'s backend and the lock, every row is written once and the tick commits as leader; a second instance is a follower during the phase and leads afterwards', async () => {
    // 51 orgs with one due digest user each; the membership read of each org is slowed by 200 ms, so the
    // phase takes over 10 s against a 5 s idle bound, while a heartbeat group of 5 orgs takes about 1 s
    // (its ten real statements would have to average 400 ms for the group to reach the bound).
    const ORGS = 51
    const HEARTBEAT_ORGS = 5
    const DELAY_MS = 200
    const BOUND_MS = 5000
    const stamp = stampOf()
    const users: string[] = []
    for (let i = 0; i < ORGS; i += 1) {
      const orgId = orgOf('phase', `${stamp}_${String(i).padStart(2, '0')}`)
      const user = `usrP_phase_${stamp}_${i}`
      await digestUser(orgId, user, 'Asia/Shanghai')
      await activeIntegration(orgId)
      users.push(user)
    }
    let membershipReads = 0
    const slowed: TaskDeliveryQuery = async (sql, params) => {
      if (sql.includes('FROM user_orgs uo')) {
        membershipReads += 1
        await wait(DELAY_MS)
      }
      const result = await poolManager.get().query(sql, params)
      return { rows: result.rows }
    }
    const observer = await rawClient()
    let leaderPid = 0
    const a = scheduler({
      scanJobs: [resolveTaskDailyDigestJob({ env: PIPELINE_ON, query: slowed, heartbeatOrgs: HEARTBEAT_ORGS })],
      // 01:30 UTC = 09:30 in Shanghai: every user is due.
      readNow: async () => at(BASE_MS + 21 * DAY),
      leaderIdleTimeoutMs: BOUND_MS,
      connectLeaderClient: async () => {
        const client = await connectLeaderClient()
        leaderPid = Number(((await client.query('SELECT pg_backend_pid() AS pid')) as { rows: Array<{ pid: number }> }).rows[0].pid)
        return client
      },
    })
    const other = countingJob('other-scan')
    const b = scheduler({ scanJobs: [other], lockTimeoutMs: 1000 })
    try {
      const tickA = a.runTick()
      await settle(() => (membershipReads >= 5 ? true : null), 10000, 'the per-org phase to be under way')
      const underWayAt = Date.now()
      // The lock is held throughout the phase: the other instance waits its timeout and is a follower.
      expect(await b.runTick()).toEqual({ leader: false, reason: 'lock_busy' })
      expect(other.runs).toBe(0)
      const resultA = await tickA
      expect(Date.now() - underWayAt).toBeGreaterThan(BOUND_MS)
      expect(resultA.reason).toBeUndefined()
      expect(resultA.leader).toBe(true)
      expect(resultA.jobs?.['task-daily-digest-scan']).toMatchObject({ settings: ORGS, due: ORGS, written: ORGS, inactiveMember: 0, invalidZone: 0 })
      expect(membershipReads).toBe(ORGS)
      expect(await backendAlive(observer, leaderPid)).toBe(true)
      const rows = (await poolManager.get().query<{ recipient_user_id: string }>(
        'SELECT recipient_user_id FROM task_notification_deliveries WHERE recipient_user_id = ANY($1::text[]) ORDER BY recipient_user_id',
        [users],
      )).rows.map((row) => row.recipient_user_id)
      expect(rows).toEqual([...users].sort())
      // Afterwards the lock is free: the other instance leads.
      const next = await b.runTick()
      expect(next.leader).toBe(true)
      expect(next.reason).toBeUndefined()
      expect(other.runs).toBe(1)
    } finally {
      await observer.end()
    }
  }, 90000)
})

// ── The reminder scan (M4-c, scan half) ──────────────────────────────────────────────────────────

describe('the reminder scan (RULED(2026-10-07): [R06]; design §6.2, §11.4)', () => {
  it('window, floor and task state: due rows are written once; the window\'s lower edge, a floor after the moment, no floor, done, deleted and future tasks are not; a second tick writes nothing; a rescheduled reminder gets a new row', async () => {
    const o = await orgWithMembers('win')
    const now = at(BASE_MS)
    const db = poolManager.get()
    const ok = await reminderTask(o.orgId, o.creator, [o.assignee], at(BASE_MS - 30 * MINUTE), '窗口内')
    const atNow = await reminderTask(o.orgId, o.creator, [o.assignee], now, '恰好到点')
    const edge = await reminderTask(o.orgId, o.creator, [o.assignee], at(BASE_MS - W), '下沿')
    const older = await reminderTask(o.orgId, o.creator, [o.assignee], at(BASE_MS - W - MINUTE), '更早')
    const lateFloor = await reminderTask(o.orgId, o.creator, [o.assignee], at(BASE_MS - 30 * MINUTE), '写入在后')
    await remindChanged(lateFloor, o.creator, at(BASE_MS - 29 * MINUTE))
    const noFloor = await reminderTask(o.orgId, o.creator, [o.assignee], at(BASE_MS - 30 * MINUTE), '无事件')
    await db.query('DELETE FROM task_events WHERE task_id = $1', [noFloor])
    const done = await reminderTask(o.orgId, o.creator, [o.assignee], at(BASE_MS - 30 * MINUTE), '已完成')
    await db.query(`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1`, [done])
    const gone = await reminderTask(o.orgId, o.creator, [o.assignee], at(BASE_MS - 30 * MINUTE), '已删除')
    await db.query('UPDATE tasks SET deleted_at = now() WHERE id = $1', [gone])
    await reminderTask(o.orgId, o.creator, [o.assignee], at(BASE_MS + HOUR), '未来')

    const first = await runTaskReminderScan(ctxAt(now), { env: PIPELINE_ON })
    // Candidates: inside the SQL window, open and live (ok, atNow, lateFloor, noFloor); due: floor holds.
    expect(first).toEqual({ ran: true, pages: 1, candidates: 4, due: 2, written: 2 })
    const rows = await outboxOfOrg(o.orgId)
    expect(rows.map((row) => [row.source_id, row.recipient_user_id, row.recipient_role, row.status]).sort()).toEqual(
      [[ok, o.assignee, 'assignee', 'pending'], [atNow, o.assignee, 'assignee', 'pending']].sort(),
    )
    for (const id of [edge, older, lateFloor, noFloor, done, gone]) {
      expect(rows.some((row) => row.source_id === id), id).toBe(false)
    }
    const okRow = rows.find((row) => row.source_id === ok)
    expect(okRow?.payload).toEqual({ kind: 'task_reminder', taskId: ok, remindAt: at(BASE_MS - 30 * MINUTE).toISOString() })
    expect(okRow?.source_key).toBe(`task_reminder:${ok}:${at(BASE_MS - 30 * MINUTE).toISOString()}:recipient:${o.assignee}:channel:${CHANNEL}`)

    // A second tick inside the window writes nothing new.
    expect(await runTaskReminderScan(ctxAt(at(BASE_MS + MINUTE)), { env: PIPELINE_ON })).toMatchObject({ due: 2, written: 0 })
    // Rescheduled before the new moment: a new key and a new row; the old row stays.
    await db.query('UPDATE tasks SET remind_at = $2 WHERE id = $1', [ok, at(BASE_MS - 20 * MINUTE)])
    await remindChanged(ok, o.creator, at(BASE_MS - 25 * MINUTE))
    expect(await runTaskReminderScan(ctxAt(at(BASE_MS + 2 * MINUTE)), { env: PIPELINE_ON })).toMatchObject({ written: 1 })
    expect((await outboxOfOrg(o.orgId)).filter((row) => row.source_id === ok)).toHaveLength(2)
  })

  it('recipients: the incomplete assignees only; the creator (role creator) for a task without assignee rows; followers get no reminder', async () => {
    const o = await orgWithMembers('rcpt')
    const second = `usrB_rcpt_${o.stamp}`
    const follower = `usrF_rcpt_${o.stamp}`
    await members(o.orgId, second, follower)
    const moment = at(BASE_MS + 3 * DAY - 10 * MINUTE)
    const pair = await reminderTask(o.orgId, o.creator, [o.assignee, second], moment, '两人')
    await completeTask({ orgId: o.orgId, actorId: second, taskId: pair })
    await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [pair, follower])
    const solo = await reminderTask(o.orgId, o.creator, [], moment, '无负责人')
    const result = await runTaskReminderScan(ctxAt(at(BASE_MS + 3 * DAY)), { env: PIPELINE_ON })
    expect(result).toMatchObject({ due: 2, written: 2 })
    const rows = await outboxOfOrg(o.orgId)
    expect(rows.map((row) => [row.source_id, row.recipient_user_id, row.recipient_role]).sort()).toEqual(
      [[pair, o.assignee, 'assignee'], [solo, o.creator, 'creator']].sort(),
    )
  })

  it('one tick drains the window across pages (ASSUMPTION(task-m4): [own-3b-15]): page size 5, 12 tasks at one instant, the first 3 by id with a floor after the moment ⇒ 9 rows in 3 pages', async () => {
    const o = await orgWithMembers('page')
    const moment = at(BASE_MS + 6 * DAY - 10 * MINUTE)
    for (let i = 0; i < 12; i += 1) await reminderTask(o.orgId, o.creator, [o.assignee], moment, `分页${i}`)
    const firstIds = (await poolManager.get().query<{ id: string }>(
      'SELECT id FROM tasks WHERE org_id = $1 ORDER BY id ASC LIMIT 3', [o.orgId],
    )).rows.map((row) => row.id)
    for (const id of firstIds) await remindChanged(id, o.creator, at(moment.getTime() + 1000))
    const result = await runTaskReminderScan(ctxAt(at(BASE_MS + 6 * DAY)), { env: PIPELINE_ON, pageSize: 5 })
    expect(result).toEqual({ ran: true, pages: 3, candidates: 12, due: 9, written: 9 })
    const rows = await outboxOfOrg(o.orgId)
    expect(rows).toHaveLength(9)
    for (const id of firstIds) expect(rows.some((row) => row.source_id === id), id).toBe(false)
  })

  it('501 tasks at one instant with the default page size: one tick writes all 501 rows in two pages', async () => {
    const o = await orgWithMembers('bulk')
    const moment = at(BASE_MS + 9 * DAY - 10 * MINUTE)
    const db = poolManager.get()
    await db.query(
      `INSERT INTO tasks (id, org_id, title, created_by, remind_at)
       SELECT 'tsk_s5bulk' || $3 || lpad(g::text, 4, '0'), $1, 'bulk', $2, $4
         FROM generate_series(1, 501) AS g`,
      [o.orgId, o.creator, o.stamp, moment],
    )
    await db.query(
      `INSERT INTO task_events (id, task_id, actor_id, event_type)
       SELECT 'tev_s5bulk' || substr(t.id, 11), t.id, t.created_by, 'created' FROM tasks t WHERE t.org_id = $1`,
      [o.orgId],
    )
    const result = await runTaskReminderScan(ctxAt(at(BASE_MS + 9 * DAY)), { env: PIPELINE_ON })
    expect(result).toEqual({ ran: true, pages: 2, candidates: 501, due: 501, written: 501 })
    expect(await outboxOfOrg(o.orgId)).toHaveLength(501)
  }, 60000)
})

// ── The org precondition and the switches ────────────────────────────────────────────────────────

describe('both scans: the org precondition and the pipeline switches (ASSUMPTION(task-m4): [own-3b-13] [own-3b-01]; design §5.1, §11.2)', () => {
  it('org A without a DingTalk integration and org B with an inactive one get no row from either scan; org C with an active one does; with any switch off nothing is read or written', async () => {
    const stamp = stampOf()
    const orgs = { a: orgOf('pa', stamp), b: orgOf('pb', stamp), c: orgOf('pc', stamp) }
    const now = at(Date.UTC(2031, 3, 1, 1, 30))
    for (const [key, orgId] of Object.entries(orgs)) {
      const user = `usrP${key}_${stamp}`
      await members(orgId, user)
      if (key === 'b') await seedOrgDingTalkIntegration(orgId, { status: 'inactive' })
      if (key === 'c') await activeIntegration(orgId)
      await reminderTask(orgId, user, [user], at(now.getTime() - 10 * MINUTE), '前提')
      await poolManager.get().query(
        `INSERT INTO task_user_settings (user_id, org_id, daily_reminder_enabled, time_zone) VALUES ($1, $2, true, 'Asia/Shanghai')`,
        [user, orgId],
      )
    }
    for (const env of [{ ...PIPELINE_ON, TASKS_SCHEDULER_ENABLED: 'false' }, { ...PIPELINE_ON, TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: undefined }]) {
      const counting = countingQuery()
      expect(await runTaskReminderScan(ctxAt(now), { env, query: counting.query })).toMatchObject({ ran: false, written: 0 })
      expect(await runTaskDailyDigestScan(ctxAt(now), { env, query: counting.query })).toMatchObject({ ran: false, written: 0 })
      expect(counting.count()).toBe(0)
    }
    expect(await outboxOfPrefix()).toEqual([])
    expect(await runTaskReminderScan(ctxAt(now), { env: PIPELINE_ON })).toMatchObject({ due: 3, written: 1 })
    expect(await runTaskDailyDigestScan(ctxAt(now), { env: PIPELINE_ON })).toMatchObject({ written: 1 })
    const rows = await outboxOfPrefix()
    expect(rows.map((row) => [row.org_id, row.source_type]).sort()).toEqual([[orgs.c, 'task_daily'], [orgs.c, 'task_reminder']])
  })
})

// ── The daily digest scan (M4-c, scan half) ──────────────────────────────────────────────────────

async function digestUser(orgId: string, userId: string, tz: string): Promise<void> {
  await members(orgId, userId)
  await poolManager.get().query(
    'INSERT INTO task_user_settings (user_id, org_id, daily_reminder_enabled, time_zone) VALUES ($1, $2, true, $3)',
    [userId, orgId, tz],
  )
}

describe('the daily digest scan (RULED(2026-10-07): [R07]; ASSUMPTION(task-m4): [own-3b-02]; design §6.3, §11.5)', () => {
  it('two zones: at 01:30 UTC Shanghai (09:30) is due and Kiritimati (15:30) is not; at 19:30 UTC the day before it is the other way round; each row carries its own local date', async () => {
    const stamp = stampOf()
    const orgId = orgOf('zones', stamp)
    await activeIntegration(orgId)
    const sh = `usrSH_${stamp}`
    const ki = `usrKI_${stamp}`
    await digestUser(orgId, sh, 'Asia/Shanghai')
    await digestUser(orgId, ki, 'Pacific/Kiritimati')
    await runTaskDailyDigestScan(ctxAt(at(Date.UTC(2031, 4, 12, 1, 30))), { env: PIPELINE_ON })
    expect((await outboxOfOrg(orgId)).map((row) => [row.recipient_user_id, row.payload])).toEqual([
      [sh, { kind: 'task_daily', date: '2031-05-12', timeZone: 'Asia/Shanghai' }],
    ])
    await runTaskDailyDigestScan(ctxAt(at(Date.UTC(2031, 4, 11, 19, 30))), { env: PIPELINE_ON })
    const rows = await outboxOfOrg(orgId)
    expect(rows.map((row) => [row.recipient_user_id, row.payload.date, row.recipient_role, row.source_id, row.status]).sort()).toEqual([
      [ki, '2031-05-12', 'assignee', ki, 'pending'],
      [sh, '2031-05-12', 'assignee', sh, 'pending'],
    ])
    expect(rows.find((row) => row.recipient_user_id === ki)?.source_key).toBe(`task_daily:2031-05-12:recipient:${ki}:channel:${CHANNEL}`)
  })

  it('one row a day: two ticks inside the window write one row, the next day another; one millisecond before 09:00 or at 09:00 + W nothing is written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('daily', stamp)
    await activeIntegration(orgId)
    const me = `usrD_daily_${stamp}`
    await digestUser(orgId, me, 'Asia/Shanghai')
    const sendAt = (date: string): number => computeDailyDigestSendAt(date, 'Asia/Shanghai').getTime()
    const tick = async (ms: number) => runTaskDailyDigestScan(ctxAt(at(ms)), { env: PIPELINE_ON })
    expect(await tick(sendAt('2031-06-01') + 5 * MINUTE)).toMatchObject({ written: 1 })
    expect(await tick(sendAt('2031-06-01') + W - 1)).toMatchObject({ written: 0 })
    expect(await tick(sendAt('2031-06-02'))).toMatchObject({ written: 1 })
    expect(await tick(sendAt('2031-06-03') - 1)).toMatchObject({ written: 0 })
    expect(await tick(sendAt('2031-06-04') + W)).toMatchObject({ written: 0 })
    expect((await outboxOfOrg(orgId)).map((row) => row.payload.date)).toEqual(['2031-06-01', '2031-06-02'])
  })

  it('a settings row whose user is no longer an active member of the org writes no row, on any day (RULED(2026-10-07): [R17]; ASSUMPTION(task-m4): [own-3b-38]); an active neighbour still gets its row', async () => {
    const stamp = stampOf()
    const orgId = orgOf('departed', stamp)
    await activeIntegration(orgId)
    const stays = `usrS_dep_${stamp}`
    const gone = `usrG_dep_${stamp}`
    await digestUser(orgId, stays, 'Asia/Shanghai')
    await seedOrgMembers(orgId, [gone], { active: false })
    seededUsers.push(gone)
    await poolManager.get().query(
      'INSERT INTO task_user_settings (user_id, org_id, daily_reminder_enabled, time_zone) VALUES ($1, $2, true, $3)',
      [gone, orgId, 'Asia/Shanghai'],
    )
    const sendAt = (date: string): number => computeDailyDigestSendAt(date, 'Asia/Shanghai').getTime()
    for (const date of ['2031-08-01', '2031-08-02']) {
      const result = await runTaskDailyDigestScan(ctxAt(at(sendAt(date) + 5 * MINUTE)), { env: PIPELINE_ON })
      expect(result, date).toMatchObject({ due: 2, written: 1, inactiveMember: 1 })
    }
    expect((await outboxOfOrg(orgId)).map((row) => [row.recipient_user_id, row.payload.date])).toEqual([[stays, '2031-08-01'], [stays, '2031-08-02']])
  })

  it('a settings row whose zone cannot be resolved is counted and skipped; the other recipients still get their rows', async () => {
    const stamp = stampOf()
    const orgId = orgOf('badzone', stamp)
    await activeIntegration(orgId)
    const good = `usrG_${stamp}`
    const bad = `usrX_${stamp}`
    await digestUser(orgId, good, 'Asia/Shanghai')
    await digestUser(orgId, bad, 'Mars/Olympus_Mons')
    const result = await runTaskDailyDigestScan(ctxAt(at(Date.UTC(2031, 6, 1, 1, 30))), { env: PIPELINE_ON })
    expect(result.invalidZone).toBeGreaterThanOrEqual(1)
    expect((await outboxOfOrg(orgId)).map((row) => row.recipient_user_id)).toEqual([good])
  })
})

// ── The digest at send time through real ticks (R07 v2) ──────────────────────────────────────────

/**
 * The digest's content query reads the database clock and the window check reads the tick's clock;
 * both must see the same local date inside 09:00 + W. These cells pick a fixed-offset zone in which
 * the database's current time is 09:MM (or 12:MM for the SQL/TS comparison), far from local
 * midnight, and anchor the tick on the database clock.
 */
async function zoneAtLocalHour(hour: number): Promise<{ tz: string; dbNow: Date; today: string }> {
  const dbNow = await databaseNow()
  let offset = hour - dbNow.getUTCHours()
  if (offset < -12) offset += 24
  if (offset > 14) offset -= 24
  const tz = offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`
  return { tz, dbNow, today: viewerToday(dbNow, tz) }
}

describe('an empty digest through real ticks (RULED(2026-10-07): [R07]; design §11.5)', () => {
  it('the tick writes the day\'s row; a later tick delivers it as skipped / empty_digest with no send; a task due later the same day writes no second row and nothing is sent', async () => {
    const { tz, today } = await zoneAtLocalHour(9)
    const stamp = stampOf()
    const orgId = orgOf('empty', stamp)
    await activeIntegration(orgId)
    const me = `usrD_empty_${stamp}`
    const other = `usrO_empty_${stamp}`
    await digestUser(orgId, me, tz)
    await members(orgId, other)
    const channel = new FakeTaskDeliveryChannel({ label: 'tick' })
    const deliveryJob = resolveTaskNotificationDeliveryJob({ env: PIPELINE_ON, channels: [channel] })
    let offsetMs = 0
    const s = scheduler({
      scanJobs: [resolveTaskDailyDigestJob({ env: PIPELINE_ON })],
      deliveryJob,
      readNow: async () => new Date((await databaseNow()).getTime() + offsetMs),
    })
    // Tick 1: the scan writes the day's row. Its next_attempt_at is the database clock at the INSERT,
    // so whether this tick's delivery loop already claims it depends on the clock's progress; tick 2,
    // one second later, certainly does.
    expect((await s.runTick()).leader).toBe(true)
    const [row] = await outboxOfOrg(orgId)
    expect(row).toMatchObject({ source_type: 'task_daily', recipient_user_id: me, payload: { kind: 'task_daily', date: today, timeZone: tz } })
    offsetMs = 1000
    expect((await s.runTick()).leader).toBe(true)
    expect((await outboxOfOrg(orgId)).map((r) => [r.id, r.status, r.last_error, r.attempt_count])).toEqual([[row.id, 'skipped', 'empty_digest', 1]])
    // Thirty minutes later a task falls due today; tick 3 writes nothing new and sends nothing.
    const task = await createTask({ orgId, creatorId: other, title: '后到的今天项', assignees: [me], completionMode: 'all' })
    await poolManager.get().query(
      'UPDATE tasks SET due_date = (now() AT TIME ZONE $2)::date, due_time = NULL, due_at = NULL, time_zone = $2 WHERE id = $1',
      [task.id, tz],
    )
    offsetMs = 30 * MINUTE
    const third = await s.runTick()
    expect(third.jobs?.['task-daily-digest-scan']).toMatchObject({ written: 0 })
    expect((await outboxOfOrg(orgId)).map((r) => [r.id, r.status])).toEqual([[row.id, 'skipped']])
    expect(channel.calls.filter((call) => call.phase === 'send')).toEqual([])
  })

  it('the digest content condition and isInDailyDigest select the same tasks (TS/SQL comparison, design §11.5)', async () => {
    const { tz, dbNow } = await zoneAtLocalHour(12)
    const stamp = stampOf()
    const orgId = orgOf('pair', stamp)
    const me = `usrD_pair_${stamp}`
    const other = `usrO_pair_${stamp}`
    await members(orgId, me, other)
    const db = poolManager.get()
    const allDay = async (title: string, days: number): Promise<string> => {
      const task = await createTask({ orgId, creatorId: other, title, assignees: [me], completionMode: 'all' })
      await db.query(
        'UPDATE tasks SET due_date = (now() AT TIME ZONE $2)::date + $3::int, due_time = NULL, due_at = NULL, time_zone = $2 WHERE id = $1',
        [task.id, tz, days],
      )
      return task.id
    }
    const timed = async (title: string, days: number, time: string): Promise<string> => {
      const task = await createTask({ orgId, creatorId: other, title, assignees: [me], completionMode: 'all' })
      await db.query(
        `UPDATE tasks SET due_date = (now() AT TIME ZONE $2)::date + $3::int, due_time = $4::time, time_zone = $2,
                due_at = (((now() AT TIME ZONE $2)::date + $3::int) + $4::time) AT TIME ZONE $2
          WHERE id = $1`,
        [task.id, tz, days, time],
      )
      return task.id
    }
    await allDay('昨天', -1)
    await allDay('今天', 0)
    await allDay('明天', 1)
    await allDay('后天', 2)
    await timed('今天上午', 0, '08:00')
    await timed('明天深夜', 1, '23:59')
    await timed('后天零点', 2, '00:00')
    await timed('昨天下午', -1, '15:00')
    const doneTask = await allDay('已结束', 0)
    await db.query(`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1`, [doneTask])
    const shared = await createTask({ orgId, creatorId: other, title: '我已完成', assignees: [me, other], completionMode: 'all' })
    await db.query(
      'UPDATE tasks SET due_date = (now() AT TIME ZONE $2)::date, due_time = NULL, due_at = NULL, time_zone = $2 WHERE id = $1',
      [shared.id, tz],
    )
    await completeTask({ orgId, actorId: me, taskId: shared.id })

    const cond = buildTaskDailyDigestCondition({ actorParam: me, orgParam: orgId, viewerTzParam: tz })
    const sqlSet = (await db.query<{ id: string }>(`SELECT tasks.id FROM tasks WHERE ${cond.sql}`, cond.params)).rows.map((r) => r.id).sort()
    const all = (await db.query(
      `SELECT t.id, t.status, t.due_date::text AS due_date, t.due_time::text AS due_time, t.due_at, t.time_zone,
              EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $2 AND ta.completed_at IS NOT NULL) AS done_by_me
         FROM tasks t WHERE t.org_id = $1`,
      [orgId, me],
    )).rows
    const tsSet = all.filter((row) => isInDailyDigest({
      status: row.status as 'open' | 'done',
      completedByViewer: row.done_by_me === true,
      dueDate: row.due_date === null ? null : String(row.due_date),
      dueTime: row.due_time === null ? null : String(row.due_time),
      dueAt: row.due_at === null ? null : new Date(row.due_at as Date),
      timeZone: String(row.time_zone),
    }, dbNow, tz)).map((row) => String(row.id)).sort()
    expect(all).toHaveLength(10)
    expect(sqlSet).toEqual(tsSet)
    expect(sqlSet).toHaveLength(6)
  })
})

// ── End to end, start-up, stop, the backlog gauge ────────────────────────────────────────────────

describe('a whole tick, start-up with the switches off, stop(), the backlog gauge (design §6.4–§6.6, §11.6)', () => {
  it('one tick built like start-up: the scan writes a due reminder, the leader commits, the delivery loop sends it, the backlog gauge reads zero waiting', async () => {
    const o = await orgWithMembers('e2e')
    const now = at(BASE_MS + 12 * DAY)
    const taskId = await reminderTask(o.orgId, o.creator, [o.assignee], at(now.getTime() - 5 * MINUTE), '端到端')
    const channel = new FakeTaskDeliveryChannel({ label: 'e2e' })
    const leader = recordingGauge()
    const backlog = recordingGauge()
    const s = scheduler({
      scanJobs: [resolveTaskReminderJob({ env: PIPELINE_ON }), resolveTaskDailyDigestJob({ env: PIPELINE_ON })],
      deliveryJob: resolveTaskNotificationDeliveryJob({ env: PIPELINE_ON, channels: [channel] }),
      readNow: async () => now,
      leaderStateGauge: leader.gauge,
      backlogGauge: backlog.gauge,
    })
    const result = await s.runTick()
    expect(result.leader).toBe(true)
    expect(result.jobs?.['task-reminder-scan']).toMatchObject({ written: 1 })
    expect(result.jobs?.['task-notification-delivery']).toMatchObject({ totals: { claimed: 1, sent: 1 } })
    const [row] = await outboxOfOrg(o.orgId)
    expect(row).toMatchObject({ source_type: 'task_reminder', source_id: taskId, recipient_user_id: o.assignee, status: 'sent', attempt_count: 1 })
    expect(channel.sentIds()).toEqual([row.id])
    expect(channel.calls.find((call) => call.phase === 'send')?.title).toBe('任务提醒')
    expect(Object.fromEntries(backlog.values)).toEqual({ pending: 0, oldest_due_wait_seconds: 0, outcome_unknown: 0 })
    expect(leader.state()).toBe('leader')
  })

  it('switches off: startTaskScheduler returns null, no delivery job, no channel from the environment, a due row is never claimed; both on: a scheduler that stops cleanly', async () => {
    const o = await orgWithMembers('off')
    const db = poolManager.get().getInternalPool()
    const offEnvs: NodeJS.ProcessEnv[] = [{}, { TASKS_ENABLED: 'true' }, { TASKS_SCHEDULER_ENABLED: 'true' }, { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'TRUE' }]
    for (const env of offEnvs) {
      expect(startTaskScheduler({ env, pool: db as never, logger: quiet }), JSON.stringify(env)).toBeNull()
      expect(resolveTaskNotificationDeliveryJob({ env })).toBeNull()
      expect(createTaskDeliveryChannelsFromEnv(env)).toEqual([])
    }
    const due = await seedOutboxRow({
      orgId: o.orgId, sourceType: 'task_daily', sourceId: o.assignee, sourceKey: `task_daily:2031-01-01:recipient:${o.assignee}:channel:${CHANNEL}`,
      recipientUserId: o.assignee, recipientRole: 'assignee', channel: CHANNEL,
      payload: { kind: 'task_daily', date: '2031-01-01', timeZone: 'Asia/Shanghai' }, nextAttemptAt: at(BASE_MS),
    })
    const worker = new TaskNotificationDeliveryWorker({ channels: createTaskDeliveryChannelsFromEnv({}), now: steppedClock(at(BASE_MS + DAY)).now, env: PIPELINE_ON })
    expect(await worker.runBatch()).toMatchObject({ claimed: 0 })
    expect((await outboxOfOrg(o.orgId)).map((row) => [row.id, row.status, row.attempt_count])).toEqual([[due, 'pending', 0]])
    const started = startTaskScheduler({ env: { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'true' }, pool: db as never, logger: quiet })
    expect(started).toBeInstanceOf(TaskScheduler)
    await stopTaskScheduler()
    expect(await started?.runTick()).toEqual({ leader: false, reason: 'stopping' })
  })

  it('stop() during a tick: the scan sees stopping, the tick commits and returns its client, stop() waits for it, and the lock is free afterwards', async () => {
    const gate = deferred()
    const inScan = deferred()
    let sawStopping: boolean | undefined
    const delivery = countingJob('delivery')
    const s = scheduler({
      scanJobs: [{ name: 'hold', run: async (ctx) => { inScan.resolve(); await gate.promise; sawStopping = ctx.stopping() } }],
      deliveryJob: delivery,
    })
    const tick = s.runTick()
    await inScan.promise
    let stopped = false
    const stopping = s.stop().then(() => { stopped = true })
    // One turn of the event loop: the scan is still held, so stop() has not returned.
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    gate.resolve()
    await stopping
    expect(sawStopping).toBe(true)
    expect((await tick).leader).toBe(true)
    expect(delivery.runs).toBe(0)
    const other = countingJob('other')
    expect((await scheduler({ scanJobs: [other] }).runTick()).leader).toBe(true)
    expect(other.runs).toBe(1)
  })

  it('stop() while the delivery loop has a row in prepare: the unstarted rows are handed back, attempt returned, before stop() returns; the row in flight goes back when it returns; nothing is sent (design §6.6)', async () => {
    const o = await orgWithMembers('stopdeliv')
    const task = await createTask({ orgId: o.orgId, creatorId: o.creator, title: '停机退还', assignees: [o.assignee], completionMode: 'all' })
    const seeded: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const [plan] = planTaskEventDeliveries({
        orgId: o.orgId, taskId: task.id, eventId: `tev_s5stop${i}${o.stamp}`, event: 'commented', actorId: o.creator,
        recipients: [{ userId: o.assignee, recipientRole: 'assignee' }], channels: [CHANNEL],
      })
      seeded.push(await seedOutboxRow({
        orgId: plan.orgId, sourceType: plan.sourceType, sourceId: plan.sourceId, sourceKey: plan.sourceKey,
        recipientUserId: plan.recipientUserId, recipientRole: plan.recipientRole, channel: plan.channel,
        payload: plan.payload as unknown as Record<string, unknown>,
      }))
    }
    const gate = deferred()
    const inPrepare = deferred()
    const channel = new FakeTaskDeliveryChannel({
      label: 'stop',
      onPrepare: async (_target, index) => {
        if (index === 0) {
          inPrepare.resolve()
          await gate.promise
        }
      },
    })
    const dbNow = await databaseNow()
    const s = scheduler({
      deliveryJob: resolveTaskNotificationDeliveryJob({ env: PIPELINE_ON, channels: [channel] }),
      readNow: async () => new Date(dbNow.getTime() + 1000),
      stopGraceMs: 1000,
    })
    const claims = async () => (await poolManager.get().query<{ id: string; status: string; attempt_count: number; claim_worker_id: string | null; claim_expires_at: Date | null }>(
      'SELECT id::text AS id, status, attempt_count, claim_worker_id, claim_expires_at FROM task_notification_deliveries WHERE org_id = $1 ORDER BY id',
      [o.orgId],
    )).rows
    const tick = s.runTick()
    await inPrepare.promise
    const inFlight = channel.calls.find((call) => call.phase === 'prepare')?.deliveryId
    const started = Date.now()
    let stopped = false
    const stopping = s.stop().then(() => { stopped = true })
    // While stop() is still pending (the row in prepare holds the tick inside the grace), the other four rows are already back, unspent.
    const atHandBack = await settle(async () => {
      const rows = await claims()
      return rows.filter((row) => row.id !== inFlight && row.claim_worker_id === null).length === 4 ? rows : null
    }, 1500, 'the unstarted rows to be handed back')
    expect(stopped).toBe(false)
    expect(atHandBack).toHaveLength(5)
    for (const row of atHandBack.filter((row) => row.id !== inFlight)) {
      expect(row).toMatchObject({ status: 'pending', attempt_count: 0, claim_worker_id: null, claim_expires_at: null })
    }
    // The row in prepare is still held.
    const held = atHandBack.filter((row) => row.id === inFlight)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ status: 'pending', attempt_count: 1 })
    expect(held[0].claim_worker_id).not.toBeNull()
    await stopping
    expect(Date.now() - started).toBeLessThanOrEqual(1000 + 1500)
    expect(stopped).toBe(true)
    gate.resolve()
    const result = await tick
    expect(result.leader).toBe(true)
    expect(result.jobs?.['task-notification-delivery']).toMatchObject({ totals: { claimed: 5, released: 5, sent: 0, lostLease: 0 } })
    for (const row of await claims()) expect(row).toMatchObject({ status: 'pending', attempt_count: 0, claim_worker_id: null, claim_expires_at: null })
    expect(channel.sentIds()).toEqual([])
  })

  it('the backlog gauge after a leader tick: rows waiting (pending and retrying), whole seconds the earliest due one has waited, outcome_unknown rows', async () => {
    const o = await orgWithMembers('backlog')
    const now = at(BASE_MS + 15 * DAY)
    const seed = async (n: number, extra: Partial<Parameters<typeof seedOutboxRow>[0]>): Promise<void> => {
      await seedOutboxRow({
        orgId: o.orgId, sourceType: 'task_daily', sourceId: o.assignee, sourceKey: `task_daily:2031-02-0${n}:recipient:${o.assignee}:channel:${CHANNEL}`,
        recipientUserId: o.assignee, recipientRole: 'assignee', channel: CHANNEL,
        payload: { kind: 'task_daily', date: `2031-02-0${n}`, timeZone: 'Asia/Shanghai' }, ...extra,
      })
    }
    await seed(1, { nextAttemptAt: at(now.getTime() - 90_000) })
    await seed(2, { nextAttemptAt: at(now.getTime() + HOUR) })
    await seed(3, { status: 'retrying', attemptCount: 1, nextAttemptAt: at(now.getTime() - 30_000) })
    await seed(4, { status: 'outcome_unknown', attemptCount: 1 })
    await seed(5, { status: 'sent', attemptCount: 1, deliveredAt: now })
    const backlog = recordingGauge()
    const s = scheduler({ readNow: async () => now, backlogGauge: backlog.gauge })
    expect((await s.runTick()).leader).toBe(true)
    expect(Object.fromEntries(backlog.values)).toEqual({ pending: 3, oldest_due_wait_seconds: 90, outcome_unknown: 1 })
  })
})
