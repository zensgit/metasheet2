/**
 * §7.6 Delivery Closure — OPERATOR-INITIATED redelivery of a FAILED attendance-notification outbox
 * row (real DB). Locks every owner-ratified doctrine guardrail as a falsifiable property.
 *
 * DOCTRINE UPDATE (PR #4102 owner CHANGES-REQUESTED): eligibility is NO LONGER the single
 * `status='failed'` predicate — that was CONTAMINATED (this is a MULTI-CHANNEL shared outbox; a
 * `failed` row can be a pre-#4046 ambiguous DingTalk send, or a WeCom/Email failure with no
 * outcome_unknown vocabulary — resending either risks a DUPLICATE notification). The gate is now
 * THREE predicates: `status='failed' AND channel='dingtalk_work_notification' AND
 * redelivery_safe=true`, where redelivery_safe is a boolean the worker's markFailed sets true IFF the
 * row is a DEFINITE (non-ambiguous) DingTalk non-delivery.
 *
 *   1. A DEFINITE DingTalk failure (failed + dingtalk + redelivery_safe=true) → requeued to `pending`
 *      (one operator-requested send).
 *   2. `sent` → no-op `already_delivered`: nothing written, nothing sent (dedup no-op on success).
 *   3. `outcome_unknown` → refused, row untouched: NEVER resent (may already have been delivered).
 *   4. skipped/pending/retrying, a historical DingTalk failure (redelivery_safe=false), and any
 *      WeCom/Email failure → `not_eligible`, untouched.
 *   5. source_key dedup BY CONSTRUCTION: the row is flipped in place, a redelivery NEVER inserts a
 *      second row for the same (org_id, source_key) destination.
 *   6. No auto/background path: the delivery worker's claim NEVER moves a `failed` row to `pending`;
 *      the only failed→pending transition is this explicit operator request.
 *
 * Mutation-replay (recorded in the PR body): reverting EACH of the three UPDATE predicates
 * individually turns a distinct test RED —
 *   - dropping `status='failed'`  → the status-predicate pin (synthetic pending+safe row) requeues.
 *   - dropping `channel='dingtalk_work_notification'` → the WeCom-safe pin requeues.
 *   - dropping `redelivery_safe=true` → the historical-DingTalk-failure pin requeues.
 * The DISCRIMINATOR test drives an ambiguous DingTalk send through the worker and proves it lands as
 * `outcome_unknown` (redelivery_safe=false) and is then REFUSED by redelivery — never requeued.
 * Making the requeue SET a no-op makes (1) RED.
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
  WECOM_WORK_NOTIFICATION_CHANNEL_NAME,
  type AttendanceDeliveryChannel,
  type AttendanceDeliveryChannelResult,
  type AttendanceDeliveryMessage,
  type AttendanceNotificationDeliveryQuery,
} from '../../src/services/AttendanceNotificationDeliveryWorker'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool!.query(sql, params)

const ORG = `org_redeliver_${Date.now()}`

type SeedStatus = 'failed' | 'sent' | 'outcome_unknown' | 'pending' | 'skipped' | 'retrying'

async function seed(
  status: SeedStatus,
  opts: { attemptCount?: number; channel?: string; sourceKey?: string; redeliverySafe?: boolean } = {},
): Promise<string> {
  const sourceKey = opts.sourceKey ?? `sk_${randomUUID()}`
  const channel = opts.channel ?? DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME
  const attemptCount = opts.attemptCount ?? (status === 'failed' ? 5 : 0)
  // redelivery_safe default mirrors what the worker's markFailed would persist: a DEFINITE DingTalk
  // failure carries redelivery_safe=true; every other row (non-dingtalk failure, or a non-failed
  // status that never went through the dingtalk-failed markFailed path) is false. Tests that need to
  // isolate a single UPDATE predicate override this explicitly (synthetic rows).
  const redeliverySafe = opts.redeliverySafe
    ?? (status === 'failed' && channel === DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
  // A failed row carries the residue of its exhausted attempts (claim fields + last_error + a past
  // next_attempt_at) — exactly what a requeue must clear.
  const deliveredAt = status === 'sent' ? 'NOW()' : 'NULL'
  const res = await q(
    `INSERT INTO attendance_notification_deliveries
       (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel,
        status, attempt_count, redelivery_safe, next_attempt_at, last_attempt_at, claimed_at, claim_expires_at,
        claim_worker_id, last_error, delivered_at, payload)
     VALUES
       ($1, 'test', NULL, $2, 'user_x', 'employee', $3,
        $4, $5, $6, NOW() - interval '1 hour', NOW() - interval '1 hour',
        ${status === 'failed' ? "NOW() - interval '1 hour'" : 'NULL'},
        ${status === 'failed' ? "NOW() - interval '30 minutes'" : 'NULL'},
        ${status === 'failed' ? "'stale-worker'" : 'NULL'},
        ${status === 'failed' ? "'boom: previous send failed'" : 'NULL'},
        ${deliveredAt}, '{}'::jsonb)
     RETURNING id::text AS id`,
    [ORG, sourceKey, channel, status, attemptCount, redeliverySafe],
  )
  return (res.rows[0] as { id: string }).id
}

async function readRow(id: string): Promise<{ status: string; attempt_count: number; redelivery_safe: boolean; last_error: string | null; claim_worker_id: string | null; updated_at: string } | null> {
  const res = await q(
    `SELECT status, attempt_count, redelivery_safe, last_error, claim_worker_id, updated_at::text AS updated_at
       FROM attendance_notification_deliveries WHERE id = $1::uuid`,
    [id],
  )
  return (res.rows[0] as { status: string; attempt_count: number; redelivery_safe: boolean; last_error: string | null; claim_worker_id: string | null; updated_at: string } | undefined) ?? null
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
    // The delivery worker's claim is DB-global (no org filter), so isolate: the ONLY row it could
    // see is this one failed row. If the worker had any failed→pending path, it would claim+send it.
    await q(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [ORG])
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
    // Same global-claim isolation: the only row the worker can see is this due pending row.
    await q(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [ORG])
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

  // ── PR #4102 owner CHANGES-REQUESTED — three-predicate safe-redelivery gate ──────────────────────

  it('positive: a DEFINITE DingTalk failure (failed + dingtalk + redelivery_safe=true) → requeued', async () => {
    const id = await seed('failed', { redeliverySafe: true })
    const before = await readRow(id)
    expect(before?.status).toBe('failed')
    expect(before?.redelivery_safe).toBe(true)

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('requeued')
    expect(result.status).toBe('pending')
    // Values-free audit metadata is carried out for the audit trail.
    expect(result.previousStatus).toBe('failed')
    expect(result.orgId).toBe(ORG)
    expect(result.channel).toBe(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)

    const after = await readRow(id)
    expect(after?.status).toBe('pending')
  })

  it('predicate pin (status=\'failed\'): a synthetic pending+dingtalk+safe row → not_eligible, untouched', async () => {
    // Only status differs from an eligible row (dingtalk + redelivery_safe=true). With the real gate
    // it is not_eligible; DROP the `status='failed'` predicate and it would requeue → this test RED.
    const id = await seed('pending', { redeliverySafe: true })
    const before = await readRow(id)

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('not_eligible')
    expect(result.status).toBe('pending')

    const after = await readRow(id)
    expect(after?.status).toBe('pending')
    expect(after?.updated_at).toBe(before?.updated_at)
  })

  it('predicate pin (channel=dingtalk): a synthetic WeCom failed+safe row → not_eligible, untouched', async () => {
    // Only channel differs from an eligible row (status=failed + redelivery_safe forced true — a
    // WeCom row would never really carry safe=true, this isolates the channel predicate). Real gate:
    // not_eligible; DROP the channel predicate and it would requeue → this test RED.
    const id = await seed('failed', { channel: WECOM_WORK_NOTIFICATION_CHANNEL_NAME, redeliverySafe: true })
    const before = await readRow(id)
    expect(before?.status).toBe('failed')

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('not_eligible')
    expect(result.channel).toBe(WECOM_WORK_NOTIFICATION_CHANNEL_NAME)

    const after = await readRow(id)
    expect(after?.status).toBe('failed')
    expect(after?.updated_at).toBe(before?.updated_at)
  })

  it('predicate pin (redelivery_safe=true): a historical DingTalk failed row (safe=false) → not_eligible, untouched', async () => {
    // A pre-#4046 / pre-flag DingTalk failure: failed + dingtalk, but redelivery_safe=false. It may
    // already have been delivered (ambiguous) — resending is the duplicate hazard the owner caught.
    // Real gate: not_eligible, NOTHING written; DROP the redelivery_safe predicate and it would
    // requeue → this test RED.
    const id = await seed('failed', { redeliverySafe: false })
    const before = await readRow(id)
    expect(before?.status).toBe('failed')
    expect(before?.redelivery_safe).toBe(false)

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('not_eligible')

    const after = await readRow(id)
    expect(after?.status).toBe('failed')
    expect(after?.redelivery_safe).toBe(false)
    expect(after?.updated_at).toBe(before?.updated_at)
  })

  it('a natural WeCom failure (redelivery_safe=false by default) → not_eligible', async () => {
    // WeCom/Email transports emit no outcome_unknown marker, so a WeCom `failed` row can be an
    // ambiguous send — it is never redelivery-eligible.
    const id = await seed('failed', { channel: WECOM_WORK_NOTIFICATION_CHANNEL_NAME })
    const before = await readRow(id)
    expect(before?.redelivery_safe).toBe(false)

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('not_eligible')

    const after = await readRow(id)
    expect(after?.status).toBe('failed')
    expect(after?.updated_at).toBe(before?.updated_at)
  })

  it('DISCRIMINATOR: an ambiguous DingTalk send → worker marks outcome_unknown (safe=false) → redelivery REFUSES it', async () => {
    // Drive a genuine ambiguous DingTalk result through the worker via a fake channel returning
    // {ok:false, retryable:false, outcomeUnknown:true}. The deliver() invariant must route it to
    // markOutcomeUnknown (NOT markFailed), so the row lands `outcome_unknown` with redelivery_safe
    // still false — and redelivery then refuses it. This proves ambiguous results are never
    // redelivery-eligible (the owner's crux).
    await q(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [ORG])
    const id = await seed('pending', { sourceKey: `sk_ambiguous_${randomUUID()}` })
    const channel = new OutcomeUnknownChannel()
    const worker = new AttendanceNotificationDeliveryWorker({
      query: q as unknown as AttendanceNotificationDeliveryQuery,
      channels: [channel],
      quietHours: null,
      maxAttempts: 1,
      workerId: `test-worker-${randomUUID()}`,
    })

    const outcome = await worker.runBatch()
    expect(channel.calls).toBe(1)
    expect(outcome.outcomeUnknown).toBe(1)

    // The worker classified the ambiguous send as outcome_unknown, NOT failed, and did NOT flip the
    // redelivery-safe flag (only markFailed on a DingTalk row does).
    const marked = await readRow(id)
    expect(marked?.status).toBe('outcome_unknown')
    expect(marked?.redelivery_safe).toBe(false)

    // Redelivery refuses it — never requeued.
    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('refused_outcome_unknown')
    expect(result.status).toBe('outcome_unknown')
    const after = await readRow(id)
    expect(after?.status).toBe('outcome_unknown')
  })

  it('markFailed WRITE: a DEFINITE DingTalk failure → worker sets redelivery_safe=true → redelivery requeues it', async () => {
    // End-to-end proof that markFailed's `redelivery_safe = (channel = dingtalk)` write is real: seed
    // a due pending DingTalk row (redelivery_safe defaults false for a non-failed row), drive a
    // DEFINITE non-retryable failure through the worker, and assert the resulting failed row carries
    // redelivery_safe=true — then redelivery accepts it. Breaking the markFailed write turns this RED.
    await q(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [ORG])
    const id = await seed('pending', { redeliverySafe: false, sourceKey: `sk_markfailed_dt_${randomUUID()}` })
    const channel = new DefiniteFailureChannel(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
    const worker = new AttendanceNotificationDeliveryWorker({
      query: q as unknown as AttendanceNotificationDeliveryQuery,
      channels: [channel],
      quietHours: null,
      maxAttempts: 1,
      workerId: `test-worker-${randomUUID()}`,
    })

    const outcome = await worker.runBatch()
    expect(channel.calls).toBe(1)
    expect(outcome.failed).toBe(1)

    const marked = await readRow(id)
    expect(marked?.status).toBe('failed')
    expect(marked?.redelivery_safe).toBe(true)

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('requeued')
  })

  it('markFailed WRITE: a DEFINITE WeCom failure → worker leaves redelivery_safe=false → redelivery refuses it', async () => {
    // The channel-conditional write: a definite WeCom non-delivery is `failed` but NOT redelivery-safe
    // (WeCom has no outcome_unknown vocabulary, so its failures may be ambiguous). Mutating the
    // markFailed write to an unconditional `true` would turn this RED.
    await q(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [ORG])
    const id = await seed('pending', { channel: WECOM_WORK_NOTIFICATION_CHANNEL_NAME, sourceKey: `sk_markfailed_wecom_${randomUUID()}` })
    const channel = new DefiniteFailureChannel(WECOM_WORK_NOTIFICATION_CHANNEL_NAME)
    const worker = new AttendanceNotificationDeliveryWorker({
      query: q as unknown as AttendanceNotificationDeliveryQuery,
      channels: [channel],
      quietHours: null,
      maxAttempts: 1,
      workerId: `test-worker-${randomUUID()}`,
    })

    const outcome = await worker.runBatch()
    expect(channel.calls).toBe(1)
    expect(outcome.failed).toBe(1)

    const marked = await readRow(id)
    expect(marked?.status).toBe('failed')
    expect(marked?.redelivery_safe).toBe(false)

    const result = await redeliverFailedAttendanceNotification(q, id)
    expect(result.outcome).toBe('not_eligible')
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

// A DingTalk channel whose send() is AMBIGUOUS: attempted, outcome unknowable (network/timeout/5xx/
// malformed 2xx). retryable:false + outcomeUnknown:true is exactly what classifyDingTalkSendError
// emits for an isDingTalkOutcomeUnknown error, and the deliver() invariant must route it to
// markOutcomeUnknown — never markFailed — so redelivery_safe stays false.
class OutcomeUnknownChannel implements AttendanceDeliveryChannel {
  readonly name = DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME
  calls = 0
  async send(_message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    this.calls += 1
    return { ok: false, retryable: false, outcomeUnknown: true, error: 'dingtalk_send_outcome_unknown: fake ambiguous send' }
  }
}

// A channel (name configurable) whose send() is a DEFINITE, non-retryable, non-ambiguous failure —
// the classification that reaches markFailed. Used to prove markFailed's channel-conditional
// redelivery_safe write end-to-end.
class DefiniteFailureChannel implements AttendanceDeliveryChannel {
  calls = 0
  constructor(readonly name: string) {}
  async send(_message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    this.calls += 1
    return { ok: false, retryable: false, error: 'definite_non_delivery' }
  }
}
