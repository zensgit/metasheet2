/**
 * Delivery worker: deferred channel results and lease headroom.
 *
 * A channel may answer `{ ok:false, defer:true, deferMs, error }` instead of a failure. The worker
 * returns the row to `pending` (CAS: status 'sending' + same claim_worker_id + same attempt_count),
 * gives back the attempt the claim took, and schedules `next_attempt_at = now + clamp(deferMs)`.
 * A row still deferred more than two hours after creation ends as `skipped` with `<error>_expired`.
 * A channel that declares `maxSendDurationMs` is only sent to while that much of the batch lease is
 * left; otherwise the row is deferred without an external call.
 *
 * The harness below applies each UPDATE the worker issues to an in-memory row, honouring the CAS
 * predicates and the `attempt_count - 1` assignment in the statement text. The statements themselves
 * run against real PostgreSQL in tests/integration/attendance-notification-defer.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AttendanceNotificationDeliveryWorker,
  type AttendanceDeliveryChannel,
  type AttendanceDeliveryChannelResult,
  type AttendanceNotificationDeliveryQuery,
} from '../../src/services/AttendanceNotificationDeliveryWorker'

const T0 = Date.parse('2026-11-07T10:00:00.000Z')
const HOUR = 60 * 60_000
const WORKER_ID = 'worker-under-test'

interface FakeRow {
  id: string
  status: string
  attempt_count: number
  claim_worker_id: string | null
  next_attempt_at: string | null
  last_error: string | null
  created_at: string
  channel: string
}

function makeHarness(rows: Array<Partial<FakeRow> & { id: string }>, clock: { ms: number }) {
  const table = new Map<string, FakeRow>()
  for (const r of rows) {
    table.set(r.id, {
      status: 'pending',
      attempt_count: 0,
      claim_worker_id: null,
      next_attempt_at: new Date(T0).toISOString(),
      last_error: null,
      created_at: new Date(T0 - 60_000).toISOString(),
      channel: 'chan',
      ...r,
    })
  }
  const statements: string[] = []
  const query = (async (sql: string, params: unknown[] = []) => {
    statements.push(sql)
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      const claimed: Array<Record<string, unknown>> = []
      for (const row of table.values()) {
        if (row.status !== 'pending' && row.status !== 'retrying') continue
        if (Date.parse(row.next_attempt_at as string) > Date.parse(params[0] as string)) continue
        row.status = 'sending'
        row.attempt_count += 1
        row.claim_worker_id = params[3] as string
        claimed.push({
          id: row.id,
          org_id: 'org',
          source_type: 'test',
          source_id: null,
          source_key: `key-${row.id}`,
          recipient_user_id: 'u',
          recipient_role: 'employee',
          channel: row.channel,
          attempt_count: row.attempt_count,
          payload: {},
          created_at: row.created_at,
        })
      }
      return { rows: claimed, rowCount: claimed.length }
    }
    // Every terminal / requeue write has the same CAS tail: id = $1, claim worker, attempt count.
    const m = sql.match(/SET status = '(\w+)'/)
    if (!m) throw new Error(`unexpected statement: ${sql}`)
    const param = (re: RegExp) => {
      const hit = sql.match(re)
      return hit ? params[Number(hit[1]) - 1] : undefined
    }
    const row = table.get(params[0] as string)
    // Each CAS predicate is applied only when the statement text carries it.
    const workerParam = sql.match(/claim_worker_id = \$(\d+)/)
    const attemptParam = sql.match(/attempt_count = \$(\d+)::int/)
    const casOk = !!row
      && (!sql.includes("AND status = 'sending'") || row.status === 'sending')
      && (!workerParam || row.claim_worker_id === params[Number(workerParam[1]) - 1])
      && (!attemptParam || row.attempt_count === params[Number(attemptParam[1]) - 1])
    if (!casOk || !row) return { rows: [], rowCount: 0 }
    row.status = m[1]
    row.claim_worker_id = null
    if (sql.includes('attempt_count = attempt_count - 1')) row.attempt_count -= 1
    const next = param(/next_attempt_at = \$(\d+)/)
    if (next !== undefined) row.next_attempt_at = next as string
    row.last_error = (param(/last_error = \$(\d+)/) as string | undefined) ?? null
    return { rows: [], rowCount: 1 }
  }) as unknown as AttendanceNotificationDeliveryQuery
  return { table, statements, query }
}

function makeWorker(
  harness: ReturnType<typeof makeHarness>,
  channel: AttendanceDeliveryChannel,
  clock: { ms: number },
  extra: { leaseMs?: number; maxAttempts?: number } = {},
) {
  return new AttendanceNotificationDeliveryWorker({
    query: harness.query,
    channels: [channel],
    workerId: WORKER_ID,
    quietHours: null,
    now: () => new Date(clock.ms),
    ...extra,
  })
}

function channelReturning(result: AttendanceDeliveryChannelResult, extra: Partial<AttendanceDeliveryChannel> = {}) {
  const send = vi.fn(async () => result)
  return { name: 'chan', send, ...extra } as AttendanceDeliveryChannel & { send: typeof send }
}

describe('deferred channel result', () => {
  it('returns the row to pending, gives back the claimed attempt and schedules a short next attempt', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 30_000, error: 'wecom_recipient_paced' })
    const result = await makeWorker(h, channel, clock).runBatch()

    expect(result).toMatchObject({ claimed: 1, sent: 0, retrying: 0, failed: 0, skipped: 0, deferred: 1 })
    const row = h.table.get('a')!
    expect(row.status).toBe('pending')
    expect(row.attempt_count).toBe(0)
    expect(row.claim_worker_id).toBeNull()
    expect(row.next_attempt_at).toBe(new Date(T0 + 30_000).toISOString())
    expect(row.last_error).toBe('wecom_recipient_paced')
  })

  it('never consumes attempts: repeated deferrals stay pending past maxAttempts', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 5_000, error: 'wecom_recipient_paced' })
    const worker = makeWorker(h, channel, clock, { maxAttempts: 2 })
    for (let i = 0; i < 8; i += 1) {
      clock.ms += 6_000
      await worker.runBatch()
    }
    expect(channel.send).toHaveBeenCalledTimes(8)
    expect(h.table.get('a')).toMatchObject({ status: 'pending', attempt_count: 0 })
  })

  it('a deferral wins over the attempt ceiling of a row that already used its attempts', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a', attempt_count: 4 }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 5_000, error: 'wecom_recipient_paced' })
    const result = await makeWorker(h, channel, clock, { maxAttempts: 5 }).runBatch()
    expect(result.failed).toBe(0)
    expect(h.table.get('a')).toMatchObject({ status: 'pending', attempt_count: 4 })
  })

  it.each([
    [1, 5_000],
    [Number.NaN, 5_000],
    [-10, 5_000],
    [45 * 60_000, 5 * 60_000],
    [12_345.9, 12_345],
  ])('clamps deferMs %s to %s ms', async (deferMs, expected) => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs, error: 'wecom_recipient_paced' })
    await makeWorker(h, channel, clock).runBatch()
    expect(h.table.get('a')!.next_attempt_at).toBe(new Date(T0 + expected).toISOString())
  })

  it.each([
    ['claim worker changed', { claim_worker_id: 'other-worker' }],
    ['attempt count advanced', { attempt_count: 2 }],
    ['status no longer sending', { status: 'failed' }],
  ] as Array<[string, Partial<FakeRow>]>)('writes nothing when the lease was lost (%s); the count is reported as lostLease', async (_name, change) => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 30_000, error: 'wecom_recipient_paced' })
    channel.send.mockImplementationOnce(async () => {
      Object.assign(h.table.get('a')!, change)
      return { ok: false, defer: true, deferMs: 30_000, error: 'wecom_recipient_paced' } as AttendanceDeliveryChannelResult
    })
    const result = await makeWorker(h, channel, clock).runBatch()
    expect(result).toMatchObject({ claimed: 1, lostLease: 1 })
    expect(result.deferred).toBeUndefined()
    const row = h.table.get('a')!
    expect(row.status).toBe(change.status ?? 'sending')
    expect(row.attempt_count).toBe(change.attempt_count ?? 1)
    expect(row.claim_worker_id).toBe(change.claim_worker_id ?? WORKER_ID)
    expect(row.last_error).toBeNull()
    expect(row.next_attempt_at).toBe(new Date(T0).toISOString())
  })

  it('the requeue statement carries the full CAS predicate and restores the attempt', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 30_000, error: 'wecom_recipient_paced' })
    await makeWorker(h, channel, clock).runBatch()
    const update = h.statements.find((s) => s.includes("SET status = 'pending'"))!
    expect(update).toContain("status = 'sending'")
    expect(update).toContain('claim_worker_id = $5')
    expect(update).toContain('attempt_count = $6::int')
    expect(update).toContain('attempt_count = attempt_count - 1')
  })
})

describe('deferral window', () => {
  const error = 'wecom_recipient_paced'

  it('a row created more than two hours ago ends as skipped with the expired suffix', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a', created_at: new Date(T0 - 2 * HOUR - 1).toISOString() }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 30_000, error })
    const result = await makeWorker(h, channel, clock).runBatch()
    expect(result).toMatchObject({ skipped: 1, failed: 0, retrying: 0 })
    expect(result.deferred).toBeUndefined()
    expect(h.table.get('a')).toMatchObject({ status: 'skipped', last_error: `${error}_expired` })
  })

  it('a row exactly two hours old is still deferred', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a', created_at: new Date(T0 - 2 * HOUR).toISOString() }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 30_000, error })
    const result = await makeWorker(h, channel, clock).runBatch()
    expect(result.deferred).toBe(1)
    expect(h.table.get('a')!.status).toBe('pending')
  })

  it('a row whose creation time is unreadable is not deferred again', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a', created_at: 'not-a-time' }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 30_000, error })
    const result = await makeWorker(h, channel, clock).runBatch()
    expect(result.skipped).toBe(1)
    expect(h.table.get('a')!.status).toBe('skipped')
  })

  it('the expired error text keeps at most 200 characters of the deferral reason', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a', created_at: new Date(T0 - 3 * HOUR).toISOString() }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 30_000, error: 'x'.repeat(300) })
    await makeWorker(h, channel, clock).runBatch()
    expect(h.table.get('a')!.last_error).toBe(`${'x'.repeat(200)}_expired`)
  })

  it('an expired skip is also guarded by the lease CAS', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a', created_at: new Date(T0 - 3 * HOUR).toISOString() }], clock)
    const channel = channelReturning({ ok: false, defer: true, deferMs: 30_000, error })
    channel.send.mockImplementationOnce(async () => {
      h.table.get('a')!.claim_worker_id = 'other-worker'
      return { ok: false, defer: true, deferMs: 30_000, error } as AttendanceDeliveryChannelResult
    })
    const result = await makeWorker(h, channel, clock).runBatch()
    expect(result).toMatchObject({ lostLease: 1, skipped: 0 })
    expect(h.table.get('a')!.status).toBe('sending')
  })
})

describe('lease headroom', () => {
  it('starts no send once less than maxSendDurationMs of the lease is left', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }, { id: 'b' }], clock)
    const channel = channelReturning({ ok: true }, { maxSendDurationMs: 12_000 })
    channel.send.mockImplementationOnce(async () => {
      clock.ms += 50_000 // 10 s of the 60 s lease remain for the next row
      return { ok: true } as AttendanceDeliveryChannelResult
    })
    const result = await makeWorker(h, channel, clock, { leaseMs: 60_000 }).runBatch()

    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ claimed: 2, sent: 1, deferred: 1, failed: 0, retrying: 0 })
    expect(h.table.get('a')!.status).toBe('sent')
    expect(h.table.get('b')).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      last_error: 'attendance_delivery_lease_margin_insufficient',
    })
    expect(h.table.get('b')!.next_attempt_at).toBe(new Date(clock.ms + 5_000).toISOString())
  })

  it('sends while exactly maxSendDurationMs remains', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }, { id: 'b' }], clock)
    const channel = channelReturning({ ok: true }, { maxSendDurationMs: 12_000 })
    channel.send.mockImplementationOnce(async () => {
      clock.ms += 48_000
      return { ok: true } as AttendanceDeliveryChannelResult
    })
    const result = await makeWorker(h, channel, clock, { leaseMs: 60_000 }).runBatch()
    expect(channel.send).toHaveBeenCalledTimes(2)
    expect(result.sent).toBe(2)
    expect(result.deferred).toBeUndefined()
  })

  it('a zero budget declares nothing and is never held back', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }, { id: 'b' }], clock)
    const channel = channelReturning({ ok: true }, { maxSendDurationMs: 0 })
    channel.send.mockImplementationOnce(async () => {
      clock.ms += 61_000
      return { ok: true } as AttendanceDeliveryChannelResult
    })
    const result = await makeWorker(h, channel, clock, { leaseMs: 60_000 }).runBatch()
    expect(channel.send).toHaveBeenCalledTimes(2)
    expect(result.sent).toBe(2)
  })

  it('the claim returns the creation time that the deferral window is measured from', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }], clock)
    await makeWorker(h, channelReturning({ ok: true }), clock).runBatch()
    const claim = h.statements.find((s) => s.includes('FOR UPDATE SKIP LOCKED'))!
    expect(claim).toMatch(/RETURNING[\s\S]*d\.created_at/)
  })

  it('warns once per construction about a budget that is not below the lease, and only then', () => {
    const clock = { ms: T0 }
    const h = makeHarness([], clock)
    const build = (budget: number) => {
      const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
      new AttendanceNotificationDeliveryWorker({
        query: h.query,
        channels: [channelReturning({ ok: true }, { maxSendDurationMs: budget })],
        quietHours: null,
        leaseMs: 60_000,
        logger: logger as never,
      })
      return logger.warn
    }
    expect(build(60_000)).toHaveBeenCalledTimes(1)
    expect(build(90_000)).toHaveBeenCalledTimes(1)
    expect(build(59_999)).not.toHaveBeenCalled()
    expect(build(0)).toHaveBeenCalledTimes(0)
  })

  it('a margin deferral past the window ends as skipped with the expired suffix', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a', created_at: new Date(T0 - 3 * HOUR).toISOString() }], clock)
    const channel = channelReturning({ ok: true }, { maxSendDurationMs: 90_000 })
    const result = await makeWorker(h, channel, clock, { leaseMs: 60_000 }).runBatch()
    expect(channel.send).not.toHaveBeenCalled()
    expect(result.skipped).toBe(1)
    expect(h.table.get('a')).toMatchObject({
      status: 'skipped',
      last_error: 'attendance_delivery_lease_margin_insufficient_expired',
    })
  })

  it('a channel without maxSendDurationMs is never held back, however little lease is left', async () => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }, { id: 'b' }], clock)
    const channel = channelReturning({ ok: true })
    channel.send.mockImplementationOnce(async () => {
      clock.ms += 59_999
      return { ok: true } as AttendanceDeliveryChannelResult
    })
    const result = await makeWorker(h, channel, clock, { leaseMs: 60_000 }).runBatch()
    expect(channel.send).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ sent: 2 })
    expect(result.deferred).toBeUndefined()
  })
})

describe('results without a deferral keep their classification', () => {
  it.each([
    ['retryable failure', { ok: false, retryable: true, error: 'boom' }, { retrying: 1 }, 'retrying', 1],
    ['permanent failure', { ok: false, retryable: false, error: 'boom' }, { failed: 1 }, 'failed', 1],
    ['structural skip', { ok: false, retryable: false, skip: true, error: 'no_identity' }, { skipped: 1 }, 'skipped', 1],
    ['unknown outcome', { ok: false, retryable: false, outcomeUnknown: true, error: 'lost' }, { outcomeUnknown: 1 }, 'outcome_unknown', 1],
  ] as const)('%s', async (_name, channelResult, counts, status, attempts) => {
    const clock = { ms: T0 }
    const h = makeHarness([{ id: 'a' }], clock)
    const channel = channelReturning(channelResult as AttendanceDeliveryChannelResult)
    const result = await makeWorker(h, channel, clock).runBatch()
    expect(result).toMatchObject(counts)
    expect(result.deferred).toBeUndefined()
    expect(h.table.get('a')).toMatchObject({ status, attempt_count: attempts })
  })
})
