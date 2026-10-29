/**
 * LIVE07 native selection on the #6630 source: production adapters and PostgreSQL.
 * Observe the loader result before mapping, returning every native result unchanged.
 * Legal adjustment/foreign-org fixtures use production migrations and active memberships.
 * Boundary proof only: no HTTP claim, private export, SQL replacement or constraint bypass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import {
  createAttendanceLiveScheduledBoundaryV1,
  computeAttendanceOuterSourceDefinitionFingerprintV1,
  type AttendancePluginShapedTrxV1,
  type AttendanceW4LiveScheduledLegacyAdaptersV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import { applyAttendanceInOutMergePolicyPureV1 } from '../../src/attendance/w4c1-merge-policy'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
if (!dbUrl) throw new Error('LIVE07 requires production-migrated PostgreSQL')
const requireCjs = createRequire(import.meta.url)
type Adapters = AttendanceW4LiveScheduledLegacyAdaptersV1
type NativeSelection = { params: unknown[]; rows: Array<Record<string, unknown>> }
const workDate = '2026-05-04'
const checkInAt = '2026-05-04T01:00:00.000Z'
const checkOutAt = '2026-05-04T10:00:00.000Z'

describe('LIVE07 native physical-event and org selection', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let server: MetaSheetServer | undefined
  let adapters: Adapters
  const priorEnv = new Map<string, string | undefined>()
  const allowedOrgs: string[] = []

  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'SKIP_PLUGINS', 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED']) {
      priorEnv.set(key, process.env[key])
    }
    process.env.DATABASE_URL = dbUrl
    process.env.SKIP_PLUGINS = 'false'
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ''
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0, host: '127.0.0.1',
      pluginDirs: [path.resolve(__dirname, '../../../../plugins/plugin-attendance')],
    })
    await server.start()
    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4c2LivePunchAdaptersForTests: {
        applyLivePunchProjectionLegacyV1: (
          trx: Parameters<Adapters['applyLivePunchLegacy']>[0],
          args: Parameters<Adapters['applyLivePunchLegacy']>[1],
          merge: typeof applyAttendanceInOutMergePolicyPureV1,
        ) => ReturnType<Adapters['applyLivePunchLegacy']>
        insertLivePunchEventV1: Adapters['insertLivePunchEvent']
        deriveLivePunchWorkDateResolutionV1: Adapters['deriveLivePunchWorkDateResolution']
        resolveW4LiveCandidateInTransactionV1: Adapters['resolveLiveCandidate']
        buildW4ShadowFrozenContextV1: Adapters['buildShadowFrozenContext']
      }
      __attendanceW7IssuanceSeamForTests: { issueAttendanceFrozenContextV1: Adapters['issueFrozenContext'] }
    }
    const a = plugin.__attendanceW4c2LivePunchAdaptersForTests
    adapters = {
      applyLivePunchLegacy: (trx, args) =>
        a.applyLivePunchProjectionLegacyV1(trx, args, applyAttendanceInOutMergePolicyPureV1),
      insertLivePunchEvent: a.insertLivePunchEventV1,
      deriveLivePunchWorkDateResolution: a.deriveLivePunchWorkDateResolutionV1,
      resolveLiveCandidate: a.resolveW4LiveCandidateInTransactionV1,
      buildShadowFrozenContext: a.buildW4ShadowFrozenContextV1,
      issueFrozenContext: plugin.__attendanceW7IssuanceSeamForTests.issueAttendanceFrozenContextV1,
      applyScheduledAbsenceLegacy: async () => [],
      resolveScheduledCandidate: async () => ({ kind: 'unresolved' }),
    }
  }, 180000)

  afterAll(async () => {
    await server?.stop()
    await pool.end()
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // Append-only calculation, operation and rollout rows stay in the owned test DB.
  }, 60000)

  for (const mode of ['shadow', 'authoritative'] as const) {
    for (const decoy of ['nonphysical', 'foreign-org'] as const) {
      it(`${mode}: excludes ${decoy} decoy before mapping and from persisted evidence`, async () => {
        const orgId = randomUUID(), foreignOrgId = randomUUID(), userId = randomUUID()
        const shiftId = randomUUID(), checkInId = randomUUID(), decoyId = randomUUID()
        await pool.query(
          `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin)
           VALUES ($1, $2, $1, 'LIVE07 fixture', 'x', 'user', '[]'::jsonb, true, false)`,
          [userId, `${userId}@live07.test`],
        )
        for (const fixtureOrg of [orgId, foreignOrgId]) {
          await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, fixtureOrg])
          await pool.query(
            `INSERT INTO attendance_rules
             (id, org_id, name, timezone, timezone_version, work_start_time, work_end_time, working_days, is_default)
             VALUES ($1, $2, 'LIVE07 rule', 'Asia/Shanghai', 1, '09:00', '18:00', '[1,2,3,4,5]'::jsonb, true)`,
            [randomUUID(), fixtureOrg],
          )
        }
        await pool.query(
          `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time, timezone)
           VALUES ($1, $2, 'LIVE07 shift', '09:00', '18:00', 'Asia/Shanghai')`, [shiftId, orgId],
        )
        await pool.query(
          `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
           VALUES ($1, $2, $3, $4, 0, '2026-05-01', NULL, true, 'published', 'regular')`,
          [randomUUID(), orgId, userId, shiftId],
        )
        await pool.query(
          `INSERT INTO attendance_calculation_rollout_state
           (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
           VALUES ($1, 'shadow', 'live07-native', 'TEST_FIXTURE', 'live07-native', 1, NULL)`, [orgId],
        )
        if (mode === 'authoritative') {
          for (const [state, prior, version] of [['eligible', 'shadow', 2], ['authoritative', 'eligible', 3]] as const) {
            await pool.query(
              'UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1',
              [orgId, state, prior, version],
            )
          }
        }
        allowedOrgs.push(orgId)
        process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = allowedOrgs.join(',')
        await pool.query(
          `INSERT INTO attendance_events (id, org_id, user_id, work_date, occurred_at, event_type, source, timezone)
           VALUES ($1, $2, $3, $4, $5, 'check_in', 'manual', 'Asia/Shanghai'),
                  ($6, $7, $3, $4, '2026-05-04T02:00:00.000Z', $8, 'manual', 'Asia/Shanghai')`,
          [checkInId, orgId, userId, workDate, checkInAt, decoyId,
            decoy === 'foreign-org' ? foreignOrgId : orgId,
            decoy === 'nonphysical' ? 'adjustment' : 'check_in'],
        )
        const decoyReadback = await pool.query(
          'SELECT id::text, org_id, user_id, work_date::text, event_type FROM attendance_events WHERE id = $1', [decoyId],
        )
        expect(decoyReadback.rows).toEqual([{
          id: decoyId, org_id: decoy === 'foreign-org' ? foreignOrgId : orgId,
          user_id: userId, work_date: workDate, event_type: decoy === 'nonphysical' ? 'adjustment' : 'check_in',
        }])
        const selections: NativeSelection[] = []
        const boundary = createAttendanceLiveScheduledBoundaryV1({
          legacyAdapters: adapters,
          acquireConnection: async () => {
            const client = await pool.connect()
            return {
              client: {
                async query(sqlText, params = []) {
                  const result = await client.query(sqlText, params)
                  if (sqlText.includes('SELECT id::text AS id, event_type, occurred_at, source')
                    && sqlText.includes('FROM attendance_events')) {
                    selections.push({
                      params: [...params],
                      rows: result.rows.map(row => ({ ...row, occurred_at: new Date(row.occurred_at).toISOString() })),
                    })
                  }
                  return result
                },
              },
              release: () => client.release(),
            }
          },
        })
        const client = await pool.connect()
        const trx: AttendancePluginShapedTrxV1 = {
          __w4CanonicalTrx: true,
          query: async (sqlText, params = []) => (await client.query(sqlText, params)).rows,
        }
        let resolution: Awaited<ReturnType<Adapters['resolveLiveCandidate']>>
        let context: Awaited<ReturnType<Adapters['buildShadowFrozenContext']>>
        try {
          resolution = await adapters.resolveLiveCandidate(trx, {
            orgId, userId, occurredAt: checkOutAt, timezone: 'Asia/Shanghai',
          })
          expect(resolution.kind).toBe('resolved')
          expect(resolution.shiftId).toBe(shiftId)
          context = await adapters.buildShadowFrozenContext(trx, {
            orgId, userId, workDate, shiftId, timezone: 'Asia/Shanghai', isWorkday: true, holidayKind: null,
          })
        } finally {
          client.release()
        }
        await boundary.executeLivePunch({
          orgId, userId, operationId: randomUUID(), eventType: 'check_out',
          occurredAtRaw: checkOutAt, occurredAtResolved: checkOutAt,
          timezone: 'Asia/Shanghai', requestTimezone: 'Asia/Shanghai', source: 'mobile',
          location: null, meta: null, photoFileRef: null, workDate, shiftId,
          outerSourceDefinitionFingerprint: computeAttendanceOuterSourceDefinitionFingerprintV1({
            orgId, userId, source: 'live_resolution', nowIso: new Date().toISOString(), resolution, context,
          }),
          isWorkday: true, holidayKind: null,
        })
        const { rows: checkOutRows } = await pool.query(
          `SELECT id::text AS id FROM attendance_events
           WHERE org_id = $1 AND user_id = $2 AND work_date = $3 AND event_type = 'check_out'`,
          [orgId, userId, workDate],
        )
        expect(checkOutRows).toHaveLength(1)
        const checkOutId = checkOutRows[0].id as string
        expect(selections).toEqual([{
          params: [userId, orgId, workDate],
          rows: [
            { id: checkInId, event_type: 'check_in', occurred_at: checkInAt, source: 'manual' },
            { id: checkOutId, event_type: 'check_out', occurred_at: checkOutAt, source: 'mobile' },
          ],
        }])
        const { rows: calculations } = await pool.query(
          `SELECT c.mode, c.outcome, c.outcome_reason_code, c.expected_segment_count, c.evidence_snapshot
             FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id
            WHERE c.org_id = $1 AND r.user_id = $2`, [orgId, userId],
        )
        expect(calculations).toEqual([{
          mode, outcome: 'completed', outcome_reason_code: 'calculated', expected_segment_count: 1,
          evidence_snapshot: [
            { kind: 'punch', ref: checkInId, direction: 'check_in', occurredAt: checkInAt, source: 'attendance_event' },
            { kind: 'punch', ref: checkOutId, direction: 'check_out', occurredAt: checkOutAt, source: 'attendance_event' },
          ],
        }])
      }, 60000)
    }
  }
})
