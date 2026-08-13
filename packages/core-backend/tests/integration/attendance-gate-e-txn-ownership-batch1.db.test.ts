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
 * Both now call the EXISTING exported `assertConnectionIsIdleV1` (w4c0-identity.ts) before their
 * first `BEGIN` — no new probe was written. Four states per site, per the design lock (§D4):
 *   1. an open, READ-ONLY caller txn -> refused `W4C0_CONNECTION_NOT_IDLE`; the caller's txn is
 *      still open and usable afterward (neither committed nor rolled back by the callee).
 *   2. an open txn with UNCOMMITTED writes -> refused; the caller's row stays invisible to a
 *      SECOND connection while refused, visible only IN-TXN to the caller, and gone once the
 *      caller rolls back — the DISCRIMINATING case: pre-fix, the wrapped function's own `COMMIT`
 *      would durably publish that row regardless of what the caller intended.
 *   3. an idle connection -> POSITIVE CONTROL: the function succeeds and does its real work
 *      (without this, "it refuses" cannot be told apart from "it's broken").
 *   4. cleanup -- the idle probe's own `SAVEPOINT w4c5_idle_probe` is fully RELEASEd on refusal,
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
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'
import {
  dispatchAttendanceResultEventOutboxV1,
  type AttendanceOutboxDeliveryV1,
} from '../../src/attendance/w4c2-outbox-dispatcher'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

// File-level fixture-ID namespace (per this repo's shared-DB discipline): every identifier below
// is derived from this ONE run tag, unique to this file's process invocation, so concurrently
// running sibling `.db.test.ts` files against the same shared DB cannot collide with it.
const RUN = `gateE1b1_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const PROBE_TABLE = `gate_e_batch1_probe_${RUN}`
const ORG = `${RUN}_org`
const FP = 'e'.repeat(64)

function wrap(client: Client): AttendanceW4TransactionClientV1 {
  return {
    query: async (sqlText: string, params?: unknown[]) => {
      const result = await client.query(sqlText, params)
      return { rows: (result.rows ?? []) as Array<Record<string, unknown>> }
    },
  }
}

describeDb('Gate E (#4844) batch 1 — transaction-ownership idle precondition (real DB, four-state)', () => {
  let pool: Pool

  const openClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    return client
  }

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

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`).catch(() => undefined)
    await pool?.end().catch(() => undefined)
  })

  describe('site 1: runAttendanceResultOperationTransactionV1 (w4c0-operation-registry.ts)', () => {
    it('1. refuses on an open READ-ONLY caller txn; the caller txn stays open and intact (can still SELECT and COMMIT its own txn)', async () => {
      const client = await openClient()
      const body = vi.fn(async () => 'should-not-run')
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1')
        await expect(runAttendanceResultOperationTransactionV1(wrap(client), body)).rejects.toMatchObject({
          code: 'W4C0_CONNECTION_NOT_IDLE',
        })
        expect(body).not.toHaveBeenCalled()
        await expect(client.query('SELECT 1 AS still_alive')).resolves.toMatchObject({
          rows: [{ still_alive: 1 }],
        })
        await expect(client.query('COMMIT')).resolves.toBeDefined()
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        await client.end()
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
        await client.end()
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
        await client.end()
      }
    })

    it('4. cleanup: on refusal the idle probe has already RELEASEd its own savepoint — a caller RELEASE afterward fails 3B001, and the connection is fully usable once the caller rolls back', async () => {
      const client = await openClient()
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1')
        await expect(
          runAttendanceResultOperationTransactionV1(wrap(client), async () => 'should-not-run'),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        // The guard already RELEASEd `w4c5_idle_probe` — a second RELEASE must fail with 3B001
        // (invalid_savepoint_specification), proving cleanup rather than merely documenting it.
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
        await client.end()
      }
    })
  })

  describe('site 2: dispatchAttendanceResultEventOutboxV1 (w4c2-outbox-dispatcher.ts)', () => {
    it('1. refuses on an open READ-ONLY caller txn; the caller txn stays open and intact (can still SELECT and COMMIT its own txn)', async () => {
      const client = await openClient()
      const emit = vi.fn()
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1')
        await expect(dispatchAttendanceResultEventOutboxV1(wrap(client), { emit })).rejects.toMatchObject({
          code: 'W4C0_CONNECTION_NOT_IDLE',
        })
        expect(emit).not.toHaveBeenCalled()
        await expect(client.query('SELECT 1 AS still_alive')).resolves.toMatchObject({
          rows: [{ still_alive: 1 }],
        })
        await expect(client.query('COMMIT')).resolves.toBeDefined()
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        await client.end()
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
        expect(emit).not.toHaveBeenCalled()
        expect(await probeRowCount(rowId)).toBe(0)
        await expect(
          client.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE} WHERE id = $1`, [rowId]),
        ).resolves.toMatchObject({ rows: [{ n: 1 }] })
        await client.query('ROLLBACK')
        expect(await probeRowCount(rowId)).toBe(0)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        await client.end()
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
        await client.end()
      }
    })

    it('4. cleanup: on refusal the idle probe has already RELEASEd its own savepoint — a caller RELEASE afterward fails 3B001, and the connection is fully usable once the caller rolls back', async () => {
      const client = await openClient()
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1')
        await expect(
          dispatchAttendanceResultEventOutboxV1(wrap(client), { emit: vi.fn() }),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        await expect(client.query('RELEASE SAVEPOINT w4c5_idle_probe')).rejects.toMatchObject({
          code: '3B001',
        })
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
        await client.query('ROLLBACK')
        await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        await client.end()
      }
    })
  })
})
