/**
 * W4C-2 Gate D1 (#4556 / #4844) — real-Postgres proof of the INERT authoritative-mode result-write
 * CORE (`src/attendance/w4c2-authoritative-calculation-core.ts`).
 *
 * Every §7.3 authoritative-mode invariant gets: a POSITIVE leg (the correct write happens and passes
 * every DB constraint INCLUDING the deferred commit-time triggers — each leg COMMITs), a NEGATIVE leg
 * (the forbidden write is refused with a PRODUCT CODE, never a raw SQLSTATE), and — for the DB-only
 * invariants (version-uniqueness index, lineage trigger, append-only trigger, deferred count trigger)
 * — a BACKSTOP leg that bypasses the core's product-code validation with a raw INSERT and proves the
 * database itself refuses. Load-bearingness of each product-code guard is verified out-of-band by the
 * gate (neuter the core check → the negative leg reddens because it now sees the DB SQLSTATE, not the
 * product code); the guards are written as discrete functions precisely so that mutation is possible.
 *
 * INERT: this suite is the ONLY caller of the core. The live/scheduled boundary still fails closed
 * (`W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED`, unchanged). Two-point wired (vitest.config exclude +
 * plugin-tests.yml attendance real-DB run-list) so the no-DB job cannot skip-green it.
 *
 * Shared-DB discipline: every fixture identity is namespaced per run; append-only rows are left behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import type { AttendanceSegmentCalculationResultV1 } from '../../src/attendance/w4c1-segment-calculator'
import type { AttendanceInputProvenanceRefV1 } from '../../src/attendance/w4c0-fingerprints'
import {
  appendAuthoritativeLegacyBaselineV1,
  writeAuthoritativeSegmentCalculationV1,
  writeAuthoritativeReversalV1,
  projectedDailyFingerprintV1,
  AttendanceW4AuthoritativeCalculationError,
  ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1 as CODES,
  type AttendanceAuthoritativeParentPreimageV1,
  type AttendanceAuthoritativePreimageProjectionV1,
} from '../../src/attendance/w4c2-authoritative-calculation-core'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const WORK_DATE = '2026-03-02'
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const TZ = 'Asia/Shanghai'

function uuid(): string {
  return crypto.randomUUID()
}

const asTrx = (client: PoolClient): AttendanceW4TransactionClientV1 =>
  client as unknown as AttendanceW4TransactionClientV1

function provenanceRef(): AttendanceInputProvenanceRefV1 {
  return {
    transport: 'live_event',
    sourceRef: `live:${RUN}`,
    artifactSha256: null,
    normalizedCsvSha256: null,
    convertedSheetName: null,
  }
}

function resolvedAttribution(): unknown {
  return {
    posture: 'resolved_v2',
    value: { workDate: WORK_DATE, shiftId: `shift-${RUN}`, resolvedAt: '2026-03-02T00:00:00.000Z', reasonCode: 'DIRECT' },
  }
}

function frozenContext(): unknown {
  return { timezone: TZ, workDate: WORK_DATE, segments: [] }
}

function completedCalculation(segmentCount: 1 | 2 | 3, workedMinutes = 480): AttendanceSegmentCalculationResultV1 {
  const segments = Array.from({ length: segmentCount }, (_unused, index) => ({
    segmentIndex: index as 0 | 1 | 2,
    expectedStartAt: '2026-03-02T01:00:00.000Z',
    expectedEndAt: '2026-03-02T09:00:00.000Z',
    expectedStartOffsetMinutes: 480,
    expectedEndOffsetMinutes: 1080,
    expectedStartFold: 'unique' as const,
    expectedEndFold: 'unique' as const,
    actualInAt: '2026-03-02T01:00:00.000Z',
    actualOutAt: '2026-03-02T09:00:00.000Z',
    workedMinutes,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeExtensionMinutes: 0,
    excusedByLeave: false,
    status: 'normal' as const,
    reasons: ['within_window' as const],
    matchedEvidenceRefs: [],
    unmatchedEvidenceRefs: [],
  }))
  return {
    outcome: 'completed',
    outcomeReasonCode: 'calculated',
    segments,
    dailyProjection: {
      firstInAt: '2026-03-02T01:00:00.000Z',
      lastOutAt: '2026-03-02T09:00:00.000Z',
      workedMinutes,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: 'normal',
      timezone: TZ,
      workDate: WORK_DATE,
      meta: null,
    },
  }
}

function reviewCalculation(): AttendanceSegmentCalculationResultV1 {
  return { outcome: 'review_required', outcomeReasonCode: 'ambiguous_segment_match', segments: [], dailyProjection: null }
}

const LEGACY_PROJECTION: AttendanceAuthoritativePreimageProjectionV1 = Object.freeze({
  status: 'normal',
  firstInAt: '2026-03-02T01:30:00.000Z',
  lastOutAt: '2026-03-02T08:30:00.000Z',
  workMinutes: 420,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
})

function presentLegacyPreimage(): AttendanceAuthoritativeParentPreimageV1 {
  return {
    posture: 'present',
    projectionOwner: 'legacy_untracked',
    currentCalculationId: null,
    visibilityState: 'active',
    visibilityReason: 'active',
    projection: LEGACY_PROJECTION,
    compatibilityFingerprint: HEX_A,
  }
}

function segmentInput(overrides: Partial<Parameters<typeof writeAuthoritativeSegmentCalculationV1>[1]> = {}) {
  const operationId = uuid()
  const payloadFingerprint = HEX_B
  return {
    orgId: `org-${RUN}`,
    recordId: '00000000-0000-0000-0000-000000000000',
    entrypoint: 'live',
    operationId,
    calculation: completedCalculation(1),
    attribution: resolvedAttribution() as never,
    context: frozenContext() as never,
    evidence: [],
    approvedFacts: [],
    provenanceRef: provenanceRef(),
    inputProvenance: { schemaVersion: 1, payloadFingerprint },
    payloadFingerprint,
    preimage: presentLegacyPreimage(),
    expectedCurrentCalculationId: null,
    actorId: `actor-${RUN}`,
    correlationId: `corr-${RUN}`,
    ...overrides,
  }
}

describeIfDatabase('W4C-2 Gate D1 — authoritative-mode result-write CORE (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let migrationDb: Kysely<unknown> | undefined

  beforeAll(async () => {
    migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
    })
    await up(migrationDb)
  }, 60000)

  afterAll(async () => {
    await migrationDb?.destroy()
    await pool.end()
  })

  // ---- fixtures ----------------------------------------------------------

  async function insertLegacyActiveParent(org: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO attendance_records
         (user_id, work_date, org_id, timezone, status, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes)
       VALUES ($1, $2::date, $3, $4, 'normal', $5, $6, 420, 0, 0)
       RETURNING id::text AS id`,
      [`u-${uuid()}`, WORK_DATE, org, TZ, LEGACY_PROJECTION.firstInAt, LEGACY_PROJECTION.lastOutAt],
    )
    return String(rows[0].id)
  }

  async function withTxn<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let result: T
      try {
        result = await fn(client)
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
      await client.query('COMMIT')
      return result
    } finally {
      client.release()
    }
  }

  async function expectProductCode(promise: Promise<unknown>, code: string): Promise<void> {
    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AttendanceW4AuthoritativeCalculationError)
    expect((caught as AttendanceW4AuthoritativeCalculationError).code).toBe(code)
  }

  async function calcRow(id: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await pool.query(
      `SELECT * FROM attendance_record_calculations WHERE id = $1::uuid`,
      [id],
    )
    return rows[0]
  }

  async function recordRow(id: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(`SELECT * FROM attendance_records WHERE id = $1::uuid`, [id])
    return rows[0]
  }

  async function countCalcs(recordId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_record_calculations WHERE attendance_record_id = $1::uuid`,
      [recordId],
    )
    return rows[0].n as number
  }

  // First authoritative completed write on a fresh active legacy parent → returns {recordId, calcId}.
  async function seedFirstCompleted(org: string): Promise<{ recordId: string; calcId: string; baselineId: string }> {
    const recordId = await insertLegacyActiveParent(org)
    const result = await withTxn((client) =>
      writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId })),
    )
    if (result.kind !== 'completed') throw new Error('seed expected completed')
    return { recordId, calcId: result.calculationId, baselineId: result.baselineCalculationId as string }
  }

  // =========================================================================
  // Invariant 3 — legacy_baseline (built/tested first per build order).
  // =========================================================================
  describe('§7.3 invariant 3 — legacy_baseline', () => {
    it('POSITIVE: append snapshots the legacy projection with effect=none, 0 children, op_id NULL, fp=compat', async () => {
      const org = `org-b-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const result = await withTxn((client) =>
        appendAuthoritativeLegacyBaselineV1(asTrx(client), {
          orgId: org,
          recordId,
          entrypoint: 'live',
          projection: LEGACY_PROJECTION,
          compatibilityFingerprint: HEX_A,
          parentPreimageSnapshot: presentLegacyPreimage(),
          actorId: `actor-${RUN}`,
          correlationId: `corr-${RUN}`,
        }),
      )
      expect(result.kind).toBe('appended')
      const row = await calcRow(result.kind === 'appended' ? result.baselineCalculationId : '')
      expect(row?.calculation_kind).toBe('legacy_baseline')
      expect(row?.mode).toBe('authoritative')
      expect(row?.outcome).toBe('baseline')
      expect(row?.outcome_reason_code).toBe('legacy_projection_baseline')
      expect(row?.projection_effect).toBe('none')
      expect(row?.expected_segment_count).toBe(0)
      expect(row?.operation_id).toBeNull()
      expect(row?.supersedes_calculation_id).toBeNull()
      expect(row?.projected_daily_fingerprint).toBe(HEX_A)
    })

    it('POSITIVE (idempotent): a second append returns the existing baseline, allocates no new row', async () => {
      const org = `org-b2-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const first = await withTxn((client) =>
        appendAuthoritativeLegacyBaselineV1(asTrx(client), baselineInput(org, recordId)),
      )
      const second = await withTxn((client) =>
        appendAuthoritativeLegacyBaselineV1(asTrx(client), baselineInput(org, recordId)),
      )
      expect(first.baselineCalculationId).toBe(second.baselineCalculationId)
      expect(second.kind).toBe('exists')
      expect(await countCalcs(recordId)).toBe(1)
    })

    it('NEGATIVE (product code): a non-hex compatibility fingerprint is refused with BASELINE_FINGERPRINT_INVALID', async () => {
      const org = `org-b3-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      await expectProductCode(
        withTxn((client) =>
          appendAuthoritativeLegacyBaselineV1(asTrx(client), { ...baselineInput(org, recordId), compatibilityFingerprint: 'not-hex' }),
        ),
        CODES.BASELINE_FINGERPRINT_INVALID,
      )
      expect(await countCalcs(recordId)).toBe(0)
    })

    it('BACKSTOP (uq_arc_baseline): a raw second legacy_baseline with the same fingerprint is refused by the DB', async () => {
      const org = `org-b4-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      await withTxn((client) => appendAuthoritativeLegacyBaselineV1(asTrx(client), baselineInput(org, recordId)))
      let caught: unknown
      try {
        await withTxn((client) => rawInsertBaseline(client, org, recordId, HEX_A, 99))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
    })

    it('SAME-TXN atomicity (§7.3): a failure in the calc step after the baseline write leaves NEITHER row', async () => {
      // Active legacy parent + a completed calc whose projection carries a negative minute → the calc
      // INSERT trips chk_arc_projected_minutes AFTER the baseline is appended in the same txn. If the
      // baseline were written on a separate/auto-committing connection it would survive; it must not.
      const org = `org-b5-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const bad = completedCalculation(1)
      ;(bad.dailyProjection as { workedMinutes: number }).workedMinutes = -1
      let caught: unknown
      try {
        await withTxn((client) =>
          writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, calculation: bad })),
        )
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
      expect(await countCalcs(recordId)).toBe(0)
    })
  })

  function baselineInput(org: string, recordId: string) {
    return {
      orgId: org,
      recordId,
      entrypoint: 'live',
      projection: LEGACY_PROJECTION,
      compatibilityFingerprint: HEX_A,
      parentPreimageSnapshot: presentLegacyPreimage(),
      actorId: `actor-${RUN}`,
      correlationId: `corr-${RUN}`,
    }
  }

  async function rawInsertBaseline(client: PoolClient, org: string, recordId: string, fp: string, version: number): Promise<void> {
    await client.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint, engine_version,
          snapshot_schema_version, operation_id, semantic_input_fingerprint, provenance_fingerprint,
          source_definition_fingerprint, attribution_snapshot, context_snapshot, segment_snapshot,
          evidence_snapshot, approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
          outcome, outcome_reason_code, projection_effect, expected_segment_count, projected_status,
          projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
          projected_daily_fingerprint, actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, $4, 'legacy_baseline', 'authoritative', 'live', 'raw', 1, NULL,
               $5, $5, $5, '{"posture":"unsupported","sourceSchemaVersion":1,"reason":"legacy_v1","sourceFingerprint":null}'::jsonb,
               '{"schemaVersion":1}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{"schemaVersion":1}'::jsonb,
               'append', 'legacy_shadow', 'baseline', 'legacy_projection_baseline', 'none', 0, 'normal',
               420, 0, 0, $5, 'raw-actor', $6)`,
      [uuid(), org, recordId, version, fp, `raw-${RUN}`],
    )
  }

  // =========================================================================
  // Invariant 7 (completed) + invariant 4 (supersedes) — the main live path.
  // =========================================================================
  describe('§7.3 invariant 7 — completed normal calculation + parent pointer', () => {
    it('POSITIVE: completed → baseline+calc appended, effect=set_active, count in 1..3, pointer moves, daily fields match', async () => {
      const org = `org-c-${RUN}`
      const { recordId, calcId, baselineId } = await seedFirstCompleted(org)
      const calc = await calcRow(calcId)
      expect(calc?.outcome).toBe('completed')
      expect(calc?.mode).toBe('authoritative')
      expect(calc?.projection_effect).toBe('set_active')
      expect(calc?.expected_segment_count).toBe(1)
      expect(calc?.calculation_tier).toBe('segment_authoritative')
      expect(calc?.supersedes_calculation_id).toBe(baselineId)
      expect(calc?.projected_daily_fingerprint).toBe(
        projectedDailyFingerprintV1({ status: 'normal', firstInAt: '2026-03-02T01:00:00.000Z', lastOutAt: '2026-03-02T09:00:00.000Z', workedMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0 }),
      )
      const rec = await recordRow(recordId)
      expect(rec.current_calculation_id).toBe(calcId)
      expect(rec.projection_owner).toBe('w4')
      expect(rec.visibility_state).toBe('active')
      expect(Number(rec.work_minutes)).toBe(480)
      const seg = await pool.query(`SELECT count(*)::int AS n FROM attendance_record_segments WHERE calculation_id = $1::uuid`, [calcId])
      expect(seg.rows[0].n).toBe(1)
    })

    it('NEGATIVE (product code): completed with 0 segments is refused with EXPECTED_COUNT_INVALID', async () => {
      const org = `org-c2-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const zero = completedCalculation(1)
      zero.segments = []
      await expectProductCode(
        withTxn((client) => writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, calculation: zero }))),
        CODES.EXPECTED_COUNT_INVALID,
      )
      expect(await countCalcs(recordId)).toBe(0)
    })

    it('NEGATIVE (product code): completed without a frozen context is refused with COMPLETED_SHAPE_INVALID', async () => {
      const org = `org-c3-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      await expectProductCode(
        withTxn((client) => writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, context: null }))),
        CODES.COMPLETED_SHAPE_INVALID,
      )
      expect(await countCalcs(recordId)).toBe(0)
    })

    it('BACKSTOP (deferred count trigger): a completed row committed with the wrong child count is refused at COMMIT', async () => {
      const org = `org-c4-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      let caught: unknown
      try {
        // expected_segment_count=2 but the writer produces exactly segments.length children (here 1) —
        // force the mismatch by committing a raw completed row claiming 2 with 1 child.
        await withTxn((client) => rawInsertCompletedWithChildren(client, org, recordId, 2, 1))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
    })
  })

  describe('§7.3 invariant 4 — supersedes the exact locked current pointer', () => {
    it('POSITIVE: a second completed calc supersedes the first and the pointer moves to it', async () => {
      const org = `org-s-${RUN}`
      const { recordId, calcId: first } = await seedFirstCompleted(org)
      const second = await withTxn((client) =>
        writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, expectedCurrentCalculationId: first, calculation: completedCalculation(1, 500) })),
      )
      if (second.kind !== 'completed') throw new Error('expected completed')
      expect(second.supersedesCalculationId).toBe(first)
      expect(second.baselineCalculationId).toBeNull()
      const calc = await calcRow(second.calculationId)
      expect(Number(calc?.version)).toBeGreaterThan(2)
      const rec = await recordRow(recordId)
      expect(rec.current_calculation_id).toBe(second.calculationId)
    })

    it('NEGATIVE (product code): a stale expectedCurrentCalculationId is refused with VERSION_CONFLICT', async () => {
      const org = `org-s2-${RUN}`
      const { recordId } = await seedFirstCompleted(org)
      await expectProductCode(
        withTxn((client) =>
          // parent now points at the first calc, but the caller still believes it is null → stale.
          writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, expectedCurrentCalculationId: null, calculation: completedCalculation(1, 500) })),
        ),
        CODES.VERSION_CONFLICT,
      )
    })

    it('NEGATIVE (product code): a missing parent record is refused with RECORD_NOT_FOUND', async () => {
      const org = `org-s3-${RUN}`
      await expectProductCode(
        withTxn((client) => writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId: uuid() }))),
        CODES.RECORD_NOT_FOUND,
      )
    })

    it('BACKSTOP (uq_arc_record_version): a raw duplicate (record, version) is refused by the DB', async () => {
      const org = `org-s4-${RUN}`
      const { recordId } = await seedFirstCompleted(org)
      let caught: unknown
      try {
        await withTxn((client) => rawInsertBaseline(client, org, recordId, HEX_B, 1))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
    })
  })

  // =========================================================================
  // Invariant 2 — retry idempotency on (org, entrypoint, operation_id).
  // =========================================================================
  describe('§7.3 invariant 2 — retry idempotency', () => {
    it('POSITIVE: the same operation_id twice returns the existing calc and allocates NO new version', async () => {
      const org = `org-r-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const input = segmentInput({ orgId: org, recordId })
      const first = await withTxn((client) => writeAuthoritativeSegmentCalculationV1(asTrx(client), input))
      const before = await countCalcs(recordId)
      const second = await withTxn((client) => writeAuthoritativeSegmentCalculationV1(asTrx(client), input))
      expect(second.kind).toBe('replay')
      expect(second.calculationId).toBe(first.calculationId)
      expect(await countCalcs(recordId)).toBe(before)
    })

    it('NEGATIVE (product code): the same operation_id with a different payload is refused with REPLAY_CONFLICT', async () => {
      const org = `org-r2-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const operationId = uuid()
      await withTxn((client) =>
        writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, operationId, payloadFingerprint: HEX_A, inputProvenance: { schemaVersion: 1, payloadFingerprint: HEX_A } })),
      )
      await expectProductCode(
        withTxn((client) =>
          writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, operationId, payloadFingerprint: HEX_B, inputProvenance: { schemaVersion: 1, payloadFingerprint: HEX_B } })),
        ),
        CODES.REPLAY_CONFLICT,
      )
    })

    it('BACKSTOP (uq_arc_operation): a raw duplicate (org, entrypoint, operation_id) is refused by the DB', async () => {
      const org = `org-r3-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const operationId = uuid()
      await withTxn((client) =>
        writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, operationId })),
      )
      let caught: unknown
      try {
        await withTxn((client) => rawInsertReviewWithOperation(client, org, recordId, operationId))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
    })
  })

  // =========================================================================
  // Invariant 5 — review_required hidden placeholder (all projected NULL).
  // =========================================================================
  describe('§7.3 invariant 5 — review_required hidden placeholder', () => {
    it('POSITIVE: every projected daily field is NULL, effect none, 0 children, no supersedes/pointer change', async () => {
      const org = `org-rv-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const before = await recordRow(recordId)
      const result = await withTxn((client) =>
        writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, calculation: reviewCalculation() })),
      )
      expect(result.kind).toBe('review')
      const row = await calcRow(result.kind === 'review' ? result.calculationId : '')
      expect(row?.outcome).toBe('review_required')
      expect(row?.projection_effect).toBe('none')
      expect(row?.expected_segment_count).toBe(0)
      expect(row?.supersedes_calculation_id).toBeNull()
      for (const field of ['projected_status', 'projected_first_in_at', 'projected_last_out_at', 'projected_work_minutes', 'projected_late_minutes', 'projected_early_leave_minutes']) {
        expect(row?.[field]).toBeNull()
      }
      // pointer untouched (still legacy_untracked / null)
      const after = await recordRow(recordId)
      expect(after.current_calculation_id).toBe(before.current_calculation_id)
      expect(after.projection_owner).toBe('legacy_untracked')
      // §7.3 "a later first completed result … needs no baseline because no active compatibility
      // projection existed". This leg proves the CORE branch: a retired/review_placeholder parent
      // (the state §7.5 requires a fresh authoritative review to install) takes NO baseline and no
      // supersedes. The retired/review_placeholder precondition is installed here by fixture — it is
      // NOT an end-to-end review→completed proof (the boundary, not this core, decides whether a
      // fresh review leaves the parent retired; that is a D2/D3 seam, see the PR body's open items).
      await pool.query(
        `UPDATE attendance_records SET visibility_state='retired', visibility_reason='review_placeholder' WHERE id=$1::uuid`,
        [recordId],
      )
      const completed = await withTxn((client) =>
        writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, expectedCurrentCalculationId: null })),
      )
      if (completed.kind !== 'completed') throw new Error('expected completed')
      expect(completed.baselineCalculationId).toBeNull()
      expect(completed.supersedesCalculationId).toBeNull()
    })

    it('NEGATIVE (product code): a review row carrying a non-null projected field is refused with REVIEW_SHAPE_INVALID', async () => {
      const org = `org-rv2-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      const bad = reviewCalculation()
      // a projection present on a review outcome is exactly the fabricated zero-minute row §7.5 forbids.
      ;(bad as { dailyProjection: unknown }).dailyProjection = completedCalculation(1).dailyProjection
      await expectProductCode(
        withTxn((client) => writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, calculation: bad }))),
        CODES.REVIEW_SHAPE_INVALID,
      )
      expect(await countCalcs(recordId)).toBe(0)
    })

    it('BACKSTOP (chk_arc_review_shape): a raw review row with a non-null projected field is refused by the DB', async () => {
      const org = `org-rv3-${RUN}`
      const recordId = await insertLegacyActiveParent(org)
      let caught: unknown
      try {
        await withTxn((client) => rawInsertReviewWithProjectedStatus(client, org, recordId))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
    })
  })

  // =========================================================================
  // Invariant 6 — reversal.
  // =========================================================================
  describe('§7.3 invariant 6 — reversal', () => {
    it('POSITIVE (present preimage): reversal restores the earlier calc; restores == preimage pointer; effect set_active; pointer restored', async () => {
      const org = `org-x-${RUN}`
      const { recordId, calcId: first } = await seedFirstCompleted(org)
      const firstRow = await calcRow(first)
      const second = await withTxn((client) =>
        writeAuthoritativeSegmentCalculationV1(asTrx(client), segmentInput({ orgId: org, recordId, expectedCurrentCalculationId: first, calculation: completedCalculation(1, 500) })),
      )
      if (second.kind !== 'completed') throw new Error('expected completed')
      const reversed = await calcRow(second.calculationId)
      const reversal = await withTxn((client) =>
        writeAuthoritativeReversalV1(asTrx(client), reversalInput(org, recordId, {
          supersedesCalculationId: second.calculationId,
          reversedRow: reversed as Record<string, unknown>,
          preimage: presentPointerPreimage(first, projectionOf(firstRow as Record<string, unknown>)),
          restoresCalculationId: first,
          frozenTarget: { visibilityState: 'active', visibilityReason: 'active', projection: projectionOf(reversed as Record<string, unknown>), dailyFingerprint: String((reversed as Record<string, unknown>).projected_daily_fingerprint) },
          outcomeReasonCode: 'import_rollback_reversal',
          mergePolicy: 'reversal',
        })),
      )
      expect(reversal.projectionEffect).toBe('set_active')
      expect(reversal.restoresCalculationId).toBe(first)
      const row = await calcRow(reversal.calculationId)
      expect(row?.calculation_kind).toBe('reversal')
      expect(row?.restores_calculation_id).toBe(first)
      expect(row?.supersedes_calculation_id).toBe(second.calculationId)
      const rec = await recordRow(recordId)
      expect(rec.current_calculation_id).toBe(first) // pointer restored to the earlier calc
    })

    it('POSITIVE (absent preimage): reversal retires; restores NULL; effect set_retired; pointer moves to the reversal row', async () => {
      const org = `org-x2-${RUN}`
      const { recordId, calcId: first } = await seedFirstCompleted(org)
      const reversed = await calcRow(first)
      const reversal = await withTxn((client) =>
        writeAuthoritativeReversalV1(asTrx(client), reversalInput(org, recordId, {
          supersedesCalculationId: first,
          reversedRow: reversed as Record<string, unknown>,
          preimage: { posture: 'absent' },
          restoresCalculationId: null,
          frozenTarget: { visibilityState: 'retired', visibilityReason: 'import_rollback', projection: projectionOf(reversed as Record<string, unknown>), dailyFingerprint: String((reversed as Record<string, unknown>).projected_daily_fingerprint) },
          outcomeReasonCode: 'import_rollback_reversal',
          mergePolicy: 'reversal',
        })),
      )
      expect(reversal.projectionEffect).toBe('set_retired')
      expect(reversal.restoresCalculationId).toBeNull()
      const row = await calcRow(reversal.calculationId)
      expect(row?.restores_calculation_id).toBeNull()
      const rec = await recordRow(recordId)
      expect(rec.current_calculation_id).toBe(reversal.calculationId)
      expect(rec.visibility_state).toBe('retired')
      expect(rec.visibility_reason).toBe('import_rollback')
    })

    it('NEGATIVE (product code): a reversal without a supersedes target is refused with REVERSAL_SUPERSEDES_REQUIRED', async () => {
      const org = `org-x3-${RUN}`
      const { recordId, calcId: first } = await seedFirstCompleted(org)
      const reversed = await calcRow(first)
      await expectProductCode(
        withTxn((client) =>
          writeAuthoritativeReversalV1(asTrx(client), reversalInput(org, recordId, {
            supersedesCalculationId: null,
            reversedRow: reversed as Record<string, unknown>,
            preimage: { posture: 'absent' },
            restoresCalculationId: null,
            frozenTarget: { visibilityState: 'retired', visibilityReason: 'import_rollback', projection: projectionOf(reversed as Record<string, unknown>), dailyFingerprint: String((reversed as Record<string, unknown>).projected_daily_fingerprint) },
            outcomeReasonCode: 'import_rollback_reversal',
            mergePolicy: 'reversal',
          })),
        ),
        CODES.REVERSAL_SUPERSEDES_REQUIRED,
      )
    })

    it('NEGATIVE (product code): a present preimage whose pointer != restores is refused with REVERSAL_RESTORES_MISMATCH', async () => {
      const org = `org-x4-${RUN}`
      const { recordId, calcId: first } = await seedFirstCompleted(org)
      const reversed = await calcRow(first)
      await expectProductCode(
        withTxn((client) =>
          writeAuthoritativeReversalV1(asTrx(client), reversalInput(org, recordId, {
            supersedesCalculationId: first,
            reversedRow: reversed as Record<string, unknown>,
            preimage: presentPointerPreimage(uuid()), // pointer is some other id
            restoresCalculationId: first, // ... but restores claims `first` → mismatch
            frozenTarget: { visibilityState: 'active', visibilityReason: 'active', projection: projectionOf(reversed as Record<string, unknown>), dailyFingerprint: String((reversed as Record<string, unknown>).projected_daily_fingerprint) },
            outcomeReasonCode: 'import_rollback_reversal',
            mergePolicy: 'reversal',
          })),
        ),
        CODES.REVERSAL_RESTORES_MISMATCH,
      )
    })

    it('NEGATIVE (product code): a restores target that does not exist is refused with LINEAGE_TARGET_MISSING', async () => {
      const org = `org-x5-${RUN}`
      const { recordId, calcId: first } = await seedFirstCompleted(org)
      const reversed = await calcRow(first)
      const bogus = uuid()
      await expectProductCode(
        withTxn((client) =>
          writeAuthoritativeReversalV1(asTrx(client), reversalInput(org, recordId, {
            supersedesCalculationId: first,
            reversedRow: reversed as Record<string, unknown>,
            preimage: presentPointerPreimage(bogus), // pointer == bogus so restores-match passes
            restoresCalculationId: bogus, // ... but no such calc exists → lineage target missing
            frozenTarget: { visibilityState: 'active', visibilityReason: 'active', projection: projectionOf(reversed as Record<string, unknown>), dailyFingerprint: String((reversed as Record<string, unknown>).projected_daily_fingerprint) },
            outcomeReasonCode: 'import_rollback_reversal',
            mergePolicy: 'reversal',
          })),
        ),
        CODES.LINEAGE_TARGET_MISSING,
      )
    })

    it('BACKSTOP (chk_arc_reversal_supersedes): a raw reversal row with NULL supersedes is refused by the DB', async () => {
      const org = `org-x6-${RUN}`
      const { recordId } = await seedFirstCompleted(org)
      let caught: unknown
      try {
        await withTxn((client) => rawInsertReversalNoSupersedes(client, org, recordId))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
    })
  })

  // =========================================================================
  // Invariant 1 (lineage backstops) + invariant 8 (append-only).
  // =========================================================================
  describe('§7.3 invariant 1 — lineage backstops (DB)', () => {
    it('BACKSTOP (trg_arc_lineage_guard): a raw supersedes pointing at a NOT-strictly-lower version is refused', async () => {
      const org = `org-l-${RUN}`
      const { recordId, calcId: first } = await seedFirstCompleted(org)
      // first has version 2; a raw baseline claiming version 1 that supersedes `first` (v2) → v2 >= v1.
      let caught: unknown
      try {
        await withTxn((client) => rawInsertSupersedingBaseline(client, org, recordId, first, 1))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
    })
  })

  describe('§7.3 invariant 8 — append-only (no updated_at, UPDATE refused)', () => {
    it('the calc table has no updated_at column', async () => {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='attendance_record_calculations' AND column_name='updated_at'`,
      )
      expect(rows.length).toBe(0)
    })

    it('BACKSTOP (deny_mutation): a raw UPDATE of a calc row is refused by the DB', async () => {
      const org = `org-a-${RUN}`
      const { calcId } = await seedFirstCompleted(org)
      let caught: unknown
      try {
        await withTxn((client) => client.query(`UPDATE attendance_record_calculations SET actor_id='x' WHERE id=$1::uuid`, [calcId]).then(() => undefined))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeTruthy()
    })
  })

  // ---- raw helpers for backstop legs ------------------------------------

  // For a present-pointer reversal the preimage projection MUST equal the restored calc's projection
  // (the record's daily fields are set to it, and the DB pointer guard checks them against the
  // selected row). Callers restoring a real calc pass that calc's projection; the negative legs
  // (which fail before the pointer move) can leave the default.
  function presentPointerPreimage(
    pointer: string,
    projection: AttendanceAuthoritativePreimageProjectionV1 = LEGACY_PROJECTION,
  ): AttendanceAuthoritativeParentPreimageV1 {
    return {
      posture: 'present',
      projectionOwner: 'w4',
      currentCalculationId: pointer,
      visibilityState: 'active',
      visibilityReason: 'active',
      projection,
      compatibilityFingerprint: HEX_A,
    }
  }

  function projectionOf(row: Record<string, unknown>): AttendanceAuthoritativePreimageProjectionV1 {
    return {
      status: String(row.projected_status ?? 'normal'),
      firstInAt: row.projected_first_in_at ? new Date(row.projected_first_in_at as string).toISOString() : null,
      lastOutAt: row.projected_last_out_at ? new Date(row.projected_last_out_at as string).toISOString() : null,
      workMinutes: Number(row.projected_work_minutes ?? 0),
      lateMinutes: Number(row.projected_late_minutes ?? 0),
      earlyLeaveMinutes: Number(row.projected_early_leave_minutes ?? 0),
    }
  }

  function reversalInput(
    org: string,
    recordId: string,
    spec: {
      supersedesCalculationId: string | null
      reversedRow: Record<string, unknown>
      preimage: AttendanceAuthoritativeParentPreimageV1
      restoresCalculationId: string | null
      frozenTarget: { visibilityState: 'active' | 'retired'; visibilityReason: 'active' | 'review_placeholder' | 'import_rollback' | 'operator_retirement'; projection: AttendanceAuthoritativePreimageProjectionV1; dailyFingerprint: string }
      outcomeReasonCode: 'import_rollback_reversal' | 'operator_retirement'
      mergePolicy: 'reversal' | 'retire'
    },
  ) {
    const r = spec.reversedRow
    return {
      orgId: org,
      recordId,
      entrypoint: 'import_rollback',
      operationId: uuid(),
      supersedesCalculationId: spec.supersedesCalculationId,
      reversedSnapshots: {
        semanticInputFingerprint: String(r.semantic_input_fingerprint),
        provenanceFingerprint: String(r.provenance_fingerprint),
        sourceDefinitionFingerprint: r.source_definition_fingerprint ? String(r.source_definition_fingerprint) : null,
        attributionSnapshot: r.attribution_snapshot,
        contextSnapshot: r.context_snapshot ?? null,
        evidenceSnapshot: Array.isArray(r.evidence_snapshot) ? (r.evidence_snapshot as unknown[]) : [],
        approvedFactsSnapshot: Array.isArray(r.approved_facts_snapshot) ? (r.approved_facts_snapshot as unknown[]) : [],
        manualOverrideSnapshot: r.manual_override_snapshot ?? null,
      },
      inputProvenance: { schemaVersion: 1, kind: 'import_rollback' },
      preimage: spec.preimage,
      frozenTarget: spec.frozenTarget,
      restoresCalculationId: spec.restoresCalculationId,
      outcomeReasonCode: spec.outcomeReasonCode,
      mergePolicy: spec.mergePolicy,
      actorId: `actor-${RUN}`,
      correlationId: `corr-${RUN}`,
    }
  }

  async function rawInsertCompletedWithChildren(client: PoolClient, org: string, recordId: string, claimed: number, children: number): Promise<void> {
    const id = uuid()
    await client.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint, engine_version,
          snapshot_schema_version, operation_id, semantic_input_fingerprint, provenance_fingerprint,
          source_definition_fingerprint, attribution_snapshot, context_snapshot, segment_snapshot,
          evidence_snapshot, approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
          outcome, outcome_reason_code, projection_effect, expected_segment_count, projected_status,
          projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
          projected_daily_fingerprint, actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, 900, 'calculation', 'authoritative', 'live', 'raw', 1, $4::uuid,
               $5, $5, $5, '{"posture":"resolved_v2","value":{}}'::jsonb, '{"tz":"x"}'::jsonb, '[]'::jsonb,
               '[]'::jsonb, '[]'::jsonb, '{"schemaVersion":1}'::jsonb, 'append', 'segment_authoritative',
               'completed', 'calculated', 'set_active', $6, 'normal', 480, 0, 0, $5, 'raw', $7)`,
      [id, org, recordId, uuid(), HEX_A, claimed, `raw-${RUN}`],
    )
    for (let i = 0; i < children; i += 1) {
      await client.query(
        `INSERT INTO attendance_record_segments
           (org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
            work_minutes, late_minutes, early_leave_minutes, status, status_reasons,
            matched_evidence_refs, unmatched_evidence_refs)
         VALUES ($1, $2::uuid, $3::uuid, $4, '2026-03-02T01:00:00Z', '2026-03-02T09:00:00Z',
                 480, 0, 0, 'normal', '["within_window"]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
        [org, recordId, id, i],
      )
    }
  }

  async function rawInsertReviewWithOperation(client: PoolClient, org: string, recordId: string, operationId: string): Promise<void> {
    await client.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint, engine_version,
          snapshot_schema_version, operation_id, semantic_input_fingerprint, provenance_fingerprint,
          source_definition_fingerprint, attribution_snapshot, context_snapshot, segment_snapshot,
          evidence_snapshot, approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
          outcome, outcome_reason_code, projection_effect, expected_segment_count, actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, 901, 'calculation', 'authoritative', 'live', 'raw', 1, $4::uuid,
               $5, $5, NULL, '{"posture":"unsupported","sourceSchemaVersion":1,"reason":"missing","sourceFingerprint":null}'::jsonb,
               NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{"schemaVersion":1}'::jsonb, 'append',
               'segment_authoritative', 'review_required', 'ambiguous_segment_match', 'none', 0, 'raw', $6)`,
      [uuid(), org, recordId, operationId, HEX_A, `raw-${RUN}`],
    )
  }

  async function rawInsertReviewWithProjectedStatus(client: PoolClient, org: string, recordId: string): Promise<void> {
    await client.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint, engine_version,
          snapshot_schema_version, operation_id, semantic_input_fingerprint, provenance_fingerprint,
          source_definition_fingerprint, attribution_snapshot, context_snapshot, segment_snapshot,
          evidence_snapshot, approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
          outcome, outcome_reason_code, projection_effect, expected_segment_count, projected_status, actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, 902, 'calculation', 'authoritative', 'live', 'raw', 1, $4::uuid,
               $5, $5, NULL, '{"posture":"unsupported","sourceSchemaVersion":1,"reason":"missing","sourceFingerprint":null}'::jsonb,
               NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{"schemaVersion":1}'::jsonb, 'append',
               'segment_authoritative', 'review_required', 'ambiguous_segment_match', 'none', 0, 'normal', 'raw', $6)`,
      [uuid(), org, recordId, uuid(), HEX_A, `raw-${RUN}`],
    )
  }

  async function rawInsertReversalNoSupersedes(client: PoolClient, org: string, recordId: string): Promise<void> {
    await client.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint, engine_version,
          snapshot_schema_version, operation_id, semantic_input_fingerprint, provenance_fingerprint,
          source_definition_fingerprint, attribution_snapshot, context_snapshot, segment_snapshot,
          evidence_snapshot, approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
          outcome, outcome_reason_code, projection_effect, expected_segment_count, projected_status,
          projected_work_minutes, projected_late_minutes, projected_early_leave_minutes, projected_daily_fingerprint, actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, 903, 'reversal', 'authoritative', 'import_rollback', 'raw', 1, $4::uuid,
               $5, $5, $5, '{"posture":"resolved_v2","value":{}}'::jsonb, '{"tz":"x"}'::jsonb, '[]'::jsonb,
               '[]'::jsonb, '[]'::jsonb, '{"schemaVersion":1}'::jsonb, 'reversal', 'segment_authoritative',
               'reversed', 'import_rollback_reversal', 'set_retired', 0, 'normal', 480, 0, 0, $5, 'raw', $6)`,
      [uuid(), org, recordId, uuid(), HEX_A, `raw-${RUN}`],
    )
  }

  async function rawInsertSupersedingBaseline(client: PoolClient, org: string, recordId: string, supersedes: string, version: number): Promise<void> {
    await client.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint, engine_version,
          snapshot_schema_version, supersedes_calculation_id, operation_id, semantic_input_fingerprint,
          provenance_fingerprint, source_definition_fingerprint, attribution_snapshot, context_snapshot,
          segment_snapshot, evidence_snapshot, approved_facts_snapshot, input_provenance, merge_policy,
          calculation_tier, outcome, outcome_reason_code, projection_effect, expected_segment_count,
          projected_status, projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
          projected_daily_fingerprint, actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, $7, 'reversal', 'authoritative', 'import_rollback', 'raw', 1, $4::uuid, $8::uuid,
               $5, $5, $5, '{"posture":"resolved_v2","value":{}}'::jsonb, '{"tz":"x"}'::jsonb, '[]'::jsonb,
               '[]'::jsonb, '[]'::jsonb, '{"schemaVersion":1}'::jsonb, 'reversal', 'segment_authoritative',
               'reversed', 'import_rollback_reversal', 'set_retired', 0, 'normal', 480, 0, 0, $5, 'raw', $6)`,
      [uuid(), org, recordId, supersedes, HEX_A, `raw-${RUN}`, version, uuid()],
    )
  }
})
