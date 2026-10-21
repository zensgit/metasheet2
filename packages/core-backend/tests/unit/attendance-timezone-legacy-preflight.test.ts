import { describe, expect, it } from 'vitest'
import {
  attendanceLegacyRepairRecordFingerprintV1 as fingerprint,
  buildAttendanceLegacyRepairFrameV1,
  inspectAttendanceTimezoneLegacyRepairV1,
} from '../../src/attendance/attendance-timezone-legacy-repair'
import type { AttendanceLegacyRepairEvidenceV1 } from '../../src/attendance/attendance-timezone-legacy-repair'

const orgId = '00000000-0000-4000-8000-000000006395'
// Intentionally models the pg/jsonb boundary, including damaged JSON mutants.
type Row = Record<string, any>
function record(id = '00000000-0000-4000-8000-000000000001'): Row {
  return { scan_id: id, record_id: id, user_id: 'employee', work_date: '2026-10-14', timezone: 'Asia/Shanghai',
    current_calculation_id: null, projection_owner: 'legacy_untracked', meta: {}, first_in_at: '2026-10-14T01:00:00Z', last_out_at: null,
    companion: null, calculation_attribution_posture: null }
}
function withCompanion(row = record()): Row {
  const originalRecord = { id: row.record_id, org_id: orgId, user_id: row.user_id, work_date: row.work_date, timezone: row.timezone }
  const evidence: AttendanceLegacyRepairEvidenceV1 = {
    schemaVersion: 1, kind: 'archived_legacy_rule_context', orgId, recordId: row.record_id, userId: row.user_id,
    workDate: row.work_date, timezone: row.timezone, expectedRecordFingerprint: fingerprint(originalRecord),
    archive: { reference: 'synthetic-private-archive', capturedAt: '2026-10-14T01:00:00Z', reviewedBy: 'admin', attestation: 'historical_source_reviewed' },
    rule: { id: null, orgId, timezone: row.timezone, workStartTime: '09:00', workEndTime: '18:00', isOvernight: false,
      workingDays: [1, 2, 3, 4, 5], lateGraceMinutes: 5, earlyGraceMinutes: 3, roundingMinutes: 15,
      severeLateThresholdMinutes: 30, absenceLateThresholdMinutes: 120, flexMode: null,
      flexRequiredMinutes: null, flexArrivalWindowBeforeMinutes: null, flexArrivalWindowAfterMinutes: null,
      flexCoreStartTime: null, flexCoreEndTime: null }, calendar: { isWorkingDay: true, holiday: null },
    noWinningAssignment: { reasonCode: 'UNSCHEDULED_NO_SHIFT', attestation: 'no_winning_assignment_at_original_record_freeze' },
    attribution: { tailMinutes: 120, approvedOvertimeWindows: [], attestation: 'complete_historical_tail_and_approved_overtime' },
    absoluteWindow: { startAt: '2026-10-14T01:00:00Z', endAt: '2026-10-14T10:00:00Z' },
    attributionWindow: { startAt: '2026-10-14T01:00:00Z', endAt: '2026-10-14T12:00:00Z' },
  }
  const frame = JSON.parse(JSON.stringify(buildAttendanceLegacyRepairFrameV1(evidence)))
  const sourceSha256 = '0'.repeat(64)
  const planSha256 = fingerprint({ schemaVersion: 1, sourceSha256, actorId: 'admin', expectedRecordFingerprint: evidence.expectedRecordFingerprint, frame })
  const original = { kind: evidence.kind, repair: { sourceSha256, planSha256, actorId: 'admin' },
    originalRecord, expectedRecordFingerprint: evidence.expectedRecordFingerprint, evidence }
  row.companion = { schema_version: 1, record_id: row.record_id, org_id: orgId, user_id: row.user_id, work_date: row.work_date,
    timezone: row.timezone, frame_snapshot: frame, context_fingerprint: frame.fingerprint,
    original_freeze_snapshot: original, original_freeze_fingerprint: fingerprint(original),
    absolute_start_at: frame.absoluteWindow.startAt, absolute_end_at: frame.absoluteWindow.endAt,
    attribution_start_at: frame.attributionWindow.startAt, attribution_end_at: frame.attributionWindow.endAt }
  return row
}
function database() {
  const sql: string[] = []
  const db = { records: [] as Row[], requests: [] as Row[], defaults: [{ timezone: 'Asia/Shanghai' }] as Row[],
    rollout: [] as Row[], policy: [] as Row[], actorAllowed: true, sql,
    pool: { async connect() { return { release() {}, async query(query: string, args: unknown[] = []) {
      sql.push(query)
      if (query.includes('JOIN user_roles')) return { rows: db.actorAllowed ? [{ id: 'admin' }] : [] }
      if (query.includes('FROM attendance_rules')) return { rows: db.defaults }
      if (query.includes('FROM attendance_calculation_rollout_state')) return { rows: db.rollout }
      if (query.includes('FROM attendance_timezone_policies')) return { rows: db.policy }
      const rows = query.includes('FROM attendance_records r') ? db.records : query.includes('FROM attendance_requests req') ? db.requests : []
      return { rows: rows.filter(row => args[1] === null || row.scan_id > args[1]).slice(0, Number(args[2])) }
    } } } } }
  return db
}
const inspect = (db: ReturnType<typeof database>) => inspectAttendanceTimezoneLegacyRepairV1(db.pool, { orgId, actorId: 'admin' })

describe('org-wide historical timezone upgrade preflight', () => {
  it('is read-only, names only counts, and returns READY for a fully scanned empty org', async () => {
    const db = database()
    const result = await inspect(db)
    expect(result).toEqual({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_READY', scanComplete: true, counts: {
      defaultRules: 1, missingDefaultRules: 0, multipleDefaultRules: 0, invalidDefaultTimezones: 0,
      recordsScanned: 0, ordinaryLegacyRecordsWithoutCompanion: 0, openOrdinaryLegacyRecordsWithoutCompanion: 0,
      unsupportedLegacyRecordsWithoutCompanion: 0, writableNowLegacyRecordsWithoutCompanion: 0, v2CandidatesRequireValidation: 0, invalidCompanions: 0, companionCandidatesRequireValidation: 0,
      legacyRepairPostureBlocked: 0, pendingRelatedRequestsScanned: 0, pendingRequestsWithoutUsableContext: 0,
      pendingRequestsRequireValidation: 0,
      tokenCandidatesRequireValidation: 0, overtimeCandidatesRequireValidation: 0,
    } })
    expect(db.sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(db.sql).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(db.sql).toContain("SET LOCAL statement_timeout = '10000ms'")
    expect(db.sql.some(sql => /\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false)
    expect(db.sql.at(-1)).toBe('COMMIT')
    expect(JSON.stringify(result)).not.toContain(orgId)
    expect(JSON.stringify(result)).not.toContain('Asia/Shanghai')
  })

  it.each([[], [{ timezone: 'Asia/Shanghai' }, { timezone: 'UTC' }], [{ timezone: 'bad/timezone' }]].map(defaults => [defaults]))('blocks missing/duplicate/invalid default timezones', async defaults => {
    const db = database(); db.defaults = defaults
    expect((await inspect(db)).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
  })

  it('counts unbound other-zone ordinary open records and their pending related requests as blockers', async () => {
    const db = database(); db.records = [{ ...record(), timezone: 'UTC' }]; db.requests = [{ ...record(), metadata: {} }]
    const result = await inspect(db)
    expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
    expect(result.counts.ordinaryLegacyRecordsWithoutCompanion).toBe(1)
    expect(result.counts.openOrdinaryLegacyRecordsWithoutCompanion).toBe(1)
    expect(result.counts.pendingRequestsWithoutUsableContext).toBe(1)
  })

  describe('same-zone untracked records are writable now, not blockers (compatibility amendment 2)', () => {
    const recordIn = (timezone: string, id = '00000000-0000-4000-8000-000000000001'): Row => ({ ...record(id), timezone })
    it('splits a same-zone untracked record out of BLOCKED and reports the exact counts', async () => {
      const db = database(); db.records = [recordIn('Asia/Shanghai')]
      const result = await inspect(db)
      expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_READY')
      expect(result.counts).toMatchObject({
        recordsScanned: 1, ordinaryLegacyRecordsWithoutCompanion: 1, openOrdinaryLegacyRecordsWithoutCompanion: 1,
        unsupportedLegacyRecordsWithoutCompanion: 0, writableNowLegacyRecordsWithoutCompanion: 1,
      })
    })
    it('counts an unsupported-shape untracked same-zone record as writable now too (admission looks only at tracking and zone)', async () => {
      const db = database(); db.records = [{ ...recordIn('Asia/Shanghai'), projection_owner: 'something_else' }]
      const result = await inspect(db)
      expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_READY')
      expect(result.counts).toMatchObject({
        ordinaryLegacyRecordsWithoutCompanion: 0, unsupportedLegacyRecordsWithoutCompanion: 1, writableNowLegacyRecordsWithoutCompanion: 1,
      })
    })
    it('keeps a different-zone record blocked while still counting the same-zone one as writable', async () => {
      const db = database()
      db.records = [recordIn('Asia/Shanghai', '00000000-0000-4000-8000-000000000001'), recordIn('UTC', '00000000-0000-4000-8000-000000000002')]
      const result = await inspect(db)
      expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
      expect(result.counts).toMatchObject({ ordinaryLegacyRecordsWithoutCompanion: 2, writableNowLegacyRecordsWithoutCompanion: 1 })
    })
    it.each([
      ['multi-timezone on', (db: ReturnType<typeof database>) => { db.policy = [{ enabled: true }] }],
      ['an ambiguous policy read', (db: ReturnType<typeof database>) => { db.policy = [{ enabled: false }, { enabled: false }] }],
      ['shadow posture', (db: ReturnType<typeof database>) => { db.rollout = [{ state: 'shadow', scope: 'synthetic_staging' }] }],
      ['authoritative posture', (db: ReturnType<typeof database>) => { db.rollout = [{ state: 'authoritative', scope: 'synthetic_staging' }] }],
      ['multiple default rules', (db: ReturnType<typeof database>) => { db.defaults = [{ timezone: 'Asia/Shanghai' }, { timezone: 'Asia/Shanghai' }] }],
      ['an invalid default zone', (db: ReturnType<typeof database>) => { db.defaults = [{ timezone: 'bad/timezone' }]; db.records = [recordIn('bad/timezone')] }],
      ['a missing default rule', (db: ReturnType<typeof database>) => { db.defaults = [] }],
    ])('keeps the record blocked under %s', async (_label, mutate) => {
      const db = database(); db.records = [recordIn('Asia/Shanghai')]; mutate(db)
      const result = await inspect(db)
      expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
      expect(result.counts.writableNowLegacyRecordsWithoutCompanion).toBe(0)
      expect(result.counts.ordinaryLegacyRecordsWithoutCompanion).toBe(1)
    })
    it('never counts a calculation-tracked record or a record with a companion', async () => {
      const db = database()
      db.records = [{ ...recordIn('Asia/Shanghai', '00000000-0000-4000-8000-000000000001'), current_calculation_id: 'calc', calculation_attribution_posture: 'other' },
        withCompanion(recordIn('Asia/Shanghai', '00000000-0000-4000-8000-000000000002'))]
      const result = await inspect(db)
      expect(result.counts.writableNowLegacyRecordsWithoutCompanion).toBe(0)
      expect(result.counts.unsupportedLegacyRecordsWithoutCompanion).toBe(1)
      expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
    })
    it('treats an explicit multi-timezone-off policy row like no policy row', async () => {
      const db = database(); db.records = [recordIn('Asia/Shanghai')]; db.policy = [{ enabled: false }]
      expect((await inspect(db)).counts.writableNowLegacyRecordsWithoutCompanion).toBe(1)
    })
    it('still blocks on pending requests for such a date (unchanged)', async () => {
      const db = database(); db.records = [recordIn('Asia/Shanghai')]; db.requests = [{ ...recordIn('Asia/Shanghai'), metadata: {} }]
      const result = await inspect(db)
      expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
      expect(result.counts.pendingRequestsWithoutUsableContext).toBe(1)
    })
  })

  it('never treats an unresolved V2 SQL label or existing request token as validated', async () => {
    const db = database(); db.records = [{ ...record(), current_calculation_id: 'calc', calculation_attribution_posture: 'resolved_v2' }]
    db.requests = [{ ...record(), metadata: { timezoneContextV1: { forged: true } } }]
    const result = await inspect(db)
    expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_REVIEW_REQUIRED')
    expect(result.counts.v2CandidatesRequireValidation).toBe(1)
    expect(result.counts.tokenCandidatesRequireValidation).toBe(1)
  })

  it('accepts a hash-bound repair companion only while persisted posture remains legacy', async () => {
    const db = database(); db.records = [withCompanion()]
    expect((await inspect(db)).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_READY')
    db.requests = [{ ...withCompanion(), request_type: 'leave', metadata: {}, requested_in_at: '2026-10-14T01:00:00Z', requested_out_at: '2026-10-16T01:00:00Z' }]
    const pending = await inspect(db)
    expect(pending.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_REVIEW_REQUIRED')
    expect(pending.counts.pendingRequestsWithoutUsableContext).toBe(0)
    expect(pending.counts.pendingRequestsRequireValidation).toBe(1)
    db.rollout = [{ state: 'authoritative', scope: 'synthetic_staging' }]
    const result = await inspect(db)
    expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
    expect(result.counts.legacyRepairPostureBlocked).toBe(1)
    expect(result.counts.pendingRequestsWithoutUsableContext).toBe(1)
  })

  it('marks other companion types for strict runtime review, including issued-context corruption', async () => {
    const db = database(); const row = withCompanion()
    row.companion.frame_snapshot.identity.source = 'frozen_v2'
    row.companion.frame_snapshot.identity.calculationDefinition = { unvalidated: true }
    row.companion.frame_snapshot.fingerprint = row.companion.context_fingerprint = fingerprint(row.companion.frame_snapshot.identity)
    row.companion.frame_snapshot.issued = { context: { corrupted: true } }
    db.records = [row]
    const result = await inspect(db)
    expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_REVIEW_REQUIRED')
    expect(result.counts.companionCandidatesRequireValidation).toBe(1)
  })

  it.each([
    (row: Row) => { row.companion.frame_snapshot.identity.timezone = 'UTC' },
    (row: Row) => { row.companion.original_freeze_snapshot.recordId = 'other' },
    (row: Row) => { row.companion.attribution_end_at = '2026-10-14T11:00:00Z' },
    (row: Row) => { row.companion.frame_snapshot.context.rule.workStartTime = 'bad' },
  ])('blocks damaged companion binding and unavailable pending authority', async mutate => {
    const db = database(); const row = withCompanion(); mutate(row)
    db.records = [row]; db.requests = [{ ...row, metadata: {} }]
    const result = await inspect(db)
    expect(result.counts.invalidCompanions).toBe(1)
    expect(result.counts.pendingRequestsWithoutUsableContext).toBe(1)
    expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
  })

  it('uses keyset pages and does not report READY when the hard scan limit truncates data', async () => {
    const db = database()
    const row = record()
    db.records = Array.from({ length: 100_001 }, (_, index) => {
      const id = '00000000-0000-4000-8000-' + String(index).padStart(12, '0')
      return { ...row, scan_id: id, record_id: id }
    })
    const result = await inspect(db)
    expect(result.scanComplete).toBe(false)
    expect(result.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_SCAN_INCOMPLETE')
    expect(result.counts.recordsScanned).toBe(100_000)
    expect(db.sql.filter(sql => sql.includes('FROM attendance_records r')).length).toBeGreaterThan(1)
  })

  it('requires an active same-org administrator before scanning business rows', async () => {
    const db = database(); db.actorAllowed = false
    await expect(inspect(db)).rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ACTOR_FORBIDDEN' })
    expect(db.sql.some(sql => sql.includes('FROM attendance_records r'))).toBe(false)
    expect(db.sql.at(-1)).toBe('ROLLBACK')
  })
})
