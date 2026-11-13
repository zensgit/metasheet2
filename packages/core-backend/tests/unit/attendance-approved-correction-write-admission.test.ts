import { describe, expect, it } from 'vitest'
import * as boundary from '../../src/attendance/w4c2-live-scheduled-boundary'

describe('approved correction shadow writer admission', () => {
  it('does not expose low-level shadow mutator while retaining a guarded correction entry', async () => {
    const exposed = boundary as unknown as Record<string, unknown>
    expect(exposed.insertShadowCalculation).toBeUndefined()
    expect(typeof exposed.appendBoundApprovedCorrectionCalculationV1).toBe('function')
    const queries: string[] = []
    const client = { query: async (sql: string) => { queries.push(sql); return { rows: [] } } }
    const guarded = exposed.appendBoundApprovedCorrectionCalculationV1 as (
      trx: typeof client, identity: Record<string, string>,
    ) => Promise<unknown>
    await expect(guarded(client, {
      orgId: 'synthetic-org', userId: 'synthetic-user', requestId: 'synthetic-request',
      operationId: '00000000-0000-4000-8000-000000000001', actorId: 'synthetic-actor',
      correlationId: 'synthetic-correlation', mode: 'shadow',
    })).rejects.toThrow('ATTENDANCE_CORRECTION_OPERATION_REQUIRED')
    expect(queries).toHaveLength(0)
    expect(queries.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true)
  })
})
