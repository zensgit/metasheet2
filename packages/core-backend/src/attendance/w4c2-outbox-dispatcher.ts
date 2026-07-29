/**
 * W4C-2 (#4556) — durable outbox dispatcher (lock 7.1a / 12.3).
 *
 * W4C-0 delivered the transactional outbox (`attendance_result_event_outbox`:
 * rows are inserted BEFORE operation seal in the same source transaction, with
 * immutable identity/payload and a one-way pending -> delivered state machine
 * enforced by DB triggers). This module is the delivery side: an idempotent,
 * restart-safe, concurrency-safe drain that emits each pending row through the
 * injected event sink and marks it delivered.
 *
 * Contract (lock 12.3): "crash after commit/before emit, dispatcher restart,
 * concurrent dispatcher, and emit failure eventually deliver without repeating
 * source/result DML."
 *
 *  - The dispatcher performs DML on the outbox table ONLY — never on
 *    operation/source/calculation/projection rows, so a redelivery can never
 *    repeat business DML.
 *  - Rows are claimed with `FOR UPDATE SKIP LOCKED`, so two concurrent
 *    dispatchers partition the pending set instead of double-emitting or
 *    deadlocking; the one-way DB state machine is the final backstop.
 *  - Emit happens inside the claiming transaction, then the row flips to
 *    `delivered` before commit. A crash between emit and commit re-delivers
 *    later (at-least-once notification), which is the lock's stated posture:
 *    notifications may repeat, source/result DML may not.
 *  - A failing sink increments `attempts` and schedules `next_attempt_at`
 *    with bounded linear backoff; the row stays `pending` and a later run
 *    (same process or a restarted one) retries it. Errors are contained per
 *    row — one poisoned row cannot stall the drain.
 *
 * Zero-caller posture note: production wiring is gated exactly like the
 * posture seam — with no org in a W4 posture there are never outbox rows and
 * the dispatcher is idle. This module holds no timer; scheduling is the
 * caller's concern.
 */
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'

export class AttendanceW4OutboxDispatchError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4OutboxDispatchError'
    this.code = code
  }
}

/** Values-free view of one outbox row handed to the sink. */
export interface AttendanceOutboxDeliveryV1 {
  readonly eventKind: string
  readonly payload: unknown
  readonly payloadSchemaVersion: number
}

export interface AttendanceOutboxDispatchOptionsV1 {
  /**
   * Event sink. Throwing marks the row for retry (attempts+1, backoff);
   * returning normally marks it delivered.
   */
  readonly emit: (delivery: AttendanceOutboxDeliveryV1) => void | Promise<void>
  /** Max rows drained per call (positive integer; default 100). */
  readonly batchLimit?: number
  /** Base retry backoff in ms (linear: attempts * base; default 30000). */
  readonly retryBackoffMs?: number
}

export interface AttendanceOutboxDispatchResultV1 {
  readonly claimed: number
  readonly delivered: number
  readonly failed: number
}

interface OutboxRow {
  id: string
  event_kind: string
  payload: unknown
  payload_schema_version: number
  attempts: number
}

/**
 * Drain one batch of due pending rows on the given connection. The connection
 * must be a dedicated session (the claim uses a transaction with row locks).
 * Safe to call from any number of processes concurrently.
 */
export async function dispatchAttendanceResultEventOutboxV1(
  connection: AttendanceW4TransactionClientV1,
  options: AttendanceOutboxDispatchOptionsV1,
): Promise<AttendanceOutboxDispatchResultV1> {
  if (typeof options?.emit !== 'function') {
    throw new AttendanceW4OutboxDispatchError('W4C2_OUTBOX_SINK_REQUIRED')
  }
  const batchLimit = options.batchLimit ?? 100
  if (!Number.isInteger(batchLimit) || batchLimit < 1) {
    throw new AttendanceW4OutboxDispatchError('W4C2_OUTBOX_BATCH_LIMIT_INVALID')
  }
  const retryBackoffMs = options.retryBackoffMs ?? 30_000
  if (!Number.isInteger(retryBackoffMs) || retryBackoffMs < 0) {
    throw new AttendanceW4OutboxDispatchError('W4C2_OUTBOX_BACKOFF_INVALID')
  }

  let claimed = 0
  let delivered = 0
  let failed = 0

  await connection.query('BEGIN', [])
  try {
    // Claim due pending rows; SKIP LOCKED partitions the set between
    // concurrent dispatchers (no double-claim, no lock wait).
    const rows = (await connection.query(
      `SELECT id::text AS id, event_kind, payload, payload_schema_version, attempts
         FROM attendance_result_event_outbox
        WHERE delivery_state = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchLimit}`,
      [],
    )).rows as unknown as OutboxRow[]
    claimed = rows.length

    for (const row of rows) {
      let ok = false
      try {
        await options.emit({
          eventKind: String(row.event_kind),
          payload: row.payload,
          payloadSchemaVersion: Number(row.payload_schema_version),
        })
        ok = true
      } catch {
        // Contained per row: the sink failure schedules a retry, it never
        // aborts the batch or surfaces sink internals.
        ok = false
      }
      if (ok) {
        await connection.query(
          `UPDATE attendance_result_event_outbox
              SET delivery_state = 'delivered',
                  delivered_at = now(),
                  attempts = attempts + 1
            WHERE id = $1::uuid AND delivery_state = 'pending'`,
          [row.id],
        )
        delivered += 1
      } else {
        await connection.query(
          `UPDATE attendance_result_event_outbox
              SET attempts = attempts + 1,
                  next_attempt_at = now() + make_interval(secs => $2::double precision)
            WHERE id = $1::uuid AND delivery_state = 'pending'`,
          [row.id, ((row.attempts + 1) * retryBackoffMs) / 1000],
        )
        failed += 1
      }
    }
    await connection.query('COMMIT', [])
  } catch (error) {
    await connection.query('ROLLBACK', []).catch(() => undefined)
    throw error
  }

  return { claimed, delivered, failed }
}
