import { describe, expect, it } from 'vitest'
import { assertLegacyGoldenCompletedJobTiming } from '../utils/attendance-legacy-golden-timing'

describe('legacy golden completed job timing', () => {
  it.each([
    { elapsedMs: 0, processedRows: 1, throughputRowsPerSec: 0 },
    { elapsedMs: 1000, processedRows: 1, throughputRowsPerSec: 1 },
    { elapsedMs: 333, processedRows: 2, throughputRowsPerSec: 6.01 },
    { elapsedMs: 1000, processedRows: 0, throughputRowsPerSec: 0 },
  ])('accepts valid timing %#', (job) => {
    expect(() => assertLegacyGoldenCompletedJobTiming(job)).not.toThrow()
  })

  it.each([
    { elapsedMs: -1, throughputRowsPerSec: 0 },
    { elapsedMs: 0.5, processedRows: 0, throughputRowsPerSec: 0 },
    { elapsedMs: Number.NaN, throughputRowsPerSec: 0 },
    { elapsedMs: Number.POSITIVE_INFINITY, throughputRowsPerSec: 0 },
    { elapsedMs: '1000' },
    { processedRows: -1, elapsedMs: 0, throughputRowsPerSec: 0 },
    { processedRows: 0.5 },
    { processedRows: '1' },
    { throughputRowsPerSec: -1 },
    { throughputRowsPerSec: Number.NaN },
    { throughputRowsPerSec: Number.POSITIVE_INFINITY },
    { throughputRowsPerSec: '1' },
    { throughputRowsPerSec: 0 },
    { elapsedMs: 0, throughputRowsPerSec: 1 },
  ])('rejects invalid timing %#', (override) => {
    expect(() => assertLegacyGoldenCompletedJobTiming({
      elapsedMs: 1000,
      processedRows: 1,
      throughputRowsPerSec: 1,
      ...override,
    })).toThrow('LEGACY_GOLDEN_COMPLETED_TIMING_INVALID')
  })
})
