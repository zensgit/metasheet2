import { describe, expect, it } from 'vitest'
import type { FrozenAttendanceContextV1, AttendanceAttributionSnapshotV1 } from '../w4c0-write-boundary-types'
import {
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
  type AttendanceRequestCalculationSnapshotRowV1,
  type AttendanceRequestTerminalSnapshotBindingV1,
} from '../w4c3b-request-snapshots'
import {
  validateApprovedOvertimeFrozenInputV1, buildBoundedApprovedOvertimeFactV1,
  validateApprovedOvertimeSnapshotInputV1, validateMissingApprovedOvertimeBindingV1,
} from '../w4c3b-approved-overtime-inputs'

function fixture() {
  const context: FrozenAttendanceContextV1 = {
    schemaVersion: 1, selector: 'legacy', orgId: 'writer-preservation-org',
    userId: 'writer-preservation-user', workDate: '2026-10-27', timezone: 'UTC',
    shiftId: 'writer-preservation-shift', isWorkday: true, holidayKind: null,
    calculationGroupId: null, roundingMinutes: 1,
    severeLateThresholdMinutes: 45, absenceLateThresholdMinutes: 90,
    segments: [{
      index: 0, startTime: '09:00', endTime: '17:00', startDayOffset: 0, endDayOffset: 0,
      lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0,
    }],
  }
  const window = { startAt: '2026-10-27T00:00:00.000Z', endAt: '2026-10-28T00:00:00.000Z' }
  const attribution: AttendanceAttributionSnapshotV1 = {
    posture: 'resolved_v2',
    value: {
      schemaVersion: 2, resolverVersion: 'w2-resolver@3',
      orgId: context.orgId, userId: context.userId, workDate: context.workDate,
      shiftId: context.shiftId, reasonCode: 'assignment_match',
      resolvedAt: '2026-10-27T00:00:00.000Z', absoluteWindow: window,
      attributionWindow: window, attributionTailMinutes: 240,
      extendedByApprovedOvertime: false, windowEvidenceFingerprint: 'a'.repeat(64),
      source: 'request_creation',
    },
  }

  const request = {
    id: '60000000-0000-4000-8000-000000000006', org_id: context.orgId,
    user_id: context.userId, request_type: 'overtime', work_date: context.workDate,
    requested_in_at: '2026-10-27T17:00:00.000Z', requested_out_at: '2026-10-27T18:00:00.000Z',
    reason: 'synthetic overtime', metadata: { minutes: 60 },
  }
  const payload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
    workDate: request.work_date, requestedInAt: request.requested_in_at,
    requestedOutAt: request.requested_out_at, reason: request.reason, minutes: 60,
  })
  const snapshot: AttendanceRequestCalculationSnapshotRowV1 = {
    orgId: context.orgId, subjectUserId: context.userId, requestId: request.id,
    requestType: 'overtime', version: 2, payload,
    payloadFingerprint: computeAttendanceRequestPayloadFingerprintV1(payload),
    attributionSnapshot: attribution, contextSnapshot: context, createdBy: context.userId,
  }
  const binding: AttendanceRequestTerminalSnapshotBindingV1 = {
    schemaVersion: 1, kind: 'w4c3b_request_snapshot_terminal_binding',
    orgId: context.orgId, subjectUserId: context.userId, requestId: request.id,
    requestType: 'overtime', requestSnapshotVersion: 2, requestSnapshotFingerprint: snapshot.payloadFingerprint,
    approvalVersion: 3, approvalRecordId: '17', action: 'approve', bindingPosture: 'bound',
  }
  return { orgId: context.orgId, subjectUserId: context.userId, request, snapshot, binding }
}

describe('EP01 overtime frozen input (pure, no transaction proof)', () => {
  it('uses the exact creation context/window and exact returned terminal binding, without mutating input', () => {
    const input = fixture()
    const before = JSON.stringify(input)
    const frozen = validateApprovedOvertimeFrozenInputV1(input)
    expect(frozen.context).toEqual(input.snapshot.contextSnapshot)
    expect(frozen.attribution).toEqual(input.snapshot.attributionSnapshot)
    expect(buildBoundedApprovedOvertimeFactV1(frozen, input.binding)).toEqual({
      kind: 'overtime', requestId: input.request.id, requestSnapshotVersion: 2,
      requestSnapshotFingerprint: input.snapshot.payloadFingerprint,
      approvalVersion: 3, approvalRecordId: '17',
      coverage: { kind: 'bounded_interval', startAt: input.request.requested_in_at, endAt: input.request.requested_out_at, minutes: 60 },
    })
    expect(JSON.stringify(input)).toBe(before)
  })

  it.each(['org_id', 'user_id', 'id', 'request_type'] as const)('rejects changed request identity %s', (field) => {
    const input = fixture()
    input.request[field] = 'foreign'
    expect(() => validateApprovedOvertimeFrozenInputV1(input)).toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_IDENTITY_MISMATCH')
  })

  it.each(['requested_in_at', 'requested_out_at', 'work_date', 'reason'] as const)('rejects mutable request drift %s', (field) => {
    const input = fixture()
    input.request[field] = field === 'reason' ? 'changed' : field === 'work_date' ? '2026-10-28' : '2026-10-27T16:00:00.000Z'
    expect(() => validateApprovedOvertimeFrozenInputV1(input)).toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH')
  })

  it('rejects request minute drift and snapshot fingerprint corruption', () => {
    const input = fixture()
    input.request.metadata.minutes = 61
    expect(() => validateApprovedOvertimeFrozenInputV1(input)).toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH')
    const good = fixture()
    expect(() => validateApprovedOvertimeFrozenInputV1({ ...good, snapshot: { ...good.snapshot, payloadFingerprint: 'f'.repeat(64) } }))
      .toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH')
  })

  it.each(['orgId', 'userId', 'workDate', 'shiftId'] as const)('rejects frozen context identity drift %s', (field) => {
    const input = fixture()
    const context = { ...input.snapshot.contextSnapshot!, [field]: field === 'workDate' ? '2026-10-28' : 'foreign' }
    expect(() => validateApprovedOvertimeFrozenInputV1({ ...input, snapshot: { ...input.snapshot, contextSnapshot: context } }))
      .toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_CONTEXT_MISMATCH')
  })

  it('refuses unsupported historical input rather than resolving current policy or calendar date', () => {
    const input = fixture()
    expect(() => validateApprovedOvertimeFrozenInputV1({
      ...input, snapshot: { ...input.snapshot, contextSnapshot: null, attributionSnapshot: {
        posture: 'unsupported', sourceSchemaVersion: 1, reason: 'legacy_v1', sourceFingerprint: null,
      } },
    })).toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
  })

  it.each([
    { action: 'reject' }, { orgId: 'foreign' }, { subjectUserId: 'foreign' }, { requestId: 'foreign' },
    { requestSnapshotVersion: 1 }, { requestSnapshotFingerprint: 'e'.repeat(64) },
    { approvalVersion: 0 }, { approvalRecordId: '0' }, { bindingPosture: 'unsupported_pre_w4_shadow' },
  ])('rejects incongruent terminal binding %j', (patch) => {
    const input = fixture()
    expect(() => buildBoundedApprovedOvertimeFactV1(validateApprovedOvertimeFrozenInputV1(input), {
      ...input.binding, ...patch,
    } as AttendanceRequestTerminalSnapshotBindingV1)).toThrow('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
  })

  it('rejects tampered immutable payload even when the locked request still matches the stored fingerprint', () => {
    const input = fixture()
    expect(() => validateApprovedOvertimeFrozenInputV1({
      ...input, snapshot: { ...input.snapshot, payload: { ...input.snapshot.payload, minutes: 61 } },
    })).toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH')
  })

  it('does not fabricate minute-only provenance when endpoints are absent', () => {
    const input = fixture()
    const payload = { ...input.snapshot.payload, requestedInAt: null, requestedOutAt: null }
    const payloadFingerprint = computeAttendanceRequestPayloadFingerprintV1(payload)
    const snapshot = { ...input.snapshot, payload, payloadFingerprint }
    const frozen = validateApprovedOvertimeFrozenInputV1({
      ...input, snapshot, request: { ...input.request, requested_in_at: null, requested_out_at: null },
    })
    expect(buildBoundedApprovedOvertimeFactV1(frozen, { ...input.binding, requestSnapshotFingerprint: payloadFingerprint }).coverage)
      .toEqual({ kind: 'minutes_only_unbounded', minutes: 60, source: 'request_snapshot_unattributed' })
  })
})

describe('EP01 shadow frozen input admission (pure, no transaction proof)', () => {
  it.each(['legacy_v1', 'missing', 'ambiguous', 'unresolved'] as const)(
    'retains exact unsupported %s attribution and context with a real bounded fact',
    (reason) => {
      const input = fixture()
      const attribution: AttendanceAttributionSnapshotV1 = {
        posture: 'unsupported', sourceSchemaVersion: 1, reason, sourceFingerprint: 'b'.repeat(64),
      }
      const snapshot = { ...input.snapshot, attributionSnapshot: attribution }
      const frozen = validateApprovedOvertimeSnapshotInputV1({ ...input, snapshot })
      expect(frozen.attribution).toEqual(attribution)
      expect(frozen.context).toEqual(input.snapshot.contextSnapshot)
      expect(buildBoundedApprovedOvertimeFactV1(frozen, input.binding)).toEqual({
        kind: 'overtime', requestId: input.request.id, requestSnapshotVersion: 2,
        requestSnapshotFingerprint: input.snapshot.payloadFingerprint,
        approvalVersion: 3, approvalRecordId: '17',
        coverage: { kind: 'bounded_interval', startAt: input.request.requested_in_at, endAt: input.request.requested_out_at, minutes: 60 },
      })
      expect(() => validateApprovedOvertimeFrozenInputV1({ ...input, snapshot }))
        .toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
    },
  )

  it('allows real resolved attribution with missing context only for shadow admission', () => {
    const input = fixture()
    const snapshot = { ...input.snapshot, contextSnapshot: null }
    const frozen = validateApprovedOvertimeSnapshotInputV1({ ...input, snapshot })
    expect(frozen.context).toBeNull()
    expect(frozen.attribution).toEqual(input.snapshot.attributionSnapshot)
    expect(buildBoundedApprovedOvertimeFactV1(frozen, input.binding).requestSnapshotVersion).toBe(2)
    expect(() => validateApprovedOvertimeFrozenInputV1({ ...input, snapshot }))
      .toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_UNSUPPORTED')
  })

  it('does not launder payload corruption or foreign context as unsupported review', () => {
    const input = fixture()
    const snapshot = { ...input.snapshot, attributionSnapshot: {
      posture: 'unsupported' as const, sourceSchemaVersion: 1 as const, reason: 'legacy_v1' as const,
      sourceFingerprint: null,
    } }
    expect(() => validateApprovedOvertimeSnapshotInputV1({
      ...input, snapshot: { ...snapshot, payloadFingerprint: 'f'.repeat(64) },
    })).toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH')
    expect(() => validateApprovedOvertimeSnapshotInputV1({
      ...input, snapshot: { ...snapshot, contextSnapshot: { ...snapshot.contextSnapshot!, userId: 'foreign' } },
    })).toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_CONTEXT_MISMATCH')
  })

  it('rejects unknown unsupported attribution enums', () => {
    const input = fixture()
    expect(() => validateApprovedOvertimeSnapshotInputV1({
      ...input, snapshot: { ...input.snapshot, attributionSnapshot: {
        posture: 'unsupported', sourceSchemaVersion: 1, reason: 'unknown', sourceFingerprint: null,
      } as unknown as AttendanceAttributionSnapshotV1 },
    })).toThrow('Invalid request snapshot input')
  })

  it('accepts the exact missing-snapshot binding marker without promoting it to a fact', () => {
    const input = fixture()
    const binding: AttendanceRequestTerminalSnapshotBindingV1 = {
      ...input.binding, bindingPosture: 'unsupported_pre_w4_shadow',
      requestSnapshotVersion: 0, requestSnapshotFingerprint: '0'.repeat(64),
    }
    expect(validateMissingApprovedOvertimeBindingV1(input.request, binding)).toBeUndefined()
    expect(() => buildBoundedApprovedOvertimeFactV1(validateApprovedOvertimeSnapshotInputV1(input), binding))
      .toThrow('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
  })

  it.each([
    { action: 'reject' }, { orgId: 'foreign' }, { subjectUserId: 'foreign' },
    { requestId: 'foreign' }, { requestType: 'leave' }, { requestSnapshotVersion: 1 },
    { requestSnapshotFingerprint: 'e'.repeat(64) }, { approvalVersion: 0 },
    { approvalRecordId: '0' }, { bindingPosture: 'bound' },
  ])('rejects a forged missing-snapshot binding %j', (patch) => {
    const input = fixture()
    expect(() => validateMissingApprovedOvertimeBindingV1(input.request, {
      ...input.binding, bindingPosture: 'unsupported_pre_w4_shadow',
      requestSnapshotVersion: 0, requestSnapshotFingerprint: '0'.repeat(64), ...patch,
    } as AttendanceRequestTerminalSnapshotBindingV1)).toThrow('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
  })
})
