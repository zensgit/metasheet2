import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => {
    throw new Error('the scheduler under test must use its injected query')
  }),
  transaction: vi.fn(async () => {
    throw new Error('the scheduler under test must not open a pool transaction')
  }),
  pool: null,
}))

import { registry } from '../../src/metrics/metrics'
import type { TaskDeliveryQuery } from '../../src/services/task-notification-delivery-worker'
import type { Row } from '../../src/services/task-records'
import {
  createDbAnchoredClock,
  resolveTaskDailyDigestJob,
  resolveTaskNotificationDeliveryJob,
  resolveTaskReminderJob,
  runTaskDailyDigestScan,
  runTaskReminderScan,
  startTaskScheduler,
  stopTaskScheduler,
  TASK_NOTIFICATION_BACKLOG_KINDS,
  TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS,
  TASK_SCHEDULER_LEADER_LOCK_TIMEOUT_MS,
  TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS,
  TASK_SCHEDULER_STOP_GRACE_MS,
  TaskScheduler,
  type LeaderClient,
  type TaskSchedulerJob,
  type TaskSchedulerJobContext,
  type TaskSchedulerLeaderState,
  type TaskSchedulerOptions,
} from '../../src/services/task-scheduler'
import { TASK_SCHEDULER_INTERVAL_MAX_MS } from '../../src/services/task-notification-flags'
import { TASK_DELIVERY_TICK_BUDGET_MS } from '../../src/tasks/task-delivery-protocol'
import { tasksSchedulerLeaderLockKey } from '../../src/tasks/task-lock-keys'
import { TASK_NOTIFICATION_CHANNEL_DINGTALK } from '../../src/tasks/task-notifications'
import {
  TASK_REMINDER_FLOOR_EVENT_TYPES,
  TASK_REMINDER_SCAN_BATCH,
  TASK_REMINDER_SCAN_ORDER_BY,
  TASK_REMINDER_SCAN_WINDOW_MS,
} from '../../src/tasks/task-reminders'

/**
 * M4 PR-3b S5 (design task-m4-pr3b-backend-design-20261001.md §3.2, §6): the scheduler on a fake
 * leader client and scripted queries. Pins what a database run cannot show directly: the exact
 * statements of the leader transaction (the two bounds and the lock) and their order around the
 * jobs, the heartbeat the scans send on the leader client, the listener's lifetime, how the client
 * is released, each tick reason, the gauges, the interval validation and the timer, the stop grace
 * and the stop signal, the start-up switches, and the scans' statement texts, paging and
 * membership filter. The database behaviour is tests/integration/task-m4-scheduler.db.test.ts.
 */

const DB_NOW = new Date('2026-10-08T01:30:00.000Z')
const PIPELINE_ON: NodeJS.ProcessEnv = {
  TASKS_ENABLED: 'true',
  TASKS_SCHEDULER_ENABLED: 'true',
  TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true',
  TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true',
}
const LOCK_KEY = tasksSchedulerLeaderLockKey()

afterEach(async () => {
  vi.useRealTimers()
  await stopTaskScheduler()
})

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function sqlError(code: string): Error {
  return Object.assign(new Error(`sqlstate ${code}`), { code })
}

/** A leader client that records every call into a shared log and answers the lock as scripted. */
class FakeLeaderClient implements LeaderClient {
  readonly listeners: Array<(error: Error) => void> = []
  released: { error: unknown } | null = null

  constructor(
    private readonly log: string[],
    private readonly script: {
      lock?: () => Promise<unknown>
      commit?: () => Promise<unknown>
      begin?: () => Promise<unknown>
      rollback?: () => Promise<unknown>
      heartbeat?: () => Promise<unknown>
    } = {},
  ) {}

  lockParams: unknown[] | undefined

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    this.log.push(`leader:${sql}`)
    if (sql === 'BEGIN' && this.script.begin) return this.script.begin()
    if (sql.includes('pg_advisory_xact_lock')) {
      this.lockParams = params
      return this.script.lock ? this.script.lock() : { rows: [] }
    }
    if (sql === 'COMMIT' && this.script.commit) return this.script.commit()
    if (sql === 'ROLLBACK' && this.script.rollback) return this.script.rollback()
    if (sql === 'SELECT 1' && this.script.heartbeat) return this.script.heartbeat()
    return { rows: [] }
  }

  on(event: 'error', listener: (error: Error) => void): this {
    this.log.push(`leader:on:${event}`)
    this.listeners.push(listener)
    return this
  }

  removeListener(event: 'error', listener: (error: Error) => void): this {
    this.log.push(`leader:removeListener:${event}`)
    const at = this.listeners.indexOf(listener)
    if (at >= 0) this.listeners.splice(at, 1)
    return this
  }

  release(error?: Error | boolean): void {
    this.log.push(`leader:release:${error ? 'destroy' : 'return'}`)
    this.released = { error }
  }

  /** What an EventEmitter does: the listeners get it, and with none attached it throws. */
  emitError(error: Error): void {
    if (this.listeners.length === 0) throw error
    for (const listener of [...this.listeners]) listener(error)
  }
}

function recordingGauge<L extends string>(): { gauge: { labels(labels: Record<string, L>): { set(value: number): void } }; values: Map<string, number> } {
  const values = new Map<string, number>()
  return {
    values,
    gauge: {
      labels: (labels: Record<string, L>) => ({
        set: (value: number) => {
          values.set(Object.values(labels)[0], value)
        },
      }),
    },
  }
}

function leaderStateOf(values: Map<string, number>): TaskSchedulerLeaderState | 'none' {
  const on = ['leader', 'follower', 'relinquished'].filter((state) => values.get(state) === 1)
  if (on.length !== 1) return 'none'
  const off = ['leader', 'follower', 'relinquished'].filter((state) => values.get(state) === 0)
  expect(off).toHaveLength(2)
  return on[0] as TaskSchedulerLeaderState
}

function job(log: string[], name: string, run?: (ctx: TaskSchedulerJobContext) => Promise<unknown>): TaskSchedulerJob {
  return {
    name,
    run: async (ctx) => {
      log.push(`job:${name}`)
      return run ? run(ctx) : { ran: name }
    },
  }
}

interface Kit {
  scheduler: TaskScheduler
  log: string[]
  client: FakeLeaderClient
  gauge: Map<string, number>
  backlog: Map<string, number>
  warns: string[]
  connects: () => number
}

function kit(
  overrides: Partial<TaskSchedulerOptions> & { client?: FakeLeaderClient; log?: string[]; clientScript?: ConstructorParameters<typeof FakeLeaderClient>[1] } = {},
): Kit {
  const log = overrides.log ?? []
  const client = overrides.client ?? new FakeLeaderClient(log, overrides.clientScript)
  const leader = recordingGauge<TaskSchedulerLeaderState>()
  const backlog = recordingGauge<string>()
  const warns: string[] = []
  let connects = 0
  const backlogQuery: TaskDeliveryQuery = async (sql) => {
    log.push(sql.includes('task_notification_deliveries') ? 'backlog' : `pool:${sql}`)
    return { rows: [{ pending: '3', oldest_due: new Date(DB_NOW.getTime() - 90_500), outcome_unknown: '2' }] }
  }
  const scheduler = new TaskScheduler({
    scanJobs: [job(log, 'scan-a'), job(log, 'scan-b')],
    deliveryJob: job(log, 'delivery'),
    connectLeaderClient: async () => {
      connects += 1
      log.push('connect')
      return client
    },
    readNow: async () => {
      log.push('readNow')
      return DB_NOW
    },
    query: backlogQuery,
    logger: { info: () => undefined, warn: (message: string) => { warns.push(message) } },
    leaderStateGauge: leader.gauge,
    backlogGauge: backlog.gauge,
    ...overrides,
  })
  return { scheduler, log, client, gauge: leader.values, backlog: backlog.values, warns, connects: () => connects }
}

const LEADER_TX = [
  'leader:BEGIN',
  `leader:SET LOCAL lock_timeout = '${TASK_SCHEDULER_LEADER_LOCK_TIMEOUT_MS}ms'`,
  `leader:SET LOCAL idle_in_transaction_session_timeout = '${TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS}ms'`,
  'leader:SELECT pg_advisory_xact_lock(hashtext($1))',
]

// ── One leader tick ──────────────────────────────────────────────────────────────────────────────

describe('a leader tick (design §6.1, §6.4)', () => {
  it('the leader transaction holds exactly the two SET LOCAL bounds and the lock; the scans run inside it, the delivery job and the backlog after the commit and the release', async () => {
    const k = kit()
    const result = await k.scheduler.runTick()
    expect(result).toEqual({ leader: true, jobs: { 'scan-a': { ran: 'scan-a' }, 'scan-b': { ran: 'scan-b' }, delivery: { ran: 'delivery' } } })
    expect(k.log).toEqual([
      'readNow',
      'connect',
      'leader:on:error',
      ...LEADER_TX,
      'job:scan-a',
      'job:scan-b',
      'leader:COMMIT',
      'leader:removeListener:error',
      'leader:release:return',
      'job:delivery',
      'backlog',
    ])
    expect(k.client.lockParams).toEqual([LOCK_KEY])
    expect(k.client.listeners).toHaveLength(0)
    expect(leaderStateOf(k.gauge)).toBe('leader')
  })

  it('the lock wait is bounded by the configured lock timeout', async () => {
    const k = kit({ lockTimeoutMs: 1500 })
    await k.scheduler.runTick()
    expect(k.log).toContain("leader:SET LOCAL lock_timeout = '1500ms'")
    expect(k.scheduler.lockTimeoutMs).toBe(1500)
    expect(new TaskScheduler({ scanJobs: [], connectLeaderClient: async () => k.client }).lockTimeoutMs).toBe(1000)
    for (const lockTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => kit({ lockTimeoutMs })).toThrow(TypeError)
    }
  })

  it('the leader session is bounded on the server side by the configured idle timeout, set inside the transaction before the lock; the default is 30 s (ASSUMPTION(task-m4): [own-3b-35])', async () => {
    const k = kit({ leaderIdleTimeoutMs: 2500 })
    await k.scheduler.runTick()
    const begin = k.log.indexOf('leader:BEGIN')
    expect(k.log.slice(begin, begin + 4)).toEqual([
      'leader:BEGIN',
      "leader:SET LOCAL lock_timeout = '1000ms'",
      "leader:SET LOCAL idle_in_transaction_session_timeout = '2500ms'",
      'leader:SELECT pg_advisory_xact_lock(hashtext($1))',
    ])
    expect(k.scheduler.leaderIdleTimeoutMs).toBe(2500)
    expect(TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS).toBe(30_000)
    expect(new TaskScheduler({ scanJobs: [], connectLeaderClient: async () => k.client }).leaderIdleTimeoutMs).toBe(30_000)
    for (const leaderIdleTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => kit({ leaderIdleTimeoutMs })).toThrow(TypeError)
    }
  })

  it('the jobs share one database-anchored clock that starts at the database clock read at the start of the tick', async () => {
    let mono = 1000
    const seen: number[] = []
    const k = kit({
      monotonic: () => mono,
      scanJobs: [{ name: 'clock', run: async (ctx) => { seen.push(ctx.now().getTime()); mono += 250; seen.push(ctx.now().getTime()) } }],
      deliveryJob: { name: 'clock-after', run: async (ctx) => { seen.push(ctx.now().getTime()) } },
    })
    await k.scheduler.runTick()
    expect(seen).toEqual([DB_NOW.getTime(), DB_NOW.getTime() + 250, DB_NOW.getTime() + 250])
  })

  it('a failing job is recorded with a code and does not stop the other jobs', async () => {
    const log: string[] = []
    const k = kit({
      log,
      scanJobs: [job(log, 'scan-a', async () => { throw sqlError('42P01') }), job(log, 'scan-b')],
    })
    const result = await k.scheduler.runTick()
    expect(result.leader).toBe(true)
    expect(result.jobs).toEqual({ 'scan-a': { failed: true, code: '42P01' }, 'scan-b': { ran: 'scan-b' }, delivery: { ran: 'delivery' } })
    expect(log).toContain('leader:COMMIT')
    expect(k.warns).toContain('task scheduler job failed')
  })

  it('without a delivery job the tick commits and refreshes the backlog only', async () => {
    const k = kit({ deliveryJob: null })
    const result = await k.scheduler.runTick()
    expect(Object.keys(result.jobs ?? {})).toEqual(['scan-a', 'scan-b'])
    expect(k.log.slice(-3)).toEqual(['leader:removeListener:error', 'leader:release:return', 'backlog'])
  })
})

// ── Not the leader ───────────────────────────────────────────────────────────────────────────────

describe('a tick that is not the leader (design §6.1)', () => {
  it.each(['55P03', '57014'])('the lock wait ends with %s: rolled back, client returned, follower, no job runs', async (code) => {
    const k = kit({ clientScript: { lock: async () => { throw sqlError(code) } } })
    const result = await k.scheduler.runTick()
    expect(result).toEqual({ leader: false, reason: 'lock_busy' })
    expect(k.log).toEqual(['readNow', 'connect', 'leader:on:error', ...LEADER_TX, 'leader:ROLLBACK', 'leader:removeListener:error', 'leader:release:return'])
    expect(leaderStateOf(k.gauge)).toBe('follower')
  })

  it('any other failure of the leader transaction: the client is destroyed, follower, leader_unavailable, no job runs', async () => {
    for (const failing of ['begin', 'lock'] as const) {
      const k = kit({ clientScript: { [failing]: async () => { throw sqlError('08006') } } })
      const result = await k.scheduler.runTick()
      expect(result, failing).toEqual({ leader: false, reason: 'leader_unavailable' })
      expect(k.log.filter((entry) => entry.startsWith('job:'))).toEqual([])
      expect(k.log.slice(-2)).toEqual(['leader:removeListener:error', 'leader:release:destroy'])
      expect(leaderStateOf(k.gauge)).toBe('follower')
    }
  })

  it('a rollback that fails after a busy lock destroys the client', async () => {
    const k = kit({ clientScript: { lock: async () => { throw sqlError('55P03') }, rollback: async () => { throw sqlError('08006') } } })
    expect(await k.scheduler.runTick()).toEqual({ leader: false, reason: 'lock_busy' })
    expect(k.log.at(-1)).toBe('leader:release:destroy')
  })

  it('no database clock or no leader client: leader_unavailable, nothing else is sent', async () => {
    const noClock = kit({ readNow: async () => { throw sqlError('57P01') } })
    expect(await noClock.scheduler.runTick()).toEqual({ leader: false, reason: 'leader_unavailable' })
    expect(noClock.connects()).toBe(0)
    expect(leaderStateOf(noClock.gauge)).toBe('follower')
    const noClient = kit({ connectLeaderClient: async () => { throw sqlError('53300') } })
    expect(await noClient.scheduler.runTick()).toEqual({ leader: false, reason: 'leader_unavailable' })
    expect(noClient.log).toEqual(['readNow'])
  })
})

// ── The leader connection fails ──────────────────────────────────────────────────────────────────

describe('the leader connection fails during the scans (design §6.1, ASSUMPTION(task-m4): [own-3b-23])', () => {
  it('the listener marks the leader lost: the next scan does not run, nothing is committed, the client is destroyed, no delivery, relinquished', async () => {
    const log: string[] = []
    const client = new FakeLeaderClient(log)
    let sawLost: boolean | undefined
    const k = kit({
      log,
      client,
      scanJobs: [
        job(log, 'scan-a', async (ctx) => {
          // The EventEmitter path: an error with no listener would throw here.
          client.emitError(sqlError('57P01'))
          sawLost = ctx.leaderLost()
          return { stoppedEarly: true }
        }),
        job(log, 'scan-b'),
      ],
    })
    const result = await k.scheduler.runTick()
    expect(result).toEqual({ leader: true, reason: 'leader_client_lost', jobs: { 'scan-a': { stoppedEarly: true } } })
    expect(sawLost).toBe(true)
    expect(log).not.toContain('leader:COMMIT')
    expect(log).not.toContain('job:scan-b')
    expect(log).not.toContain('job:delivery')
    expect(log).not.toContain('backlog')
    expect(log.slice(-2)).toEqual(['leader:removeListener:error', 'leader:release:destroy'])
    expect(leaderStateOf(k.gauge)).toBe('relinquished')
    // The next tick takes a fresh client and leads again.
    const next = kit({ log: [], client: new FakeLeaderClient([]) })
    expect((await next.scheduler.runTick()).leader).toBe(true)
  })

  it('a commit that fails: leader_client_lost, the client is destroyed, no delivery', async () => {
    const k = kit({ clientScript: { commit: async () => { throw sqlError('08006') } } })
    const result = await k.scheduler.runTick()
    expect(result).toMatchObject({ leader: true, reason: 'leader_client_lost' })
    expect(k.log).not.toContain('job:delivery')
    expect(k.log.at(-1)).toBe('leader:release:destroy')
    expect(leaderStateOf(k.gauge)).toBe('relinquished')
  })

  it('an error during the lock wait after the connection failed is not read as a busy lock', async () => {
    const log: string[] = []
    const client: FakeLeaderClient = new FakeLeaderClient(log, {
      lock: async () => {
        client.emitError(sqlError('57P01'))
        throw sqlError('57014')
      },
    })
    const k = kit({ log, client })
    expect(await k.scheduler.runTick()).toEqual({ leader: false, reason: 'leader_client_lost' })
    expect(log.at(-1)).toBe('leader:release:destroy')
    expect(leaderStateOf(k.gauge)).toBe('relinquished')
  })
})

// ── The leader heartbeat ─────────────────────────────────────────────────────────────────────────

describe('the leader heartbeat (design §6.1; ASSUMPTION(task-m4): [own-3b-35])', () => {
  it('a scan that heartbeats sends SELECT 1 on the leader client inside the transaction; after the release the heartbeat sends nothing', async () => {
    const log: string[] = []
    const k = kit({
      log,
      scanJobs: [job(log, 'scan-a', async (ctx) => {
        await ctx.leaderHeartbeat?.()
        await ctx.leaderHeartbeat?.()
        return { beats: 2 }
      })],
      deliveryJob: job(log, 'delivery', async (ctx) => {
        await ctx.leaderHeartbeat?.()
        return { late: true }
      }),
    })
    expect(await k.scheduler.runTick()).toEqual({ leader: true, jobs: { 'scan-a': { beats: 2 }, delivery: { late: true } } })
    expect(log).toEqual([
      'readNow', 'connect', 'leader:on:error', ...LEADER_TX,
      'job:scan-a', 'leader:SELECT 1', 'leader:SELECT 1',
      'leader:COMMIT', 'leader:removeListener:error', 'leader:release:return',
      'job:delivery', 'backlog',
    ])
  })

  it('a heartbeat that fails marks the leader lost: the scan sees it, nothing is committed, the client is destroyed, no delivery, relinquished', async () => {
    const log: string[] = []
    const client = new FakeLeaderClient(log, { heartbeat: async () => { throw sqlError('57P01') } })
    let sawLost: boolean | undefined
    const k = kit({
      log,
      client,
      scanJobs: [
        job(log, 'scan-a', async (ctx) => {
          await ctx.leaderHeartbeat?.()
          sawLost = ctx.leaderLost()
          return { sawLost }
        }),
        job(log, 'scan-b'),
      ],
    })
    expect(await k.scheduler.runTick()).toEqual({ leader: true, reason: 'leader_client_lost', jobs: { 'scan-a': { sawLost: true } } })
    expect(sawLost).toBe(true)
    expect(log).not.toContain('leader:COMMIT')
    expect(log).not.toContain('job:scan-b')
    expect(log).not.toContain('job:delivery')
    expect(log).not.toContain('backlog')
    expect(log.slice(-2)).toEqual(['leader:removeListener:error', 'leader:release:destroy'])
    expect(leaderStateOf(k.gauge)).toBe('relinquished')
    expect(k.warns).toContain('task scheduler leader heartbeat failed')
  })

  it('once the leader is lost, or once stopping, the heartbeat sends nothing', async () => {
    const lostLog: string[] = []
    const lostClient = new FakeLeaderClient(lostLog)
    const lost = kit({
      log: lostLog,
      client: lostClient,
      scanJobs: [job(lostLog, 'scan-a', async (ctx) => {
        lostClient.emitError(sqlError('57P01'))
        await ctx.leaderHeartbeat?.()
        return { lost: ctx.leaderLost() }
      })],
    })
    expect(await lost.scheduler.runTick()).toMatchObject({ reason: 'leader_client_lost', jobs: { 'scan-a': { lost: true } } })
    expect(lostLog).not.toContain('leader:SELECT 1')

    const stopLog: string[] = []
    const stopping = kit({
      log: stopLog,
      stopGraceMs: 0,
      scanJobs: [job(stopLog, 'scan-a', async (ctx) => {
        const stopped = stopping.scheduler.stop()
        await ctx.leaderHeartbeat?.()
        await stopped
        return { stopping: ctx.stopping() }
      })],
    })
    expect(await stopping.scheduler.runTick()).toMatchObject({ leader: true, jobs: { 'scan-a': { stopping: true } } })
    expect(stopLog).not.toContain('leader:SELECT 1')
    expect(stopLog).toContain('leader:COMMIT')
  })
})

// ── Running, stopping, timer ─────────────────────────────────────────────────────────────────────

describe('one tick at a time, stop and the timer (design §6.6)', () => {
  it('a tick while another is in flight returns running without a client; a tick after stop() returns stopping', async () => {
    const gate = deferred()
    const k = kit({ scanJobs: [{ name: 'slow', run: () => gate.promise }] })
    const first = k.scheduler.runTick()
    await vi.waitFor(() => expect(k.log).toContain('leader:SELECT pg_advisory_xact_lock(hashtext($1))'))
    expect(await k.scheduler.runTick()).toEqual({ leader: false, reason: 'running' })
    expect(k.connects()).toBe(1)
    gate.resolve()
    expect((await first).leader).toBe(true)
    await k.scheduler.stop()
    expect(await k.scheduler.runTick()).toEqual({ leader: false, reason: 'stopping' })
    expect(k.connects()).toBe(1)
    expect(leaderStateOf(k.gauge)).toBe('relinquished')
  })

  it('stop() during the scans: the scans see stopping, later scans and the delivery job do not run, stop() waits for the tick', async () => {
    const gate = deferred()
    const log: string[] = []
    let seen: boolean | undefined
    const k = kit({
      log,
      scanJobs: [
        job(log, 'scan-a', async (ctx) => {
          await gate.promise
          seen = ctx.stopping()
        }),
        job(log, 'scan-b'),
      ],
    })
    const tick = k.scheduler.runTick()
    await vi.waitFor(() => expect(log).toContain('job:scan-a'))
    let stopped = false
    const stopping = k.scheduler.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    gate.resolve()
    await stopping
    expect(seen).toBe(true)
    expect((await tick).leader).toBe(true)
    expect(log).not.toContain('job:scan-b')
    expect(log).not.toContain('job:delivery')
    expect(log).not.toContain('backlog')
    expect(log).toContain('leader:COMMIT')
  })

  it('stop() aborts the stop signal every job receives; before stop() it is live', async () => {
    const seen: boolean[] = []
    let signal: AbortSignal | undefined
    const k = kit({
      scanJobs: [{ name: 'signal', run: async (ctx) => { signal = ctx.stopSignal; seen.push(ctx.stopSignal?.aborted ?? true) } }],
    })
    await k.scheduler.runTick()
    expect(seen).toEqual([false])
    expect(signal).toBeInstanceOf(AbortSignal)
    await k.scheduler.stop()
    expect(signal?.aborted).toBe(true)
  })

  it('stop() aborts the stop signal before it waits for the tick in flight: the job sees the abort while stop() is still pending, inside the grace', async () => {
    const gate = deferred()
    const log: string[] = []
    let aborted = false
    let stopped = false
    const k = kit({
      log,
      stopGraceMs: 200,
      deliveryJob: job(log, 'delivery', async (ctx) => {
        await new Promise<void>((resolve) => ctx.stopSignal?.addEventListener('abort', () => resolve(), { once: true }))
        aborted = true
        await gate.promise
        return { aborted }
      }),
    })
    const tick = k.scheduler.runTick()
    await vi.waitFor(() => expect(log).toContain('job:delivery'))
    const started = Date.now()
    const stopping = k.scheduler.stop().then(() => { stopped = true })
    await vi.waitFor(() => expect(aborted).toBe(true))
    // The abort came first: stop() is still waiting for the tick, inside its grace.
    expect(stopped).toBe(false)
    expect(Date.now() - started).toBeLessThan(200)
    gate.resolve()
    await stopping
    expect((await tick).leader).toBe(true)
  })

  it('stop() returns after the grace when the tick does not finish; the default grace is 8 s', async () => {
    expect(TASK_SCHEDULER_STOP_GRACE_MS).toBe(8000)
    const gate = deferred()
    const k = kit({ stopGraceMs: 30, scanJobs: [{ name: 'stuck', run: () => gate.promise }] })
    const tick = k.scheduler.runTick()
    await vi.waitFor(() => expect(k.log).toContain('leader:SELECT pg_advisory_xact_lock(hashtext($1))'))
    const started = Date.now()
    await k.scheduler.stop()
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
    expect(k.warns).toContain('task scheduler stopped with a tick still in flight')
    gate.resolve()
    expect((await tick).leader).toBe(true)
    for (const stopGraceMs of [-1, 1.5, Number.NaN]) {
      expect(() => kit({ stopGraceMs })).toThrow(TypeError)
    }
  })

  it('start() ticks every interval, never at once, on an unref\'d timer; stop() clears it', async () => {
    vi.useFakeTimers()
    const k = kit({ intervalMs: 5000 })
    k.scheduler.start()
    k.scheduler.start()
    await vi.advanceTimersByTimeAsync(4999)
    expect(k.connects()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(k.connects()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(k.connects()).toBe(2)
    const timer = (k.scheduler as unknown as { timer: NodeJS.Timeout | null }).timer
    expect(timer?.hasRef()).toBe(false)
    await k.scheduler.stop()
    expect((k.scheduler as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull()
    await vi.advanceTimersByTimeAsync(20000)
    expect(k.connects()).toBe(2)
    k.scheduler.start()
    expect((k.scheduler as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull()
    await vi.advanceTimersByTimeAsync(20000)
    expect(k.connects()).toBe(2)
  })

  it('the interval is validated, not clamped: an integer in [5 000 ms, W/2]; anything else is refused (W ≥ 2 × interval, design §6.2; ASSUMPTION(task-m4): [own-3b-39])', () => {
    expect(kit({}).scheduler.intervalMs).toBe(60_000)
    expect(kit({ intervalMs: 5_000 }).scheduler.intervalMs).toBe(5_000)
    expect(TASK_SCHEDULER_INTERVAL_MAX_MS).toBe(TASK_REMINDER_SCAN_WINDOW_MS / 2)
    expect(kit({ intervalMs: TASK_SCHEDULER_INTERVAL_MAX_MS }).scheduler.intervalMs).toBe(3_600_000)
    for (const intervalMs of [10, 4_999, TASK_SCHEDULER_INTERVAL_MAX_MS + 1, TASK_REMINDER_SCAN_WINDOW_MS, 5_000.5, Number.NaN]) {
      expect(() => kit({ intervalMs }), String(intervalMs)).toThrow(TypeError)
    }
    expect(kit({}).warns).toEqual([])
  })

  it('createDbAnchoredClock moves with the monotonic clock from the database instant and refuses a bad instant', () => {
    let mono = 10.75
    const clock = createDbAnchoredClock(DB_NOW, () => mono)
    expect(clock().getTime()).toBe(DB_NOW.getTime())
    mono += 1999.6
    expect(clock().getTime()).toBe(DB_NOW.getTime() + 1999)
    expect(() => createDbAnchoredClock(new Date(Number.NaN))).toThrow(TypeError)
    expect(() => createDbAnchoredClock('x' as never)).toThrow(TypeError)
  })
})

// ── Gauges ───────────────────────────────────────────────────────────────────────────────────────

describe('gauges (design §4.1, §6.6; ASSUMPTION(task-m4): [own-3b-31])', () => {
  it('the backlog gauge: rows waiting, whole seconds the earliest due one has waited, outcome_unknown rows', async () => {
    const k = kit()
    await k.scheduler.runTick()
    expect(Object.fromEntries(k.backlog)).toEqual({ pending: 3, oldest_due_wait_seconds: 90, outcome_unknown: 2 })
    const sql: string[] = []
    const none = kit({
      query: async (text, params) => {
        sql.push(text.replace(/\s+/g, ' ').trim())
        expect(params).toEqual([DB_NOW])
        return { rows: [{ pending: '0', oldest_due: null, outcome_unknown: '0' }] }
      },
    })
    await none.scheduler.runTick()
    expect(Object.fromEntries(none.backlog)).toEqual({ pending: 0, oldest_due_wait_seconds: 0, outcome_unknown: 0 })
    expect(sql).toEqual([
      "SELECT (SELECT count(*) FROM task_notification_deliveries WHERE status IN ('pending','retrying'))::bigint AS pending, "
      + "(SELECT min(next_attempt_at) FROM task_notification_deliveries WHERE status IN ('pending','retrying') AND next_attempt_at <= $1) AS oldest_due, "
      + "(SELECT count(*) FROM task_notification_deliveries WHERE status = 'outcome_unknown')::bigint AS outcome_unknown",
    ])
  })

  it('a backlog read that fails is logged and the tick still ends as the leader', async () => {
    const k = kit({ query: async () => { throw sqlError('57014') } })
    expect((await k.scheduler.runTick()).leader).toBe(true)
    expect(k.warns).toContain('task scheduler backlog refresh failed')
    expect(k.backlog.size).toBe(0)
  })

  it('both gauges are registered with a zero sample for every label before the first tick', async () => {
    const text = await registry.metrics()
    for (const state of ['leader', 'follower', 'relinquished']) {
      expect(text).toContain(`tasks_scheduler_leader{state="${state}"} 0`)
    }
    expect([...TASK_NOTIFICATION_BACKLOG_KINDS]).toEqual(['pending', 'oldest_due_wait_seconds', 'outcome_unknown'])
    for (const kind of TASK_NOTIFICATION_BACKLOG_KINDS) {
      expect(text).toContain(`tasks_notification_backlog{kind="${kind}"} 0`)
    }
  })
})

// ── Start-up switches ────────────────────────────────────────────────────────────────────────────

describe('start-up (design §6.6; ASSUMPTION(task-m4): [own-3b-06])', () => {
  const pool = { connect: async () => new FakeLeaderClient([]) }
  const quiet = { info: () => undefined, warn: () => undefined }

  it('starts only when TASKS_ENABLED and TASKS_SCHEDULER_ENABLED are both exactly true', async () => {
    const off: NodeJS.ProcessEnv[] = [
      {},
      { TASKS_ENABLED: 'true' },
      { TASKS_SCHEDULER_ENABLED: 'true' },
      { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'TRUE' },
      { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: ' true' },
      { TASKS_ENABLED: '1', TASKS_SCHEDULER_ENABLED: 'true' },
    ]
    for (const env of off) {
      expect(startTaskScheduler({ env, pool, logger: quiet }), JSON.stringify(env)).toBeNull()
    }
    const scheduler = startTaskScheduler({ env: { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'true' }, pool, logger: quiet })
    expect(scheduler).toBeInstanceOf(TaskScheduler)
    expect(startTaskScheduler({ env: { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'true' }, pool, logger: quiet })).toBe(scheduler)
    await stopTaskScheduler()
    expect(await scheduler?.runTick()).toEqual({ leader: false, reason: 'stopping' })
  })

  it('both switches on but no database pool: null with a warning (the default pool here is null)', () => {
    const warns: string[] = []
    const logger = { info: () => undefined, warn: (message: string) => { warns.push(message) } }
    expect(startTaskScheduler({ env: { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'true' }, pool: null, logger })).toBeNull()
    expect(startTaskScheduler({ env: { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'true' }, logger })).toBeNull()
    expect(warns).toEqual([
      'task scheduler not started: both switches are on but there is no database pool',
      'task scheduler not started: both switches are on but there is no database pool',
    ])
  })

  it('reads the interval knob through the flags parser', async () => {
    const scheduler = startTaskScheduler({
      env: { TASKS_ENABLED: 'true', TASKS_SCHEDULER_ENABLED: 'true', TASKS_SCHEDULER_INTERVAL_MS: '30000' },
      pool,
      logger: quiet,
    })
    expect(scheduler?.intervalMs).toBe(30_000)
  })

  it('the delivery job exists only when TASKS_ENABLED and the worker switch are both exactly true', () => {
    for (const env of [{}, { TASKS_ENABLED: 'true' }, { TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' }, { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'TRUE' }]) {
      expect(resolveTaskNotificationDeliveryJob({ env }), JSON.stringify(env)).toBeNull()
    }
    expect(resolveTaskNotificationDeliveryJob({ env: { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' } })?.name)
      .toBe('task-notification-delivery')
    expect(resolveTaskReminderJob().name).toBe('task-reminder-scan')
    expect(resolveTaskDailyDigestJob().name).toBe('task-daily-digest-scan')
  })

  it('the delivery job runs the worker for the tick budget on the tick clock, stops when the tick stops', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const query: TaskDeliveryQuery = async (sql, params = []) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      return { rows: [] }
    }
    const deliveryJob = resolveTaskNotificationDeliveryJob({
      env: { TASKS_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true' },
      channels: [],
      query,
    })
    expect(deliveryJob).not.toBeNull()
    const tickAt = new Date('2026-10-08T05:00:00.000Z')
    const result = await deliveryJob?.run({ now: () => tickAt, stopping: () => false, leaderLost: () => false })
    expect(result).toMatchObject({ batches: 1, totals: { claimed: 0 } })
    const claim = statements.find((statement) => statement.sql.startsWith('WITH claim AS'))
    expect(claim?.params[0]).toEqual(tickAt)
    expect(claim?.params[4]).toEqual([])
    statements.length = 0
    expect(await deliveryJob?.run({ now: () => tickAt, stopping: () => true, leaderLost: () => false })).toMatchObject({ batches: 0 })
    expect(statements).toEqual([])
    // The tick's stop signal reaches the worker: already aborted ⇒ no batch, no statement.
    const aborted = new AbortController()
    aborted.abort()
    expect(await deliveryJob?.run({ now: () => tickAt, stopping: () => false, leaderLost: () => false, stopSignal: aborted.signal })).toMatchObject({ batches: 0 })
    expect(statements).toEqual([])
    expect(TASK_DELIVERY_TICK_BUDGET_MS).toBe(40_000)
  })
})

// ── The server's start and stop (design §6.6) ───────────────────────────────────────────────────

/** The body of one member of the server class in src/index.ts: from its signature to the next member. */
function serverMember(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  const rest = source.slice(start + signature.length)
  const next = rest.search(/\n {2}(?:private |public |protected |async |static |get |set |[A-Za-z_]+\()/)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('server wiring (design §6.6)', () => {
  it('startOnce() starts the task scheduler once; stopOnce() awaits stopTaskScheduler() as a shutdown task inside the shutdown barrier', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { startTaskScheduler, stopTaskScheduler } from './services/task-scheduler'")
    expect(source.split('startTaskScheduler()')).toHaveLength(2)
    expect(source.split('stopTaskScheduler()')).toHaveLength(2)
    const startOnce = serverMember(source, 'private async startOnce(): Promise<void> {')
    expect(startOnce.split('startTaskScheduler()')).toHaveLength(2)
    const stopOnce = serverMember(source, 'private async stopOnce(signal: string): Promise<void> {')
    const push = stopOnce.indexOf('shutdownTasks.push((async () => {\n      try {\n        await stopTaskScheduler()')
    const barrier = stopOnce.indexOf('await this.waitForShutdownBarrier(\n      shutdownTasks,')
    expect(push).toBeGreaterThan(-1)
    expect(barrier).toBeGreaterThan(push)
  })
})

// ── The scans on scripted queries ────────────────────────────────────────────────────────────────

interface Recorded { sql: string; params: unknown[] }

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function ctxAt(now: Date, flags: { stopping?: () => boolean; leaderLost?: () => boolean; leaderHeartbeat?: () => Promise<void> } = {}): TaskSchedulerJobContext {
  return { now: () => now, stopping: flags.stopping ?? (() => false), leaderLost: flags.leaderLost ?? (() => false), leaderHeartbeat: flags.leaderHeartbeat }
}

function beatCounter(): { leaderHeartbeat: () => Promise<void>; beats: () => number } {
  let n = 0
  return { leaderHeartbeat: async () => { n += 1 }, beats: () => n }
}

/**
 * A heartbeat that writes `<beat>` into the scan's statement log, so its position among the
 * statements is visible; the `failAt`-th beat (0-based) fails the way the scheduler's does: the
 * leader is marked lost and every later beat sends nothing.
 */
function beatLog(log: Recorded[], failAt?: number): { leaderHeartbeat: () => Promise<void>; leaderLost: () => boolean; beats: () => number } {
  let n = 0
  let lost = false
  return {
    leaderHeartbeat: async () => {
      if (lost) return
      log.push({ sql: '<beat>', params: [] })
      if (failAt !== undefined && n === failAt) lost = true
      n += 1
    },
    leaderLost: () => lost,
    beats: () => n,
  }
}

/** The statement log as one word per entry. */
function shapeOf(log: Recorded[]): string[] {
  return log.map((entry) => {
    if (entry.sql === '<beat>') return 'beat'
    if (entry.sql.includes('FROM tasks LEFT JOIN LATERAL')) return 'page'
    if (entry.sql.startsWith('SELECT user_id, org_id, time_zone FROM task_user_settings')) return 'settings'
    if (entry.sql.includes('FROM directory_integrations')) return 'precondition'
    if (entry.sql.includes('FROM user_orgs uo')) return 'membership'
    if (entry.sql.startsWith('SELECT task_id, user_id, completed_at FROM task_assignees')) return 'assignees'
    if (entry.sql.startsWith('INSERT INTO task_notification_deliveries')) return 'insert'
    return 'other'
  })
}

function repeated(words: string[], times: number): string[] {
  return Array.from({ length: times }, () => words).flat()
}

function failingQuery(): TaskDeliveryQuery {
  return async () => {
    throw new Error('no statement may be sent while the pipeline is off')
  }
}

describe('the scans send nothing while the pipeline is off (ASSUMPTION(task-m4): [own-3b-01])', () => {
  it('as scheduler jobs they say so once, then stay quiet', async () => {
    const infos: string[] = []
    const logger = { info: (message: string) => { infos.push(message) }, warn: () => undefined }
    for (const resolve of [resolveTaskReminderJob, resolveTaskDailyDigestJob]) {
      infos.length = 0
      const job = resolve({ env: {}, query: failingQuery(), logger })
      expect(await job.run(ctxAt(DB_NOW))).toMatchObject({ ran: false })
      expect(await job.run(ctxAt(DB_NOW))).toMatchObject({ ran: false })
      expect(infos).toEqual(['task scan idle: the notification pipeline is off'])
    }
  })

  it('any of the three switches not exactly true ⇒ ran false, zero statements', async () => {
    const offs: NodeJS.ProcessEnv[] = [
      {},
      { ...PIPELINE_ON, TASKS_SCHEDULER_ENABLED: 'TRUE' },
      { ...PIPELINE_ON, TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: undefined },
      { ...PIPELINE_ON, TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'false' },
    ]
    for (const env of offs) {
      expect(await runTaskReminderScan(ctxAt(DB_NOW), { env, query: failingQuery() })).toEqual({ ran: false, pages: 0, candidates: 0, due: 0, written: 0 })
      expect(await runTaskDailyDigestScan(ctxAt(DB_NOW), { env, query: failingQuery() }))
        .toEqual({ ran: false, settings: 0, due: 0, written: 0, invalidZone: 0, inactiveMember: 0 })
    }
  })
})

function reminderRow(id: string, opts: { org?: string; remindAt?: Date; floor?: Date | null; creator?: string } = {}): Row {
  const remindAt = opts.remindAt ?? new Date(DB_NOW.getTime() - 10 * 60_000)
  return {
    id,
    org_id: opts.org ?? 'org-1',
    created_by: opts.creator ?? `usr_creator_${id}`,
    remind_at: remindAt,
    remind_at_cursor: remindAt.toISOString().replace('T', ' ').replace('Z', '+00'),
    floor: opts.floor === undefined ? new Date(remindAt.getTime() - 60 * 60_000) : opts.floor,
  }
}

function scriptedScanQuery(script: {
  pages?: Row[][]
  activeOrgs?: string[]
  assignees?: Row[]
  settings?: Row[]
  /** Users the membership read leaves out (inactive in their org). */
  inactiveUsers?: string[]
}): { query: TaskDeliveryQuery; log: Recorded[]; inserts: Array<Record<string, unknown>[]> } {
  const log: Recorded[] = []
  const inserts: Array<Record<string, unknown>[]> = []
  let page = 0
  const query: TaskDeliveryQuery = async (sql, params = []) => {
    const text = oneLine(sql)
    log.push({ sql: text, params })
    if (text.includes('FROM tasks LEFT JOIN LATERAL')) return { rows: script.pages?.[page++] ?? [] }
    if (text.includes('FROM directory_integrations')) return { rows: [{ dingtalk_active: (script.activeOrgs ?? ['org-1']).includes(String(params[0])) }] }
    if (text.startsWith('SELECT task_id, user_id, completed_at FROM task_assignees')) return { rows: script.assignees ?? [] }
    if (text.startsWith('SELECT user_id, org_id, time_zone FROM task_user_settings')) return { rows: script.settings ?? [] }
    if (text.includes('FROM user_orgs uo')) {
      return { rows: (params[1] as string[]).filter((id) => !(script.inactiveUsers ?? []).includes(id)).map((user_id) => ({ user_id })) }
    }
    if (text.startsWith('INSERT INTO task_notification_deliveries')) {
      const columns = ['org_id', 'source_type', 'source_id', 'source_key', 'recipient_user_id', 'recipient_role', 'channel', 'payload']
      const arrays = params as string[][]
      const rows = arrays[0].map((_, i) => Object.fromEntries(columns.map((column, c) => [column, arrays[c][i]])))
      inserts.push(rows)
      return { rows: rows.map((_, i) => ({ id: `new-${inserts.length}-${i}` })) }
    }
    throw new Error(`unexpected statement: ${text.slice(0, 80)}`)
  }
  return { query, log, inserts }
}

describe('the reminder scan (design §6.2; RULED(2026-10-07): [R06]; ASSUMPTION(task-m4): [own-3b-15])', () => {
  it('the page statement: the keyset condition, its ORDER BY, LIMIT and the floor event types as binds', async () => {
    const s = scriptedScanQuery({ pages: [[]] })
    expect(await runTaskReminderScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: s.query })).toEqual({ ran: true, pages: 1, candidates: 0, due: 0, written: 0 })
    expect(s.log).toHaveLength(1)
    const [page] = s.log
    expect(page.sql).toBe(
      'SELECT tasks.id, tasks.org_id, tasks.created_by, tasks.remind_at, tasks.remind_at::text AS remind_at_cursor, reminder_floor.floor '
      + 'FROM tasks LEFT JOIN LATERAL ( SELECT max(e.occurred_at) AS floor FROM task_events e '
      + 'WHERE e.task_id = tasks.id AND e.event_type = ANY($6::text[]) ) reminder_floor ON true '
      + "WHERE tasks.remind_at IS NOT NULL AND tasks.remind_at <= $1::timestamptz AND tasks.remind_at > ($1::timestamptz - ($2::int * interval '1 millisecond')) "
      + "AND tasks.status = 'open' AND tasks.deleted_at IS NULL AND (tasks.remind_at, tasks.id) > ($3::timestamptz, $4::text) "
      + `ORDER BY ${TASK_REMINDER_SCAN_ORDER_BY} LIMIT $5`,
    )
    expect(page.params).toEqual([DB_NOW, TASK_REMINDER_SCAN_WINDOW_MS, '-infinity', '', TASK_REMINDER_SCAN_BATCH, [...TASK_REMINDER_FLOOR_EVENT_TYPES]])
  })

  it('pages advance the cursor to the last row\'s database text and id; a short page ends the scan', async () => {
    const first = [reminderRow('tsk_a'), reminderRow('tsk_b')]
    const second = [reminderRow('tsk_c')]
    const s = scriptedScanQuery({ pages: [first, second] })
    const result = await runTaskReminderScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: s.query, pageSize: 2 })
    expect(result).toEqual({ ran: true, pages: 2, candidates: 3, due: 3, written: 3 })
    const pages = s.log.filter((entry) => entry.sql.includes('FROM tasks LEFT JOIN LATERAL'))
    expect(pages.map((entry) => entry.params.slice(2, 5))).toEqual([
      ['-infinity', '', 2],
      [first[1].remind_at_cursor, 'tsk_b', 2],
    ])
  })

  it('the scan heartbeats the leader connection before each page (design §6.1)', async () => {
    const s = scriptedScanQuery({ pages: [[reminderRow('tsk_a'), reminderRow('tsk_b')], [reminderRow('tsk_c'), reminderRow('tsk_d')], [reminderRow('tsk_e')]] })
    const beat = beatCounter()
    const result = await runTaskReminderScan(ctxAt(DB_NOW, { leaderHeartbeat: beat.leaderHeartbeat }), { env: PIPELINE_ON, query: s.query, pageSize: 2 })
    expect(result).toMatchObject({ pages: 3, written: 5 })
    expect(beat.beats()).toBe(3)
    // Without a heartbeat in the context the scan runs the same.
    const plain = scriptedScanQuery({ pages: [[reminderRow('tsk_a')]] })
    expect(await runTaskReminderScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: plain.query })).toMatchObject({ pages: 1, written: 1 })
  })

  it('a full page that ends on the same row as the page before it ends the scan (no page is read a third time)', async () => {
    const stuck = [reminderRow('tsk_a'), reminderRow('tsk_b')]
    const s = scriptedScanQuery({ pages: [stuck, stuck, stuck] })
    let pagesRead = 0
    const counting: TaskDeliveryQuery = async (sql, params) => {
      if (sql.includes('LEFT JOIN LATERAL')) pagesRead += 1
      return s.query(sql, params)
    }
    const result = await runTaskReminderScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: counting, pageSize: 2 })
    expect(pagesRead).toBe(2)
    expect(result.pages).toBe(2)
  })

  it('stopping or a lost leader ends the scan before the next page', async () => {
    for (const flag of ['stopping', 'leaderLost'] as const) {
      const s = scriptedScanQuery({ pages: [[reminderRow('tsk_a'), reminderRow('tsk_b')], [reminderRow('tsk_c')]] })
      let calls = 0
      const after = (): boolean => {
        calls += 1
        return calls > 1
      }
      const ctx = ctxAt(DB_NOW, { [flag]: after })
      const result = await runTaskReminderScan(ctx, { env: PIPELINE_ON, query: s.query, pageSize: 2 })
      expect(result.pages, flag).toBe(1)
      expect(s.inserts, flag).toHaveLength(1)
    }
  })

  it('each candidate is judged again with its floor: no floor, a floor after the moment, or a moment outside the window ⇒ no row', async () => {
    const at = new Date(DB_NOW.getTime() - 10 * 60_000)
    const page = [
      reminderRow('tsk_ok', { remindAt: at }),
      reminderRow('tsk_nofloor', { remindAt: at, floor: null }),
      reminderRow('tsk_late', { remindAt: at, floor: new Date(at.getTime() + 1) }),
      reminderRow('tsk_old', { remindAt: new Date(DB_NOW.getTime() - TASK_REMINDER_SCAN_WINDOW_MS) }),
      reminderRow('tsk_future', { remindAt: new Date(DB_NOW.getTime() + 1) }),
    ]
    const s = scriptedScanQuery({ pages: [page] })
    const result = await runTaskReminderScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: s.query })
    expect(result).toEqual({ ran: true, pages: 1, candidates: 5, due: 1, written: 1 })
    expect(s.inserts).toHaveLength(1)
    expect(s.inserts[0].map((row) => row.source_id)).toEqual(['tsk_ok'])
  })

  it('recipients: the incomplete assignees, the creator when there is no assignee row; an org without an active integration writes nothing', async () => {
    const page = [
      reminderRow('tsk_two', { creator: 'usr_c1' }),
      reminderRow('tsk_none', { creator: 'usr_c2' }),
      reminderRow('tsk_other_org', { org: 'org-2', creator: 'usr_c3' }),
    ]
    const s = scriptedScanQuery({
      pages: [page],
      activeOrgs: ['org-1'],
      assignees: [
        { task_id: 'tsk_two', user_id: 'usr_open', completed_at: null },
        { task_id: 'tsk_two', user_id: 'usr_done', completed_at: new Date(DB_NOW.getTime() - 1000) },
      ],
    })
    const result = await runTaskReminderScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: s.query })
    expect(result).toEqual({ ran: true, pages: 1, candidates: 3, due: 3, written: 2 })
    const rows = s.inserts[0]
    expect(rows.map((row) => [row.source_id, row.recipient_user_id, row.recipient_role, row.channel])).toEqual([
      ['tsk_two', 'usr_open', 'assignee', TASK_NOTIFICATION_CHANNEL_DINGTALK],
      ['tsk_none', 'usr_c2', 'creator', TASK_NOTIFICATION_CHANNEL_DINGTALK],
    ])
    const assigneeRead = s.log.find((entry) => entry.sql.startsWith('SELECT task_id, user_id, completed_at FROM task_assignees'))
    expect(assigneeRead?.params).toEqual([['tsk_two', 'tsk_none']])
    // One precondition read per org per tick.
    expect(s.log.filter((entry) => entry.sql.includes('FROM directory_integrations')).map((entry) => entry.params)).toEqual([['org-1'], ['org-2']])
  })

  it('refuses a page size outside [1, TASK_REMINDER_SCAN_BATCH]', async () => {
    for (const pageSize of [0, TASK_REMINDER_SCAN_BATCH + 1, 1.5]) {
      await expect(runTaskReminderScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: scriptedScanQuery({}).query, pageSize })).rejects.toThrow(TypeError)
    }
  })

  it('a heartbeat that fails before a page: the page is not read and nothing more is written (heartbeat first, then the check)', async () => {
    const s = scriptedScanQuery({ pages: [[reminderRow('tsk_a'), reminderRow('tsk_b')], [reminderRow('tsk_c'), reminderRow('tsk_d')], [reminderRow('tsk_e')]] })
    const beat = beatLog(s.log, 1)
    const result = await runTaskReminderScan(ctxAt(DB_NOW, { leaderHeartbeat: beat.leaderHeartbeat, leaderLost: beat.leaderLost }), { env: PIPELINE_ON, query: s.query, pageSize: 2 })
    expect(result).toMatchObject({ pages: 1, written: 2 })
    expect(shapeOf(s.log)).toEqual(['beat', 'page', 'precondition', 'assignees', 'insert', 'beat'])
    expect(s.inserts).toHaveLength(1)
  })

  it('inside a page the scan heartbeats before each further group of heartbeatOrgs distinct orgs\' precondition reads; one org needs no further beat; a failing in-page beat ends the scan before the group\'s reads', async () => {
    const orgs = ['org-1', 'org-2', 'org-3', 'org-4', 'org-5']
    const page = orgs.map((org, i) => reminderRow(`tsk_${i}`, { org }))
    const many = scriptedScanQuery({ pages: [page], activeOrgs: orgs })
    const beat = beatLog(many.log)
    const result = await runTaskReminderScan(ctxAt(DB_NOW, { leaderHeartbeat: beat.leaderHeartbeat, leaderLost: beat.leaderLost }), { env: PIPELINE_ON, query: many.query, heartbeatOrgs: 2 })
    expect(result).toMatchObject({ pages: 1, due: 5, written: 5 })
    expect(shapeOf(many.log)).toEqual([
      'beat', 'page',
      'precondition', 'precondition',
      'beat', 'precondition', 'precondition',
      'beat', 'precondition',
      'assignees', 'insert',
    ])
    expect(beat.beats()).toBe(3)

    const one = scriptedScanQuery({ pages: [orgs.map((_, i) => reminderRow(`tsk_${i}`))] })
    const single = beatLog(one.log)
    expect(await runTaskReminderScan(ctxAt(DB_NOW, { leaderHeartbeat: single.leaderHeartbeat, leaderLost: single.leaderLost }), { env: PIPELINE_ON, query: one.query, heartbeatOrgs: 2 })).toMatchObject({ written: 5 })
    expect(shapeOf(one.log)).toEqual(['beat', 'page', 'precondition', 'assignees', 'insert'])

    const failing = scriptedScanQuery({ pages: [page], activeOrgs: orgs })
    const fails = beatLog(failing.log, 1)
    const stopped = await runTaskReminderScan(ctxAt(DB_NOW, { leaderHeartbeat: fails.leaderHeartbeat, leaderLost: fails.leaderLost }), { env: PIPELINE_ON, query: failing.query, heartbeatOrgs: 2 })
    expect(stopped).toMatchObject({ pages: 1, written: 0 })
    expect(shapeOf(failing.log)).toEqual(['beat', 'page', 'precondition', 'precondition', 'beat'])
    expect(failing.inserts).toEqual([])

    expect(TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS).toBe(50)
    for (const heartbeatOrgs of [0, TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS + 1, 1.5]) {
      await expect(runTaskReminderScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: scriptedScanQuery({}).query, heartbeatOrgs })).rejects.toThrow(TypeError)
      await expect(runTaskDailyDigestScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: scriptedScanQuery({}).query, heartbeatOrgs })).rejects.toThrow(TypeError)
    }
  })
})

describe('the daily digest scan (design §6.3; RULED(2026-10-07): [R07]; ASSUMPTION(task-m4): [own-3b-02])', () => {
  it('reads the switched-on settings, judges each row in its own zone, writes one row per due recipient of an org that passes the precondition', async () => {
    // 01:30 UTC = 09:30 in Shanghai (due), 15:30 in Kiritimati (not due).
    const s = scriptedScanQuery({
      activeOrgs: ['org-1'],
      settings: [
        { user_id: 'usr_sh', org_id: 'org-1', time_zone: 'Asia/Shanghai' },
        { user_id: 'usr_ki', org_id: 'org-1', time_zone: 'Pacific/Kiritimati' },
        { user_id: 'usr_bad', org_id: 'org-1', time_zone: 'Not/AZone' },
        { user_id: 'usr_off', org_id: 'org-2', time_zone: 'Asia/Shanghai' },
      ],
    })
    const result = await runTaskDailyDigestScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: s.query })
    expect(result).toEqual({ ran: true, settings: 4, due: 2, written: 1, invalidZone: 1, inactiveMember: 0 })
    expect(s.log[0]).toEqual({
      sql: 'SELECT user_id, org_id, time_zone FROM task_user_settings WHERE daily_reminder_enabled = true AND time_zone IS NOT NULL ORDER BY org_id, user_id',
      params: [],
    })
    // The membership read: once per org that passes the precondition, for that org's due users.
    expect(s.log.filter((entry) => entry.sql.includes('FROM user_orgs uo')).map((entry) => entry.params)).toEqual([['org-1', ['usr_sh']]])
    expect(s.inserts).toEqual([[{
      org_id: 'org-1',
      source_type: 'task_daily',
      source_id: 'usr_sh',
      source_key: `task_daily:2026-10-08:recipient:usr_sh:channel:${TASK_NOTIFICATION_CHANNEL_DINGTALK}`,
      recipient_user_id: 'usr_sh',
      recipient_role: 'assignee',
      channel: TASK_NOTIFICATION_CHANNEL_DINGTALK,
      payload: JSON.stringify({ kind: 'task_daily', date: '2026-10-08', timeZone: 'Asia/Shanghai' }),
    }]])
  })

  it('a due recipient who is no longer an active member of the org gets no row (RULED(2026-10-07): [R17]; ASSUMPTION(task-m4): [own-3b-38]); the read is one per org, for its due users', async () => {
    const s = scriptedScanQuery({
      settings: [
        { user_id: 'usr_a', org_id: 'org-1', time_zone: 'Asia/Shanghai' },
        { user_id: 'usr_gone', org_id: 'org-1', time_zone: 'Asia/Shanghai' },
        { user_id: 'usr_ki', org_id: 'org-1', time_zone: 'Pacific/Kiritimati' },
      ],
      inactiveUsers: ['usr_gone'],
    })
    expect(await runTaskDailyDigestScan(ctxAt(DB_NOW), { env: PIPELINE_ON, query: s.query })).toEqual({ ran: true, settings: 3, due: 2, written: 1, invalidZone: 0, inactiveMember: 1 })
    expect(s.log.filter((entry) => entry.sql.includes('FROM user_orgs uo')).map((entry) => entry.params)).toEqual([['org-1', ['usr_a', 'usr_gone']]])
    expect(s.inserts).toEqual([[expect.objectContaining({ recipient_user_id: 'usr_a' })]])
  })

  it('writes in INSERTs of at most one page of plans, heartbeating before the settings read and before each INSERT, and stops before the next one when stopping', async () => {
    const settings = Array.from({ length: TASK_REMINDER_SCAN_BATCH + 1 }, (_, i) => ({ user_id: `usr_${String(i).padStart(4, '0')}`, org_id: 'org-1', time_zone: 'Asia/Shanghai' }))
    const all = scriptedScanQuery({ settings })
    const beat = beatCounter()
    expect(await runTaskDailyDigestScan(ctxAt(DB_NOW, { leaderHeartbeat: beat.leaderHeartbeat }), { env: PIPELINE_ON, query: all.query })).toMatchObject({ due: 501, written: 501 })
    expect(all.inserts.map((rows) => rows.length)).toEqual([TASK_REMINDER_SCAN_BATCH, 1])
    expect(beat.beats()).toBe(3)
    for (const flag of ['stopping', 'leaderLost'] as const) {
      const part = scriptedScanQuery({ settings })
      // The flag is read before the settings read and before each INSERT: it turns true at the second INSERT.
      let calls = 0
      const ctx = ctxAt(DB_NOW, { [flag]: () => ++calls > 2 })
      expect(await runTaskDailyDigestScan(ctx, { env: PIPELINE_ON, query: part.query }), flag).toMatchObject({ written: TASK_REMINDER_SCAN_BATCH })
      expect(part.inserts, flag).toHaveLength(1)
      // Already true before the settings read: nothing is read or written.
      const none = scriptedScanQuery({ settings })
      expect(await runTaskDailyDigestScan(ctxAt(DB_NOW, { [flag]: () => true }), { env: PIPELINE_ON, query: none.query }), flag).toMatchObject({ ran: true, settings: 0, written: 0 })
      expect(none.log, flag).toEqual([])
    }
  })

  it('the first heartbeat precedes the settings read', async () => {
    const s = scriptedScanQuery({ settings: [{ user_id: 'usr_sh', org_id: 'org-1', time_zone: 'Asia/Shanghai' }] })
    const beat = beatLog(s.log)
    expect(await runTaskDailyDigestScan(ctxAt(DB_NOW, { leaderHeartbeat: beat.leaderHeartbeat, leaderLost: beat.leaderLost }), { env: PIPELINE_ON, query: s.query })).toMatchObject({ written: 1 })
    expect(shapeOf(s.log)).toEqual(['beat', 'settings', 'precondition', 'membership', 'beat', 'insert'])
  })

  const orgSettings = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ user_id: `usr_${i}`, org_id: `org-${i}`, time_zone: 'Asia/Shanghai' }))
  const orgIdsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `org-${i}`)

  it('inside the per-org phase the scan heartbeats before each further group of TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS orgs\' reads; the heartbeat before the settings read covers the first group; heartbeatOrgs narrows the group', async () => {
    const K = TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS
    const wide = scriptedScanQuery({ settings: orgSettings(2 * K + 1), activeOrgs: orgIdsOf(2 * K + 1) })
    const beat = beatLog(wide.log)
    expect(await runTaskDailyDigestScan(ctxAt(DB_NOW, { leaderHeartbeat: beat.leaderHeartbeat, leaderLost: beat.leaderLost }), { env: PIPELINE_ON, query: wide.query }))
      .toMatchObject({ settings: 2 * K + 1, due: 2 * K + 1, written: 2 * K + 1 })
    expect(shapeOf(wide.log)).toEqual([
      'beat', 'settings',
      ...repeated(['precondition', 'membership'], K),
      'beat', ...repeated(['precondition', 'membership'], K),
      'beat', 'precondition', 'membership',
      'beat', 'insert',
    ])
    expect(beat.beats()).toBe(4)

    const narrow = scriptedScanQuery({ settings: orgSettings(5), activeOrgs: orgIdsOf(5) })
    const beats = beatLog(narrow.log)
    expect(await runTaskDailyDigestScan(ctxAt(DB_NOW, { leaderHeartbeat: beats.leaderHeartbeat, leaderLost: beats.leaderLost }), { env: PIPELINE_ON, query: narrow.query, heartbeatOrgs: 2 }))
      .toMatchObject({ written: 5 })
    expect(shapeOf(narrow.log)).toEqual([
      'beat', 'settings',
      'precondition', 'membership', 'precondition', 'membership',
      'beat', 'precondition', 'membership', 'precondition', 'membership',
      'beat', 'precondition', 'membership',
      'beat', 'insert',
    ])
  })

  it('a heartbeat that fails inside the per-org phase ends the scan before the next group\'s reads: heartbeat first, then the check; nothing is written', async () => {
    const s = scriptedScanQuery({ settings: orgSettings(5), activeOrgs: orgIdsOf(5) })
    const beat = beatLog(s.log, 1)
    const result = await runTaskDailyDigestScan(ctxAt(DB_NOW, { leaderHeartbeat: beat.leaderHeartbeat, leaderLost: beat.leaderLost }), { env: PIPELINE_ON, query: s.query, heartbeatOrgs: 2 })
    expect(result).toMatchObject({ settings: 5, due: 5, written: 0 })
    expect(shapeOf(s.log)).toEqual(['beat', 'settings', 'precondition', 'membership', 'precondition', 'membership', 'beat'])
    expect(s.inserts).toEqual([])
  })
})
