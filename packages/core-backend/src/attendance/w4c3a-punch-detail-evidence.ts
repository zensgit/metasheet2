import {
  parseRawImportEvidenceV1,
  type RawImportEvidenceV1,
} from './w4c3a-legacy-execution-plan'
import {
  AttendancePunchDetailInputError,
  parseAttendancePunchDetailInputV1,
} from './w4c3a-punch-detail-input'

/**
 * Each physical event receives its own source ordinal. The existing V1 raw
 * parser still sees exactly one real endpoint; it is never widened to four.
 * This is evidence expansion only, not a prepared/authorized execution plan.
 */
export function expandAttendancePunchDetailEvidenceV1(
  value: unknown,
  batchId: string,
): readonly RawImportEvidenceV1[] {
  const input = parseAttendancePunchDetailInputV1(value)
  if (typeof batchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(batchId)) {
    throw new AttendancePunchDetailInputError()
  }
  const absent = { present: false, value: null } as const
  return Object.freeze(input.punches.map((punch, sourceOrdinal) => parseRawImportEvidenceV1({
    schemaVersion: 1,
    sourceOrdinal,
    punches: [punch],
    fields: {
      userId: { present: true, value: input.userId },
      workDate: { present: true, value: input.workDate },
      timezone: { present: true, value: input.timezone },
      firstInAt: punch.direction === 'check_in'
        ? { present: true, value: punch.occurredAt }
        : absent,
      lastOutAt: punch.direction === 'check_out'
        ? { present: true, value: punch.occurredAt }
        : absent,
      status: absent,
      isWorkday: absent,
    },
    metrics: {
      workMinutes: absent,
      lateMinutes: absent,
      earlyLeaveMinutes: absent,
      leaveMinutes: absent,
      overtimeMinutes: absent,
    },
    provenance: {
      transport: 'rows',
      sourceRef: 'attendance-import:' + batchId + ':punch_events_v1:' + sourceOrdinal,
      artifactSha256: null,
      normalizedCsvSha256: null,
      convertedSheetName: null,
    },
  })))
}
