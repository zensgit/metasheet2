/**
 * CanaryMetrics - Prometheus metrics for canary vs stable comparison
 *
 * Tracks request counts, latency distributions, and error rates
 * per version (stable/canary) and topic.
 */

import client from 'prom-client'
import { registry } from '../metrics/metrics'

const canaryRequestsTotal = new client.Counter({
  name: 'metasheet_canary_requests_total',
  help: 'Total canary/stable requests',
  labelNames: ['version', 'topic'] as const,
})

const canaryLatencySeconds = new client.Histogram({
  name: 'metasheet_canary_latency_seconds',
  help: 'Canary/stable request latency in seconds',
  labelNames: ['version', 'topic'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
})

const canaryErrorsTotal = new client.Counter({
  name: 'metasheet_canary_errors_total',
  help: 'Total canary/stable errors',
  labelNames: ['version', 'topic'] as const,
})

const canaryWeightGauge = new client.Gauge({
  name: 'metasheet_canary_weight',
  help: 'Current canary weight setting per topic',
  labelNames: ['topic'] as const,
})

// Register all metrics
registry.registerMetric(canaryRequestsTotal)
registry.registerMetric(canaryLatencySeconds)
registry.registerMetric(canaryErrorsTotal)
registry.registerMetric(canaryWeightGauge)

export interface VersionStats {
  p50: number
  p99: number
  errorRate: number
}

export class CanaryMetrics {
  /**
   * Record a request for a version + topic.
   */
  recordRequest(version: 'stable' | 'canary', topic: string): void {
    canaryRequestsTotal.labels(version, topic).inc()
  }

  /**
   * Observe latency for a version + topic.
   */
  recordLatency(version: 'stable' | 'canary', topic: string, durationSeconds: number): void {
    canaryLatencySeconds.labels(version, topic).observe(durationSeconds)
  }

  /**
   * Record an error for a version + topic.
   */
  recordError(version: 'stable' | 'canary', topic: string): void {
    canaryErrorsTotal.labels(version, topic).inc()
  }

  /**
   * Update the canary weight gauge for a topic.
   */
  setWeight(topic: string, weight: number): void {
    canaryWeightGauge.labels(topic).set(weight)
  }

  /**
   * Start a latency timer; returns a function to call when done.
   */
  startTimer(version: 'stable' | 'canary', topic: string): () => void {
    const start = process.hrtime.bigint()
    return () => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e9
      this.recordLatency(version, topic, elapsed)
    }
  }

  /**
   * Compare stable vs canary stats for a topic.
   * Reads from Prometheus registry histograms/counters.
   */
  async compareVersions(topic: string): Promise<{
    stable: VersionStats
    canary: VersionStats
  }> {
    const extract = async (version: string): Promise<VersionStats> => {
      const latencyMetric = await canaryLatencySeconds.get()
      const errorMetric = await canaryErrorsTotal.get()
      const requestMetric = await canaryRequestsTotal.get()

      // Collect histogram values for this version+topic
      const histValues = latencyMetric.values.filter(
        v => v.labels.version === version && v.labels.topic === topic,
      )
      const totalRequests =
        requestMetric.values.find(
          v => v.labels.version === version && v.labels.topic === topic,
        )?.value ?? 0
      const totalErrors =
        errorMetric.values.find(
          v => v.labels.version === version && v.labels.topic === topic,
        )?.value ?? 0

      // Extract quantiles from histogram buckets
      const sumEntry = histValues.find(v => v.metricName?.endsWith('_sum'))
      const countEntry = histValues.find(v => v.metricName?.endsWith('_count'))

      const sum = sumEntry?.value ?? 0
      const count = countEntry?.value ?? 0
      const mean = count > 0 ? sum / count : 0

      // Approximate p50/p99 from bucket boundaries
      const buckets = histValues
        .filter(v => v.metricName?.endsWith('_bucket'))
        .sort((a, b) => Number((a.labels as Record<string, string>).le) - Number((b.labels as Record<string, string>).le))
        .map(v => ({ value: v.value, labels: v.labels as unknown as Record<string, string> }))

      const p50 = this.percentileFromBuckets(buckets, count, 0.5) ?? mean
      const p99 = this.percentileFromBuckets(buckets, count, 0.99) ?? mean
      const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0

      return { p50, p99, errorRate }
    }

    return {
      stable: await extract('stable'),
      canary: await extract('canary'),
    }
  }

  /**
   * Approximate a percentile from histogram bucket counts.
   */
  private percentileFromBuckets(
    buckets: Array<{ value: number; labels: Record<string, string> }>,
    totalCount: number,
    percentile: number,
  ): number | null {
    if (buckets.length === 0 || totalCount === 0) return null

    const target = totalCount * percentile
    for (const bucket of buckets) {
      if (bucket.value >= target) {
        return Number(bucket.labels.le)
      }
    }
    return Number(buckets[buckets.length - 1]?.labels.le) ?? null
  }
}

export const canaryMetrics = new CanaryMetrics()
