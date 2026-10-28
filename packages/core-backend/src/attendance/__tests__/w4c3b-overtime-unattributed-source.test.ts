import { describe, expect, it, vi } from 'vitest'
import type { FrozenAttendanceContextV1, AttendanceAttributionSnapshotV1 } from '../w4c0-write-boundary-types'
import {
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
  type AttendanceRequestCalculationSnapshotRowV1,
  type AttendanceRequestTerminalSnapshotBindingV1,
} from '../w4c3b-request-snapshots'
import {
  validateApprovedOvertimeFrozenInputV1, buildBoundedApprovedOvertimeFactV1,
  assertFactLink,
} from '../w4c3b-approved-overtime-inputs'

import { calculateAttendanceSegmentsV1 } from '../w4c1-segment-calculator'
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

function minuteOnly(endpoints: 'none' | 'in' | 'out' = 'none') {
  const input = fixture()
  const request = {
    ...input.request,
    requested_in_at: endpoints === 'in' ? input.request.requested_in_at : null,
    requested_out_at: endpoints === 'out' ? input.request.requested_out_at : null,
  }
  const payload = { ...input.snapshot.payload, requestedInAt: request.requested_in_at, requestedOutAt: request.requested_out_at }
  const payloadFingerprint = computeAttendanceRequestPayloadFingerprintV1(payload)
  return { ...input, request, snapshot: { ...input.snapshot, payload, payloadFingerprint },
    binding: { ...input.binding, requestSnapshotFingerprint: payloadFingerprint } }
}

describe('DG-OT-01 snapshot-unattributed overtime (pure source and mocked link; not native proof)', () => {
  it.each(['none', 'in', 'out'] as const)('retains exact frozen minutes and unknown origin for endpoint posture %s', posture => {
    const input = minuteOnly(posture)
    const before = JSON.stringify(input)
    const frozen = validateApprovedOvertimeFrozenInputV1(input)
    const fact = buildBoundedApprovedOvertimeFactV1(frozen, input.binding)
    expect(fact).toEqual({
      kind: 'overtime', requestId: input.request.id, requestSnapshotVersion: 2,
      requestSnapshotFingerprint: input.snapshot.payloadFingerprint, approvalVersion: 3, approvalRecordId: '17',
      coverage: { kind: 'minutes_only_unbounded', minutes: 60, source: 'request_snapshot_unattributed' },
    })
    expect(calculateAttendanceSegmentsV1({
      attribution: frozen.attribution, context: frozen.context, evidence: [], approvedFacts: [fact],
    })).toEqual({ outcome: 'review_required', outcomeReasonCode: 'approved_fact_conflict', segments: [], dailyProjection: null })
    expect(JSON.stringify(input)).toBe(before)
    expect(computeAttendanceRequestPayloadFingerprintV1(input.snapshot.payload)).toBe(input.snapshot.payloadFingerprint)
    expect(Object.isFrozen(fact.coverage)).toBe(true)
  })

  it('keeps leave and illegal source enums outside the named overtime exception', () => {
    const input = minuteOnly()
    const frozen = validateApprovedOvertimeFrozenInputV1(input)
    const fact = buildBoundedApprovedOvertimeFactV1(frozen, input.binding)
    for (const invalid of [
      { ...fact, kind: 'leave', leaveType: 'annual' },
      { ...fact, coverage: { ...fact.coverage, source: 'unknown_source' } },
    ]) {
      expect(calculateAttendanceSegmentsV1({
        attribution: frozen.attribution, context: frozen.context, evidence: [], approvedFacts: [invalid],
      })).toEqual({ outcome: 'review_required', outcomeReasonCode: 'input_schema_invalid', segments: [], dailyProjection: null })
    }
  })

  it('rejects unknown minute origin when binding is forged or snapshot minutes drift', () => {
    const input = minuteOnly()
    const frozen = validateApprovedOvertimeFrozenInputV1(input)
    expect(() => buildBoundedApprovedOvertimeFactV1(frozen, { ...input.binding, approvalRecordId: '0' }))
      .toThrow('ATTENDANCE_OVERTIME_TERMINAL_BINDING_MISMATCH')
    expect(() => validateApprovedOvertimeFrozenInputV1({ ...input, request: {
      ...input.request, metadata: { minutes: 61 },
    } })).toThrow('ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH')
  })

  it('keeps a fully bounded fact bounded and leaves its physical control unchanged', () => {
    const input = fixture()
    const fact = buildBoundedApprovedOvertimeFactV1(validateApprovedOvertimeFrozenInputV1(input), input.binding)
    expect(fact.coverage).toEqual({ kind: 'bounded_interval', startAt: input.request.requested_in_at, endAt: input.request.requested_out_at, minutes: 60 })
  })

  it('revalidates inherited unbounded source against the real approval-row query and exact frozen endpoints', async () => {
    const input = minuteOnly()
    const frozen = validateApprovedOvertimeFrozenInputV1(input)
    const fact = buildBoundedApprovedOvertimeFactV1(frozen, input.binding)
    const source = {
      id: input.request.id, request_type: 'overtime', status: 'approved',
      metadata: { w4RequestSnapshotTerminalBinding: input.binding }, approval_instance_id: 'approval-fixture',
      payload: input.snapshot.payload, payload_fingerprint: input.snapshot.payloadFingerprint,
      subject_user_id: input.subjectUserId, snapshot_type: 'overtime',
      attribution_snapshot: input.snapshot.attributionSnapshot, context_snapshot: input.snapshot.contextSnapshot,
    }
    const query = vi.fn(async (sql: string) => sql.includes('JOIN attendance_request_calculation_snapshots')
      ? { rows: [source] } : { rows: [{ id: '17', from_version: 2, actor_id: 'actor' }] })
    const witness = { org: { orgId: input.orgId }, subjectUserId: input.subjectUserId, trx: { query } } as unknown as Parameters<typeof assertFactLink>[0]
    expect(await assertFactLink(witness, fact, frozen)).toBeNull()
    expect(query.mock.calls).toHaveLength(2)
    expect(query.mock.calls[1][0]).toContain("ar.action = 'approve'")
    expect(query.mock.calls[1][0]).toContain("ai.status = 'approved'")
    await expect(assertFactLink(witness, { ...fact, coverage: {
      kind: 'minutes_only_unbounded', minutes: 60, source: 'explicit_minutes',
    } }, frozen)).rejects.toThrow('ATTENDANCE_OVERTIME_MINUTES_PROVENANCE_UNRESOLVED')
    query.mockImplementation(async (sql: string) => sql.includes('JOIN attendance_request_calculation_snapshots')
      ? { rows: [source] } : { rows: [] })
    await expect(assertFactLink(witness, fact, frozen)).rejects.toThrow('ATTENDANCE_OVERTIME_TERMINAL_APPROVAL_MISMATCH')
  })
})
