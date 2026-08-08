/**
 * W6 (#4556) — group effective-policy aggregate: response contract validator.
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 *   §3 (red lines W6-R2, W6-R6, W6-R7, W6-R8), §4.2-4.3.
 *
 * Pure, DB-free, exact-key + enum-strict structural validator for the W6-1
 * aggregate response. It exists to give W6-R2/R6/R7/R8 a single mechanical
 * judge:
 *  - W6-R2 (values-free): any key outside the closed shape — `memberIds`,
 *    `userId`, `ownerUserId`, `affectedUserIds`, ... — fails validation,
 *    because the walker rejects ANY unlisted key, not a hand-maintained
 *    deny-list of "known bad" names;
 *  - W6-R6 (enum-strict): every enum field is checked against its closed
 *    union; an unrecognized value fails rather than being coerced to a
 *    default;
 *  - W6-R7 (labels only from persisted facts): this module has no notion of
 *    a client-suppliable override — it only judges shape, so a caller that
 *    tried to inject one would already have to fabricate a value that must
 *    still pass the closed-enum check;
 *  - W6-R8 (closed editor navigation): `parseAttendanceGroupEffectivePolicyEditorRefV1`
 *    is the single closed-table parser for the two-kind union.
 *
 * Also used (see `w6-group-effective-policy-aggregate.ts`) as a final,
 * cheap runtime self-check before the service hands its result to the
 * route: if the service's own output ever fails this contract, the route
 * must 500 rather than serve a malformed body.
 */
import {
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_REASON_CODES_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1,
  type AttendanceGroupEffectivePolicyCalculationPostureV1,
  type AttendanceGroupEffectivePolicyEditorRefV1,
  type AttendanceGroupEffectivePolicyGroupTypeV1,
  type AttendanceGroupEffectivePolicyResponseV1,
} from './w6-group-effective-policy-contract'

const REASON_CODES = new Set(ATTENDANCE_GROUP_EFFECTIVE_POLICY_REASON_CODES_V1)

const CALCULATION_POSTURES: readonly AttendanceGroupEffectivePolicyCalculationPostureV1[] = Object.freeze([
  'legacy',
  'shadow',
  'eligible',
  'authoritative',
  'suspended',
])

const GROUP_TYPES: readonly AttendanceGroupEffectivePolicyGroupTypeV1[] = Object.freeze([
  'fixed_shift',
  'scheduled_shift',
  'free_time',
])

const FSER_STATES = Object.freeze(['not_configured', 'pending_apply', 'effective', 'configuration_changed'])

const FLEX_MODES = Object.freeze(['strict', 'flex_required_duration'])
const RULE_SOURCES = Object.freeze(['org_default', 'group_rule_set'])
const SCHEDULE_ROUTE_SURFACES: Record<string, readonly string[] | null> = Object.freeze({
  schedule: ['shifts', 'assignments', 'advanced-scheduling'],
  calendar: null,
  rules: ['rule-sets'],
})
const GROUP_STAGES = Object.freeze(['basics', 'people', 'schedule', 'policies'])
const SOURCE_REF_KINDS = Object.freeze(['shift', 'rule_set', 'fixed_schedule_config', 'schedule_group'])

export type AttendanceGroupEffectivePolicyValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

function fail(reason: string): AttendanceGroupEffectivePolicyValidationResult {
  return { ok: false, reason }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

/** Exact-key check: `value` must be a plain object whose own enumerable keys
 * are exactly `required` plus zero or more of `optional` — nothing else. */
function hasClosedKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const own = Object.getOwnPropertyNames(value)
  const allowed = new Set([...required, ...optional])
  for (const key of own) {
    if (!allowed.has(key)) return false
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false
  }
  return true
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** W6-R6: reason codes are closed end to end (§4.2), not merely
 * "an array of strings" — every entry must be one of FSER's closed
 * `REASON_ORDER` or the four W6-authored domain reason codes. */
function isReasonCodeArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every((item) => REASON_CODES.has(item))
}

/**
 * W6-R8: the single closed-table parser for `editorRef`. Returns the parsed
 * value on success; `null` on ANY shape that is not exactly one of the two
 * kinds in the closed union, including a caller-supplied admin `section` id
 * (the exact shape of `invalid-reject-open-editor-ref.json`).
 */
export function parseAttendanceGroupEffectivePolicyEditorRefV1(
  value: unknown,
): AttendanceGroupEffectivePolicyEditorRefV1 | null {
  if (!isPlainObject(value)) return null
  if (value.kind === 'group_stage') {
    if (!hasClosedKeys(value, ['kind', 'stage'])) return null
    if (typeof value.stage !== 'string' || !GROUP_STAGES.includes(value.stage)) return null
    return { kind: 'group_stage', stage: value.stage as 'basics' | 'people' | 'schedule' | 'policies' }
  }
  if (value.kind === 'group_context_route') {
    if (typeof value.step !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEDULE_ROUTE_SURFACES, value.step)) {
      return null
    }
    const step = value.step as 'schedule' | 'calendar' | 'rules'
    const allowedSurfaces = SCHEDULE_ROUTE_SURFACES[step]
    if (allowedSurfaces === null) {
      if (!hasClosedKeys(value, ['kind', 'step'])) return null
      return { kind: 'group_context_route', step: 'calendar' }
    }
    if (!hasClosedKeys(value, ['kind', 'step'], ['surface'])) return null
    if (Object.prototype.hasOwnProperty.call(value, 'surface')) {
      if (typeof value.surface !== 'string' || !allowedSurfaces.includes(value.surface)) return null
      return { kind: 'group_context_route', step, surface: value.surface } as AttendanceGroupEffectivePolicyEditorRefV1
    }
    return { kind: 'group_context_route', step } as AttendanceGroupEffectivePolicyEditorRefV1
  }
  return null
}

function validateSourceRefs(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.every(
    (item) =>
      hasClosedKeys(item, ['kind', 'id']) &&
      typeof (item as Record<string, unknown>).kind === 'string' &&
      SOURCE_REF_KINDS.includes((item as Record<string, unknown>).kind as string) &&
      isNonEmptyString((item as Record<string, unknown>).id),
  )
}

function validateFixedSchedule(value: unknown): AttendanceGroupEffectivePolicyValidationResult {
  if (value === null) return { ok: true }
  if (!hasClosedKeys(value, ['state', 'reasonCodes', 'desired', 'coverage', 'drift', 'evaluatedAt'])) {
    return fail('fixedSchedule: unexpected key set')
  }
  const v = value as Record<string, unknown>
  if (typeof v.state !== 'string' || !FSER_STATES.includes(v.state)) return fail('fixedSchedule.state: unknown enum value')
  if (!isReasonCodeArray(v.reasonCodes)) return fail('fixedSchedule.reasonCodes: not a closed-set string array')
  if (v.desired !== null) {
    if (!hasClosedKeys(v.desired, ['shiftId', 'startDate', 'endDate', 'revision'])) return fail('fixedSchedule.desired: unexpected key set')
    const d = v.desired as Record<string, unknown>
    if (!isNonEmptyString(d.shiftId) || !isNonEmptyString(d.startDate) || !isNonEmptyString(d.endDate) || typeof d.revision !== 'number') {
      return fail('fixedSchedule.desired: field type mismatch')
    }
  }
  if (!hasClosedKeys(v.coverage, ['targetMembers', 'matchingMembers', 'missingMembers', 'nonMemberTargets', 'differentKeyRows'])) {
    return fail('fixedSchedule.coverage: unexpected key set')
  }
  const coverage = v.coverage as Record<string, unknown>
  for (const key of ['targetMembers', 'matchingMembers', 'missingMembers', 'nonMemberTargets', 'differentKeyRows']) {
    if (!isNonNegativeInt(coverage[key])) return fail(`fixedSchedule.coverage.${key}: not a non-negative int`)
  }
  if (!hasClosedKeys(v.drift, ['unconfiguredManagedRows', 'unpublishedManagedRows', 'managedSets'])) {
    return fail('fixedSchedule.drift: unexpected key set')
  }
  const drift = v.drift as Record<string, unknown>
  if (!isNonNegativeInt(drift.unconfiguredManagedRows) || !isNonNegativeInt(drift.unpublishedManagedRows)) {
    return fail('fixedSchedule.drift: counts not a non-negative int')
  }
  if (!Array.isArray(drift.managedSets)) return fail('fixedSchedule.drift.managedSets: not an array')
  for (const set of drift.managedSets) {
    if (!hasClosedKeys(set, ['shiftId', 'startDate', 'endDate', 'producerKey', 'rowCount'])) {
      return fail('fixedSchedule.drift.managedSets[]: unexpected key set')
    }
  }
  if (!isIsoTimestamp(v.evaluatedAt)) return fail('fixedSchedule.evaluatedAt: not an ISO timestamp')
  return { ok: true }
}

function validateDomainSummary(
  name: string,
  value: unknown,
  extraRequired: readonly string[],
  extraOptional: readonly string[] = [],
): AttendanceGroupEffectivePolicyValidationResult {
  if (!hasClosedKeys(value, ['label', 'reasonCodes', 'editorRef', ...extraRequired], ['sourceRefs', ...extraOptional])) {
    return fail(`${name}: unexpected key set`)
  }
  const v = value as Record<string, unknown>
  if (typeof v.label !== 'string' || !ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1.includes(v.label as never)) {
    return fail(`${name}.label: unknown enum value`)
  }
  if (!isReasonCodeArray(v.reasonCodes)) return fail(`${name}.reasonCodes: not a closed-set string array`)
  if (Object.prototype.hasOwnProperty.call(v, 'sourceRefs') && !validateSourceRefs(v.sourceRefs)) {
    return fail(`${name}.sourceRefs: invalid shape`)
  }
  const editorRef = parseAttendanceGroupEffectivePolicyEditorRefV1(v.editorRef)
  if (!editorRef) return fail(`${name}.editorRef: fails closed-table parse`)
  return { ok: true }
}

/**
 * W6-R2/R6/R7/R8 combined judge. Validates the FULL `{ ok: true, data }`
 * envelope. Returns the first violation found; callers that need every
 * violation should fix-and-rerun (matches this repo's other exact-shape
 * validators).
 */
export function validateAttendanceGroupEffectivePolicyResponseV1(
  candidate: unknown,
): AttendanceGroupEffectivePolicyValidationResult {
  if (!hasClosedKeys(candidate, ['ok', 'data'])) return fail('envelope: unexpected key set')
  const envelope = candidate as Record<string, unknown>
  if (envelope.ok !== true) return fail('envelope.ok: must be literal true')
  const data = envelope.data
  if (
    !hasClosedKeys(data, [
      'groupId',
      'groupType',
      'timezone',
      'activeMemberCount',
      'managerPosture',
      'calculationPosture',
      'domains',
      'conflicts',
      'evaluatedAt',
    ])
  ) {
    return fail('data: unexpected key set')
  }
  const d = data as Record<string, unknown>
  if (!isNonEmptyString(d.groupId)) return fail('data.groupId: not a non-empty string')
  if (typeof d.groupType !== 'string' || !GROUP_TYPES.includes(d.groupType as never)) return fail('data.groupType: unknown enum value')
  if (d.timezone !== null && !isNonEmptyString(d.timezone)) return fail('data.timezone: not string|null')
  if (!isNonNegativeInt(d.activeMemberCount)) return fail('data.activeMemberCount: not a non-negative int')
  if (!hasClosedKeys(d.managerPosture, ['ownerCount', 'subOwnerCount'])) return fail('data.managerPosture: unexpected key set')
  const managerPosture = d.managerPosture as Record<string, unknown>
  if (!isNonNegativeInt(managerPosture.ownerCount) || !isNonNegativeInt(managerPosture.subOwnerCount)) {
    return fail('data.managerPosture: counts not a non-negative int')
  }
  if (typeof d.calculationPosture !== 'string' || !CALCULATION_POSTURES.includes(d.calculationPosture as never)) {
    return fail('data.calculationPosture: unknown enum value')
  }
  if (
    !hasClosedKeys(d.domains, [
      'membership',
      'schedule',
      'segments',
      'flex',
      'rules',
      'punchMethod',
      'requestPosture',
    ])
  ) {
    return fail('data.domains: unexpected key set')
  }
  const domains = d.domains as Record<string, unknown>

  const membership = validateDomainSummary('domains.membership', domains.membership, [])
  if (!membership.ok) return membership

  const schedule = validateDomainSummary('domains.schedule', domains.schedule, ['strategy', 'fixedSchedule'])
  if (!schedule.ok) return schedule
  const scheduleValue = domains.schedule as Record<string, unknown>
  if (typeof scheduleValue.strategy !== 'string' || !GROUP_TYPES.includes(scheduleValue.strategy as never)) {
    return fail('domains.schedule.strategy: unknown enum value')
  }
  const fixedSchedule = validateFixedSchedule(scheduleValue.fixedSchedule)
  if (!fixedSchedule.ok) return fixedSchedule

  const segments = validateDomainSummary('domains.segments', domains.segments, [])
  if (!segments.ok) return segments

  const flex = validateDomainSummary('domains.flex', domains.flex, [], ['mode'])
  if (!flex.ok) return flex
  const flexValue = domains.flex as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(flexValue, 'mode') && !FLEX_MODES.includes(flexValue.mode as string)) {
    return fail('domains.flex.mode: unknown enum value')
  }

  const rules = validateDomainSummary('domains.rules', domains.rules, ['source'])
  if (!rules.ok) return rules
  const rulesValue = domains.rules as Record<string, unknown>
  if (!RULE_SOURCES.includes(rulesValue.source as string)) return fail('domains.rules.source: unknown enum value')

  const punchMethod = validateDomainSummary('domains.punchMethod', domains.punchMethod, ['source'])
  if (!punchMethod.ok) return punchMethod
  const punchMethodValue = domains.punchMethod as Record<string, unknown>
  if (punchMethodValue.source !== 'org_inherited') return fail('domains.punchMethod.source: must be org_inherited')

  const requestPosture = validateDomainSummary('domains.requestPosture', domains.requestPosture, [
    'overtime',
    'makeupPunch',
    'outdoor',
  ])
  if (!requestPosture.ok) return requestPosture
  const requestPostureValue = domains.requestPosture as Record<string, unknown>
  for (const key of ['overtime', 'makeupPunch', 'outdoor']) {
    if (requestPostureValue[key] !== 'org_inherited') return fail(`domains.requestPosture.${key}: must be org_inherited`)
  }

  if (!Array.isArray(d.conflicts)) return fail('data.conflicts: not an array')
  for (const conflict of d.conflicts) {
    if (!hasClosedKeys(conflict, ['code', 'domain', 'label', 'editorRef'], ['affectedUserCount'])) {
      return fail('conflicts[]: unexpected key set')
    }
    const c = conflict as Record<string, unknown>
    if (typeof c.code !== 'string' || !ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1.includes(c.code as never)) {
      return fail('conflicts[].code: unknown enum value')
    }
    if (typeof c.domain !== 'string' || !ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1.includes(c.domain as never)) {
      return fail('conflicts[].domain: unknown enum value')
    }
    if (c.label !== 'conflict_action_required') return fail('conflicts[].label: must be conflict_action_required')
    if (Object.prototype.hasOwnProperty.call(c, 'affectedUserCount') && !isNonNegativeInt(c.affectedUserCount)) {
      return fail('conflicts[].affectedUserCount: not a non-negative int')
    }
    if (!parseAttendanceGroupEffectivePolicyEditorRefV1(c.editorRef)) return fail('conflicts[].editorRef: fails closed-table parse')
  }

  if (!isIsoTimestamp(d.evaluatedAt)) return fail('data.evaluatedAt: not an ISO timestamp')

  return { ok: true }
}

/** Type-guard convenience wrapper. */
export function isValidAttendanceGroupEffectivePolicyResponseV1(
  candidate: unknown,
): candidate is AttendanceGroupEffectivePolicyResponseV1 {
  return validateAttendanceGroupEffectivePolicyResponseV1(candidate).ok
}
