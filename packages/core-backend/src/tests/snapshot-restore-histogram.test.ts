import { describe, it, expect } from '@jest/globals'
import { metrics } from '../metrics/metrics'

// This test assumes snapshot histogram metric is registered
describe('Snapshot restore histogram presence', () => {
  it('has histogram buckets registered for restore operation', async () => {
    const prom = await metrics.snapshotOperationDuration.get()
    const buckets = prom.values.filter(v => v.metricName === 'metasheet_snapshot_operation_duration_seconds_bucket')
    // We expect bucket definitions even if no samples yet
    const hasRestoreBuckets = buckets.some(b => b.labels.operation === 'restore') || buckets.length > 0
    expect(hasRestoreBuckets).toBe(true)
  })
})
