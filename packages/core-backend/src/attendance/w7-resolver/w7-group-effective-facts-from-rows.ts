import {
  parseCanonicalAttendanceRolloutOrgKeyV1,
  parseCanonicalAttendanceUserIdV1,
  parseCanonicalAttendanceWorkDateV1,
} from '../w4c0-identity'
import type {
  AttendanceW7GroupEffectiveResolverDepsV1,
  AttendanceW7GroupEffectiveResolverInputV1,
  AttendanceW7GroupResolutionV1,
  AttendanceW7GroupEffectiveSegmentFactsV1,
} from './w7-group-effective-facts-resolver'

/**
 * The runtime overlap code. Deliberately the SAME string the W1 membership
 * writer throws (`../../services/AttendanceCalculationGroupMembership.ts:5-6`,
 * thrown `:543`): the gist storage constraint is date-dependent, so
 * runtime must re-check, and a caller distinguishing "storage said overlap"
 * from "calculation said overlap" would be distinguishing two spellings of
 * one fact (W7-R2).
 */
export const ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP =
  'ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP'

export class AttendanceW7GroupResolverError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW7GroupResolverError'
    this.code = code
  }
}

export interface AttendanceW7LoadedSourceRowsV1 {
  orgId: string
  userId: string
  workDate: string
  membershipRows: Record<string, unknown>[]
  groupRow: Record<string, unknown> | null
  configRow: Record<string, unknown> | null
  memberRows: Record<string, unknown>[]
  managedRows: Record<string, unknown>[]
  shiftRow: Record<string, unknown> | null
  segmentRows: Record<string, unknown>[]
  orgRuleFacts?: {severeLateThresholdMinutes:number;absenceLateThresholdMinutes:number}
  defaultTimezone?: string
  calendarFacts?: {isWorkday:boolean;holidayKind:string|null}
  publishedSourceRows?: Record<string,unknown>[]
}

function formatDateOnly(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
      .join('-')
  }
  const normalized = String(value)
  const match = normalized.match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : normalized
}

/** `HH:MM` / `HH:MM:SS` -> `HH:MM`; anything else -> null (fail-closed). */
function normalizeTimeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)/)
  return match ? `${match[1]}:${match[2]}` : null
}

function toNonNegativeInt(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** One loaded-row -> facts seam. This owns the existing pure FSER call and
 * strict normalization. Storage loaders execute SQL or return typed retained
 * rows; neither loader parses or impersonates a query client. No context issues here. */
export function assembleAttendanceW7GroupEffectiveFactsV1(
  deps: AttendanceW7GroupEffectiveResolverDepsV1,
  input: AttendanceW7GroupEffectiveResolverInputV1,
  loaded: AttendanceW7LoadedSourceRowsV1,
): AttendanceW7GroupResolutionV1 {
  const orgKey=parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
  const userId=parseCanonicalAttendanceUserIdV1(input.userId)
  const workDate=parseCanonicalAttendanceWorkDateV1(input.workDate)
  if (loaded.orgId!==orgKey || loaded.userId!==userId || loaded.workDate!==workDate) return {ok:false,reason:'incomplete-policy'}
  if (loaded.membershipRows.length===0) return {ok:false,reason:'membership-absent'}
  if (loaded.membershipRows.length>1) throw new AttendanceW7GroupResolverError(ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP)
  const calculationGroupId=String(loaded.membershipRows[0].group_id ?? '')
  const groupRow=loaded.groupRow
  if (!calculationGroupId || !groupRow || groupRow.id!==calculationGroupId || groupRow.attendance_type!=='fixed_shift') return {ok:false,reason:'incomplete-policy'}
  if (loaded.publishedSourceRows && (loaded.publishedSourceRows.length!==1
    || loaded.publishedSourceRows[0].shift_id!==loaded.configRow?.shift_id
    || loaded.publishedSourceRows[0].producer_type!=='attendance_group_fixed_schedule'
    || loaded.publishedSourceRows[0].producer_ref_id!==calculationGroupId)) return {ok:false,reason:'incomplete-policy'}
  const configRow = loaded.configRow
  const desired = configRow
    ? {
        shiftId: String(configRow.shift_id),
        startDate: formatDateOnly(configRow.start_date) as string,
        endDate: formatDateOnly(configRow.end_date),
        revision: Number(configRow.revision),
      }
    : null
  const producerKey = desired
    ? deps.buildFixedScheduleProducerKey({
        groupId: calculationGroupId,
        shiftId: desired.shiftId,
        startDate: desired.startDate,
        endDate: desired.endDate,
      })
    : null
  const targetMemberIds = loaded.memberRows.map((row) => String(row.user_id))

  const effectiveness = deps.deriveFixedScheduleEffectiveness({
    desired,
    producerKey,
    targetMemberIds,
    managedRows: loaded.managedRows,
    evaluatedAt: (deps.now ?? (() => new Date().toISOString()))(),
  })

  // Fail-close unless the group's fixed schedule is fully effective. A
  // `pending_apply` / `configuration_changed` / `not_configured` group has a
  // policy that is not yet (or no longer) the one its assignments express;
  // freezing a calculation context off it would freeze a policy nobody
  // authorized.
  if (effectiveness.state !== 'effective' || effectiveness.desired === null) {
    return { ok: false, reason: 'incomplete-policy' }
  }

  // Ruling 6: W1-membership vs FSER member-set reconciliation. The user is
  // W1-effective in this group, but FSER's member set comes from a DIFFERENT,
  // non-effective-dated table (`attendance_group_members`). If the two
  // disagree about this user, FAIL-CLOSE — no soft degrade, no shadow
  // substitute. `state === 'effective'` already implies FSER has full coverage
  // of ITS OWN member set, but it says nothing about a user W1 considers a
  // member and FSER has never heard of; that user is exactly the gap.
  if (!targetMemberIds.includes(userId)) return { ok: false, reason: 'incomplete-policy' }

  // ---- (d) the effective shift row + its segments. ----
  const shiftId = effectiveness.desired.shiftId
  if (!loaded.shiftRow || loaded.shiftRow.id !== shiftId) return {ok:false,reason:'incomplete-policy'}
  const shiftRow = loaded.shiftRow

  // Ruling 11: `flex_required_duration` fail-closes unconditionally in W7-1.
  // Its v2 expression awaits a NEW amendment/OD — it is not a supplement to
  // the OD-W7-2 this ratification fixed. Note the check is "not strict", not
  // "equals flex_required_duration": an unrecognised third mode must also
  // fail-close rather than fall through as if it were strict.
  if (shiftRow.flex_mode !== 'strict') return { ok: false, reason: 'incomplete-policy' }

  const lateGraceMinutes = toNonNegativeInt(shiftRow.late_grace_minutes)
  const earlyLeaveGraceMinutes = toNonNegativeInt(shiftRow.early_grace_minutes)



  const segments: AttendanceW7GroupEffectiveSegmentFactsV1[] = []
  if (loaded.segmentRows.length > 0) {
    if (loaded.segmentRows.length > 3) return { ok: false, reason: 'incomplete-policy' }
    for (let i = 0; i < loaded.segmentRows.length; i += 1) {
      const row = loaded.segmentRows[i]
      const index = Number(row.segment_index)
      const startDayOffset = Number(row.start_day_offset ?? 0)
      const endDayOffset = Number(row.end_day_offset ?? 0)
      const startTime = normalizeTimeString(row.start_time)
      const endTime = normalizeTimeString(row.end_time)
      if (
        index !== i ||
        startDayOffset !== 0 ||
        (endDayOffset !== 0 && endDayOffset !== 1) ||
        !startTime ||
        !endTime
      ) {
        return { ok: false, reason: 'incomplete-policy' }
      }
      segments.push({
        index: index as 0 | 1 | 2,
        startTime,
        endTime,
        startDayOffset: 0,
        endDayOffset: endDayOffset as 0 | 1,
        lateGraceMinutes,
        earlyLeaveGraceMinutes,
      })
    }
  } else {
    const startTime = normalizeTimeString(shiftRow.work_start_time)
    const endTime = normalizeTimeString(shiftRow.work_end_time)
    if (!startTime || !endTime) return { ok: false, reason: 'incomplete-policy' }
    segments.push({
      index: 0,
      startTime,
      endTime,
      startDayOffset: 0,
      endDayOffset: shiftRow.is_overnight === true ? 1 : 0,
      lateGraceMinutes,
      earlyLeaveGraceMinutes,
    })
  }

  // The resolver's SUCCESS OUTPUT MUST BE A SUBSET OF op(i)'s ACCEPTED DOMAIN.
  //
  // `rounding_minutes` is `integer NOT NULL DEFAULT 5` with no CHECK, and the
  // shift create/update schema accepts `z.number().int().min(0)`
  // (`plugins/plugin-attendance/index.cjs:26092`), so `0` is both storable and
  // authorable. But op(i)'s v2 shape requires `roundingMinutes >= 1` — the
  // byte-identical predicate the LIVE v1 validator already carries
  // (`../w4c1-segment-calculator.ts:359`).
  //
  // Without this gate the resolver returned `{ok: true}` for such a shift and
  // its documented sole consumer then THREW `W7_CONTEXT_FACTS_INVALID`. That
  // is worse than it sounds: on the v1 path the same shift degrades to a
  // handled `review('input_schema_invalid')` (`../w4c1-segment-calculator.ts:849`),
  // so W7 would have converted a gracefully-reviewed condition into a thrown
  // one AND reported success on the way to it. The value is rejected on both
  // paths either way; what is aligned here is the failure MODE and the
  // resolver's contract that `ok: true` means op(i) will accept these facts.
  const roundingMinutes = toNonNegativeInt(shiftRow.rounding_minutes)
  if (roundingMinutes < 1) return { ok: false, reason: 'incomplete-policy' }

  const ruleFacts = loaded.orgRuleFacts
  if (!ruleFacts) return {ok:false,reason:'incomplete-policy'}

  const shiftTimezone =
    typeof shiftRow.timezone === 'string' && shiftRow.timezone ? shiftRow.timezone : null
  const groupTimezone =
    typeof groupRow.timezone === 'string' && groupRow.timezone ? groupRow.timezone : null

  return {
    ok: true,
    facts: {
      orgId: orgKey,
      userId,
      workDate,
      // Same precedence the legacy builder uses (`index.cjs:22841`): the
      // shift's own timezone wins, then the caller's. The group row's
      // timezone is the fallback between them — it is group POLICY, which the
      // legacy per-user path never had.
      timezone: input.effectiveTimezone ?? shiftTimezone ?? groupTimezone ?? loaded.defaultTimezone ?? input.timezone,
      calculationGroupId,
      shiftId,
      isWorkday: loaded.calendarFacts?.isWorkday ?? (input.isWorkday !== false),
      holidayKind: loaded.calendarFacts ? loaded.calendarFacts.holidayKind : input.holidayKind ?? null,
      roundingMinutes,
      severeLateThresholdMinutes: ruleFacts.severeLateThresholdMinutes,
      absenceLateThresholdMinutes: ruleFacts.absenceLateThresholdMinutes,
      segments,
    },
  }
}
