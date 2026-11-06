import { buildAttendanceImportAttributionFreezeV1, buildAttendanceImportPolicySourceProofV1 } from '../../w4c3a-import-proof'
import type { AttendancePunchDetailPreparationInputV1 } from '../../w4c3a-punch-detail-prepare'

export type PunchDetailFixtureKind = 'fold_start' | 'fold_end' | 'gap' | 'shared_fold'
export function punchDetailPreparationFixture(
  kind: PunchDetailFixtureKind = 'fold_start',
  scope: AttendancePunchDetailPreparationInputV1['scope'] = { orgId: '2ec9914b-5352-4f9a-a4ef-4c344c045ef1', actorId: 'punch-detail-admin',
    actorPosture: 'platform_admin' as const, tokenSubjectUserId: 'punch-detail-admin' },
  batchId = 'b62fe9a4-821f-4a2c-b917-0380dd12bd98',
  subject = { userId: 'punch-detail-employee', shiftId: 'punch-detail-shift' },
): AttendancePunchDetailPreparationInputV1 {
  const { userId, shiftId } = subject
  const workDate = kind === 'gap' ? '2026-03-08' : '2025-11-02'
  const timezone = 'America/New_York'
  const clocks = {
    fold_start: [['00:30', '00:45'], ['01:30', '03:00']],
    fold_end: [['00:30', '01:45'], ['02:00', '03:00']],
    gap: [['00:30', '01:00'], ['02:30', '04:00']],
    shared_fold: [['00:30', '01:30'], ['01:30', '03:00']],
  }[kind]
  const instants = {
    fold_start: ['04:30', '04:45', '05:30', '08:00'],
    fold_end: ['04:30', '06:45', '07:00', '08:00'],
    gap: ['05:30', '06:00', '07:30', '08:00'],
    shared_fold: ['04:30', '05:30', '06:30', '08:00'],
  }[kind].map((time) => workDate + 'T' + time + ':00.000Z')
  const end = kind === 'gap' ? '04:00' : '03:00'
  const window = { startAt: instants[0], endAt: instants[3] }
  const attribution = buildAttendanceImportAttributionFreezeV1({
    orgId: scope.orgId, userId, workDate, shiftId,
    reasonCode: 'SINGLE_MATCHING_CANDIDATE', resolvedAt: workDate + 'T12:00:00.000Z',
    timezone, workStartTime: '00:30', workEndTime: end, isOvernight: false,
    candidateAbsoluteWindow: window, candidateAttributionWindow: window,
    attributionTailMinutes: 0, approvedOvertimeWindows: [],
  })
  if (attribution.kind !== 'resolved_v2') throw new Error('PUNCH_DETAIL_FIXTURE_ATTRIBUTION_INVALID')
  return {
    scope, batchId, attribution, chunkConfig: { size: 100 },
    envelope: { __jobType: 'commit', idempotencyKey: null, __importEngine: 'standard',
      recordUpsertStrategy: 'values', itemsInsertStrategy: 'values', __w4ContractVersion: 1,
      __punchDetailInput: { inputKind: 'punch_events_v1', userId, workDate, timezone,
        punches: instants.map((occurredAt, index) => ({
          direction: index % 2 === 0 ? 'check_in' as const : 'check_out' as const, occurredAt,
        })) } },
    context: { schemaVersion: 1, selector: 'legacy', orgId: scope.orgId, userId, workDate, timezone,
      shiftId, isWorkday: true, holidayKind: null, calculationGroupId: null,
      roundingMinutes: 1, severeLateThresholdMinutes: 60, absenceLateThresholdMinutes: 240,
      segments: clocks.map(([startTime, endTime], index) => ({ index: index as 0 | 1,
        startTime, endTime, startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 })),
    },
    policySourceProof: buildAttendanceImportPolicySourceProofV1({
      ruleVersion: 'punch-detail-fixture', engineVersion: null,
      rule: { timezone, workStartTime: '00:30', workEndTime: end, lateGraceMinutes: 0, earlyGraceMinutes: 0,
        roundingMinutes: 1, severeLateThresholdMinutes: 60, absenceLateThresholdMinutes: 240,
        workingDays: [0, 1, 2, 3, 4, 5, 6] },
      policy: { appliedRules: [], userGroups: [] }, engine: null,
    }),
  }
}
