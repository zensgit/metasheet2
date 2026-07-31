import type {
  RawImportEvidenceV1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'

type PresenceValue<T> = T | null | undefined

export type RawImportEvidenceOptionsV1 = Readonly<{
  userId?: PresenceValue<string>
  workDate?: PresenceValue<string>
  timezone?: PresenceValue<string>
  firstInAt?: PresenceValue<string>
  lastOutAt?: PresenceValue<string>
  status?: PresenceValue<string>
  isWorkday?: PresenceValue<boolean>
  workMinutes?: PresenceValue<number>
  lateMinutes?: PresenceValue<number>
  earlyLeaveMinutes?: PresenceValue<number>
  leaveMinutes?: PresenceValue<number>
  overtimeMinutes?: PresenceValue<number>
  transport?: RawImportEvidenceV1['provenance']['transport']
  sourceRef?: string
}>

function presence<T>(value: PresenceValue<T>): { present: boolean; value: T | null } {
  return value === undefined
    ? { present: false, value: null }
    : { present: true, value }
}

/** Small, valid evidence fixture for plan-item tests. */
export function rawImportEvidenceV1(
  sourceOrdinal: number,
  options: RawImportEvidenceOptionsV1 = {},
): RawImportEvidenceV1 {
  const firstInAt = options.firstInAt
  const lastOutAt = options.lastOutAt
  return {
    schemaVersion: 1,
    sourceOrdinal,
    punches: [
      ...(typeof firstInAt === 'string'
        ? [{ direction: 'check_in' as const, occurredAt: firstInAt }]
        : []),
      ...(typeof lastOutAt === 'string'
        ? [{ direction: 'check_out' as const, occurredAt: lastOutAt }]
        : []),
    ],
    fields: {
      userId: presence(options.userId),
      workDate: presence(options.workDate),
      timezone: presence(options.timezone),
      firstInAt: presence(firstInAt),
      lastOutAt: presence(lastOutAt),
      status: presence(options.status),
      isWorkday: presence(options.isWorkday),
    },
    metrics: {
      workMinutes: presence(options.workMinutes),
      lateMinutes: presence(options.lateMinutes),
      earlyLeaveMinutes: presence(options.earlyLeaveMinutes),
      leaveMinutes: presence(options.leaveMinutes),
      overtimeMinutes: presence(options.overtimeMinutes),
    },
    provenance: {
      transport: options.transport ?? 'rows',
      sourceRef: options.sourceRef ?? `w4c3a-test-source:${sourceOrdinal}`,
      artifactSha256: null,
      normalizedCsvSha256: null,
      convertedSheetName: null,
    },
  }
}
