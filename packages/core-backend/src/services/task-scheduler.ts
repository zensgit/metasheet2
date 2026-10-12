/**
 * Task scheduler (M4 PR-3b design `docs/development/task-m4-pr3b-backend-design-20261001.md` §3.2,
 * §6).
 *
 * A periodic loop of the task line's own. One tick:
 *   1. reads the database clock on a pool connection (every tick, followers included), then takes a
 *      dedicated pool client and attaches an `error` listener to it at once; on that client a
 *      transaction holds `SET LOCAL lock_timeout`, `SET LOCAL idle_in_transaction_session_timeout`,
 *      the leader lock taken through `acquireTasksSchedulerLeaderLock` (`db/task-advisory-locks.ts`,
 *      the only place the lock statement is written), and the heartbeats the scans send between
 *      their pages (`SELECT 1`); no data statement;
 *   2. a tick that does not get the lock within the timeout (SQLSTATE 55P03, or 57014) is a follower:
 *      it rolls back and runs nothing;
 *   3. the tick that holds the lock runs the reminder scan and the daily digest scan on other pool
 *      connections (autocommit statements) with the clock read in step 1, then commits, which
 *      releases the lock, and returns the client;
 *   4. after that commit, and only on the tick that held the lock, it runs the delivery loop with a
 *      time budget and refreshes the outbox backlog gauge.
 * The leader is a per-tick mutual exclusion, not a sticky role: a crashed leader's transaction ends
 * with its connection, and the next tick of any instance can take the lock.
 *
 * When the leader connection fails while the scans run (the backend is terminated, the network
 * drops), the listener marks the leader lost: the scans stop before their next page, the client is
 * destroyed instead of being returned, and the tick runs no delivery. Rows already written stay;
 * every outbox write is idempotent on `(org_id, source_key)`.
 *
 * The leader session is bounded on the server side (ASSUMPTION(task-m4): [own-3b-35]): the
 * transaction sets `idle_in_transaction_session_timeout` to TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS,
 * so a leader whose connection stops responding without closing (a host that is gone, a network
 * partition) loses its backend, and with it the lock, within that bound; the scans keep an alive
 * leader out of that bound by sending one heartbeat on the leader client before each page of
 * work and, inside a page, before each further group of TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS orgs'
 * reads, so the leader's idle stretch in transaction is at most a page's own statement, one
 * group's per-org reads and, for the reminder scan, the page's assignee read and its INSERT (the
 * digest scan's INSERTs each follow a heartbeat), however many orgs or users a tick has. A
 * heartbeat that fails marks the leader lost like
 * the listener does, and a scan acts on that (heartbeat first, then the stopping and lost checks)
 * before it sends the next group's reads.
 *
 * The scans write outbox rows through the producer's single INSERT and its org precondition
 * (`task-notification-producer.ts`), and only while the delivery pipeline is on
 * (ASSUMPTION(task-m4): [own-3b-01]). The rules the scans apply are pure functions of
 * `src/tasks/` (`task-reminders.ts`, `task-notifications.ts`); this module runs the statements.
 *
 * ASSUMPTION(task-m4): [own-3b-06] the scheduler starts only when TASKS_ENABLED and
 * TASKS_SCHEDULER_ENABLED are both exactly 'true' and the database pool exists. [own-3b-07] the
 * delivery loop runs outside the leader transaction, started only by the tick that held the lock.
 * [own-3b-08] the timeouts and the stop grace. [own-3b-15] the reminder scan drains its window page
 * by page with a keyset cursor. [own-3b-23] the dedicated leader client and its listener.
 * [own-3b-30]…[own-3b-33] this module's own choices, named where they apply.
 * RULED(2026-10-07): [R06] the reminder scan window and floor; [R07] the 09:00 digest in the
 * recipient's own time zone, one row per recipient and local date.
 *
 * Logs carry ids, counts and fixed codes only.
 */
import { performance } from 'node:perf_hooks'
import { Logger } from '../core/logger'
import { pool as defaultPool, query as defaultQuery } from '../db/pg'
import { acquireTasksSchedulerLeaderLock } from '../db/task-advisory-locks'
import { metrics } from '../metrics/metrics'
import { isTasksEnabled } from '../tasks/feature-flag'
import { TASK_DELIVERY_TICK_BUDGET_MS } from '../tasks/task-delivery-protocol'
import { findActiveOrgMembers } from './task-org-members'
import {
  planTaskDailyDigestDelivery,
  planTaskReminderDeliveries,
  type TaskAssigneeCompletionShape,
  type TaskNotificationChannel,
  type TaskNotificationDeliveryPlan,
} from '../tasks/task-notifications'
import {
  buildTaskReminderScanCondition,
  isTaskReminderDue,
  resolveDailyDigestOccurrence,
  TASK_REMINDER_FLOOR_EVENT_TYPES,
  TASK_REMINDER_SCAN_BATCH,
  TASK_REMINDER_SCAN_CURSOR_START,
  TASK_REMINDER_SCAN_ORDER_BY,
  TASK_REMINDER_SCAN_WINDOW_MS,
} from '../tasks/task-reminders'
import {
  createTaskDeliveryChannelsFromEnv,
  TaskNotificationDeliveryWorker,
  type TaskDeliveryChannel,
  type TaskDeliveryQuery,
} from './task-notification-delivery-worker'
import {
  isTaskNotificationDeliveryWorkerEnabled,
  isTasksSchedulerEnabled,
  resolveTaskDeliveryChannelNames,
  resolveTaskSchedulerIntervalMs,
  TASK_SCHEDULER_INTERVAL_DEFAULT_MS,
  TASK_SCHEDULER_INTERVAL_MAX_MS,
  TASK_SCHEDULER_INTERVAL_MIN_MS,
} from './task-notification-flags'
import { insertTaskNotificationDeliveries, resolveTaskDeliveryChannelsForOrg } from './task-notification-producer'
import type { Db, Row } from './task-records'

// ── Constants (ASSUMPTION(task-m4): [own-3b-08]) ─────────────────────────────────────────────────

/** How long a tick waits for the leader lock before it is a follower (design §6.1). */
export const TASK_SCHEDULER_LEADER_LOCK_TIMEOUT_MS = 1_000
/**
 * How long the leader session may be idle in its transaction before the server ends it (design
 * §6.1): above a page statement, one heartbeat group of per-org reads and a page's assignee read
 * and INSERT (the scans heartbeat between pages and between groups of per-org reads), far below
 * the OS keepalive.
 */
export const TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS = 30_000
/**
 * Orgs whose per-org reads one heartbeat covers inside a scan (design §6.1): the heartbeat before a
 * page's own statement covers the first group of that page; a further heartbeat precedes each
 * following group of this many orgs' reads (the reminder scan's precondition read per org, the
 * digest scan's precondition and membership reads per org).
 */
export const TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS = 50
/**
 * How long `stop()` waits for the tick in flight (design §6.6). Below the server's shutdown
 * barrier, which gives up after 10 s and then leaves the pool open.
 */
export const TASK_SCHEDULER_STOP_GRACE_MS = 8_000

/** SQLSTATEs that end the wait for the leader lock: lock_not_available, query_canceled. */
const LOCK_BUSY_SQLSTATES = new Set(['55P03', '57014'])

// ── Contracts ────────────────────────────────────────────────────────────────────────────────────

export interface TaskSchedulerJobContext {
  /** The tick's clock, anchored on the database clock read once at the start of the tick. */
  now: () => Date
  /** True once `stop()` was called. */
  stopping: () => boolean
  /** True once the leader connection failed during this tick. */
  leaderLost: () => boolean
  /** Aborted by `stop()`; the delivery loop hands its unstarted rows back on it (design §6.6). */
  stopSignal?: AbortSignal
  /**
   * One statement on the leader connection (design §6.1); the scans call it before each page of
   * work. A no-op once the leader is lost, the tick is stopping, or the client was released.
   */
  leaderHeartbeat?: () => Promise<void>
}

export interface TaskSchedulerJob {
  name: string
  run(ctx: TaskSchedulerJobContext): Promise<unknown>
}

/** The dedicated leader connection: production is a client from `db/pg.ts#pool.connect()`. */
export interface LeaderClient {
  query(sql: string, params?: unknown[]): Promise<unknown>
  on(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  /** `release(error)` destroys the client instead of returning it to the pool. */
  release(error?: Error | boolean): void
}

export type TaskSchedulerLeaderState = 'leader' | 'follower' | 'relinquished'

/** The subset of a prom-client gauge the scheduler sets (labels: `state`). */
export interface TaskSchedulerLeaderGauge {
  labels(labels: { state: TaskSchedulerLeaderState }): { set(value: number): void }
}

export const TASK_NOTIFICATION_BACKLOG_KINDS = ['pending', 'oldest_due_wait_seconds', 'outcome_unknown'] as const
export type TaskNotificationBacklogKind = (typeof TASK_NOTIFICATION_BACKLOG_KINDS)[number]

/** The subset of a prom-client gauge the scheduler sets (labels: `kind`). */
export interface TaskNotificationBacklogGauge {
  labels(labels: { kind: TaskNotificationBacklogKind }): { set(value: number): void }
}

// ASSUMPTION(task-m4): [own-3b-30] besides the four reasons of design §3.2, a tick that cannot
// open its leader transaction (no client, or one of its own statements fails for any reason other
// than the lock wait) ends as `leader_unavailable`: it is not the leader and runs nothing.
export type TaskSchedulerTickReason = 'lock_busy' | 'running' | 'stopping' | 'leader_client_lost' | 'leader_unavailable'

export interface TaskSchedulerTickResult {
  leader: boolean
  reason?: TaskSchedulerTickReason
  jobs?: Record<string, unknown>
}

type TaskSchedulerLogger = Pick<Logger, 'info' | 'warn'>

export interface TaskSchedulerOptions {
  /** Run while the leader lock is held: the reminder scan and the daily digest scan. */
  scanJobs: readonly TaskSchedulerJob[]
  /** Run after the leader transaction committed, only by the tick that held the lock. */
  deliveryJob?: TaskSchedulerJob | null
  connectLeaderClient: () => Promise<LeaderClient>
  /**
   * Tick interval; an integer in [TASK_SCHEDULER_INTERVAL_MIN_MS, TASK_SCHEDULER_INTERVAL_MAX_MS]
   * (design §6.2: W ≥ 2 × interval), else the constructor throws; the environment knob is clamped
   * into that range by `resolveTaskSchedulerIntervalMs` before it gets here.
   */
  intervalMs?: number
  lockTimeoutMs?: number
  /** Server-side bound on the leader session's idle time; default TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS. */
  leaderIdleTimeoutMs?: number
  /** `stop()` waits at most this long for the tick in flight; default TASK_SCHEDULER_STOP_GRACE_MS. */
  stopGraceMs?: number
  logger?: TaskSchedulerLogger
  leaderStateGauge?: TaskSchedulerLeaderGauge | null
  backlogGauge?: TaskNotificationBacklogGauge | null
  /** The database clock; default `SELECT now()` on the pool. */
  readNow?: () => Promise<Date>
  /** Statement runner for the backlog refresh; default `db/pg.ts#query`. */
  query?: TaskDeliveryQuery
  /** Monotonic milliseconds for the anchored clock; default `performance.now`. */
  monotonic?: () => number
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('task scheduler: non-error value thrown')
}

/** A value-free code for a log line: the SQLSTATE when there is one, else the error's class name. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) return name
  }
  return 'unknown'
}

function isLockBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && LOCK_BUSY_SQLSTATES.has(String((error as { code?: unknown }).code))
}

/**
 * Design §6.5: a clock that starts at `dbNow` and moves with the process's monotonic clock, so the
 * instants a tick judges by come from the database clock alone, not from each instance's own.
 */
export function createDbAnchoredClock(dbNow: Date, monotonic: () => number = () => performance.now()): () => Date {
  if (!(dbNow instanceof Date) || Number.isNaN(dbNow.getTime())) {
    throw new TypeError('createDbAnchoredClock: dbNow must be a valid Date')
  }
  const base = dbNow.getTime()
  const anchor = monotonic()
  return () => new Date(base + Math.floor(monotonic() - anchor))
}

// ASSUMPTION(task-m4): [own-3b-39] the interval is validated, not clamped, here: a value outside
// [TASK_SCHEDULER_INTERVAL_MIN_MS, TASK_SCHEDULER_INTERVAL_MAX_MS] is a caller error.
function validateInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined) return TASK_SCHEDULER_INTERVAL_DEFAULT_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs < TASK_SCHEDULER_INTERVAL_MIN_MS || intervalMs > TASK_SCHEDULER_INTERVAL_MAX_MS) {
    throw new TypeError(`TaskScheduler: intervalMs must be an integer in [${TASK_SCHEDULER_INTERVAL_MIN_MS}, ${TASK_SCHEDULER_INTERVAL_MAX_MS}]`)
  }
  return intervalMs
}

// ── Scheduler ────────────────────────────────────────────────────────────────────────────────────

export class TaskScheduler {
  readonly intervalMs: number
  readonly lockTimeoutMs: number
  readonly leaderIdleTimeoutMs: number
  private readonly scanJobs: readonly TaskSchedulerJob[]
  private readonly deliveryJob: TaskSchedulerJob | null
  private readonly connectLeaderClient: () => Promise<LeaderClient>
  private readonly stopGraceMs: number
  private readonly logger: TaskSchedulerLogger
  private readonly leaderStateGauge: TaskSchedulerLeaderGauge | null
  private readonly backlogGauge: TaskNotificationBacklogGauge | null
  private readonly readNow: () => Promise<Date>
  private readonly query: TaskDeliveryQuery
  private readonly monotonic: () => number
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<TaskSchedulerTickResult> | null = null
  private stopping = false
  /** Aborted by `stop()`; handed to every job as `stopSignal` (design §6.6). */
  private readonly stopController = new AbortController()

  constructor(options: TaskSchedulerOptions) {
    if (typeof options !== 'object' || options === null || !Array.isArray(options.scanJobs)) {
      throw new TypeError('TaskScheduler: options.scanJobs must be an array')
    }
    if (typeof options.connectLeaderClient !== 'function') {
      throw new TypeError('TaskScheduler: options.connectLeaderClient must be a function')
    }
    this.logger = options.logger ?? new Logger('TaskScheduler')
    this.scanJobs = [...options.scanJobs]
    this.deliveryJob = options.deliveryJob ?? null
    this.connectLeaderClient = options.connectLeaderClient
    this.intervalMs = validateInterval(options.intervalMs)
    const lockTimeoutMs = options.lockTimeoutMs ?? TASK_SCHEDULER_LEADER_LOCK_TIMEOUT_MS
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('TaskScheduler: lockTimeoutMs must be a positive integer')
    }
    this.lockTimeoutMs = lockTimeoutMs
    const leaderIdleTimeoutMs = options.leaderIdleTimeoutMs ?? TASK_SCHEDULER_LEADER_IDLE_TIMEOUT_MS
    if (!Number.isSafeInteger(leaderIdleTimeoutMs) || leaderIdleTimeoutMs < 1) {
      throw new TypeError('TaskScheduler: leaderIdleTimeoutMs must be a positive integer')
    }
    this.leaderIdleTimeoutMs = leaderIdleTimeoutMs
    const stopGraceMs = options.stopGraceMs ?? TASK_SCHEDULER_STOP_GRACE_MS
    if (!Number.isSafeInteger(stopGraceMs) || stopGraceMs < 0) {
      throw new TypeError('TaskScheduler: stopGraceMs must be a non-negative integer')
    }
    this.stopGraceMs = stopGraceMs
    this.leaderStateGauge = options.leaderStateGauge ?? null
    this.backlogGauge = options.backlogGauge ?? null
    this.query = options.query ?? ((sql, params) => defaultQuery(sql, params))
    this.readNow = options.readNow ?? (async () => toDate((await this.query('SELECT now() AS now')).rows[0]?.now))
    this.monotonic = options.monotonic ?? (() => performance.now())
  }

  /** Starts the interval; the first tick runs one interval after this call (design §6.6). */
  start(): void {
    if (this.timer || this.stopping) return
    this.timer = setInterval(() => {
      void this.runTick().catch((error) => {
        this.logger.warn('task scheduler tick failed', { code: errorCode(error) })
      })
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.logger.info('task scheduler started', { intervalMs: this.intervalMs })
  }

  /**
   * Clears the interval, marks the scheduler stopping and aborts the stop signal, then waits for
   * the tick in flight, at most `stopGraceMs` (design §6.6). Scans stop before their next page; the
   * delivery loop hands its unstarted rows back at once, starts no new row and passes no row
   * through the fence.
   */
  async stop(): Promise<void> {
    this.stopping = true
    this.stopController.abort()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const inFlight = this.inFlight
    if (inFlight) {
      let timeout: NodeJS.Timeout | null = null
      const graceElapsed = new Promise<'grace'>((resolve) => {
        timeout = setTimeout(() => resolve('grace'), this.stopGraceMs)
      })
      try {
        const outcome = await Promise.race([inFlight.then(() => 'done' as const, () => 'done' as const), graceElapsed])
        if (outcome === 'grace') this.logger.warn('task scheduler stopped with a tick still in flight', { graceMs: this.stopGraceMs })
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }
    this.setLeaderGauge('relinquished')
    this.logger.info('task scheduler stopped')
  }

  /** One tick (design §6.1, §6.4). At most one tick of this instance runs at a time. */
  async runTick(): Promise<TaskSchedulerTickResult> {
    if (this.stopping) return { leader: false, reason: 'stopping' }
    if (this.inFlight) return { leader: false, reason: 'running' }
    const tick = this.tick()
    this.inFlight = tick
    try {
      return await tick
    } finally {
      this.inFlight = null
    }
  }

  private async tick(): Promise<TaskSchedulerTickResult> {
    // Design §6.5: the database clock is read once at the start of the tick; every instant the tick
    // judges by comes from it.
    let now: () => Date
    try {
      now = createDbAnchoredClock(await this.readNow(), this.monotonic)
    } catch (error) {
      this.logger.warn('task scheduler could not read the database clock', { code: errorCode(error) })
      this.setLeaderGauge('follower')
      return { leader: false, reason: 'leader_unavailable' }
    }

    let client: LeaderClient
    try {
      client = await this.connectLeaderClient()
    } catch (error) {
      this.logger.warn('task scheduler could not take a leader client', { code: errorCode(error) })
      this.setLeaderGauge('follower')
      return { leader: false, reason: 'leader_unavailable' }
    }

    // Design §6.1: the listener is attached before the first statement and stays until the client
    // is released, so an error the idle connection emits during the scans never goes unhandled.
    let lost: Error | null = null
    let released = false
    const markLost = (error: Error, message: string): void => {
      if (lost !== null) return
      lost = error
      this.setLeaderGauge('relinquished')
      this.logger.warn(message, { code: errorCode(error) })
    }
    const onError = (error: Error): void => markLost(asError(error), 'task scheduler leader connection lost')
    client.on('error', onError)
    const ctx: TaskSchedulerJobContext = {
      now,
      stopping: () => this.stopping,
      leaderLost: () => lost !== null,
      stopSignal: this.stopController.signal,
      leaderHeartbeat: async () => {
        if (released || lost !== null || this.stopping) return
        try {
          await client.query('SELECT 1')
        } catch (error) {
          markLost(asError(error), 'task scheduler leader heartbeat failed')
        }
      },
    }

    let releaseWith: Error | undefined
    const jobs: Record<string, unknown> = {}
    try {
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`)
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${this.leaderIdleTimeoutMs}ms'`)
        await acquireTasksSchedulerLeaderLock((sql, params) => client.query(sql, params))
      } catch (error) {
        if (lost === null && isLockBusy(error)) {
          try {
            await client.query('ROLLBACK')
          } catch (rollbackError) {
            releaseWith = asError(rollbackError)
          }
          this.setLeaderGauge('follower')
          return { leader: false, reason: 'lock_busy' }
        }
        releaseWith = lost ?? asError(error)
        this.logger.warn('task scheduler leader transaction failed', { code: errorCode(error) })
        if (lost !== null) return { leader: false, reason: 'leader_client_lost' }
        this.setLeaderGauge('follower')
        return { leader: false, reason: 'leader_unavailable' }
      }
      this.setLeaderGauge('leader')

      for (const job of this.scanJobs) {
        if (lost !== null || this.stopping) break
        jobs[job.name] = await this.runJob(job, ctx)
      }

      if (lost !== null) {
        releaseWith = lost
        return { leader: true, reason: 'leader_client_lost', jobs }
      }
      try {
        await client.query('COMMIT')
      } catch (error) {
        markLost(asError(error), 'task scheduler leader commit failed')
        releaseWith = lost ?? asError(error)
        return { leader: true, reason: 'leader_client_lost', jobs }
      }
    } finally {
      released = true
      client.removeListener('error', onError)
      client.release(releaseWith ?? lost ?? undefined)
    }

    // Design §6.4: the lock is released; only the tick that held it starts the delivery loop.
    if (this.deliveryJob && !this.stopping) {
      jobs[this.deliveryJob.name] = await this.runJob(this.deliveryJob, ctx)
    }
    if (!this.stopping) await this.refreshBacklog(ctx.now())
    return { leader: true, jobs }
  }

  /** One job, isolated from the others: a failure is logged with a code and recorded as such. */
  private async runJob(job: TaskSchedulerJob, ctx: TaskSchedulerJobContext): Promise<unknown> {
    try {
      return await job.run(ctx)
    } catch (error) {
      this.logger.warn('task scheduler job failed', { job: job.name, code: errorCode(error) })
      return { failed: true, code: errorCode(error) }
    }
  }

  // ASSUMPTION(task-m4): [own-3b-31] the backlog gauge, refreshed once per leader tick after the
  // delivery loop, across orgs: `pending` = rows waiting for a send (`pending` or `retrying`);
  // `oldest_due_wait_seconds` = how long the earliest due waiting row has been due (0 when none);
  // `outcome_unknown` = rows ended in `outcome_unknown`, which need manual review (design §7.6).
  // Each value comes from its own subquery over the status-led index.
  private async refreshBacklog(now: Date): Promise<void> {
    if (!this.backlogGauge) return
    try {
      const result = await this.query(
        `SELECT
           (SELECT count(*) FROM task_notification_deliveries
             WHERE status IN ('pending','retrying'))::bigint AS pending,
           (SELECT min(next_attempt_at) FROM task_notification_deliveries
             WHERE status IN ('pending','retrying') AND next_attempt_at <= $1) AS oldest_due,
           (SELECT count(*) FROM task_notification_deliveries
             WHERE status = 'outcome_unknown')::bigint AS outcome_unknown`,
        [now],
      )
      const row = result.rows[0] ?? {}
      const oldestDue = row.oldest_due === null || row.oldest_due === undefined ? null : toDate(row.oldest_due)
      const values: Record<TaskNotificationBacklogKind, number> = {
        pending: Number(row.pending ?? 0),
        oldest_due_wait_seconds: oldestDue === null ? 0 : Math.max(0, Math.floor((now.getTime() - oldestDue.getTime()) / 1000)),
        outcome_unknown: Number(row.outcome_unknown ?? 0),
      }
      for (const kind of TASK_NOTIFICATION_BACKLOG_KINDS) {
        this.backlogGauge.labels({ kind }).set(values[kind])
      }
    } catch (error) {
      this.logger.warn('task scheduler backlog refresh failed', { code: errorCode(error) })
    }
  }

  private setLeaderGauge(state: TaskSchedulerLeaderState): void {
    if (!this.leaderStateGauge) return
    try {
      for (const candidate of ['leader', 'follower', 'relinquished'] as const) {
        this.leaderStateGauge.labels({ state: candidate }).set(candidate === state ? 1 : 0)
      }
    } catch {
      // A metrics failure never stops a tick.
    }
  }
}

// ── The two scans ────────────────────────────────────────────────────────────────────────────────

export interface TaskScanJobOptions {
  /** Statement runner; default `db/pg.ts#query` (autocommit on the pool). */
  query?: TaskDeliveryQuery
  /** Where the pipeline switches are read; default `process.env`. */
  env?: NodeJS.ProcessEnv
  logger?: TaskSchedulerLogger
  /** Reminder scan page size; default TASK_REMINDER_SCAN_BATCH (ASSUMPTION(task-m4): [own-3b-32]). */
  pageSize?: number
  /**
   * Orgs whose per-org reads one heartbeat covers; an integer in [1, TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS],
   * default the constant (design §6.1).
   */
  heartbeatOrgs?: number
}

export interface TaskReminderScanResult {
  /** False when the pipeline is off and the scan sent no statement. */
  ran: boolean
  pages: number
  /** Rows the scan SQL returned (open, live, `remind_at` inside the window). */
  candidates: number
  /** Candidates whose floor and window hold (`isTaskReminderDue`). */
  due: number
  /** Outbox rows written (an existing source key writes nothing). */
  written: number
}

export interface TaskDailyDigestScanResult {
  ran: boolean
  /** Settings rows with the digest on. */
  settings: number
  /** Of those, the ones due now in their own zone. */
  due: number
  written: number
  /** Settings rows whose zone could not be resolved (skipped; the rest of the scan continues). */
  invalidZone: number
  /** Due rows whose user is no longer an active member of the row's org (no row written). */
  inactiveMember: number
}

function dbOf(query: TaskDeliveryQuery): Db {
  return { query: async (sql, params) => ({ rows: (await query(sql, params)).rows }) }
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined) return TASK_REMINDER_SCAN_BATCH
  if (!Number.isSafeInteger(value) || value < 1 || value > TASK_REMINDER_SCAN_BATCH) {
    throw new TypeError(`task reminder scan: pageSize must be an integer in [1, ${TASK_REMINDER_SCAN_BATCH}]`)
  }
  return value
}

function clampHeartbeatOrgs(value: number | undefined): number {
  if (value === undefined) return TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS
  if (!Number.isSafeInteger(value) || value < 1 || value > TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS) {
    throw new TypeError(`task scan: heartbeatOrgs must be an integer in [1, ${TASK_SCHEDULER_SCAN_HEARTBEAT_ORGS}]`)
  }
  return value
}

/**
 * Design §6.1: before the org at `index` of a phase of per-org reads, one heartbeat at the start of
 * each group of `groupSize` orgs after the first (the heartbeat that preceded the phase's own
 * statement covers the first group), then the stopping and lost checks, in that order. `false`
 * once the scan must stop before this org's reads.
 */
async function beforeOrgGroup(ctx: TaskSchedulerJobContext, index: number, groupSize: number): Promise<boolean> {
  if (index === 0 || index % groupSize !== 0) return true
  await ctx.leaderHeartbeat?.()
  return !(ctx.stopping() || ctx.leaderLost())
}

/** Per tick, the channels each org may receive (the producer's org precondition, asked once per org). */
function orgChannelCache(db: Db, names: readonly TaskNotificationChannel[]): (orgId: string) => Promise<TaskNotificationChannel[]> {
  const known = new Map<string, TaskNotificationChannel[]>()
  return async (orgId) => {
    const cached = known.get(orgId)
    if (cached) return cached
    const channels = await resolveTaskDeliveryChannelsForOrg(db, orgId, names)
    known.set(orgId, channels)
    return channels
  }
}

/**
 * The single-task reminder scan (design §6.2). One tick drains the scan window page by page:
 * candidates come from `buildTaskReminderScanCondition` in `TASK_REMINDER_SCAN_ORDER_BY`, each page
 * starting after the previous page's last `(remind_at, id)`; each candidate is judged again by
 * `isTaskReminderDue` against its floor (a candidate without a floor is not sent); the recipients
 * and rows come from `planTaskReminderDeliveries`; each page writes one INSERT. Before each page the
 * scan heartbeats the leader connection, and inside a page before each further group of
 * `heartbeatOrgs` distinct orgs' precondition reads (design §6.1). The scan stops at a short page,
 * when stopping, when the leader is lost, or when a full page ends on the same row as the page
 * before it.
 */
export async function runTaskReminderScan(ctx: TaskSchedulerJobContext, options: TaskScanJobOptions = {}): Promise<TaskReminderScanResult> {
  const result: TaskReminderScanResult = { ran: false, pages: 0, candidates: 0, due: 0, written: 0 }
  const names = resolveTaskDeliveryChannelNames(options.env ?? process.env)
  if (names.length === 0) return result
  result.ran = true
  const pageSize = clampPageSize(options.pageSize)
  const heartbeatOrgs = clampHeartbeatOrgs(options.heartbeatOrgs)
  const db = dbOf(options.query ?? ((sql, params) => defaultQuery(sql, params)))
  const channelsOf = orgChannelCache(db, names)
  const now = ctx.now()
  let cursor: { afterAtParam: Date | string; afterIdParam: string } = { ...TASK_REMINDER_SCAN_CURSOR_START }
  let previousLast: { afterAtParam: string; afterIdParam: string } | null = null
  for (;;) {
    await ctx.leaderHeartbeat?.()
    if (ctx.stopping() || ctx.leaderLost()) break
    const cond = buildTaskReminderScanCondition({
      nowParam: now,
      windowMsParam: TASK_REMINDER_SCAN_WINDOW_MS,
      afterAtParam: cursor.afterAtParam,
      afterIdParam: cursor.afterIdParam,
    })
    const page = (await db.query(
      `SELECT tasks.id, tasks.org_id, tasks.created_by, tasks.remind_at,
              tasks.remind_at::text AS remind_at_cursor, reminder_floor.floor
         FROM tasks
         LEFT JOIN LATERAL (
           SELECT max(e.occurred_at) AS floor
             FROM task_events e
            WHERE e.task_id = tasks.id AND e.event_type = ANY($${cond.params.length + 2}::text[])
         ) reminder_floor ON true
        WHERE ${cond.sql}
        ORDER BY ${TASK_REMINDER_SCAN_ORDER_BY}
        LIMIT $${cond.params.length + 1}`,
      [...cond.params, pageSize, [...TASK_REMINDER_FLOOR_EVENT_TYPES]],
    )).rows
    result.pages += 1
    result.candidates += page.length
    if (!(await writeReminderPage(ctx, db, page, now, channelsOf, heartbeatOrgs, result))) break
    if (page.length < pageSize) break
    const last = page[page.length - 1]
    const next = { afterAtParam: String(last.remind_at_cursor), afterIdParam: String(last.id) }
    // ASSUMPTION(task-m4): [own-3b-32] a full page that ends on the same row as the page before it
    // ends the scan: a guard against reading the same page forever, which a correct keyset never
    // returns.
    if (previousLast !== null && next.afterAtParam === previousLast.afterAtParam && next.afterIdParam === previousLast.afterIdParam) break
    previousLast = next
    cursor = next
  }
  return result
}

/** One page's judgement, precondition reads, assignee read and INSERT; `false` when the scan must stop (the page is not written). */
async function writeReminderPage(
  ctx: TaskSchedulerJobContext,
  db: Db,
  page: readonly Row[],
  now: Date,
  channelsOf: (orgId: string) => Promise<TaskNotificationChannel[]>,
  heartbeatOrgs: number,
  result: TaskReminderScanResult,
): Promise<boolean> {
  // RULED(2026-10-07): [R06] the floor is judged here, not in SQL: no floor ⇒ not sent.
  const due = page.filter((row) => row.floor !== null && row.floor !== undefined
    && isTaskReminderDue(toDate(row.remind_at), now, toDate(row.floor)))
  result.due += due.length
  // The precondition is asked once per distinct org of the page, in page order, in heartbeat groups.
  const orgIds = [...new Set(due.map((row) => String(row.org_id)))]
  const channelsByOrg = new Map<string, TaskNotificationChannel[]>()
  for (let index = 0; index < orgIds.length; index += 1) {
    if (!(await beforeOrgGroup(ctx, index, heartbeatOrgs))) return false
    channelsByOrg.set(orgIds[index], await channelsOf(orgIds[index]))
  }
  const eligible: Array<{ row: Row; channels: TaskNotificationChannel[] }> = []
  for (const row of due) {
    const channels = channelsByOrg.get(String(row.org_id)) ?? []
    if (channels.length > 0) eligible.push({ row, channels })
  }
  if (eligible.length === 0) return true
  const assignees = await db.query(
    'SELECT task_id, user_id, completed_at FROM task_assignees WHERE task_id = ANY($1::text[])',
    [eligible.map(({ row }) => String(row.id))],
  )
  const byTask = new Map<string, TaskAssigneeCompletionShape[]>()
  for (const assignee of assignees.rows) {
    const list = byTask.get(String(assignee.task_id)) ?? []
    list.push({
      userId: String(assignee.user_id),
      completedAt: assignee.completed_at === null || assignee.completed_at === undefined ? null : toDate(assignee.completed_at),
    })
    byTask.set(String(assignee.task_id), list)
  }
  const plans: TaskNotificationDeliveryPlan[] = []
  for (const { row, channels } of eligible) {
    plans.push(...planTaskReminderDeliveries({
      orgId: String(row.org_id),
      taskId: String(row.id),
      remindAt: toDate(row.remind_at),
      creatorId: String(row.created_by),
      assignees: byTask.get(String(row.id)) ?? [],
      channels,
    }))
  }
  result.written += await insertTaskNotificationDeliveries(db, plans)
  return true
}

/**
 * The daily digest scan (design §6.3): every settings row with the digest on is judged in its own
 * zone (`resolveDailyDigestOccurrence`); a due recipient of an org that passes the precondition,
 * and who is still an active member of that org by the test of send time, gets one row for its
 * local date (`planTaskDailyDigestDelivery`). The content is computed at send time by the worker.
 * Rows are written in INSERTs of at most `TASK_REMINDER_SCAN_BATCH` plans, with a heartbeat on the
 * leader connection before the settings read, before each further group of `heartbeatOrgs` orgs'
 * precondition and membership reads, and before each INSERT (design §6.1).
 */
export async function runTaskDailyDigestScan(ctx: TaskSchedulerJobContext, options: TaskScanJobOptions = {}): Promise<TaskDailyDigestScanResult> {
  const result: TaskDailyDigestScanResult = { ran: false, settings: 0, due: 0, written: 0, invalidZone: 0, inactiveMember: 0 }
  const names = resolveTaskDeliveryChannelNames(options.env ?? process.env)
  if (names.length === 0) return result
  result.ran = true
  const heartbeatOrgs = clampHeartbeatOrgs(options.heartbeatOrgs)
  const db = dbOf(options.query ?? ((sql, params) => defaultQuery(sql, params)))
  const channelsOf = orgChannelCache(db, names)
  const now = ctx.now()
  await ctx.leaderHeartbeat?.()
  if (ctx.stopping() || ctx.leaderLost()) return result
  const settings = (await db.query(
    `SELECT user_id, org_id, time_zone FROM task_user_settings
      WHERE daily_reminder_enabled = true AND time_zone IS NOT NULL
      ORDER BY org_id, user_id`,
  )).rows
  result.settings = settings.length
  const dueByOrg = new Map<string, Array<{ userId: string; timeZone: string; localDate: string }>>()
  for (const row of settings) {
    const timeZone = String(row.time_zone)
    let occurrence: ReturnType<typeof resolveDailyDigestOccurrence>
    try {
      occurrence = resolveDailyDigestOccurrence(now, timeZone)
    } catch {
      // One unusable zone never stops the scan for everyone else.
      result.invalidZone += 1
      continue
    }
    if (!occurrence.due) continue
    result.due += 1
    const orgId = String(row.org_id)
    const due = dueByOrg.get(orgId) ?? []
    due.push({ userId: String(row.user_id), timeZone, localDate: occurrence.localDate })
    dueByOrg.set(orgId, due)
  }
  const plans: TaskNotificationDeliveryPlan[] = []
  // The per-org phase: the precondition and the membership read per org, in heartbeat groups
  // (design §6.1); once stopping or lost the scan sends no further statement.
  const orgIds = [...dueByOrg.keys()]
  for (let index = 0; index < orgIds.length; index += 1) {
    if (!(await beforeOrgGroup(ctx, index, heartbeatOrgs))) break
    const orgId = orgIds[index]
    const due = dueByOrg.get(orgId) ?? []
    const channels = await channelsOf(orgId)
    if (channels.length === 0) continue
    // ASSUMPTION(task-m4): [own-3b-38] the membership test of send time (RULED(2026-10-07): [R17])
    // is applied here too, once per org: a settings row whose user has left the org writes no row,
    // instead of one row a day that the worker would end as skipped.
    const active = await findActiveOrgMembers(db, orgId, due.map((entry) => entry.userId))
    for (const entry of due) {
      if (!active.has(entry.userId)) {
        result.inactiveMember += 1
        continue
      }
      plans.push(...planTaskDailyDigestDelivery({ orgId, userId: entry.userId, date: entry.localDate, timeZone: entry.timeZone, channels }))
    }
  }
  // One INSERT per page of plans; the scan stops before the next page when stopping or when the
  // leader is lost (rows already written stay; a later tick writes the rest while still due).
  for (let at = 0; at < plans.length; at += TASK_REMINDER_SCAN_BATCH) {
    await ctx.leaderHeartbeat?.()
    if (ctx.stopping() || ctx.leaderLost()) break
    result.written += await insertTaskNotificationDeliveries(db, plans.slice(at, at + TASK_REMINDER_SCAN_BATCH))
  }
  return result
}

/** A scan as a scheduler job; while the pipeline is off the job logs that once and writes nothing. */
function scanJob<R extends { ran: boolean }>(
  name: string,
  scan: (ctx: TaskSchedulerJobContext, options: TaskScanJobOptions) => Promise<R>,
  options: TaskScanJobOptions,
): TaskSchedulerJob {
  let offLogged = false
  return {
    name,
    run: async (ctx) => {
      const result = await scan(ctx, options)
      if (!result.ran && !offLogged) {
        offLogged = true
        ;(options.logger ?? new Logger('TaskScheduler')).info('task scan idle: the notification pipeline is off', { job: name })
      }
      return result
    },
  }
}

/** The reminder scan as a scheduler job (design §3.2). */
export function resolveTaskReminderJob(options: TaskScanJobOptions = {}): TaskSchedulerJob {
  return scanJob('task-reminder-scan', runTaskReminderScan, options)
}

/** The daily digest scan as a scheduler job (design §3.2). */
export function resolveTaskDailyDigestJob(options: TaskScanJobOptions = {}): TaskSchedulerJob {
  return scanJob('task-daily-digest-scan', runTaskDailyDigestScan, options)
}

// ── The delivery job ─────────────────────────────────────────────────────────────────────────────

export interface TaskNotificationDeliveryJobOptions {
  env?: NodeJS.ProcessEnv
  /** Channels; default `createTaskDeliveryChannelsFromEnv(env)`. */
  channels?: TaskDeliveryChannel[]
  query?: TaskDeliveryQuery
  workerId?: string
  budgetMs?: number
}

/**
 * The delivery loop as a scheduler job (design §6.4), or `null` unless TASKS_ENABLED and
 * TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED are both exactly 'true'. Each run is
 * `runUntilIdle({ budgetMs: TASK_DELIVERY_TICK_BUDGET_MS, stopping })`.
 *
 * ASSUMPTION(task-m4): [own-3b-33] the worker is built once, when the job is resolved at start-up
 * (its switches and channels are read then); each run hands it the tick's database-anchored clock.
 */
export function resolveTaskNotificationDeliveryJob(options: TaskNotificationDeliveryJobOptions = {}): TaskSchedulerJob | null {
  const env = options.env ?? process.env
  if (!(isTasksEnabled(env) && isTaskNotificationDeliveryWorkerEnabled(env))) return null
  let tickNow: () => Date = () => new Date()
  const worker = new TaskNotificationDeliveryWorker({
    channels: options.channels ?? createTaskDeliveryChannelsFromEnv(env),
    now: () => tickNow(),
    env,
    query: options.query,
    workerId: options.workerId,
  })
  const budgetMs = options.budgetMs ?? TASK_DELIVERY_TICK_BUDGET_MS
  return {
    name: 'task-notification-delivery',
    run: (ctx) => {
      tickNow = ctx.now
      return worker.runUntilIdle({ budgetMs, stopping: ctx.stopping, stopSignal: ctx.stopSignal })
    },
  }
}

// ── Start and stop (design §6.6) ─────────────────────────────────────────────────────────────────

/** The pool the scheduler takes its leader clients from (`db/pg.ts#pool`). */
export interface TaskSchedulerPool {
  connect(): Promise<LeaderClient>
}

let sharedScheduler: TaskScheduler | null = null

/**
 * Builds and starts the scheduler when TASKS_ENABLED and TASKS_SCHEDULER_ENABLED are both exactly
 * 'true' and the database pool exists; otherwise returns `null` (a pool that is missing while both
 * switches are on is logged as a warning: it is a deployment fault, not a quiet off state).
 */
export function startTaskScheduler(options: { env?: NodeJS.ProcessEnv; pool?: TaskSchedulerPool | null; logger?: TaskSchedulerLogger } = {}): TaskScheduler | null {
  const env = options.env ?? process.env
  const logger = options.logger ?? new Logger('TaskScheduler')
  if (!(isTasksEnabled(env) && isTasksSchedulerEnabled(env))) {
    logger.info('task scheduler disabled')
    return null
  }
  const pool = options.pool === undefined ? (defaultPool as unknown as TaskSchedulerPool | null) : options.pool
  if (!pool) {
    logger.warn('task scheduler not started: both switches are on but there is no database pool')
    return null
  }
  if (sharedScheduler) return sharedScheduler
  sharedScheduler = new TaskScheduler({
    scanJobs: [resolveTaskReminderJob({ env }), resolveTaskDailyDigestJob({ env })],
    deliveryJob: resolveTaskNotificationDeliveryJob({ env }),
    connectLeaderClient: () => pool.connect(),
    intervalMs: resolveTaskSchedulerIntervalMs(env),
    logger,
    leaderStateGauge: metrics.tasksSchedulerLeaderGauge,
    backlogGauge: metrics.tasksNotificationBacklogGauge,
  })
  sharedScheduler.start()
  return sharedScheduler
}

/** Stops the scheduler `startTaskScheduler` built, waiting for its tick in flight (bounded). */
export async function stopTaskScheduler(): Promise<void> {
  const scheduler = sharedScheduler
  sharedScheduler = null
  if (scheduler) await scheduler.stop()
}
