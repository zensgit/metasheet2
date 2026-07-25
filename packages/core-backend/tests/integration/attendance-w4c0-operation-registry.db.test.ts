/**
 * W4C-0 (#4556) Stage C — registry service claim/seal/replay/congruence against
 * real Postgres (lock sections 4.1/7.1/7.1a/8.1/8.2; amendment 1.3).
 *
 * Covers the Stage C interface layer end to end:
 *  - shadow single-command lifecycle: claim -> seal -> commit, exact-payload
 *    replay returns the stored response with zero DML, different payload /
 *    different actor on the same key returns closed 409;
 *  - atomic import batch lifecycle through the strict envelope normalizer:
 *    all-new claim, batch+item seal, all-existing congruent replay, reordered/
 *    shrunken batch conflicts;
 *  - legacy_projection_only: null-ID command creates no operation row;
 *    stable-ID command claims/seals a compatibility operation whose stored
 *    response replays; outbox enqueue is forbidden in legacy posture;
 *  - source-free cancel persists; a canceled key is not a completed replay;
 *  - claim without seal cannot commit (Stage A deferred constraint fires
 *    through the service-layer rows);
 *  - P07 V1 job reservation: created -> congruent existing -> conflicting 409,
 *    with zero operation rows;
 *  - advisory-helper deadline protocol: busy waiter maps to the closed
 *    operation busy code (55P03 never escapes) and lock_timeout is restored
 *    after success;
 *  - SQL authorization recheck: an inactive actor fails closed before any DML.
 *
 * The full two-connection first-claim/race matrix is Stage E (section 12.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceResultOperationLocks,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  __setAttendanceW4MonotonicClockForTests,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOrgIdentityV1,
} from '../../src/attendance/w4c0-identity'
import {
  createAuthorizedAttendanceWriteContextV1,
  type AuthorizedAttendanceWriteContextV1,
} from '../../src/attendance/w4c0-authorization'
import {
  attendanceResultOperationPreflightV1,
  cancelAttendanceResultOperationV1,
  enqueueAttendanceResultEventOutboxV1,
  reserveAttendanceImportJobW4V1,
  sealAttendanceResultOperationBatchV1,
  sealAttendanceResultOperationV1,
  AttendanceW4RegistryError,
} from '../../src/attendance/w4c0-operation-registry'
import { AttendanceW4OperationError } from '../../src/attendance/w4c0-operation-contract'
import { normalizeAttendanceSourceOperationEnvelopeV1 } from '../../src/attendance/w4c0-source-commands'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

// File-namespaced fixtures (shared DB): per-run random org/user/operation IDs so
// the append-only registries never collide across runs.
const RUN = crypto.randomUUID().slice(0, 8)
const ORG_SHADOW = crypto.randomUUID()
const ORG_LEGACY = crypto.randomUUID()
const ACTOR = `w4c0-reg-actor-${RUN}`
const INACTIVE_ACTOR = `w4c0-reg-inactive-${RUN}`
const ENV_KEY = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (sqlText, params) =>
      client.query(sqlText, params as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>,
  }
}

function mintAuth(overrides: Partial<Record<string, unknown>> = {}): AuthorizedAttendanceWriteContextV1 {
  return createAuthorizedAttendanceWriteContextV1({
    actorId: ACTOR,
    actorPosture: 'self',
    tokenSubjectUserId: ACTOR,
    orgId: ORG_SHADOW,
    subjectScope: { kind: 'self', userId: ACTOR },
    capability: 'punch',
    sourceRef: 'test:w4c0-registry',
    ...overrides,
  })
}

function livePunchEnvelope(orgId: string, operationId: string | null, occurredAt = '2026-03-01T01:00:00Z') {
  return normalizeAttendanceSourceOperationEnvelopeV1({
    schemaVersion: 1,
    orgId,
    correlationId: `corr-${RUN}`,
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
    correlationId: `corr-batch-${RUN}`,
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

describeIfDatabase('W4C-0 Stage C — operation registry service (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let priorEnv: string | undefined

  beforeAll(async () => {
    priorEnv = process.env[ENV_KEY]
    process.env[ENV_KEY] = ORG_SHADOW
    await pool.query(
      `INSERT INTO users (id, password_hash) VALUES ($1, ''), ($2, '') ON CONFLICT (id) DO NOTHING`,
      [ACTOR, INACTIVE_ACTOR],
    )
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [INACTIVE_ACTOR])
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $3, true), ($1, $4, true), ($2, $3, true)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [ACTOR, INACTIVE_ACTOR, ORG_SHADOW, ORG_LEGACY],
    )
    // Persist a shadow rollout row for ORG_SHADOW (initial INSERT shape allowed by
    // the Stage A guard: state=shadow, prior_state=legacy, version=1).
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'shadow', 'w4c0-test', 'TEST_FIXTURE', $2, 1, 'legacy', 'synthetic_staging')
       ON CONFLICT (org_id) DO NOTHING`,
      [ORG_SHADOW, ACTOR],
    )
  })

  afterAll(async () => {
    if (priorEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = priorEnv
    await pool.end()
  })

  async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  it('shadow single command: claim+seal -> commit -> zero-DML congruent replay; payload/actor drift 409s', async () => {
    const operationId = crypto.randomUUID()
    const envelope = livePunchEnvelope(ORG_SHADOW, operationId)
    const auth = mintAuth()

    // First writer: claim + seal + outbox in one transaction.
    await withClient(async (client) => {
      await client.query('BEGIN')
      const result = await attendanceResultOperationPreflightV1(trx(client), auth, envelope.registryInput)
      expect(result.kind).toBe('claimed')
      if (result.kind !== 'claimed') return
      expect(result.org.acceptedWritePosture).toBe('shadow')
      expect(result.itemIdentities).toHaveLength(1)
      await sealAttendanceResultOperationV1(trx(client), result.itemIdentities[0], {
        responseSnapshot: { ok: true, eventId: 'evt-1' },
        resultSemanticFingerprint: HEX64_A,
        resultProvenanceFingerprint: HEX64_B,
      })
      await enqueueAttendanceResultEventOutboxV1(trx(client), result.itemIdentities[0], [
        {
          eventKind: 'attendance.punched',
          payload: { v: 1 },
          payloadSchemaVersion: 1,
          businessKeyFingerprint: HEX64_A,
        },
      ])
      await client.query('COMMIT')
    })

    // Exact-key/exact-payload replay: stored response, zero new rows.
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1',
      [ORG_SHADOW],
    )
    await withClient(async (client) => {
      await client.query('BEGIN')
      const replay = await attendanceResultOperationPreflightV1(trx(client), mintAuth(), envelope.registryInput)
      expect(replay.kind).toBe('replay')
      if (replay.kind !== 'replay') return
      expect(replay.responses.itemResponses[operationId]).toEqual({ ok: true, eventId: 'evt-1' })
      await client.query('COMMIT')
    })
    const after = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1',
      [ORG_SHADOW],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)

    // Same key, different payload (different occurred-at -> different fingerprint): 409.
    await withClient(async (client) => {
      await client.query('BEGIN')
      let caught: unknown
      try {
        await attendanceResultOperationPreflightV1(
          trx(client),
          mintAuth(),
          livePunchEnvelope(ORG_SHADOW, operationId, '2026-03-01T02:00:00Z').registryInput,
        )
      } catch (error) {
        caught = error
      }
      await client.query('ROLLBACK')
      expect(caught).toBeInstanceOf(AttendanceW4OperationError)
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    })

    // Same key + payload, different actor posture/subject: 409 (not a replay read).
    await withClient(async (client) => {
      await client.query('BEGIN')
      const otherAuth = mintAuth({
        actorPosture: 'attendance_admin',
        tokenSubjectUserId: null,
        subjectScope: { kind: 'explicit_users', userIds: [ACTOR] },
      })
      let caught: unknown
      try {
        await attendanceResultOperationPreflightV1(trx(client), otherAuth, envelope.registryInput)
      } catch (error) {
        caught = error
      }
      await client.query('ROLLBACK')
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    })
  })

  it('atomic import batch: all-new claim -> seal -> all-existing replay; reordered/shrunken input conflicts', async () => {
    const batchCommandId = crypto.randomUUID()
    const envelope = importBatchEnvelope(ORG_SHADOW, batchCommandId, [HEX64_A, HEX64_B])
    const auth = mintAuth({ capability: 'import' })

    let itemIds: string[] = []
    await withClient(async (client) => {
      await client.query('BEGIN')
      const result = await attendanceResultOperationPreflightV1(trx(client), auth, envelope.registryInput)
      expect(result.kind).toBe('claimed')
      if (result.kind !== 'claimed') return
      expect(result.batchIdentity).not.toBeNull()
      expect(result.itemIdentities).toHaveLength(2)
      itemIds = result.itemIdentities.map((identity) => identity.id as string)
      for (const identity of result.itemIdentities) {
        await sealAttendanceResultOperationV1(trx(client), identity, {
          responseSnapshot: { imported: identity.id },
        })
      }
      await sealAttendanceResultOperationBatchV1(trx(client), result.batchIdentity, {
        order: itemIds,
        byItem: Object.fromEntries(itemIds.map((id) => [id, { imported: id }])),
      })
      await client.query('COMMIT')
    })

    // All-existing congruent replay returns the order vector + per-item object.
    await withClient(async (client) => {
      await client.query('BEGIN')
      const replay = await attendanceResultOperationPreflightV1(trx(client), mintAuth({ capability: 'import' }), envelope.registryInput)
      expect(replay.kind).toBe('replay')
      if (replay.kind !== 'replay') return
      expect((replay.responses.batchResponse as { order: string[] }).order).toEqual(itemIds)
      expect(Object.keys(replay.responses.itemResponses).sort()).toEqual([...itemIds].sort())
      await client.query('COMMIT')
    })

    // Reused batch command ID with a REORDERED item sequence: 409 batch conflict
    // even though the unordered set is identical.
    await withClient(async (client) => {
      await client.query('BEGIN')
      let caught: unknown
      try {
        await attendanceResultOperationPreflightV1(
          trx(client),
          mintAuth({ capability: 'import' }),
          importBatchEnvelope(ORG_SHADOW, batchCommandId, [HEX64_B, HEX64_A]).registryInput,
        )
      } catch (error) {
        caught = error
      }
      await client.query('ROLLBACK')
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    })

    // Missing item (count/set drift): 409 batch conflict.
    await withClient(async (client) => {
      await client.query('BEGIN')
      let caught: unknown
      try {
        await attendanceResultOperationPreflightV1(
          trx(client),
          mintAuth({ capability: 'import' }),
          importBatchEnvelope(ORG_SHADOW, batchCommandId, [HEX64_A]).registryInput,
        )
      } catch (error) {
        caught = error
      }
      await client.query('ROLLBACK')
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_BATCH_CONFLICT')
    })
  })

  it('legacy posture: null-ID command creates no row; stable-ID claims a compatibility op that replays; outbox is forbidden', async () => {
    // Null-ID legacy command: no operation row at all.
    await withClient(async (client) => {
      await client.query('BEGIN')
      const result = await attendanceResultOperationPreflightV1(
        trx(client),
        mintAuth({ orgId: ORG_LEGACY }),
        livePunchEnvelope(ORG_LEGACY, null).registryInput,
      )
      expect(result.kind).toBe('legacy_no_operation')
      await client.query('COMMIT')
    })
    const nullIdRows = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1',
      [ORG_LEGACY],
    )
    expect(nullIdRows.rows[0].n).toBe(0)

    // Stable-ID legacy command: compatibility operation claimed and sealed; the
    // stored legacy response replays; posture is frozen as legacy_projection_only.
    const operationId = crypto.randomUUID()
    const envelope = livePunchEnvelope(ORG_LEGACY, operationId)
    await withClient(async (client) => {
      await client.query('BEGIN')
      const result = await attendanceResultOperationPreflightV1(trx(client), mintAuth({ orgId: ORG_LEGACY }), envelope.registryInput)
      expect(result.kind).toBe('claimed')
      if (result.kind !== 'claimed') return
      expect(result.org.acceptedWritePosture).toBe('legacy_projection_only')
      // Legacy branch creates NO outbox row (closed posture split).
      let outboxCaught: unknown
      try {
        await enqueueAttendanceResultEventOutboxV1(trx(client), result.itemIdentities[0], [
          { eventKind: 'attendance.punched', payload: {}, payloadSchemaVersion: 1, businessKeyFingerprint: HEX64_A },
        ])
      } catch (error) {
        outboxCaught = error
      }
      expect((outboxCaught as AttendanceW4RegistryError).code).toBe('W4C0_OUTBOX_LEGACY_FORBIDDEN')
      await sealAttendanceResultOperationV1(trx(client), result.itemIdentities[0], {
        responseSnapshot: { legacy: true },
      })
      await client.query('COMMIT')
    })
    await withClient(async (client) => {
      await client.query('BEGIN')
      const replay = await attendanceResultOperationPreflightV1(trx(client), mintAuth({ orgId: ORG_LEGACY }), envelope.registryInput)
      expect(replay.kind).toBe('replay')
      if (replay.kind !== 'replay') return
      expect(replay.responses.itemResponses[operationId]).toEqual({ legacy: true })
      await client.query('COMMIT')
    })
    const outboxRows = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE org_id = $1',
      [ORG_LEGACY],
    )
    expect(outboxRows.rows[0].n).toBe(0)
  })

  it('source-free cancel persists; a canceled key is not a completed replay', async () => {
    const operationId = crypto.randomUUID()
    const envelope = livePunchEnvelope(ORG_SHADOW, operationId)
    await withClient(async (client) => {
      await client.query('BEGIN')
      const result = await attendanceResultOperationPreflightV1(trx(client), mintAuth(), envelope.registryInput)
      expect(result.kind).toBe('claimed')
      if (result.kind !== 'claimed') return
      await cancelAttendanceResultOperationV1(trx(client), result.itemIdentities[0])
      await client.query('COMMIT') // source-free canceled row commits
    })
    const row = await pool.query(
      'SELECT state, response_snapshot FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
      [ORG_SHADOW, operationId],
    )
    expect(row.rows).toEqual([{ state: 'canceled', response_snapshot: null }])
    await withClient(async (client) => {
      await client.query('BEGIN')
      let caught: unknown
      try {
        await attendanceResultOperationPreflightV1(trx(client), mintAuth(), envelope.registryInput)
      } catch (error) {
        caught = error
      }
      await client.query('ROLLBACK')
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    })
  })

  it('a claim that is never sealed cannot commit (deferred constraint fires through the service rows)', async () => {
    const envelope = livePunchEnvelope(ORG_SHADOW, crypto.randomUUID())
    await withClient(async (client) => {
      await client.query('BEGIN')
      const result = await attendanceResultOperationPreflightV1(trx(client), mintAuth(), envelope.registryInput)
      expect(result.kind).toBe('claimed')
      let caught: unknown
      try {
        await client.query('COMMIT')
      } catch (error) {
        caught = error
      }
      expect(String((caught as Error).message)).toContain('W4C0_CLAIMED_COMMIT')
      await client.query('ROLLBACK').catch(() => undefined)
    })
  })

  it('P07 reservation: created -> congruent existing -> conflicting 409; zero operation rows', async () => {
    const batchRoot = crypto.randomUUID()
    const legacyBatchId = crypto.randomUUID()
    const auth = mintAuth({ capability: 'import' })

    const buildIdentities = async (client: PoolClient, fingerprints: readonly string[]) => {
      const t = trx(client)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_SHADOW)
      await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
      const posture = await resolveSegmentCalculationPosture(t, ORG_SHADOW)
      const org: VerifiedAttendanceOrgIdentityV1 = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_SHADOW, posture })
      const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'batch',
        entrypoint: 'import_batch',
        source: { sourceKind: 'import_batch', batchCommandId: batchRoot },
      })
      const items = fingerprints.map((semanticFingerprint, index) => ({
        identity: createVerifiedAttendanceOperationIdentityV1({
          org,
          kind: 'item',
          entrypoint: 'import_batch',
          source: { sourceKind: 'import_item', batchCommandId: batchRoot, ordinal: String(index), semanticFingerprint },
        }),
        commandFingerprint: semanticFingerprint,
      }))
      return { batchIdentity, items }
    }

    // First enqueue: creates the V1 job (proof vector validated by the SQL CHECK).
    let jobId = ''
    await withClient(async (client) => {
      await client.query('BEGIN')
      const { batchIdentity, items } = await buildIdentities(client, [HEX64_A, HEX64_B])
      const created = await reserveAttendanceImportJobW4V1(trx(client), auth, {
        batchIdentity,
        items,
        batchCommandFingerprint: HEX64_A,
        legacyJob: { batchId: legacyBatchId, createdBy: ACTOR, payload: { rows: 2 }, total: 2 },
      })
      expect(created.kind).toBe('created')
      jobId = (created as { jobId: string }).jobId
      await client.query('COMMIT')
    })

    // Congruent retry: the one existing durable job, no second row, no raw 23505.
    await withClient(async (client) => {
      await client.query('BEGIN')
      const { batchIdentity, items } = await buildIdentities(client, [HEX64_A, HEX64_B])
      const existing = await reserveAttendanceImportJobW4V1(trx(client), auth, {
        batchIdentity,
        items,
        batchCommandFingerprint: HEX64_A,
        legacyJob: { batchId: legacyBatchId, createdBy: ACTOR, payload: { rows: 2 }, total: 2 },
      })
      expect(existing).toEqual({ kind: 'existing', jobId, status: 'queued' })
      await client.query('COMMIT')
    })

    // Same reservation, different batch command fingerprint: 409 before enqueue DML.
    await withClient(async (client) => {
      await client.query('BEGIN')
      const { batchIdentity, items } = await buildIdentities(client, [HEX64_A, HEX64_B])
      let caught: unknown
      try {
        await reserveAttendanceImportJobW4V1(trx(client), auth, {
          batchIdentity,
          items,
          batchCommandFingerprint: HEX64_B,
          legacyJob: { batchId: legacyBatchId, createdBy: ACTOR, payload: { rows: 2 }, total: 2 },
        })
      } catch (error) {
        caught = error
      }
      await client.query('ROLLBACK')
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    })

    const jobs = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1 AND w4_batch_command_id = $2::uuid',
      [ORG_SHADOW, batchRoot],
    )
    expect(jobs.rows[0].n).toBe(1)
    // Reservation creates NO operation rows.
    const ops = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1 AND batch_command_id = $2::uuid',
      [ORG_SHADOW, batchRoot],
    )
    expect(ops.rows[0].n).toBe(0)
  })

  it('advisory-helper deadline: contended acquisition maps to the closed operation busy code; lock_timeout restored on success', async () => {
    const operationId = crypto.randomUUID()
    const source = { sourceKind: 'direct_live_punch', clientOperationId: operationId }
    const holder = await pool.connect()
    const waiter = await pool.connect()
    try {
      const mint = async (client: PoolClient) => {
        const t = trx(client)
        const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_SHADOW)
        await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
        const posture = await resolveSegmentCalculationPosture(t, ORG_SHADOW)
        const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_SHADOW, posture })
        return createVerifiedAttendanceOperationIdentityV1({ org, kind: 'item', entrypoint: 'live_punch', source })
      }

      await holder.query('BEGIN')
      const holderIdentity = await mint(holder)
      await acquireAttendanceResultOperationLocks(trx(holder), [holderIdentity])
      // Successful acquisition restores the contract lock timeout (5000ms).
      const timeout = await holder.query('SHOW lock_timeout')
      expect(timeout.rows[0].lock_timeout).toBe('5s')

      await waiter.query('BEGIN')
      const waiterIdentity = await mint(waiter)
      // Test-clock seam (test runtime only): entry at t=0, first per-key check at
      // t=4990 -> 10ms remaining budget -> the waiter's own 55P03 maps to the
      // closed busy code; the raw SQLSTATE never escapes.
      const script = [0, 4990]
      let calls = 0
      __setAttendanceW4MonotonicClockForTests(() => {
        const value = script[Math.min(calls, script.length - 1)]
        calls += 1
        return value
      })
      let caught: unknown
      try {
        await acquireAttendanceResultOperationLocks(trx(waiter), [waiterIdentity])
      } catch (error) {
        caught = error
      } finally {
        __setAttendanceW4MonotonicClockForTests(null)
      }
      expect(caught).toBeInstanceOf(AttendanceW4OperationError)
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_OPERATION_IN_PROGRESS')
      expect((caught as AttendanceW4OperationError).lockClass).toBe('operation')
      expect((caught as AttendanceW4OperationError).message).not.toContain('55P03')
      await waiter.query('ROLLBACK')
      await holder.query('ROLLBACK')
    } finally {
      holder.release()
      waiter.release()
    }
  })

  it('SQL authorization recheck: inactive actor fails closed before any DML', async () => {
    const inactiveAuth = createAuthorizedAttendanceWriteContextV1({
      actorId: INACTIVE_ACTOR,
      actorPosture: 'self',
      tokenSubjectUserId: INACTIVE_ACTOR,
      orgId: ORG_SHADOW,
      subjectScope: { kind: 'self', userId: INACTIVE_ACTOR },
      capability: 'punch',
      sourceRef: 'test:w4c0-registry',
    })
    const operationId = crypto.randomUUID()
    await withClient(async (client) => {
      await client.query('BEGIN')
      let caught: unknown
      try {
        await attendanceResultOperationPreflightV1(
          trx(client),
          inactiveAuth,
          livePunchEnvelope(ORG_SHADOW, operationId).registryInput,
        )
      } catch (error) {
        caught = error
      }
      await client.query('ROLLBACK')
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    })
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
      [ORG_SHADOW, operationId],
    )
    expect(rows.rows[0].n).toBe(0)
  })
})
