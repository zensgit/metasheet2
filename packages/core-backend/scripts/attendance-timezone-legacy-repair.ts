/**
 * Reviewed historical archive only. A file hash binds review to bytes; it does
 * not establish archive authenticity. Preview is the default and is read-only.
 *
 * pnpm --filter @metasheet/core-backend exec tsx scripts/attendance-timezone-legacy-repair.ts
 *   --source=<private-archive.json> --actor=<admin-id> --confirm-archive-source
 * Apply additionally requires --apply --approved-source-sha256=<preview SHA>
 *   --approved-plan-sha256=<preview SHA>. DATABASE_URL is environment-only.
 * Compute the original-row digest from to_jsonb(r) in a UTC session; both
 * service transactions pin SET LOCAL TIME ZONE 'UTC' before reading the row.
 * Org-wide admission scan: --preflight --org=<org-id> --actor=<admin-id>.
 * This mode is mutually exclusive with source/apply/archive-confirmation/SHA
 * arguments. Exit 0 means READY for this read-only snapshot; 2 means BLOCKED or
 * REVIEW_REQUIRED; 3 means SCAN_INCOMPLETE; 1 means a fixed-code error.
 * Scan pages are capped at 500, 100000 record/request rows total, 10 seconds
 * per SQL statement and 30 seconds overall. V2, other companion types and all
 * pending related requests require strict runtime validation; the preflight
 * does not infer validity from JSON labels or a repaired parent record.
 * Counts: ordinary/unsupportedLegacyRecordsWithoutCompanion list every record
 * without a companion. writableNowLegacyRecordsWithoutCompanion is the subset that
 * is untracked, in the single valid default zone, with multi-timezone off and
 * legacy posture: it is writable without repair and is NOT counted as BLOCKED
 * (blocked = ordinary + unsupported - writableNow + the other blocker counts).
 * Records in another zone, any record while multi-timezone is on, and any record
 * under shadow/authoritative posture stay blocked.
 *
 * Required JSON keys (nulls are explicit historical facts, not omitted fields):
 * {
 *   "schemaVersion":1,"kind":"archived_legacy_rule_context",
 *   "orgId":"...","userId":"...","recordId":"...","workDate":"YYYY-MM-DD",
 *   "timezone":"Asia/Shanghai","expectedRecordFingerprint":"<sha256 of DB to_jsonb(record)>",
 *   "archive":{"reference":"private archive reference","capturedAt":"2026-01-01T00:00:00Z",
 *     "reviewedBy":"<same admin-id>","attestation":"historical_source_reviewed"},
 *   "rule":{"id":null,"orgId":"...","timezone":"Asia/Shanghai",
 *     "workStartTime":"09:00","workEndTime":"18:00","isOvernight":false,
 *     "workingDays":[1,2,3,4,5],"lateGraceMinutes":0,"earlyGraceMinutes":0,
 *     "roundingMinutes":0,"severeLateThresholdMinutes":30,"absenceLateThresholdMinutes":120,
 *     "flexMode":null,"flexRequiredMinutes":null,"flexArrivalWindowBeforeMinutes":null,
 *     "flexArrivalWindowAfterMinutes":null,"flexCoreStartTime":null,"flexCoreEndTime":null},
 *   "calendar":{"isWorkingDay":true,"holiday":null},
 *   "noWinningAssignment":{"reasonCode":"UNSCHEDULED_NO_SHIFT",
 *     "attestation":"no_winning_assignment_at_original_record_freeze"},
 *   "attribution":{"tailMinutes":120,"approvedOvertimeWindows":[],
 *     "attestation":"complete_historical_tail_and_approved_overtime"},
 *   "absoluteWindow":{"startAt":"<strict ISO instant>","endAt":"<strict ISO instant>"},
 *   "attributionWindow":{"startAt":"<same start>","endAt":"<end plus historical tail>"}
 * }
 * First version permits only the three ordinary severe/absence statistics in
 * record meta. It refuses shift metadata, active flex, nonempty approved overtime,
 * and any persisted non-legacy calculator rollout state, regardless of flags.
 */
import { open } from 'node:fs/promises'
import pg from 'pg'
import {
  ATTENDANCE_LEGACY_REPAIR_MAX_SOURCE_BYTES_V1, AttendanceLegacyRepairError,
  applyAttendanceTimezoneLegacyRepairV1, inspectAttendanceTimezoneLegacyRepairV1, previewAttendanceTimezoneLegacyRepairV1,
} from '../src/attendance/attendance-timezone-legacy-repair'

async function main() {
  const args = new Map<string, string>()
  const allowed = new Set(['source', 'actor', 'confirm-archive-source', 'apply', 'approved-source-sha256', 'approved-plan-sha256', 'preflight', 'org'])
  for (const arg of process.argv.slice(2)) {
    const match = /^--([a-z0-9-]+)(?:=(.+))?$/.exec(arg)
    if (!match || !allowed.has(match[1]) || args.has(match[1])) throw new AttendanceLegacyRepairError('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ARGUMENT_INVALID')
    const isSwitch = ['apply', 'confirm-archive-source', 'preflight'].includes(match[1])
    if (isSwitch === (match[2] !== undefined)) throw new AttendanceLegacyRepairError('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ARGUMENT_INVALID')
    args.set(match[1], match[2] ?? 'true')
  }
  if (args.has('preflight')) {
    if (!args.get('org') || !args.get('actor') || [...args.keys()].some(key => !['preflight', 'org', 'actor'].includes(key))) {
      throw new AttendanceLegacyRepairError('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ARGUMENT_INVALID')
    }
    if (!process.env.DATABASE_URL) throw new AttendanceLegacyRepairError('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_DATABASE_REQUIRED')
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    try {
      const result = await inspectAttendanceTimezoneLegacyRepairV1(pool, { orgId: args.get('org')!, actorId: args.get('actor')! })
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exitCode = result.code.endsWith('_READY') ? 0 : result.scanComplete ? 2 : 3
    } finally { await pool.end() }
    return
  }
  if (args.has('org') || !args.get('source') || !args.get('actor') || !args.has('confirm-archive-source')
    || (!args.has('apply') && (args.has('approved-source-sha256') || args.has('approved-plan-sha256')))) {
    throw new AttendanceLegacyRepairError('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ARGUMENT_INVALID')
  }
  const handle = await open(args.get('source')!, 'r')
  let source: Buffer
  try {
    // A bounded read also caps a file changed after stat, without printing its path.
    source = Buffer.alloc(ATTENDANCE_LEGACY_REPAIR_MAX_SOURCE_BYTES_V1 + 1)
    let total = 0
    while (total < source.length) {
      const read = await handle.read(source, total, source.length - total, null)
      if (!read.bytesRead) break
      total += read.bytesRead
    }
    if (total > ATTENDANCE_LEGACY_REPAIR_MAX_SOURCE_BYTES_V1) throw new AttendanceLegacyRepairError('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_EVIDENCE_INVALID')
    source = source.subarray(0, total)
  } finally { await handle.close() }
  if (!process.env.DATABASE_URL) throw new AttendanceLegacyRepairError('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_DATABASE_REQUIRED')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    const input = { source, actorId: args.get('actor')!, archiveSourceConfirmed: true as const }
    const result = args.has('apply')
      ? await applyAttendanceTimezoneLegacyRepairV1(pool, { ...input,
        approvedSourceSha256: args.get('approved-source-sha256') ?? '',
        approvedPlanSha256: args.get('approved-plan-sha256') ?? '' })
      : await previewAttendanceTimezoneLegacyRepairV1(pool, input)
    process.stdout.write(JSON.stringify(result) + '\n')
  } finally { await pool.end() }
}

main().catch(error => {
  const code = error instanceof AttendanceLegacyRepairError ? error.code : 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_SOURCE_UNAVAILABLE'
  process.stdout.write(JSON.stringify({ code, count: 0 }) + '\n')
  process.exitCode = 1
})
