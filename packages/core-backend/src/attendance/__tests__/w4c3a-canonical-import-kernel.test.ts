import { describe, expect, it, vi } from 'vitest'

import { inspectAttendanceCanonicalImportRegistryV1 } from '../w4c3a-canonical-import-kernel'
import { reservationIdentitiesFromJob } from '../w4c3a-legacy-plan-processor'
import type { AttendanceLegacyPlanWorkerJobV1 } from '../w4c3a-legacy-plan-worker'

function strictJob(): AttendanceLegacyPlanWorkerJobV1 {
  return {
    orgId: '20000000-0000-4000-8000-000000000001',
    batchId: '20000000-0000-4000-8000-000000000002',
    acceptedWritePosture: 'shadow',
    itemCount: 1,
    identityProofVector: [
      {
        ordinal: 0,
        semanticFingerprint: 'a'.repeat(64),
      },
    ],
  } as unknown as AttendanceLegacyPlanWorkerJobV1
}

describe('W4C-3a canonical import registry', () => {
  it('locks the batch row before issuing the ordered item-row lock', async () => {
    const job = strictJob()
    const identities = reservationIdentitiesFromJob(job)
    let releaseBatchRead: (() => void) | undefined
    const batchRead = new Promise<void>((resolve) => {
      releaseBatchRead = resolve
    })
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('attendance_result_operation_batches')) {
        await batchRead
        return { rows: [] }
      }
      return { rows: [] }
    })

    const inspected = inspectAttendanceCanonicalImportRegistryV1(
      { query },
      { job, identities },
    )
    await Promise.resolve()

    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'attendance_result_operation_batches',
    )

    releaseBatchRead?.()
    await expect(inspected).resolves.toBe('all_new')
    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[1]?.[0])).toContain(
      'attendance_result_operations',
    )
  })
})
