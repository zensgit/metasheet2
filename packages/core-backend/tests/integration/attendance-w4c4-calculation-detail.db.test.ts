import { randomUUID } from 'node:crypto'
import express from 'express'
import { Pool, type QueryResultRow } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND,
  AttendanceCalculationSchemaUnsupportedError,
  readAttendanceCalculationDetail,
  readAttendanceW4ShadowBacklog,
  type AttendanceW4CalculationQuery,
} from '../../src/services/AttendanceW4CalculationDetail'
import {
  buildTodayStatusTrace,
  type AttendanceDecisionTraceQueryFn,
} from '../../src/services/AttendanceDecisionTrace'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
if (dbUrl) process.env.DATABASE_URL = dbUrl
const describeIfDatabase = dbUrl ? describe : describe.skip

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: (resource: string, action: string) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const permission = `${resource}:${action}`
    const user = req.user as { role?: string; permissions?: string[] } | undefined
    if (user?.role === 'admin' || user?.permissions?.includes(permission)) return next()
    return res.status(403).json({ error: 'Insufficient permissions' })
  },
}))

vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: vi.fn(async () => false),
    listUserPermissions: vi.fn(async () => []),
  }
})

vi.mock('../../src/routes/admin-users', () => ({ ensurePlatformAdmin: vi.fn(async () => null) }))
vi.mock('../../src/services/AttendanceScheduler', () => ({ getSharedAttendanceScheduler: vi.fn(() => null) }))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({ redeliverFailedAttendanceNotification: vi.fn() }))
vi.mock('../../src/services/ApprovalDirectoryOrg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ApprovalDirectoryOrg')>()
  return { ...actual, MAX_MANAGER_CHAIN_LEVELS: 10 }
})

const { attendanceAdminRouter } = await import('../../src/routes/attendance-admin')

type CalculationFixture = {
  calculationId: string
  recordId: string
  orgId: string
  userId: string
  workDate: string
}

describeIfDatabase('W4C-4 calculation detail and DecisionTrace (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const orgA = `w4c4-a-${randomUUID()}`
  const orgB = `w4c4-b-${randomUUID()}`
  const orgShadow = `w4c4-shadow-${randomUUID()}`
  const userA = randomUUID()
  const userB = randomUUID()
  const adminA = randomUUID()
  const outsiderB = randomUUID()
  const shadowUser = randomUUID()
  const platformAdmin = randomUUID()
  const invalidSchemaUser = randomUUID()
  const invalidDiffUser = randomUUID()
  const calculationRaceUser = randomUUID()
  const segmentRaceUser = randomUUID()
  const workDate = '2026-08-03'
  const recordA = randomUUID()
  const recordB = randomUUID()
  const foreignInvalidRecord = randomUUID()
  const foreignPlatformRecord = randomUUID()
  const invalidSchemaRecord = randomUUID()
  const invalidDiffRecord = randomUUID()
  const shadowRecord = randomUUID()
  const foreignSelfRecord = randomUUID()
  const calcToctouRecord = randomUUID()
  const segmentToctouRecord = randomUUID()
  const missingRecord = randomUUID()
  const shiftId = randomUUID()
  let historicalCalculationId = ''
  let currentCalculationId = ''
  let invalidDiffCalculationId = ''
  let calcToctouCalculationId = ''
  let segmentToctouCalculationId = ''

  function makeApp(
    userId: string,
    permissions: string[],
    role?: string,
  ): express.Express {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: unknown }).user = { id: userId, permissions, role }
      next()
    })
    app.use(attendanceAdminRouter())
    return app
  }

  async function seedUser(userId: string, orgIds: string[]): Promise<void> {
    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-4 fixture', 'x', 'user', '[]'::jsonb,
               true, false, 'activated', now(), now())`,
      [userId, `w4c4-${userId}@example.test`],
    )
    for (const orgId of orgIds) {
      await pool.query(
        'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)',
        [userId, orgId],
      )
    }
  }

  async function seedRollout(orgId: string, actorId: string, state: 'shadow' | 'authoritative'): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c4-db-test', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
      [orgId, actorId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'shadow', prior_state = 'legacy', version = 2
        WHERE org_id = $1`,
      [orgId],
    )
    if (state === 'authoritative') {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'eligible', prior_state = 'shadow', version = 3
          WHERE org_id = $1`,
        [orgId],
      )
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'authoritative', prior_state = 'eligible', version = 4
          WHERE org_id = $1`,
        [orgId],
      )
    }
  }

  async function seedRecord(recordId: string, orgId: string, userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_records
       (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
        work_minutes, late_minutes, early_leave_minutes, status, is_workday,
        meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, $4::date, 'UTC', $5::timestamptz, NULL,
               420, 35, 0, 'partial', true, '{}'::jsonb,
               'legacy_untracked', 'active', 'active', now())`,
      [recordId, userId, orgId, workDate, `${workDate}T01:35:00.000Z`],
    )
  }

  async function seedCalculation(input: {
    recordId: string
    orgId: string
    userId: string
    version: number
    mode: 'shadow' | 'authoritative'
    schemaVersion?: number
    review?: boolean
    shadowDiff?: Record<string, unknown> | null
  }): Promise<CalculationFixture> {
    const calculationId = randomUUID()
    const operationId = randomUUID()
    const review = input.review === true
    const context = review ? null : {
      schemaVersion: 1,
      selector: 'legacy',
      orgId: input.orgId,
      userId: input.userId,
      workDate,
      timezone: 'UTC',
      shiftId,
      isWorkday: true,
      holidayKind: null,
      calculationGroupId: null,
      roundingMinutes: 1,
      severeLateThresholdMinutes: 30,
      absenceLateThresholdMinutes: 60,
      segments: [{
        index: 0,
        startTime: '09:00',
        endTime: '18:00',
        startDayOffset: 0,
        endDayOffset: 0,
        lateGraceMinutes: 5,
        earlyLeaveGraceMinutes: 5,
      }],
    }
    const attribution = review
      ? { posture: 'unresolved', reasonCode: 'frozen_evidence_unavailable' }
      : {
          posture: 'resolved_v2',
          value: {
            schemaVersion: 2,
            resolverVersion: 'w4c4-test@1',
            orgId: input.orgId,
            userId: input.userId,
            workDate,
            shiftId,
            reasonCode: 'assignment_match',
            resolvedAt: `${workDate}T00:00:00.000Z`,
            absoluteWindow: { startAt: `${workDate}T00:00:00.000Z`, endAt: `${workDate}T23:59:59.000Z` },
            attributionWindow: { startAt: `${workDate}T00:00:00.000Z`, endAt: `${workDate}T23:59:59.000Z` },
            attributionTailMinutes: 0,
            extendedByApprovedOvertime: false,
            windowEvidenceFingerprint: 'a'.repeat(64),
            source: 'live_resolution',
          },
        }
    const segmentSnapshot = review ? [] : context?.segments ?? []
    const shadowDiffCode = input.shadowDiff ? String(input.shadowDiff.code) : null
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_record_calculations (
          id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
          engine_version, snapshot_schema_version, operation_id,
          semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
          attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
          approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
          outcome, outcome_reason_code, projection_effect, expected_segment_count,
          projected_status, projected_first_in_at, projected_last_out_at,
          projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
          projected_daily_fingerprint, shadow_diff_code, shadow_diff, actor_id, correlation_id
        ) VALUES (
          $1::uuid, $2, $3::uuid, $4, 'calculation', $5, 'live',
          'attendance-segment-v1', $6, $7::uuid,
          $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, '[]'::jsonb,
          '[]'::jsonb, '{}'::jsonb, 'append', $14,
          $15, $16, $17, $18,
          $19, $20::timestamptz, $21::timestamptz,
          $22, $23, $24, $25, $26, $27::jsonb, $28, $29
        )`,
        [
          calculationId,
          input.orgId,
          input.recordId,
          input.version,
          input.mode,
          input.schemaVersion ?? 1,
          operationId,
          '1'.repeat(64),
          '2'.repeat(64),
          review ? null : '3'.repeat(64),
          JSON.stringify(attribution),
          context === null ? null : JSON.stringify(context),
          JSON.stringify(segmentSnapshot),
          review ? 'legacy_shadow' : input.mode === 'authoritative' ? 'segment_authoritative' : 'legacy_shadow',
          review ? 'review_required' : 'completed',
          review ? 'frozen_evidence_unavailable' : input.mode === 'shadow' ? 'shadow_only' : 'calculated',
          input.mode === 'authoritative' && !review ? 'set_active' : 'none',
          review ? 0 : 1,
          review ? null : 'partial',
          review ? null : `${workDate}T01:35:00.000Z`,
          null,
          review ? null : 420,
          review ? null : 35,
          review ? null : 0,
          review ? null : '4'.repeat(64),
          shadowDiffCode,
          input.shadowDiff ? JSON.stringify(input.shadowDiff) : null,
          input.userId,
          `w4c4:${calculationId}`,
        ],
      )
      if (!review) {
        await client.query(
          `INSERT INTO attendance_record_segments (
            org_id, record_id, calculation_id, segment_index,
            expected_start_at, expected_end_at, actual_in_at, actual_out_at,
            work_minutes, late_minutes, early_leave_minutes, status,
            status_reasons, matched_evidence_refs, unmatched_evidence_refs
          ) VALUES (
            $1, $2::uuid, $3::uuid, 0,
            $4::timestamptz, $5::timestamptz, $6::timestamptz, NULL,
            420, 35, 0, 'missing_check_out',
            '["missing_check_out"]'::jsonb, '[]'::jsonb, '[]'::jsonb
          )`,
          [
            input.orgId,
            input.recordId,
            calculationId,
            `${workDate}T01:00:00.000Z`,
            `${workDate}T10:00:00.000Z`,
            `${workDate}T01:35:00.000Z`,
          ],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return { calculationId, recordId: input.recordId, orgId: input.orgId, userId: input.userId, workDate }
  }

  async function pointRecordAt(fixture: CalculationFixture): Promise<void> {
    await pool.query(
      `UPDATE attendance_records
          SET current_calculation_id = $1::uuid, projection_owner = 'w4',
              visibility_state = 'active', visibility_reason = 'active'
        WHERE id = $2::uuid AND org_id = $3`,
      [fixture.calculationId, fixture.recordId, fixture.orgId],
    )
  }

  async function forceRecordSubjectForMutation(recordId: string, userId: string): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL session_replication_role = 'replica'")
      await client.query(
        'UPDATE attendance_records SET user_id = $1 WHERE id = $2::uuid AND org_id = $3',
        [userId, recordId, orgA],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    if (!dbUrl) throw new Error('W4C4_CALCULATION_DETAIL_DB_REQUIRES_DATABASE_URL')
    await seedUser(userA, [orgA])
    await seedUser(userB, [orgA])
    await seedUser(adminA, [orgA])
    await seedUser(outsiderB, [orgB])
    await seedUser(shadowUser, [orgShadow])
    await seedUser(platformAdmin, [])
    await seedUser(invalidSchemaUser, [orgA])
    await seedUser(invalidDiffUser, [orgA])
    await seedUser(calculationRaceUser, [orgA])
    await seedUser(segmentRaceUser, [orgA])
    await seedRollout(orgA, adminA, 'authoritative')
    await seedRollout(orgB, outsiderB, 'authoritative')
    await seedRollout(orgShadow, shadowUser, 'shadow')
    await pool.query(
      `INSERT INTO attendance_shifts
       (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days)
       VALUES ($1::uuid, $2, 'W4C-4 frozen rule', 'UTC', '09:00', '18:00', false, '[1,2,3,4,5]'::jsonb)`,
      [shiftId, orgA],
    )

    for (const [recordId, orgId, userId] of [
      [recordA, orgA, userA],
      [recordB, orgA, userB],
      [foreignInvalidRecord, orgB, outsiderB],
      [foreignPlatformRecord, orgB, platformAdmin],
      [invalidSchemaRecord, orgA, invalidSchemaUser],
      [invalidDiffRecord, orgA, invalidDiffUser],
      [shadowRecord, orgShadow, shadowUser],
      [foreignSelfRecord, orgB, userA],
      [calcToctouRecord, orgA, calculationRaceUser],
      [segmentToctouRecord, orgA, segmentRaceUser],
    ] as const) {
      await seedRecord(recordId, orgId, userId)
    }

    historicalCalculationId = (await seedCalculation({
      recordId: recordA,
      orgId: orgA,
      userId: userA,
      version: 1,
      mode: 'shadow',
      shadowDiff: {
        schemaVersion: 1,
        code: 'status_changed',
        changedFields: ['status'],
        absoluteMinuteDelta: 0,
        segmentCount: 1,
      },
    })).calculationId
    const current = await seedCalculation({
      recordId: recordA,
      orgId: orgA,
      userId: userA,
      version: 2,
      mode: 'authoritative',
    })
    currentCalculationId = current.calculationId
    await pointRecordAt(current)

    await pointRecordAt(await seedCalculation({
      recordId: foreignInvalidRecord,
      orgId: orgB,
      userId: outsiderB,
      version: 1,
      mode: 'authoritative',
      schemaVersion: 2,
    }))
    await pointRecordAt(await seedCalculation({
      recordId: foreignPlatformRecord,
      orgId: orgB,
      userId: outsiderB,
      version: 1,
      mode: 'authoritative',
    }))
    await pointRecordAt(await seedCalculation({
      recordId: invalidSchemaRecord,
      orgId: orgA,
      userId: invalidSchemaUser,
      version: 1,
      mode: 'authoritative',
      schemaVersion: 2,
    }))
    invalidDiffCalculationId = (await seedCalculation({
      recordId: invalidDiffRecord,
      orgId: orgA,
      userId: invalidDiffUser,
      version: 1,
      mode: 'shadow',
      shadowDiff: {
        schemaVersion: 1,
        code: 'status_changed',
        changedFields: ['rawUserId'],
        absoluteMinuteDelta: 0,
        segmentCount: 1,
      },
    })).calculationId
    await seedCalculation({
      recordId: shadowRecord,
      orgId: orgShadow,
      userId: shadowUser,
      version: 1,
      mode: 'shadow',
      shadowDiff: {
        schemaVersion: 1,
        code: 'context_mismatch',
        changedFields: ['context'],
        absoluteMinuteDelta: 0,
        segmentCount: 1,
      },
    })
    calcToctouCalculationId = (await seedCalculation({
      recordId: calcToctouRecord,
      orgId: orgA,
      userId: calculationRaceUser,
      version: 1,
      mode: 'shadow',
      review: true,
    })).calculationId
    segmentToctouCalculationId = (await seedCalculation({
      recordId: segmentToctouRecord,
      orgId: orgA,
      userId: segmentRaceUser,
      version: 1,
      mode: 'shadow',
    })).calculationId
  })

  afterAll(async () => {
    const orgs = [orgA, orgB, orgShadow]
    const client = await pool.connect().catch(() => null)
    if (client) {
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL session_replication_role = 'replica'")
        await client.query('DELETE FROM attendance_record_segments WHERE org_id = ANY($1::text[])', [orgs])
        await client.query('DELETE FROM attendance_record_calculations WHERE org_id = ANY($1::text[])', [orgs])
        await client.query('DELETE FROM attendance_calculation_rollout_events WHERE org_id = ANY($1::text[])', [orgs])
        await client.query('DELETE FROM attendance_calculation_rollout_state WHERE org_id = ANY($1::text[])', [orgs])
        await client.query('DELETE FROM attendance_records WHERE org_id = ANY($1::text[])', [orgs])
        await client.query('DELETE FROM attendance_shifts WHERE id = $1::uuid', [shiftId])
        await client.query('COMMIT')
      } catch {
        await client.query('ROLLBACK').catch(() => undefined)
      } finally {
        client.release()
      }
    }
    const users = [
      userA, userB, adminA, outsiderB, shadowUser, platformAdmin,
      invalidSchemaUser, invalidDiffUser, calculationRaceUser, segmentRaceUser,
    ]
    await pool.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [users]).catch(() => undefined)
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]).catch(() => undefined)
    await pool.end()
  })

  it('enforces the dual-host permission matrix and byte-identical self 404 shape', async () => {
    const self = makeApp(userA, ['attendance:read'])
    expect((await request(self).get(`/api/attendance/records/${recordA}/calculation-detail?orgId=${orgA}`)).status).toBe(200)
    expect((await request(makeApp(userA, [])).get(`/api/attendance/records/${recordA}/calculation-detail?orgId=${orgA}`)).status).toBe(403)

    const other = await request(self).get(`/api/attendance/records/${recordB}/calculation-detail?orgId=${orgA}`)
    const missing = await request(self).get(`/api/attendance/records/${missingRecord}/calculation-detail?orgId=${orgA}`)
    expect(other.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(other.text).toBe(missing.text)

    const delegatedAdmin = makeApp(adminA, ['attendance:admin'])
    expect((await request(delegatedAdmin).get(`/api/attendance-admin/records/${recordA}/calculation-detail?orgId=${orgA}`)).status).toBe(200)
    expect((await request(makeApp(userA, ['attendance:read'])).get(`/api/attendance-admin/records/${recordA}/calculation-detail?orgId=${orgA}`)).status).toBe(403)

    // The foreign row has unsupported schema. A result-table query would therefore produce 409;
    // 403 proves the delegated org gate ran before the read-only result transaction.
    const spoof = await request(delegatedAdmin).get(
      `/api/attendance-admin/records/${foreignInvalidRecord}/calculation-detail?orgId=${orgB}`,
    )
    expect(spoof.status).toBe(403)

    const override = await request(makeApp(platformAdmin, [], 'admin')).get(
      `/api/attendance-admin/records/${foreignPlatformRecord}/calculation-detail?orgId=${orgB}`,
    )
    expect(override.status).toBe(200)
  })

  it('selects the current pointer by default and explicit immutable history by calculationId', async () => {
    const admin = makeApp(adminA, ['attendance:admin'])
    const current = await request(admin).get(
      `/api/attendance-admin/records/${recordA}/calculation-detail?orgId=${orgA}`,
    )
    const history = await request(admin).get(
      `/api/attendance-admin/records/${recordA}/calculation-detail?orgId=${orgA}&calculationId=${historicalCalculationId}`,
    )
    expect(current.status).toBe(200)
    expect(Object.keys(current.body.data).sort()).toEqual(['calculation', 'current', 'recordId', 'segments'])
    expect(current.body.data.calculation.id).toBe(currentCalculationId)
    expect(current.body.data.calculation.version).toBe(2)
    expect(current.body.data.calculation.mode).toBe('authoritative')
    expect(history.status).toBe(200)
    expect(history.body.data.calculation.id).toBe(historicalCalculationId)
    expect(history.body.data.calculation.version).toBe(1)
    expect(history.body.data.calculation.mode).toBe('shadow')
    expect(history.body.data.current.posture).toBe('authoritative')
  })

  it('returns a values-free shadow backlog and enforces its org gate', async () => {
    const ordinaryQuery = ((sql: string, params?: unknown[]) => pool.query(sql, params)) as AttendanceW4CalculationQuery
    await expect(readAttendanceW4ShadowBacklog(orgShadow, 50, ordinaryQuery)).resolves.toEqual([{
      entrypoint: 'live',
      code: 'context_mismatch',
      label: 'Frozen context differs',
      critical: true,
      count: 1,
    }])

    const delegatedForeign = await request(makeApp(adminA, ['attendance:admin'])).get(
      `/api/attendance-admin/calculation-shadow-backlog?orgId=${orgShadow}`,
    )
    expect(delegatedForeign.status).toBe(403)

    const platform = await request(makeApp(platformAdmin, [], 'admin')).get(
      `/api/attendance-admin/calculation-shadow-backlog?orgId=${orgShadow}`,
    )
    expect(platform.status).toBe(200)
    expect(platform.body.data.items).toEqual([{
      entrypoint: 'live',
      code: 'context_mismatch',
      label: 'Frozen context differs',
      critical: true,
      count: 1,
    }])
    expect(JSON.stringify(platform.body.data)).not.toMatch(/user|punch|request|shift|group|recordId|calculationId/i)
  })

  it('captures representative synthetic EXPLAIN evidence for detail, reversal and backlog reads', async () => {
    const explain = async (sql: string, params: unknown[]): Promise<string> => {
      const result = await pool.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        params,
      )
      expect(result.rows).toHaveLength(1)
      return JSON.stringify(result.rows[0]?.['QUERY PLAN'])
    }

    const currentPlan = await explain(
      `SELECT r.id::text AS id, r.current_calculation_id::text AS current_calculation_id,
              current_calculation.mode AS current_mode, r.projection_owner,
              r.visibility_state, r.visibility_reason
         FROM attendance_records r
         LEFT JOIN attendance_record_calculations current_calculation
           ON current_calculation.id = r.current_calculation_id
          AND current_calculation.attendance_record_id = r.id
          AND current_calculation.org_id = r.org_id
        WHERE r.id = $1::uuid AND r.org_id = $2 AND r.user_id = $3
        LIMIT 1`,
      [recordA, orgA, userA],
    )
    expect(currentPlan).toContain('attendance_records')
    expect(currentPlan).toContain('attendance_record_calculations')

    const historyPlan = await explain(
      `SELECT calculation.id
         FROM attendance_record_calculations calculation
         JOIN attendance_records owner
           ON owner.id = calculation.attendance_record_id
          AND owner.org_id = calculation.org_id
          AND owner.user_id = $4
        WHERE calculation.id = $1::uuid
          AND calculation.attendance_record_id = $2::uuid
          AND calculation.org_id = $3
        LIMIT 1`,
      [historicalCalculationId, recordA, orgA, userA],
    )
    expect(historyPlan).toContain('attendance_record_calculations')
    expect(historyPlan).toContain('attendance_records')

    const sourceBatchPlan = await explain(
      `SELECT source.user_id, source.work_date, source.attendance_record_id
         FROM (
           SELECT i.user_id::text AS user_id, i.work_date,
                  COALESCE(i.record_id::text, i.id::text) AS attendance_record_id
             FROM attendance_import_items i
            WHERE i.org_id = $1 AND i.batch_id = $2::uuid
              AND i.user_id IS NOT NULL AND i.work_date IS NOT NULL
           UNION
           SELECT r.user_id::text, r.work_date, r.id::text
             FROM attendance_records r
            WHERE r.org_id = $1 AND r.source_batch_id = $2::uuid
         ) source
        ORDER BY source.user_id, source.work_date, source.attendance_record_id`,
      [orgA, randomUUID()],
    )
    expect(sourceBatchPlan).toContain('attendance_import_items')
    expect(sourceBatchPlan).toContain('attendance_records')

    const backlogPlan = await explain(
      `SELECT entrypoint, shadow_diff_code, count(*)::int AS item_count
         FROM attendance_record_calculations
        WHERE org_id = $1 AND mode = 'shadow'
          AND shadow_diff_code IS NOT NULL AND shadow_diff_code <> 'equal'
        GROUP BY entrypoint, shadow_diff_code
        ORDER BY entrypoint ASC, shadow_diff_code ASC
        LIMIT $2`,
      [orgShadow, 50],
    )
    expect(backlogPlan).toContain('attendance_record_calculations')
  })

  it('maps persisted unsupported schema and closed-vocabulary violations to 409', async () => {
    const schema = await request(makeApp(invalidSchemaUser, ['attendance:read'])).get(
      `/api/attendance/records/${invalidSchemaRecord}/calculation-detail?orgId=${orgA}`,
    )
    expect(schema.status).toBe(409)
    expect(schema.body.error.code).toBe('CALCULATION_SCHEMA_UNSUPPORTED')

    const changedField = await request(makeApp(invalidDiffUser, ['attendance:read'])).get(
      `/api/attendance/records/${invalidDiffRecord}/calculation-detail?orgId=${orgA}&calculationId=${invalidDiffCalculationId}`,
    )
    expect(changedField.status).toBe(409)
    expect(changedField.body.error.code).toBe('CALCULATION_SCHEMA_UNSUPPORTED')
  })

  it('keeps authoritative DecisionTrace stable under mutable parent and current-rule changes', async () => {
    const runQuery = ((sql: string, params?: unknown[]) => pool.query(sql, params)) as AttendanceDecisionTraceQueryFn
    const before = await buildTodayStatusTrace(orgA, userA, workDate, runQuery)
    expect(before.confidence).toBe('grounded')
    expect(before.basis).toEqual([expect.objectContaining({
      source: { kind: 'snapshot', ref: 'attendance_record_calculations:authoritative' },
    })])

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL session_replication_role = 'replica'")
      await client.query(
        `UPDATE attendance_records
            SET status = 'normal', first_in_at = NULL, last_out_at = now(),
                work_minutes = 1, late_minutes = 0, early_leave_minutes = 0,
                meta = '{"severeLateThresholdMinutes":999}'::jsonb
          WHERE id = $1::uuid AND org_id = $2`,
        [recordA, orgA],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    await pool.query(
      `UPDATE attendance_shifts
          SET work_start_time = '12:00', work_end_time = '13:00', working_days = '[7]'::jsonb
        WHERE id = $1::uuid AND org_id = $2`,
      [shiftId, orgA],
    )

    const after = await buildTodayStatusTrace(orgA, userA, workDate, runQuery)
    expect(after).toEqual(before)
  })

  it('labels shadow evidence and never presents it as the legacy row decision', async () => {
    const runQuery = ((sql: string, params?: unknown[]) => pool.query(sql, params)) as AttendanceDecisionTraceQueryFn
    const trace = await buildTodayStatusTrace(orgShadow, shadowUser, workDate, runQuery)
    expect(trace.basis).toContainEqual({
      source: { kind: 'snapshot', ref: 'attendance_record_calculations:shadow' },
      version: { posture: 'current_live_no_history' },
    })
    expect(trace.basis).not.toContainEqual(expect.objectContaining({
      source: { kind: 'snapshot', ref: 'attendance_record_calculations:authoritative' },
    }))
  })

  it('has real fixtures that expose subject/org predicate neuters', async () => {
    const ordinaryQuery = ((sql: string, params?: unknown[]) => pool.query(sql, params)) as AttendanceW4CalculationQuery
    expect(await readAttendanceCalculationDetail(
      { orgId: orgA, recordId: recordB, subjectUserId: userA },
      ordinaryQuery,
    )).toBe(ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND)

    const neuterRecordSubject = ((sql: string, params?: unknown[]) => {
      if (!sql.includes(' AND r.user_id = $3')) return pool.query(sql, params)
      return pool.query(sql.replace(' AND r.user_id = $3', ''), params?.slice(0, 2))
    }) as AttendanceW4CalculationQuery
    const leakedOther = await readAttendanceCalculationDetail(
      { orgId: orgA, recordId: recordB, subjectUserId: userA },
      neuterRecordSubject,
    )
    expect(leakedOther).not.toBe(ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND)

    expect(await readAttendanceCalculationDetail(
      { orgId: orgA, recordId: foreignSelfRecord, subjectUserId: userA },
      ordinaryQuery,
    )).toBe(ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND)
    const neuterRecordOrg = ((sql: string, params?: unknown[]) => {
      if (!sql.includes('r.org_id = $2 AND r.user_id = $3')) return pool.query(sql, params)
      return pool.query(
        sql.replace('r.org_id = $2 AND r.user_id = $3', 'r.user_id = $2'),
        params ? [params[0], params[2]] : params,
      )
    }) as AttendanceW4CalculationQuery
    const leakedForeign = await readAttendanceCalculationDetail(
      { orgId: orgA, recordId: foreignSelfRecord, subjectUserId: userA },
      neuterRecordOrg,
    )
    expect(leakedForeign).not.toBe(ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND)

    let calculationQuerySeen = false
    const calculationRace = (async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => {
      if (/FROM attendance_record_calculations calculation/.test(sql)) {
        calculationQuerySeen = true
        await forceRecordSubjectForMutation(calcToctouRecord, outsiderB)
      }
      return pool.query<T>(sql, params)
    }) as AttendanceW4CalculationQuery
    expect(await readAttendanceCalculationDetail(
      { orgId: orgA, recordId: calcToctouRecord, subjectUserId: calculationRaceUser, calculationId: calcToctouCalculationId },
      calculationRace,
    )).toBe(ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND)
    expect(calculationQuerySeen).toBe(true)
    await forceRecordSubjectForMutation(calcToctouRecord, calculationRaceUser)

    const neuterCalculationSubject = (async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => {
      if (/FROM attendance_record_calculations calculation/.test(sql)) {
        await forceRecordSubjectForMutation(calcToctouRecord, outsiderB)
      }
      if (!sql.includes('AND owner.user_id = $4')) return pool.query<T>(sql, params)
      return pool.query<T>(sql.replace('AND owner.user_id = $4', ''), params?.slice(0, 3))
    }) as AttendanceW4CalculationQuery
    const leakedCalculation = await readAttendanceCalculationDetail(
      { orgId: orgA, recordId: calcToctouRecord, subjectUserId: calculationRaceUser, calculationId: calcToctouCalculationId },
      neuterCalculationSubject,
    )
    expect(leakedCalculation).not.toBe(ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND)
    await forceRecordSubjectForMutation(calcToctouRecord, calculationRaceUser)

    const segmentRace = (async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => {
      if (/FROM attendance_record_segments segment/.test(sql)) {
        await forceRecordSubjectForMutation(segmentToctouRecord, outsiderB)
      }
      return pool.query<T>(sql, params)
    }) as AttendanceW4CalculationQuery
    await expect(readAttendanceCalculationDetail(
      { orgId: orgA, recordId: segmentToctouRecord, subjectUserId: segmentRaceUser, calculationId: segmentToctouCalculationId },
      segmentRace,
    )).rejects.toBeInstanceOf(AttendanceCalculationSchemaUnsupportedError)
    await forceRecordSubjectForMutation(segmentToctouRecord, segmentRaceUser)

    const neuterSegmentSubject = (async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => {
      if (/FROM attendance_record_segments segment/.test(sql)) {
        await forceRecordSubjectForMutation(segmentToctouRecord, outsiderB)
      }
      if (!sql.includes('AND owner.user_id = $4')) return pool.query<T>(sql, params)
      return pool.query<T>(sql.replace('AND owner.user_id = $4', ''), params?.slice(0, 3))
    }) as AttendanceW4CalculationQuery
    const leakedSegment = await readAttendanceCalculationDetail(
      { orgId: orgA, recordId: segmentToctouRecord, subjectUserId: segmentRaceUser, calculationId: segmentToctouCalculationId },
      neuterSegmentSubject,
    )
    expect(leakedSegment).not.toBe(ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND)
    await forceRecordSubjectForMutation(segmentToctouRecord, segmentRaceUser)
  })
})
