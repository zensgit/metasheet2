/**
 * W4C-3c real-DB legs: manual override, prior/current recompute, ops_retirement,
 * ordinary-writer zero-write on retired parents, P20 retired-row surfaces,
 * multi-segment physical fidelity, recompute override survival, and retirement
 * response-loss replay.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { appendOperatorRetirementCalculationV1 } from '../../src/attendance/w4c3c-ops-retirement'
import {
  appendManualOverrideCalculationV1,
  ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES,
} from '../../src/attendance/w4c3c-manual-edit-apply'
import {
  appendRecomputeCalculationV1,
  ATTENDANCE_RECOMPUTE_ERROR_CODES,
} from '../../src/attendance/w4c3c-recompute'
import {
  loadActiveCurrentAttendanceRecordForDecisionTraceV1,
  loadActiveCurrentAttendanceRecordForMakeupAnomalyFactsV1,
  listActiveCurrentOpenRecordsForWorkDateResolverV1,
  listActiveCurrentAttendanceRecordsForAnomalyListingV1,
  ATTENDANCE_ACTIVE_CURRENT_RELATION_V1,
} from '../../src/attendance/w4c3c-active-current'
import {
  assertRecordOperationCapabilityMatchV1,
  recordOperationCapabilityForKindV1,
} from '../../src/attendance/w4c3c-record-operation-boundary'
import {
  assertManualOverrideOperationsValidV1,
  applyManualOverrideDailyOverlayV1,
} from '../../src/attendance/w4c3c-manual-override'
import { ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 } from '../../src/attendance/w4c1-segment-calculator'
import {
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from '../../src/attendance/w4c0-fingerprints'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('W4C-3c manual / recompute / operator retirement (real DB)', () => {
  let pool: Pool
  const orgId = randomUUID()
  const userId = randomUUID()
  const workDate = '2026-08-01'
  const shiftId = randomUUID()
  let recordId = ''
  let priorCalculationId = ''

  const clientOf = (c: { query: Pool['query'] }) => ({
    query: async (sql: string, params?: readonly unknown[]) => c.query(sql, [...(params ?? [])]),
  })

  async function calculationVersion(db: Pool | PoolClient, calculationId: string): Promise<number> {
    const result = await db.query(
      'SELECT version FROM attendance_record_calculations WHERE id = $1::uuid',
      [calculationId],
    )
    const version = Number(result.rows[0]?.version)
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(`W4C3C_TEST_CALCULATION_VERSION_MISSING:${calculationId}`)
    }
    return version
  }

  function completeAttribution(forWorkDate = workDate) {
    return {
      posture: 'resolved_v2',
      value: {
        schemaVersion: 2,
        resolverVersion: 'w2-resolver@3',
        orgId,
        userId,
        workDate: forWorkDate,
        shiftId,
        reasonCode: 'assignment_match',
        resolvedAt: `${forWorkDate}T00:05:00.000Z`,
        // Windows must cover the full shift day so recompute calculator can complete.
        absoluteWindow: {
          startAt: `${forWorkDate}T00:00:00.000Z`,
          endAt: `${forWorkDate}T23:59:59.000Z`,
        },
        attributionWindow: {
          startAt: `${forWorkDate}T00:00:00.000Z`,
          endAt: `${forWorkDate}T23:59:59.000Z`,
        },
        attributionTailMinutes: 0,
        extendedByApprovedOvertime: false,
        windowEvidenceFingerprint: 'a'.repeat(64),
        source: 'live_resolution',
      },
    }
  }

  function completeEvidence(forWorkDate = workDate, segmentCount: 1 | 2 = 1) {
    if (segmentCount === 2) {
      return [
        {
          kind: 'punch',
          ref: 'ev-in-0',
          direction: 'check_in',
          occurredAt: `${forWorkDate}T01:10:00.000Z`,
          source: 'attendance_event',
        },
        {
          kind: 'punch',
          ref: 'ev-out-0',
          direction: 'check_out',
          occurredAt: `${forWorkDate}T04:00:00.000Z`,
          source: 'attendance_event',
        },
        {
          kind: 'punch',
          ref: 'ev-in-1',
          direction: 'check_in',
          occurredAt: `${forWorkDate}T05:00:00.000Z`,
          source: 'attendance_event',
        },
        {
          kind: 'punch',
          ref: 'ev-out-1',
          direction: 'check_out',
          occurredAt: `${forWorkDate}T10:00:00.000Z`,
          source: 'attendance_event',
        },
      ]
    }
    return [
      {
        kind: 'punch',
        ref: 'ev-in-0',
        direction: 'check_in',
        occurredAt: `${forWorkDate}T01:10:00.000Z`,
        source: 'attendance_event',
      },
      {
        kind: 'punch',
        ref: 'ev-out-0',
        direction: 'check_out',
        occurredAt: `${forWorkDate}T10:00:00.000Z`,
        source: 'attendance_event',
      },
    ]
  }

  function completeContext(segmentCount: 1 | 2 = 1, forWorkDate = workDate) {
    // Wall times aligned with seed punch/segment instants in UTC.
    const segments =
      segmentCount === 2
        ? [
            {
              index: 0,
              startTime: '01:00',
              endTime: '04:00',
              startDayOffset: 0,
              endDayOffset: 0,
              lateGraceMinutes: 0,
              earlyLeaveGraceMinutes: 0,
            },
            {
              index: 1,
              startTime: '05:00',
              endTime: '10:00',
              startDayOffset: 0,
              endDayOffset: 0,
              lateGraceMinutes: 0,
              earlyLeaveGraceMinutes: 0,
            },
          ]
        : [
            {
              index: 0,
              startTime: '01:00',
              endTime: '10:00',
              startDayOffset: 0,
              endDayOffset: 0,
              lateGraceMinutes: 0,
              earlyLeaveGraceMinutes: 0,
            },
          ]
    return {
      schemaVersion: 1,
      selector: 'legacy',
      orgId,
      userId,
      workDate: forWorkDate,
      timezone: 'UTC',
      shiftId,
      isWorkday: true,
      holidayKind: null,
      calculationGroupId: null,
      roundingMinutes: 5,
      severeLateThresholdMinutes: 30,
      absenceLateThresholdMinutes: 60,
      segments,
    }
  }

  /**
   * Seed a completed calculation + its dense segment children in ONE transaction.
   * The W4 children-count commit guard requires segments to exist before the
   * calculation row commits (expected_segment_count must match child count).
   */
  async function seedCompletePriorCalculation(
    db: Pool,
    options: {
      segmentCount?: 1 | 2
      targetRecordId?: string
      manualOverrideSnapshot?: unknown
    } = {},
  ) {
    const segmentCount = options.segmentCount ?? 1
    const targetRecordId = options.targetRecordId ?? recordId
    const calcId = randomUUID()
    // Read the target record work_date so attribution/context/evidence agree.
    const workDateRow = await db.query(
      `SELECT work_date::text AS work_date FROM attendance_records WHERE id = $1::uuid`,
      [targetRecordId],
    )
    const forWorkDate = String(workDateRow.rows[0]?.work_date || workDate).slice(0, 10)
    const attr = completeAttribution(forWorkDate)
    const ctx = completeContext(segmentCount, forWorkDate)
    const evidence = completeEvidence(forWorkDate, segmentCount)
    const semanticFp = 'b'.repeat(64)
    const provenance = {
      transport: 'live_event',
      sourceRef: `seed-live:${calcId}`,
      artifactSha256: null,
      normalizedCsvSha256: null,
      convertedSheetName: null,
    }
    const provenanceFp = computeAttendanceProvenanceFingerprintV1(provenance)
    const sourceDefFp = 'd'.repeat(64)
    const dailyFp = 'e'.repeat(64)
    const operationId = randomUUID()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Explicit per-use casts avoid PostgreSQL 42P08 (inconsistent types for $N).
      await client.query(
        `INSERT INTO attendance_record_calculations (
            id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
            engine_version, snapshot_schema_version, supersedes_calculation_id, operation_id,
            semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
            attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
            approved_facts_snapshot, manual_override_snapshot, input_provenance,
            merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
            expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
            projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
            projected_daily_fingerprint, actor_id, correlation_id
          ) VALUES (
            $1::uuid, $2, $3::uuid, 1, 'calculation', 'authoritative', 'live',
            $4, 1, NULL, $5::uuid,
            $6::char(64), $7::char(64), $8::char(64),
            $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
            '[]'::jsonb, $20::jsonb, $19::jsonb,
            'append', 'segment_authoritative', 'completed', 'calculated', 'set_active',
            $13::int, 'late', $14::timestamptz, $15::timestamptz, 400, 15, 0, $16::text,
            $17, $18
          )`,
        [
          calcId,
          orgId,
          targetRecordId,
          ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
          operationId,
          semanticFp,
          provenanceFp,
          sourceDefFp,
          JSON.stringify(attr),
          JSON.stringify(ctx),
          JSON.stringify(ctx.segments),
          JSON.stringify(evidence),
          segmentCount,
          `${forWorkDate}T01:10:00.000Z`,
          `${forWorkDate}T10:00:00.000Z`,
          dailyFp,
          userId,
          `seed-prior:${calcId}`,
          JSON.stringify(provenance),
          JSON.stringify(options.manualOverrideSnapshot ?? null),
        ],
      )
      if (segmentCount === 1) {
        await client.query(
          `INSERT INTO attendance_record_segments (
              org_id, record_id, calculation_id, segment_index,
              expected_start_at, expected_end_at, actual_in_at, actual_out_at,
              work_minutes, late_minutes, early_leave_minutes, status,
              status_reasons, matched_evidence_refs, unmatched_evidence_refs
            ) VALUES (
              $1, $2::uuid, $3::uuid, 0,
              $4::timestamptz, $5::timestamptz, $4::timestamptz, $5::timestamptz,
              400, 15, 0, 'late',
              '["late_check_in"]'::jsonb, '[]'::jsonb, '[]'::jsonb
            )`,
          [orgId, targetRecordId, calcId, `${forWorkDate}T01:00:00.000Z`, `${forWorkDate}T10:00:00.000Z`],
        )
      } else {
        // Two physical segments with distinct metrics — must survive manual overlay copy.
        await client.query(
          `INSERT INTO attendance_record_segments (
              org_id, record_id, calculation_id, segment_index,
              expected_start_at, expected_end_at, actual_in_at, actual_out_at,
              work_minutes, late_minutes, early_leave_minutes, status,
              status_reasons, matched_evidence_refs, unmatched_evidence_refs
            ) VALUES
            ($1, $2::uuid, $3::uuid, 0,
             $4::timestamptz, $5::timestamptz, $4::timestamptz, $5::timestamptz,
             180, 10, 0, 'late',
             '["late_check_in"]'::jsonb, '["ev-in-0"]'::jsonb, '[]'::jsonb),
            ($1, $2::uuid, $3::uuid, 1,
             $6::timestamptz, $7::timestamptz, $6::timestamptz, $7::timestamptz,
             220, 5, 0, 'late',
             '["late_check_in"]'::jsonb, '["ev-in-1"]'::jsonb, '[]'::jsonb)`,
          [
            orgId,
            targetRecordId,
            calcId,
            `${forWorkDate}T01:00:00.000Z`,
            `${forWorkDate}T04:00:00.000Z`,
            `${forWorkDate}T05:00:00.000Z`,
            `${forWorkDate}T10:00:00.000Z`,
          ],
        )
      }
      // Pointer guard requires W4-owned daily fields to match the selected snapshot.
      await client.query(
        `UPDATE attendance_records
            SET current_calculation_id = $1::uuid,
                projection_owner = 'w4',
                visibility_state = 'active',
                visibility_reason = 'active',
                status = 'late',
                first_in_at = $4::timestamptz,
                last_out_at = $5::timestamptz,
                work_minutes = 400,
                late_minutes = 15,
                early_leave_minutes = 0
          WHERE id = $2::uuid AND org_id = $3`,
        [
          calcId,
          targetRecordId,
          orgId,
          `${forWorkDate}T01:10:00.000Z`,
          `${forWorkDate}T10:00:00.000Z`,
        ],
      )
      await client.query('COMMIT')
      return calcId
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    // users schema on this DB may require extra columns — best-effort identity seed.
    await pool.query(
      `INSERT INTO users (id, email, name, status)
       VALUES ($1, $2, 'w4c3c', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [userId, `w4c3c-${userId}@example.test`],
    ).catch(async () => {
      await pool.query(
        `INSERT INTO users
           (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $1, 'w4c3c', 'x', 'user', '[]'::jsonb, true, false, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [userId, `w4c3c-${userId}@example.test`],
      ).catch(() => undefined)
    })
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT DO NOTHING`,
      [userId, orgId],
    ).catch(async () => {
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
         ON CONFLICT DO NOTHING`,
        [userId, orgId],
      ).catch(() => undefined)
    })

    const inserted = await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, $4::date, 'UTC', $5::timestamptz, $6::timestamptz, 400, 15, 0, 'late', true,
               '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())
       RETURNING id::text AS id`,
      [
        randomUUID(),
        userId,
        orgId,
        workDate,
        `${workDate}T01:10:00.000Z`,
        `${workDate}T10:00:00.000Z`,
      ],
    )
    recordId = String(inserted.rows[0].id)
    priorCalculationId = await seedCompletePriorCalculation(pool, { segmentCount: 1 })
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM attendance_record_segments WHERE org_id = $1`, [orgId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_record_calculations WHERE org_id = $1`, [orgId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_record_result_edits WHERE org_id = $1`, [orgId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_records WHERE org_id = $1`, [orgId]).catch(() => undefined)
    await pool.end()
  })

  it('set/unset validators and pure daily overlay helper', () => {
    expect(() =>
      assertManualOverrideOperationsValidV1([{ op: 'set', field: 'status', value: 'normal' }]),
    ).not.toThrow()
    const ops = assertManualOverrideOperationsValidV1([
      { op: 'set', field: 'status', value: 'normal' },
      { op: 'set', field: 'lateMinutes', value: 0 },
      { op: 'unset', field: 'earlyLeaveMinutes', value: null },
    ])
    const overlaid = applyManualOverrideDailyOverlayV1(
      {
        status: 'late',
        firstInAt: '2026-08-01T01:00:00.000Z',
        lastOutAt: '2026-08-01T10:00:00.000Z',
        workMinutes: 400,
        lateMinutes: 15,
        earlyLeaveMinutes: 3,
      },
      ops,
    )
    expect(overlaid.status).toBe('normal')
    expect(overlaid.lateMinutes).toBe(0)
    expect(overlaid.earlyLeaveMinutes).toBeNull()
    expect(overlaid.workMinutes).toBe(400)
    expect(overlaid.firstInAt).toBe('2026-08-01T01:00:00.000Z')
  })

  it('entrypoint/capability matrix rejects forged capability mismatch', () => {
    expect(recordOperationCapabilityForKindV1('manual_edit')).toBe('manual_edit')
    expect(recordOperationCapabilityForKindV1('recompute')).toBe('recompute')
    expect(recordOperationCapabilityForKindV1('ops_retirement')).toBe('retirement')
    expect(() => assertRecordOperationCapabilityMatchV1('manual_edit', 'punch')).toThrow(
      /ATTENDANCE_ENTRYPOINT_CAPABILITY_MISMATCH/,
    )
  })

  it('mutation: missing expected prior fails with zero current change', async () => {
    // Fresh legacy-only parent (never W4-pointed — pointer guard forbids returning to legacy).
    const legacyOnlyId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, '2026-07-10'::date, 'UTC', $4::timestamptz, $5::timestamptz,
               400, 15, 0, 'late', true, '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
      [legacyOnlyId, userId, orgId, '2026-07-10T01:10:00.000Z', '2026-07-10T10:00:00.000Z'],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let failed = false
      try {
        await appendManualOverrideCalculationV1({
          client: clientOf(client) as never,
          orgId,
          recordId: legacyOnlyId,
          expectedCalculationId: null,
          expectedCalculationVersion: null,
          operationId: randomUUID(),
          actorId: userId,
          correlationId: 'no-prior',
          reason: 'should fail',
          evidence: null,
          operations: [{ op: 'set', field: 'status', value: 'normal' }],
          mode: 'authoritative',
          editId: randomUUID(),
        })
      } catch (error) {
        failed = true
        expect(String((error as { code?: string }).code || '')).toMatch(/VERSION_CONFLICT/)
      }
      expect(failed).toBe(true)
      const after = await client.query(
        `SELECT status, current_calculation_id FROM attendance_records WHERE id = $1::uuid`,
        [legacyOnlyId],
      )
      expect(after.rows[0].status).toBe('late')
      expect(after.rows[0].current_calculation_id).toBeNull()
      await client.query('ROLLBACK')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  it('malformed frozen manual override fails recompute closed with zero writes', async () => {
    const malformedRecordId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, '2026-07-11'::date, 'UTC', $4::timestamptz, $5::timestamptz,
               400, 15, 0, 'late', true, '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
      [malformedRecordId, userId, orgId, '2026-07-11T01:10:00.000Z', '2026-07-11T10:00:00.000Z'],
    )
    const malformedPriorId = await seedCompletePriorCalculation(pool, {
      targetRecordId: malformedRecordId,
      manualOverrideSnapshot: {
        operations: [{ op: 'set', field: 'workMinutes', value: -1 }],
      },
    })
    const before = await pool.query(
      `SELECT status, work_minutes, current_calculation_id::text AS current_calculation_id,
              (SELECT COUNT(*)::int FROM attendance_record_calculations
                WHERE attendance_record_id = $1::uuid) AS calculation_count
         FROM attendance_records WHERE id = $1::uuid`,
      [malformedRecordId],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(
        appendRecomputeCalculationV1({
          client: clientOf(client) as never,
          orgId,
          recordId: malformedRecordId,
          expectedCalculationId: malformedPriorId,
          expectedCalculationVersion: await calculationVersion(client, malformedPriorId),
          operationId: randomUUID(),
          actorId: userId,
          correlationId: 'malformed-frozen-manual-override',
          policy: 'frozen_prior',
          mode: 'authoritative',
        }),
      ).rejects.toMatchObject({ code: 'W4C3C_MANUAL_OVERRIDE_INPUT_INVALID' })
      const after = await client.query(
        `SELECT status, work_minutes, current_calculation_id::text AS current_calculation_id,
                (SELECT COUNT(*)::int FROM attendance_record_calculations
                  WHERE attendance_record_id = $1::uuid) AS calculation_count
           FROM attendance_records WHERE id = $1::uuid`,
        [malformedRecordId],
      )
      expect(after.rows[0]).toEqual(before.rows[0])
      await client.query('ROLLBACK')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  it('closed payroll cycle blocks manual override before result DML', async () => {
    const closedRecordId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, '2026-07-12'::date, 'UTC', $4::timestamptz, $5::timestamptz,
               400, 15, 0, 'late', true, '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
      [closedRecordId, userId, orgId, '2026-07-12T01:10:00.000Z', '2026-07-12T10:00:00.000Z'],
    )
    const closedPriorId = await seedCompletePriorCalculation(pool, { targetRecordId: closedRecordId })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_payroll_cycles (org_id, start_date, end_date, status)
         VALUES ($1, '2026-07-01'::date, '2026-07-31'::date, 'closed')`,
        [orgId],
      )
      const before = await client.query(
        `SELECT status, work_minutes, current_calculation_id::text AS current_calculation_id,
                (SELECT COUNT(*)::int FROM attendance_record_calculations
                  WHERE attendance_record_id = $1::uuid) AS calculation_count
           FROM attendance_records WHERE id = $1::uuid`,
        [closedRecordId],
      )
      await expect(
        appendManualOverrideCalculationV1({
          client: clientOf(client) as never,
          orgId,
          recordId: closedRecordId,
          expectedCalculationId: closedPriorId,
          expectedCalculationVersion: await calculationVersion(client, closedPriorId),
          operationId: randomUUID(),
          actorId: userId,
          correlationId: 'closed-cycle-manual-override',
          reason: 'must fail before write',
          evidence: null,
          operations: [{ op: 'set', field: 'status', value: 'normal' }],
          mode: 'authoritative',
          editId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.CYCLE_CLOSED })
      const after = await client.query(
        `SELECT status, work_minutes, current_calculation_id::text AS current_calculation_id,
                (SELECT COUNT(*)::int FROM attendance_record_calculations
                  WHERE attendance_record_id = $1::uuid) AS calculation_count
           FROM attendance_records WHERE id = $1::uuid`,
        [closedRecordId],
      )
      expect(after.rows[0]).toEqual(before.rows[0])
      await client.query('ROLLBACK')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  it('two-segment: manual override copies physical segment rows byte-equivalent; daily projection reflects overlay', async () => {
    const multiRecordId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, $4::date, 'UTC', $5::timestamptz, $6::timestamptz, 400, 15, 0, 'late', true,
               '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
      [
        multiRecordId,
        userId,
        orgId,
        '2026-08-02',
        '2026-08-02T01:10:00.000Z',
        '2026-08-02T10:00:00.000Z',
      ],
    )
    // Temporarily retarget seed workDate attribution via seed helper's org/user only.
    const multiPriorId = await seedCompletePriorCalculation(pool, {
      segmentCount: 2,
      targetRecordId: multiRecordId,
    })
    // Fix work_date on the calculation context is ok for this physical-copy leg.

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const priorSegs = await client.query(
        `SELECT segment_index, expected_start_at, expected_end_at, actual_in_at, actual_out_at,
                work_minutes, late_minutes, early_leave_minutes, status,
                status_reasons, matched_evidence_refs, unmatched_evidence_refs
           FROM attendance_record_segments
          WHERE calculation_id = $1::uuid
          ORDER BY segment_index`,
        [multiPriorId],
      )
      expect(priorSegs.rows).toHaveLength(2)

      const operationId = randomUUID()
      const result = await appendManualOverrideCalculationV1({
        client: clientOf(client) as never,
        orgId,
        recordId: multiRecordId,
        expectedCalculationId: multiPriorId,
        expectedCalculationVersion: await calculationVersion(client, multiPriorId),
        operationId,
        actorId: userId,
        correlationId: `multi-${operationId}`,
        reason: 'two-segment overlay',
        evidence: null,
        operations: [
          { op: 'set', field: 'status', value: 'normal' },
          { op: 'set', field: 'workMinutes', value: 999 },
          { op: 'set', field: 'lateMinutes', value: 0 },
        ],
        mode: 'authoritative',
        editId: operationId,
      })
      expect(result.kind).toBe('appended')
      if (result.kind !== 'appended') throw new Error('expected appended')
      expect(result.projection.workMinutes).toBe(999)
      expect(result.projection.status).toBe('normal')

      const newSegs = await client.query(
        `SELECT segment_index, expected_start_at, expected_end_at, actual_in_at, actual_out_at,
                work_minutes, late_minutes, early_leave_minutes, status,
                status_reasons, matched_evidence_refs, unmatched_evidence_refs
           FROM attendance_record_segments
          WHERE calculation_id = $1::uuid
          ORDER BY segment_index`,
        [result.calculationId],
      )
      expect(newSegs.rows).toHaveLength(2)
      for (let i = 0; i < 2; i += 1) {
        const prior = priorSegs.rows[i]
        const next = newSegs.rows[i]
        expect(Number(next.segment_index)).toBe(Number(prior.segment_index))
        expect(Number(next.work_minutes)).toBe(Number(prior.work_minutes))
        expect(Number(next.late_minutes)).toBe(Number(prior.late_minutes))
        expect(Number(next.early_leave_minutes)).toBe(Number(prior.early_leave_minutes))
        expect(String(next.status)).toBe(String(prior.status))
        // Must NOT have injected daily override totals into segment 0.
        expect(Number(next.work_minutes)).not.toBe(999)
        expect(String(next.status)).not.toBe('normal')
        expect(JSON.stringify(next.status_reasons)).toBe(JSON.stringify(prior.status_reasons))
        expect(JSON.stringify(next.matched_evidence_refs)).toBe(JSON.stringify(prior.matched_evidence_refs))
      }
      // Physical sum still 180+220=400, not 999.
      const sum = newSegs.rows.reduce((acc, row) => acc + Number(row.work_minutes), 0)
      expect(sum).toBe(400)

      const parent = await client.query(
        `SELECT status, work_minutes, late_minutes FROM attendance_records WHERE id = $1::uuid`,
        [multiRecordId],
      )
      expect(parent.rows[0].status).toBe('normal')
      expect(Number(parent.rows[0].work_minutes)).toBe(999)
      expect(Number(parent.rows[0].late_minutes)).toBe(0)

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  it('manual override freezes snapshot; recompute preserves surviving manual_override_snapshot daily overlay', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE attendance_records SET current_calculation_id = $1::uuid, status = 'late',
                visibility_state = 'active', visibility_reason = 'active'
          WHERE id = $2::uuid`,
        [priorCalculationId, recordId],
      )
      const operationId = randomUUID()
      const manual = await appendManualOverrideCalculationV1({
        client: clientOf(client) as never,
        orgId,
        recordId,
        expectedCalculationId: priorCalculationId,
        expectedCalculationVersion: await calculationVersion(client, priorCalculationId),
        operationId,
        actorId: userId,
        correlationId: `manual-${operationId}`,
        reason: 'admin correction for late',
        evidence: { note: 'ticket-1' },
        operations: [
          { op: 'set', field: 'status', value: 'normal' },
          { op: 'set', field: 'lateMinutes', value: 0 },
          { op: 'set', field: 'workMinutes', value: 480 },
        ],
        mode: 'authoritative',
        editId: operationId,
      })
      expect(manual.kind).toBe('appended')
      if (manual.kind !== 'appended') throw new Error('expected appended')

      const calc = await client.query(
        `SELECT manual_override_snapshot, projected_status, projected_work_minutes, projected_late_minutes,
                provenance_fingerprint, input_provenance
           FROM attendance_record_calculations WHERE id = $1::uuid`,
        [manual.calculationId],
      )
      expect(calc.rows[0].manual_override_snapshot).toBeTruthy()
      expect(calc.rows[0].projected_status).toBe('normal')
      expect(Number(calc.rows[0].projected_work_minutes)).toBe(480)
      const priorCalc = await client.query(
        `SELECT provenance_fingerprint, input_provenance
           FROM attendance_record_calculations WHERE id = $1::uuid`,
        [priorCalculationId],
      )
      expect(calc.rows[0].provenance_fingerprint).toBe(priorCalc.rows[0].provenance_fingerprint)
      expect(calc.rows[0].input_provenance?.provenance).toEqual(
        priorCalc.rows[0].input_provenance,
      )
      expect(calc.rows[0].input_provenance?.provenance?.transport).toBe('live_event')

      // frozen_prior recompute must preserve the immutable snapshot and apply overlay daily.
      const recomputeOp = randomUUID()
      const recompute = await appendRecomputeCalculationV1({
        client: clientOf(client) as never,
        orgId,
        recordId,
        expectedCalculationId: manual.calculationId,
        expectedCalculationVersion: await calculationVersion(client, manual.calculationId),
        operationId: recomputeOp,
        actorId: userId,
        correlationId: `recompute-${recomputeOp}`,
        policy: 'frozen_prior',
        mode: 'authoritative',
      })
      expect(recompute.kind).toBe('appended')
      if (recompute.kind !== 'appended') throw new Error('expected appended')

      const recomputeCalc = await client.query(
        `SELECT manual_override_snapshot, projected_status, projected_work_minutes, projected_late_minutes
           FROM attendance_record_calculations WHERE id = $1::uuid`,
        [recompute.calculationId],
      )
      // Immutable snapshot preserved (not cleared).
      expect(recomputeCalc.rows[0].manual_override_snapshot).toBeTruthy()
      expect(JSON.stringify(recomputeCalc.rows[0].manual_override_snapshot)).toBe(
        JSON.stringify(calc.rows[0].manual_override_snapshot),
      )
      // Daily projection includes override overlay.
      expect(recomputeCalc.rows[0].projected_status).toBe('normal')
      expect(Number(recomputeCalc.rows[0].projected_work_minutes)).toBe(480)
      expect(Number(recomputeCalc.rows[0].projected_late_minutes)).toBe(0)

      const parent = await client.query(
        `SELECT status, work_minutes, late_minutes FROM attendance_records WHERE id = $1::uuid`,
        [recordId],
      )
      expect(parent.rows[0].status).toBe('normal')
      expect(Number(parent.rows[0].work_minutes)).toBe(480)
      expect(Number(parent.rows[0].late_minutes)).toBe(0)

      // current_policy with complete frozen context likewise preserves snapshot + overlay.
      const currentOp = randomUUID()
      const current = await appendRecomputeCalculationV1({
        client: clientOf(client) as never,
        orgId,
        recordId,
        expectedCalculationId: recompute.calculationId,
        expectedCalculationVersion: await calculationVersion(client, recompute.calculationId),
        operationId: currentOp,
        actorId: userId,
        correlationId: `current-${currentOp}`,
        policy: 'current_policy',
        mode: 'authoritative',
        currentPolicyAttribution: completeAttribution(),
        currentPolicyContext: completeContext(1),
      })
      expect(current.kind).toBe('appended')
      if (current.kind === 'appended') {
        const curCalc = await client.query(
          `SELECT manual_override_snapshot, projected_status, projected_work_minutes
             FROM attendance_record_calculations WHERE id = $1::uuid`,
          [current.calculationId],
        )
        expect(curCalc.rows[0].manual_override_snapshot).toBeTruthy()
        expect(JSON.stringify(curCalc.rows[0].manual_override_snapshot)).toBe(
          JSON.stringify(calc.rows[0].manual_override_snapshot),
        )
        expect(curCalc.rows[0].projected_status).toBe('normal')
        expect(Number(curCalc.rows[0].projected_work_minutes)).toBe(480)
        priorCalculationId = current.calculationId
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  it('ops_retirement: same operation+payload replays after authoritative success; different op ALREADY_RETIRED; same op changed payload conflicts', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const before = await client.query(
        `SELECT status, current_calculation_id::text AS cid
           FROM attendance_records WHERE id = $1::uuid`,
        [recordId],
      )
      const operationId = randomUUID()
      const payload = {
        client: clientOf(client) as never,
        orgId,
        recordId,
        expectedCalculationId: before.rows[0].cid,
        expectedCalculationVersion: null as number | null,
        operationId,
        actorId: userId,
        correlationId: `retire-${operationId}`,
        reason: 'staging cleanup',
        ticket: 'TICKET-W4C3C-REPLAY',
        mode: 'authoritative' as const,
      }
      const first = await appendOperatorRetirementCalculationV1(payload)
      expect(first.kind).toBe('appended')
      if (first.kind !== 'appended') throw new Error('expected appended')
      const retirementCalc = await client.query(
        `SELECT semantic_input_fingerprint, provenance_fingerprint, attribution_snapshot,
                context_snapshot, evidence_snapshot, approved_facts_snapshot,
                manual_override_snapshot, input_provenance, merge_policy, calculation_tier
           FROM attendance_record_calculations WHERE id = $1::uuid`,
        [first.calculationId],
      )
      const retirementRow = retirementCalc.rows[0]
      expect(retirementRow.provenance_fingerprint).toBe(
        computeAttendanceProvenanceFingerprintV1(retirementRow.input_provenance.provenance),
      )
      expect(retirementRow.input_provenance.provenance.transport).toBe('operator_retirement')
      expect(retirementRow.semantic_input_fingerprint).toBe(
        computeAttendanceSemanticInputFingerprintV1({
          attribution: retirementRow.attribution_snapshot,
          context: retirementRow.context_snapshot,
          evidence: retirementRow.evidence_snapshot,
          approvedFacts: retirementRow.approved_facts_snapshot,
          manualOverride: retirementRow.manual_override_snapshot,
          mergePolicy: retirementRow.merge_policy,
          calculationTier: retirementRow.calculation_tier,
          engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
          snapshotSchemaVersion: 1,
        }),
      )

      // Response-loss replay: same operation + payload after parent is retired.
      const replay = await appendOperatorRetirementCalculationV1(payload)
      expect(replay.kind).toBe('replay')
      if (replay.kind === 'replay') {
        expect(replay.calculationId).toBe(first.calculationId)
      }

      // Same op, changed payload → conflict (not silent already-retired).
      let conflict = false
      try {
        await appendOperatorRetirementCalculationV1({
          ...payload,
          reason: 'different reason payload',
        })
      } catch (error) {
        conflict = true
        expect(String((error as { code?: string }).code || '')).toMatch(/REPLAY_CONFLICT/)
      }
      expect(conflict).toBe(true)

      // Different operation against already-retired → ALREADY_OPERATOR_RETIRED.
      let already = false
      try {
        await appendOperatorRetirementCalculationV1({
          ...payload,
          operationId: randomUUID(),
          expectedCalculationId: first.calculationId,
          reason: 'second retirement attempt',
          ticket: 'TICKET-W4C3C-2',
        })
      } catch (error) {
        already = true
        expect(String((error as { code?: string }).code || '')).toMatch(
          /ALREADY_OPERATOR_RETIRED|ATTENDANCE_RECORD_ALREADY_OPERATOR_RETIRED/,
        )
      }
      expect(already).toBe(true)

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  it('ordinary writers fail closed on retired parents (operator_retirement + import_rollback) with zero reactivation', async () => {
    // Self-contained: retire a dedicated record in this test.
    const retireRecordId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, '2026-07-20'::date, 'UTC', $4::timestamptz, $5::timestamptz,
               400, 15, 0, 'late', true, '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
      [retireRecordId, userId, orgId, '2026-07-20T01:10:00.000Z', '2026-07-20T10:00:00.000Z'],
    )
    const retirePrior = await seedCompletePriorCalculation(pool, {
      segmentCount: 1,
      targetRecordId: retireRecordId,
    })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const retireOp = randomUUID()
      const retired = await appendOperatorRetirementCalculationV1({
        client: clientOf(client) as never,
        orgId,
        recordId: retireRecordId,
        expectedCalculationId: retirePrior,
        expectedCalculationVersion: null,
        operationId: retireOp,
        actorId: userId,
        correlationId: `retire-block-${retireOp}`,
        reason: 'block ordinary writers',
        ticket: 'TICKET-BLOCK',
        mode: 'authoritative',
      })
      expect(retired.kind).toBe('appended')
      if (retired.kind !== 'appended') throw new Error('expected appended')

      const opRetired = await client.query(
        `SELECT visibility_state, visibility_reason, status, current_calculation_id::text AS cid
           FROM attendance_records WHERE id = $1::uuid`,
        [retireRecordId],
      )
      expect(opRetired.rows[0].visibility_state).toBe('retired')
      expect(opRetired.rows[0].visibility_reason).toBe('operator_retirement')
      const beforeStatus = String(opRetired.rows[0].status)
      const beforeCid = opRetired.rows[0].cid

      let recomputeFailed = false
      try {
        await appendRecomputeCalculationV1({
          client: clientOf(client) as never,
          orgId,
          recordId: retireRecordId,
          expectedCalculationId: beforeCid,
          expectedCalculationVersion: await calculationVersion(client, beforeCid),
          operationId: randomUUID(),
          actorId: userId,
          correlationId: 'should-fail',
          policy: 'frozen_prior',
          mode: 'authoritative',
        })
      } catch (error) {
        recomputeFailed = true
        expect(String((error as { code?: string }).code || '')).toMatch(
          /OPERATOR_RETIRED|ATTENDANCE_RECORD_OPERATOR_RETIRED/,
        )
      }
      expect(recomputeFailed).toBe(true)

      let manualFailed = false
      try {
        await appendManualOverrideCalculationV1({
          client: clientOf(client) as never,
          orgId,
          recordId: retireRecordId,
          expectedCalculationId: beforeCid,
          expectedCalculationVersion: await calculationVersion(client, beforeCid),
          operationId: randomUUID(),
          actorId: userId,
          correlationId: 'should-fail-manual',
          reason: 'should fail',
          evidence: null,
          operations: [{ op: 'set', field: 'status', value: 'normal' }],
          mode: 'authoritative',
          editId: randomUUID(),
        })
      } catch (error) {
        manualFailed = true
        expect(String((error as { code?: string }).code || '')).toMatch(
          /OPERATOR_RETIRED|ATTENDANCE_RECORD_OPERATOR_RETIRED/,
        )
      }
      expect(manualFailed).toBe(true)

      const after = await client.query(
        `SELECT status, visibility_state, visibility_reason, current_calculation_id::text AS cid
           FROM attendance_records WHERE id = $1::uuid`,
        [retireRecordId],
      )
      expect(after.rows[0].visibility_state).toBe('retired')
      expect(after.rows[0].visibility_reason).toBe('operator_retirement')
      expect(String(after.rows[0].status)).toBe(beforeStatus)
      expect(after.rows[0].cid).toBe(beforeCid)

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    // import_rollback retired negative control: seed prior, then append a set_retired
    // reverse calc so the pointer guard accepts retired/import_rollback visibility.
    const importRollbackId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, '2026-07-15'::date, 'UTC', $4::timestamptz, $5::timestamptz,
               400, 15, 0, 'late', true, '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
      [importRollbackId, userId, orgId, '2026-07-15T01:00:00.000Z', '2026-07-15T10:00:00.000Z'],
    )
    const irCompletedPrior = await seedCompletePriorCalculation(pool, {
      segmentCount: 1,
      targetRecordId: importRollbackId,
    })
    const irReversalId = randomUUID()
    const irClient = await pool.connect()
    try {
      await irClient.query('BEGIN')
      const fp = 'f'.repeat(64)
      await irClient.query(
        `INSERT INTO attendance_record_calculations (
            id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
            engine_version, snapshot_schema_version, supersedes_calculation_id, operation_id,
            semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
            attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
            approved_facts_snapshot, manual_override_snapshot, input_provenance,
            merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
            expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
            projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
            projected_daily_fingerprint, actor_id, correlation_id
          ) VALUES (
            $1::uuid, $2, $3::uuid, 2, 'reversal', 'authoritative', 'import_rollback',
            $4, 1, $5::uuid, $6::uuid,
            $7::char(64), $7::char(64), $7::char(64),
            $8::jsonb, $9::jsonb, '[]'::jsonb, '[]'::jsonb,
            '[]'::jsonb, NULL, '{}'::jsonb,
            'retire', 'segment_authoritative', 'reversed', 'import_rollback_reversal', 'set_retired',
            0, 'late', $10::timestamptz, $11::timestamptz, 400, 15, 0, $7::text,
            $12, $13
          )`,
        [
          irReversalId,
          orgId,
          importRollbackId,
          ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
          irCompletedPrior,
          randomUUID(),
          fp,
          JSON.stringify(completeAttribution('2026-07-15')),
          JSON.stringify(completeContext(1, '2026-07-15')),
          '2026-07-15T01:10:00.000Z',
          '2026-07-15T10:00:00.000Z',
          userId,
          `import-rollback:${irReversalId}`,
        ],
      )
      await irClient.query(
        `UPDATE attendance_records
            SET current_calculation_id = $1::uuid,
                projection_owner = 'w4',
                visibility_state = 'retired',
                visibility_reason = 'import_rollback',
                status = 'late',
                first_in_at = $3::timestamptz,
                last_out_at = $4::timestamptz,
                work_minutes = 400,
                late_minutes = 15,
                early_leave_minutes = 0
          WHERE id = $2::uuid`,
        [
          irReversalId,
          importRollbackId,
          '2026-07-15T01:10:00.000Z',
          '2026-07-15T10:00:00.000Z',
        ],
      )
      await irClient.query('COMMIT')
    } catch (error) {
      await irClient.query('ROLLBACK')
      throw error
    } finally {
      irClient.release()
    }

    const client2 = await pool.connect()
    try {
      await client2.query('BEGIN')
      let irManualFailed = false
      try {
        await appendManualOverrideCalculationV1({
          client: clientOf(client2) as never,
          orgId,
          recordId: importRollbackId,
          expectedCalculationId: irReversalId,
          expectedCalculationVersion: await calculationVersion(client2, irReversalId),
          operationId: randomUUID(),
          actorId: userId,
          correlationId: 'ir-manual',
          reason: 'should fail import_rollback retired',
          evidence: null,
          operations: [{ op: 'set', field: 'status', value: 'normal' }],
          mode: 'authoritative',
          editId: randomUUID(),
        })
      } catch (error) {
        irManualFailed = true
        expect(String((error as { code?: string }).code || '')).toMatch(
          /ATTENDANCE_RECORD_RETIRED/,
        )
        // Must not use operator_retirement code for non-operator retired.
        expect(String((error as { code?: string }).code || '')).not.toBe(
          'ATTENDANCE_RECORD_OPERATOR_RETIRED',
        )
      }
      expect(irManualFailed).toBe(true)

      let irRecomputeFailed = false
      try {
        await appendRecomputeCalculationV1({
          client: clientOf(client2) as never,
          orgId,
          recordId: importRollbackId,
          expectedCalculationId: irReversalId,
          expectedCalculationVersion: await calculationVersion(client2, irReversalId),
          operationId: randomUUID(),
          actorId: userId,
          correlationId: 'ir-recompute',
          policy: 'frozen_prior',
          mode: 'authoritative',
        })
      } catch (error) {
        irRecomputeFailed = true
        expect(String((error as { code?: string }).code || '')).toMatch(
          /ATTENDANCE_RECORD_RETIRED/,
        )
        expect(String((error as { code?: string }).code || '')).not.toBe(
          'ATTENDANCE_RECORD_OPERATOR_RETIRED',
        )
      }
      expect(irRecomputeFailed).toBe(true)

      const irAfter = await client2.query(
        `SELECT visibility_state, visibility_reason FROM attendance_records WHERE id = $1::uuid`,
        [importRollbackId],
      )
      expect(irAfter.rows[0].visibility_state).toBe('retired')
      expect(irAfter.rows[0].visibility_reason).toBe('import_rollback')

      await client2.query('COMMIT')
    } catch (error) {
      await client2.query('ROLLBACK')
      throw error
    } finally {
      client2.release()
    }
  })

  it('P20: four surfaces use the singular relation and each excludes an operator-retired row', async () => {
    const retiredDate = '2026-07-31'
    const p20Id = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, $4::date, 'UTC', $5::timestamptz, NULL, 0, 0, 0, 'partial', true,
               '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
      [p20Id, userId, orgId, retiredDate, `${retiredDate}T01:00:00.000Z`],
    )
    const p20Prior = await seedCompletePriorCalculation(pool, {
      segmentCount: 1,
      targetRecordId: p20Id,
    })
    // Operator retirement requires W4 pointer (guard).
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await appendOperatorRetirementCalculationV1({
        client: clientOf(client) as never,
        orgId,
        recordId: p20Id,
        expectedCalculationId: p20Prior,
        expectedCalculationVersion: null,
        operationId: randomUUID(),
        actorId: userId,
        correlationId: 'p20-retire',
        reason: 'p20 surface exclusion fixture',
        ticket: 'P20',
        mode: 'authoritative',
      })
      expect(result.kind).toBe('appended')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const query = async (sql: string, params?: readonly unknown[]) =>
      pool.query(sql, [...(params ?? [])])

    expect(ATTENDANCE_ACTIVE_CURRENT_RELATION_V1).toBe('attendance_current_records')

    const decision = await loadActiveCurrentAttendanceRecordForDecisionTraceV1(query, {
      orgId, userId, workDate: retiredDate,
    })
    expect(decision).toBeNull()

    const makeup = await loadActiveCurrentAttendanceRecordForMakeupAnomalyFactsV1(query, {
      orgId, userId, workDate: retiredDate,
    })
    expect(makeup).toBeNull()

    const open = await listActiveCurrentOpenRecordsForWorkDateResolverV1(query, {
      orgId, userId, workDates: [retiredDate],
    })
    expect(open).toEqual([])

    const anomalies = await listActiveCurrentAttendanceRecordsForAnomalyListingV1(query, {
      orgId, userId, from: retiredDate, to: retiredDate, excludedStatuses: ['normal', 'off', 'adjusted'],
    })
    expect(anomalies).toEqual([])

    const base = await pool.query(
      `SELECT id FROM attendance_records
        WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
          AND visibility_state = 'retired' AND visibility_reason = 'operator_retirement'`,
      [orgId, userId, retiredDate],
    )
    expect(base.rows.length).toBeGreaterThanOrEqual(1)
  })

  it('mutation: missing operationId rejected', async () => {
    expect(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.OPERATION_ID_REQUIRED).toBeTruthy()
    expect(ATTENDANCE_RECOMPUTE_ERROR_CODES.OPERATION_ID_REQUIRED).toBeTruthy()
  })
})
