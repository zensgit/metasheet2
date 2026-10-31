import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAttendanceLiveScheduledBoundaryV1,
  requireAttendanceRetainedCorrectionExecutionV1,
  type AttendanceLivePunchBoundaryInputV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import {
  createVerifiedAttendanceOperationIdentityV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
} from '../../src/attendance/w4c0-identity'
import { attendanceResultOperationPreflightV1 } from '../../src/attendance/w4c0-operation-registry'
import {
  loadRetainedAttendanceCorrectionsV1,
  validateRetainedAttendanceCorrectionWriteV1,
} from '../../src/attendance/approved-correction-target-source'
import { calculateAttendanceSegmentsV1 } from '../../src/attendance/w4c1-segment-calculator'
import { computeAttendanceOuterComparableSourceDefinitionFingerprintV1 } from '../../src/attendance/w4c1-fingerprints'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import type { ApprovedAttendanceFactV1, AttendanceEvidenceV1 } from '../../src/attendance/w4c0-write-boundary-types'
import { approvedCorrectionFixture } from '../utils/attendance-approved-correction-fixture'

type CarryWriter = typeof import('../../src/attendance/approved-correction-apply').writeRetainedApprovedCorrectionCalculationV1
type CarryArgs = Parameters<CarryWriter>
type CarryResult = Awaited<ReturnType<CarryWriter>>
const control = vi.hoisted(() => ({
  intercept: null as null | ((writer: CarryWriter, args: CarryArgs) => Promise<CarryResult>),
}))

// Mock only transaction/claim/source IO and activation adapters. The execution
// token is created by the real private live body, not by a test/public issuer.
// This is an unexecuted unit counterexample, with no native authority credit.
vi.mock('../../src/attendance/approved-correction-apply', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/attendance/approved-correction-apply')>()
  return { ...actual, writeRetainedApprovedCorrectionCalculationV1: async (...args: CarryArgs) => {
    if (!control.intercept) throw new Error('CARRY_INTERCEPT_REQUIRED')
    return control.intercept(actual.writeRetainedApprovedCorrectionCalculationV1, args)
  } }
})
vi.mock('../../src/attendance/approved-correction-target-source', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/attendance/approved-correction-target-source')>(),
  loadRetainedAttendanceCorrectionsV1: vi.fn(),
  validateRetainedAttendanceCorrectionWriteV1: vi.fn(async () => undefined),
}))
vi.mock('../../src/attendance/w4c0-identity', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/attendance/w4c0-identity')>(),
  acquireAttendanceCalculationRolloutLock: vi.fn(async () => undefined),
  acquireAttendanceCalculationTargetLocks: vi.fn(async () => undefined),
  resolveSegmentCalculationPosture: vi.fn(async () => ({ effectiveState: 'authoritative', writePosture: 'authoritative' })),
}))
vi.mock('../../src/attendance/w4c0-operation-registry', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/attendance/w4c0-operation-registry')>(),
  attendanceResultOperationPreflightV1: vi.fn(),
  runAttendanceResultOperationTransactionV1: vi.fn(async (
    client: AttendanceW4TransactionClientV1, body: (trx: AttendanceW4TransactionClientV1) => Promise<unknown>,
  ) => body(client)),
  enqueueAttendanceResultEventOutboxV1: vi.fn(async () => undefined),
  sealAttendanceResultOperationV1: vi.fn(async () => undefined),
}))

const id = (suffix: string) => '53080000-0000-4000-8000-' + suffix.padStart(12, '0')
const stopped = new Error('END_SCOPE_PROBE')
function fixture() {
  const f = approvedCorrectionFixture(id('1'), id('2'))
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({ orgId: f.context.orgId, acceptedWritePosture: 'authoritative' })
  const operation = createVerifiedAttendanceOperationIdentityV1({ org, kind: 'item', entrypoint: 'live_punch',
    source: { sourceKind: 'direct_live_punch', clientOperationId: id('3') } })
  const fact: ApprovedAttendanceFactV1 = {
    kind: 'correction', schemaVersion: 2, requestId: id('4'), requestSnapshotVersion: 1,
    requestSnapshotFingerprint: 'a'.repeat(64), approvalVersion: 2, approvalRecordId: '53',
    changes: [{ target: { kind: 'replacement', segmentIndex: 0, direction: 'check_in', evidenceRef: f.evidence[0].ref },
      occurredAt: f.instant('09:00'), adjustmentEvidenceRef: `correction:${id('4')}:check_in` }],
  }
  const adjustment: AttendanceEvidenceV1 = { kind: 'approved_adjustment', ref: fact.changes[0].adjustmentEvidenceRef,
    direction: 'check_in', occurredAt: f.instant('09:00'), source: 'correction' }
  const projection = calculateAttendanceSegmentsV1({ attribution: f.attribution, context: f.context,
    evidence: [...f.evidence, adjustment], approvedFacts: [fact] }).dailyProjection!
  const parent = { id: id('5'), workDate: f.context.workDate, status: projection.status,
    firstInAt: projection.firstInAt, lastOutAt: projection.lastOutAt, workMinutes: projection.workedMinutes,
    lateMinutes: projection.lateMinutes, earlyLeaveMinutes: projection.earlyLeaveMinutes,
    projectionOwner: 'w4', currentCalculationId: id('6'), visibilityState: 'active', visibilityReason: 'active' }
  const events = f.evidence.map(item => {
    if (item.kind !== 'punch') throw new Error('PUNCH_FIXTURE_REQUIRED')
    return { id: item.ref, event_type: item.direction, occurred_at: item.occurredAt, source: 'api' }
  })
  const queries: string[] = []
  const client = { query: vi.fn(async (sql: string) => {
    queries.push(sql)
    if (sql.includes('FROM attendance_records')) return { rows: [parent] }
    if (sql.includes('FROM attendance_events')) return { rows: events }
    throw new Error('UNEXPECTED_CARRY_QUERY')
  }) }
  vi.mocked(attendanceResultOperationPreflightV1).mockImplementation(async (trx, authorization) => {
    expect(trx).toBe(client)
    expect(authorization.actorId).toBe(f.context.userId)
    expect(authorization.subjectScope).toEqual({ kind: 'self', userId: f.context.userId })
    return { kind: 'claimed', org, itemIdentities: [operation], batchIdentity: null,
      legacyNullIdCount: 0, referenceSegments: true }
  })
  vi.mocked(loadRetainedAttendanceCorrectionsV1).mockResolvedValue({ approvedFacts: [fact], evidence: [adjustment],
    source: { recordId: parent.id, calculationId: id('6'), calculationVersion: 2, semanticInputFingerprint: 'b'.repeat(64) },
    sourceDefinitionFingerprint: null })
  const boundary = createAttendanceLiveScheduledBoundaryV1({
    acquireConnection: async () => ({ client, release: () => undefined }),
    legacyAdapters: {
      applyLivePunchLegacy: async () => { throw new Error('AUTHORITATIVE_LEGACY_CALL') },
      insertLivePunchEvent: async () => {
        const event = { id: id('7'), event_type: 'check_out' as const, occurred_at: f.instant('18:00'), source: 'api' }
        events.push(event)
        return event
      },
      deriveLivePunchWorkDateResolution: async () => null,
      resolveLiveCandidate: async () => ({ kind: 'resolved', workDate: f.context.workDate, shiftId: f.context.shiftId,
        frozenAttribution: f.attribution }),
      buildShadowFrozenContext: async () => f.context,
      issueFrozenContext: async () => ({ arm: 'legacy', context: f.context, reason: null }),
      applyScheduledAbsenceLegacy: async () => { throw new Error('LIVE_ONLY_TEST') },
      resolveScheduledCandidate: async () => { throw new Error('LIVE_ONLY_TEST') },
    },
  })
  const input: AttendanceLivePunchBoundaryInputV1 = {
    orgId: f.context.orgId, userId: f.context.userId, workDate: f.context.workDate, operationId: operation.id,
    eventType: 'check_out', occurredAtRaw: f.instant('18:00'), occurredAtResolved: f.instant('18:00'),
    timezone: 'UTC', requestTimezone: 'UTC', source: 'manual', location: null, meta: null, photoFileRef: null,
    shiftId: f.context.shiftId, isWorkday: true, holidayKind: null,
    outerSourceDefinitionFingerprint: computeAttendanceOuterComparableSourceDefinitionFingerprintV1({
      attribution: f.attribution, context: f.context }),
  }
  const result: CarryResult = { kind: 'completed', calculationId: id('8'), version: 3,
    supersedesCalculationId: id('6'), baselineCalculationId: null }
  return { client, org, operation, queries, boundary, input, result }
}

beforeEach(() => {
  vi.clearAllMocks()
  control.intercept = null
})

describe('A-SOURCE-08 retained correction execution scope (unit seams only)', () => {
  it.each(['actor', 'correlation', 'client', 'subject', 'date', 'factory-only'] as const)(
    'rejects initially wrong %s before source SQL or admission', async scenario => {
      const f = fixture()
      control.intercept = async (writer, args) => {
        const [client, input, org, operation, execution] = args
        expect(requireAttendanceRetainedCorrectionExecutionV1(client, execution, input, org, operation))
          .toEqual({ org, operation })
        const otherClient = { query: vi.fn(async () => { throw new Error('WRONG_CLIENT_QUERY') }) }
        const wrong = structuredClone(input)
        if (scenario === 'actor') Object.assign(wrong, { actorId: id('90') })
        if (scenario === 'correlation') Object.assign(wrong, { correlationId: 'substituted-correlation' })
        if (scenario === 'subject') Object.assign(wrong.context!, { userId: id('90') })
        if (scenario === 'date') Object.assign(wrong.context!, { workDate: '2049-08-22' })
        const before = [...f.queries]
        await expect(writer(scenario === 'client' ? otherClient : client, wrong, org, operation,
          scenario === 'factory-only' ? { org, operation, phase: 'execute' } : execution))
          .rejects.toThrow('ATTENDANCE_CORRECTION_OPERATION_REQUIRED')
        expect(f.queries).toEqual(before)
        expect(otherClient.query).not.toHaveBeenCalled()
        expect(validateRetainedAttendanceCorrectionWriteV1).not.toHaveBeenCalled()
        throw stopped
      }
      await expect(f.boundary.executeLivePunch(f.input)).rejects.toBe(stopped)
    },
  )

  it.each(['returned', 'threw'] as const)('revokes the exact token after the live writer %s', async exit => {
    const f = fixture()
    let saved: { writer: CarryWriter; args: CarryArgs } | undefined
    control.intercept = async (writer, args) => {
      saved = { writer, args }
      const [client, input, org, operation, execution] = args
      expect(requireAttendanceRetainedCorrectionExecutionV1(client, execution, input, org, operation))
        .toEqual({ org, operation })
      if (exit === 'threw') throw stopped
      return f.result
    }
    if (exit === 'threw') await expect(f.boundary.executeLivePunch(f.input)).rejects.toBe(stopped)
    else expect((await f.boundary.executeLivePunch(f.input)).kind).toBe('w4')
    expect(saved).toBeDefined()
    const before = [...f.queries]
    await expect(saved!.writer(...saved!.args)).rejects.toThrow('ATTENDANCE_CORRECTION_OPERATION_REQUIRED')
    expect(f.queries).toEqual(before)
    expect(validateRetainedAttendanceCorrectionWriteV1).not.toHaveBeenCalled()
  })
})
