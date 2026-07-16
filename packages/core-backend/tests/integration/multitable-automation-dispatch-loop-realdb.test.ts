/**
 * P2 durable-delivery — slice S2-b: dispatch loop (registry + tick) against real Postgres.
 *
 * Proves the loop's guarantees end-to-end on the real outbox tables:
 *   - registry uniqueness is a startup error (duplicate key throws — never a silent double-run);
 *   - a success adapter's row completes; a retryable failure reschedules with a GROWING backoff lease and a
 *     values-free reason; a permanent failure dead-letters;
 *   - an adapter THROW maps to retryable `adapter_error` (never poison, never verbatim message);
 *   - per-row isolation: one adapter failing never blocks another row in the same tick;
 *   - rolling-deploy: a row with a consumer_key outside the registry is alerted via the seam and left
 *     `pending` untouched;
 *   - the long-running loop REFUSES to start with the master flag OFF, and with the flag ON (injected env)
 *     actually drains a row, then stop() halts it.
 *
 * Consumer keys are randomUUID()-scoped for shared-DB isolation. Two-point wired (plugin-tests.yml +
 * vitest.config.ts exclude) so it cannot skip-green.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  computeRetryDelayMs,
  ConsumerAdapterRegistry,
  normalizeAdapterVerdict,
  runDispatchTick,
  startDurableDispatchLoop,
  type AdapterOutcome,
  type ConsumerAdapter,
  type DispatchLoopObserver,
} from '../../src/multitable/automation-durable-dispatch-loop'
import type { ClaimedConsumer, Queryable } from '../../src/multitable/automation-durable-dispatcher'

/** A minimal always-valid telemetry sink for tests that don't assert on it. */
const noopObserver: DispatchLoopObserver = { onUnknownConsumerKeys: () => {}, onTickError: () => {} }

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const outboxIds: string[] = []
let seq = 0

async function seedRow(consumerKey: string) {
  const id = `ob_s2b_${RUN}_${seq}`
  seq += 1
  outboxIds.push(id)
  await db().query(
    `INSERT INTO meta_automation_outbox (id, event_type, payload, automation_depth, manifest_version, event_id)
     VALUES ($1,'approval.approved',$2::jsonb,0,1,$3)`,
    [id, JSON.stringify({ ob: id }), `evt_${id}`],
  )
  await db().query(
    `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key) VALUES ($1,$2)`,
    [id, consumerKey],
  )
  return id
}

async function readRow(outboxId: string, consumerKey: string) {
  const { rows } = await db().query(
    `SELECT status, fence::text AS fence, attempts, last_error,
            (lease_expires_at IS NULL) AS lease_null,
            GREATEST(0, ceil(extract(epoch FROM (lease_expires_at - now())) * 1000))::bigint::text AS lease_remaining_ms
       FROM meta_automation_outbox_consumer WHERE outbox_id=$1 AND consumer_key=$2`,
    [outboxId, consumerKey],
  )
  return rows[0] as {
    status: string
    fence: string
    attempts: number
    last_error: string | null
    lease_null: boolean
    lease_remaining_ms: string
  }
}

function adapter(key: string, handle: (e: ClaimedConsumer) => Promise<AdapterOutcome>): ConsumerAdapter {
  return { key, handle }
}

const ok = async (): Promise<AdapterOutcome> => ({ outcome: 'success' })

describeIfDatabase('P2 durable-delivery S2-b — dispatch loop (real DB)', () => {
  afterAll(async () => {
    if (outboxIds.length) {
      await db().query('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [outboxIds]).catch(() => {})
    }
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('registry: duplicate consumer_key registration throws (startup error, never silent double-run)', () => {
    const r = new ConsumerAdapterRegistry()
    r.register(adapter('dup-key', ok))
    expect(() => r.register(adapter('dup-key', ok))).toThrow(/duplicate consumer adapter/)
    expect(() => r.register(adapter('', ok))).toThrow(/non-empty/)
    expect(r.keys()).toEqual(['dup-key'])
  })

  test('tick with an empty registry throws (empty known-keys would hide misconfiguration)', async () => {
    await expect(runDispatchTick(db(), new ConsumerAdapterRegistry())).rejects.toThrow(/at least one adapter/)
  })

  test('success adapter: the row is claimed and completed in one tick; the adapter saw the joined event', async () => {
    const key = `ck_${RUN}_ok`
    const id = await seedRow(key)
    const seen: ClaimedConsumer[] = []
    const r = new ConsumerAdapterRegistry()
    r.register(adapter(key, async (e) => (seen.push(e), { outcome: 'success' })))
    const res = await runDispatchTick(db(), r)
    expect(res).toMatchObject({ claimed: 1, completed: 1, rescheduled: 0, poisoned: 0, lostLease: 0 })
    expect(seen[0]).toMatchObject({ outboxId: id, consumerKey: key, eventType: 'approval.approved', eventId: `evt_${id}` })
    expect(await readRow(id, key)).toMatchObject({ status: 'done', lease_null: true })
  })

  test('retryable failure: rescheduled with a values-free reason and a backoff lease that GROWS with attempts', async () => {
    const key = `ck_${RUN}_retry`
    const id = await seedRow(key)
    const r = new ConsumerAdapterRegistry()
    r.register(adapter(key, async () => ({ outcome: 'retryable_failure', reason: 'adapter_timeout' })))
    // attempt 1 → backoff base (5s default here: use explicit base for determinism)
    const t1 = await runDispatchTick(db(), r, { retryBaseMs: 60_000, retryCapMs: 600_000 })
    expect(t1).toMatchObject({ claimed: 1, rescheduled: 1, completed: 0, poisoned: 0 })
    const after1 = await readRow(id, key)
    expect(after1).toMatchObject({ status: 'in_progress', attempts: 1, last_error: 'adapter_timeout', lease_null: false })
    const remaining1 = Number(after1.lease_remaining_ms)
    expect(remaining1).toBeGreaterThan(30_000) // ~60s backoff, not the tiny claim lease
    // not reclaimable inside the backoff window
    expect((await runDispatchTick(db(), r, { retryBaseMs: 60_000 })).claimed).toBe(0)
    // force expiry → attempt 2 → backoff doubles (120s)
    await db().query(
      `UPDATE meta_automation_outbox_consumer SET lease_expires_at = now() - interval '1 second' WHERE outbox_id=$1`,
      [id],
    )
    const t2 = await runDispatchTick(db(), r, { retryBaseMs: 60_000, retryCapMs: 600_000 })
    expect(t2).toMatchObject({ claimed: 1, rescheduled: 1 })
    const after2 = await readRow(id, key)
    expect(after2.attempts).toBe(2)
    expect(Number(after2.lease_remaining_ms)).toBeGreaterThan(remaining1) // grew: 120s > 60s
  })

  test('permanent failure: dead_letter with permanent_rejection', async () => {
    const key = `ck_${RUN}_perm`
    const id = await seedRow(key)
    const r = new ConsumerAdapterRegistry()
    r.register(adapter(key, async () => ({ outcome: 'permanent_failure', reason: 'permanent_rejection' })))
    const res = await runDispatchTick(db(), r)
    expect(res).toMatchObject({ claimed: 1, poisoned: 1 })
    expect(await readRow(id, key)).toMatchObject({ status: 'dead_letter', last_error: 'permanent_rejection', lease_null: true })
  })

  test('adapter THROW (with a secret-shaped message) → retryable adapter_error; message never persisted', async () => {
    const key = `ck_${RUN}_throw`
    const id = await seedRow(key)
    const r = new ConsumerAdapterRegistry()
    r.register(
      adapter(key, async () => {
        throw new Error('https://internal.example/hook?token=SECRET-VALUE')
      }),
    )
    const res = await runDispatchTick(db(), r)
    expect(res).toMatchObject({ claimed: 1, rescheduled: 1, poisoned: 0 })
    const row = await readRow(id, key)
    expect(row).toMatchObject({ status: 'in_progress', last_error: 'adapter_error' })
    expect(row.last_error).not.toContain('SECRET') // the raw message never reaches the DB
  })

  test('per-row isolation: a throwing adapter for row A does not block row B completing in the same tick', async () => {
    const keyA = `ck_${RUN}_isoA`
    const keyB = `ck_${RUN}_isoB`
    const idA = await seedRow(keyA)
    const idB = await seedRow(keyB)
    const r = new ConsumerAdapterRegistry()
    r.register(
      adapter(keyA, async () => {
        throw new Error('boom')
      }),
    )
    r.register(adapter(keyB, ok))
    const res = await runDispatchTick(db(), r)
    expect(res.claimed).toBe(2)
    expect(res.completed).toBe(1)
    expect(res.rescheduled).toBe(1)
    expect((await readRow(idA, keyA)).status).toBe('in_progress')
    expect((await readRow(idB, keyB)).status).toBe('done')
  })

  test('rolling deploy: an unknown consumer_key is alerted through the seam and left pending untouched', async () => {
    const unknownKey = `ck_${RUN}_unknown`
    const knownKey = `ck_${RUN}_known`
    const idU = await seedRow(unknownKey)
    await seedRow(knownKey)
    const alerted: string[][] = []
    const r = new ConsumerAdapterRegistry()
    r.register(adapter(knownKey, ok))
    const res = await runDispatchTick(db(), r, { onUnknownConsumerKeys: (k) => alerted.push(k) })
    expect(alerted.flat()).toContain(unknownKey) // surfaced for alerting
    expect(res.unknownKeys).toContain(unknownKey)
    expect(await readRow(idU, unknownKey)).toMatchObject({ status: 'pending', attempts: 0 }) // untouched
  })

  test('a THROWING alert callback never fails the tick (best-effort seam)', async () => {
    const unknownKey = `ck_${RUN}_alertthrow_u`
    const knownKey = `ck_${RUN}_alertthrow_k`
    await seedRow(unknownKey)
    const idK = await seedRow(knownKey)
    const r = new ConsumerAdapterRegistry()
    r.register(adapter(knownKey, ok))
    const res = await runDispatchTick(db(), r, {
      onUnknownConsumerKeys: () => {
        throw new Error('alert sink down')
      },
    })
    expect(res.completed).toBe(1) // delivery still happened
    expect((await readRow(idK, knownKey)).status).toBe('done')
  })

  test('computeRetryDelayMs (pure): exponential from base, capped, clamped inputs', () => {
    expect(computeRetryDelayMs(1, 5_000, 900_000)).toBe(5_000)
    expect(computeRetryDelayMs(2, 5_000, 900_000)).toBe(10_000)
    expect(computeRetryDelayMs(5, 5_000, 900_000)).toBe(80_000)
    expect(computeRetryDelayMs(10, 5_000, 900_000)).toBe(900_000) // capped
    expect(computeRetryDelayMs(0)).toBe(computeRetryDelayMs(1)) // clamped
    expect(computeRetryDelayMs(1_000_000, 5_000, 900_000)).toBe(900_000) // huge attempts: capped, no overflow
  })

  test('loop: refuses to start with the flag OFF; with flag ON drains a row and stop() halts', async () => {
    const key = `ck_${RUN}_loop`
    const id = await seedRow(key)
    const r = new ConsumerAdapterRegistry()
    r.register(adapter(key, ok))
    // flag OFF (empty env) → must refuse
    expect(() => startDurableDispatchLoop(db(), r, noopObserver, { env: {} as NodeJS.ProcessEnv })).toThrow(/must not start/)
    // flag ON via injected env → drains the seeded row, then stops cleanly
    const handle = startDurableDispatchLoop(db(), r, noopObserver, {
      env: { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv,
      intervalMs: 100,
    })
    try {
      const deadline = Date.now() + 8_000
      // eslint-disable-next-line no-unmodified-loop-condition
      while (Date.now() < deadline) {
        if ((await readRow(id, key)).status === 'done') break
        await new Promise((res2) => setTimeout(res2, 100))
      }
      expect((await readRow(id, key)).status).toBe('done')
    } finally {
      await handle.stop()
    }
  }, 15_000)

  // [#4334 review P1#1] Batch-claim + serial execution: a worker that LOSES its lease mid-batch must not go
  // on to call the next row's adapter (double external emit). The pre-call fence-CAS renew is the guard.
  test('P1#1: a stale worker does NOT invoke the adapter for a row a concurrent worker reclaimed mid-batch', async () => {
    const k1 = `ck_${RUN}_slotA`
    const k2 = `ck_${RUN}_slotB`
    const id1 = await seedRow(k1)
    const id2 = await seedRow(k2)
    // Deterministic dispatch order: row1 before row2 (claim dispatches ORDER BY outbox.created_at ASC).
    await db().query(`UPDATE meta_automation_outbox SET created_at = now() - interval '2 seconds' WHERE id=$1`, [id1])
    await db().query(`UPDATE meta_automation_outbox SET created_at = now() - interval '1 second'  WHERE id=$1`, [id2])

    const callOrder: string[] = []
    let k2Called = false
    const r = new ConsumerAdapterRegistry()
    // Row1's adapter simulates a CONCURRENT RECLAIM of row2 (exactly what another worker's claim does: bump
    // the fence) while THIS worker is mid-batch. When the loop reaches row2, its pre-call renew must fail.
    r.register(
      adapter(k1, async () => {
        callOrder.push('k1')
        await db().query(
          `UPDATE meta_automation_outbox_consumer SET fence = fence + 1 WHERE outbox_id=$1 AND consumer_key=$2`,
          [id2, k2],
        )
        return { outcome: 'success' }
      }),
    )
    r.register(
      adapter(k2, async () => {
        k2Called = true
        callOrder.push('k2')
        return { outcome: 'success' }
      }),
    )

    const res = await runDispatchTick(db(), r)
    expect(res.claimed).toBe(2)
    expect(k2Called).toBe(false) // the guard held: the stale row's adapter was never called
    expect(callOrder).toEqual(['k1']) // only the still-owned row ran
    expect(res.completed).toBe(1) // row1
    expect(res.lostLease).toBe(1) // row2 skipped at the pre-call renew
    expect((await readRow(id1, k1)).status).toBe('done')
    expect((await readRow(id2, k2)).status).toBe('in_progress') // left to its new owner, untouched by us
  })

  // [#4334 review P1#2] A malformed adapter verdict must RETRY (values-free adapter_error), never poison —
  // poisoning drops the event. Only an exact permanent verdict dead-letters.
  test('P1#2: malformed adapter verdicts reschedule as adapter_error (never dead_letter)', async () => {
    const cases: Array<{ label: string; ret: unknown }> = [
      { label: 'unknown outcome', ret: { outcome: 'bogus' } },
      { label: 'permanent w/o reason', ret: { outcome: 'permanent_failure' } },
      { label: 'permanent w/ bad reason', ret: { outcome: 'permanent_failure', reason: 'nope' } },
      { label: 'null', ret: null },
      { label: 'non-object', ret: 42 },
      { label: 'retryable w/ bad reason', ret: { outcome: 'retryable_failure', reason: 'not_in_vocab' } },
    ]
    for (const c of cases) {
      const key = `ck_${RUN}_bad_${cases.indexOf(c)}`
      const id = await seedRow(key)
      const r = new ConsumerAdapterRegistry()
      r.register(adapter(key, async () => c.ret as unknown as AdapterOutcome))
      const res = await runDispatchTick(db(), r)
      expect(res, c.label).toMatchObject({ claimed: 1, rescheduled: 1, poisoned: 0 })
      const row = await readRow(id, key)
      expect(row.status, c.label).toBe('in_progress') // retried, NOT dead_letter — the event is not dropped
      // retryable-with-bad-reason normalizes to values-free `unknown`; every other malformed shape → adapter_error.
      const expected = (c.ret as { outcome?: string })?.outcome === 'retryable_failure' ? 'unknown' : 'adapter_error'
      expect(row.last_error, c.label).toBe(expected)
    }
  })

  // [#4334 review P1#3] A hung adapter must not freeze the tick — it times out to adapter_timeout and the
  // dispatcher moves on; a sibling row still completes in the same tick.
  test('P1#3: a hung adapter times out (adapter_timeout) and never blocks the tick or sibling rows', async () => {
    const hangKey = `ck_${RUN}_hang`
    const okKey = `ck_${RUN}_hang_ok`
    const idHang = await seedRow(hangKey)
    const idOk = await seedRow(okKey)
    const r = new ConsumerAdapterRegistry()
    r.register(adapter(hangKey, () => new Promise<AdapterOutcome>(() => {}))) // never settles
    r.register(adapter(okKey, ok))
    const started = Date.now()
    const res = await runDispatchTick(db(), r, { adapterTimeoutMs: 300 })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(8_000) // the tick returned — it did NOT hang on the dangling promise
    expect(res.claimed).toBe(2)
    expect(res.completed).toBe(1) // the ok row
    expect(res.rescheduled).toBe(1) // the hung row
    expect(await readRow(idHang, hangKey)).toMatchObject({ status: 'in_progress', last_error: 'adapter_timeout' })
    expect((await readRow(idOk, okKey)).status).toBe('done')
  })

  // [#4334 review P2#4] A throwing telemetry sink must not stop delivery: the known row still drains.
  test('P2#4: a throwing observer.onUnknownConsumerKeys never stops the loop draining a known row', async () => {
    const unknownKey = `ck_${RUN}_obsthrow_u`
    const knownKey = `ck_${RUN}_obsthrow_k`
    await seedRow(unknownKey)
    const idK = await seedRow(knownKey)
    const r = new ConsumerAdapterRegistry()
    r.register(adapter(knownKey, ok))
    const throwingObserver: DispatchLoopObserver = {
      onUnknownConsumerKeys: () => {
        throw new Error('telemetry sink down')
      },
      onTickError: () => {},
    }
    const handle = startDurableDispatchLoop(db(), r, throwingObserver, {
      env: { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv,
      intervalMs: 100,
    })
    try {
      const deadline = Date.now() + 8_000
      // eslint-disable-next-line no-unmodified-loop-condition
      while (Date.now() < deadline) {
        if ((await readRow(idK, knownKey)).status === 'done') break
        await new Promise((res2) => setTimeout(res2, 100))
      }
      expect((await readRow(idK, knownKey)).status).toBe('done') // delivery survived the broken sink
    } finally {
      await handle.stop()
    }
  }, 15_000)
})

/**
 * Pure guards — run without a database (fake Queryable / no DB touched). These cover the runtime verdict
 * parser and the startup-time validation added for the #4334 review (P1#2 shape, P2#4 required sink /
 * exception-safety, P2#5 numeric bounds).
 */
describe('P2 durable-delivery S2-b — pure guards (no DB)', () => {
  const flagOn = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv
  const oneAdapterRegistry = () => {
    const r = new ConsumerAdapterRegistry()
    r.register(adapter('k', ok))
    return r
  }
  // a Queryable that MUST NOT be reached (validation/guards throw first).
  const unreachableDb: Queryable = {
    query: async () => {
      throw new Error('db must not be queried in this test')
    },
  }

  test('P1#2: normalizeAdapterVerdict maps the closed set; everything malformed → retry, never poison', () => {
    expect(normalizeAdapterVerdict({ outcome: 'success' })).toEqual({ action: 'complete' })
    expect(normalizeAdapterVerdict({ outcome: 'permanent_failure', reason: 'permanent_rejection' })).toEqual({
      action: 'poison',
      reason: 'permanent_rejection',
    })
    expect(normalizeAdapterVerdict({ outcome: 'retryable_failure', reason: 'adapter_timeout' })).toEqual({
      action: 'reschedule',
      reason: 'adapter_timeout',
    })
    // malformed shapes never poison:
    for (const bad of [{ outcome: 'bogus' }, { outcome: 'permanent_failure' }, { outcome: 'permanent_failure', reason: 'x' }, null, 42, 'success', undefined, {}]) {
      expect(normalizeAdapterVerdict(bad).action, JSON.stringify(bad)).not.toBe('poison')
    }
    expect(normalizeAdapterVerdict({ outcome: 'bogus' })).toEqual({ action: 'reschedule', reason: 'adapter_error' })
    expect(normalizeAdapterVerdict({ outcome: 'retryable_failure', reason: 'garbage' })).toEqual({ action: 'reschedule', reason: 'unknown' })
  })

  test('P2#4: startDurableDispatchLoop requires a telemetry sink', () => {
    expect(() => startDurableDispatchLoop(unreachableDb, oneAdapterRegistry(), undefined as unknown as DispatchLoopObserver, { env: flagOn })).toThrow(
      /telemetry sink/,
    )
    expect(() =>
      startDurableDispatchLoop(unreachableDb, oneAdapterRegistry(), { onUnknownConsumerKeys: () => {} } as unknown as DispatchLoopObserver, { env: flagOn }),
    ).toThrow(/telemetry sink/)
  })

  test('P2#5: illegal numeric knobs are rejected BEFORE any work (loop start + tick entry)', async () => {
    // intervalMs=0 would be a hot loop — rejected before the timer exists.
    expect(() => startDurableDispatchLoop(unreachableDb, oneAdapterRegistry(), noopObserver, { env: flagOn, intervalMs: 0 })).toThrow(/intervalMs/)
    // fractional / inverted backoff — rejected at loop start and at tick entry, before claim/side effects.
    expect(() => startDurableDispatchLoop(unreachableDb, oneAdapterRegistry(), noopObserver, { env: flagOn, retryBaseMs: 1.5 })).toThrow(/retryBaseMs/)
    expect(() => startDurableDispatchLoop(unreachableDb, oneAdapterRegistry(), noopObserver, { env: flagOn, retryBaseMs: 10, retryCapMs: 5 })).toThrow(
      /retryCapMs/,
    )
    await expect(runDispatchTick(unreachableDb, oneAdapterRegistry(), { adapterTimeoutMs: -1 })).rejects.toThrow(/adapterTimeoutMs/)
    await expect(runDispatchTick(unreachableDb, oneAdapterRegistry(), { batchSize: 2.5 })).rejects.toThrow(/batchSize/)
  })

  test('P2#4: a throwing observer.onTickError never becomes an unhandled rejection (loop survives a DB error)', async () => {
    const rejectingDb: Queryable = {
      query: async () => {
        throw new Error('db down')
      },
    }
    let tickErrorSeen = 0
    const observer: DispatchLoopObserver = {
      onUnknownConsumerKeys: () => {},
      onTickError: () => {
        tickErrorSeen += 1
        throw new Error('and the error sink is down too')
      },
    }
    const handle = startDurableDispatchLoop(rejectingDb, oneAdapterRegistry(), observer, { env: flagOn, intervalMs: 10 })
    try {
      const deadline = Date.now() + 2_000
      // eslint-disable-next-line no-unmodified-loop-condition
      while (Date.now() < deadline && tickErrorSeen === 0) {
        await new Promise((res2) => setTimeout(res2, 20))
      }
      expect(tickErrorSeen).toBeGreaterThan(0) // the error WAS surfaced to the sink...
    } finally {
      await handle.stop() // ...and the loop is still healthy enough to stop cleanly (no crash / unhandled rejection)
    }
  }, 10_000)
})
