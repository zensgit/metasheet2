import { describe, expect, it, vi } from 'vitest'
import { createAttendanceLegacyPlanProcessorV1 } from '../../src/attendance/w4c3a-legacy-plan-processor'

describe('W4C-3a processor connection lifecycle', () => {
  it('does not release the connection until the worker promise settles', async () => {
    let resolveCandidate!: (value: { rows: readonly [] }) => void
    const candidate = new Promise<{ rows: readonly [] }>((resolve) => {
      resolveCandidate = resolve
    })
    const client = {
      query: vi.fn(() => candidate),
    }
    const release = vi.fn()
    const processor = createAttendanceLegacyPlanProcessorV1({
      acquireConnection: async () => ({ client, release }),
    })

    const processing = processor.processLegacyImportPlanV1(
      '00000000-0000-4000-8000-000000000001',
    )
    await Promise.resolve()

    expect(client.query).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()

    resolveCandidate({ rows: [] })
    await expect(processing).resolves.toEqual({ kind: 'not_found' })
    expect(release).toHaveBeenCalledTimes(1)
  })
})
