import { describe, it, expect, vi, beforeEach } from 'vitest'
import { observeRpcLatency, metrics, registry } from '../../src/metrics/metrics'

describe('RPC Latency Histogram', () => {
  beforeEach(async () => {
    // Reset the histogram between tests
    metrics.rpcLatencySeconds.reset()
  })

  it('should record a success observation', async () => {
    observeRpcLatency('getData', 'plugin-a', 'success', 0.05)

    const metricValues = await registry.getMetricsAsJSON()
    const histogram = metricValues.find(
      (m: { name: string }) => m.name === 'metasheet_rpc_latency_seconds'
    )
    expect(histogram).toBeDefined()

    // Verify the metric has values recorded
    const values = histogram!.values as Array<{
      labels: Record<string, string>
      value: number
      metricName: string
    }>
    const countEntry = values.find(
      (v) =>
        v.metricName === 'metasheet_rpc_latency_seconds_count' &&
        v.labels.method === 'getData' &&
        v.labels.plugin === 'plugin-a' &&
        v.labels.status === 'success'
    )
    expect(countEntry).toBeDefined()
    expect(countEntry!.value).toBe(1)
  })

  it('should record a failure observation', async () => {
    observeRpcLatency('saveData', 'plugin-b', 'failure', 0.123)

    const metricValues = await registry.getMetricsAsJSON()
    const histogram = metricValues.find(
      (m: { name: string }) => m.name === 'metasheet_rpc_latency_seconds'
    )
    const values = histogram!.values as Array<{
      labels: Record<string, string>
      value: number
      metricName: string
    }>
    const countEntry = values.find(
      (v) =>
        v.metricName === 'metasheet_rpc_latency_seconds_count' &&
        v.labels.method === 'saveData' &&
        v.labels.plugin === 'plugin-b' &&
        v.labels.status === 'failure'
    )
    expect(countEntry).toBeDefined()
    expect(countEntry!.value).toBe(1)
  })

  it('should record a timeout observation', async () => {
    observeRpcLatency('slowMethod', 'plugin-c', 'timeout', 5.0)

    const metricValues = await registry.getMetricsAsJSON()
    const histogram = metricValues.find(
      (m: { name: string }) => m.name === 'metasheet_rpc_latency_seconds'
    )
    const values = histogram!.values as Array<{
      labels: Record<string, string>
      value: number
      metricName: string
    }>
    const countEntry = values.find(
      (v) =>
        v.metricName === 'metasheet_rpc_latency_seconds_count' &&
        v.labels.method === 'slowMethod' &&
        v.labels.plugin === 'plugin-c' &&
        v.labels.status === 'timeout'
    )
    expect(countEntry).toBeDefined()
    expect(countEntry!.value).toBe(1)

    // Verify sum reflects the large duration
    const sumEntry = values.find(
      (v) =>
        v.metricName === 'metasheet_rpc_latency_seconds_sum' &&
        v.labels.method === 'slowMethod' &&
        v.labels.plugin === 'plugin-c' &&
        v.labels.status === 'timeout'
    )
    expect(sumEntry).toBeDefined()
    expect(sumEntry!.value).toBe(5.0)
  })

  it('should accumulate multiple observations for the same labels', async () => {
    observeRpcLatency('fetch', 'plugin-a', 'success', 0.01)
    observeRpcLatency('fetch', 'plugin-a', 'success', 0.02)
    observeRpcLatency('fetch', 'plugin-a', 'success', 0.03)

    const metricValues = await registry.getMetricsAsJSON()
    const histogram = metricValues.find(
      (m: { name: string }) => m.name === 'metasheet_rpc_latency_seconds'
    )
    const values = histogram!.values as Array<{
      labels: Record<string, string>
      value: number
      metricName: string
    }>
    const countEntry = values.find(
      (v) =>
        v.metricName === 'metasheet_rpc_latency_seconds_count' &&
        v.labels.method === 'fetch' &&
        v.labels.plugin === 'plugin-a' &&
        v.labels.status === 'success'
    )
    expect(countEntry).toBeDefined()
    expect(countEntry!.value).toBe(3)

    const sumEntry = values.find(
      (v) =>
        v.metricName === 'metasheet_rpc_latency_seconds_sum' &&
        v.labels.method === 'fetch' &&
        v.labels.plugin === 'plugin-a' &&
        v.labels.status === 'success'
    )
    expect(sumEntry).toBeDefined()
    expect(sumEntry!.value).toBeCloseTo(0.06, 5)
  })

  it('should track different statuses independently', async () => {
    observeRpcLatency('doWork', 'plugin-x', 'success', 0.01)
    observeRpcLatency('doWork', 'plugin-x', 'failure', 0.05)
    observeRpcLatency('doWork', 'plugin-x', 'timeout', 2.0)

    const metricValues = await registry.getMetricsAsJSON()
    const histogram = metricValues.find(
      (m: { name: string }) => m.name === 'metasheet_rpc_latency_seconds'
    )
    const values = histogram!.values as Array<{
      labels: Record<string, string>
      value: number
      metricName: string
    }>

    for (const status of ['success', 'failure', 'timeout']) {
      const countEntry = values.find(
        (v) =>
          v.metricName === 'metasheet_rpc_latency_seconds_count' &&
          v.labels.method === 'doWork' &&
          v.labels.plugin === 'plugin-x' &&
          v.labels.status === status
      )
      expect(countEntry).toBeDefined()
      expect(countEntry!.value).toBe(1)
    }
  })

  it('should populate histogram buckets correctly', async () => {
    // Observe a value that falls into the 0.01 bucket
    observeRpcLatency('bucketTest', 'plugin-z', 'success', 0.008)

    const metricValues = await registry.getMetricsAsJSON()
    const histogram = metricValues.find(
      (m: { name: string }) => m.name === 'metasheet_rpc_latency_seconds'
    )
    const values = histogram!.values as Array<{
      labels: Record<string, string | number>
      value: number
      metricName: string
    }>

    // The 0.01 bucket (le=0.01) should have count 1
    const bucket01 = values.find(
      (v) =>
        v.metricName === 'metasheet_rpc_latency_seconds_bucket' &&
        v.labels.method === 'bucketTest' &&
        v.labels.le === 0.01 &&
        v.labels.status === 'success'
    )
    expect(bucket01).toBeDefined()
    expect(bucket01!.value).toBe(1)

    // The 0.001 bucket should have count 0 (0.008 > 0.001)
    const bucket0001 = values.find(
      (v) =>
        v.metricName === 'metasheet_rpc_latency_seconds_bucket' &&
        v.labels.method === 'bucketTest' &&
        v.labels.le === 0.001 &&
        v.labels.status === 'success'
    )
    expect(bucket0001).toBeDefined()
    expect(bucket0001!.value).toBe(0)
  })
})
