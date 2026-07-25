/**
 * W4C-2 (#4556 lock 7.1a / 12.3) — outbox dispatcher gates against real
 * Postgres: "crash after commit/before emit, dispatcher restart, concurrent
 * dispatcher, and emit failure eventually deliver without repeating
 * source/result DML."
 *
 * Fixture rows are raw pending outbox rows in a per-run random org — exactly
 * the durable state a crash-after-commit-before-emit leaves behind (the source
 * transaction committed its outbox insert; the process died before any emit).
 * The outbox is append-only + one-way (W4C-0 triggers), so fixture rows are
 * designed shared-DB residue like every other w4c0/w4c2 suite.
 *
 * The concurrent leg is TRUE concurrency ([[feedback_toctou_needs_constructed_race]]):
 * two dedicated pg connections run the dispatcher simultaneously, held inside
 * their claiming transactions by a sink-side rendezvous so their FOR UPDATE
 * SKIP LOCKED scans provably overlap; exactly-once delivery per row is
 * asserted across both sinks together.
 */
import { randomUUID } from 'crypto'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  dispatchAttendanceResultEventOutboxV1,
  AttendanceW4OutboxDispatchError,
  type AttendanceOutboxDeliveryV1,
} from '../../src/attendance/w4c2-outbox-dispatcher'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const ORG = `w4c2ob_${RUN}`
const FP = 'f'.repeat(64)

function wrap(client: Client) {
  return {
    query: async (sqlText: string, params?: unknown[]) => {
      const result = await client.query(sqlText, params)
      return { rows: (result.rows ?? []) as Array<Record<string, unknown>> }
    },
  }
}

describeDb('W4C-2 outbox dispatcher (lock 7.1a/12.3, real DB, true concurrency)', () => {
  let pool: Pool

  const seedPending = async (eventKind: string, payload: Record<string, unknown>): Promise<string> => {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO attendance_result_event_outbox
         (id, org_id, entrypoint, operation_id, event_kind, payload, payload_schema_version, business_key_fingerprint, delivery_state)
       VALUES ($1, $2, 'live_punch', $3, $4, $5::jsonb, 1, $6, 'pending')`,
      [id, ORG, randomUUID(), eventKind, JSON.stringify(payload), FP],
    )
    return id
  }

  const rowState = async (id: string) =>
    (await pool.query(
      `SELECT delivery_state, attempts, (delivered_at IS NOT NULL) AS has_delivered_at,
              (next_attempt_at IS NOT NULL AND next_attempt_at > now()) AS backoff_in_future
         FROM attendance_result_event_outbox WHERE id = $1`,
      [id],
    )).rows[0]

  // The "no repeated source/result DML" witness: the dispatcher may touch the
  // outbox table only. These three tables are the source/result surface a
  // buggy dispatcher would most plausibly re-run.
  const businessCounts = async () => {
    const q = async (sqlText: string) => Number((await pool.query(sqlText)).rows[0].n)
    return {
      operations: await q('SELECT count(*)::int AS n FROM attendance_result_operations'),
      calculations: await q('SELECT count(*)::int AS n FROM attendance_record_calculations'),
      records: await q('SELECT count(*)::int AS n FROM attendance_records'),
    }
  }

  const openClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    return client
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
  })

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
  })

  it('crash-after-commit-before-emit: a committed pending row is delivered exactly once; a re-run re-emits nothing and repeats zero source/result DML', async () => {
    const id = await seedPending('attendance.punched', { probe: 'crash-recovery', run: RUN })
    const before = await businessCounts()
    const emitted: AttendanceOutboxDeliveryV1[] = []
    const client = await openClient()
    try {
      const first = await dispatchAttendanceResultEventOutboxV1(wrap(client), {
        emit: (delivery) => { emitted.push(delivery) },
      })
      expect(first.delivered).toBeGreaterThanOrEqual(1)
      expect(first.failed).toBe(0)
      expect(emitted.filter((e) => (e.payload as { probe?: string; run?: string })?.run === RUN)).toEqual([
        { eventKind: 'attendance.punched', payload: { probe: 'crash-recovery', run: RUN }, payloadSchemaVersion: 1 },
      ])
      expect(await rowState(id)).toEqual({
        delivery_state: 'delivered', attempts: 1, has_delivered_at: true, backoff_in_future: false,
      })

      // Restarted dispatcher: nothing left for this row, zero re-emit.
      const emittedAgain: AttendanceOutboxDeliveryV1[] = []
      await dispatchAttendanceResultEventOutboxV1(wrap(client), {
        emit: (delivery) => { emittedAgain.push(delivery) },
      })
      expect(emittedAgain.filter((e) => (e.payload as { run?: string })?.run === RUN)).toEqual([])
      expect(await businessCounts()).toEqual(before)
    } finally {
      await client.end()
    }
  })

  it('emit failure: attempts+1, row stays pending with future backoff, batch is not aborted; a restarted dispatcher with a healthy sink delivers it', async () => {
    const poisoned = await seedPending('attendance.requested', { probe: 'poison', run: RUN })
    const healthy = await seedPending('attendance.resolved', { probe: 'healthy', run: RUN })
    const client = await openClient()
    try {
      const delivered: string[] = []
      const first = await dispatchAttendanceResultEventOutboxV1(wrap(client), {
        emit: (delivery) => {
          if ((delivery.payload as { probe?: string })?.probe === 'poison') {
            throw new Error('sink down')
          }
          delivered.push(delivery.eventKind)
        },
      })
      expect(first.failed).toBeGreaterThanOrEqual(1)
      // The poisoned row did not stall the healthy one.
      expect(delivered).toContain('attendance.resolved')
      expect(await rowState(healthy)).toMatchObject({ delivery_state: 'delivered' })
      expect(await rowState(poisoned)).toEqual({
        delivery_state: 'pending', attempts: 1, has_delivered_at: false, backoff_in_future: true,
      })

      // Backoff respected: an immediate re-run does not reclaim the poisoned row.
      const reclaimed: AttendanceOutboxDeliveryV1[] = []
      await dispatchAttendanceResultEventOutboxV1(wrap(client), {
        emit: (delivery) => { reclaimed.push(delivery) },
      })
      expect(reclaimed.filter((e) => (e.payload as { probe?: string })?.probe === 'poison')).toEqual([])

      // "Restart" recovery: once due (backoff elapsed — simulated by a
      // guard-legal forward-only attempts-preserving reschedule), a fresh
      // dispatcher instance with a healthy sink delivers it.
      await pool.query(
        `UPDATE attendance_result_event_outbox SET next_attempt_at = now() WHERE id = $1`,
        [poisoned],
      )
      const restarted = await openClient()
      try {
        const recovered: AttendanceOutboxDeliveryV1[] = []
        await dispatchAttendanceResultEventOutboxV1(wrap(restarted), {
          emit: (delivery) => { recovered.push(delivery) },
        })
        expect(recovered.filter((e) => (e.payload as { probe?: string })?.probe === 'poison')).toEqual([
          { eventKind: 'attendance.requested', payload: { probe: 'poison', run: RUN }, payloadSchemaVersion: 1 },
        ])
        expect(await rowState(poisoned)).toMatchObject({ delivery_state: 'delivered', attempts: 2 })
      } finally {
        await restarted.end()
      }
    } finally {
      await client.end()
    }
  })

  it('two CONCURRENT dispatchers partition the pending set: every row delivered exactly once across both sinks, no errors, no double emit', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i += 1) {
      ids.push(await seedPending('attendance.request.updated', { probe: 'concurrent', run: RUN, ordinal: i }))
    }
    const a = await openClient()
    const b = await openClient()
    try {
      const seen: Array<{ sink: string; ordinal: number }> = []
      let rendezvous: (() => void) | null = null
      const bothInside = new Promise<void>((resolve, reject) => {
        let count = 0
        rendezvous = () => { count += 1; if (count === 2) resolve() }
        const timer = setTimeout(() => reject(new Error('rendezvous timeout: dispatchers did not overlap')), 10_000)
        timer.unref?.()
      })
      const makeSink = (name: string) => {
        let first = true
        return async (delivery: AttendanceOutboxDeliveryV1) => {
          if (first) {
            first = false
            // Rendezvous on the FIRST claimed row (whatever suite seeded it —
            // this is a shared DB): hold THIS dispatcher inside its claiming
            // transaction until the other one has also claimed, so the two
            // FOR UPDATE SKIP LOCKED scans provably overlap in time.
            rendezvous?.()
            await bothInside
          }
          const payload = delivery.payload as { probe?: string; run?: string; ordinal?: number }
          if (payload?.probe !== 'concurrent' || payload?.run !== RUN) return
          seen.push({ sink: name, ordinal: Number(payload.ordinal) })
        }
      }
      // Small batches force both dispatchers to hold live claims at once:
      // 6 seeded rows and a limit of 3 mean NEITHER dispatcher can have
      // claimed everything, so both must be inside for the rendezvous.
      const [ra, rb] = await Promise.all([
        dispatchAttendanceResultEventOutboxV1(wrap(a), { emit: makeSink('a'), batchLimit: 3 }),
        dispatchAttendanceResultEventOutboxV1(wrap(b), { emit: makeSink('b'), batchLimit: 3 }),
      ])
      // Drain any remainder (foreign shared-DB pending rows may have displaced
      // some of ours from the two capped first passes).
      let guard = 0
      for (;;) {
        const more = await dispatchAttendanceResultEventOutboxV1(wrap(a), { emit: makeSink('a'), batchLimit: 100 })
        if (more.claimed === 0 || (guard += 1) > 20) break
      }

      expect(ra.failed).toBe(0)
      expect(rb.failed).toBe(0)
      const ordinals = seen.map((s) => s.ordinal).sort((x, y) => x - y)
      expect(ordinals).toEqual([0, 1, 2, 3, 4, 5]) // exactly once each — a double emit would duplicate an ordinal
      expect(ra.claimed).toBe(3) // both dispatchers held live claims in the overlapping window
      expect(rb.claimed).toBe(3)
      for (const id of ids) {
        expect(await rowState(id)).toMatchObject({ delivery_state: 'delivered', attempts: 1 })
      }
    } finally {
      await a.end()
      await b.end()
    }
  }, 30_000)

  it('closed input validation: missing sink / invalid batch limit / invalid backoff fail closed with typed codes', async () => {
    const client = await openClient()
    try {
      const trx = wrap(client)
      await expect(
        dispatchAttendanceResultEventOutboxV1(trx, { emit: undefined as unknown as () => void }),
      ).rejects.toMatchObject({ code: 'W4C2_OUTBOX_SINK_REQUIRED', name: 'AttendanceW4OutboxDispatchError' })
      await expect(
        dispatchAttendanceResultEventOutboxV1(trx, { emit: () => undefined, batchLimit: 0 }),
      ).rejects.toBeInstanceOf(AttendanceW4OutboxDispatchError)
      await expect(
        dispatchAttendanceResultEventOutboxV1(trx, { emit: () => undefined, retryBackoffMs: -1 }),
      ).rejects.toMatchObject({ code: 'W4C2_OUTBOX_BACKOFF_INVALID' })
    } finally {
      await client.end()
    }
  })

  it('two-point wiring self-check: this file is listed in the plugin-tests attendance step and the no-DB vitest exclude', async () => {
    const fs = await import('fs/promises')
    const pathMod = await import('path')
    const self = 'tests/integration/attendance-w4c2-outbox-dispatcher.db.test.ts'
    const workflow = await fs.readFile(pathMod.join(__dirname, '../../../../.github/workflows/plugin-tests.yml'), 'utf8')
    expect(workflow).toContain(self)
    const vitestConfig = await fs.readFile(pathMod.join(__dirname, '../../vitest.config.ts'), 'utf8')
    expect(vitestConfig).toContain(self)
  })
})
