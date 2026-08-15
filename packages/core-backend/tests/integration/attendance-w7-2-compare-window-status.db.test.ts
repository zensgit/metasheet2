/**
 * W7-2 (#4556) — §3.5 compare-window exit-criteria counters (real DB).
 *
 * Authority: #4556 comments 5293034619 + 5293478713; design lock §4.2;
 * W4C-5 amendment §3 ("counts returned by the command, no caller-supplied
 * `ready=true`").
 *
 * Brief matrix legs T-C1..T-C8 and the seeded halves of T-D1..T-D3.
 *
 * ⚠️ SEEDED LEGS, labelled per brief §5.0: every W7 "compare row" in this
 * suite is INSERTed directly (with distinct operation ids), standing in for
 * the produced-row twins that the dual-run suite
 * (`attendance-w7-2-group-shadow-dualrun.db.test.ts`) drives through the real
 * boundary producers. The V2 `context_snapshot` payloads are NOT hand-written
 * JSON blobs: they are minted by the real issuance operation
 * (`coreIssueGroupEffectiveContextV2`) so the seeded rows carry exactly the
 * shape the seam persists (fixture-shape rule — a bare stand-in that never
 * traversed the producing operation is a false green).
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID;
 * the suite writes only its own rows and deletes them in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID, createHash } from 'crypto'
import { Pool, type PoolClient } from 'pg'
import {
  readAttendanceW7CompareWindowStatusV1,
  ATTENDANCE_W7_COMPARE_PREDICATE_CODES_V1,
  ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1,
  AttendanceW7CompareWindowError,
} from '../../src/attendance/w7-compare-window-status'
import {
  readAttendanceRequestSnapshotDefectReportV1,
  ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1,
} from '../../src/attendance/w4c3a-rollout-control'
import { coreIssueGroupEffectiveContextV2 } from '../../src/attendance/w7-resolver/w7-group-effective-context-issuance'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const WORK_DATE = '2026-01-05'
const OUT_OF_WINDOW_DATE = '2026-02-01'
const WINDOW = { from: '2026-01-01', to: '2026-01-31' }

type TrxClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }
const asTrx = (client: Pool | PoolClient): TrxClient => ({
  query: async (sql: string, params?: unknown[]) => {
    const result = await client.query(sql, params)
    return { rows: result.rows }
  },
})

/** A REAL issuance-operation-minted V2 context (never a hand-written blob). */
function mintV2Context(orgId: string, userId: string, workDate: string) {
  return coreIssueGroupEffectiveContextV2({
    orgId,
    userId,
    workDate,
    timezone: 'UTC',
    calculationGroupId: randomUUID(),
    shiftId: randomUUID(),
    isWorkday: true,
    holidayKind: null,
    roundingMinutes: 15,
    severeLateThresholdMinutes: 30,
    absenceLateThresholdMinutes: 60,
    segments: [
      {
        index: 0,
        startTime: '09:00',
        endTime: '18:00',
        startDayOffset: 0,
        endDayOffset: 0,
        lateGraceMinutes: 5,
        earlyLeaveGraceMinutes: 5,
      },
    ],
  })
}

/** The legacy V1 shape, for the W4-shadow twin rows (same recipe as the
 *  landed od-w7-10 suite's `contextFor`). */
function v1Context(orgId: string, userId: string, workDate: string) {
  return {
    schemaVersion: 1,
    selector: 'legacy',
    orgId,
    userId,
    workDate,
    timezone: 'UTC',
    shiftId: randomUUID(),
    isWorkday: true,
    holidayKind: null,
    calculationGroupId: null,
    roundingMinutes: 15,
    severeLateThresholdMinutes: 30,
    absenceLateThresholdMinutes: 60,
    segments: [
      { index: 0, startTime: '09:00', endTime: '18:00', startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 5, earlyLeaveGraceMinutes: 5 },
    ],
  }
}

function hex64(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

type ShadowRowSpec = {
  recordId: string
  orgId: string
  entrypoint?: 'live' | 'scheduled'
  /** null = fail-close record (no group context) */
  context: Record<string, unknown> | null
  /** marker: undefined = W4 row (no marker); string|null = W7 row (`shadowReason`) */
  w7Marker?: { shadowReason: string | null }
  outcome: 'completed' | 'review_required'
  outcomeReasonCode: string
  shadowDiffCode: string
  changedFields?: readonly string[]
  projectedStatus?: string
}

describeDb('W7-2 §3.5 — compare-window exit-criteria counters (real DB, seeded legs)', () => {
  let pool: Pool
  const orgs: string[] = []
  const users: string[] = []
  const mkOrg = () => {
    const id = randomUUID()
    orgs.push(id)
    return id
  }
  const mkUser = () => {
    const id = randomUUID()
    users.push(id)
    return id
  }

  async function insertRecord(orgId: string, userId: string, workDate: string): Promise<string> {
    const recordId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes,
          status, is_workday, projection_owner, visibility_state, visibility_reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'UTC',480,0,0,'normal',true,'legacy_untracked','active','active',now(),now())`,
      [recordId, userId, orgId, workDate],
    )
    return recordId
  }

  /** Direct INSERT against the real CHECK matrix + deferred segment-count
   *  trigger (calculation + child segment in ONE transaction — same recipe as
   *  the landed od-w7-10 suite). Distinct operation ids per row: the shared
   *  operation-id dedup partition is the DUAL-RUN suite's produced-row
   *  concern, not this seeded suite's. */
  async function insertShadowRow(spec: ShadowRowSpec): Promise<string> {
    const calculationId = randomUUID()
    const completed = spec.outcome === 'completed'
    // W7 comparison records carry `operation_id NULL` and the producing
    // operation in the marker (chk_arc_operation_id's marker disjunct);
    // served-path rows carry their operation id as before.
    const inputProvenance =
      spec.w7Marker === undefined
        ? {}
        : {
            [ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1]: {
              schemaVersion: 1,
              operationId: randomUUID(),
              shadowReason: spec.w7Marker.shadowReason,
            },
          }
    const shadowDiff = {
      schemaVersion: 1,
      code: spec.shadowDiffCode,
      changedFields: spec.changedFields ?? [],
      absoluteMinuteDelta: 0,
      segmentCount: completed ? 1 : 0,
    }
    const seedClient = await pool.connect()
    try {
      await seedClient.query('BEGIN')
      await seedClient.query(
        `INSERT INTO attendance_record_calculations
           (id, attendance_record_id, org_id, version,
            calculation_kind, mode, entrypoint, engine_version, snapshot_schema_version,
            semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
            attribution_snapshot, segment_snapshot, evidence_snapshot, approved_facts_snapshot,
            input_provenance, merge_policy, calculation_tier,
            outcome, outcome_reason_code, projection_effect, expected_segment_count,
            actor_id, correlation_id, operation_id,
            projected_status, projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
            shadow_diff_code, shadow_diff, context_snapshot, created_at)
         VALUES ($1,$2,$3,
                 (SELECT COALESCE(MAX(version),0)+1 FROM attendance_record_calculations WHERE attendance_record_id = $2),
                 'calculation','shadow',$4,'w7-2-seed',1,
                 $5,$6,$7,
                 $8::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                 $9::jsonb,'append','legacy_shadow',
                 $10,$11,'none',$12,
                 'w7-2-seed-actor',$13,$14::uuid,
                 $15,$16,$17,$18,
                 $19,$20::jsonb,$21::jsonb, now())`,
        [
          calculationId,
          spec.recordId,
          spec.orgId,
          spec.entrypoint ?? 'live',
          hex64(`semantic:${calculationId}`),
          hex64(`provenance:${calculationId}`),
          hex64(`sourcedef:${calculationId}`),
          JSON.stringify({
            posture: 'resolved_v2',
            value: { orgId: spec.orgId, userId: 'seed', workDate: WORK_DATE, shiftId: randomUUID() },
          }),
          JSON.stringify(inputProvenance),
          spec.outcome,
          spec.outcomeReasonCode,
          completed ? 1 : 0,
          `w7-2-corr-${calculationId}`,
          spec.w7Marker === undefined ? randomUUID() : null,
          completed ? spec.projectedStatus ?? 'normal' : null,
          completed ? 480 : null,
          completed ? 0 : null,
          completed ? 0 : null,
          spec.shadowDiffCode,
          JSON.stringify(shadowDiff),
          spec.context === null ? null : JSON.stringify(spec.context),
        ],
      )
      if (completed) {
        await seedClient.query(
          `INSERT INTO attendance_record_segments
             (org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
              work_minutes, late_minutes, early_leave_minutes, status, status_reasons,
              matched_evidence_refs, unmatched_evidence_refs)
           VALUES ($1,$2::uuid,$3::uuid,0,$4::timestamptz,$5::timestamptz,480,0,0,'normal','["within_window"]'::jsonb,'[]'::jsonb,'[]'::jsonb)`,
          [spec.orgId, spec.recordId, calculationId, `${WORK_DATE}T00:00:00Z`, `${WORK_DATE}T23:59:00Z`],
        )
      }
      await seedClient.query('COMMIT')
    } catch (error) {
      await seedClient.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      seedClient.release()
    }
    return calculationId
  }

  const status = (orgId: string, from = WINDOW.from, to = WINDOW.to) =>
    readAttendanceW7CompareWindowStatusV1(asTrx(pool), { orgId, from, to })

  const predicate = (
    result: Awaited<ReturnType<typeof readAttendanceW7CompareWindowStatusV1>>,
    code: string,
  ) => {
    const found = result.predicates.filter((p) => p.code === code)
    expect(found.length, `predicate ${code} must appear exactly once`).toBe(1)
    return found[0]
  }

  // Fixture orgs, seeded in beforeAll:
  let orgMixed = '' // the T-D1/T-C2 org: W4+W7 twins, critical, equal, fail-close
  let orgClean = '' // all predicates pass (positive control for `blocked`)
  let orgOffRosterOnly = '' // only OFF_ROSTER fails
  let orgFailcloseOnly = '' // only GROUP_RESOLUTION_FAILCLOSE fails
  let orgEmpty = '' // empty window: only COVERAGE fails
  let orgIngress = '' // only UNRESOLVED_INGRESS_REVIEW fails (plus coverage pass row)
  let orgDefect = '' // only REQUEST_SNAPSHOT_DEFECT fails (pendingMissing cell)

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })

    // ---- orgMixed ----------------------------------------------------------
    orgMixed = mkOrg()
    const u1 = mkUser()
    const u2 = mkUser()
    const u3 = mkUser()
    const r1 = await insertRecord(orgMixed, u1, WORK_DATE)
    const r2 = await insertRecord(orgMixed, u2, WORK_DATE)
    const r3 = await insertRecord(orgMixed, u3, WORK_DATE)
    const r4 = await insertRecord(orgMixed, u1, '2026-01-06')
    const r5 = await insertRecord(orgMixed, u1, OUT_OF_WINDOW_DATE)
    // T-D1 seeded twin pair on ONE record: a W4 shadow row (V1 context, NO
    // marker) and a W7 compare row (V2 context, marker) with the SAME
    // non-critical divergence code.
    await insertShadowRow({
      recordId: r1, orgId: orgMixed,
      context: v1Context(orgMixed, u1, WORK_DATE),
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'work_minutes_mismatch', changedFields: ['workMinutes'],
    })
    await insertShadowRow({
      recordId: r1, orgId: orgMixed,
      context: mintV2Context(orgMixed, u1, WORK_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'work_minutes_mismatch', changedFields: ['workMinutes'],
    })
    // T-D1 second twin pair, critical this time: W4 review row + W7 review row
    // both `context_mismatch` — the selector filter must count ONLY the W7 one.
    await insertShadowRow({
      recordId: r2, orgId: orgMixed,
      context: v1Context(orgMixed, u2, WORK_DATE),
      outcome: 'review_required', outcomeReasonCode: 'context_mismatch',
      shadowDiffCode: 'context_mismatch', changedFields: ['context'],
    })
    await insertShadowRow({
      recordId: r2, orgId: orgMixed,
      context: mintV2Context(orgMixed, u2, WORK_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'review_required', outcomeReasonCode: 'context_mismatch',
      shadowDiffCode: 'context_mismatch', changedFields: ['context'],
    })
    // An `equal` W7 compare row: coverage, no diff.
    await insertShadowRow({
      recordId: r3, orgId: orgMixed,
      context: mintV2Context(orgMixed, u3, WORK_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'equal',
    })
    // Gate P3-2 scenario: a `group_authoritative`-era W4 shadow row — it
    // legitimately carries a group_effective V2 context but NO marker (the
    // ordinary W4 shadow producer wrote it). Every W7 counter must exclude it:
    // the marker conjunct, not the selector alone, is what pins the compare
    // domain to rows the W7-2 comparison recorder wrote.
    await insertShadowRow({
      recordId: r3, orgId: orgMixed,
      context: mintV2Context(orgMixed, u3, WORK_DATE) as unknown as Record<string, unknown>,
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'work_minutes_mismatch', changedFields: ['workMinutes'],
    })
    // A W7 group-resolution FAIL-CLOSE record: null context, reason carried.
    await insertShadowRow({
      recordId: r4, orgId: orgMixed,
      context: null,
      w7Marker: { shadowReason: 'membership-absent' },
      outcome: 'review_required', outcomeReasonCode: 'missing_frozen_context',
      shadowDiffCode: 'review_required',
    })
    // Window discipline: a CRITICAL W7 row OUTSIDE the window must not count.
    await insertShadowRow({
      recordId: r5, orgId: orgMixed,
      context: mintV2Context(orgMixed, u1, OUT_OF_WINDOW_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'review_required', outcomeReasonCode: 'context_mismatch',
      shadowDiffCode: 'context_mismatch', changedFields: ['context'],
    })

    // ---- orgClean ----------------------------------------------------------
    orgClean = mkOrg()
    const uClean = mkUser()
    const rClean = await insertRecord(orgClean, uClean, WORK_DATE)
    await insertShadowRow({
      recordId: rClean, orgId: orgClean,
      context: mintV2Context(orgClean, uClean, WORK_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'equal',
    })

    // ---- orgOffRosterOnly --------------------------------------------------
    orgOffRosterOnly = mkOrg()
    const uOff = mkUser()
    const rOff = await insertRecord(orgOffRosterOnly, uOff, WORK_DATE)
    await insertShadowRow({
      recordId: rOff, orgId: orgOffRosterOnly,
      context: mintV2Context(orgOffRosterOnly, uOff, WORK_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'late_minutes_mismatch', changedFields: ['lateMinutes'],
      projectedStatus: 'late',
    })

    // ---- orgFailcloseOnly --------------------------------------------------
    orgFailcloseOnly = mkOrg()
    const uFc = mkUser()
    const rFcCover = await insertRecord(orgFailcloseOnly, uFc, WORK_DATE)
    const rFc = await insertRecord(orgFailcloseOnly, uFc, '2026-01-06')
    await insertShadowRow({
      recordId: rFcCover, orgId: orgFailcloseOnly,
      context: mintV2Context(orgFailcloseOnly, uFc, WORK_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'equal',
    })
    await insertShadowRow({
      recordId: rFc, orgId: orgFailcloseOnly,
      context: null,
      w7Marker: { shadowReason: 'incomplete-policy' },
      outcome: 'review_required', outcomeReasonCode: 'missing_frozen_context',
      shadowDiffCode: 'review_required',
    })

    // ---- orgEmpty ----------------------------------------------------------
    orgEmpty = mkOrg()

    // ---- orgIngress --------------------------------------------------------
    orgIngress = mkOrg()
    const uIn = mkUser()
    const rInCover = await insertRecord(orgIngress, uIn, WORK_DATE)
    const rIn = await insertRecord(orgIngress, uIn, '2026-01-07')
    await insertShadowRow({
      recordId: rInCover, orgId: orgIngress,
      context: mintV2Context(orgIngress, uIn, WORK_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'equal',
    })
    // An unresolved legacy-time ingress review: the review row IS the record's
    // MAX(version) calculation. Diff code review_required; W4 shape (no
    // marker, V1-context-less review row — context null like the product's
    // own legacy-time rows).
    await insertShadowRow({
      recordId: rIn, orgId: orgIngress,
      context: null,
      outcome: 'review_required', outcomeReasonCode: 'legacy_time_ingress_not_authoritative',
      shadowDiffCode: 'review_required',
    })

    // ---- orgDefect ---------------------------------------------------------
    orgDefect = mkOrg()
    const uDef = mkUser()
    const rDef = await insertRecord(orgDefect, uDef, WORK_DATE)
    await insertShadowRow({
      recordId: rDef, orgId: orgDefect,
      context: mintV2Context(orgDefect, uDef, WORK_DATE) as unknown as Record<string, unknown>,
      w7Marker: { shadowReason: null },
      outcome: 'completed', outcomeReasonCode: 'shadow_only',
      shadowDiffCode: 'equal',
    })
    // A pending calculation-affecting request with NO snapshot row: the
    // `pendingMissing` cell of the reused 8-cell classifier.
    await pool.query(
      `INSERT INTO attendance_requests (id, user_id, work_date, request_type, status, org_id)
       VALUES ($1, $2, $3::date, 'leave', 'pending', $4)`,
      [randomUUID(), uDef, WORK_DATE, orgDefect],
    )
  }, 120_000)

  afterAll(async () => {
    for (const table of ['attendance_requests', 'attendance_record_segments', 'attendance_record_calculations', 'attendance_records']) {
      await pool?.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => undefined)
    }
    await pool?.end()
  })

  // -------------------------------------------------------------------------
  // T-C1 — every predicate code appears exactly once, applicable or not.
  // -------------------------------------------------------------------------
  it('T-C1: every predicate code appears exactly once and the emitted set equals the closed code set', async () => {
    const result = await status(orgMixed)
    expect(result.predicates.map((p) => p.code)).toEqual([...ATTENDANCE_W7_COMPARE_PREDICATE_CODES_V1])
    for (const code of ATTENDANCE_W7_COMPARE_PREDICATE_CODES_V1) predicate(result, code)
    // Counts are numbers on every predicate this command computes from rows.
    for (const p of result.predicates) {
      expect(typeof p.applicable).toBe('boolean')
      expect(typeof p.pass).toBe('boolean')
      expect(p.count === null || Number.isInteger(p.count)).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // T-C2 + T-D1 (seeded) + T-D3 — real counts over the mixed org.
  // -------------------------------------------------------------------------
  it('T-C2/T-D1(seeded): counts are exact, and every counter counts ONLY the marker+selector-discriminated W7 comparison records', async () => {
    const result = await status(orgMixed)
    // T-D1: r1 and r2 each carry BOTH a W4 twin and a W7 record with the same
    // code, and r3 additionally carries the P3-2 group_authoritative-era W4
    // row (group V2 context, NO marker). A marker-blind implementation would
    // count that r3 row as a third off-roster diff; a selector/marker-blind
    // one would count the W4 twins too.
    expect(predicate(result, 'W7_CRITICAL_SHADOW_DIFF').count).toBe(1)
    expect(predicate(result, 'W7_OFF_ROSTER_DIFF').count).toBe(2) // r1 W7 + r2 W7; equal + unmarked-V2 rows excluded
    expect(predicate(result, 'W7_COMPARE_COVERAGE').count).toBe(3) // (u1,0105),(u2,0105),(u3,0105); fail-close has no context
    expect(predicate(result, 'W7_GROUP_RESOLUTION_FAILCLOSE').count).toBe(1)
    expect(predicate(result, 'W7_UNRESOLVED_INGRESS_REVIEW').count).toBe(0)
    expect(predicate(result, 'W7_REQUEST_SNAPSHOT_DEFECT').count).toBe(0)
    expect(result.blocked).toBe(true)
    // The out-of-window critical row exists but did not count (window bound).
    // Its presence is asserted so the window claim is not vacuous:
    const outOfWindow = await pool.query(
      `SELECT count(*) AS n FROM attendance_record_calculations c
        JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id
       WHERE c.org_id = $1 AND r.work_date = $2::date AND c.shadow_diff_code = 'context_mismatch'`,
      [orgMixed, OUT_OF_WINDOW_DATE],
    )
    expect(Number(outOfWindow.rows[0].n)).toBe(1)
  })

  it('T-D3(seeded): the discrimination is by the CALCULATION context, never the parent pointer owner', async () => {
    // Every parent in this suite is `legacy_untracked` (the shadow-posture
    // shape) — an implementation keyed on the parent's projection_owner would
    // count zero W7 rows everywhere and fail T-C2 above. Asserted explicitly:
    const owners = await pool.query(
      `SELECT DISTINCT projection_owner FROM attendance_records WHERE org_id = $1`,
      [orgMixed],
    )
    expect(owners.rows.map((r) => r.projection_owner)).toEqual(['legacy_untracked'])
    const result = await status(orgMixed)
    expect(predicate(result, 'W7_COMPARE_COVERAGE').count).toBe(3)
  })

  // -------------------------------------------------------------------------
  // T-C3 — each failing predicate independently sets `blocked`; the clean org
  // is the paired passing positive control.
  // -------------------------------------------------------------------------
  it('T-C3: a fully clean org passes every predicate and is NOT blocked (positive control)', async () => {
    const result = await status(orgClean)
    for (const p of result.predicates) {
      expect(p.pass, `${p.code} must pass on the clean org (count=${p.count})`).toBe(true)
    }
    expect(predicate(result, 'W7_COMPARE_COVERAGE').count).toBe(1)
    expect(result.blocked).toBe(false)
  })

  it('T-C3b: OFF_ROSTER alone fails ⇒ blocked (every other predicate passes)', async () => {
    const result = await status(orgOffRosterOnly)
    expect(predicate(result, 'W7_OFF_ROSTER_DIFF').count).toBe(1)
    expect(predicate(result, 'W7_OFF_ROSTER_DIFF').pass).toBe(false)
    for (const p of result.predicates) {
      if (p.code !== 'W7_OFF_ROSTER_DIFF') expect(p.pass, `${p.code}`).toBe(true)
    }
    expect(result.blocked).toBe(true)
  })

  it('T-C3c: GROUP_RESOLUTION_FAILCLOSE alone fails ⇒ blocked — and a fail-close is NOT a critical/off-roster diff', async () => {
    const result = await status(orgFailcloseOnly)
    expect(predicate(result, 'W7_GROUP_RESOLUTION_FAILCLOSE').count).toBe(1)
    expect(predicate(result, 'W7_GROUP_RESOLUTION_FAILCLOSE').pass).toBe(false)
    // The null-context fail-close record must NOT leak into the selector-
    // filtered compare domain (no double counting — §3.1 vs §3.2 separation).
    expect(predicate(result, 'W7_CRITICAL_SHADOW_DIFF').count).toBe(0)
    expect(predicate(result, 'W7_OFF_ROSTER_DIFF').count).toBe(0)
    for (const p of result.predicates) {
      if (p.code !== 'W7_GROUP_RESOLUTION_FAILCLOSE') expect(p.pass, `${p.code}`).toBe(true)
    }
    expect(result.blocked).toBe(true)
  })

  it('T-C3d: UNRESOLVED_INGRESS_REVIEW alone fails ⇒ blocked (the reused predicate really is consulted)', async () => {
    const result = await status(orgIngress)
    expect(predicate(result, 'W7_UNRESOLVED_INGRESS_REVIEW').count).toBe(1)
    expect(predicate(result, 'W7_UNRESOLVED_INGRESS_REVIEW').pass).toBe(false)
    for (const p of result.predicates) {
      if (p.code !== 'W7_UNRESOLVED_INGRESS_REVIEW') expect(p.pass, `${p.code}`).toBe(true)
    }
    expect(result.blocked).toBe(true)
  })

  it('T-C3e: REQUEST_SNAPSHOT_DEFECT alone fails ⇒ blocked, and its count IS the reused reader’s total (non-vacuous coupling)', async () => {
    const result = await status(orgDefect)
    const defect = predicate(result, 'W7_REQUEST_SNAPSHOT_DEFECT')
    expect(defect.count).toBe(1)
    expect(defect.pass).toBe(false)
    for (const p of result.predicates) {
      if (p.code !== 'W7_REQUEST_SNAPSHOT_DEFECT') expect(p.pass, `${p.code}`).toBe(true)
    }
    expect(result.blocked).toBe(true)
    // The reuse coupling, at a NON-ZERO count: the reader and the predicate
    // agree on the same defective request, in the same pendingMissing cell.
    const report = await readAttendanceRequestSnapshotDefectReportV1(asTrx(pool), orgDefect)
    expect(report.totalDefectiveRequests).toBe(1)
    expect(report.byCell.pendingMissing).toBe(1)
    expect(defect.count).toBe(report.totalDefectiveRequests)
  })

  // -------------------------------------------------------------------------
  // T-C4 — no caller-supplied readiness: the input key set is exact.
  // -------------------------------------------------------------------------
  it('T-C4: a probe adding `ready: true` (or any extra/missing/ill-typed key) is REJECTED, never ignored', async () => {
    const good = { orgId: orgClean, from: WINDOW.from, to: WINDOW.to }
    const badInputs: unknown[] = [
      { ...good, ready: true },
      { ...good, force: true },
      { orgId: orgClean, from: WINDOW.from }, // missing key
      { ...good, from: 'not-a-date' },
      { ...good, from: WINDOW.to, to: WINDOW.from }, // inverted window
      { ...good, orgId: '' },
      null,
      [],
      'org',
    ]
    for (const input of badInputs) {
      let thrown: unknown = null
      try {
        await readAttendanceW7CompareWindowStatusV1(asTrx(pool), input)
      } catch (error) {
        thrown = error
      }
      expect(thrown, `input ${JSON.stringify(input)} must be rejected`).toBeInstanceOf(
        AttendanceW7CompareWindowError,
      )
      expect((thrown as AttendanceW7CompareWindowError).code).toBe('W7_COMPARE_WINDOW_INPUT_INVALID')
    }
    // Positive control: the exact key set still works after all the rejects.
    const ok = await readAttendanceW7CompareWindowStatusV1(asTrx(pool), good)
    expect(ok.blocked).toBe(false)
  })

  // -------------------------------------------------------------------------
  // T-C5 — coverage blocks a vacuous pass.
  // -------------------------------------------------------------------------
  it('T-C5: an EMPTY window is blocked by W7_COMPARE_COVERAGE — never "zero diffs"', async () => {
    const result = await status(orgEmpty)
    const coverage = predicate(result, 'W7_COMPARE_COVERAGE')
    expect(coverage.count).toBe(0)
    expect(coverage.pass).toBe(false)
    // The diff predicates all "pass" (no rows) — which is exactly why the
    // coverage predicate must exist and must block.
    expect(predicate(result, 'W7_CRITICAL_SHADOW_DIFF').pass).toBe(true)
    expect(predicate(result, 'W7_OFF_ROSTER_DIFF').pass).toBe(true)
    expect(result.blocked).toBe(true)
  })

  // -------------------------------------------------------------------------
  // T-C6 — read-only: after a status call the ledger is unchanged.
  // -------------------------------------------------------------------------
  it('T-C6: a status call leaves every calculation/record row byte-identical (row hash + xmin)', async () => {
    const snapshot = () =>
      pool
        .query(
          `SELECT c.id, c.xmin::text AS xid, md5(c::text) AS row_hash
             FROM attendance_record_calculations c WHERE c.org_id = ANY($1::text[])
            UNION ALL
           SELECT r.id, r.xmin::text AS xid, md5(r::text) AS row_hash
             FROM attendance_records r WHERE r.org_id = ANY($1::text[])
            ORDER BY 1`,
          [orgs],
        )
        .then((res) => res.rows)
    const before = await snapshot()
    expect(before.length).toBeGreaterThan(0) // non-vacuity: the snapshot saw rows
    // Run the status read in its own short-lived transaction (the documented
    // point-in-time pattern: the reused ingress predicate takes FOR UPDATE
    // row locks, released at rollback — a lock, never a write).
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await readAttendanceW7CompareWindowStatusV1(asTrx(client), {
        orgId: orgMixed,
        from: WINDOW.from,
        to: WINDOW.to,
      })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const after = await snapshot()
    expect(after).toEqual(before)
  })

  // -------------------------------------------------------------------------
  // T-C7 — the 8-cell report is REUSED, not re-derived.
  // -------------------------------------------------------------------------
  it('T-C7: the request-snapshot predicate count equals the reused reader’s total, and the byCell keys equal the closed 8-cell set', async () => {
    const report = await readAttendanceRequestSnapshotDefectReportV1(asTrx(pool), orgMixed)
    expect(Object.keys(report.byCell).sort()).toEqual([...ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1].sort())
    expect(ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1.length).toBe(8)
    const result = await status(orgMixed)
    expect(predicate(result, 'W7_REQUEST_SNAPSHOT_DEFECT').count).toBe(report.totalDefectiveRequests)
  })

  // -------------------------------------------------------------------------
  // T-C8 — evaluated inside the CALLER's transaction.
  // -------------------------------------------------------------------------
  it('T-C8: the command reads through the caller’s transaction — an uncommitted in-transaction row is seen by it and by nobody else', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Seed an off-roster W7 compare row INSIDE the open transaction.
      const uTx = randomUUID()
      const recordId = randomUUID()
      await client.query(
        `INSERT INTO attendance_records
           (id, user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes,
            status, is_workday, projection_owner, visibility_state, visibility_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'UTC',480,0,0,'normal',true,'legacy_untracked','active','active',now(),now())`,
        [recordId, uTx, orgClean, '2026-01-08'],
      )
      const minted = mintV2Context(orgClean, uTx, '2026-01-08')
      const calculationId = randomUUID()
      await client.query(
        `INSERT INTO attendance_record_calculations
           (id, attendance_record_id, org_id, version,
            calculation_kind, mode, entrypoint, engine_version, snapshot_schema_version,
            semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
            attribution_snapshot, segment_snapshot, evidence_snapshot, approved_facts_snapshot,
            input_provenance, merge_policy, calculation_tier,
            outcome, outcome_reason_code, projection_effect, expected_segment_count,
            actor_id, correlation_id, operation_id,
            shadow_diff_code, shadow_diff, context_snapshot, created_at)
         VALUES ($1,$2,$3,1,
                 'calculation','shadow','live','w7-2-seed',1,
                 $4,$5,$6,
                 $7::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                 $8::jsonb,'append','legacy_shadow',
                 'review_required','context_mismatch','none',0,
                 'w7-2-seed-actor',$9,$10::uuid,
                 'context_mismatch',$11::jsonb,$12::jsonb, now())`,
        [
          calculationId, recordId, orgClean,
          hex64(`semantic:${calculationId}`), hex64(`provenance:${calculationId}`), hex64(`sourcedef:${calculationId}`),
          JSON.stringify({ posture: 'resolved_v2', value: { orgId: orgClean, userId: uTx, workDate: '2026-01-08', shiftId: randomUUID() } }),
          JSON.stringify({
            [ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1]: {
              schemaVersion: 1,
              operationId: randomUUID(),
              shadowReason: null,
            },
          }),
          `w7-2-corr-${calculationId}`, null,
          JSON.stringify({ schemaVersion: 1, code: 'context_mismatch', changedFields: ['context'], absoluteMinuteDelta: 0, segmentCount: 0 }),
          JSON.stringify(minted),
        ],
      )
      // Inside the transaction: the uncommitted critical row IS counted.
      const inside = await readAttendanceW7CompareWindowStatusV1(asTrx(client), {
        orgId: orgClean, from: WINDOW.from, to: WINDOW.to,
      })
      expect(predicate(inside, 'W7_CRITICAL_SHADOW_DIFF').count).toBe(1)
      expect(inside.blocked).toBe(true)
      // Outside (a different connection): invisible — the command has no
      // connection of its own to smuggle a stale preflight through.
      const outside = await status(orgClean)
      expect(predicate(outside, 'W7_CRITICAL_SHADOW_DIFF').count).toBe(0)
      expect(outside.blocked).toBe(false)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    // Post-rollback control: the clean org is clean again.
    const after = await status(orgClean)
    expect(after.blocked).toBe(false)
  })

  // -------------------------------------------------------------------------
  // T-D2 (seeded) — the selector read is TOTAL; corruption is a hard error.
  // -------------------------------------------------------------------------
  it('T-D2(seeded): a non-null context with no selector member is a HARD error, never "legacy" (a default would fail open)', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const uCorrupt = randomUUID()
      const recordId = randomUUID()
      await client.query(
        `INSERT INTO attendance_records
           (id, user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes,
            status, is_workday, projection_owner, visibility_state, visibility_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'UTC',480,0,0,'normal',true,'legacy_untracked','active','active',now(),now())`,
        [recordId, uCorrupt, orgClean, '2026-01-09'],
      )
      const calculationId = randomUUID()
      await client.query(
        `INSERT INTO attendance_record_calculations
           (id, attendance_record_id, org_id, version,
            calculation_kind, mode, entrypoint, engine_version, snapshot_schema_version,
            semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
            attribution_snapshot, segment_snapshot, evidence_snapshot, approved_facts_snapshot,
            input_provenance, merge_policy, calculation_tier,
            outcome, outcome_reason_code, projection_effect, expected_segment_count,
            actor_id, correlation_id, operation_id,
            shadow_diff_code, shadow_diff, context_snapshot, created_at)
         VALUES ($1,$2,$3,1,
                 'calculation','shadow','live','w7-2-seed',1,
                 $4,$5,$6,
                 $7::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                 '{}'::jsonb,'append','legacy_shadow',
                 'review_required','missing_frozen_context','none',0,
                 'w7-2-seed-actor',$8,$9::uuid,
                 'review_required',$10::jsonb,'{"corrupt":true}'::jsonb, now())`,
        [
          calculationId, recordId, orgClean,
          hex64(`semantic:${calculationId}`), hex64(`provenance:${calculationId}`), hex64(`sourcedef:${calculationId}`),
          JSON.stringify({ posture: 'resolved_v2', value: { orgId: orgClean, userId: uCorrupt, workDate: '2026-01-09', shiftId: randomUUID() } }),
          `w7-2-corr-${calculationId}`, randomUUID(),
          JSON.stringify({ schemaVersion: 1, code: 'review_required', changedFields: [], absoluteMinuteDelta: 0, segmentCount: 0 }),
        ],
      )
      let thrown: unknown = null
      try {
        await readAttendanceW7CompareWindowStatusV1(asTrx(client), {
          orgId: orgClean, from: WINDOW.from, to: WINDOW.to,
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AttendanceW7CompareWindowError)
      expect((thrown as AttendanceW7CompareWindowError).code).toBe('W7_COMPARE_CONTEXT_SELECTOR_MISSING')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
