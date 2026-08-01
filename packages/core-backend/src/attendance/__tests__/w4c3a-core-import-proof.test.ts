import crypto from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { canonicalAttendanceJsonV1 } from '../w4c0-fingerprints'
import {
  validateAttendanceCanonicalImportFreezeV1,
} from '../w4c3a-canonical-import-kernel'
import {
  ATTENDANCE_IMPORT_POLICY_SOURCE_FINGERPRINT_DOMAIN_V1,
  buildAttendanceImportAttributionFreezeV1,
  buildAttendanceImportPolicySourceProjectionV1,
  computeAttendanceImportPolicySourceFingerprintV1,
} from '../w4c3a-import-proof'
import type { LegacyImportRecordWritePlanV1 } from '../w4c3a-legacy-execution-plan'
import type { AttendanceImportFrozenAttributionBuildInputV1 } from '../w4c2-frozen-attribution'

const ORG_ID = 'org-w4c3a-import'
const USER_ID = 'user-w4c3a-import'
const WORK_DATE = '2026-07-20'
const SHIFT_ID = 'shift-w4c3a-import'
const ABSOLUTE_START = '2026-07-20T01:00:00.000Z'
const ABSOLUTE_END = '2026-07-20T10:00:00.000Z'

function attributionInput(
  overrides: Partial<AttendanceImportFrozenAttributionBuildInputV1> = {},
): AttendanceImportFrozenAttributionBuildInputV1 {
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    workDate: WORK_DATE,
    shiftId: SHIFT_ID,
    reasonCode: 'SINGLE_MATCHING_CANDIDATE',
    resolvedAt: '2026-07-20T02:00:00.000Z',
    timezone: 'Asia/Shanghai',
    workStartTime: '09:00',
    workEndTime: '18:00',
    isOvernight: false,
    candidateAbsoluteWindow: { startAt: ABSOLUTE_START, endAt: ABSOLUTE_END },
    candidateAttributionWindow: { startAt: ABSOLUTE_START, endAt: ABSOLUTE_END },
    attributionTailMinutes: 0,
    approvedOvertimeWindows: [],
    ...overrides,
  }
}

function resolvedAttribution() {
  const result = buildAttendanceImportAttributionFreezeV1(attributionInput())
  if (result.kind !== 'resolved_v2') throw new Error('expected resolved import attribution')
  return result
}

function policySource(workStartTime = '09:00') {
  return buildAttendanceImportPolicySourceProjectionV1({
    ruleVersion: 'rule-set:strict-import',
    engineVersion: 'attendance-rule-engine@1',
    rule: {
      timezone: 'Asia/Shanghai',
      workStartTime,
      workEndTime: '18:00',
      lateGraceMinutes: 0,
      earlyGraceMinutes: 0,
      roundingMinutes: 1,
      severeLateThresholdMinutes: 30,
      absenceLateThresholdMinutes: 60,
      workingDays: [5, 3, 1],
    },
    policy: {
      appliedRules: ['late-policy', 'absence-policy'],
      userGroups: ['engineering', 'day-shift'],
    },
    engine: {
      appliedRules: ['round-work-minutes'],
    },
  })
}

function canonicalWrite(
  sourceDefinition = policySource(),
): LegacyImportRecordWritePlanV1 {
  const attribution = resolvedAttribution()
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    workDate: WORK_DATE,
    sourceOrdinals: [0],
    attributionSnapshot: {
      schemaVersion: 2,
      sources: [
        {
          sourceOrdinal: 0,
          attribution: attribution.attribution,
          context: null,
          importAttributionReconstruction: attribution.reconstruction,
        },
      ],
    },
    policySnapshot: {
      schemaVersion: 2,
      sources: [
        {
          sourceOrdinal: 0,
          sourceDefinition,
          sourceFingerprint: computeAttendanceImportPolicySourceFingerprintV1(sourceDefinition),
          output: {
            status: 'normal',
            workMinutes: 480,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            leaveMinutes: 0,
            overtimeMinutes: 0,
          },
        },
      ],
    },
  } as LegacyImportRecordWritePlanV1
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('W4C-3a core import attribution proof', () => {
  it('uses the strict W4C2 reconstruction for import resolution', () => {
    const resolved = resolvedAttribution()
    expect(resolved.attribution.value.source).toBe('import_resolution')
    expect(resolved.attribution.value.absoluteWindow).toEqual({
      startAt: ABSOLUTE_START,
      endAt: ABSOLUTE_END,
    })

    const mismatch = buildAttendanceImportAttributionFreezeV1(
      attributionInput({
        candidateAbsoluteWindow: {
          startAt: '2026-07-20T02:00:00.000Z',
          endAt: ABSOLUTE_END,
        },
        candidateAttributionWindow: {
          startAt: '2026-07-20T02:00:00.000Z',
          endAt: ABSOLUTE_END,
        },
      }),
    )
    expect(mismatch).toEqual({
      kind: 'not_reconstructible',
      code: 'W4C2_ATTRIBUTION_START_MISMATCH',
    })
  })

  it('refuses DST gaps and folds through the same import adapter', () => {
    const gap = buildAttendanceImportAttributionFreezeV1(
      attributionInput({
        workDate: '2026-03-08',
        timezone: 'America/New_York',
        workStartTime: '02:30',
        workEndTime: '11:00',
        candidateAbsoluteWindow: {
          startAt: '2026-03-08T07:30:00.000Z',
          endAt: '2026-03-08T15:00:00.000Z',
        },
        candidateAttributionWindow: {
          startAt: '2026-03-08T07:30:00.000Z',
          endAt: '2026-03-08T15:00:00.000Z',
        },
      }),
    )
    expect(gap).toEqual({
      kind: 'not_reconstructible',
      code: 'W4C2_ATTRIBUTION_START_NOT_UNIQUE',
    })

    const fold = buildAttendanceImportAttributionFreezeV1(
      attributionInput({
        workDate: '2026-11-01',
        timezone: 'America/New_York',
        workStartTime: '01:30',
        workEndTime: '09:00',
        candidateAbsoluteWindow: {
          startAt: '2026-11-01T05:30:00.000Z',
          endAt: '2026-11-01T14:00:00.000Z',
        },
        candidateAttributionWindow: {
          startAt: '2026-11-01T05:30:00.000Z',
          endAt: '2026-11-01T14:00:00.000Z',
        },
      }),
    )
    expect(fold).toEqual({
      kind: 'not_reconstructible',
      code: 'W4C2_ATTRIBUTION_START_NOT_UNIQUE',
    })
  })

  it('validates a resolved import snapshot and recomputes its policy-source fingerprint exactly', () => {
    const sourceDefinition = policySource()
    const expected = crypto
      .createHash('sha256')
      .update(ATTENDANCE_IMPORT_POLICY_SOURCE_FINGERPRINT_DOMAIN_V1, 'utf8')
      .update(Buffer.from([0]))
      .update(canonicalAttendanceJsonV1(sourceDefinition), 'utf8')
      .digest('hex')
    expect(computeAttendanceImportPolicySourceFingerprintV1(sourceDefinition)).toBe(expected)

    const write = canonicalWrite(sourceDefinition)
    expect(() => validateAttendanceCanonicalImportFreezeV1(write)).not.toThrow()

    const forged = copy(write)
    const forgedSource = (
      forged.policySnapshot as { sources: Array<{ sourceFingerprint: string }> }
    ).sources[0]
    forgedSource.sourceFingerprint = 'f'.repeat(64)
    expect(() => validateAttendanceCanonicalImportFreezeV1(forged)).toThrow(
      'W4C3A_IMPORT_FREEZE_INVALID',
    )
  })

  it('binds the fingerprint to rule definition rather than unchanged imported output metrics', () => {
    const original = policySource('09:00')
    const changedRule = policySource('08:30')
    expect(computeAttendanceImportPolicySourceFingerprintV1(changedRule)).not.toBe(
      computeAttendanceImportPolicySourceFingerprintV1(original),
    )

    const originalWrite = canonicalWrite(original)
    const changedWrite = canonicalWrite(changedRule)
    expect(
      (originalWrite.policySnapshot as { sources: Array<{ output: unknown }> }).sources[0].output,
    ).toEqual((changedWrite.policySnapshot as { sources: Array<{ output: unknown }> }).sources[0].output)
    expect(() => validateAttendanceCanonicalImportFreezeV1(changedWrite)).not.toThrow()
  })

  it('fails closed on unknown policy-definition keys', () => {
    const write = copy(canonicalWrite())
    const source = (
      write.policySnapshot as {
        sources: Array<{ sourceDefinition: Record<string, unknown> }>
      }
    ).sources[0]
    source.sourceDefinition.unexpected = 'not part of the sealed projection'

    expect(() => validateAttendanceCanonicalImportFreezeV1(write)).toThrow(
      'W4C3A_IMPORT_FREEZE_INVALID',
    )
  })
})
