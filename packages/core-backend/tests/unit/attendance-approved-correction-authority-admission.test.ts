import { describe, expect, it } from 'vitest'
import { writeAuthoritativeSegmentCalculationV1 } from '../../src/attendance/w4c2-authoritative-calculation-core'
import { appendBoundApprovedCorrectionCalculationV1 } from '../../src/attendance/w4c2-live-scheduled-boundary'

describe('approved correction public authority admission', () => {
  it.each(['invented approval target', 'substituted independent result'])('rejects %s before any query', async (scenario) => {
    const queries: string[] = []
    const trx = { query: async (sql: string) => { queries.push(sql); throw new Error('UNVERIFIED_QUERY_REACHED') } }
    const input = {
      orgId: 'synthetic-org', recordId: 'synthetic-record', entrypoint: 'correction',
      operationId: '00000000-0000-4000-8000-000000000001',
      approvedFacts: [{ kind: 'correction', schemaVersion: 2, requestId: 'synthetic-request',
        requestSnapshotVersion: 1, requestSnapshotFingerprint: 'a'.repeat(64),
        approvalVersion: 1, approvalRecordId: '1',
        changes: [{ target: { kind: 'replacement', segmentIndex: 0, direction: 'check_in',
          evidenceRef: 'not-an-approved-target' }, occurredAt: '2026-10-30T01:00:00.000Z',
          adjustmentEvidenceRef: 'synthetic-adjustment' }] }],
      calculation: { outcome: 'completed', dailyProjection: { workMinutes: scenario === 'substituted independent result' ? 999 : 1 } },
    } as unknown as Parameters<typeof writeAuthoritativeSegmentCalculationV1>[1]
    await expect(writeAuthoritativeSegmentCalculationV1(trx, input))
      .rejects.toThrow('ATTENDANCE_CORRECTION_WRITE_ADMISSION_REQUIRED')
    expect(queries).toEqual([])
  })

  it('rejects a caller-made operation and authoritative mode before source access', async () => {
    const queries: string[] = []
    const trx = { query: async (sql: string) => { queries.push(sql); return { rows: [] } } }
    const identity = { orgId: 'synthetic-org', userId: 'synthetic-user', requestId: 'synthetic-request',
      operationId: '00000000-0000-4000-8000-000000000001', actorId: 'synthetic-actor',
      correlationId: 'synthetic-correlation', mode: 'authoritative' as const }
    const append = appendBoundApprovedCorrectionCalculationV1 as unknown as (
      client: typeof trx, input: typeof identity, operation: unknown,
    ) => Promise<unknown>
    await expect(append(trx, identity, { ...identity, acceptedWritePosture: 'authoritative' }))
      .rejects.toThrow('ATTENDANCE_CORRECTION_OPERATION_REQUIRED')
    expect(queries).toEqual([])
  })
})
