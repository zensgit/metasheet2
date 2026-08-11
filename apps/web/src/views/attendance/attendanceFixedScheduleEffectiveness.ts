// #4709 FSER-4 §3 (amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §3, RATIFIED
// `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): the ONE strict shared parser both
// FSER-4 response shapes go through.
//
//   GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness      (admin aggregate)
//   GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness/me   (member-safe self)
//
// This module owns EXACTLY: the closed four-state / reason-code / applicability enums, and a
// strict parse of each response shape into a typed result. It derives NOTHING — `state` is
// forwarded verbatim from the server, never recomputed from `coverage`/`drift`/`applicability`.
// Every surface (group drawer, employee schedule, self/admin decision trace, report) must import
// `parseAttendanceGroupFixedScheduleAdminResponse` / `parseAttendanceGroupFixedScheduleSelfResponse`
// and the `attendanceFixedScheduleStateLabel`/`attendanceFixedScheduleStateClass`/
// `attendanceFixedScheduleReasonCodeLabel` tables below rather than switching on `state` or
// `reasonCodes` themselves — a second four-state derivation or a second reason-order table
// anywhere in frontend code is a contract violation (gate 7 scans for exactly that).
//
// `reasonCodes` render in the order the server returns them. The array below is an UNORDERED
// membership set for validation only — never `.sort()` it, never treat its declaration order as
// authoritative for display. Order is server-owned (base lock §4).

/** Closed four-state enum (base design lock §4). */
export const ATTENDANCE_FIXED_SCHEDULE_STATES = [
  'not_configured',
  'configuration_changed',
  'pending_apply',
  'effective',
] as const
export type AttendanceFixedScheduleState = (typeof ATTENDANCE_FIXED_SCHEDULE_STATES)[number]

/** Closed reason-code membership set (base design lock §4). Order is server-owned — see header. */
export const ATTENDANCE_FIXED_SCHEDULE_REASON_CODES = [
  'NO_DESIRED_CONFIG',
  'NO_TARGET_MEMBERS',
  'DIFFERENT_MANAGED_KEY_ACTIVE',
  'TARGET_MEMBER_MISSING',
  'NON_MEMBER_TARGET_ACTIVE',
  'DUPLICATE_MATCHING_ASSIGNMENT',
  'ASSIGNMENT_VALUE_MISMATCH',
  'UNPUBLISHED_MANAGED_ROW',
  'EFFECTIVE',
] as const
export type AttendanceFixedScheduleReasonCode = (typeof ATTENDANCE_FIXED_SCHEDULE_REASON_CODES)[number]

/** Closed applicability enum (amendment §2). */
export const ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES = ['not_configured', 'matching', 'non_matching'] as const
export type AttendanceFixedScheduleApplicability = (typeof ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES)[number]

const STATE_SET: ReadonlySet<string> = new Set(ATTENDANCE_FIXED_SCHEDULE_STATES)
const REASON_CODE_SET: ReadonlySet<string> = new Set(ATTENDANCE_FIXED_SCHEDULE_REASON_CODES)
const APPLICABILITY_SET: ReadonlySet<string> = new Set(ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES)

export function isAttendanceFixedScheduleState(value: unknown): value is AttendanceFixedScheduleState {
  return typeof value === 'string' && STATE_SET.has(value)
}
export function isAttendanceFixedScheduleReasonCode(value: unknown): value is AttendanceFixedScheduleReasonCode {
  return typeof value === 'string' && REASON_CODE_SET.has(value)
}
export function isAttendanceFixedScheduleApplicability(value: unknown): value is AttendanceFixedScheduleApplicability {
  return typeof value === 'string' && APPLICABILITY_SET.has(value)
}

export interface AttendanceFixedScheduleDesired {
  shiftId: string
  startDate: string
  endDate: string
  revision: number
}

export interface AttendanceFixedScheduleCoverage {
  targetMembers: number
  matchingMembers: number
  missingMembers: number
  nonMemberTargets: number
  differentKeyRows: number
}

export interface AttendanceFixedScheduleManagedSet {
  shiftId: string
  startDate: string
  endDate: string
  producerKey: string
  rowCount: number
}

export interface AttendanceFixedScheduleDrift {
  unconfiguredManagedRows: number
  unpublishedManagedRows: number
  managedSets: AttendanceFixedScheduleManagedSet[]
}

/** Admin aggregate projection — group drawer, admin decision trace, report. */
export interface AttendanceGroupFixedScheduleAdminResult {
  groupId: string
  state: AttendanceFixedScheduleState
  reasonCodes: AttendanceFixedScheduleReasonCode[]
  desired: AttendanceFixedScheduleDesired | null
  coverage: AttendanceFixedScheduleCoverage
  drift: AttendanceFixedScheduleDrift
  evaluatedAt: string
}

/** Member-safe self projection — employee schedule, self decision trace. Exact-key: never
 *  `coverage`/`drift`/`managedSets`/`producerKey`/a raw user identifier (amendment §2/§4 gate 6). */
export interface AttendanceGroupFixedScheduleSelfResult {
  groupId: string
  state: AttendanceFixedScheduleState
  reasonCodes: AttendanceFixedScheduleReasonCode[]
  desired: AttendanceFixedScheduleDesired | null
  applicability: AttendanceFixedScheduleApplicability
  evaluatedAt: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseReasonCodes(value: unknown): AttendanceFixedScheduleReasonCode[] | null {
  if (!Array.isArray(value)) return null
  const codes: AttendanceFixedScheduleReasonCode[] = []
  for (const entry of value) {
    if (!isAttendanceFixedScheduleReasonCode(entry)) return null
    codes.push(entry)
  }
  return codes
}

// Sentinel distinguishing "parsed as null" (valid `desired: null`) from "failed to parse".
const PARSE_FAILED = Symbol('attendance-fixed-schedule-parse-failed')

function parseDesired(value: unknown): AttendanceFixedScheduleDesired | null | typeof PARSE_FAILED {
  if (value === null) return null
  if (!isPlainObject(value)) return PARSE_FAILED
  const requiredKeys = ['shiftId', 'startDate', 'endDate', 'revision']
  for (const key of requiredKeys) {
    if (!(key in value)) return PARSE_FAILED
  }
  if (!isNonEmptyString(value.shiftId) || !isNonEmptyString(value.startDate) || !isNonEmptyString(value.endDate)) {
    return PARSE_FAILED
  }
  if (!isFiniteNumber(value.revision)) return PARSE_FAILED
  return { shiftId: value.shiftId, startDate: value.startDate, endDate: value.endDate, revision: value.revision }
}

function parseCoverage(value: unknown): AttendanceFixedScheduleCoverage | null {
  if (!isPlainObject(value)) return null
  const keys = ['targetMembers', 'matchingMembers', 'missingMembers', 'nonMemberTargets', 'differentKeyRows'] as const
  for (const key of keys) {
    if (!isFiniteNumber(value[key])) return null
  }
  return {
    targetMembers: value.targetMembers as number,
    matchingMembers: value.matchingMembers as number,
    missingMembers: value.missingMembers as number,
    nonMemberTargets: value.nonMemberTargets as number,
    differentKeyRows: value.differentKeyRows as number,
  }
}

function parseManagedSet(value: unknown): AttendanceFixedScheduleManagedSet | null {
  if (!isPlainObject(value)) return null
  if (!isNonEmptyString(value.shiftId) || !isNonEmptyString(value.startDate) || !isNonEmptyString(value.endDate)) return null
  if (!isNonEmptyString(value.producerKey) || !isFiniteNumber(value.rowCount)) return null
  return {
    shiftId: value.shiftId,
    startDate: value.startDate,
    endDate: value.endDate,
    producerKey: value.producerKey,
    rowCount: value.rowCount,
  }
}

function parseDrift(value: unknown): AttendanceFixedScheduleDrift | null {
  if (!isPlainObject(value)) return null
  if (!isFiniteNumber(value.unconfiguredManagedRows) || !isFiniteNumber(value.unpublishedManagedRows)) return null
  if (!Array.isArray(value.managedSets)) return null
  const managedSets: AttendanceFixedScheduleManagedSet[] = []
  for (const entry of value.managedSets) {
    const parsed = parseManagedSet(entry)
    if (!parsed) return null
    managedSets.push(parsed)
  }
  return {
    unconfiguredManagedRows: value.unconfiguredManagedRows,
    unpublishedManagedRows: value.unpublishedManagedRows,
    managedSets,
  }
}

/** Strict parse of the admin aggregate route's `data` payload. Returns `null` on ANY shape
 *  mismatch — a missing/mistyped field, an unknown `state`, or an unknown `reasonCodes` entry —
 *  never a partial/best-effort object (§3: response-shape mismatch is a fail-closed trigger). */
export function parseAttendanceGroupFixedScheduleAdminResponse(value: unknown): AttendanceGroupFixedScheduleAdminResult | null {
  if (!isPlainObject(value)) return null
  if (!isNonEmptyString(value.groupId)) return null
  if (!isAttendanceFixedScheduleState(value.state)) return null
  const reasonCodes = parseReasonCodes(value.reasonCodes)
  if (!reasonCodes) return null
  const desired = parseDesired(value.desired)
  if (desired === PARSE_FAILED) return null
  const coverage = parseCoverage(value.coverage)
  if (!coverage) return null
  const drift = parseDrift(value.drift)
  if (!drift) return null
  if (!isNonEmptyString(value.evaluatedAt)) return null
  return { groupId: value.groupId, state: value.state, reasonCodes, desired, coverage, drift, evaluatedAt: value.evaluatedAt }
}

// Amendment §2/§4 gate 6: the self response must never carry these, at ANY nesting depth. Kept as
// a named list (not "reject every unrecognized key") — a future, contract-permitted optional field
// on the self shape must not be treated as a shape mismatch; only these specific fields (and any
// user-id-shaped key) are load-bearing enough to fail closed on.
const ATTENDANCE_FIXED_SCHEDULE_SELF_FORBIDDEN_KEYS = [
  'coverage',
  'drift',
  'managedSets',
  'producerKey',
  'userId',
  'user_id',
  'subjectId',
  'targetUserId',
  'memberIds',
  'members',
]
const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set(ATTENDANCE_FIXED_SCHEDULE_SELF_FORBIDDEN_KEYS)

/** Recursive walk of every own-enumerable key at any nesting depth — mirrors the backend's own
 *  `EXACT-KEY` real-DB test methodology, applied client-side as defense in depth. */
function containsForbiddenSelfKey(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (Array.isArray(value)) {
    if (seen.has(value)) return false
    seen.add(value)
    return value.some(entry => containsForbiddenSelfKey(entry, seen))
  }
  if (!isPlainObject(value)) return false
  if (seen.has(value)) return false
  seen.add(value)
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_SET.has(key)) return true
    if (containsForbiddenSelfKey(value[key], seen)) return true
  }
  return false
}

/** Strict parse of the member-safe `/me` route's `data` payload. Returns `null` on ANY shape
 *  mismatch, including the presence of a forbidden key (coverage/drift/managedSets/producerKey/a
 *  raw user identifier) at any nesting depth. */
export function parseAttendanceGroupFixedScheduleSelfResponse(value: unknown): AttendanceGroupFixedScheduleSelfResult | null {
  if (!isPlainObject(value)) return null
  if (containsForbiddenSelfKey(value)) return null
  if (!isNonEmptyString(value.groupId)) return null
  if (!isAttendanceFixedScheduleState(value.state)) return null
  const reasonCodes = parseReasonCodes(value.reasonCodes)
  if (!reasonCodes) return null
  const desired = parseDesired(value.desired)
  if (desired === PARSE_FAILED) return null
  if (!isAttendanceFixedScheduleApplicability(value.applicability)) return null
  if (!isNonEmptyString(value.evaluatedAt)) return null
  return { groupId: value.groupId, state: value.state, reasonCodes, desired, applicability: value.applicability, evaluatedAt: value.evaluatedAt }
}

// ---------------------------------------------------------------------------------------------
// Display tables. Every surface renders through these — never a local switch/if-chain on `state`
// or `reasonCodes` (gate 7).
// ---------------------------------------------------------------------------------------------

const STATE_LABELS: Record<AttendanceFixedScheduleState, readonly [string, string]> = {
  not_configured: ['Not configured', '未配置'],
  configuration_changed: ['Changed since last apply', '配置已变更'],
  pending_apply: ['Pending apply', '待应用'],
  effective: ['Effective', '生效中'],
}

const STATE_CLASSES: Record<AttendanceFixedScheduleState, string> = {
  not_configured: 'attendance-fs-state--neutral',
  configuration_changed: 'attendance-fs-state--warning',
  pending_apply: 'attendance-fs-state--pending',
  effective: 'attendance-fs-state--success',
}

export function attendanceFixedScheduleStateLabel(state: AttendanceFixedScheduleState, tr: (en: string, zh: string) => string): string {
  const [en, zh] = STATE_LABELS[state]
  return tr(en, zh)
}

export function attendanceFixedScheduleStateClass(state: AttendanceFixedScheduleState): string {
  return STATE_CLASSES[state]
}

const APPLICABILITY_LABELS: Record<AttendanceFixedScheduleApplicability, readonly [string, string]> = {
  not_configured: ['No desired schedule set', '尚未设置期望排班'],
  matching: ['Matches the desired schedule', '与期望排班一致'],
  non_matching: ['Does not match the desired schedule yet', '尚未与期望排班一致'],
}

export function attendanceFixedScheduleApplicabilityLabel(
  applicability: AttendanceFixedScheduleApplicability,
  tr: (en: string, zh: string) => string,
): string {
  const [en, zh] = APPLICABILITY_LABELS[applicability]
  return tr(en, zh)
}

const REASON_CODE_LABELS: Record<AttendanceFixedScheduleReasonCode, readonly [string, string]> = {
  NO_DESIRED_CONFIG: ['No desired configuration saved', '尚未保存期望配置'],
  NO_TARGET_MEMBERS: ['Group has no current members', '考勤组当前无成员'],
  DIFFERENT_MANAGED_KEY_ACTIVE: ['An earlier managed schedule is still active', '仍有此前的已管理排班生效中'],
  TARGET_MEMBER_MISSING: ['Some members are missing the desired schedule', '部分成员尚未获得期望排班'],
  NON_MEMBER_TARGET_ACTIVE: ['A non-member still holds a managed row', '存在非成员仍持有已管理排班'],
  DUPLICATE_MATCHING_ASSIGNMENT: ['A member has duplicate matching rows', '存在成员持有重复的匹配排班'],
  ASSIGNMENT_VALUE_MISMATCH: ['A matching-key row has different values', '同班次同窗口的行取值不一致'],
  UNPUBLISHED_MANAGED_ROW: ['A managed row is not yet published', '存在尚未发布的已管理排班行'],
  EFFECTIVE: ['Desired schedule is fully effective', '期望排班已完全生效'],
}

export function attendanceFixedScheduleReasonCodeLabel(
  code: AttendanceFixedScheduleReasonCode,
  tr: (en: string, zh: string) => string,
): string {
  const [en, zh] = REASON_CODE_LABELS[code]
  return tr(en, zh)
}
