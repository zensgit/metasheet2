import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAttendanceOwningSessionUnitFixture,
  disposeAttendanceOwningSessionUnitFixtures,
} from '../helpers/attendance-owning-session-unit-fixture'
import { createAttendanceLegacyPlanProcessorV1 } from '../../src/attendance/w4c3a-legacy-plan-processor'

afterEach(disposeAttendanceOwningSessionUnitFixtures)

describe('W4C-3a processor connection lifecycle', () => {
  it('does not release the connection until the worker promise settles', async () => {
    let resolveCandidate!: (value: { rows: [] }) => void
    const candidate = new Promise<{ rows: [] }>((resolve) => {
      resolveCandidate = resolve
    })
    const client = {
      query: vi.fn(() => candidate),
    }
    const release = vi.fn()
    const owned = await createAttendanceOwningSessionUnitFixture(client.query, { onRelease: release })
    const processor = createAttendanceLegacyPlanProcessorV1({
      acquireConnection: async () => owned,
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
