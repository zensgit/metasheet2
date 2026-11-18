/**
 * Gate E (#4844) first batch — real-PostgreSQL four-state acceptance for the two converted
 * category-1 sites (a multi-statement boundary that `BEGIN`s on a CALLER-supplied connection
 * with no idle proof — on a dirty connection PostgreSQL only WARNs on the nested `BEGIN`, then
 * the function's own `COMMIT`/`ROLLBACK` acts on the CALLER's transaction):
 *
 *  1. `runAttendanceResultOperationTransactionV1` (w4c0-operation-registry.ts) —
 *     `BEGIN ISOLATION LEVEL SERIALIZABLE` then `COMMIT`, inside a bounded retry loop. On a dirty
 *     caller connection the `COMMIT` durably publishes the caller's uncommitted writes.
 *  2. `dispatchAttendanceResultEventOutboxV1` (w4c2-outbox-dispatcher.ts) — bare `BEGIN` then
 *     `COMMIT`, same class, no isolation pin.
 *
 * Both now require a protocol-observed idle managed checkout and an enforced session lease
 * before their first BEGIN. Borrowed states issue zero SQL, including no SAVEPOINT or cleanup.
 * The original positive, visibility and 3B001 recovery assertions remain; teardown-failure
 * cases now demand no callee savepoint rather than accepting a leftover removed by the caller.
 * Four baseline states per site, per the design lock (§D4):
 *   1. an open, READ-ONLY caller txn -> refused `W4C0_CONNECTION_NOT_IDLE`; the caller's txn is
 *      still open and usable afterward (neither committed nor rolled back by the callee).
 *   2. an open txn with UNCOMMITTED writes -> refused; the caller's row stays invisible to a
 *      SECOND connection while refused, visible only IN-TXN to the caller, and gone once the
 *      caller rolls back — the DISCRIMINATING case: pre-fix, the wrapped function's own `COMMIT`
 *      would durably publish that row regardless of what the caller intended.
 *   3. an idle connection -> POSITIVE CONTROL: the function succeeds and does its real work
 *      (without this, "it refuses" cannot be told apart from "it's broken").
 *   4. cleanup -- no idle-probe savepoint is created at all on refusal,
 *      not merely rolled back to (mirrors the P2-C proof in
 *      attendance-w4c5-rollout-transition-tool.db.test.ts): a caller-issued
 *      `RELEASE SAVEPOINT w4c5_idle_probe` afterward must fail 3B001 (does not exist), and the
 *      connection is otherwise fully usable once the caller rolls back its own txn.
 *
 * Wiring: same shared `metasheet_test` DB as the sibling
 * `attendance-w4c2-outbox-dispatcher.db.test.ts` (migrations already applied by the workflow's
 * `db:migrate` step; `attendance_result_operations` / `attendance_result_event_outbox` exist).
 * Additionally self-provisions ONE small, run-namespaced scratch table for the write-visibility
 * probe, since `runAttendanceResultOperationTransactionV1` is schema-agnostic (any `body`
 * callback) and the discriminating property (does this function's `COMMIT` durably publish an
 * uncommitted caller write) does not depend on any attendance-specific table.
 *
 * DATABASE_URL-gated (`describeDb`); excluded in `vitest.config.ts` and wired whole-file into the
 * attendance real-DB step in `plugin-tests.yml` (two-point wiring — see both files' comments at
 * this test's own entry).
 */
import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { AttendanceManagedPgPool as Pool, attendanceOwningSessionForClientV1, type AttendanceOwningSessionV1 } from '../../src/attendance/attendance-owning-session'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'
import {
  dispatchAttendanceResultEventOutboxV1,
  type AttendanceOutboxDeliveryV1,
} from '../../src/attendance/w4c2-outbox-dispatcher'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

// File-level fixture-ID namespace (per this repo's shared-DB discipline): every identifier below
// is derived from this ONE run tag, unique to this file's process invocation, so concurrently
// running sibling `.db.test.ts` files against the same shared DB cannot collide with it.
const RUN = `gateE1b1_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const PROBE_TABLE = `gate_e_batch1_probe_${RUN}`
const ORG = `${RUN}_org`
const FP = 'e'.repeat(64)

let pool: Pool
const traces: Array<ReturnType<typeof observeClient>> = []

function observeClient(client: PoolClient, rejectTeardown: boolean) {
  // Test-only access arms the old failure model below the managed dispatcher;
  // ownership still comes only from the real managed checkout and protocol.
  const raw = (pool as unknown as { _clients: Array<{
    processID: number
    connection: { query(sql: string): unknown; stream: { write(...args: unknown[]): unknown } }
  }> })._clients.find(candidate => candidate.processID === Reflect.get(client, 'processID'))
  if (!raw) throw new Error('GATE_E_PROTOCOL_FIXTURE_REQUIRED')
  const originalQuery = raw.connection.query.bind(raw.connection)
  const teardown = (sql: string) => {
    if (rejectTeardown && (sql === 'ROLLBACK TO SAVEPOINT w4c5_idle_probe'
      || sql === 'RELEASE SAVEPOINT w4c5_idle_probe')) throw new Error('GATE_E_SYNTHETIC_TEARDOWN_FAILURE')
  }
  if (rejectTeardown) {
    // Prove the failure is armed without sending a query or changing pg state.
    expect(() => teardown('ROLLBACK TO SAVEPOINT w4c5_idle_probe')).toThrow('GATE_E_SYNTHETIC_TEARDOWN_FAILURE')
    expect(() => teardown('RELEASE SAVEPOINT w4c5_idle_probe')).toThrow('GATE_E_SYNTHETIC_TEARDOWN_FAILURE')
  }
  const query = vi.spyOn(raw.connection, 'query').mockImplementation(sql => { teardown(sql); return originalQuery(sql) })
  const write = vi.spyOn(raw.connection.stream, 'write')
  const trace = { client, query, write, restore: () => { query.mockRestore(); write.mockRestore() } }
  traces.push(trace)
  return trace
}

function wrap(client: PoolClient): AttendanceOwningSessionV1 {
  observeClient(client, false)
  return attendanceOwningSessionForClientV1(client)
}

function wrapWithTeardownFailure(client: PoolClient): AttendanceOwningSessionV1 {
  observeClient(client, true)
  return attendanceOwningSessionForClientV1(client)
}

function assertNoCalleeSql(client: PoolClient) {
  const trace = traces.slice().reverse().find(candidate => candidate.client === client)
  if (!trace) throw new Error('GATE_E_PROTOCOL_TRACE_REQUIRED')
  expect(trace.query).not.toHaveBeenCalled()
  expect(trace.write).not.toHaveBeenCalled()
  trace.restore()
}

describeDb('Gate E (#4844) batch 1 — transaction-ownership idle precondition (real DB, four-state)', () => {
  const openClient = async (): Promise<PoolClient> => pool.connect()

  const probeRowCount = async (id: string): Promise<number> =>
    Number(
      (await pool.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE} WHERE id = $1`, [id])).rows[0].n,
    )

  const seedPendingOutboxRow = async (eventKind: string, payload: Record<string, unknown>): Promise<string> => {
    const id = randomUUID()
    const operationId = randomUUID()
    // Same FK shape as the sibling `attendance-w4c2-outbox-dispatcher.db.test.ts`'s
    // `seedPending`: W4C-2 amendment section 1.4's `fk_areo_operation` requires a real
    // (org_id, entrypoint, operation_id) row before any outbox row can reference it.
    await pool.query(
      `INSERT INTO attendance_result_operations (
          org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
          capability, subject_scope, command_fingerprint, accepted_write_posture, state, response_snapshot
        ) VALUES ($1,'live_punch',$2,'direct_live_punch','ref:gate-e-batch1',$3,'self','punch','{}'::jsonb,$4,'shadow','completed','{}'::jsonb)`,
      [ORG, operationId, `actor-${RUN}`, FP],
    )
    await pool.query(
      `INSERT INTO attendance_result_event_outbox
         (id, org_id, entrypoint, operation_id, identity_kind, event_kind, payload, payload_schema_version, business_key_fingerprint, delivery_state)
       VALUES ($1, $2, 'live_punch', $3, 'operation', $4, $5::jsonb, 1, $6, 'pending')`,
      [id, ORG, operationId, eventKind, JSON.stringify(payload), FP],
    )
    return id
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id uuid PRIMARY KEY, tag text NOT NULL)`,
    )
  })

  afterEach(() => {
    for (const trace of traces.splice(0)) trace.restore()
  })

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`).catch(() => undefined)
    await pool?.end().catch(() => undefined)
  })

  describe('site 1: runAttendanceResultOperationTransactionV1 (w4c0-operation-registry.ts)', () => {
    it('1. refuses on an open READ-ONLY caller txn; the caller txn stays open and intact (can still SELECT and COMMIT its own txn)', async () => {
      const client = await openClient()
      const body = vi.fn(async () => 'should-not-run')
      try {
        await client.query('BEGIN READ ONLY')
        await client.query('SELECT 1')
        await expect(runAttendanceResultOperationTransactionV1(wrap(client), body)).rejects.toMatchObject({
          code: 'W4C0_CONNECTION_NOT_IDLE',
        })
        assertNoCalleeSql(client)
        expect(body).not.toHaveBeenCalled()
        await expect(client.query('SELECT 1 AS still_alive')).resolves.toMatchObject({
          rows: [{ still_alive: 1 }],
        })
        await expect(client.query('COMMIT')).resolves.toBeDefined()
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it("2. refuses on an open txn with UNCOMMITTED writes — the caller's row stays invisible to a SECOND connection while refused, visible only IN-TXN to the caller, and gone once the caller rolls back (the DISCRIMINATING case: pre-fix, this function's own COMMIT would durably publish it)", async () => {
      const client = await openClient()
      const rowId = randomUUID()
      const body = vi.fn(async () => 'should-not-run')
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO ${PROBE_TABLE} (id, tag) VALUES ($1, $2)`, [rowId, 'site1-uncommitted'])
        await expect(runAttendanceResultOperationTransactionV1(wrap(client), body)).rejects.toMatchObject({
          code: 'W4C0_CONNECTION_NOT_IDLE',
        })
        assertNoCalleeSql(client)
        expect(body).not.toHaveBeenCalled()
        // A SECOND connection must not see the row — it is still uncommitted.
        expect(await probeRowCount(rowId)).toBe(0)
        // The caller's OWN connection, still inside its own open txn, still sees it.
        await expect(
          client.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE} WHERE id = $1`, [rowId]),
        ).resolves.toMatchObject({ rows: [{ n: 1 }] })
        await client.query('ROLLBACK')
        // After the caller rolls back its own txn, the row is gone everywhere.
        expect(await probeRowCount(rowId)).toBe(0)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it("3. positive control: an idle connection succeeds and COMMITs the body's real work", async () => {
      const client = await openClient()
      const rowId = randomUUID()
      try {
        const result = await runAttendanceResultOperationTransactionV1(wrap(client), async (trx) => {
          await trx.query(`INSERT INTO ${PROBE_TABLE} (id, tag) VALUES ($1, $2)`, [rowId, 'site1-idle-control'])
          return 'ok'
        })
        expect(result).toBe('ok')
        // Committed — visible from a second connection.
        expect(await probeRowCount(rowId)).toBe(1)
      } finally {
        client.release()
      }
    })

    it('4a. refusal creates no savepoint or SQL; caller RELEASE still fails 3B001 and caller rollback recovers', async () => {
      const client = await openClient()
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1')
        await expect(
          runAttendanceResultOperationTransactionV1(wrap(client), async () => 'should-not-run'),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        assertNoCalleeSql(client)
        // No callee savepoint was created; the same original 3B001 proof is stronger.
        await expect(client.query('RELEASE SAVEPOINT w4c5_idle_probe')).rejects.toMatchObject({
          code: '3B001',
        })
        // That failed RELEASE poisons the rest of the (still-open) transaction until ROLLBACK —
        // confirming this was a genuine SQL-level 3B001 on THIS connection, not a dropped/reset
        // connection silently answering something else.
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
        await client.query('ROLLBACK')
        await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it("4b. armed teardown failure cannot leave a callee savepoint: refusal sends zero SQL and preserves caller ownership", async () => {
      const client = await openClient()
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1')
        await expect(
          runAttendanceResultOperationTransactionV1(wrapWithTeardownFailure(client), async () => 'should-not-run'),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' }) // never the injected error
        assertNoCalleeSql(client)
        await expect(client.query('RELEASE SAVEPOINT w4c5_idle_probe')).rejects.toMatchObject({ code: '3B001' })
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
        await client.query('ROLLBACK')
        // Only the caller recovers its transaction after the intentional 3B001 check.
        await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })

  describe('site 2: dispatchAttendanceResultEventOutboxV1 (w4c2-outbox-dispatcher.ts)', () => {
    it('1. refuses on an open READ-ONLY caller txn; the caller txn stays open and intact (can still SELECT and COMMIT its own txn)', async () => {
      const client = await openClient()
      const emit = vi.fn()
      try {
        await client.query('BEGIN READ ONLY')
        await client.query('SELECT 1')
        await expect(dispatchAttendanceResultEventOutboxV1(wrap(client), { emit })).rejects.toMatchObject({
          code: 'W4C0_CONNECTION_NOT_IDLE',
        })
        assertNoCalleeSql(client)
        expect(emit).not.toHaveBeenCalled()
        await expect(client.query('SELECT 1 AS still_alive')).resolves.toMatchObject({
          rows: [{ still_alive: 1 }],
        })
        await expect(client.query('COMMIT')).resolves.toBeDefined()
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it("2. refuses on an open txn with UNCOMMITTED writes — the caller's row stays invisible to a SECOND connection while refused, visible only IN-TXN to the caller, and gone once the caller rolls back (the DISCRIMINATING case: pre-fix, this function's own COMMIT would durably publish it)", async () => {
      const client = await openClient()
      const rowId = randomUUID()
      const emit = vi.fn()
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO ${PROBE_TABLE} (id, tag) VALUES ($1, $2)`, [rowId, 'site2-uncommitted'])
        await expect(dispatchAttendanceResultEventOutboxV1(wrap(client), { emit })).rejects.toMatchObject({
          code: 'W4C0_CONNECTION_NOT_IDLE',
        })
        assertNoCalleeSql(client)
        expect(emit).not.toHaveBeenCalled()
        expect(await probeRowCount(rowId)).toBe(0)
        await expect(
          client.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE} WHERE id = $1`, [rowId]),
        ).resolves.toMatchObject({ rows: [{ n: 1 }] })
        await client.query('ROLLBACK')
        expect(await probeRowCount(rowId)).toBe(0)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('3. positive control: an idle connection dispatches a real pending row', async () => {
      const id = await seedPendingOutboxRow('attendance.punched', { probe: 'gate-e-batch1-idle', run: RUN })
      const client = await openClient()
      const emitted: AttendanceOutboxDeliveryV1[] = []
      try {
        const result = await dispatchAttendanceResultEventOutboxV1(wrap(client), {
          emit: (delivery) => {
            emitted.push(delivery)
          },
        })
        expect(result.delivered).toBeGreaterThanOrEqual(1)
        expect(emitted.some((e) => (e.payload as { run?: string })?.run === RUN)).toBe(true)
        await expect(
          pool.query('SELECT delivery_state FROM attendance_result_event_outbox WHERE id = $1', [id]),
        ).resolves.toMatchObject({ rows: [{ delivery_state: 'delivered' }] })
      } finally {
        client.release()
      }
    })

    it('4a. refusal creates no savepoint or SQL; caller RELEASE still fails 3B001 and caller rollback recovers', async () => {
      const client = await openClient()
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1')
        await expect(
          dispatchAttendanceResultEventOutboxV1(wrap(client), { emit: vi.fn() }),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        assertNoCalleeSql(client)
        await expect(client.query('RELEASE SAVEPOINT w4c5_idle_probe')).rejects.toMatchObject({
          code: '3B001',
        })
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
        await client.query('ROLLBACK')
        await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it("4b. armed teardown failure cannot leave a callee savepoint: refusal sends zero SQL and preserves caller ownership", async () => {
      const client = await openClient()
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1')
        await expect(
          dispatchAttendanceResultEventOutboxV1(wrapWithTeardownFailure(client), { emit: vi.fn() }),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' }) // never the injected error
        assertNoCalleeSql(client)
        await expect(client.query('RELEASE SAVEPOINT w4c5_idle_probe')).rejects.toMatchObject({ code: '3B001' })
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
        await client.query('ROLLBACK')
        await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })

  for (const site of ['registry', 'outbox'] as const) {
    const invoke = (session: AttendanceOwningSessionV1, callback: () => Promise<unknown>) => site === 'registry'
      ? runAttendanceResultOperationTransactionV1(session, callback)
      : dispatchAttendanceResultEventOutboxV1(session, { emit: callback })

    it(site + ': no-xid SERIALIZABLE READ ONLY and caller savepoint survive zero-SQL refusal', async () => {
      const client = await openClient()
      const callback = vi.fn(async () => undefined)
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY')
        await client.query('SAVEPOINT caller_owned')
        expect((await client.query('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows).toEqual([{ xid: null }])
        await expect(invoke(wrap(client), callback)).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        assertNoCalleeSql(client)
        expect(callback).not.toHaveBeenCalled()
        await client.query('ROLLBACK TO SAVEPOINT caller_owned')
        await client.query('RELEASE SAVEPOINT caller_owned')
        expect((await client.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }])
        await client.query('COMMIT')
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release() }
    })

    it(site + ': aborted caller writes and same-named caller savepoint are never cleaned or consumed', async () => {
      const client = await openClient()
      const rowId = randomUUID()
      const callback = vi.fn(async () => undefined)
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO ${PROBE_TABLE} (id, tag) VALUES ($1, $2)`, [rowId, 'aborted-caller'])
        await client.query('SAVEPOINT w4c5_idle_probe')
        await expect(client.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' })
        await expect(invoke(wrapWithTeardownFailure(client), callback)).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        assertNoCalleeSql(client)
        expect(callback).not.toHaveBeenCalled()
        expect(await probeRowCount(rowId)).toBe(0)
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
        await client.query('ROLLBACK TO SAVEPOINT w4c5_idle_probe')
        expect((await client.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE} WHERE id=$1`, [rowId])).rows).toEqual([{ n: 1 }])
        await client.query('RELEASE SAVEPOINT w4c5_idle_probe')
        await client.query('ROLLBACK')
        expect(await probeRowCount(rowId)).toBe(0)
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release() }
    })

    it(site + ': a BEGIN queued behind an in-flight query cannot pass idle admission', async () => {
      const client = await openClient()
      const blocker = await pool.connect()
      const key = RUN + ':' + site
      const callback = vi.fn(async () => undefined)
      let pending: Promise<unknown>[] = []
      try {
        await blocker.query('SELECT pg_advisory_lock(hashtext($1))', [key])
        const session = attendanceOwningSessionForClientV1(client)
        pending = [client.query('SELECT pg_advisory_lock(hashtext($1))', [key]), client.query('BEGIN')]
        observeClient(client, false)
        await expect(invoke(session, callback)).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        assertNoCalleeSql(client)
        expect(callback).not.toHaveBeenCalled()
        await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
        await Promise.all(pending)
        await client.query('SAVEPOINT caller_after_queue')
        await client.query('ROLLBACK TO SAVEPOINT caller_after_queue')
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
        await client.query('ROLLBACK')
      } finally {
        await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined)
        await Promise.allSettled(pending)
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined)
        await client.query('ROLLBACK').catch(() => undefined)
        blocker.release()
        client.release()
      }
    })
  }

  it('registry: actual owning lease excludes raw query and release while retaining the same backend', async () => {
    const client = await openClient()
    try {
      const pid = Reflect.get(client, 'processID')
      await runAttendanceResultOperationTransactionV1(attendanceOwningSessionForClientV1(client), async trx => {
        const trace = observeClient(client, false)
        await expect(client.query('COMMIT')).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        expect(() => client.release()).toThrowError(expect.objectContaining({ code: 'W4C0_CONNECTION_NOT_IDLE' }))
        expect(trace.write).not.toHaveBeenCalled()
        trace.restore()
        expect((await trx.query('SELECT pg_backend_pid() AS pid')).rows).toEqual([{ pid }])
      })
    } finally { client.release() }
  })

  it('outbox: the real emit callback cannot commit or release the dispatcher session', async () => {
    const eventKind = 'attendance.punched'
    const id = await seedPendingOutboxRow(eventKind, { run: RUN, probe: 'lease-fence' })
    const client = await openClient()
    let checked = 0
    try {
      await dispatchAttendanceResultEventOutboxV1(attendanceOwningSessionForClientV1(client), {
        emit: async delivery => {
          if ((delivery.payload as { probe?: string }).probe !== 'lease-fence') return
          const trace = observeClient(client, false)
          await expect(client.query('COMMIT')).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
          expect(() => client.release()).toThrowError(expect.objectContaining({ code: 'W4C0_CONNECTION_NOT_IDLE' }))
          expect(trace.write).not.toHaveBeenCalled()
          trace.restore()
          checked += 1
        },
      })
      expect(checked).toBe(1)
      expect((await pool.query('SELECT delivery_state FROM attendance_result_event_outbox WHERE id=$1', [id])).rows)
        .toEqual([{ delivery_state: 'delivered' }])
    } finally { client.release() }
  })
})
