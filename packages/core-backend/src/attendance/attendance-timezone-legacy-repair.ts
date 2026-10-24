import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isAttendanceCalendarDateKeyV1, isAttendanceWallTimeHHMMV1,
  parseAttendanceInstantMsV1, resolveAttendanceLocalWallTimeV1,
  validateAttendanceIanaTimezoneV1,
} from './w4c1-strict-time'
import { acquireAttendanceTimezoneRuntimeLocksV1 } from './attendance-timezone-runtime-locks'
import { acquireAttendanceCalculationRolloutLock, parseCanonicalAttendanceRolloutOrgKeyV1 } from './w4c0-identity'

const runtimePath = [
  resolve(__dirname, '../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs'),
  resolve(__dirname, '../../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs'),
].find(existsSync)
const { canonicalContextFingerprint, canonicalRuleProfile } = require(runtimePath!) as {
  canonicalContextFingerprint(value: unknown): string
  canonicalRuleProfile(value: ArchivedLegacyRuleV1): Record<string, unknown>
}

export const ATTENDANCE_LEGACY_REPAIR_MAX_SOURCE_BYTES_V1 = 64 * 1024
const PREFIX = 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_'
export class AttendanceLegacyRepairError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}
function fail(suffix: string): never { throw new AttendanceLegacyRepairError(PREFIX + suffix) }

export interface ArchivedLegacyRuleV1 {
  id: string | null
  orgId: string
  timezone: string
  workStartTime: string
  workEndTime: string
  isOvernight: boolean
  workingDays: number[]
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  severeLateThresholdMinutes: number
  absenceLateThresholdMinutes: number
  flexMode: null | 'strict' | 'flex_required_duration'
  flexRequiredMinutes: number | null
  flexArrivalWindowBeforeMinutes: number | null
  flexArrivalWindowAfterMinutes: number | null
  flexCoreStartTime: string | null
  flexCoreEndTime: string | null
}
export interface AttendanceLegacyRepairEvidenceV1 {
  schemaVersion: 1
  kind: 'archived_legacy_rule_context'
  orgId: string
  userId: string
  recordId: string
  workDate: string
  timezone: string
  expectedRecordFingerprint: string
  archive: { reference: string; capturedAt: string; reviewedBy: string; attestation: 'historical_source_reviewed' }
  rule: ArchivedLegacyRuleV1
  calendar: { isWorkingDay: boolean; holiday: null | { kind: 'holiday' | 'workday'; isWorkingDay: boolean } }
  noWinningAssignment: { reasonCode: 'UNSCHEDULED_NO_SHIFT'; attestation: 'no_winning_assignment_at_original_record_freeze' }
  attribution: { tailMinutes: number; approvedOvertimeWindows: []; attestation: 'complete_historical_tail_and_approved_overtime' }
  absoluteWindow: { startAt: string; endAt: string }
  attributionWindow: { startAt: string; endAt: string }
}
export interface AttendanceLegacyRepairClientV1 {
  // DB/JSON boundary is validated below before use; PostgreSQL jsonb has no static row shape.
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>
  release(): void
}
export interface AttendanceLegacyRepairPoolV1 { connect(): Promise<AttendanceLegacyRepairClientV1> }
export interface AttendanceLegacyRepairInputV1 {
  source: Buffer | string
  actorId: string
  archiveSourceConfirmed: true
}
export interface AttendanceLegacyRepairResultV1 {
  code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREVIEW_READY' | 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_APPLIED' | 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ALREADY_APPLIED'
  count: 1
  sourceSha256: string
  planSha256: string
  contextFingerprint: string
}

// Until every scalar passes its closed validator, archive JSON is an untyped boundary.
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail('EVIDENCE_INVALID')
  return value as Record<string, any>
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f]/.test(value)
}
function minutes(value: unknown): boolean { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1440 }
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function ordinaryLegacyMeta(value: unknown): boolean {
  const keys = new Set(['severe_late_count', 'severe_late_minutes', 'absence_late_count'])
  return value === null || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => keys.has(key)
      && typeof item === 'number' && Number.isFinite(item) && item >= 0
      && (!key.endsWith('_count') || Number.isSafeInteger(item))))
}

/** All source facts are reviewed archive assertions, never inferred from today's rule. */
export function parseAttendanceLegacyRepairEvidenceV1(source: Buffer | string): AttendanceLegacyRepairEvidenceV1 {
  try {
    if (!(typeof source === 'string' || Buffer.isBuffer(source)) || Buffer.byteLength(source) > ATTENDANCE_LEGACY_REPAIR_MAX_SOURCE_BYTES_V1) fail('EVIDENCE_INVALID')
    const e = object(JSON.parse(source.toString()), ['schemaVersion', 'kind', 'orgId', 'userId', 'recordId', 'workDate', 'timezone', 'expectedRecordFingerprint', 'archive', 'rule', 'calendar', 'noWinningAssignment', 'attribution', 'absoluteWindow', 'attributionWindow'])
    if (e.schemaVersion !== 1 || e.kind !== 'archived_legacy_rule_context'
      || ![e.orgId, e.userId, e.recordId].every(text) || !sha(e.expectedRecordFingerprint)
      || !isAttendanceCalendarDateKeyV1(e.workDate)) fail('EVIDENCE_INVALID')
    if (parseCanonicalAttendanceRolloutOrgKeyV1(e.orgId) !== e.orgId) fail('EVIDENCE_INVALID')
    validateAttendanceIanaTimezoneV1(e.timezone)
    const archive = object(e.archive, ['reference', 'capturedAt', 'reviewedBy', 'attestation'])
    if (![archive.reference, archive.reviewedBy].every(text) || archive.attestation !== 'historical_source_reviewed') fail('EVIDENCE_INVALID')
    parseAttendanceInstantMsV1(archive.capturedAt)
    const rule = object(e.rule, ['id', 'orgId', 'timezone', 'workStartTime', 'workEndTime', 'isOvernight', 'workingDays', 'lateGraceMinutes', 'earlyGraceMinutes', 'roundingMinutes', 'severeLateThresholdMinutes', 'absenceLateThresholdMinutes', 'flexMode', 'flexRequiredMinutes', 'flexArrivalWindowBeforeMinutes', 'flexArrivalWindowAfterMinutes', 'flexCoreStartTime', 'flexCoreEndTime'])
    if ((rule.id !== null && !text(rule.id)) || rule.orgId !== e.orgId || rule.timezone !== e.timezone
      || typeof rule.isOvernight !== 'boolean' || !isAttendanceWallTimeHHMMV1(rule.workStartTime)
      || !isAttendanceWallTimeHHMMV1(rule.workEndTime) || !Array.isArray(rule.workingDays)
      || rule.workingDays.length > 7 || new Set(rule.workingDays).size !== rule.workingDays.length
      || !rule.workingDays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
      || !['lateGraceMinutes', 'earlyGraceMinutes', 'roundingMinutes', 'severeLateThresholdMinutes', 'absenceLateThresholdMinutes'].every(key => minutes(rule[key]))
      || ![null, 'strict', 'flex_required_duration'].includes(rule.flexMode)
      || !['flexRequiredMinutes', 'flexArrivalWindowBeforeMinutes', 'flexArrivalWindowAfterMinutes'].every(key => rule[key] === null || minutes(rule[key]))
      || !['flexCoreStartTime', 'flexCoreEndTime'].every(key => rule[key] === null || isAttendanceWallTimeHHMMV1(rule[key]))) fail('EVIDENCE_INVALID')
    if (!(rule.absenceLateThresholdMinutes >= rule.severeLateThresholdMinutes
      && rule.severeLateThresholdMinutes >= rule.lateGraceMinutes)) fail('EVIDENCE_INVALID')
    if (rule.flexMode === 'flex_required_duration') fail('RULE_UNSUPPORTED')
    const calendar = object(e.calendar, ['isWorkingDay', 'holiday'])
    if (typeof calendar.isWorkingDay !== 'boolean') fail('EVIDENCE_INVALID')
    if (calendar.holiday !== null) {
      const holiday = object(calendar.holiday, ['kind', 'isWorkingDay'])
      if (!['holiday', 'workday'].includes(holiday.kind) || typeof holiday.isWorkingDay !== 'boolean'
        || holiday.isWorkingDay !== calendar.isWorkingDay || (holiday.kind === 'workday') !== holiday.isWorkingDay) fail('EVIDENCE_INVALID')
    } else if (calendar.isWorkingDay !== rule.workingDays.includes(new Date(e.workDate + 'T00:00:00Z').getUTCDay())) fail('EVIDENCE_INVALID')
    const absent = object(e.noWinningAssignment, ['reasonCode', 'attestation'])
    if (absent.reasonCode !== 'UNSCHEDULED_NO_SHIFT' || absent.attestation !== 'no_winning_assignment_at_original_record_freeze') fail('EVIDENCE_INVALID')
    const attribution = object(e.attribution, ['tailMinutes', 'approvedOvertimeWindows', 'attestation'])
    if (!minutes(attribution.tailMinutes) || attribution.tailMinutes > 360 || !Array.isArray(attribution.approvedOvertimeWindows)
      || attribution.attestation !== 'complete_historical_tail_and_approved_overtime') fail('EVIDENCE_INVALID')
    if (attribution.approvedOvertimeWindows.length) fail('OVERTIME_UNSUPPORTED')
    for (const key of ['absoluteWindow', 'attributionWindow']) {
      const window = object(e[key], ['startAt', 'endAt'])
      parseAttendanceInstantMsV1(window.startAt); parseAttendanceInstantMsV1(window.endAt)
    }
    return e as AttendanceLegacyRepairEvidenceV1
  } catch (error) {
    if (error instanceof AttendanceLegacyRepairError) throw error
    fail('EVIDENCE_INVALID')
  }
}

export function attendanceLegacyRepairRecordFingerprintV1(row: unknown): string { return canonicalContextFingerprint(row) }

export function buildAttendanceLegacyRepairFrameV1(e: AttendanceLegacyRepairEvidenceV1) {
  const start = resolveAttendanceLocalWallTimeV1(e.workDate, e.rule.workStartTime, 0, e.timezone)
  const end = resolveAttendanceLocalWallTimeV1(e.workDate, e.rule.workEndTime, e.rule.isOvernight ? 1 : 0, e.timezone)
  if (start.posture !== 'unique' || end.posture !== 'unique') fail('WALL_UNSUPPORTED')
  if (end.epochMs <= start.epochMs || end.epochMs - start.epochMs > 24 * 3600_000) fail('WINDOW_INVALID')
  const absoluteWindow = { startAt: new Date(start.epochMs), endAt: new Date(end.epochMs) }
  const attributionWindow = { startAt: absoluteWindow.startAt, endAt: new Date(end.epochMs + e.attribution.tailMinutes * 60_000) }
  for (const [key, expected] of Object.entries({ absoluteWindow, attributionWindow })) {
    if (parseAttendanceInstantMsV1(e[key].startAt) !== expected.startAt.getTime()
      || parseAttendanceInstantMsV1(e[key].endAt) !== expected.endAt.getTime()) fail('WINDOW_INVALID')
  }
  const rule = canonicalRuleProfile(e.rule)
  const calculationDefinition = { kind: 'rule', isWorkday: e.calendar.isWorkingDay, holidayKind: e.calendar.holiday?.kind ?? null, rule }
  const identity = { workDate: e.workDate, shiftId: null, assignmentId: null, source: 'legacy_repair',
    originalRecordId: e.recordId, startAt: absoluteWindow.startAt.toISOString(), endAt: absoluteWindow.endAt.toISOString(),
    timezone: e.timezone, timezoneContext: null, rule, calculationDefinition }
  return {
    orgId: e.orgId, userId: e.userId, workDate: e.workDate, timezone: e.timezone, timezoneContext: null,
    context: { rule: e.rule, isWorkingDay: e.calendar.isWorkingDay, holiday: e.calendar.holiday,
      source: 'legacy_repair', assignment: null, rotation: null, rotationAssignment: null },
    resolution: { kind: 'unresolved', reasonCode: 'UNSCHEDULED_NO_SHIFT', workDate: e.workDate,
      attributionTailMinutes: e.attribution.tailMinutes, approvedOvertimeWindows: [] },
    identity, absoluteWindow, attributionWindow, fingerprint: canonicalContextFingerprint(identity),
    legacyRecordId: e.recordId, legacyFrozenCalculationId: null,
  }
}

async function runRepair(pool: AttendanceLegacyRepairPoolV1, input: AttendanceLegacyRepairInputV1,
  approval?: { approvedSourceSha256: string; approvedPlanSha256: string }): Promise<AttendanceLegacyRepairResultV1> {
  const e = parseAttendanceLegacyRepairEvidenceV1(input.source)
  if (input.archiveSourceConfirmed !== true || !text(input.actorId) || input.actorId !== e.archive.reviewedBy) fail('ARCHIVE_CONFIRMATION_REQUIRED')
  const frame = buildAttendanceLegacyRepairFrameV1(e)
  const sourceSha256 = createHash('sha256').update(input.source).digest('hex')
  const planSha256 = canonicalContextFingerprint({ schemaVersion: 1, sourceSha256, actorId: input.actorId,
    expectedRecordFingerprint: e.expectedRecordFingerprint, frame })
  if (approval && (!sha(approval.approvedSourceSha256) || !sha(approval.approvedPlanSha256)
    || approval.approvedSourceSha256 !== sourceSha256 || approval.approvedPlanSha256 !== planSha256)) fail('APPROVAL_MISMATCH')
  const result = { count: 1 as const, sourceSha256, planSha256, contextFingerprint: frame.fingerprint }
  let client: AttendanceLegacyRepairClientV1
  try { client = await pool.connect() } catch { fail('SOURCE_UNAVAILABLE') }
  try {
    await client.query(approval ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    // The reviewed to_jsonb(record) digest must be taken under the same UTC session setting.
    await client.query("SET LOCAL TIME ZONE 'UTC'")
    if (approval) {
      // Existing live/request order: class-00 rollout before timezone policy/facts.
      // Covers an absent rollout row as well as a concurrent promotion.
      await acquireAttendanceCalculationRolloutLock(client, parseCanonicalAttendanceRolloutOrgKeyV1(e.orgId), 'shared')
      await acquireAttendanceTimezoneRuntimeLocksV1(client, { orgId: e.orgId, userId: e.userId, mode: 'exclusive' })
    }
    const admin = await client.query(`SELECT u.id FROM users u
      JOIN user_orgs m ON m.user_id=u.id AND m.org_id=$2
      JOIN user_roles ur ON ur.user_id=u.id AND ur.role_id='admin'
      WHERE u.id=$1 AND COALESCE(u.is_active,TRUE)=TRUE
        AND COALESCE(u.activation_status,'activated')='activated' AND COALESCE(m.is_active,TRUE)=TRUE
      ${approval ? 'FOR SHARE OF u,m,ur' : ''}`, [input.actorId, e.orgId])
    if (admin.rows.length !== 1) fail('ACTOR_FORBIDDEN')
    const subject = await client.query(`SELECT u.id FROM users u
      JOIN user_orgs m ON m.user_id=u.id AND m.org_id=$2
      WHERE u.id=$1 AND COALESCE(u.is_active,TRUE)=TRUE
        AND COALESCE(u.activation_status,'activated')='activated' AND COALESCE(m.is_active,TRUE)=TRUE
      ${approval ? 'FOR SHARE OF u,m' : ''}`, [e.userId, e.orgId])
    if (subject.rows.length !== 1) fail('MEMBER_REQUIRED')
    const posture = await client.query('SELECT state,scope FROM attendance_calculation_rollout_state WHERE org_id=$1', [e.orgId])
    if (posture.rows.length > 1 || posture.rows.some(row => row.state !== 'legacy' || row.scope !== 'synthetic_staging')) fail('POSTURE_UNSUPPORTED')
    const existing = await client.query(`SELECT c.*,c.work_date::text AS repair_work_date FROM attendance_timezone_context_companions c
      WHERE org_id=$1 AND (record_id=$2 OR (user_id=$3 AND work_date=$4::date))`, [e.orgId, e.recordId, e.userId, e.workDate])
    if (existing.rows.length) {
      const row = existing.rows[0]
      const snapshot = row.original_freeze_snapshot
      const savedFrame = row.frame_snapshot
      if (existing.rows.length !== 1 || row.record_id !== e.recordId || row.user_id !== e.userId
        || row.org_id !== e.orgId || row.repair_work_date !== e.workDate || row.timezone !== e.timezone
        || snapshot?.kind !== e.kind || snapshot?.repair?.sourceSha256 !== sourceSha256
        || snapshot?.repair?.planSha256 !== planSha256 || row.context_fingerprint !== frame.fingerprint
        || canonicalContextFingerprint(snapshot) !== row.original_freeze_fingerprint
        || canonicalContextFingerprint(savedFrame) !== canonicalContextFingerprint(frame)) fail('COMPANION_CONFLICT')
      await client.query('COMMIT')
      return { ...result, code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ALREADY_APPLIED' }
    }
    const records = await client.query(`SELECT to_jsonb(r) AS original_record FROM attendance_records r
      WHERE r.id=$1 AND r.org_id=$2 AND r.user_id=$3 AND r.work_date=$4::date ${approval ? 'FOR UPDATE OF r' : ''}`,
    [e.recordId, e.orgId, e.userId, e.workDate])
    if (records.rows.length !== 1) fail('RECORD_NOT_FOUND')
    const record = records.rows[0].original_record
    if (attendanceLegacyRepairRecordFingerprintV1(record) !== e.expectedRecordFingerprint) fail('RECORD_CHANGED')
    if (record.visibility_state !== 'active' || record.projection_owner !== 'legacy_untracked'
      || record.current_calculation_id !== null || record.timezone !== e.timezone
      || record.is_workday !== e.calendar.isWorkingDay
      || !ordinaryLegacyMeta(record.meta)) fail('RECORD_UNSUPPORTED')
    if (approval) {
      const originalFreeze = { kind: e.kind, repair: { sourceSha256, planSha256, actorId: input.actorId },
        expectedRecordFingerprint: e.expectedRecordFingerprint, originalRecord: record, evidence: e }
      await client.query(`INSERT INTO attendance_timezone_context_companions
        (record_id,org_id,user_id,work_date,timezone,absolute_start_at,absolute_end_at,
         attribution_start_at,attribution_end_at,context_fingerprint,original_freeze_fingerprint,
         original_calculation_id,frame_snapshot,original_freeze_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12::jsonb,$13::jsonb)`,
      [e.recordId, e.orgId, e.userId, e.workDate, e.timezone, frame.absoluteWindow.startAt, frame.absoluteWindow.endAt,
        frame.attributionWindow.startAt, frame.attributionWindow.endAt, frame.fingerprint,
        canonicalContextFingerprint(originalFreeze), JSON.stringify(frame), JSON.stringify(originalFreeze)])
    }
    await client.query('COMMIT')
    return { ...result, code: approval ? 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_APPLIED' : 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREVIEW_READY' }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof AttendanceLegacyRepairError) throw error
    fail('SOURCE_UNAVAILABLE')
  } finally { client.release() }
}

export function previewAttendanceTimezoneLegacyRepairV1(pool: AttendanceLegacyRepairPoolV1, input: AttendanceLegacyRepairInputV1) {
  return runRepair(pool, input)
}
export function applyAttendanceTimezoneLegacyRepairV1(pool: AttendanceLegacyRepairPoolV1,
  input: AttendanceLegacyRepairInputV1 & { approvedSourceSha256: string; approvedPlanSha256: string }) {
  return runRepair(pool, input, input)
}

export interface AttendanceLegacyPreflightCountsV1 {
  defaultRules: number
  missingDefaultRules: number
  multipleDefaultRules: number
  invalidDefaultTimezones: number
  recordsScanned: number
  ordinaryLegacyRecordsWithoutCompanion: number
  openOrdinaryLegacyRecordsWithoutCompanion: number
  unsupportedLegacyRecordsWithoutCompanion: number
  /**
   * Companion-less, calculation-untracked records whose zone equals the single valid default zone,
   * with multi-timezone off and legacy posture: writable now without repair (compatibility amendment 2).
   * A subset of ordinary + unsupported (those counts are unchanged); it is excluded from BLOCKED.
   */
  writableNowLegacyRecordsWithoutCompanion: number
  v2CandidatesRequireValidation: number
  invalidCompanions: number
  companionCandidatesRequireValidation: number
  legacyRepairPostureBlocked: number
  pendingRelatedRequestsScanned: number
  pendingRequestsWithoutUsableContext: number
  pendingRequestsRequireValidation: number
  tokenCandidatesRequireValidation: number
  overtimeCandidatesRequireValidation: number
}
export interface AttendanceLegacyPreflightResultV1 {
  code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_READY' | 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED'
    | 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_REVIEW_REQUIRED' | 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_SCAN_INCOMPLETE'
  scanComplete: boolean
  counts: AttendanceLegacyPreflightCountsV1
}

// Only companion facts needed for historical admission are scanned; no business
// values or identities leave this service. V2/token candidates require a separate
// strict runtime validation and are deliberately never counted as verified.
const PREFLIGHT_PAGE_SIZE = 500
const PREFLIGHT_MAX_ROWS = 100_000
const PREFLIGHT_BUDGET_MS = 30_000
function validPreflightCompanion(row: Record<string, any>, orgId: string): boolean {
  try {
    const c = row.companion
    const f = c?.frame_snapshot
    if (!c || !f || !f.identity || c.schema_version !== 1
      || c.org_id !== orgId || c.user_id !== row.user_id || c.record_id !== row.record_id
      || c.work_date !== row.work_date || f.orgId !== orgId || f.userId !== row.user_id
      || f.workDate !== row.work_date || f.timezone !== c.timezone || f.identity.timezone !== f.timezone
      || (row.timezone !== undefined && row.timezone !== f.timezone)
      || f.context?.rule?.timezone !== f.timezone || typeof f.context?.isWorkingDay !== 'boolean'
      || canonicalContextFingerprint(f.identity) !== f.fingerprint || f.fingerprint !== c.context_fingerprint
      || !c.original_freeze_snapshot || typeof c.original_freeze_snapshot !== 'object'
      || canonicalContextFingerprint(c.original_freeze_snapshot) !== c.original_freeze_fingerprint) return false
    validateAttendanceIanaTimezoneV1(f.timezone)
    const start = parseAttendanceInstantMsV1(f.absoluteWindow?.startAt)
    const end = parseAttendanceInstantMsV1(f.absoluteWindow?.endAt)
    const attrStart = parseAttendanceInstantMsV1(f.attributionWindow?.startAt)
    const attrEnd = parseAttendanceInstantMsV1(f.attributionWindow?.endAt)
    const validWindows = start < end && attrStart === start && attrEnd >= end
      && parseAttendanceInstantMsV1(c.absolute_start_at) === start && parseAttendanceInstantMsV1(c.absolute_end_at) === end
      && parseAttendanceInstantMsV1(c.attribution_start_at) === attrStart && parseAttendanceInstantMsV1(c.attribution_end_at) === attrEnd
    if (!validWindows) return false
    if (f.identity.source !== 'legacy_repair') return true // Caller marks unvalidated companions REVIEW_REQUIRED.
    const snapshot = c.original_freeze_snapshot
    const evidence = parseAttendanceLegacyRepairEvidenceV1(JSON.stringify(snapshot.evidence))
    const rebuilt = buildAttendanceLegacyRepairFrameV1(evidence)
    return snapshot.kind === 'archived_legacy_rule_context' && evidence.orgId === orgId
      && evidence.userId === row.user_id && evidence.recordId === row.record_id && evidence.workDate === row.work_date
      && snapshot.repair?.actorId === evidence.archive.reviewedBy && sha(snapshot.repair?.sourceSha256)
      && snapshot.expectedRecordFingerprint === evidence.expectedRecordFingerprint
      && canonicalContextFingerprint(snapshot.originalRecord) === evidence.expectedRecordFingerprint
      && canonicalContextFingerprint(f) === canonicalContextFingerprint(rebuilt)
      && snapshot.repair.planSha256 === canonicalContextFingerprint({ schemaVersion: 1,
        sourceSha256: snapshot.repair.sourceSha256, actorId: snapshot.repair.actorId,
        expectedRecordFingerprint: evidence.expectedRecordFingerprint, frame: rebuilt })
  } catch { return false }
}

/** Explicit org-wide read-only scan. READY describes this snapshot, never enables anything. */
export async function inspectAttendanceTimezoneLegacyRepairV1(pool: AttendanceLegacyRepairPoolV1,
  input: { orgId: string; actorId: string }): Promise<AttendanceLegacyPreflightResultV1> {
  try {
    if (!text(input.actorId) || parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId) !== input.orgId) fail('PREFLIGHT_ARGUMENT_INVALID')
  } catch { fail('PREFLIGHT_ARGUMENT_INVALID') }
  const counts: AttendanceLegacyPreflightCountsV1 = {
    defaultRules: 0, missingDefaultRules: 0, multipleDefaultRules: 0, invalidDefaultTimezones: 0,
    recordsScanned: 0, ordinaryLegacyRecordsWithoutCompanion: 0, openOrdinaryLegacyRecordsWithoutCompanion: 0,
    unsupportedLegacyRecordsWithoutCompanion: 0, writableNowLegacyRecordsWithoutCompanion: 0, v2CandidatesRequireValidation: 0,
    invalidCompanions: 0, companionCandidatesRequireValidation: 0, legacyRepairPostureBlocked: 0, pendingRelatedRequestsScanned: 0,
    pendingRequestsWithoutUsableContext: 0, pendingRequestsRequireValidation: 0,
    tokenCandidatesRequireValidation: 0, overtimeCandidatesRequireValidation: 0,
  }
  const started = Date.now()
  let client: AttendanceLegacyRepairClientV1
  try { client = await pool.connect() } catch { fail('SOURCE_UNAVAILABLE') }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL TIME ZONE 'UTC'")
    await client.query("SET LOCAL statement_timeout = '10000ms'")
    const actor = await client.query(`SELECT u.id FROM users u
      JOIN user_orgs m ON m.user_id=u.id AND m.org_id=$2
      JOIN user_roles ur ON ur.user_id=u.id AND ur.role_id='admin'
      WHERE u.id=$1 AND COALESCE(u.is_active,TRUE)=TRUE
        AND COALESCE(u.activation_status,'activated')='activated' AND COALESCE(m.is_active,TRUE)=TRUE`, [input.actorId, input.orgId])
    if (actor.rows.length !== 1) fail('ACTOR_FORBIDDEN')
    const defaults = await client.query('SELECT timezone FROM attendance_rules WHERE org_id=$1 AND is_default=true ORDER BY id LIMIT 1001', [input.orgId])
    counts.defaultRules = defaults.rows.length
    counts.missingDefaultRules = defaults.rows.length === 0 ? 1 : 0
    counts.multipleDefaultRules = defaults.rows.length > 1 ? 1 : 0
    for (const row of defaults.rows) {
      try { validateAttendanceIanaTimezoneV1(row.timezone) } catch { counts.invalidDefaultTimezones++ }
    }
    const rollout = await client.query('SELECT state,scope FROM attendance_calculation_rollout_state WHERE org_id=$1', [input.orgId])
    const legacyPosture = rollout.rows.length === 0 || (rollout.rows.length === 1
      && rollout.rows[0].state === 'legacy' && rollout.rows[0].scope === 'synthetic_staging')
    // Amendment 2: with multi-timezone off, an untracked same-zone record without a companion is
    // computed from the current default as before the upgrade, so it is not an upgrade blocker.
    const policy = await client.query('SELECT enabled FROM attendance_timezone_policies WHERE org_id=$1', [input.orgId])
    const multiTimezoneOff = policy.rows.length === 0 || (policy.rows.length === 1 && policy.rows[0].enabled === false)
    const soleDefaultZone: string | null = defaults.rows.length === 1 && counts.invalidDefaultTimezones === 0
      && typeof defaults.rows[0].timezone === 'string' ? defaults.rows[0].timezone : null
    let scanComplete = defaults.rows.length <= 1000
    const scan = async (query: string, visit: (row: Record<string, any>) => void) => {
      let after: string | null = null
      while (scanComplete) {
        const scanned = counts.recordsScanned + counts.pendingRelatedRequestsScanned
        if (Date.now() - started > PREFLIGHT_BUDGET_MS) { scanComplete = false; break }
        const limit = Math.min(PREFLIGHT_PAGE_SIZE, PREFLIGHT_MAX_ROWS - scanned + 1)
        const page = await client.query(query, [input.orgId, after, limit])
        for (const row of page.rows) {
          if (counts.recordsScanned + counts.pendingRelatedRequestsScanned >= PREFLIGHT_MAX_ROWS) { scanComplete = false; break }
          visit(row)
        }
        if (Date.now() - started > PREFLIGHT_BUDGET_MS) scanComplete = false
        if (!scanComplete || page.rows.length < limit) break
        after = page.rows.at(-1)!.scan_id
      }
    }
    await scan(`SELECT r.id::text AS scan_id,r.id::text AS record_id,r.user_id,r.work_date::text,
      r.timezone,r.current_calculation_id,r.projection_owner,r.meta,r.first_in_at,r.last_out_at,
      to_jsonb(c) AS companion,calc.attribution_snapshot->>'posture' AS calculation_attribution_posture
      FROM attendance_records r LEFT JOIN attendance_timezone_context_companions c ON c.record_id=r.id AND c.org_id=r.org_id
      LEFT JOIN attendance_record_calculations calc ON calc.id=r.current_calculation_id AND calc.attendance_record_id=r.id AND calc.org_id=r.org_id
      WHERE r.org_id=$1 AND r.visibility_state='active' AND ($2::uuid IS NULL OR r.id>$2::uuid)
      ORDER BY r.id LIMIT $3`, row => {
      counts.recordsScanned++
      // Subset of the two counts below; see the amendment 2 note above.
      if (!row.companion && row.current_calculation_id === null && legacyPosture && multiTimezoneOff
        && soleDefaultZone !== null && row.timezone === soleDefaultZone) counts.writableNowLegacyRecordsWithoutCompanion++
      if (row.companion) {
        if (!validPreflightCompanion(row, input.orgId)) counts.invalidCompanions++
        else if (row.companion.frame_snapshot?.identity?.source !== 'legacy_repair') counts.companionCandidatesRequireValidation++
        if (row.companion.frame_snapshot?.identity?.source === 'legacy_repair' && !legacyPosture) counts.legacyRepairPostureBlocked++
      } else if (row.current_calculation_id !== null && row.calculation_attribution_posture === 'resolved_v2') {
        counts.v2CandidatesRequireValidation++
      } else if (row.current_calculation_id === null && row.projection_owner === 'legacy_untracked' && ordinaryLegacyMeta(row.meta)) {
        counts.ordinaryLegacyRecordsWithoutCompanion++
        if (row.first_in_at !== null && row.last_out_at === null) counts.openOrdinaryLegacyRecordsWithoutCompanion++
      } else counts.unsupportedLegacyRecordsWithoutCompanion++
    })
    await scan(`SELECT req.id::text AS scan_id,req.user_id,req.work_date::text,req.metadata,req.request_type,
      r.id::text AS record_id,r.timezone,to_jsonb(c) AS companion
      FROM attendance_requests req
      LEFT JOIN attendance_records r ON r.org_id=req.org_id AND r.user_id=req.user_id AND r.work_date=req.work_date AND r.visibility_state='active'
      LEFT JOIN attendance_timezone_context_companions c ON c.record_id=r.id AND c.org_id=r.org_id
      WHERE req.org_id=$1 AND req.status='pending'
        AND req.request_type IN ('leave','overtime','missed_check_in','missed_check_out','time_correction')
        AND ($2::uuid IS NULL OR req.id>$2::uuid) ORDER BY req.id LIMIT $3`, row => {
      counts.pendingRelatedRequestsScanned++
      // A parent freeze alone proves neither request endpoint admission nor
      // the independent overtime anchor. All pending approvals need runtime validation.
      counts.pendingRequestsRequireValidation++
      // Parent repair does not establish the separate creation-frozen OT anchor.
      if (row.request_type === 'overtime') counts.overtimeCandidatesRequireValidation++
      if (row.metadata?.timezoneContextV1 !== undefined) {
        counts.tokenCandidatesRequireValidation++
      } else if (!legacyPosture || row.companion?.frame_snapshot?.identity?.source !== 'legacy_repair'
        || !validPreflightCompanion(row, input.orgId)) counts.pendingRequestsWithoutUsableContext++
    })
    const blocked = counts.missingDefaultRules + counts.multipleDefaultRules + counts.invalidDefaultTimezones
      + counts.ordinaryLegacyRecordsWithoutCompanion + counts.unsupportedLegacyRecordsWithoutCompanion
      - counts.writableNowLegacyRecordsWithoutCompanion + counts.invalidCompanions + counts.legacyRepairPostureBlocked + counts.pendingRequestsWithoutUsableContext
    const review = counts.v2CandidatesRequireValidation + counts.tokenCandidatesRequireValidation
      + counts.companionCandidatesRequireValidation + counts.overtimeCandidatesRequireValidation
      + counts.pendingRequestsRequireValidation
    await client.query('COMMIT')
    return { code: !scanComplete ? 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_SCAN_INCOMPLETE'
      : blocked ? 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED'
        : review ? 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_REVIEW_REQUIRED'
          : 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_READY', scanComplete, counts }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof AttendanceLegacyRepairError) throw error
    fail('SOURCE_UNAVAILABLE')
  } finally { client.release() }
}
