import {
  isAttendanceGroupFixedScheduleStateV1,
  type AttendanceGroupFixedScheduleStateV1,
} from './attendanceGroupEffectivePolicyLabels'

export const FIXED_SCHEDULE_REASON_CODES = [
  'NO_DESIRED_CONFIG', 'NO_TARGET_MEMBERS', 'DIFFERENT_MANAGED_KEY_ACTIVE',
  'TARGET_MEMBER_MISSING', 'NON_MEMBER_TARGET_ACTIVE', 'DUPLICATE_MATCHING_ASSIGNMENT',
  'ASSIGNMENT_VALUE_MISMATCH', 'UNPUBLISHED_MANAGED_ROW', 'EFFECTIVE',
] as const
export type FixedScheduleReasonCode = (typeof FIXED_SCHEDULE_REASON_CODES)[number]
export type FixedScheduleAudience = 'admin' | 'self'
export interface FixedScheduleDesired {
  shiftId: string
  startDate: string
  endDate: string
  revision: number
}
interface FixedScheduleBase {
  groupId: string
  state: AttendanceGroupFixedScheduleStateV1
  reasonCodes: FixedScheduleReasonCode[]
  desired: FixedScheduleDesired | null
  evaluatedAt: string
}
export interface FixedScheduleManagedSet {
  shiftId: string
  startDate: string
  endDate: string | null
  producerKey: string
  rowCount: number
}
export interface FixedScheduleAdmin extends FixedScheduleBase {
  coverage: {
    targetMembers: number
    matchingMembers: number
    missingMembers: number
    nonMemberTargets: number
    differentKeyRows: number
  }
  drift: {
    unconfiguredManagedRows: number
    unpublishedManagedRows: number
    managedSets: FixedScheduleManagedSet[]
  }
}
export interface FixedScheduleSelf extends FixedScheduleBase {
  applicability: 'not_configured' | 'matching' | 'non_matching'
}
export type FixedScheduleEffectiveness = FixedScheduleAdmin | FixedScheduleSelf

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
function instant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function desired(value: unknown): FixedScheduleDesired | null | false {
  if (value === null) return null
  if (!exact(value, ['shiftId', 'startDate', 'endDate', 'revision'])
    || !text(value.shiftId) || !date(value.startDate) || !date(value.endDate)
    || value.startDate > value.endDate || !count(value.revision) || value.revision === 0) return false
  return { shiftId: value.shiftId, startDate: value.startDate, endDate: value.endDate, revision: value.revision }
}

// This validates the wire contract, never derives a posture from counts or reasons.
function base(value: Record<string, unknown>, groupId: string): FixedScheduleBase | null {
  if (value.groupId !== groupId || !isAttendanceGroupFixedScheduleStateV1(value.state)
    || !instant(value.evaluatedAt) || !Array.isArray(value.reasonCodes)) return null
  const reasons = value.reasonCodes
  if (!reasons.every((reason): reason is FixedScheduleReasonCode => typeof reason === 'string'
    && (FIXED_SCHEDULE_REASON_CODES as readonly string[]).includes(reason))
    || new Set(reasons).size !== reasons.length) return null
  const config = desired(value.desired)
  if (config === false || ((value.state === 'not_configured') !== (config === null))) return null
  return { groupId, state: value.state, reasonCodes: [...reasons], desired: config, evaluatedAt: value.evaluatedAt }
}
function envelope(value: unknown): Record<string, unknown> | null {
  return exact(value, ['ok', 'data']) && value.ok === true && record(value.data) ? value.data : null
}

export function parseFixedScheduleSelf(value: unknown, groupId: string): FixedScheduleSelf | null {
  const data = envelope(value)
  // Exact keys at every nested object reject aggregate fields and raw identities anywhere.
  if (!exact(data, ['groupId', 'state', 'reasonCodes', 'desired', 'applicability', 'evaluatedAt'])) return null
  const common = base(data, groupId)
  if (!common || (data.applicability !== 'not_configured' && data.applicability !== 'matching'
    && data.applicability !== 'non_matching')) return null
  if ((common.desired === null) !== (data.applicability === 'not_configured')) return null
  return { ...common, applicability: data.applicability }
}

export function parseFixedScheduleAdmin(value: unknown, groupId: string): FixedScheduleAdmin | null {
  const data = envelope(value)
  if (!exact(data, ['groupId', 'state', 'reasonCodes', 'desired', 'coverage', 'drift', 'evaluatedAt'])) return null
  const common = base(data, groupId)
  const coverage = data.coverage
  const drift = data.drift
  if (!common || !exact(coverage, ['targetMembers', 'matchingMembers', 'missingMembers', 'nonMemberTargets', 'differentKeyRows'])
    || !Object.values(coverage).every(count)
    || !exact(drift, ['unconfiguredManagedRows', 'unpublishedManagedRows', 'managedSets'])
    || !count(drift.unconfiguredManagedRows) || !count(drift.unpublishedManagedRows)
    || !Array.isArray(drift.managedSets)) return null
  const sets: FixedScheduleManagedSet[] = []
  for (const item of drift.managedSets) {
    if (!exact(item, ['shiftId', 'startDate', 'endDate', 'producerKey', 'rowCount'])
      || !text(item.shiftId) || !date(item.startDate)
      || (item.endDate !== null && (!date(item.endDate) || item.startDate > item.endDate))
      || !text(item.producerKey) || !count(item.rowCount) || item.rowCount === 0) return null
    sets.push({ shiftId: item.shiftId, startDate: item.startDate, endDate: item.endDate, producerKey: item.producerKey, rowCount: item.rowCount })
  }
  return {
    ...common,
    coverage: {
      targetMembers: coverage.targetMembers as number,
      matchingMembers: coverage.matchingMembers as number,
      missingMembers: coverage.missingMembers as number,
      nonMemberTargets: coverage.nonMemberTargets as number,
      differentKeyRows: coverage.differentKeyRows as number,
    },
    drift: { unconfiguredManagedRows: drift.unconfiguredManagedRows, unpublishedManagedRows: drift.unpublishedManagedRows, managedSets: sets },
  }
}
