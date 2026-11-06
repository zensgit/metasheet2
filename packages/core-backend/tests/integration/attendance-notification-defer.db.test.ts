/**
 * Delivery worker: deferred channel results and lease headroom (real PostgreSQL).
 *
 * Invariants:
 *   1. A deferred result returns the row to `pending` with `next_attempt_at = now + clamp(deferMs)`,
 *      gives back the attempt the claim took, and clears the claim.
 *   2. The write is a compare-and-set on status 'sending' + claim worker + attempt count: a worker
 *      that lost its lease writes nothing.
 *   3. A row still deferred more than two hours after creation ends as `skipped` (`<error>_expired`).
 *   4. A channel that declares `maxSendDurationMs` is not sent to once less than that remains of the
 *      batch lease; the row is deferred instead, so a re-claimed row is never sent a second time by the
 *      slow batch.
 *   5. Other results (retryable, permanent, skip, unknown outcome) and channels that declare nothing
 *      behave as before.
 *
 * The worker's claim is not scoped to an organisation, so every case clears this file's rows first and
 * uses a channel name no other suite writes.
 */
import { randomUUID } from 'crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { pool } from '../../src/db/pg'
import {
  AttendanceNotificationDeliveryWorker,
  type AttendanceDeliveryChannel,
  type AttendanceDeliveryChannelResult,
  type AttendanceDeliveryMessage,
  type AttendanceNotificationDeliveryQuery,
} from '../../src/services/AttendanceNotificationDeliveryWorker'

const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('sentinel: a database-expected run has DATABASE_URL', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool!.query(sql, params)
const query = q as unknown as AttendanceNotificationDeliveryQuery

const ORG = `org_defer_${Date.now()}`
const CHANNEL = `defer_test_${Date.now()}`
const MINUTE = 60_000

interface Row {
  status: string
  attempt_count: number
  claim_worker_id: string | null
  claim_expires_at: string | null
  last_error: string | null
  next_attempt_at: Date
}

async function clearRows() {
  await q(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [ORG])
}

async function seed(opts: { attemptCount?: number; createdAgoMs?: number } = {}): Promise<string> {
  const res = await q(
    `INSERT INTO attendance_notification_deliveries
       (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel,
        status, attempt_count, next_attempt_at, created_at, payload)
     VALUES
       ($1, 'test', NULL, $2, 'user_x', 'employee', $3,
        'pending', $4, NOW() - interval '1 minute', NOW() - ($5::int * interval '1 millisecond'), '{}'::jsonb)
     RETURNING id::text AS id`,
    [ORG, `sk_${randomUUID()}`, CHANNEL, opts.attemptCount ?? 0, opts.createdAgoMs ?? MINUTE],
  )
  return (res.rows[0] as { id: string }).id
}

async function readRow(id: string): Promise<Row> {
  const res = await q(
    `SELECT status, attempt_count, claim_worker_id, claim_expires_at::text AS claim_expires_at,
            last_error, next_attempt_at
       FROM attendance_notification_deliveries WHERE id = $1::uuid`,
    [id],
  )
  return res.rows[0] as Row
}

function makeChannel(
  respond: (message: AttendanceDeliveryMessage, calls: string[]) => Promise<AttendanceDeliveryChannelResult>,
  extra: Partial<AttendanceDeliveryChannel> = {},
) {
  const calls: string[] = []
  const channel: AttendanceDeliveryChannel = {
    name: CHANNEL,
    async send(message) {
      calls.push(message.id)
      return respond(message, calls)
    },
    ...extra,
  }
  return { channel, calls }
}

function makeWorker(channel: AttendanceDeliveryChannel, opts: { now?: () => Date; leaseMs?: number; maxAttempts?: number } = {}) {
  return new AttendanceNotificationDeliveryWorker({
    query,
    channels: [channel],
    quietHours: null,
    workerId: `defer-worker-${randomUUID()}`,
    ...opts,
  })
}

const defer = (deferMs: number, error = 'test_paced'): AttendanceDeliveryChannelResult => ({ ok: false, defer: true, deferMs, error })

describeIfDb('delivery worker deferral and lease headroom (real DB)', () => {
  afterAll(async () => {
    await clearRows().catch(() => {})
  })

  it('a deferred result returns the row to pending, restores the attempt and schedules next_attempt_at', async () => {
    await clearRows()
    const id = await seed({ attemptCount: 0 })
    const { channel } = makeChannel(async () => defer(30_000))
    const before = Date.now()
    const outcome = await makeWorker(channel).runBatch()
    const after = Date.now()

    expect(outcome).toMatchObject({ claimed: 1, deferred: 1, failed: 0, retrying: 0, skipped: 0 })
    const row = await readRow(id)
    expect(row.status).toBe('pending')
    expect(row.attempt_count).toBe(0)
    expect(row.claim_worker_id).toBeNull()
    expect(row.claim_expires_at).toBeNull()
    expect(row.last_error).toBe('test_paced')
    expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 30_000 - 1)
    expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(after + 30_000 + 1)
  })

  it('a deferral does not spend the attempt ceiling', async () => {
    await clearRows()
    const id = await seed({ attemptCount: 4 })
    const { channel } = makeChannel(async () => defer(5_000))
    const outcome = await makeWorker(channel, { maxAttempts: 5 }).runBatch()
    expect(outcome.failed).toBe(0)
    const row = await readRow(id)
    expect(row.status).toBe('pending')
    expect(row.attempt_count).toBe(4)
  })

  it('a worker that lost its lease writes nothing', async () => {
    await clearRows()
    const id = await seed()
    const { channel } = makeChannel(async (message) => {
      await q(
        `UPDATE attendance_notification_deliveries
            SET claim_worker_id = 'other-worker', attempt_count = attempt_count + 1
          WHERE id = $1::uuid`,
        [message.id],
      )
      return defer(30_000)
    })
    const outcome = await makeWorker(channel).runBatch()
    expect(outcome.lostLease).toBe(1)
    expect(outcome.deferred).toBeUndefined()
    const row = await readRow(id)
    expect(row.status).toBe('sending')
    expect(row.claim_worker_id).toBe('other-worker')
    expect(row.attempt_count).toBe(2)
    expect(row.last_error).toBeNull()
  })

  it('a row deferred past two hours from creation ends as skipped; one inside the window stays pending', async () => {
    await clearRows()
    const old = await seed({ createdAgoMs: 2 * 60 * MINUTE + MINUTE })
    const fresh = await seed({ createdAgoMs: 2 * 60 * MINUTE - MINUTE })
    const { channel } = makeChannel(async () => defer(30_000, 'test_paced'))
    const outcome = await makeWorker(channel).runBatch()
    expect(outcome).toMatchObject({ claimed: 2, skipped: 1, deferred: 1, failed: 0 })
    expect((await readRow(old)).status).toBe('skipped')
    expect((await readRow(old)).last_error).toBe('test_paced_expired')
    expect((await readRow(fresh)).status).toBe('pending')
    expect((await readRow(fresh)).attempt_count).toBe(0)
  })

  it('less than maxSendDurationMs of lease left: the row is deferred and no send starts', async () => {
    await clearRows()
    const a = await seed()
    const b = await seed()
    const base = Date.now()
    const clock = { ms: base }
    const { channel, calls } = makeChannel(async () => {
      clock.ms += 50_000
      return { ok: true }
    }, { maxSendDurationMs: 12_000 })
    const outcome = await makeWorker(channel, { now: () => new Date(clock.ms), leaseMs: 60_000 }).runBatch()

    expect(calls).toHaveLength(1)
    expect(outcome).toMatchObject({ claimed: 2, sent: 1, deferred: 1 })
    const rows = [await readRow(a), await readRow(b)]
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'sent'])
    const deferred = rows.find((r) => r.status === 'pending')!
    expect(deferred.attempt_count).toBe(0)
    expect(deferred.last_error).toBe('attendance_delivery_lease_margin_insufficient')
  })

  it('a slow batch whose lease expired sends no row that another worker re-claimed', async () => {
    await clearRows()
    await seed()
    await seed()
    const base = Date.now()
    const clockA = { ms: base }
    const clockB = { ms: base + 6_000 }
    const sendsById = new Map<string, number>()
    let first: string | null = null
    let runB: (() => Promise<unknown>) | null = null
    const { channel } = makeChannel(async (message) => {
      sendsById.set(message.id, (sendsById.get(message.id) ?? 0) + 1)
      if (first === null) {
        first = message.id
        clockA.ms += 4_000 // 1 s of the 5 s lease remains for the second row
        clockB.ms = base + 6_000 // the lease has now expired for another worker
        await runB!()
      }
      return { ok: true }
    }, { maxSendDurationMs: 2_000 })
    const workerA = makeWorker(channel, { now: () => new Date(clockA.ms), leaseMs: 5_000 })
    const workerB = makeWorker(channel, { now: () => new Date(clockB.ms), leaseMs: 5_000 })
    runB = () => workerB.runBatch()

    await workerA.runBatch()

    const otherId = [...sendsById.keys()].find((id) => id !== first)!
    expect(otherId).toBeDefined()
    expect(sendsById.get(otherId)).toBe(1)
  })

  it('results other than a deferral keep their classification', async () => {
    const cases: Array<[AttendanceDeliveryChannelResult, string, number]> = [
      [{ ok: false, retryable: true, error: 'boom' }, 'retrying', 1],
      [{ ok: false, retryable: false, error: 'boom' }, 'failed', 1],
      [{ ok: false, retryable: false, skip: true, error: 'no_identity' }, 'skipped', 1],
      [{ ok: false, retryable: false, outcomeUnknown: true, error: 'lost' }, 'outcome_unknown', 1],
      [{ ok: true }, 'sent', 1],
    ]
    for (const [result, status, attempts] of cases) {
      await clearRows()
      const id = await seed()
      const { channel } = makeChannel(async () => result)
      const outcome = await makeWorker(channel, { now: () => new Date(Date.now() + 10 * MINUTE), leaseMs: 5_000 }).runBatch()
      expect(outcome.deferred).toBeUndefined()
      const row = await readRow(id)
      expect(row.status).toBe(status)
      expect(row.attempt_count).toBe(attempts)
    }
  })
})
