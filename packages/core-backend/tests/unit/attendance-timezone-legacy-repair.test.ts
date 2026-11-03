import { describe, expect, it } from 'vitest'
import {
  applyAttendanceTimezoneLegacyRepairV1, attendanceLegacyRepairRecordFingerprintV1,
  buildAttendanceLegacyRepairFrameV1, parseAttendanceLegacyRepairEvidenceV1,
  previewAttendanceTimezoneLegacyRepairV1,
} from '../../src/attendance/attendance-timezone-legacy-repair'
import type { AttendanceLegacyRepairEvidenceV1 } from '../../src/attendance/attendance-timezone-legacy-repair'

const orgId = '00000000-0000-4000-8000-000000006395'
const record = {
  id: 'legacy-record', org_id: orgId, user_id: 'employee', work_date: '2026-10-14',
  timezone: 'Asia/Shanghai', visibility_state: 'active', projection_owner: 'legacy_untracked',
  is_workday: true,
  current_calculation_id: null, first_in_at: '2026-10-14T01:00:00+00:00', last_out_at: null,
  meta: { severe_late_count: 0, severe_late_minutes: 0, absence_late_count: 0 },
}
function evidence(): AttendanceLegacyRepairEvidenceV1 {
  return {
    schemaVersion: 1, kind: 'archived_legacy_rule_context', orgId, userId: 'employee', recordId: 'legacy-record',
    workDate: '2026-10-14', timezone: 'Asia/Shanghai', expectedRecordFingerprint: attendanceLegacyRepairRecordFingerprintV1(record),
    archive: { reference: 'synthetic-private-archive', capturedAt: '2026-10-14T01:00:00Z', reviewedBy: 'admin', attestation: 'historical_source_reviewed' },
    rule: { id: null, orgId, timezone: 'Asia/Shanghai', workStartTime: '09:00', workEndTime: '18:00', isOvernight: false,
      workingDays: [1, 2, 3, 4, 5], lateGraceMinutes: 5, earlyGraceMinutes: 3, roundingMinutes: 15,
      severeLateThresholdMinutes: 30, absenceLateThresholdMinutes: 120,
      flexMode: null, flexRequiredMinutes: null, flexArrivalWindowBeforeMinutes: null,
      flexArrivalWindowAfterMinutes: null, flexCoreStartTime: null, flexCoreEndTime: null },
    calendar: { isWorkingDay: true, holiday: null },
    noWinningAssignment: { reasonCode: 'UNSCHEDULED_NO_SHIFT', attestation: 'no_winning_assignment_at_original_record_freeze' },
    attribution: { tailMinutes: 120, approvedOvertimeWindows: [], attestation: 'complete_historical_tail_and_approved_overtime' },
    absoluteWindow: { startAt: '2026-10-14T01:00:00Z', endAt: '2026-10-14T10:00:00Z' },
    attributionWindow: { startAt: '2026-10-14T01:00:00Z', endAt: '2026-10-14T12:00:00Z' },
  }
}

function database(initialRecord = structuredClone(record)) {
  const sql: string[] = []
  let companion: Record<string, unknown> | null = null
  let posture: Record<string, unknown>[] = []
  let admin = true
  let member = true
  const client = {
    release() {},
    async query(query: string, args: unknown[] = []) {
      sql.push(query)
      if (query.includes("JOIN user_roles")) return { rows: admin ? [{ id: 'admin' }] : [] }
      if (query.includes('JOIN user_orgs')) return { rows: member ? [{ id: 'employee' }] : [] }
      if (query.includes('FROM attendance_calculation_rollout_state')) return { rows: posture }
      if (query.includes('FROM attendance_timezone_context_companions')) return { rows: companion ? [companion] : [] }
      if (query.includes('to_jsonb(r)')) return { rows: [{ original_record: initialRecord }] }
      if (query.includes('INSERT INTO attendance_timezone_context_companions')) {
        companion = { record_id: args[0], org_id: args[1], user_id: args[2], repair_work_date: args[3], timezone: args[4],
          context_fingerprint: args[9], original_freeze_fingerprint: args[10],
          frame_snapshot: JSON.parse(String(args[11])), original_freeze_snapshot: JSON.parse(String(args[12])) }
      }
      return { rows: [] }
    },
  }
  return { pool: { async connect() { return client } }, sql, record: initialRecord,
    companion: () => companion, posture: (value: Record<string, unknown>[]) => { posture = value },
    admin: (value: boolean) => { admin = value }, member: (value: boolean) => { member = value } }
}
const input = (e = evidence()) => ({ source: JSON.stringify(e), actorId: 'admin', archiveSourceConfirmed: true as const })

describe('reviewed ordinary legacy timezone repair', () => {
  it('constructs frozen strict rule and unresolved identity without calculator credentials', () => {
    const frame = buildAttendanceLegacyRepairFrameV1(parseAttendanceLegacyRepairEvidenceV1(input().source))
    const { orgId: _orgId, ...canonicalRule } = evidence().rule
    expect(frame.identity.source).toBe('legacy_repair')
    expect(frame.identity.calculationDefinition).toEqual({ kind: 'rule', isWorkday: true, holidayKind: null,
      rule: canonicalRule })
    expect(frame.resolution).toEqual({ kind: 'unresolved', reasonCode: 'UNSCHEDULED_NO_SHIFT', workDate: '2026-10-14',
      attributionTailMinutes: 120, approvedOvertimeWindows: [] })
    expect(frame.timezoneContext).toBeNull()
    expect(frame).not.toHaveProperty('issued')
  })

  it('preview owns a read-only repeatable-read transaction and performs no DML', async () => {
    const db = database()
    const result = await previewAttendanceTimezoneLegacyRepairV1(db.pool, input())
    expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREVIEW_READY')
    expect(db.sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(db.sql.at(-1)).toBe('COMMIT')
    expect(db.sql.some(sql => /\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false)
    expect(db.companion()).toBeNull()
  })

  it('apply appends a companion preserving record and replays after a later legitimate record update', async () => {
    const db = database()
    const original = structuredClone(db.record)
    const preview = await previewAttendanceTimezoneLegacyRepairV1(db.pool, input())
    const approved = { ...input(), approvedSourceSha256: preview.sourceSha256, approvedPlanSha256: preview.planSha256 }
    expect((await applyAttendanceTimezoneLegacyRepairV1(db.pool, approved)).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_APPLIED')
    expect(db.record).toEqual(original)
    const snapshot = db.companion()!.original_freeze_snapshot as Record<string, unknown>
    expect(snapshot.originalRecord).toEqual(original)
    db.record.meta.severe_late_minutes = 10
    expect((await applyAttendanceTimezoneLegacyRepairV1(db.pool, approved)).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ALREADY_APPLIED')
    expect(db.sql.filter(sql => sql.includes('INSERT INTO')).length).toBe(1)
    const applySql = db.sql.slice(db.sql.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED'))
    expect(applySql[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED')
    expect(applySql[1]).toBe("SET LOCAL TIME ZONE 'UTC'")
    const rolloutIndex = applySql.findIndex(sql => sql.includes('pg_advisory_xact_lock_shared($1::bigint)'))
    const runtimeIndex = applySql.findIndex(sql => sql.includes('pg_advisory_xact_lock(hashtextextended'))
    const recordIndex = applySql.findIndex(sql => sql.includes('FOR UPDATE OF r'))
    for (const index of [rolloutIndex, runtimeIndex, recordIndex]) expect(index).toBeGreaterThanOrEqual(0)
    expect(rolloutIndex).toBeLessThan(runtimeIndex)
    expect(runtimeIndex).toBeLessThan(recordIndex)
  })

  it.each(['shadow', 'eligible', 'authoritative', 'suspended'])('refuses persisted %s independently of environment capability', async state => {
    const db = database(); db.posture([{ state, scope: 'synthetic_staging' }])
    await expect(previewAttendanceTimezoneLegacyRepairV1(db.pool, input())).rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_POSTURE_UNSUPPORTED' })
    expect(db.sql.at(-1)).toBe('ROLLBACK')
  })

  it('rejects a changed original row before append, stale plan approval, and another reviewed source', async () => {
    const db = database()
    const preview = await previewAttendanceTimezoneLegacyRepairV1(db.pool, input())
    const approved = { ...input(), approvedSourceSha256: preview.sourceSha256, approvedPlanSha256: preview.planSha256 }
    await expect(applyAttendanceTimezoneLegacyRepairV1(db.pool, { ...approved, approvedPlanSha256: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_APPROVAL_MISMATCH' })
    db.record.meta.severe_late_minutes = 2
    await expect(applyAttendanceTimezoneLegacyRepairV1(db.pool, approved)).rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_RECORD_CHANGED' })
    db.record.meta.severe_late_minutes = 0
    await applyAttendanceTimezoneLegacyRepairV1(db.pool, approved)
    const another = evidence(); another.archive.reference = 'another-reviewed-file'
    await expect(previewAttendanceTimezoneLegacyRepairV1(db.pool, input(another))).rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_COMPANION_CONFLICT' })
  })

  it('requires an active org-member administrator and matching manual archive reviewer', async () => {
    const db = database(); db.admin(false)
    await expect(previewAttendanceTimezoneLegacyRepairV1(db.pool, input())).rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ACTOR_FORBIDDEN' })
    await expect(previewAttendanceTimezoneLegacyRepairV1(db.pool, { ...input(), actorId: 'other' }))
      .rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ARCHIVE_CONFIRMATION_REQUIRED' })
  })

  it('refuses a subject without current active org membership', async () => {
    const db = database(); db.member(false)
    await expect(previewAttendanceTimezoneLegacyRepairV1(db.pool, input()))
      .rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_MEMBER_REQUIRED' })
  })

  // Intentionally untyped mutants exercise invalid JSON outside the exported schema.
  it.each([
    (e: any) => { e.issued = {} },
    (e: any) => { delete e.rule.roundingMinutes },
    (e: any) => { e.rule.orgId = 'other-org' },
    (e: any) => { e.rule.absenceLateThresholdMinutes = 1 },
    (e: any) => { e.noWinningAssignment.attestation = 'guessed_from_empty_meta' },
    (e: any) => { e.calendar.holiday = { kind: 'unknown', isWorkingDay: true } },
    (e: any) => { e.attribution.tailMinutes = 361 },
  ])('rejects incomplete or unknown source facts', mutate => {
    const e = evidence(); mutate(e)
    expect(() => parseAttendanceLegacyRepairEvidenceV1(JSON.stringify(e))).toThrow('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_EVIDENCE_INVALID')
  })

  it('refuses active flex, nonempty overtime, and shift metadata instead of partially repairing', async () => {
    const flex = evidence(); flex.rule.flexMode = 'flex_required_duration'
    expect(() => parseAttendanceLegacyRepairEvidenceV1(JSON.stringify(flex))).toThrow('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_RULE_UNSUPPORTED')
    const overtime = JSON.parse(input().source); overtime.attribution.approvedOvertimeWindows = [{}]
    expect(() => parseAttendanceLegacyRepairEvidenceV1(JSON.stringify(overtime))).toThrow('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_OVERTIME_UNSUPPORTED')
    const db = database(); Object.assign(db.record.meta, { shiftId: 'old-shift' })
    const e = evidence(); e.expectedRecordFingerprint = attendanceLegacyRepairRecordFingerprintV1(db.record)
    await expect(previewAttendanceTimezoneLegacyRepairV1(db.pool, input(e))).rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_RECORD_UNSUPPORTED' })
  })

  it.each([['2026-03-08', '02:30'], ['2026-11-01', '01:30']])('refuses a DST gap/fold at %s %s', (date, time) => {
    const e = evidence(); e.workDate = date; e.timezone = e.rule.timezone = 'America/New_York'; e.rule.workStartTime = time
    e.calendar.isWorkingDay = false
    expect(() => buildAttendanceLegacyRepairFrameV1(parseAttendanceLegacyRepairEvidenceV1(JSON.stringify(e))))
      .toThrow('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_WALL_UNSUPPORTED')
  })
})
