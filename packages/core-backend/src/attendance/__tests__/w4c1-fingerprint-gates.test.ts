/**
 * W4C-1 (#4556) — fingerprint gates at the calculator level (lock 4.3, 7.3,
 * §12.2): the point-named occurredAt/semantic-hash leg, CSV/XLSX
 * semantic-vs-provenance split, approved-fact and business-time inclusion,
 * and the new source-definition fingerprint (stable across `resolvedAt`
 * re-resolution, sensitive to EVERY frozen policy field a current-context
 * reread could drift).
 */
import { describe, expect, it } from 'vitest'
import {
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from '../w4c0-fingerprints'
import {
  AttendanceW4SourceDefinitionFingerprintError,
  computeAttendanceSourceDefinitionFingerprintV1,
} from '../w4c1-fingerprints'
import { ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 } from '../w4c1-segment-calculator'

const HEX64 = /^[0-9a-f]{64}$/

function makeContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    selector: 'legacy',
    orgId: 'org-1',
    userId: 'user-1',
    workDate: '2026-07-01',
    timezone: 'Asia/Shanghai',
    shiftId: 'shift-1',
    isWorkday: true,
    holidayKind: null,
    calculationGroupId: null,
    roundingMinutes: 15,
    severeLateThresholdMinutes: 45,
    absenceLateThresholdMinutes: 90,
    segments: [
      {
        index: 0,
        startTime: '09:00',
        endTime: '18:00',
        startDayOffset: 0,
        endDayOffset: 0,
        lateGraceMinutes: 5,
        earlyLeaveGraceMinutes: 5,
      },
    ],
    ...overrides,
  }
}

function makeAttribution(valueOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    posture: 'resolved_v2',
    value: {
      schemaVersion: 2,
      resolverVersion: 'w2-resolver@3',
      orgId: 'org-1',
      userId: 'user-1',
      workDate: '2026-07-01',
      shiftId: 'shift-1',
      reasonCode: 'assignment_match',
      resolvedAt: '2026-07-02T00:05:00+08:00',
      absoluteWindow: { startAt: '2026-06-30T16:00:00Z', endAt: '2026-07-02T16:00:00Z' },
      attributionWindow: { startAt: '2026-06-30T20:00:00Z', endAt: '2026-07-01T20:00:00Z' },
      attributionTailMinutes: 240,
      extendedByApprovedOvertime: false,
      windowEvidenceFingerprint: 'a'.repeat(64),
      source: 'live_resolution',
      ...valueOverrides,
    },
  }
}

function semanticInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attribution: makeAttribution(),
    context: makeContext(),
    evidence: [
      {
        kind: 'punch',
        ref: 'ev-1',
        direction: 'check_in',
        occurredAt: '2026-07-01T00:58:00.000Z',
        source: 'attendance_event',
      },
      {
        kind: 'punch',
        ref: 'ev-2',
        direction: 'check_out',
        occurredAt: '2026-07-01T10:02:00.000Z',
        source: 'attendance_event',
      },
    ],
    approvedFacts: [
      {
        kind: 'leave',
        requestId: 'req-1',
        requestSnapshotVersion: 1,
        requestSnapshotFingerprint: 'f'.repeat(64),
        approvalVersion: 3,
        approvalRecordId: '101',
        leaveType: 'annual',
        coverage: {
          kind: 'bounded_interval',
          startAt: '2026-07-01T01:00:00.000Z',
          endAt: '2026-07-01T04:00:00.000Z',
          minutes: 180,
        },
      },
    ],
    manualOverride: null,
    mergePolicy: 'merge',
    calculationTier: 'segment_authoritative',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
    snapshotSchemaVersion: 1,
    ...overrides,
  }
}

describe('semantic fingerprint at the calculator level (lock 4.3)', () => {
  it('point-named gate: changing ONLY occurredAt on an otherwise identical evidence ref changes the semantic hash', () => {
    const base = computeAttendanceSemanticInputFingerprintV1(semanticInput())
    const shifted = computeAttendanceSemanticInputFingerprintV1(
      semanticInput({
        evidence: [
          {
            kind: 'punch',
            ref: 'ev-1',
            direction: 'check_in',
            occurredAt: '2026-07-01T00:59:00.000Z',
            source: 'attendance_event',
          },
          {
            kind: 'punch',
            ref: 'ev-2',
            direction: 'check_out',
            occurredAt: '2026-07-01T10:02:00.000Z',
            source: 'attendance_event',
          },
        ],
      }),
    )
    expect(base).toMatch(HEX64)
    expect(shifted).toMatch(HEX64)
    expect(shifted).not.toBe(base)
  })

  it('omitting an approved fact changes the semantic hash (approved-fact omission leg)', () => {
    const base = computeAttendanceSemanticInputFingerprintV1(semanticInput())
    const withoutFact = computeAttendanceSemanticInputFingerprintV1(
      semanticInput({ approvedFacts: [] }),
    )
    expect(withoutFact).not.toBe(base)
  })

  it('every business time is load-bearing: workDate, segment boundary, and fact interval all change the hash', () => {
    const base = computeAttendanceSemanticInputFingerprintV1(semanticInput())
    const workDateShift = computeAttendanceSemanticInputFingerprintV1(
      semanticInput({
        attribution: makeAttribution({ workDate: '2026-07-02' }),
      }),
    )
    const segmentShift = computeAttendanceSemanticInputFingerprintV1(
      semanticInput({
        context: makeContext({
          segments: [
            {
              index: 0,
              startTime: '09:30',
              endTime: '18:00',
              startDayOffset: 0,
              endDayOffset: 0,
              lateGraceMinutes: 5,
              earlyLeaveGraceMinutes: 5,
            },
          ],
        }),
      }),
    )
    const factIntervalShift = computeAttendanceSemanticInputFingerprintV1(
      semanticInput({
        approvedFacts: [
          {
            kind: 'leave',
            requestId: 'req-1',
            requestSnapshotVersion: 1,
            requestSnapshotFingerprint: 'f'.repeat(64),
            approvalVersion: 3,
            approvalRecordId: '101',
            leaveType: 'annual',
            coverage: {
              kind: 'bounded_interval',
              startAt: '2026-07-01T01:00:00.000Z',
              endAt: '2026-07-01T05:00:00.000Z',
              minutes: 240,
            },
          },
        ],
      }),
    )
    expect(new Set([base, workDateShift, segmentShift, factIntervalShift]).size).toBe(4)
  })

  it('the operational audit time resolvedAt is excluded: re-resolution does not change the semantic hash', () => {
    const base = computeAttendanceSemanticInputFingerprintV1(semanticInput())
    const reResolved = computeAttendanceSemanticInputFingerprintV1(
      semanticInput({
        attribution: makeAttribution({ resolvedAt: '2026-07-03T08:00:00+08:00' }),
      }),
    )
    expect(reResolved).toBe(base)
  })
})

describe('CSV/XLSX fingerprint split (lock 4.3)', () => {
  it('equivalent native CSV and client-converted XLSX share the semantic fingerprint and differ in provenance', () => {
    const semanticCsv = computeAttendanceSemanticInputFingerprintV1(semanticInput())
    const semanticXlsx = computeAttendanceSemanticInputFingerprintV1(semanticInput())
    expect(semanticXlsx).toBe(semanticCsv)

    const csvProvenance = computeAttendanceProvenanceFingerprintV1({
      transport: 'csv_upload',
      sourceRef: 'import-batch-1',
      artifactSha256: '1'.repeat(64),
      normalizedCsvSha256: '2'.repeat(64),
      convertedSheetName: null,
    })
    const xlsxProvenance = computeAttendanceProvenanceFingerprintV1({
      transport: 'xlsx_client_converted_csv',
      sourceRef: 'import-batch-1',
      artifactSha256: '3'.repeat(64),
      normalizedCsvSha256: '2'.repeat(64),
      convertedSheetName: 'Sheet1',
    })
    expect(csvProvenance).toMatch(HEX64)
    expect(xlsxProvenance).toMatch(HEX64)
    expect(xlsxProvenance).not.toBe(csvProvenance)
  })
})

describe('computeAttendanceSourceDefinitionFingerprintV1 (lock 7.3 / 8.1 step 7)', () => {
  it('is a 64-hex hash, stable across resolvedAt-only re-resolution', () => {
    const base = computeAttendanceSourceDefinitionFingerprintV1({
      attribution: makeAttribution(),
      context: makeContext(),
    })
    const reResolved = computeAttendanceSourceDefinitionFingerprintV1({
      attribution: makeAttribution({ resolvedAt: '2026-07-05T09:00:00+08:00' }),
      context: makeContext(),
    })
    expect(base).toMatch(HEX64)
    expect(reResolved).toBe(base)
  })

  it('changes when ANY frozen policy field drifts (current-context reread cannot pass the equality gate)', () => {
    const base = computeAttendanceSourceDefinitionFingerprintV1({
      attribution: makeAttribution(),
      context: makeContext(),
    })
    const drifted = [
      makeContext({ roundingMinutes: 10 }),
      makeContext({ severeLateThresholdMinutes: 30 }),
      makeContext({ absenceLateThresholdMinutes: 60 }),
      makeContext({ timezone: 'America/New_York' }),
      makeContext({ shiftId: 'shift-2' }),
      makeContext({
        segments: [
          {
            index: 0,
            startTime: '09:00',
            endTime: '18:00',
            startDayOffset: 0,
            endDayOffset: 0,
            lateGraceMinutes: 10,
            earlyLeaveGraceMinutes: 5,
          },
        ],
      }),
    ].map((context) =>
      computeAttendanceSourceDefinitionFingerprintV1({ attribution: makeAttribution(), context }),
    )
    const windowDrift = computeAttendanceSourceDefinitionFingerprintV1({
      attribution: makeAttribution({
        attributionWindow: { startAt: '2026-06-30T20:00:00Z', endAt: '2026-07-01T22:00:00Z' },
      }),
      context: makeContext(),
    })
    expect(new Set([base, ...drifted, windowDrift]).size).toBe(8)
  })

  it('is null exactly for the unsupported posture or an absent frozen context (lock 7.3 nullability)', () => {
    expect(
      computeAttendanceSourceDefinitionFingerprintV1({
        attribution: {
          posture: 'unsupported',
          sourceSchemaVersion: 1,
          reason: 'legacy_v1',
          sourceFingerprint: null,
        },
        context: null,
      }),
    ).toBeNull()
    expect(
      computeAttendanceSourceDefinitionFingerprintV1({
        attribution: makeAttribution(),
        context: null,
      }),
    ).toBeNull()
  })

  it('fails closed on malformed input', () => {
    for (const input of [
      null,
      {},
      { attribution: makeAttribution() },
      { attribution: { posture: 'guessed' }, context: makeContext() },
      { attribution: makeAttribution(), context: makeContext(), extra: 1 },
    ]) {
      expect(() => computeAttendanceSourceDefinitionFingerprintV1(input)).toThrowError(
        AttendanceW4SourceDefinitionFingerprintError,
      )
    }
  })
})
