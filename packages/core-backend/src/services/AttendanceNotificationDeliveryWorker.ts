import { randomBytes } from 'crypto'
import { query as defaultQuery } from '../db/pg'
import { Logger } from '../core/logger'

/**
 * C5-2 delivery worker.
 *
 * Consumes `attendance_notification_deliveries` outbox rows, claims due rows with a short lease, sends
 * each row through its named channel, and writes per-delivery status. This worker is the first component
 * allowed to turn C5 outbox rows into sends; source producers must only insert rows.
 */

export type AttendanceNotificationDeliveryQuery = <T = unknown>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>

export interface AttendanceDeliveryMessage {
  id: string
  orgId: string
  sourceType: string
  sourceId: string | null
  sourceKey: string
  recipientUserId: string
  recipientRole: string
  channel: string
  payload: Record<string, unknown>
}

export type AttendanceDeliveryChannelResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string }

export interface AttendanceDeliveryChannel {
  readonly name: string
  send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult>
}

export interface AttendanceNotificationDeliveryWorkerOptions {
  query?: AttendanceNotificationDeliveryQuery
  channels?: AttendanceDeliveryChannel[]
  batchSize?: number
  leaseMs?: number
  maxAttempts?: number
  workerId?: string
  now?: () => Date
  logger?: Logger
}

export interface AttendanceNotificationDeliveryResult {
  claimed: number
  sent: number
  retrying: number
  failed: number
  lostLease?: number
}

interface DeliveryRow {
  id: string
  org_id: string
  source_type: string
  source_id: string | null
  source_key: string
  recipient_user_id: string
  recipient_role: string
  channel: string
  attempt_count: number | string
  payload: unknown
}

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 5
const MIN_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 200
const MIN_LEASE_MS = 5_000
const MAX_LEASE_MS = 10 * 60_000
const FAKE_CHANNEL_NAME = 'dingtalk_work_notification'

export function clampDeliveryBatchSize(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.floor(n)))
}

export function clampDeliveryLeaseMs(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LEASE_MS
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.floor(n)))
}

export function computeDeliveryBackoffMs(attemptCount: number): number {
  if (attemptCount <= 1) return 60_000
  if (attemptCount === 2) return 5 * 60_000
  if (attemptCount === 3) return 15 * 60_000
  if (attemptCount === 4) return 60 * 60_000
  return 6 * 60 * 60_000
}

export class DeterministicFakeAttendanceDeliveryChannel implements AttendanceDeliveryChannel {
  readonly name = FAKE_CHANNEL_NAME

  async send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    const mode = String(message.payload.fakeDelivery ?? message.payload.deliveryMode ?? 'ok')
    if (mode === 'retry' || mode === 'retryable_failure') {
      return { ok: false, retryable: true, error: 'fake_retryable_failure' }
    }
    if (mode === 'fail' || mode === 'non_retryable_failure') {
      return { ok: false, retryable: false, error: 'fake_non_retryable_failure' }
    }
    return { ok: true }
  }
}

export function createAttendanceDeliveryChannelsFromEnv(env: NodeJS.ProcessEnv = process.env): AttendanceDeliveryChannel[] {
  if (env.ATTENDANCE_NOTIFICATION_FAKE_CHANNEL_ENABLED !== 'true') return []
  return [new DeterministicFakeAttendanceDeliveryChannel()]
}

export class AttendanceNotificationDeliveryWorker {
  private readonly query: AttendanceNotificationDeliveryQuery
  private readonly channelsByName: Map<string, AttendanceDeliveryChannel>
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly maxAttempts: number
  private readonly workerId: string
  private readonly now: () => Date
  private readonly logger: Logger
  private running = false

  constructor(options: AttendanceNotificationDeliveryWorkerOptions = {}) {
    this.query = options.query ?? (defaultQuery as AttendanceNotificationDeliveryQuery)
    this.channelsByName = new Map((options.channels ?? []).map((channel) => [channel.name, channel]))
    this.batchSize = clampDeliveryBatchSize(options.batchSize)
    this.leaseMs = clampDeliveryLeaseMs(options.leaseMs)
    this.maxAttempts = Number.isFinite(Number(options.maxAttempts)) && Number(options.maxAttempts) > 0
      ? Math.floor(Number(options.maxAttempts))
      : DEFAULT_MAX_ATTEMPTS
    this.workerId = options.workerId ?? `attendance-delivery:${process.pid}:${randomBytes(4).toString('hex')}`
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? new Logger('AttendanceNotificationDeliveryWorker')
  }

  async claimDueDeliveries(): Promise<DeliveryRow[]> {
    const asOf = this.now().toISOString()
    const { rows } = await this.query<DeliveryRow>(
      `WITH claim AS (
         SELECT id
           FROM attendance_notification_deliveries
          WHERE (
                  status IN ('pending','retrying')
              AND next_attempt_at <= $1::timestamptz
            )
             OR (
                  status = 'sending'
              AND claim_expires_at <= $1::timestamptz
            )
          ORDER BY COALESCE(next_attempt_at, claim_expires_at) ASC, created_at ASC
          LIMIT $2::int
          FOR UPDATE SKIP LOCKED
       ),
       claimed AS (
         UPDATE attendance_notification_deliveries d
            SET status = 'sending',
                attempt_count = attempt_count + 1,
                last_attempt_at = $1::timestamptz,
                claimed_at = $1::timestamptz,
                claim_expires_at = $1::timestamptz + ($3::int * interval '1 millisecond'),
                claim_worker_id = $4,
                updated_at = $1::timestamptz
           FROM claim
          WHERE d.id = claim.id
          RETURNING d.id::text AS id,
                    d.org_id,
                    d.source_type,
                    d.source_id,
                    d.source_key,
                    d.recipient_user_id,
                    d.recipient_role,
                    d.channel,
                    d.attempt_count,
                    d.payload
       )
       SELECT *
         FROM claimed
        ORDER BY id`,
      [asOf, this.batchSize, this.leaseMs, this.workerId],
    )
    return rows
  }

  async runBatch(): Promise<AttendanceNotificationDeliveryResult> {
    if (this.running) return { claimed: 0, sent: 0, retrying: 0, failed: 0 }
    this.running = true
    const result: AttendanceNotificationDeliveryResult = { claimed: 0, sent: 0, retrying: 0, failed: 0 }
    try {
      const rows = await this.claimDueDeliveries()
      result.claimed = rows.length
      let lostLease = 0
      for (const row of rows) {
        const outcome = await this.deliver(row)
        if (outcome === 'sent') result.sent += 1
        else if (outcome === 'retrying') result.retrying += 1
        else if (outcome === 'failed') result.failed += 1
        else lostLease += 1
      }
      if (lostLease > 0) {
        result.lostLease = lostLease
      }
      if (result.claimed > 0) {
        this.logger.info(`Attendance deliveries claimed=${result.claimed} sent=${result.sent} retrying=${result.retrying} failed=${result.failed} lostLease=${lostLease}`)
      }
      return result
    } finally {
      this.running = false
    }
  }

  private async deliver(row: DeliveryRow): Promise<'sent' | 'retrying' | 'failed' | 'lost-lease'> {
    const channel = this.channelsByName.get(row.channel)
    const attemptCount = Number(row.attempt_count)
    if (!channel) {
      return await this.markFailed(row.id, 'attendance_delivery_channel_not_configured', attemptCount)
        ? 'failed'
        : 'lost-lease'
    }

    const message: AttendanceDeliveryMessage = {
      id: row.id,
      orgId: row.org_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceKey: row.source_key,
      recipientUserId: row.recipient_user_id,
      recipientRole: row.recipient_role,
      channel: row.channel,
      payload: parsePayload(row.payload),
    }

    let channelResult: AttendanceDeliveryChannelResult
    try {
      channelResult = await channel.send(message)
    } catch (error) {
      channelResult = { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) }
    }

    if (channelResult.ok) {
      return await this.markSent(row.id, attemptCount) ? 'sent' : 'lost-lease'
    }

    const failure = channelResult as Extract<AttendanceDeliveryChannelResult, { ok: false }>
    if (!failure.retryable || attemptCount >= this.maxAttempts) {
      return await this.markFailed(row.id, failure.error, attemptCount) ? 'failed' : 'lost-lease'
    }

    return await this.markRetrying(row.id, failure.error, attemptCount) ? 'retrying' : 'lost-lease'
  }

  private async markSent(id: string, attemptCount: number): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'sent',
              delivered_at = $2::timestamptz,
              last_error = NULL,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $2::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $3
          AND attempt_count = $4::int`,
      [id, now, this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  private async markRetrying(id: string, error: string, attemptCount: number): Promise<boolean> {
    const now = this.now()
    const next = new Date(now.getTime() + computeDeliveryBackoffMs(attemptCount)).toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'retrying',
              next_attempt_at = $2::timestamptz,
              last_error = $3,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $4::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $5
          AND attempt_count = $6::int`,
      [id, next, error.slice(0, 1000), now.toISOString(), this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  private async markFailed(id: string, error: string, attemptCount: number): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'failed',
              last_error = $2,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $3::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $4
          AND attempt_count = $5::int`,
      [id, error.slice(0, 1000), now, this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  return value as Record<string, unknown>
}
