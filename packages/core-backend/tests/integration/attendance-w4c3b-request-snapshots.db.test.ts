import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  AttendanceRequestSnapshotError,
  appendAttendanceRequestCreateSnapshotV1,
  appendAttendanceRequestEditSnapshotV1,
  normalizeAttendanceContextSnapshotV1,
  type W4c3bRequestSnapshotQueryClient,
} from '../../src/attendance/w4c3b-request-snapshots'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

function uuid(): string {
  return crypto.randomUUID()
}

function unsupported() {
  return {
    posture: 'unsupported' as const,
    sourceSchemaVersion: null,
    reason: 'unresolved' as const,
    sourceFingerprint: null,
  }
}

function payload(workDate: string, reason: string | null) {
  return {
    schemaVersion: 1 as const,
    workDate,
    requestedInAt: null,
    requestedOutAt: null,
    reason,
    minutes: null,
    leaveTypeCode: null,
    outdoorPunch: null,
  }
}

async function inRollbackTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

describe('W4C-3b P12 request snapshot guards', () => {
  it('takes the shared rollout lock before resolving even a legacy no-op', async () => {
    const sql: string[] = []
    const client: W4c3bRequestSnapshotQueryClient = {
      query: async (text) => {
        sql.push(text)
        return { rows: [] }
      },
    }
    const before = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    try {
      const result = await appendAttendanceRequestCreateSnapshotV1({
        client,
        orgId: 'default',
        requestId: uuid(),
        requestType: 'leave',
        subjectUserId: 'subject',
        actorUserId: 'actor',
        resolveSnapshots: async () => {
          throw new Error('legacy resolver must not run')
        },
      })
      expect(result).toEqual({ kind: 'legacy_skipped', writePosture: 'legacy_projection_only' })
      expect(sql.some((text) => text.includes('pg_advisory_xact_lock_shared'))).toBe(true)
    } finally {
      if (before === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = before
    }
  })

  it('rejects unknown keys, accessors, and invalid nested segments in frozen context', () => {
    const context = {
      schemaVersion: 1,
      selector: 'legacy',
      orgId: uuid(),
      userId: 'subject',
      workDate: '2026-08-01',
      timezone: 'Asia/Taipei',
      shiftId: uuid(),
      isWorkday: true,
      holidayKind: null,
      calculationGroupId: null,
      roundingMinutes: 5,
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
    expect(normalizeAttendanceContextSnapshotV1(context)).toEqual(context)
    expect(() => normalizeAttendanceContextSnapshotV1({ ...context, extra: true })).toThrow(
      AttendanceRequestSnapshotError,
    )
    const accessor = { ...context }
    Object.defineProperty(accessor, 'timezone', { enumerable: true, get: () => 'Asia/Taipei' })
    expect(() => normalizeAttendanceContextSnapshotV1(accessor)).toThrow(
      AttendanceRequestSnapshotError,
    )
    const segmentAccessor = { ...context, segments: [...context.segments] }
    Object.defineProperty(segmentAccessor.segments, '0', {
      enumerable: true,
      get: () => context.segments[0],
    })
    expect(() => normalizeAttendanceContextSnapshotV1(segmentAccessor)).toThrow(
      AttendanceRequestSnapshotError,
    )
    expect(() => normalizeAttendanceContextSnapshotV1({
      ...context,
      segments: [{ ...context.segments[0], index: 1 }],
    })).toThrow(AttendanceRequestSnapshotError)
  })
})

describeIfDatabase('W4C-3b P12 request snapshots (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    await pool.end()
  })

  it('requires exact OCC tokens and appends A -> B -> A as versions 1..3', async () => {
    await inRollbackTransaction(pool, async (client) => {
      const orgId = uuid()
      const requestId = uuid()
      const subjectUserId = `w4c3b-p12-${uuid()}`
      const previousAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
      try {
        await client.query(
          `INSERT INTO attendance_calculation_rollout_state
             (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
           VALUES ($1, 'shadow', 'w4c3b-p12-test', 'TEST_FIXTURE', 'w4c3b-p12-test', 1, NULL)`,
          [orgId],
        )
        await client.query(
          `INSERT INTO attendance_requests
             (id, user_id, org_id, work_date, request_type, reason, status)
           VALUES ($1::uuid, $2, $3, '2026-08-01', 'leave', 'A', 'pending')`,
          [requestId, subjectUserId, orgId],
        )

        const created = await appendAttendanceRequestCreateSnapshotV1({
          client,
          orgId,
          requestId,
          requestType: 'leave',
          subjectUserId,
          actorUserId: subjectUserId,
          payload: payload('2026-08-01', 'A'),
          attributionSnapshot: unsupported(),
          contextSnapshot: null,
        })
        expect(created.kind).toBe('appended')
        if (created.kind !== 'appended') throw new Error('expected appended create')

        await expect(appendAttendanceRequestEditSnapshotV1({
          client,
          orgId,
          requestId,
          requestType: 'leave',
          subjectUserId,
          actorUserId: subjectUserId,
          payload: payload('2026-08-01', 'B'),
        })).rejects.toMatchObject({ code: 'W4C3B_REQUEST_SNAPSHOT_EXPECTED_VERSION_CONFLICT' })

        await expect(appendAttendanceRequestEditSnapshotV1({
          client,
          orgId,
          requestId,
          requestType: 'leave',
          subjectUserId,
          actorUserId: subjectUserId,
          expectedSnapshotVersion: 1,
          expectedSnapshotFingerprint: 'f'.repeat(64),
          payload: payload('2026-08-01', 'B'),
        })).rejects.toMatchObject({ code: 'W4C3B_REQUEST_SNAPSHOT_EXPECTED_FINGERPRINT_CONFLICT' })

        const afterConflicts = await client.query(
          `SELECT count(*)::int AS n
             FROM attendance_request_calculation_snapshots
            WHERE org_id = $1 AND request_id = $2::uuid`,
          [orgId, requestId],
        )
        expect(afterConflicts.rows[0].n).toBe(1)

        const editedB = await appendAttendanceRequestEditSnapshotV1({
          client,
          orgId,
          requestId,
          requestType: 'leave',
          subjectUserId,
          actorUserId: subjectUserId,
          expectedSnapshotVersion: created.snapshot.version,
          expectedSnapshotFingerprint: created.snapshot.payloadFingerprint,
          payload: payload('2026-08-01', 'B'),
        })
        expect(editedB.kind).toBe('appended')
        if (editedB.kind !== 'appended') throw new Error('expected appended edit B')

        const editedA = await appendAttendanceRequestEditSnapshotV1({
          client,
          orgId,
          requestId,
          requestType: 'leave',
          subjectUserId,
          actorUserId: subjectUserId,
          expectedSnapshotVersion: editedB.snapshot.version,
          expectedSnapshotFingerprint: editedB.snapshot.payloadFingerprint,
          payload: payload('2026-08-01', 'A'),
        })
        expect(editedA.kind).toBe('appended')

        const rows = await client.query(
          `SELECT version, payload_fingerprint
             FROM attendance_request_calculation_snapshots
            WHERE org_id = $1 AND request_id = $2::uuid
            ORDER BY version`,
          [orgId, requestId],
        )
        expect(rows.rows.map((row) => row.version)).toEqual([1, 2, 3])
        expect(rows.rows[0].payload_fingerprint).toBe(rows.rows[2].payload_fingerprint)
        expect(rows.rows[1].payload_fingerprint).not.toBe(rows.rows[0].payload_fingerprint)
      } finally {
        if (previousAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
        else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = previousAllowlist
      }
    })
  })
})
