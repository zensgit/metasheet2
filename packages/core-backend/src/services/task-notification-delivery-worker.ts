/**
 * Task notification delivery worker (M4 PR-3b design
 * `docs/development/task-m4-pr3b-backend-design-20261001.md` §3.3, §7).
 *
 * Takes due `task_notification_deliveries` rows (the outbox the producer and the scheduler scans
 * write), renders each row's text at send time and hands it to the row's channel at most once.
 * One batch (`runBatch`):
 *   1. two sweeps: a `sending` row whose lease has run out becomes `outcome_unknown` and is never
 *      sent again; a `pending` / `retrying` row that has used up its attempts becomes `failed`;
 *   2. one claim: up to `batchSize` due rows of a registered channel, `FOR UPDATE SKIP LOCKED`,
 *      under one batch lease, `attempt_count + 1`, status unchanged;
 *   3. per row, in claim order: payload check, materialisation (the send-time checks and the
 *      text), `channel.prepare()`, materialisation again, the effect fence (`sending`, lease
 *      renewed to exactly one send), `send()`, one terminal compare-and-set;
 *   4. the claimed rows the batch did not start are handed back (`attempt_count − 1`, no lease):
 *      at the end of the batch, or at once while a row is in flight when the stop signal fires or
 *      the row runs over `TASK_DELIVERY_ROW_BUDGET_MS`; a row in flight that has not passed the
 *      fence is handed back the same way at the first stopping check it meets (before `prepare`,
 *      before the second materialisation, before the fence), so no channel call starts once
 *      stopping.
 * The rules applied between those statements are pure functions of `src/tasks/`
 * (`task-delivery-protocol.ts`, `task-notifications.ts`, `task-reminders.ts`, `task-access.ts`,
 * `task-notification-text.ts`), with three structural checks kept in this module: a payload must
 * belong to its row (`payloadMatchesRow`), a row is started only while the batch lease still
 * covers `TASK_DELIVERY_ROW_RESERVE_MS`, and a row is fenced only while it is inside its budget
 * (the budget is read after each of the three steps before the fence: after the first
 * materialisation an over-budget row never calls the channel; after `prepare` its prepared
 * closure is dropped and the state is not read again; after the second materialisation it is not
 * fenced). This module runs the statements and calls the rules.
 *
 * Each statement autocommits. The worker opens no transaction and takes no advisory lock: two
 * workers are kept apart by `SKIP LOCKED`, the lease predicates and the compare-and-set clauses
 * (worker id, attempt count, status, lease).
 *
 * ASSUMPTION(task-m4): [own-3b-04] `sending` is the effect fence: it is written immediately before
 * the single external call, and a row once written to `sending` is never sent again; a row the
 * batch did not start is handed back without spending an attempt. [own-3b-08] the constants.
 * [own-3b-05] [own-3b-14] the send-time skip codes and the 24 h freshness of the event and list
 * families. [own-3b-26] the worker reads TASKS_ENABLED and its own switch once, when it is built;
 * unless both are exactly 'true' it sends no statement at all. [own-3b-36] the row budget: a row
 * over it is not fenced and ends as a bounded retry (`row_budget_exceeded`); the rows queued
 * behind it go back the moment it runs over. [own-3b-37] materialisation runs before `prepare`
 * (a row that is going to be skipped never calls the channel) and again right before the fence
 * (the last state check and the fence are one round trip apart, whatever `prepare` took).
 * RULED(2026-10-07): [R17] the recipient is checked again at send time: not an active member of the
 * row's org ⇒ `skipped`. [R06] a reminder is not sent when its task is done, deleted or rescheduled,
 * when the reminder moment is outside the scan window at send time, or to anyone but an incomplete
 * assignee (the creator for a task without assignees). [R07] an empty digest ends as one `skipped`
 * row and nothing is sent. [R05] [D13] an event row is sent only while its recipient can still view
 * the task (list identity included); a list row only to the list's creator.
 *
 * Logs carry ids, counts and fixed codes only. `last_error` holds a fixed code, or the error text a
 * channel returned (a channel redacts its own transport text before returning it).
 */
import { randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import { query as defaultQuery } from '../db/pg'
import { metrics } from '../metrics/metrics'
import { buildTaskByIdAnyStateCondition, buildTaskByIdCondition, can } from '../tasks/task-access'
import {
  classifyTaskDeliveryOutcome,
  clampDeliveryBatchSize,
  clampDeliveryLeaseMs,
  computeTaskDeliveryBackoffMs,
  isTaskEventNotificationStale,
  orderClaimedDeliveries,
  TASK_DELIVERY_MAX_ATTEMPTS_DEFAULT,
  TASK_DELIVERY_PRIORITY_SOURCE_TYPES,
  TASK_DELIVERY_ROW_BUDGET_MS,
  TASK_DELIVERY_ROW_RESERVE_MS,
  TASK_DELIVERY_SEND_LEASE_MS,
  type TaskDeliveryChannelResult,
  type TaskDeliveryOutcome,
} from '../tasks/task-delivery-protocol'
import { isTasksEnabled } from '../tasks/feature-flag'
import { buildTaskListByIdCondition } from '../tasks/task-list-access'
import {
  renderTaskDailyDigestMessage,
  renderTaskEventMessage,
  renderTaskListEventMessage,
  renderTaskReminderMessage,
  TASK_DIGEST_MAX_ITEMS,
  type TaskDeliveryMessage,
  type TaskDigestItem,
} from '../tasks/task-notification-text'
import {
  parseTaskNotificationPayload,
  resolveListArchiveNotificationRecipients,
  resolveReminderRecipients,
  TASK_NOTIFICATION_CHANNEL_DINGTALK,
  type TaskNotificationPayload,
} from '../tasks/task-notifications'
import {
  buildTaskDailyDigestCondition,
  isReminderSkippedByTaskState,
  isTaskReminderDue,
  resolveDailyDigestOccurrence,
  TASK_REMINDER_FLOOR_EVENT_TYPES,
} from '../tasks/task-reminders'
import { DingTalkTaskDeliveryChannel } from './task-notification-dingtalk'
import { isTaskDingTalkWorkNotificationEnabled, isTaskNotificationDeliveryWorkerEnabled } from './task-notification-flags'
import { findActiveOrgMembers } from './task-org-members'
import { loadAssignees, loadRowRoles, type Db, type Row } from './task-records'
import { getTaskSettings } from './task-user-settings'

export type { TaskDeliveryChannelResult } from '../tasks/task-delivery-protocol'

// ── Contracts ────────────────────────────────────────────────────────────────────────────────────

/** Who and what a channel prepares for: the outbox row id (for the channel's logs), its org and recipient. */
export interface TaskDeliveryPrepareTarget {
  deliveryId: string
  orgId: string
  recipientUserId: string
}

/**
 * A channel's answer to `prepare`: either a `send` closure holding everything the single external
 * call needs, or the determinate result that ends the row before any send.
 */
export type TaskDeliveryPrepared =
  | { ok: true; send(message: TaskDeliveryMessage): Promise<TaskDeliveryChannelResult> }
  | { ok: false; result: TaskDeliveryChannelResult }

/**
 * A delivery channel (design §3.3). `prepare` has no side effect towards the recipient (identity,
 * configuration, token); the closure it returns makes exactly one external call and nothing else.
 * `name` is the outbox `channel` value the worker claims rows for.
 */
export interface TaskDeliveryChannel {
  readonly name: string
  prepare(target: TaskDeliveryPrepareTarget): Promise<TaskDeliveryPrepared>
}

/** The statement runner; production is `db/pg.ts#query` (autocommit on the pool). */
export type TaskDeliveryQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>

/** The outcome counter (`tasks_notification_deliveries_total`); tests pass their own. */
export interface TaskDeliveryCounter {
  inc(labels: { outcome: TaskDeliveryOutcome }, value?: number): void
}

type TaskDeliveryLogger = Pick<Logger, 'info' | 'warn'>

/** The timer the row budget runs on; production is the global timers (unref'd), tests pass their own. */
export interface TaskDeliveryTimers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const DEFAULT_TIMERS: TaskDeliveryTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    if (typeof handle.unref === 'function') handle.unref()
    return handle
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export interface TaskNotificationDeliveryWorkerOptions {
  /** Channels the worker claims rows for; a row of any other channel is never claimed. */
  channels: readonly TaskDeliveryChannel[]
  query?: TaskDeliveryQuery
  /** Rows per claim; clamped to [1, 200], default 50. */
  batchSize?: number
  /** Batch lease in ms; clamped to [60 000, 600 000], default 60 000. */
  leaseMs?: number
  /** Attempts before a retryable row is `failed`; an integer ≥ 1, default 5. */
  maxAttempts?: number
  /** Lease the fence sets for the one send; an integer in [1, leaseMs), default 15 000. */
  sendLeaseMs?: number
  workerId?: string
  now?: () => Date
  logger?: TaskDeliveryLogger
  metrics?: TaskDeliveryCounter
  /** Where the two switches are read, once, here; default `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Timer source for the row budget; default the global timers. */
  timers?: TaskDeliveryTimers
}

export interface TaskDeliveryBatchContext {
  /** True once the process is stopping: no new row is started and no row passes the fence. */
  stopping?: () => boolean
  /**
   * Aborted once the process is stopping: the rows the batch has not started go back at once,
   * without waiting for the row in flight (design §6.6).
   */
  stopSignal?: AbortSignal
  /** Instant (ms, on the worker's clock) after which no new row is started. */
  deadline?: number
}

export interface TaskDeliveryBatchResult {
  claimed: number
  sent: number
  retrying: number
  failed: number
  skipped: number
  outcomeUnknown: number
  /** Rows whose fence or terminal write found the row no longer held by this worker. */
  lostLease: number
  /** Claimed rows handed back unstarted (attempt not spent). */
  released: number
  swept: { outcomeUnknown: number; exhausted: number }
}

export const TASK_DELIVERY_TOTAL_KEYS = [
  'claimed', 'sent', 'retrying', 'failed', 'skipped', 'outcomeUnknown', 'lostLease', 'released',
  'sweptOutcomeUnknown', 'sweptExhausted',
] as const
export type TaskDeliveryTotals = Record<(typeof TASK_DELIVERY_TOTAL_KEYS)[number], number>

// ── Fixed codes the worker itself writes to `last_error` (ASSUMPTION(task-m4): [own-3b-29]) ──────

/** Codes for failures of the worker's own steps; never an exception's text. */
export const TASK_DELIVERY_WORKER_ERROR_CODES = Object.freeze({
  payloadMismatch: 'payload_invalid',
  channelNotRegistered: 'channel_not_registered',
  prepareFailed: 'prepare_failed',
  prepareResultInvalid: 'prepare_result_invalid',
  materializeFailed: 'materialize_failed',
  rowBudgetExceeded: 'row_budget_exceeded',
  sendUnclassified: 'send_unclassified',
} as const)

/** Send-time skip codes (design §4.6, §7.4; `last_error` of a `skipped` row). */
export const TASK_DELIVERY_SKIP_CODES = Object.freeze({
  recipientInactiveInOrg: 'recipient_inactive_in_org',
  eventStale: 'event_stale',
  taskMissing: 'task_missing',
  recipientLostAccess: 'recipient_lost_access',
  reminderStale: 'reminder_stale',
  reminderWindowElapsed: 'reminder_window_elapsed',
  digestSettingsChanged: 'digest_settings_changed',
  digestWindowElapsed: 'digest_window_elapsed',
  emptyDigest: 'empty_digest',
  listMissing: 'list_missing',
} as const)

const LAST_ERROR_MAX_LENGTH = 1000

// ── Channels from the environment ────────────────────────────────────────────────────────────────

/**
 * The channels a worker built from the environment claims rows for (design §8.1): the DingTalk
 * work-notification channel when TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED is exactly
 * 'true', nothing otherwise, so a worker built from an empty list claims no row. The flag alone
 * decides: the channel's app configuration is stored on each org's integration row and read for
 * every row it prepares (ASSUMPTION(task-m4): [own-3b-19]); there is no process configuration to
 * check here, and an integration without one ends its rows retrying / `dingtalk_config_unavailable`
 * within the attempt limit.
 */
export function createTaskDeliveryChannelsFromEnv(env: NodeJS.ProcessEnv = process.env): TaskDeliveryChannel[] {
  return isTaskDingTalkWorkNotificationEnabled(env) ? [new DingTalkTaskDeliveryChannel()] : []
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────

interface ClaimedDelivery {
  id: string
  orgId: string
  sourceType: string
  sourceId: string | null
  recipientUserId: string
  channel: string
  attemptCount: number
  payload: unknown
  nextAttemptAt: Date
  createdAt: Date
  claimExpiresAt: Date
}

type RowOutcome = TaskDeliveryOutcome | 'lost-lease' | 'released'

type Materialised =
  | { kind: 'skip'; code: string }
  | { kind: 'send'; message: TaskDeliveryMessage }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value)
}

function toClaimedDelivery(row: Row): ClaimedDelivery {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    sourceType: String(row.source_type),
    sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
    recipientUserId: String(row.recipient_user_id),
    channel: String(row.channel),
    attemptCount: Number(row.attempt_count),
    payload: row.payload,
    nextAttemptAt: toDate(row.next_attempt_at),
    createdAt: toDate(row.created_at),
    claimExpiresAt: toDate(row.claim_expires_at),
  }
}

// ASSUMPTION(task-m4): [own-3b-27] a payload belongs to its row: its kind is the row's `source_type`
// and its task / list id is the row's `source_id` (a digest row's `source_id` is its recipient).
// Anything else is `failed` / `payload_invalid`, like a payload that does not parse.
function payloadMatchesRow(payload: TaskNotificationPayload, row: ClaimedDelivery): boolean {
  if (payload.kind !== row.sourceType) return false
  switch (payload.kind) {
    case 'task_event':
    case 'task_reminder':
      return payload.taskId === row.sourceId
    case 'task_list_event':
      return payload.listId === row.sourceId
    case 'task_daily':
      return row.sourceId === row.recipientUserId
  }
}

function isPrepared(value: unknown): value is Extract<TaskDeliveryPrepared, { ok: true }> {
  return isRecord(value) && value.ok === true && typeof value.send === 'function'
}

/** The error text of a channel result, or `fallback` (a fixed code) when there is none. */
function lastErrorOf(result: unknown, fallback: string): string {
  if (isRecord(result) && result.ok === false && typeof result.error === 'string' && result.error.length > 0) {
    return result.error.slice(0, LAST_ERROR_MAX_LENGTH)
  }
  return fallback
}

function emptyBatchResult(): TaskDeliveryBatchResult {
  return {
    claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0, outcomeUnknown: 0, lostLease: 0, released: 0,
    swept: { outcomeUnknown: 0, exhausted: 0 },
  }
}

function emptyTotals(): TaskDeliveryTotals {
  return Object.fromEntries(TASK_DELIVERY_TOTAL_KEYS.map((key) => [key, 0])) as TaskDeliveryTotals
}

const OUTCOME_FIELD: Record<TaskDeliveryOutcome, 'sent' | 'retrying' | 'failed' | 'skipped' | 'outcomeUnknown'> = {
  sent: 'sent',
  retrying: 'retrying',
  failed: 'failed',
  skipped: 'skipped',
  outcome_unknown: 'outcomeUnknown',
}

const NOT_FENCED_STATUSES = ['pending', 'retrying'] as const
const FENCED_STATUSES = ['sending'] as const

// ── Worker ───────────────────────────────────────────────────────────────────────────────────────

export class TaskNotificationDeliveryWorker {
  readonly workerId: string
  /** Whether TASKS_ENABLED and TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED were both exactly 'true' when built. */
  readonly enabled: boolean
  readonly batchSize: number
  private readonly query: TaskDeliveryQuery
  private readonly db: Db
  private readonly channelsByName: ReadonlyMap<string, TaskDeliveryChannel>
  private readonly channelNames: string[]
  private readonly leaseMs: number
  private readonly sendLeaseMs: number
  private readonly maxAttempts: number
  private readonly now: () => Date
  private readonly logger: TaskDeliveryLogger
  private readonly counter: TaskDeliveryCounter
  private readonly timers: TaskDeliveryTimers
  private running = false

  constructor(options: TaskNotificationDeliveryWorkerOptions) {
    if (!isRecord(options) || !Array.isArray(options.channels)) {
      throw new TypeError('TaskNotificationDeliveryWorker: options.channels must be an array')
    }
    const env = options.env ?? process.env
    this.enabled = isTasksEnabled(env) && isTaskNotificationDeliveryWorkerEnabled(env)
    const byName = new Map<string, TaskDeliveryChannel>()
    for (const channel of options.channels) {
      const shape: unknown = channel
      if (!isRecord(shape) || typeof shape.name !== 'string' || shape.name.length === 0 || typeof shape.prepare !== 'function') {
        throw new TypeError('TaskNotificationDeliveryWorker: each channel needs a name and prepare()')
      }
      if (byName.has(channel.name)) {
        throw new TypeError(`TaskNotificationDeliveryWorker: channel "${channel.name}" is registered twice`)
      }
      byName.set(channel.name, channel)
    }
    this.channelsByName = byName
    this.channelNames = [...byName.keys()]
    this.batchSize = clampDeliveryBatchSize(options.batchSize)
    this.leaseMs = clampDeliveryLeaseMs(options.leaseMs)
    // Design §7.2: a batch lease must leave room for at least one whole row.
    if (!(this.leaseMs > TASK_DELIVERY_ROW_RESERVE_MS)) {
      throw new TypeError('TaskNotificationDeliveryWorker: leaseMs must exceed TASK_DELIVERY_ROW_RESERVE_MS')
    }
    const maxAttempts = options.maxAttempts ?? TASK_DELIVERY_MAX_ATTEMPTS_DEFAULT
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError('TaskNotificationDeliveryWorker: maxAttempts must be an integer ≥ 1')
    }
    this.maxAttempts = maxAttempts
    const sendLeaseMs = options.sendLeaseMs ?? TASK_DELIVERY_SEND_LEASE_MS
    if (!Number.isSafeInteger(sendLeaseMs) || sendLeaseMs < 1 || sendLeaseMs >= this.leaseMs) {
      throw new TypeError('TaskNotificationDeliveryWorker: sendLeaseMs must be an integer in [1, leaseMs)')
    }
    this.sendLeaseMs = sendLeaseMs
    if (options.workerId !== undefined && (typeof options.workerId !== 'string' || options.workerId.length === 0)) {
      throw new TypeError('TaskNotificationDeliveryWorker: workerId must be a non-empty string')
    }
    this.workerId = options.workerId ?? `task-delivery:${process.pid}:${randomBytes(4).toString('hex')}`
    this.query = options.query ?? ((sql, params) => defaultQuery(sql, params))
    this.db = { query: async (sql, params) => ({ rows: (await this.query(sql, params)).rows }) }
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? new Logger('TaskNotificationDeliveryWorker')
    this.counter = options.metrics ?? metrics.tasksNotificationDeliveriesTotal
    this.timers = options.timers ?? DEFAULT_TIMERS
  }

  /**
   * One batch: sweeps, one claim, the claimed rows in claim order, the hand-back. Returns zeros
   * without sending a statement while the worker is not enabled, while `stopping()` is already
   * true (or the stop signal already aborted), or while another batch of this worker is running.
   */
  async runBatch(ctx: TaskDeliveryBatchContext = {}): Promise<TaskDeliveryBatchResult> {
    const result = emptyBatchResult()
    const stopping = (): boolean => (ctx.stopping?.() ?? false) || ctx.stopSignal?.aborted === true
    if (!this.enabled || this.running || stopping()) return result
    this.running = true
    try {
      let pending: ClaimedDelivery[] = []
      const handBack: ClaimedDelivery[] = []
      let failure: unknown = null
      try {
        result.swept = await this.sweep(this.now())
        const claimed = await this.claim(this.now())
        result.claimed = claimed.length
        pending = claimed
        pending = orderClaimedDeliveries(claimed)
        while (pending.length > 0) {
          const row = pending[0]
          const now = this.now().getTime()
          if (stopping()) break
          if (ctx.deadline !== undefined && now >= ctx.deadline) break
          // Design §7.2: a row is started only while the batch lease still covers a whole row.
          if (row.claimExpiresAt.getTime() - now < TASK_DELIVERY_ROW_RESERVE_MS) break
          pending.shift()
          const delivery = this.deliver(row, stopping, now)
          // Design §6.6, §7.2: a stop, or this row running over its budget, hands the rest of the
          // batch back at once, without waiting for the row in flight.
          if ((await this.firstInterrupt(delivery, ctx.stopSignal)) !== null && pending.length > 0) {
            const rest = pending.splice(0, pending.length)
            try {
              result.released += await this.release(rest, this.now())
            } catch (error) {
              if (failure === null) failure = error
            }
          }
          const outcome = await delivery
          if (outcome === 'released') handBack.push(row)
          else if (outcome === 'lost-lease') result.lostLease += 1
          else result[OUTCOME_FIELD[outcome]] += 1
        }
      } catch (error) {
        failure = error
      }
      const unstarted = [...handBack, ...pending]
      if (unstarted.length > 0) {
        try {
          result.released += await this.release(unstarted, this.now())
        } catch (error) {
          if (failure === null) failure = error
        }
      }
      if (failure !== null) throw failure
      if (result.claimed > 0 || result.swept.outcomeUnknown > 0 || result.swept.exhausted > 0) {
        this.logger.info('task deliveries', {
          workerId: this.workerId,
          claimed: result.claimed,
          sent: result.sent,
          retrying: result.retrying,
          failed: result.failed,
          skipped: result.skipped,
          outcomeUnknown: result.outcomeUnknown,
          lostLease: result.lostLease,
          released: result.released,
          sweptOutcomeUnknown: result.swept.outcomeUnknown,
          sweptExhausted: result.swept.exhausted,
        })
      }
      return result
    } finally {
      this.running = false
    }
  }

  /**
   * Batches back to back until one claims fewer rows than `batchSize` (the due rows are drained),
   * the budget on the worker's clock is spent, or `stopping()` (design §6.4). The stop signal is
   * handed to every batch (design §6.6).
   */
  async runUntilIdle(ctx: { budgetMs: number; stopping?: () => boolean; stopSignal?: AbortSignal }): Promise<{ batches: number; totals: TaskDeliveryTotals }> {
    const totals = emptyTotals()
    if (!this.enabled) return { batches: 0, totals }
    if (!isRecord(ctx) || !Number.isFinite(ctx.budgetMs) || ctx.budgetMs <= 0) {
      throw new TypeError('runUntilIdle: budgetMs must be a positive number')
    }
    const stopping = (): boolean => (ctx.stopping?.() ?? false) || ctx.stopSignal?.aborted === true
    const deadline = this.now().getTime() + ctx.budgetMs
    let batches = 0
    while (!stopping() && this.now().getTime() < deadline) {
      const batch = await this.runBatch({ stopping, stopSignal: ctx.stopSignal, deadline })
      batches += 1
      totals.claimed += batch.claimed
      totals.sent += batch.sent
      totals.retrying += batch.retrying
      totals.failed += batch.failed
      totals.skipped += batch.skipped
      totals.outcomeUnknown += batch.outcomeUnknown
      totals.lostLease += batch.lostLease
      totals.released += batch.released
      totals.sweptOutcomeUnknown += batch.swept.outcomeUnknown
      totals.sweptExhausted += batch.swept.exhausted
      if (batch.claimed < this.batchSize) break
    }
    return { batches, totals }
  }

  // ── Statements ─────────────────────────────────────────────────────────────────────────────────

  /** Design §7.2: the two sweeps at the start of every batch. Cross-org and cross-channel. */
  private async sweep(now: Date): Promise<{ outcomeUnknown: number; exhausted: number }> {
    // A send was started and its renewed lease ran out: terminal, never sent again.
    const unknown = await this.query(
      `UPDATE task_notification_deliveries
          SET status = 'outcome_unknown', last_error = 'lease_expired_after_send_started',
              claim_expires_at = NULL, updated_at = $1
        WHERE status = 'sending' AND claim_expires_at <= $1
        RETURNING id`,
      [now],
    )
    // Attempts used up while no lease is held (rows that kept failing before the fence).
    const exhausted = await this.query(
      `UPDATE task_notification_deliveries
          SET status = 'failed', last_error = 'attempts_exhausted', redelivery_safe = (channel = $3),
              claim_expires_at = NULL, claim_worker_id = NULL, updated_at = $1
        WHERE status IN ('pending','retrying') AND attempt_count >= $2
          AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
        RETURNING id`,
      [now, this.maxAttempts, TASK_NOTIFICATION_CHANNEL_DINGTALK],
    )
    if (unknown.rows.length > 0) this.counter.inc({ outcome: 'outcome_unknown' }, unknown.rows.length)
    if (exhausted.rows.length > 0) this.counter.inc({ outcome: 'failed' }, exhausted.rows.length)
    return { outcomeUnknown: unknown.rows.length, exhausted: exhausted.rows.length }
  }

  /** Design §7.2: one claim under a batch lease; the windowed families first (§6.4). */
  private async claim(now: Date): Promise<ClaimedDelivery[]> {
    const result = await this.query(
      `WITH claim AS (
         SELECT id FROM task_notification_deliveries
          WHERE status IN ('pending','retrying')
            AND next_attempt_at <= $1
            AND attempt_count < $2
            AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
            AND channel = ANY($5::text[])
          ORDER BY (source_type = ANY($7::text[])) DESC, next_attempt_at ASC, created_at ASC, id ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       UPDATE task_notification_deliveries d
          SET claim_worker_id = $4, claimed_at = $1,
              claim_expires_at = $1::timestamptz + ($6::int * interval '1 millisecond'),
              attempt_count = d.attempt_count + 1, updated_at = $1
         FROM claim WHERE d.id = claim.id
       RETURNING d.id::text AS id, d.org_id, d.source_type, d.source_id, d.source_key,
                 d.recipient_user_id, d.recipient_role, d.channel, d.attempt_count, d.payload,
                 d.next_attempt_at, d.created_at, d.claim_expires_at`,
      [now, this.maxAttempts, this.batchSize, this.workerId, this.channelNames, this.leaseMs, [...TASK_DELIVERY_PRIORITY_SOURCE_TYPES]],
    )
    return result.rows.map(toClaimedDelivery)
  }

  /** Design §7.2: the unstarted rows go back unclaimed, with the attempt the claim spent returned. */
  private async release(rows: readonly ClaimedDelivery[], now: Date): Promise<number> {
    const result = await this.query(
      `UPDATE task_notification_deliveries d
          SET claim_worker_id = NULL, claimed_at = NULL, claim_expires_at = NULL,
              attempt_count = d.attempt_count - 1, updated_at = $1
         FROM unnest($2::uuid[], $3::int[]) AS r(id, n)
        WHERE d.id = r.id AND d.claim_worker_id = $4 AND d.attempt_count = r.n
          AND d.status IN ('pending','retrying')
        RETURNING d.id`,
      [now, rows.map((row) => row.id), rows.map((row) => row.attemptCount), this.workerId],
    )
    return result.rows.length
  }

  /**
   * Design §7.2: the effect fence, the only way into `sending`. It also renews the lease to cover
   * exactly one send. No row ⇒ the lease is lost and nothing is sent.
   */
  private async fence(row: ClaimedDelivery, now: Date): Promise<boolean> {
    const result = await this.query(
      `UPDATE task_notification_deliveries
          SET status = 'sending', last_attempt_at = $1, updated_at = $1,
              claim_expires_at = $1::timestamptz + ($5::int * interval '1 millisecond')
        WHERE id = $2::uuid AND claim_worker_id = $3 AND attempt_count = $4
          AND status IN ('pending','retrying')
          AND claim_expires_at > $1
        RETURNING id`,
      [now, row.id, this.workerId, row.attemptCount, this.sendLeaseMs],
    )
    return result.rows.length === 1
  }

  /**
   * Design §7.2: one terminal compare-and-set, held by this worker at this attempt, from `sending`
   * after the fence or from `pending` / `retrying` before it. No row ⇒ the lease was lost (for a
   * fenced row: the sweep has already written `outcome_unknown`; it is not overwritten).
   */
  private async writeTerminal(
    row: ClaimedDelivery,
    outcome: TaskDeliveryOutcome,
    lastError: string | null,
    fenced: boolean,
  ): Promise<boolean> {
    const now = this.now()
    const held = 'WHERE id = $1::uuid AND claim_worker_id = $2 AND attempt_count = $3 AND status = ANY($4::text[])'
    const statuses = fenced ? [...FENCED_STATUSES] : [...NOT_FENCED_STATUSES]
    const base: unknown[] = [row.id, this.workerId, row.attemptCount, statuses, now]
    let sql: string
    let params: unknown[]
    switch (outcome) {
      case 'sent':
        sql = `UPDATE task_notification_deliveries
                  SET status = 'sent', delivered_at = $5, last_error = NULL,
                      claim_expires_at = NULL, claim_worker_id = NULL, updated_at = $5
                ${held} RETURNING id`
        params = base
        break
      case 'retrying':
        sql = `UPDATE task_notification_deliveries
                  SET status = 'retrying', next_attempt_at = $6, last_error = $7,
                      claim_expires_at = NULL, claim_worker_id = NULL, updated_at = $5
                ${held} RETURNING id`
        params = [...base, new Date(now.getTime() + computeTaskDeliveryBackoffMs(row.attemptCount)), lastError]
        break
      case 'failed':
        // Every `failed` row is a determinate non-delivery, so the DingTalk channel's rows may be
        // re-delivered (`outcome_unknown` rows stay `redelivery_safe = false`).
        sql = `UPDATE task_notification_deliveries
                  SET status = 'failed', last_error = $6, redelivery_safe = (channel = $7),
                      claim_expires_at = NULL, claim_worker_id = NULL, updated_at = $5
                ${held} RETURNING id`
        params = [...base, lastError, TASK_NOTIFICATION_CHANNEL_DINGTALK]
        break
      case 'skipped':
        sql = `UPDATE task_notification_deliveries
                  SET status = 'skipped', last_error = $6,
                      claim_expires_at = NULL, claim_worker_id = NULL, updated_at = $5
                ${held} RETURNING id`
        params = [...base, lastError]
        break
      case 'outcome_unknown':
        sql = `UPDATE task_notification_deliveries
                  SET status = 'outcome_unknown', last_error = $6,
                      claim_expires_at = NULL, claim_worker_id = NULL, updated_at = $5
                ${held} RETURNING id`
        params = [...base, lastError]
        break
    }
    const result = await this.query(sql, params)
    return result.rows.length === 1
  }

  // ── One row ────────────────────────────────────────────────────────────────────────────────────

  /** Classifies `result`, writes the terminal state and counts it; `lost-lease` when the write finds no row. */
  private async finish(row: ClaimedDelivery, result: unknown, fenced: boolean, fallbackCode: string): Promise<RowOutcome> {
    const outcome = classifyTaskDeliveryOutcome({ result, attemptCount: row.attemptCount, maxAttempts: this.maxAttempts, fenced })
    const lastError = outcome === 'sent' ? null : lastErrorOf(result, fallbackCode)
    if (!(await this.writeTerminal(row, outcome, lastError, fenced))) {
      this.logger.warn('task delivery lost its lease before the terminal write', { deliveryId: row.id, workerId: this.workerId })
      return 'lost-lease'
    }
    this.counter.inc({ outcome })
    return outcome
  }

  /**
   * Resolves with the first of: the stop signal aborting (`'stop'`), the row budget running out on
   * the timer (`'overrun'`), or the row settling (`null`). The listener and the timer are cleared
   * whichever comes first.
   */
  private firstInterrupt(delivery: Promise<unknown>, stopSignal: AbortSignal | undefined): Promise<'stop' | 'overrun' | null> {
    return new Promise((resolve) => {
      let done = false
      let handle: unknown
      const settle = (value: 'stop' | 'overrun' | null): void => {
        if (done) return
        done = true
        this.timers.clear(handle)
        stopSignal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => settle('stop')
      if (stopSignal?.aborted) {
        settle('stop')
        return
      }
      stopSignal?.addEventListener('abort', onAbort, { once: true })
      handle = this.timers.set(() => settle('overrun'), TASK_DELIVERY_ROW_BUDGET_MS)
      delivery.then(() => settle(null), () => settle(null))
    })
  }

  private overBudget(startedAtMs: number): boolean {
    return this.now().getTime() - startedAtMs > TASK_DELIVERY_ROW_BUDGET_MS
  }

  /** ASSUMPTION(task-m4): [own-3b-36] a row over its budget is not fenced; the attempt is spent. */
  private finishOverBudget(row: ClaimedDelivery): Promise<RowOutcome> {
    const code = TASK_DELIVERY_WORKER_ERROR_CODES.rowBudgetExceeded
    this.logger.warn('task delivery row over its budget before the fence', { deliveryId: row.id, code })
    return this.finish(row, { ok: false, retryable: true, error: code }, false, code)
  }

  /** One materialisation; a skip or a thrown read ends the row here, with its terminal write done. */
  private async materialiseStep(
    row: ClaimedDelivery,
    payload: TaskNotificationPayload,
  ): Promise<{ kind: 'send'; message: TaskDeliveryMessage } | { kind: 'ended'; outcome: RowOutcome }> {
    const codes = TASK_DELIVERY_WORKER_ERROR_CODES
    let material: Materialised
    try {
      material = await this.materialise(row, payload, this.now())
    } catch {
      this.logger.warn('task delivery materialisation threw', { deliveryId: row.id, code: codes.materializeFailed })
      return { kind: 'ended', outcome: await this.finish(row, { ok: false, retryable: true, error: codes.materializeFailed }, false, codes.materializeFailed) }
    }
    if (material.kind === 'skip') {
      return { kind: 'ended', outcome: await this.finish(row, { ok: false, retryable: false, skip: true, error: material.code }, false, material.code) }
    }
    return { kind: 'send', message: material.message }
  }

  /**
   * Design §7.2, §7.4: payload check → materialisation → prepare → materialisation → fence → send →
   * terminal write. `startedAtMs` is the instant the row was started, for the row budget.
   */
  private async deliver(row: ClaimedDelivery, stopping: () => boolean, startedAtMs: number): Promise<RowOutcome> {
    const codes = TASK_DELIVERY_WORKER_ERROR_CODES
    const parsed = parseTaskNotificationPayload(row.payload)
    if (parsed.ok === false) {
      return this.finish(row, { ok: false, retryable: false, error: parsed.reason }, false, parsed.reason)
    }
    if (!payloadMatchesRow(parsed.payload, row)) {
      return this.finish(row, { ok: false, retryable: false, error: codes.payloadMismatch }, false, codes.payloadMismatch)
    }
    const channel = this.channelsByName.get(row.channel)
    if (!channel) {
      return this.finish(row, { ok: false, retryable: false, error: codes.channelNotRegistered }, false, codes.channelNotRegistered)
    }

    // ASSUMPTION(task-m4): [own-3b-37] a row that is going to be skipped never calls the channel.
    const screened = await this.materialiseStep(row, parsed.payload)
    if (screened.kind === 'ended') return screened.outcome
    if (this.overBudget(startedAtMs)) return this.finishOverBudget(row)
    // Design §6.6: once stopping, no channel call starts; the row is handed back.
    if (stopping()) return 'released'

    let prepared: unknown
    try {
      prepared = await channel.prepare({ deliveryId: row.id, orgId: row.orgId, recipientUserId: row.recipientUserId })
    } catch {
      this.logger.warn('task delivery prepare threw', { deliveryId: row.id, code: codes.prepareFailed })
      return this.finish(row, { ok: false, retryable: true, error: codes.prepareFailed }, false, codes.prepareFailed)
    }
    if (!isPrepared(prepared)) {
      const result = isRecord(prepared) && prepared.ok === false ? prepared.result : undefined
      return this.finish(row, result, false, codes.prepareResultInvalid)
    }
    if (this.overBudget(startedAtMs)) return this.finishOverBudget(row)
    // Design §6.6: a stop that landed during `prepare` hands the row back before any further read.
    if (stopping()) return 'released'

    // ASSUMPTION(task-m4): [own-3b-37] the state is read again right before the fence.
    const fresh = await this.materialiseStep(row, parsed.payload)
    if (fresh.kind === 'ended') return fresh.outcome
    if (this.overBudget(startedAtMs)) return this.finishOverBudget(row)

    // Design §6.6: once stopping, no row passes the fence; this one is handed back.
    if (stopping()) return 'released'
    if (!(await this.fence(row, this.now()))) {
      this.logger.warn('task delivery lost its lease before the fence', { deliveryId: row.id, workerId: this.workerId })
      return 'lost-lease'
    }
    let sendResult: unknown
    try {
      sendResult = await prepared.send(fresh.message)
    } catch (error) {
      sendResult = error
    }
    return this.finish(row, sendResult, true, codes.sendUnclassified)
  }

  // ── Send-time materialisation (design §4.6, §7.4) ──────────────────────────────────────────────

  private async materialise(row: ClaimedDelivery, payload: TaskNotificationPayload, now: Date): Promise<Materialised> {
    const skip = (code: string): Materialised => ({ kind: 'skip', code })
    const codes = TASK_DELIVERY_SKIP_CODES
    const active = await findActiveOrgMembers(this.db, row.orgId, [row.recipientUserId])
    if (!active.has(row.recipientUserId)) return skip(codes.recipientInactiveInOrg)
    if ((payload.kind === 'task_event' || payload.kind === 'task_list_event') && isTaskEventNotificationStale(row.createdAt, now)) {
      return skip(codes.eventStale)
    }
    switch (payload.kind) {
      case 'task_event': {
        // A `deleted` event is about a task that is soft-deleted by now; every other event needs
        // the task to be live (ASSUMPTION(task-m4): [own-3b-05] [own-3b-17]).
        const cond = payload.event === 'deleted'
          ? buildTaskByIdAnyStateCondition({ taskIdParam: payload.taskId, orgParam: row.orgId })
          : buildTaskByIdCondition({ taskIdParam: payload.taskId, orgParam: row.orgId })
        const task = (await this.db.query(`SELECT tasks.title, tasks.created_by FROM tasks WHERE ${cond.sql}`, cond.params)).rows[0]
        if (!task) return skip(codes.taskMissing)
        const { roles } = await loadRowRoles(this.db, {
          taskId: payload.taskId,
          actorId: row.recipientUserId,
          createdBy: String(task.created_by),
        })
        if (!can(roles, 'view')) return skip(codes.recipientLostAccess)
        return { kind: 'send', message: renderTaskEventMessage({ event: payload.event, taskTitle: String(task.title), deliveryId: row.id }) }
      }
      case 'task_reminder': {
        const cond = buildTaskByIdCondition({ taskIdParam: payload.taskId, orgParam: row.orgId })
        const task = (await this.db.query(
          `SELECT tasks.title, tasks.status, tasks.created_by, tasks.deleted_at, tasks.remind_at,
                  tasks.due_date::text AS due_date, tasks.due_time::text AS due_time, tasks.time_zone
             FROM tasks WHERE ${cond.sql}`,
          cond.params,
        )).rows[0]
        if (!task) return skip(codes.reminderStale)
        const remindAt = new Date(payload.remindAt)
        const state = {
          status: task.status === 'open' ? 'open' as const : 'done' as const,
          deletedAt: toDateOrNull(task.deleted_at),
          remindAt: toDateOrNull(task.remind_at),
        }
        if (isReminderSkippedByTaskState(state, remindAt)) return skip(codes.reminderStale)
        const floorRow = (await this.db.query(
          `SELECT max(occurred_at) AS floor FROM task_events WHERE task_id = $1 AND event_type = ANY($2::text[])`,
          [payload.taskId, [...TASK_REMINDER_FLOOR_EVENT_TYPES]],
        )).rows[0]
        const floor = toDateOrNull(floorRow?.floor)
        // ASSUMPTION(task-m4): [own-3b-28] no floor ⇒ it cannot be shown that the reminder was
        // written before its moment, so it is not sent (the scan's rule, applied again).
        if (floor === null || !isTaskReminderDue(remindAt, now, floor)) return skip(codes.reminderWindowElapsed)
        const assignees = await loadAssignees(this.db, payload.taskId)
        if (!resolveReminderRecipients({ assignees, creatorId: String(task.created_by) }).includes(row.recipientUserId)) {
          return skip(codes.recipientLostAccess)
        }
        return {
          kind: 'send',
          message: renderTaskReminderMessage({
            taskTitle: String(task.title),
            dueDate: task.due_date === null || task.due_date === undefined ? null : String(task.due_date),
            dueTime: task.due_time === null || task.due_time === undefined ? null : String(task.due_time),
            timeZone: task.time_zone === null || task.time_zone === undefined ? null : String(task.time_zone),
            deliveryId: row.id,
          }),
        }
      }
      case 'task_daily': {
        const settings = await getTaskSettings({ orgId: row.orgId, actorId: row.recipientUserId })
        if (!settings.dailyReminderEnabled || settings.timeZone !== payload.timeZone) return skip(codes.digestSettingsChanged)
        const occurrence = resolveDailyDigestOccurrence(now, payload.timeZone)
        if (occurrence.localDate !== payload.date || !occurrence.due) return skip(codes.digestWindowElapsed)
        const cond = buildTaskDailyDigestCondition({
          actorParam: row.recipientUserId,
          orgParam: row.orgId,
          viewerTzParam: payload.timeZone,
        })
        const rows = (await this.db.query(
          `SELECT tasks.title, tasks.due_date::text AS due_date, tasks.due_time::text AS due_time, tasks.time_zone,
                  count(*) OVER () AS total
             FROM tasks WHERE ${cond.sql}
            ORDER BY tasks.due_at ASC NULLS LAST, tasks.due_date ASC, tasks.id ASC
            LIMIT $${cond.params.length + 1}`,
          [...cond.params, TASK_DIGEST_MAX_ITEMS + 1],
        )).rows
        // RULED(2026-10-07): [R07] nothing due ⇒ the day's one row ends `skipped`, nothing is sent.
        if (rows.length === 0) return skip(codes.emptyDigest)
        const items: TaskDigestItem[] = rows.map((item) => ({
          title: String(item.title),
          dueDate: String(item.due_date),
          dueTime: item.due_time === null || item.due_time === undefined ? null : String(item.due_time),
          timeZone: String(item.time_zone),
        }))
        return {
          kind: 'send',
          message: renderTaskDailyDigestMessage({ items, totalCount: Number(rows[0].total), deliveryId: row.id }),
        }
      }
      case 'task_list_event': {
        const cond = buildTaskListByIdCondition({ listIdParam: payload.listId, orgParam: row.orgId })
        const list = (await this.db.query(
          `SELECT task_lists.name, task_lists.created_by FROM task_lists WHERE ${cond.sql}`,
          cond.params,
        )).rows[0]
        if (!list) return skip(codes.listMissing)
        const recipients = resolveListArchiveNotificationRecipients({ listCreatorId: String(list.created_by), actorId: payload.actorId })
        if (!recipients.some((recipient) => recipient.userId === row.recipientUserId)) return skip(codes.recipientLostAccess)
        return { kind: 'send', message: renderTaskListEventMessage({ event: payload.event, listName: String(list.name), deliveryId: row.id }) }
      }
    }
  }
}
