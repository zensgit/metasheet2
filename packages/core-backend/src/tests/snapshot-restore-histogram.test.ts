import { describe, it, expect } from 'vitest'
import { metrics } from '../metrics/metrics'

// This test verifies snapshot histogram metric is properly registered
describe('Snapshot restore histogram presence', () => {
  it('has histogram metric registered', () => {
    // Verify the histogram exists and has the expected name
    expect(metrics.snapshotOperationDuration).toBeDefined()
  })

  it('can observe values for restore operation', async () => {
    // Observe a test value to verify the histogram works
    metrics.snapshotOperationDuration.observe({ operation: 'restore' }, 0.5)

    const prom = await metrics.snapshotOperationDuration.get()
    const buckets = prom.values.filter(v => v.metricName === 'metasheet_snapshot_operation_duration_seconds_bucket')
    const hasRestoreBuckets = buckets.some(b => b.labels.operation === 'restore')
    expect(hasRestoreBuckets).toBe(true)
  })
})
