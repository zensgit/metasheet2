import crypto from 'node:crypto'

import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import type {
  AttendanceAttributionSnapshotV1,
  FrozenWorkDateAttributionV2,
} from './w4c0-write-boundary-types'
import {
  buildFrozenImportWorkDateAttributionV2,
  type AttendanceFrozenAttributionBuildResultV1,
  type AttendanceImportFrozenAttributionBuildInputV1,
} from './w4c2-frozen-attribution'
import { parseAttendanceInstantMsV1 } from './w4c1-strict-time'

const INVALID = 'W4C3A_IMPORT_FREEZE_INVALID'

export const ATTENDANCE_IMPORT_POLICY_SOURCE_FINGERPRINT_DOMAIN_V1 =
  'metasheet2:attendance:w4c3a:import-policy-source-fingerprint:v1'

type PlainRecord = Record<string, unknown>

function fail(): never {
  throw new Error(INVALID)
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function exactRecord(value: unknown, keys: readonly string[]): PlainRecord {
  if (!isPlainRecord(value)) fail()
  const own = Object.getOwnPropertyNames(value).sort()
  const expected = [...keys].sort()
  if (
    own.length !== expected.length ||
    own.some((key, index) => key !== expected[index]) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail()
  }
  return value
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail()
  return value
}

function nullableString(value: unknown): string | null {
  return value === null ? null : nonEmptyString(value)
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}

function nonNegativeInteger(value: unknown): number {
  const parsed = nullableNonNegativeInteger(value)
  if (parsed === null) fail()
  return parsed
}

function canonicalJsonClone(value: unknown): unknown {
  try {
    return JSON.parse(canonicalAttendanceJsonV1(value))
  } catch {
    fail()
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function candidateWindow(value: unknown): Readonly<{ startAt: string; endAt: string }> {
  const row = exactRecord(value, ['startAt', 'endAt'])
  return Object.freeze({
    startAt: nonEmptyString(row.startAt),
    endAt: nonEmptyString(row.endAt),
  })
}

export type AttendanceImportAttributionReconstructionV1 = Readonly<{
  schemaVersion: 1
  timezone: string
  workStartTime: string
  workEndTime: string
  isOvernight: boolean
  candidateAbsoluteWindow: Readonly<{ startAt: string; endAt: string }>
  candidateAttributionWindow: Readonly<{ startAt: string; endAt: string }>
  attributionTailMinutes: number
  approvedOvertimeWindows: readonly Readonly<{
    requestId: string
    approvedEndAt: string
    anchor: unknown
  }>[]
}>

export type AttendanceImportAttributionFreezeBuildResultV1 =
  | Readonly<{
      kind: 'resolved_v2'
      attribution: Readonly<{
        posture: 'resolved_v2'
        value: FrozenWorkDateAttributionV2
      }>
      reconstruction: AttendanceImportAttributionReconstructionV1
    }>
  | Exclude<AttendanceFrozenAttributionBuildResultV1, { kind: 'resolved_v2' }>

function reconstructionFromInput(
  input: AttendanceImportFrozenAttributionBuildInputV1,
  attribution: FrozenWorkDateAttributionV2,
): AttendanceImportAttributionReconstructionV1 {
  const approvedOvertimeWindows = input.approvedOvertimeWindows
    .map((entry) =>
      Object.freeze({
        requestId: nonEmptyString(entry.requestId),
        approvedEndAt: new Date(parseAttendanceInstantMsV1(entry.approvedEndAt)).toISOString(),
        anchor: canonicalJsonClone(entry.anchor === undefined ? null : entry.anchor),
      }),
    )
    .sort((left, right) => compareStrings(left.requestId, right.requestId))
  return Object.freeze({
    schemaVersion: 1,
    timezone: nonEmptyString(input.timezone),
    workStartTime: nonEmptyString(input.workStartTime),
    workEndTime: nonEmptyString(input.workEndTime),
    isOvernight: input.isOvernight,
    candidateAbsoluteWindow: Object.freeze({ ...attribution.absoluteWindow }),
    candidateAttributionWindow: Object.freeze({ ...attribution.attributionWindow }),
    attributionTailMinutes: attribution.attributionTailMinutes,
    approvedOvertimeWindows: Object.freeze(approvedOvertimeWindows),
  })
}

/**
 * Closed import adapter. It is the only W4C3a surface that can produce an
 * import-resolution attribution plus the reconstruction evidence the kernel
 * later verifies.
 */
export function buildAttendanceImportAttributionFreezeV1(
  input: AttendanceImportFrozenAttributionBuildInputV1,
): AttendanceImportAttributionFreezeBuildResultV1 {
  const result = buildFrozenImportWorkDateAttributionV2(input)
  if (result.kind !== 'resolved_v2') return result
  return Object.freeze({
    kind: 'resolved_v2',
    attribution: result.attribution,
    reconstruction: reconstructionFromInput(input, result.attribution.value),
  })
}

function parseImportAttribution(value: unknown): AttendanceAttributionSnapshotV1 {
  const root = exactRecord(value, [
    'posture',
    ...(isPlainRecord(value) && value.posture === 'resolved_v2'
      ? ['value']
      : ['sourceSchemaVersion', 'reason', 'sourceFingerprint']),
  ])
  if (root.posture === 'unsupported') {
    if (
      root.sourceSchemaVersion !== null &&
      root.sourceSchemaVersion !== 0 &&
      root.sourceSchemaVersion !== 1
    ) {
      fail()
    }
    if (!['legacy_v1', 'missing', 'ambiguous', 'unresolved'].includes(String(root.reason))) fail()
    if (
      root.sourceFingerprint !== null &&
      (typeof root.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(root.sourceFingerprint))
    ) {
      fail()
    }
    return root as AttendanceAttributionSnapshotV1
  }
  if (root.posture !== 'resolved_v2') fail()
  const resolved = exactRecord(root.value, [
    'schemaVersion',
    'resolverVersion',
    'orgId',
    'userId',
    'workDate',
    'shiftId',
    'reasonCode',
    'resolvedAt',
    'absoluteWindow',
    'attributionWindow',
    'attributionTailMinutes',
    'extendedByApprovedOvertime',
    'windowEvidenceFingerprint',
    'source',
  ])
  exactRecord(resolved.absoluteWindow, ['startAt', 'endAt'])
  exactRecord(resolved.attributionWindow, ['startAt', 'endAt'])
  if (
    resolved.schemaVersion !== 2 ||
    typeof resolved.attributionTailMinutes !== 'number' ||
    !Number.isSafeInteger(resolved.attributionTailMinutes) ||
    resolved.attributionTailMinutes < 0 ||
    typeof resolved.extendedByApprovedOvertime !== 'boolean' ||
    typeof resolved.windowEvidenceFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(resolved.windowEvidenceFingerprint) ||
    resolved.source !== 'import_resolution'
  ) {
    fail()
  }
  for (const key of [
    'resolverVersion',
    'orgId',
    'userId',
    'workDate',
    'shiftId',
    'reasonCode',
    'resolvedAt',
  ]) {
    nonEmptyString(resolved[key])
  }
  nonEmptyString((resolved.absoluteWindow as PlainRecord).startAt)
  nonEmptyString((resolved.absoluteWindow as PlainRecord).endAt)
  nonEmptyString((resolved.attributionWindow as PlainRecord).startAt)
  nonEmptyString((resolved.attributionWindow as PlainRecord).endAt)
  return root as AttendanceAttributionSnapshotV1
}

function parseReconstruction(value: unknown): AttendanceImportAttributionReconstructionV1 {
  const root = exactRecord(value, [
    'schemaVersion',
    'timezone',
    'workStartTime',
    'workEndTime',
    'isOvernight',
    'candidateAbsoluteWindow',
    'candidateAttributionWindow',
    'attributionTailMinutes',
    'approvedOvertimeWindows',
  ])
  if (
    root.schemaVersion !== 1 ||
    typeof root.isOvernight !== 'boolean' ||
    !Array.isArray(root.approvedOvertimeWindows)
  ) {
    fail()
  }
  const approvedOvertimeWindows = root.approvedOvertimeWindows.map((value) => {
    const row = exactRecord(value, ['requestId', 'approvedEndAt', 'anchor'])
    return Object.freeze({
      requestId: nonEmptyString(row.requestId),
      approvedEndAt: nonEmptyString(row.approvedEndAt),
      anchor: canonicalJsonClone(row.anchor),
    })
  })
  return Object.freeze({
    schemaVersion: 1,
    timezone: nonEmptyString(root.timezone),
    workStartTime: nonEmptyString(root.workStartTime),
    workEndTime: nonEmptyString(root.workEndTime),
    isOvernight: root.isOvernight,
    candidateAbsoluteWindow: candidateWindow(root.candidateAbsoluteWindow),
    candidateAttributionWindow: candidateWindow(root.candidateAttributionWindow),
    attributionTailMinutes: nonNegativeInteger(root.attributionTailMinutes),
    approvedOvertimeWindows: Object.freeze(approvedOvertimeWindows),
  })
}

/**
 * Validates that a persisted import-resolution V2 value is exactly what the
 * closed adapter would have emitted from its persisted candidate evidence.
 */
export function verifyAttendanceImportAttributionSnapshotV1(input: Readonly<{
  attribution: unknown
  reconstruction: unknown
  expectedIdentity: Readonly<{ orgId: string; userId: string; workDate: string }>
}>): AttendanceAttributionSnapshotV1 {
  const attribution = parseImportAttribution(input.attribution)
  if (attribution.posture === 'unsupported') {
    if (input.reconstruction !== null) fail()
    return attribution
  }
  const value = attribution.value
  if (
    value.orgId !== input.expectedIdentity.orgId ||
    value.userId !== input.expectedIdentity.userId ||
    value.workDate !== input.expectedIdentity.workDate
  ) {
    fail()
  }
  const reconstruction = parseReconstruction(input.reconstruction)
  let rebuilt: AttendanceImportAttributionFreezeBuildResultV1
  try {
    rebuilt = buildAttendanceImportAttributionFreezeV1({
      orgId: value.orgId,
      userId: value.userId,
      workDate: value.workDate,
      shiftId: value.shiftId,
      reasonCode: value.reasonCode,
      resolvedAt: value.resolvedAt,
      timezone: reconstruction.timezone,
      workStartTime: reconstruction.workStartTime,
      workEndTime: reconstruction.workEndTime,
      isOvernight: reconstruction.isOvernight,
      candidateAbsoluteWindow: reconstruction.candidateAbsoluteWindow,
      candidateAttributionWindow: reconstruction.candidateAttributionWindow,
      attributionTailMinutes: reconstruction.attributionTailMinutes,
      approvedOvertimeWindows: reconstruction.approvedOvertimeWindows,
    })
  } catch {
    fail()
  }
  if (
    rebuilt.kind !== 'resolved_v2' ||
    canonicalAttendanceJsonV1(rebuilt.attribution) !== canonicalAttendanceJsonV1(attribution) ||
    canonicalAttendanceJsonV1(rebuilt.reconstruction) !== canonicalAttendanceJsonV1(reconstruction)
  ) {
    fail()
  }
  return attribution
}

export type AttendanceImportPolicySourceProjectionV1 = Readonly<{
  schemaVersion: 1
  ruleVersion: string
  engineVersion: string | null
  rule: Readonly<{
    timezone: string | null
    workStartTime: string | null
    workEndTime: string | null
    lateGraceMinutes: number | null
    earlyGraceMinutes: number | null
    roundingMinutes: number | null
    severeLateThresholdMinutes: number | null
    absenceLateThresholdMinutes: number | null
    workingDays: readonly number[]
  }>
  policy: Readonly<{
    appliedRules: readonly string[]
    userGroups: readonly string[]
  }>
  engine: Readonly<{ appliedRules: readonly string[] }> | null
}>

export type AttendanceImportPolicySourceProjectionInputV1 = Omit<
  AttendanceImportPolicySourceProjectionV1,
  'schemaVersion'
>

function normalizedStringSet(value: unknown): readonly string[] {
  if (!Array.isArray(value)) fail()
  return Object.freeze([...new Set(value.map(nonEmptyString))].sort(compareStrings))
}

function normalizedWorkingDays(value: unknown): readonly number[] {
  if (!Array.isArray(value)) fail()
  const days = value.map((day) => {
    if (!Number.isSafeInteger(day) || day < 0 || day > 6) fail()
    return day
  })
  return Object.freeze([...new Set(days)].sort((left, right) => left - right))
}

function normalizedRule(value: unknown): AttendanceImportPolicySourceProjectionV1['rule'] {
  const rule = exactRecord(value, [
    'timezone',
    'workStartTime',
    'workEndTime',
    'lateGraceMinutes',
    'earlyGraceMinutes',
    'roundingMinutes',
    'severeLateThresholdMinutes',
    'absenceLateThresholdMinutes',
    'workingDays',
  ])
  return Object.freeze({
    timezone: nullableString(rule.timezone),
    workStartTime: nullableString(rule.workStartTime),
    workEndTime: nullableString(rule.workEndTime),
    lateGraceMinutes: nullableNonNegativeInteger(rule.lateGraceMinutes),
    earlyGraceMinutes: nullableNonNegativeInteger(rule.earlyGraceMinutes),
    roundingMinutes: nullableNonNegativeInteger(rule.roundingMinutes),
    severeLateThresholdMinutes: nullableNonNegativeInteger(rule.severeLateThresholdMinutes),
    absenceLateThresholdMinutes: nullableNonNegativeInteger(rule.absenceLateThresholdMinutes),
    workingDays: normalizedWorkingDays(rule.workingDays),
  })
}

function normalizedPolicy(value: unknown): AttendanceImportPolicySourceProjectionV1['policy'] {
  const policy = exactRecord(value, ['appliedRules', 'userGroups'])
  return Object.freeze({
    appliedRules: normalizedStringSet(policy.appliedRules),
    userGroups: normalizedStringSet(policy.userGroups),
  })
}

function normalizedEngine(
  value: unknown,
  engineVersion: string | null,
): AttendanceImportPolicySourceProjectionV1['engine'] {
  if (engineVersion === null) {
    if (value !== null) fail()
    return null
  }
  const engine = exactRecord(value, ['appliedRules'])
  return Object.freeze({ appliedRules: normalizedStringSet(engine.appliedRules) })
}

export function buildAttendanceImportPolicySourceProjectionV1(
  input: AttendanceImportPolicySourceProjectionInputV1,
): AttendanceImportPolicySourceProjectionV1 {
  const root = exactRecord(input, ['ruleVersion', 'engineVersion', 'rule', 'policy', 'engine'])
  const engineVersion = nullableString(root.engineVersion)
  return Object.freeze({
    schemaVersion: 1,
    ruleVersion: nonEmptyString(root.ruleVersion),
    engineVersion,
    rule: normalizedRule(root.rule),
    policy: normalizedPolicy(root.policy),
    engine: normalizedEngine(root.engine, engineVersion),
  })
}

export function parseAttendanceImportPolicySourceProjectionV1(
  value: unknown,
): AttendanceImportPolicySourceProjectionV1 {
  const root = exactRecord(value, [
    'schemaVersion',
    'ruleVersion',
    'engineVersion',
    'rule',
    'policy',
    'engine',
  ])
  if (root.schemaVersion !== 1) fail()
  const projection = buildAttendanceImportPolicySourceProjectionV1({
    ruleVersion: root.ruleVersion as string,
    engineVersion: root.engineVersion as string | null,
    rule: root.rule as AttendanceImportPolicySourceProjectionV1['rule'],
    policy: root.policy as AttendanceImportPolicySourceProjectionV1['policy'],
    engine: root.engine as AttendanceImportPolicySourceProjectionV1['engine'],
  })
  if (canonicalAttendanceJsonV1(value) !== canonicalAttendanceJsonV1(projection)) fail()
  return projection
}

export function computeAttendanceImportPolicySourceFingerprintV1(
  projection: AttendanceImportPolicySourceProjectionV1,
): string {
  const verified = parseAttendanceImportPolicySourceProjectionV1(projection)
  return crypto
    .createHash('sha256')
    .update(ATTENDANCE_IMPORT_POLICY_SOURCE_FINGERPRINT_DOMAIN_V1, 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalAttendanceJsonV1(verified), 'utf8')
    .digest('hex')
}

export function verifyAttendanceImportPolicySourceFingerprintV1(input: Readonly<{
  sourceDefinition: unknown
  sourceFingerprint: unknown
}>): AttendanceImportPolicySourceProjectionV1 {
  if (typeof input.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(input.sourceFingerprint)) {
    fail()
  }
  const projection = parseAttendanceImportPolicySourceProjectionV1(input.sourceDefinition)
  if (computeAttendanceImportPolicySourceFingerprintV1(projection) !== input.sourceFingerprint) fail()
  return projection
}
