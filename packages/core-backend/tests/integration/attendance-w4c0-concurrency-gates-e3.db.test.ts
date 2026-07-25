/**
 * W4C-0 (#4556) Stage E3 — section 12.1 dual-connection concurrency gates
 * against real Postgres. Every leg constructs a REAL race: two (or three) live
 * connections, the waiter proven blocked in pg_locks before the holder side
 * commits/rolls back, both commit orders where the gate names them
 * (feedback_toctou_needs_constructed_race — sequential argument is not proof).
 *
 * Legs (lock section 12.1):
 *  1. two concurrent first claims of the same single operation — first holder
 *     commits within the lock budget, waiter returns the ONE stored response
 *     with exactly one effect;
 *  2. same for an all-new import batch (order vector replay, one batch row);
 *  3. holder beyond the waiter's budget — values-free 409
 *     ATTENDANCE_OPERATION_IN_PROGRESS with zero extra DML, no raw 23505/55P03,
 *     later retry returns the stored response;
 *  4. multi-key helper deadline — first final key blocked under budget, second
 *     key exhausts the cumulative budget within ONE helper budget; success after
 *     the blockers release restores the contract lock_timeout;
 *  5. helper-origin budget-expiry legs (before next query = zero SQL; after the
 *     final acquisition) map to the same closed code as the helper's own 55P03;
 *  6. null-version legacy worker — source effect + terminal job status commit
 *     atomically under the rollout SHARED lock; a two-connection transition
 *     waits on the exclusive lock and can never observe terminal-without-effect;
 *     failure after source DML leaves the job nonterminal with zero effect;
 *  7. org rollout shared/exclusive — a null-ID legacy source holding shared
 *     makes the transition wait and re-evaluate after its commit; a transition
 *     holding exclusive makes the source resolve/freeze the NEW posture only
 *     after release;
 *  8. P07 enqueue versus rollout transition in both race orders — enqueue-first
 *     makes the transition wait then see the committed retryable job;
 *     transition-first makes the enqueue freeze only the new posture, and a
 *     suspension yields blocked posture with zero job row;
 *  9. P07 enqueue versus a synchronous caller on the same batch identity in
 *     both commit orders — exactly one side reserves the tuple; the waiter
 *     re-reads under the class-`10` locks and fails closed with zero
 *     conflicting DML;
 * 10. incomplete stable-ID operation versus rollout transition — the common
 *     rollout -> operation-identity-advisory -> operation-row order completes
 *     without deadlock or bounded-retry exhaustion.
 *
 * The worker/enqueue driving code in legs 6-8 is a PROTOCOL HARNESS (W4C-0 has
 * zero caller cutover; the production worker/transition writers are later
 * slices) — the two-connection lock/atomicity/visibility assertions are real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Pool, type PoolClient } from 'pg'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceResultOperationLocks,
  buildAttendanceResultOperationAdvisoryKey,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  __setAttendanceW4MonotonicClockForTests,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOperationIdentityV1,
} from '../../src/attendance/w4c0-identity'
import {
  createAuthorizedAttendanceWriteContextV1,
  type AuthorizedAttendanceWriteContextV1,
} from '../../src/attendance/w4c0-authorization'
import {
  attendanceResultOperationPreflightV1,
  reserveAttendanceImportJobW4V1,
  sealAttendanceResultOperationBatchV1,
  sealAttendanceResultOperationV1,
} from '../../src/attendance/w4c0-operation-registry'
import { AttendanceW4OperationError } from '../../src/attendance/w4c0-operation-contract'
import { normalizeAttendanceSourceOperationEnvelopeV1 } from '../../src/attendance/w4c0-source-commands'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

// File-namespaced fixtures (shared DB, append-only registries): per-run random
// org/user/operation IDs so nothing collides across runs or with other files.
const RUN = crypto.randomUUID().slice(0, 8)
const ACTOR = `w4c0-e3-actor-${RUN}`
const ENV_KEY = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const HEX64_C = 'c'.repeat(64)

// One org per leg family (rollout state is one row per org and legal transitions
// are one-way, so legs must not share a rollout lifecycle).
const ORG_CLAIM = crypto.randomUUID() // legs 1-3, 10 (persisted shadow)
const ORG_KEYS = crypto.randomUUID() // legs 4-5 (persisted shadow; helper-only)
const ORG_WORKER = crypto.randomUUID() // leg 6 commit order (legacy: no rollout row)
const ORG_WORKER_RB = crypto.randomUUID() // leg 6 rollback order (legacy)
const ORG_SOURCE_SHARED = crypto.randomUUID() // leg 7a (legacy at start)
const ORG_TRANSITION_FIRST = crypto.randomUUID() // leg 7b (no row -> shadow inserted mid-test)
const ORG_ENQ_TRANS = crypto.randomUUID() // leg 8 order 1 (persisted shadow)
const ORG_ENQ_FREEZE = crypto.randomUUID() // leg 8 order 2 + suspension (walked to eligible)
const ORG_RACE = crypto.randomUUID() // leg 9 (persisted shadow)

const ALLOWLISTED_ORGS = [
  ORG_CLAIM,
  ORG_KEYS,
  ORG_TRANSITION_FIRST,
  ORG_ENQ_TRANS,
  ORG_ENQ_FREEZE,
  ORG_RACE,
]

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (sqlText, params) =>
      client.query(sqlText, params as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>,
  }
}

/** Transaction wrapper that counts every SQL statement issued through it. */
function countingTrx(client: PoolClient): { t: AttendanceW4TransactionClientV1; issued: () => number } {
  let n = 0
  return {
    t: {
      query: (sqlText, params) => {
        n += 1
        return client.query(sqlText, params as unknown[]) as unknown as Promise<{
          rows: Array<Record<string, unknown>>
        }>
      },
    },
    issued: () => n,
  }
}

function mintAuth(orgId: string, overrides: Partial<Record<string, unknown>> = {}): AuthorizedAttendanceWriteContextV1 {
  return createAuthorizedAttendanceWriteContextV1({
    actorId: ACTOR,
    actorPosture: 'self',
    tokenSubjectUserId: ACTOR,
    orgId,
    subjectScope: { kind: 'self', userId: ACTOR },
    capability: 'punch',
    sourceRef: 'test:w4c0-e3',
    ...overrides,
  })
}

function mintImportAuth(orgId: string): AuthorizedAttendanceWriteContextV1 {
  return mintAuth(orgId, {
    actorPosture: 'delegated_import',
    tokenSubjectUserId: null,
    subjectScope: { kind: 'explicit_users', userIds: [ACTOR] },
    capability: 'import',
  })
}

function livePunchEnvelope(orgId: string, operationId: string | null, occurredAt = '2026-03-05T01:00:00Z') {
  return normalizeAttendanceSourceOperationEnvelopeV1({
    schemaVersion: 1,
    orgId,
    correlationId: `corr-e3-${RUN}`,
    command: {
      schemaVersion: 1,
      kind: 'live_punch',
      subjectUserId: ACTOR,
      operationId,
      payload: {
        eventType: 'check_in',
        occurredAt,
        timezone: 'Asia/Shanghai',
        source: 'mobile',
        location: null,
        meta: null,
        photoFileRef: null,
      },
    },
    batch: null,
  })
}

function importBatchEnvelope(orgId: string, batchCommandId: string, fingerprints: readonly string[]) {
  return normalizeAttendanceSourceOperationEnvelopeV1({
    schemaVersion: 1,
    orgId,
    correlationId: `corr-e3-batch-${RUN}`,
    command: null,
    batch: {
      schemaVersion: 1,
      kind: 'import_batch',
      payload: { batchCommandId, transportKind: 'csv_upload', batchFingerprint: HEX64_A },
      items: fingerprints.map((semanticFingerprint, index) => ({
        ordinal: index,
        subjectUserId: ACTOR,
        semanticFingerprint,
        normalizedBusinessInput: { row: index, present: ['status'] },
      })),
    },
  })
}

describeIfDatabase('W4C-0 Stage E3 — dual-connection concurrency gates (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl, max: 10 })
  let priorEnv: string | undefined

  beforeAll(async () => {
    priorEnv = process.env[ENV_KEY]
    process.env[ENV_KEY] = ALLOWLISTED_ORGS.join(',')
    await pool.query(`INSERT INTO users (id, password_hash) VALUES ($1, '') ON CONFLICT (id) DO NOTHING`, [ACTOR])
    const allOrgs = [
      ...ALLOWLISTED_ORGS,
      ORG_WORKER,
      ORG_WORKER_RB,
      ORG_SOURCE_SHARED,
    ]
    for (const org of allOrgs) {
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [ACTOR, org],
      )
    }
    // Persisted shadow rollout rows (legal initial INSERT: shadow with prior legacy, v1).
    for (const org of [ORG_CLAIM, ORG_KEYS, ORG_ENQ_TRANS, ORG_ENQ_FREEZE, ORG_RACE]) {
      await pool.query(
        `INSERT INTO attendance_calculation_rollout_state
           (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
         VALUES ($1, 'shadow', 'w4c0-e3', 'TEST_FIXTURE', $2, 1, 'legacy', 'synthetic_staging')
         ON CONFLICT (org_id) DO NOTHING`,
        [org, ACTOR],
      )
    }
    // ORG_ENQ_FREEZE walks one legal edge further: shadow -> eligible (v2), so the
    // in-test transition eligible -> authoritative changes the NORMALIZED posture
    // (shadow -> authoritative) — the discriminating freeze for leg 8 order 2.
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'eligible', prior_state = 'shadow', version = 2        WHERE org_id = $1`,
      [ORG_ENQ_FREEZE],
    )
  }, 60000)

  afterAll(async () => {
    if (priorEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = priorEnv
    __setAttendanceW4MonotonicClockForTests(null)
    await pool.end()
  })

  async function backendPid(client: PoolClient): Promise<number> {
    const res = await client.query('SELECT pg_backend_pid() AS pid')
    return Number(res.rows[0].pid)
  }

  /** Real-blocked proof: poll pg_locks until `pid` has an ungranted advisory wait. */
  async function waitUntilAdvisoryBlocked(pid: number, timeoutMs = 8000): Promise<void> {
    const start = Date.now()
    for (;;) {
      const res = await pool.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted = false`,
        [pid],
      )
      if ((res.rows[0] as { n: number }).n > 0) return
      if (Date.now() - start > timeoutMs) throw new Error('waiter never blocked on an advisory lock')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  async function opCount(orgId: string, whereSql: string, params: unknown[]): Promise<number> {
    const res = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1 AND ${whereSql}`,
      [orgId, ...params],
    )
    return (res.rows[0] as { n: number }).n
  }

  // -------------------------------------------------------------------------
  // Leg 1 — two concurrent first claims, single operation, holder commits
  // within the budget.
  // -------------------------------------------------------------------------
  it('two concurrent first claims (single operation): waiter blocks, then returns the ONE stored response with exactly one effect and zero extra DML', async () => {
    const operationId = crypto.randomUUID()
    const envelope = livePunchEnvelope(ORG_CLAIM, operationId)
    const holder = await pool.connect()
    const waiter = await pool.connect()
    const surfaced: unknown[] = []
    try {
      await holder.query('BEGIN')
      const claimed = await attendanceResultOperationPreflightV1(trx(holder), mintAuth(ORG_CLAIM), envelope.registryInput)
      expect(claimed.kind).toBe('claimed')

      await waiter.query('BEGIN')
      const waiterPid = await backendPid(waiter)
      const waiterPromise = attendanceResultOperationPreflightV1(
        trx(waiter),
        mintAuth(ORG_CLAIM),
        envelope.registryInput,
      ).catch((error) => {
        surfaced.push(error)
        throw error
      })
      // Constructed race: the waiter is REALLY blocked on the class-`10` advisory
      // lock before the holder seals/commits.
      await waitUntilAdvisoryBlocked(waiterPid)

      if (claimed.kind === 'claimed') {
        await sealAttendanceResultOperationV1(trx(holder), claimed.itemIdentities[0], {
          responseSnapshot: { ok: true, eventId: `evt-e3-${RUN}` },
        })
      }
      await holder.query('COMMIT')

      const replay = await waiterPromise
      expect(replay.kind).toBe('replay')
      if (replay.kind === 'replay') {
        expect(replay.responses.itemResponses[operationId]).toEqual({ ok: true, eventId: `evt-e3-${RUN}` })
        expect(replay.responses.batchResponse).toBeNull()
      }
      await waiter.query('COMMIT')
    } finally {
      holder.release()
      waiter.release()
    }
    expect(surfaced).toEqual([])
    // Exactly ONE effect: one completed operation row for the key, ever.
    expect(await opCount(ORG_CLAIM, 'operation_id = $2::uuid', [operationId])).toBe(1)
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 2 — two concurrent first claims, all-new batch.
  // -------------------------------------------------------------------------
  it('two concurrent first claims (all-new batch): waiter blocks, then replays the committed order vector; exactly one batch row and one item set', async () => {
    const batchRoot = crypto.randomUUID()
    const envelope = importBatchEnvelope(ORG_CLAIM, batchRoot, [HEX64_A, HEX64_B])
    const auth = () => mintImportAuth(ORG_CLAIM)
    const holder = await pool.connect()
    const waiter = await pool.connect()
    const surfaced: unknown[] = []
    let itemIds: string[] = []
    try {
      await holder.query('BEGIN')
      const claimed = await attendanceResultOperationPreflightV1(trx(holder), auth(), envelope.registryInput)
      expect(claimed.kind).toBe('claimed')

      await waiter.query('BEGIN')
      const waiterPid = await backendPid(waiter)
      const waiterPromise = attendanceResultOperationPreflightV1(trx(waiter), auth(), envelope.registryInput).catch(
        (error) => {
          surfaced.push(error)
          throw error
        },
      )
      await waitUntilAdvisoryBlocked(waiterPid)

      if (claimed.kind === 'claimed') {
        itemIds = claimed.itemIdentities.map((identity) => identity.id as string)
        for (const identity of claimed.itemIdentities) {
          await sealAttendanceResultOperationV1(trx(holder), identity, {
            responseSnapshot: { imported: identity.id },
          })
        }
        await sealAttendanceResultOperationBatchV1(trx(holder), claimed.batchIdentity, {
          order: itemIds,
          byItem: Object.fromEntries(itemIds.map((id) => [id, { imported: id }])),
        })
      }
      await holder.query('COMMIT')

      const replay = await waiterPromise
      expect(replay.kind).toBe('replay')
      if (replay.kind === 'replay') {
        expect((replay.responses.batchResponse as { order: string[] }).order).toEqual(itemIds)
        expect(Object.keys(replay.responses.itemResponses).sort()).toEqual([...itemIds].sort())
      }
      await waiter.query('COMMIT')
    } finally {
      holder.release()
      waiter.release()
    }
    expect(surfaced).toEqual([])
    const batches = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_result_operation_batches WHERE org_id = $1 AND batch_command_id = $2::uuid`,
      [ORG_CLAIM, batchRoot],
    )
    expect(batches.rows[0].n).toBe(1)
    expect(await opCount(ORG_CLAIM, 'batch_command_id = $2::uuid', [batchRoot])).toBe(2)
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 3 — holder beyond the waiter's budget: values-free 409, zero extra DML,
  // no raw SQLSTATE, later retry replays.
  // -------------------------------------------------------------------------
  it('first-claim holder beyond the lock budget: waiter returns values-free 409 IN_PROGRESS with zero extra DML and no raw 23505/55P03; its later retry returns the stored response', async () => {
    const operationId = crypto.randomUUID()
    const envelope = livePunchEnvelope(ORG_CLAIM, operationId)
    const holder = await pool.connect()
    const waiter = await pool.connect()
    try {
      await holder.query('BEGIN')
      const claimed = await attendanceResultOperationPreflightV1(trx(holder), mintAuth(ORG_CLAIM), envelope.registryInput)
      expect(claimed.kind).toBe('claimed')

      // The waiter's helper budget is nearly exhausted via the module-private
      // monotonic test clock: rollout helper (calls 1-3) at t=0, operation
      // helper entry (call 4) at t=0, first per-key check (call 5) at t=4990 —
      // 10ms of real lock_timeout against a holder that never commits inside it.
      await waiter.query('BEGIN')
      const script = [0, 0, 0, 0, 4990]
      let calls = 0
      __setAttendanceW4MonotonicClockForTests(() => {
        const value = script[Math.min(calls, script.length - 1)]
        calls += 1
        return value
      })
      let caught: unknown
      try {
        await attendanceResultOperationPreflightV1(trx(waiter), mintAuth(ORG_CLAIM), envelope.registryInput)
      } catch (error) {
        caught = error
      } finally {
        __setAttendanceW4MonotonicClockForTests(null)
      }
      expect(caught).toBeInstanceOf(AttendanceW4OperationError)
      const busy = caught as AttendanceW4OperationError
      expect(busy.code).toBe('ATTENDANCE_OPERATION_IN_PROGRESS')
      expect(busy.httpStatus).toBe(409)
      // Values-free: the message is exactly the closed code — no SQLSTATE, no
      // key material, no org/operation value.
      expect(busy.message).toBe('ATTENDANCE_OPERATION_IN_PROGRESS')
      expect(busy.message).not.toContain('55P03')
      expect(busy.message).not.toContain('23505')
      await waiter.query('ROLLBACK')

      // Zero extra DML: nothing committed for the key while the holder is open.
      expect(await opCount(ORG_CLAIM, 'operation_id = $2::uuid', [operationId])).toBe(0)

      if (claimed.kind === 'claimed') {
        await sealAttendanceResultOperationV1(trx(holder), claimed.itemIdentities[0], {
          responseSnapshot: { ok: true, slow: true },
        })
      }
      await holder.query('COMMIT')

      // The busy waiter's LATER retry returns the stored response.
      await waiter.query('BEGIN')
      const retry = await attendanceResultOperationPreflightV1(trx(waiter), mintAuth(ORG_CLAIM), envelope.registryInput)
      expect(retry.kind).toBe('replay')
      if (retry.kind === 'replay') {
        expect(retry.responses.itemResponses[operationId]).toEqual({ ok: true, slow: true })
      }
      await waiter.query('COMMIT')
    } finally {
      holder.release()
      waiter.release()
    }
    expect(await opCount(ORG_CLAIM, 'operation_id = $2::uuid', [operationId])).toBe(1)
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 4 — multi-key deadline: first key under budget, second key exhausts the
  // cumulative budget; ONE helper budget, not one per key.
  // -------------------------------------------------------------------------
  it('multi-key helper deadline: first final key blocked under budget, second key exhausts the cumulative budget within ONE helper budget; success after release restores the contract lock_timeout', async () => {
    const waiterClient = await pool.connect()
    const blocker1 = await pool.connect()
    const blocker2 = await pool.connect()
    try {
      // Mint two verified identities on the waiter connection (rollout shared
      // lock + resolver + factories) BEFORE any clock scripting.
      await waiterClient.query('BEGIN')
      const t = trx(waiterClient)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_KEYS)
      await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
      const posture = await resolveSegmentCalculationPosture(t, ORG_KEYS)
      const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_KEYS, posture })
      const mkIdentity = (clientOperationId: string): VerifiedAttendanceOperationIdentityV1 =>
        createVerifiedAttendanceOperationIdentityV1({
          org,
          kind: 'item',
          entrypoint: 'live_punch',
          source: { sourceKind: 'direct_live_punch', clientOperationId },
        })
      const idA = mkIdentity(crypto.randomUUID())
      const idB = mkIdentity(crypto.randomUUID())
      const keyA = buildAttendanceResultOperationAdvisoryKey(idA)
      const keyB = buildAttendanceResultOperationAdvisoryKey(idB)
      // Numeric signed order decides the helper's acquisition order.
      const [firstKey, secondKey] = keyA < keyB ? [keyA, keyB] : [keyB, keyA]

      await blocker1.query('BEGIN')
      await blocker1.query('SELECT pg_advisory_xact_lock($1::bigint)', [firstKey.toString()])
      await blocker2.query('BEGIN')
      await blocker2.query('SELECT pg_advisory_xact_lock($1::bigint)', [secondKey.toString()])

      // Clock script for the helper under test (entry, before-key1, after-key1,
      // before-key2): the first key "waits" a simulated 3000ms (< 5000 budget,
      // real wait ~300ms until blocker1 releases), so the second key gets only
      // the REMAINING 2000ms of the one helper-wide budget — with a per-key
      // budget reset it would get a fresh 5000ms.
      const script = [0, 0, 3000, 3000]
      let calls = 0
      __setAttendanceW4MonotonicClockForTests(() => {
        const value = script[Math.min(calls, script.length - 1)]
        calls += 1
        return value
      })
      const releaseTimer = setTimeout(() => {
        void blocker1.query('ROLLBACK').catch(() => undefined)
      }, 300)
      const started = Date.now()
      let caught: unknown
      try {
        await acquireAttendanceResultOperationLocks(t, [idA, idB])
      } catch (error) {
        caught = error
      } finally {
        clearTimeout(releaseTimer)
        __setAttendanceW4MonotonicClockForTests(null)
      }
      const elapsed = Date.now() - started
      expect(caught).toBeInstanceOf(AttendanceW4OperationError)
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_IN_PROGRESS')
      expect((caught as AttendanceW4OperationError).message).not.toContain('55P03')
      // ONE helper budget: the second key had ~2000ms remaining (300ms real wait
      // for key1 + ~2000ms for key2). A per-key reset would wait the full 5000ms
      // on key2 (~5300ms total) — the elapsed bound discriminates the two.
      expect(elapsed).toBeGreaterThanOrEqual(1500)
      expect(elapsed).toBeLessThan(4500)
      // The failed helper performed zero DML (lock SQL only): nothing to roll
      // back, but the transaction is poisoned by 55P03 — roll it back.
      await waiterClient.query('ROLLBACK')

      // After the blockers release, a fresh attempt succeeds and restores the
      // contract lock timeout (5000ms).
      await blocker2.query('ROLLBACK')
      await waiterClient.query('BEGIN')
      const t2 = trx(waiterClient)
      await acquireAttendanceCalculationRolloutLock(t2, orgKey, 'shared')
      const posture2 = await resolveSegmentCalculationPosture(t2, ORG_KEYS)
      const org2 = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_KEYS, posture: posture2 })
      const idA2 = createVerifiedAttendanceOperationIdentityV1({
        org: org2,
        kind: 'item',
        entrypoint: 'live_punch',
        source: { sourceKind: 'direct_live_punch', clientOperationId: crypto.randomUUID() },
      })
      await acquireAttendanceResultOperationLocks(t2, [idA2])
      const timeout = await waiterClient.query('SHOW lock_timeout')
      expect(timeout.rows[0].lock_timeout).toBe('5s')
      await waiterClient.query('ROLLBACK')
    } finally {
      await blocker1.query('ROLLBACK').catch(() => undefined)
      await blocker2.query('ROLLBACK').catch(() => undefined)
      waiterClient.release()
      blocker1.release()
      blocker2.release()
    }
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 5 — helper-origin budget expiry on both check sites maps to the SAME
  // closed code as the helper's own 55P03.
  // -------------------------------------------------------------------------
  it('helper-origin budget expiry: exhausted before the next acquisition query issues ZERO SQL; exhausted immediately after the final acquisition; both map to the same closed code', async () => {
    await withClient(async (client) => {
      await client.query('BEGIN')
      const t = trx(client)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_KEYS)
      await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
      const posture = await resolveSegmentCalculationPosture(t, ORG_KEYS)
      const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_KEYS, posture })
      const identity = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'live_punch',
        source: { sourceKind: 'direct_live_punch', clientOperationId: crypto.randomUUID() },
      })

      // (a) Budget exhausted BEFORE issuing the next acquisition query: the
      // helper throws its typed busy error without a single SQL statement.
      const counting = countingTrx(client)
      const scriptA = [0, 6000]
      let callsA = 0
      __setAttendanceW4MonotonicClockForTests(() => {
        const value = scriptA[Math.min(callsA, scriptA.length - 1)]
        callsA += 1
        return value
      })
      let caughtA: unknown
      try {
        await acquireAttendanceResultOperationLocks(counting.t, [identity])
      } catch (error) {
        caughtA = error
      } finally {
        __setAttendanceW4MonotonicClockForTests(null)
      }
      expect((caughtA as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_IN_PROGRESS')
      expect(counting.issued()).toBe(0)

      // (b) Budget exhausted IMMEDIATELY AFTER the final acquisition (the key
      // itself was granted — uncontended — but the deadline passed during it).
      const scriptB = [0, 0, 6000]
      let callsB = 0
      __setAttendanceW4MonotonicClockForTests(() => {
        const value = scriptB[Math.min(callsB, scriptB.length - 1)]
        callsB += 1
        return value
      })
      let caughtB: unknown
      try {
        await acquireAttendanceResultOperationLocks(t, [identity])
      } catch (error) {
        caughtB = error
      } finally {
        __setAttendanceW4MonotonicClockForTests(null)
      }
      expect((caughtB as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_IN_PROGRESS')
      // Same closed code on both helper-origin sites AND on the helper's own
      // 55P03 path (legs 3/4) — one values-free busy surface.
      expect((caughtA as AttendanceW4OperationError).code).toBe((caughtB as AttendanceW4OperationError).code)
      await client.query('ROLLBACK')
    })
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 6 — null-version legacy worker: terminal-without-effect is unobservable.
  // -------------------------------------------------------------------------
  it('null-version legacy worker: source effect + terminal status commit atomically under the rollout SHARED lock; a transition waits on exclusive and never observes terminal-without-effect; failure leaves the job nonterminal with zero effect', async () => {
    const setupJob = async (org: string): Promise<string> => {
      const res = await pool.query(
        `INSERT INTO attendance_import_jobs (org_id, batch_id, created_by, status, progress, total, payload)
         VALUES ($1, $2::uuid, $3, 'processing', 0, 1, '{"legacy":true}'::jsonb) RETURNING id::text AS id`,
        [org, crypto.randomUUID(), ACTOR],
      )
      return (res.rows[0] as { id: string }).id
    }
    const effectCount = async (org: string): Promise<number> => {
      const res = await pool.query(`SELECT count(*)::int AS n FROM attendance_records WHERE org_id = $1`, [org])
      return (res.rows[0] as { n: number }).n
    }
    const jobStatus = async (jobId: string): Promise<string> => {
      const res = await pool.query(`SELECT status FROM attendance_import_jobs WHERE id = $1::uuid`, [jobId])
      return String((res.rows[0] as { status: string }).status)
    }

    // --- Commit order: worker commits; the waiting transition then sees BOTH. ---
    const jobId = await setupJob(ORG_WORKER)
    const worker = await pool.connect()
    const transition = await pool.connect()
    try {
      await worker.query('BEGIN')
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_WORKER)
      await acquireAttendanceCalculationRolloutLock(trx(worker), orgKey, 'shared')
      // Null-version worker protocol: source effect + terminal status in ONE
      // transaction under the shared lock.
      await worker.query(
        `INSERT INTO attendance_records (user_id, work_date, org_id, status, work_minutes, late_minutes, early_leave_minutes)
         VALUES ($1, '2026-03-06', $2, 'normal', 480, 0, 0)`,
        [ACTOR, ORG_WORKER],
      )
      await worker.query(`UPDATE attendance_import_jobs SET status = 'completed', progress = 1 WHERE id = $1::uuid`, [
        jobId,
      ])

      // Third-connection mid-flight probe: while the worker transaction is open,
      // NO snapshot anywhere can see terminal-without-effect (both writes are
      // uncommitted together).
      expect(await jobStatus(jobId)).toBe('processing')
      expect(await effectCount(ORG_WORKER)).toBe(0)

      // The transition (exclusive class-`00`) REALLY waits for the worker.
      await transition.query('BEGIN')
      const transitionPid = await backendPid(transition)
      const transitionAcquire = acquireAttendanceCalculationRolloutLock(trx(transition), orgKey, 'exclusive')
      await waitUntilAdvisoryBlocked(transitionPid)
      // Still nonterminal from every committed snapshot while the transition waits.
      expect(await jobStatus(jobId)).toBe('processing')

      await worker.query('COMMIT')
      await transitionAcquire
      // Under the exclusive lock, after the worker's atomic commit: terminal AND
      // effect — never terminal-without-effect.
      const seen = await transition.query(
        `SELECT (SELECT status FROM attendance_import_jobs WHERE id = $1::uuid) AS status,
                (SELECT count(*)::int FROM attendance_records WHERE org_id = $2) AS effects`,
        [jobId, ORG_WORKER],
      )
      expect(seen.rows[0]).toEqual({ status: 'completed', effects: 1 })
      // Re-evaluate then transition (legal initial INSERT: shadow from legacy).
      await transition.query(
        `INSERT INTO attendance_calculation_rollout_state
           (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
         VALUES ($1, 'shadow', 'w4c0-e3', 'TEST_FIXTURE', $2, 1, 'legacy', 'synthetic_staging')`,
        [ORG_WORKER, ACTOR],
      )
      await transition.query('COMMIT')
    } finally {
      worker.release()
      transition.release()
    }

    // --- Failure order: rollback after source DML leaves the job nonterminal
    //     with ZERO effect (no half state either way). ---
    const jobIdRb = await setupJob(ORG_WORKER_RB)
    await withClient(async (client) => {
      await client.query('BEGIN')
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_WORKER_RB)
      await acquireAttendanceCalculationRolloutLock(trx(client), orgKey, 'shared')
      await client.query(
        `INSERT INTO attendance_records (user_id, work_date, org_id, status, work_minutes, late_minutes, early_leave_minutes)
         VALUES ($1, '2026-03-06', $2, 'normal', 480, 0, 0)`,
        [ACTOR, ORG_WORKER_RB],
      )
      await client.query(`UPDATE attendance_import_jobs SET status = 'completed', progress = 1 WHERE id = $1::uuid`, [
        jobIdRb,
      ])
      await client.query('ROLLBACK')
    })
    expect(await jobStatus(jobIdRb)).toBe('processing')
    expect(await effectCount(ORG_WORKER_RB)).toBe(0)
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 7 — org rollout shared/exclusive in both directions.
  // -------------------------------------------------------------------------
  it('rollout advisory: a null-ID legacy source holding shared makes the transition wait and re-evaluate after commit; a transition holding exclusive makes the source freeze the NEW posture after release', async () => {
    // (a) Source-first: a null-ID legacy source (preflight legacy_no_operation)
    // holds the shared lock through its transaction; the transition must wait.
    const source = await pool.connect()
    const transition = await pool.connect()
    try {
      await source.query('BEGIN')
      const legacyResult = await attendanceResultOperationPreflightV1(
        trx(source),
        mintAuth(ORG_SOURCE_SHARED),
        livePunchEnvelope(ORG_SOURCE_SHARED, null).registryInput,
      )
      expect(legacyResult.kind).toBe('legacy_no_operation')

      await transition.query('BEGIN')
      const transitionPid = await backendPid(transition)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_SOURCE_SHARED)
      const acquire = acquireAttendanceCalculationRolloutLock(trx(transition), orgKey, 'exclusive')
      await waitUntilAdvisoryBlocked(transitionPid)

      await source.query('COMMIT') // shared released at commit
      await acquire
      // Re-evaluate under the exclusive lock (the resolver read happens AFTER
      // the source's commit), then perform the transition.
      const reEvaluated = await resolveSegmentCalculationPosture(trx(transition), ORG_SOURCE_SHARED)
      expect(reEvaluated.effectiveState).toBe('legacy')
      await transition.query(
        `INSERT INTO attendance_calculation_rollout_state
           (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
         VALUES ($1, 'shadow', 'w4c0-e3', 'TEST_FIXTURE', $2, 1, 'legacy', 'synthetic_staging')`,
        [ORG_SOURCE_SHARED, ACTOR],
      )
      await transition.query('COMMIT')
    } finally {
      source.release()
      transition.release()
    }

    // (b) Transition-first: while the transition holds exclusive and inserts the
    // shadow row, a stable-ID source is blocked at the SHARED acquisition; after
    // release it resolves the NEW posture (shadow), not the pre-transition
    // legacy — the posture read is under the lock, so the stale read is
    // impossible by construction.
    const transition2 = await pool.connect()
    const source2 = await pool.connect()
    const surfaced: unknown[] = []
    try {
      await transition2.query('BEGIN')
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_TRANSITION_FIRST)
      await acquireAttendanceCalculationRolloutLock(trx(transition2), orgKey, 'exclusive')
      await transition2.query(
        `INSERT INTO attendance_calculation_rollout_state
           (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
         VALUES ($1, 'shadow', 'w4c0-e3', 'TEST_FIXTURE', $2, 1, 'legacy', 'synthetic_staging')`,
        [ORG_TRANSITION_FIRST, ACTOR],
      )

      await source2.query('BEGIN')
      const sourcePid = await backendPid(source2)
      const operationId = crypto.randomUUID()
      const sourcePromise = attendanceResultOperationPreflightV1(
        trx(source2),
        mintAuth(ORG_TRANSITION_FIRST),
        livePunchEnvelope(ORG_TRANSITION_FIRST, operationId).registryInput,
      ).catch((error) => {
        surfaced.push(error)
        throw error
      })
      await waitUntilAdvisoryBlocked(sourcePid)

      await transition2.query('COMMIT')
      const claimed = await sourcePromise
      expect(claimed.kind).toBe('claimed')
      if (claimed.kind === 'claimed') {
        expect(claimed.org.acceptedWritePosture).toBe('shadow') // NEW posture, not legacy
        await sealAttendanceResultOperationV1(trx(source2), claimed.itemIdentities[0], {
          responseSnapshot: { ok: true },
        })
      }
      await source2.query('COMMIT')
      const row = await pool.query(
        `SELECT accepted_write_posture FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid`,
        [ORG_TRANSITION_FIRST, operationId],
      )
      expect(row.rows).toEqual([{ accepted_write_posture: 'shadow' }])
    } finally {
      source2.release()
      transition2.release()
    }
    expect(surfaced).toEqual([])
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 8 — P07 enqueue versus rollout transition, both race orders.
  // -------------------------------------------------------------------------
  it('P07 enqueue vs rollout transition in both orders: enqueue-first makes the transition wait then see the committed retryable job; transition-first makes the enqueue freeze only the NEW posture; suspension yields blocked posture and zero job row', async () => {
    const buildReservation = async (client: PoolClient, org: string, batchRoot: string) => {
      const t = trx(client)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(org)
      await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
      const posture = await resolveSegmentCalculationPosture(t, org)
      const orgIdentity = createVerifiedAttendanceOrgIdentityV1({ orgKey: org, posture })
      const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
        org: orgIdentity,
        kind: 'batch',
        entrypoint: 'import_batch',
        source: { sourceKind: 'import_batch', batchCommandId: batchRoot },
      })
      const items = [HEX64_A, HEX64_B].map((semanticFingerprint, index) => ({
        identity: createVerifiedAttendanceOperationIdentityV1({
          org: orgIdentity,
          kind: 'item',
          entrypoint: 'import_batch',
          source: { sourceKind: 'import_item', batchCommandId: batchRoot, ordinal: String(index), semanticFingerprint },
        }),
        commandFingerprint: semanticFingerprint,
      }))
      return { batchIdentity, items }
    }

    // --- Order 1: enqueue first. It holds shared from posture resolution
    //     through the job insert; the transition waits, then sees the committed
    //     retryable (queued) job with its frozen posture. ---
    const batchRoot1 = crypto.randomUUID()
    const enqueue = await pool.connect()
    const transition = await pool.connect()
    try {
      await enqueue.query('BEGIN')
      const built = await buildReservation(enqueue, ORG_ENQ_TRANS, batchRoot1)
      const created = await reserveAttendanceImportJobW4V1(trx(enqueue), mintImportAuth(ORG_ENQ_TRANS), {
        batchIdentity: built.batchIdentity,
        items: built.items,
        batchCommandFingerprint: HEX64_C,
        legacyJob: { batchId: crypto.randomUUID(), createdBy: ACTOR, payload: { rows: 2 }, total: 2 },
      })
      expect(created.kind).toBe('created')

      await transition.query('BEGIN')
      const transitionPid = await backendPid(transition)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_ENQ_TRANS)
      const acquire = acquireAttendanceCalculationRolloutLock(trx(transition), orgKey, 'exclusive')
      await waitUntilAdvisoryBlocked(transitionPid)
      // While the enqueue holds shared through its commit, the transition's
      // retryable-job scan CANNOT run yet — and no committed snapshot shows the job.
      const midFlight = await pool.query(
        `SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
        [ORG_ENQ_TRANS, batchRoot1],
      )
      expect(midFlight.rows[0].n).toBe(0)

      await enqueue.query('COMMIT')
      await acquire
      // Under the exclusive lock the transition's scan sees the committed
      // retryable job and its frozen accepted_write_posture. (The section 10
      // posture-comparison DECISION belongs to the transition-writer slice; the
      // scan visibility/ordering is what W4C-0 proves.)
      const scan = await transition.query(
        `SELECT status, w4_accepted_write_posture FROM attendance_import_jobs
          WHERE org_id = $1 AND w4_batch_command_id = $2::uuid AND w4_contract_version IS NOT NULL
            AND status NOT IN ('completed', 'failed')`,
        [ORG_ENQ_TRANS, batchRoot1],
      )
      expect(scan.rows).toEqual([{ status: 'queued', w4_accepted_write_posture: 'shadow' }])
      await transition.query('COMMIT')
    } finally {
      enqueue.release()
      transition.release()
    }

    // --- Order 2: transition first (eligible -> authoritative under exclusive).
    //     The enqueue waits at SHARED and then freezes ONLY the new posture:
    //     'authoritative', not the pre-transition normalized 'shadow'. ---
    const batchRoot2 = crypto.randomUUID()
    const transition2 = await pool.connect()
    const enqueue2 = await pool.connect()
    const surfaced: unknown[] = []
    try {
      await transition2.query('BEGIN')
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_ENQ_FREEZE)
      await acquireAttendanceCalculationRolloutLock(trx(transition2), orgKey, 'exclusive')
      await transition2.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'authoritative', prior_state = 'eligible', version = 3          WHERE org_id = $1`,
        [ORG_ENQ_FREEZE],
      )

      await enqueue2.query('BEGIN')
      const enqueuePid = await backendPid(enqueue2)
      const enqueuePromise = (async () => {
        const built = await buildReservation(enqueue2, ORG_ENQ_FREEZE, batchRoot2)
        return reserveAttendanceImportJobW4V1(trx(enqueue2), mintImportAuth(ORG_ENQ_FREEZE), {
          batchIdentity: built.batchIdentity,
          items: built.items,
          batchCommandFingerprint: HEX64_C,
          legacyJob: { batchId: crypto.randomUUID(), createdBy: ACTOR, payload: { rows: 2 }, total: 2 },
        })
      })().catch((error) => {
        surfaced.push(error)
        throw error
      })
      await waitUntilAdvisoryBlocked(enqueuePid)

      await transition2.query('COMMIT')
      const created = await enqueuePromise
      expect(created.kind).toBe('created')
      await enqueue2.query('COMMIT')
      const frozen = await pool.query(
        `SELECT w4_accepted_write_posture FROM attendance_import_jobs WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
        [ORG_ENQ_FREEZE, batchRoot2],
      )
      expect(frozen.rows).toEqual([{ w4_accepted_write_posture: 'authoritative' }])
    } finally {
      enqueue2.release()
      transition2.release()
    }
    expect(surfaced).toEqual([])

    // --- Suspension: transition authoritative -> suspended under exclusive while
    //     a fresh enqueue waits at SHARED; after release the posture resolves
    //     blocked, the org factory refuses to mint, and ZERO job row exists. ---
    const batchRoot3 = crypto.randomUUID()
    const transition3 = await pool.connect()
    const enqueue3 = await pool.connect()
    try {
      await transition3.query('BEGIN')
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_ENQ_FREEZE)
      await acquireAttendanceCalculationRolloutLock(trx(transition3), orgKey, 'exclusive')
      await transition3.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'suspended', prior_state = 'authoritative', version = 4          WHERE org_id = $1`,
        [ORG_ENQ_FREEZE],
      )

      await enqueue3.query('BEGIN')
      const enqueuePid = await backendPid(enqueue3)
      const suspendedProbe = (async () => {
        const t = trx(enqueue3)
        await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
        const posture = await resolveSegmentCalculationPosture(t, ORG_ENQ_FREEZE)
        expect(posture.writePosture).toBe('blocked')
        // The enqueue protocol CANNOT proceed: the post-lock org factory refuses
        // a blocked posture, so no batch/item identity (and no reservation) can
        // even be minted — zero job DML by construction.
        let mintCaught: unknown
        try {
          createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_ENQ_FREEZE, posture })
        } catch (error) {
          mintCaught = error
        }
        expect((mintCaught as Error).message).toBe('W4C0_ORG_POSTURE_BLOCKED')
      })()
      await waitUntilAdvisoryBlocked(enqueuePid)
      await transition3.query('COMMIT')
      await suspendedProbe
      await enqueue3.query('ROLLBACK')
    } finally {
      transition3.release()
      enqueue3.release()
    }
    const suspendedJobs = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
      [ORG_ENQ_FREEZE, batchRoot3],
    )
    expect(suspendedJobs.rows[0].n).toBe(0)
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 9 — P07 enqueue versus a synchronous caller on the same batch identity,
  // both commit orders.
  // -------------------------------------------------------------------------
  it('P07 enqueue vs synchronous caller on the same batch identity in both commit orders: exactly one side reserves the tuple; the waiter re-reads under the class-10 locks and fails closed with zero conflicting DML', async () => {
    const buildReservation = async (client: PoolClient, batchRoot: string) => {
      const t = trx(client)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_RACE)
      await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
      const posture = await resolveSegmentCalculationPosture(t, ORG_RACE)
      const orgIdentity = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_RACE, posture })
      const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
        org: orgIdentity,
        kind: 'batch',
        entrypoint: 'import_batch',
        source: { sourceKind: 'import_batch', batchCommandId: batchRoot },
      })
      const items = [HEX64_A, HEX64_B].map((semanticFingerprint, index) => ({
        identity: createVerifiedAttendanceOperationIdentityV1({
          org: orgIdentity,
          kind: 'item',
          entrypoint: 'import_batch',
          source: { sourceKind: 'import_item', batchCommandId: batchRoot, ordinal: String(index), semanticFingerprint },
        }),
        commandFingerprint: semanticFingerprint,
      }))
      return { batchIdentity, items }
    }

    // --- Order 1: synchronous caller commits first; the concurrently waiting
    //     enqueue re-reads under the class-10 locks and 409s with zero job DML. ---
    const batchRoot1 = crypto.randomUUID()
    const syncCaller = await pool.connect()
    const enqueue = await pool.connect()
    const surfaced1: unknown[] = []
    try {
      await syncCaller.query('BEGIN')
      const claimed = await attendanceResultOperationPreflightV1(
        trx(syncCaller),
        mintImportAuth(ORG_RACE),
        importBatchEnvelope(ORG_RACE, batchRoot1, [HEX64_A, HEX64_B]).registryInput,
      )
      expect(claimed.kind).toBe('claimed')

      await enqueue.query('BEGIN')
      const enqueuePid = await backendPid(enqueue)
      const enqueuePromise = (async () => {
        const built = await buildReservation(enqueue, batchRoot1)
        return reserveAttendanceImportJobW4V1(trx(enqueue), mintImportAuth(ORG_RACE), {
          batchIdentity: built.batchIdentity,
          items: built.items,
          batchCommandFingerprint: HEX64_C,
          legacyJob: { batchId: crypto.randomUUID(), createdBy: ACTOR, payload: { rows: 2 }, total: 2 },
        })
      })().catch((error) => {
        surfaced1.push(error)
        throw error
      })
      await waitUntilAdvisoryBlocked(enqueuePid)

      if (claimed.kind === 'claimed') {
        const itemIds = claimed.itemIdentities.map((identity) => identity.id as string)
        for (const identity of claimed.itemIdentities) {
          await sealAttendanceResultOperationV1(trx(syncCaller), identity, { responseSnapshot: { sync: true } })
        }
        await sealAttendanceResultOperationBatchV1(trx(syncCaller), claimed.batchIdentity, {
          order: itemIds,
          byItem: Object.fromEntries(itemIds.map((id) => [id, { sync: true }])),
        })
      }
      await syncCaller.query('COMMIT')

      let enqueueCaught: unknown
      try {
        await enqueuePromise
      } catch (error) {
        enqueueCaught = error
      }
      expect(enqueueCaught).toBeInstanceOf(AttendanceW4OperationError)
      expect((enqueueCaught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_BATCH_CONFLICT')
      await enqueue.query('ROLLBACK')
    } finally {
      syncCaller.release()
      enqueue.release()
    }
    expect(surfaced1).toHaveLength(1) // the one 409, nothing else
    const jobs1 = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
      [ORG_RACE, batchRoot1],
    )
    expect(jobs1.rows[0].n).toBe(0) // exactly one side reserved: the sync operations
    expect(await opCount(ORG_RACE, 'batch_command_id = $2::uuid', [batchRoot1])).toBe(2)

    // --- Order 2: enqueue commits first (holds class-00 then every class-10
    //     identity through the job commit); the concurrently waiting synchronous
    //     caller re-reads under the locks, finds the V1 reservation, and 409s
    //     with zero conflicting operation DML. ---
    const batchRoot2 = crypto.randomUUID()
    const enqueue2 = await pool.connect()
    const syncCaller2 = await pool.connect()
    const surfaced2: unknown[] = []
    try {
      await enqueue2.query('BEGIN')
      const built = await buildReservation(enqueue2, batchRoot2)
      const created = await reserveAttendanceImportJobW4V1(trx(enqueue2), mintImportAuth(ORG_RACE), {
        batchIdentity: built.batchIdentity,
        items: built.items,
        batchCommandFingerprint: HEX64_C,
        legacyJob: { batchId: crypto.randomUUID(), createdBy: ACTOR, payload: { rows: 2 }, total: 2 },
      })
      expect(created.kind).toBe('created')

      await syncCaller2.query('BEGIN')
      const syncPid = await backendPid(syncCaller2)
      const syncPromise = attendanceResultOperationPreflightV1(
        trx(syncCaller2),
        mintImportAuth(ORG_RACE),
        importBatchEnvelope(ORG_RACE, batchRoot2, [HEX64_A, HEX64_B]).registryInput,
      ).catch((error) => {
        surfaced2.push(error)
        throw error
      })
      await waitUntilAdvisoryBlocked(syncPid)

      await enqueue2.query('COMMIT')
      let syncCaught: unknown
      try {
        await syncPromise
      } catch (error) {
        syncCaught = error
      }
      expect(syncCaught).toBeInstanceOf(AttendanceW4OperationError)
      expect((syncCaught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_BATCH_CONFLICT')
      await syncCaller2.query('ROLLBACK')
    } finally {
      enqueue2.release()
      syncCaller2.release()
    }
    expect(surfaced2).toHaveLength(1)
    const jobs2 = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
      [ORG_RACE, batchRoot2],
    )
    expect(jobs2.rows[0].n).toBe(1) // exactly one side reserved: the job
    expect(await opCount(ORG_RACE, 'batch_command_id = $2::uuid', [batchRoot2])).toBe(0)
    const batches2 = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_result_operation_batches WHERE org_id = $1 AND batch_command_id = $2::uuid`,
      [ORG_RACE, batchRoot2],
    )
    expect(batches2.rows[0].n).toBe(0)
  }, 30000)

  // -------------------------------------------------------------------------
  // Leg 10 — incomplete stable-ID operation vs rollout transition: the common
  // lock order completes without deadlock or bounded-retry exhaustion.
  // -------------------------------------------------------------------------
  it('incomplete stable-ID operation vs rollout transition: rollout -> identity-advisory -> operation-row order completes without deadlock or retry exhaustion', async () => {
    const operationId = crypto.randomUUID()
    const envelope = livePunchEnvelope(ORG_CLAIM, operationId)
    const claimer = await pool.connect()
    const transition = await pool.connect()
    try {
      // The claimer is mid-protocol: shared class-00 + exclusive class-10 held,
      // operation row claimed but NOT committed (the "incomplete" operation).
      await claimer.query('BEGIN')
      const claimed = await attendanceResultOperationPreflightV1(trx(claimer), mintAuth(ORG_CLAIM), envelope.registryInput)
      expect(claimed.kind).toBe('claimed')

      // The transition takes ONLY the class-00 exclusive lock (never an
      // operation lock): it queues behind the claimer's shared hold — a wait,
      // never a cycle.
      await transition.query('BEGIN')
      const transitionPid = await backendPid(transition)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_CLAIM)
      const acquire = acquireAttendanceCalculationRolloutLock(trx(transition), orgKey, 'exclusive')
      await waitUntilAdvisoryBlocked(transitionPid)

      if (claimed.kind === 'claimed') {
        await sealAttendanceResultOperationV1(trx(claimer), claimed.itemIdentities[0], {
          responseSnapshot: { ok: true },
        })
      }
      await claimer.query('COMMIT')

      // Both sides complete: no 40P01 deadlock, no bounded-retry exhaustion,
      // no busy mapping — a plain wait-then-proceed.
      await acquire
      await transition.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'eligible', prior_state = 'shadow', version = 2          WHERE org_id = $1`,
        [ORG_CLAIM],
      )
      await transition.query('COMMIT')
    } finally {
      claimer.release()
      transition.release()
    }
    expect(await opCount(ORG_CLAIM, 'operation_id = $2::uuid', [operationId])).toBe(1)
    const state = await pool.query(`SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1`, [
      ORG_CLAIM,
    ])
    expect(state.rows).toEqual([{ state: 'eligible', version: 2 }])
  }, 30000)

  // -------------------------------------------------------------------------
  // Two-point wiring self-check (suite is DB-excluded from the no-DB run and
  // explicitly named in CI — lock section 12.1 last gate).
  // -------------------------------------------------------------------------
  it('this suite is wired at both required points (plugin-tests.yml step + vitest no-DB exclude)', () => {
    const repoRoot = path.resolve(__dirname, '../../../..')
    const selfName = 'attendance-w4c0-concurrency-gates-e3.db.test.ts'
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    expect(workflow).toContain(`tests/integration/${selfName}`)
    const vitestConfig = fs.readFileSync(
      path.join(repoRoot, 'packages/core-backend/vitest.config.ts'),
      'utf8',
    )
    expect(vitestConfig).toContain(selfName)
  })
})
