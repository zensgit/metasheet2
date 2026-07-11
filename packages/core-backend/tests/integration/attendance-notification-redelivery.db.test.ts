/**
 * §7.6 Delivery Closure — OPERATOR-INITIATED redelivery of a FAILED attendance-notification outbox
 * row (real DB). Locks every owner-ratified doctrine guardrail as a falsifiable property:
 *
 *   1. Eligibility is STRICTLY `status='failed'` → requeued to `pending` (one operator-requested send).
 *   2. `sent` → no-op `already_delivered`: nothing written, nothing sent (dedup no-op on success).
 *   3. `outcome_unknown` → refused, row untouched: NEVER resent (may already have been delivered).
 *   4. skipped/pending/retrying → `not_eligible`, untouched.
 *   5. source_key dedup BY CONSTRUCTION: the row is flipped in place, a redelivery NEVER inserts a
 *      second row for the same (org_id, source_key) destination.
 *   6. No auto/background path: the delivery worker's claim NEVER moves a `failed` row to `pending`;
 *      the only failed→pending transition is this explicit operator request.
 *
 * Mutation-replay (recorded in the PR body): weakening the `AND status='failed'` gate makes (2)/(3)
 * RED; making the requeue SET a no-op makes (1) RED.
 */
import { randomUUID } from 'crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../src/db/pg'
import {
  redeliverFailedAttendanceNotification,
} from '../../src/services/AttendanceNotificationRedelivery'
import {
  AttendanceNotificationDeliveryWorker,
  DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME,
  type AttendanceDeliveryChannel,
  type AttendanceDeliveryChannelResult,
  type AttendanceNotificationDeliveryQuery,
} from '../../src/services/AttendanceNotificationDeliveryWorker'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool!.query(sql, params)

const ORG = `org_redeliver_${Date.now()}`

type SeedStatus = 'failed' | 'sent' | 'outcome_unknown' | 'pending' | 'skipped' | 'retrying'

async function seed(status: SeedStatus, opts: { attemptCount?: number; channel?: string; sourceKey?: string } = {}): Promise<string> {
  const sourceKey = opts.sourceKey ?? `sk_${randomUUID()}`
  const channel = opts.channel ?? DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME
  const attemptCount = opts.attemptCount ?? (status === 'failed' ? 5 : 0)
  // A failed row carries the residue of its exhausted attempts (claim fields + last_error + a past
  // next_attempt_at) — exactly what a requeue must clear.
  const deliveredAt = status === 'sent' ? 'NOW()' : 'NULL'
  const res = await q(
    `INSERT INTO attendance_notification_deliveries
       (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel,
        status, attempt_count, next_attempt_at, last_attempt_at, claimed_at, claim_expires_at,
        claim_worker_id, last_error, delivered_at, payload)
     VALUES
       ($1, 'test', NULL, $2, 'user_x', 'employee', $3,
        $4, $5, NOW() - interval '1 hour', NOW() - interval '1 hour',
        ${status === 'failed' ? "NOW() - interval '1 hour'" : 'NULL'},
        ${status === 'failed' ? "NOW() - interval '30 minutes'" : 'NULL'},
        ${status === 'failed' ? "'stale-worker'" : 'NULL'},
        ${status === 'failed' ? "'boom: previous send failed'" : 'NULL'},
        ${deliveredAt}, '{}'::jsonb)
     RETURNING id::text AS id`,
    [ORG, sourceKey, channel, status, attemptCount],
  )
  return (res.rows[0] as { id: string }).id
}

async function readRow(id: string): Promise<{ status: string; attempt_count: number; last_error: string | null; claim_worker_id: string | null; updated_at: string } | null> {
  const res = await q(
    `SELECT status, attempt_count, last_error, claim_worker_id, updated_at::text AS updated_at
       FROM attendance_notification_deliveries WHERE id = $1::uuid`,
    [id],
  )
  return (res.rows[0] as { status: string; attempt_count: number; last_error: string | null; claim_worker_id: string | null; updated_at: string } | undefined) ?? null
}

describeIfDb('§7.6 — attendance notification redelivery (operator-initiated, real DB)', () => {
  afterAll(async () => {
    await q(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [ORG]).catch(() => {})
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('(1) failed → requeued: status flips to pending, attempt_count reset, claim/last_error cleared', async () => {
    const id = await seed('failed', { attemptCount: 5 })
    const before = await readRow(id)
    expect(before?.status).toBe('failed')
    expect(before?.attempt_count).toBe(5)
    expect(before?.claim_worker_id).toBe('stale-worker')

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('requeued')
    expect(result.status).toBe('pending')

    const after = await readRow(id)
    expect(after?.status).toBe('pending')
    expect(after?.attempt_count).toBe(0)
    expect(after?.last_error).toBeNull()
    expect(after?.claim_worker_id).toBeNull()
    // next_attempt_at is now-ish → the worker will claim it. Assert it is no longer in the far past.
    const due = await q(
      `SELECT (next_attempt_at <= NOW()) AS due, (next_attempt_at > NOW() - interval '5 minutes') AS fresh
         FROM attendance_notification_deliveries WHERE id = $1::uuid`,
      [id],
    )
    expect((due.rows[0] as { due: boolean }).due).toBe(true)
    expect((due.rows[0] as { fresh: boolean }).fresh).toBe(true)
  })

  it('(2) sent → already_delivered: NO-OP, row untouched, nothing sent (dedup no-op on success)', async () => {
    const id = await seed('sent')
    const before = await readRow(id)
    expect(before?.status).toBe('sent')

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('already_delivered')
    expect(result.status).toBe('sent')

    const after = await readRow(id)
    expect(after?.status).toBe('sent')
    // No write happened at all: updated_at is byte-for-byte identical.
    expect(after?.updated_at).toBe(before?.updated_at)
  })

  it('(3) outcome_unknown → refused, NEVER resent, row untouched', async () => {
    const id = await seed('outcome_unknown', { attemptCount: 2 })
    const before = await readRow(id)
    expect(before?.status).toBe('outcome_unknown')

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('refused_outcome_unknown')
    expect(result.status).toBe('outcome_unknown')

    const after = await readRow(id)
    expect(after?.status).toBe('outcome_unknown')
    expect(after?.attempt_count).toBe(2)
    expect(after?.updated_at).toBe(before?.updated_at)
  })

  it('(4) skipped / pending / retrying → not_eligible, untouched', async () => {
    for (const status of ['skipped', 'pending', 'retrying'] as const) {
      const id = await seed(status)
      const before = await readRow(id)
      const result = await redeliverFailedAttendanceNotification(q, id)
      expect(result.outcome).toBe('not_eligible')
      expect(result.status).toBe(status)
      const after = await readRow(id)
      expect(after?.status).toBe(status)
      expect(after?.updated_at).toBe(before?.updated_at)
    }
  })

  it('not_found: unknown id → not_found (no write)', async () => {
    const result = await redeliverFailedAttendanceNotification(q, randomUUID())
    expect(result.outcome).toBe('not_found')
    expect(result.status).toBeNull()
  })

  it('(5) source_key dedup BY CONSTRUCTION: redelivery flips the row in place, never inserts a second row', async () => {
    const sourceKey = `sk_dedup_${randomUUID()}`
    const id = await seed('failed', { sourceKey })
    const countBefore = await q(
      `SELECT COUNT(*)::int AS c FROM attendance_notification_deliveries WHERE org_id = $1 AND source_key = $2`,
      [ORG, sourceKey],
    )
    expect((countBefore.rows[0] as { c: number }).c).toBe(1)

    await redeliverFailedAttendanceNotification(q, id)

    const countAfter = await q(
      `SELECT COUNT(*)::int AS c FROM attendance_notification_deliveries WHERE org_id = $1 AND source_key = $2`,
      [ORG, sourceKey],
    )
    // Still exactly one row for this (org_id, source_key) destination — no duplicate send row.
    expect((countAfter.rows[0] as { c: number }).c).toBe(1)
    const after = await readRow(id)
    expect(after?.status).toBe('pending')
  })

  it('(6) no auto/background path: worker runBatch NEVER requeues or sends a failed row', async () => {
    const failedId = await seed('failed', { sourceKey: `sk_worker_failed_${randomUUID()}` })
    const channel = new RecordingChannel()
    const worker = new AttendanceNotificationDeliveryWorker({
      query: q as unknown as AttendanceNotificationDeliveryQuery,
      channels: [channel],
      quietHours: null,
      workerId: `test-worker-${randomUUID()}`,
    })

    const outcome = await worker.runBatch()

    // The failed row was never claimed, never sent, never moved off `failed`.
    expect(channel.calls).toBe(0)
    const after = await readRow(failedId)
    expect(after?.status).toBe('failed')
    expect(outcome.claimed).toBe(0)
  })

  it('(6-control) worker liveness: the SAME worker DOES claim+send a pending row (so (6) is not vacuous)', async () => {
    const pendingId = await seed('pending', { sourceKey: `sk_worker_pending_${randomUUID()}` })
    const channel = new RecordingChannel()
    const worker = new AttendanceNotificationDeliveryWorker({
      query: q as unknown as AttendanceNotificationDeliveryQuery,
      channels: [channel],
      quietHours: null,
      workerId: `test-worker-${randomUUID()}`,
    })

    await worker.runBatch()

    // The worker is live: a due `pending` row IS claimed and sent — proving (6)'s failed-skip is a
    // real eligibility fence, not an inert worker.
    expect(channel.calls).toBe(1)
    const after = await readRow(pendingId)
    expect(after?.status).toBe('sent')
  })
})

class RecordingChannel implements AttendanceDeliveryChannel {
  readonly name = DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME
  calls = 0
  async send(): Promise<AttendanceDeliveryChannelResult> {
    this.calls += 1
    return { ok: true }
  }
}
