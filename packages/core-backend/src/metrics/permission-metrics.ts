/**
 * Permission Metrics Implementation
 * Issue #35: Permission denied metric test enhancement
 */

interface MetricLabel {
  [key: string]: string | number
}

interface Metric {
  name: string
  type: 'counter' | 'gauge' | 'histogram'
  value: number
  labels: MetricLabel
  timestamp?: number
}

interface MetricValue {
  value: number
  type: 'counter' | 'gauge' | 'histogram'
  labels: MetricLabel
}

interface MetricWithLabels {
  value: number
  labels: MetricLabel
}

export class PermissionMetrics {
  private metrics: Map<string, Metric[]> = new Map()

  /**
   * Track authentication failures
   */
  incrementAuthFailure(reason: string, endpoint?: string, method?: string): void {
    const metricName = 'metasheet_auth_failures_total'
    const labels: MetricLabel = { reason }

    if (endpoint) labels.endpoint = endpoint
    if (method) labels.method = method

    this.incrementCounter(metricName, labels)
  }

  /**
   * Track API requests with status codes
   */
  incrementApiRequest(endpoint: string, method: string, status: number): void {
    const metricName = 'metasheet_api_requests_total'
    const labels: MetricLabel = {
      endpoint,
      method,
      status: status.toString()
    }

    this.incrementCounter(metricName, labels)
  }

  /**
   * Track RBAC permission denials
   */
  incrementRbacDenial(
    resourceType: string,
    action: string,
    role?: string,
    reason?: string
  ): void {
    const metricName = 'metasheet_rbac_denials_total'
    const labels: MetricLabel = {
      resource_type: resourceType,
      action
    }

    if (role) labels.role = role
    if (reason) labels.reason = reason

    this.incrementCounter(metricName, labels)
  }

  /**
   * Track permission check latency
   */
  recordPermissionCheckDuration(
    resourceType: string,
    action: string,
    durationMs: number
  ): void {
    const metricName = 'metasheet_permission_check_duration_ms'
    const labels: MetricLabel = {
      resource_type: resourceType,
      action
    }

    this.addHistogramValue(metricName, labels, durationMs)
  }

  /**
   * Track token validation results
   */
  incrementTokenValidation(valid: boolean, reason?: string): void {
    const metricName = valid
      ? 'metasheet_token_validations_success_total'
      : 'metasheet_token_validations_failure_total'

    const labels: MetricLabel = {}
    if (reason) labels.reason = reason

    this.incrementCounter(metricName, labels)
  }

  /**
   * Track department-based access denials
   */
  incrementDepartmentDenial(
    department: string,
    resourceType: string,
    action: string
  ): void {
    const metricName = 'metasheet_department_access_denials_total'
    const labels: MetricLabel = {
      department,
      resource_type: resourceType,
      action
    }

    this.incrementCounter(metricName, labels)
  }

  /**
   * Get current active sessions gauge
   */
  setActiveSessions(count: number): void {
    const metricName = 'metasheet_active_sessions'
    this.setGauge(metricName, {}, count)
  }

  /**
   * Track permission cache hit/miss
   */
  incrementPermissionCache(hit: boolean): void {
    const metricName = hit
      ? 'metasheet_permission_cache_hits_total'
      : 'metasheet_permission_cache_misses_total'

    this.incrementCounter(metricName, {})
  }

  /**
   * Export metrics in Prometheus format
   */
  toPrometheusFormat(): string {
    const lines: string[] = []

    // Sort metrics for consistent output
    const sortedMetrics = Array.from(this.metrics.entries()).sort(
      ([a], [b]) => a.localeCompare(b)
    )

    for (const [metricName, metricValues] of sortedMetrics) {
      if (metricValues.length === 0) continue

      const metricType = metricValues[0].type

      // Add HELP and TYPE comments
      lines.push(`# HELP ${metricName} Permission and authentication metrics`)
      lines.push(`# TYPE ${metricName} ${metricType}`)

      // Add metric values
      for (const metric of metricValues) {
        const labelStr = this.formatLabels(metric.labels)
        lines.push(`${metricName}${labelStr} ${metric.value}`)
      }

      lines.push('') // Empty line between metrics
    }

    return lines.join('\n')
  }

  /**
   * Get all metrics as object
   */
  getMetrics(): Record<string, MetricValue | MetricWithLabels[]> {
    const result: Record<string, MetricValue | MetricWithLabels[]> = {}

    for (const [metricName, metricValues] of this.metrics) {
      if (metricValues.length === 1 && Object.keys(metricValues[0].labels).length === 0) {
        // Single value without labels
        result[metricName] = {
          value: metricValues[0].value,
          type: metricValues[0].type,
          labels: metricValues[0].labels
        }
      } else {
        // Multiple values with labels
        result[metricName] = metricValues.map(m => ({
          value: m.value,
          labels: m.labels
        }))
      }
    }

    return result
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.clear()
  }

  /**
   * Private helper methods
   */
  private incrementCounter(name: string, labels: MetricLabel): void {
    const existing = this.findMetric(name, labels)

    if (existing) {
      existing.value++
    } else {
      const metrics = this.metrics.get(name) || []
      metrics.push({
        name,
        type: 'counter',
        value: 1,
        labels,
        timestamp: Date.now()
      })
      this.metrics.set(name, metrics)
    }
  }

  private setGauge(name: string, labels: MetricLabel, value: number): void {
    const existing = this.findMetric(name, labels)

    if (existing) {
      existing.value = value
      existing.timestamp = Date.now()
    } else {
      const metrics = this.metrics.get(name) || []
      metrics.push({
        name,
        type: 'gauge',
        value,
        labels,
        timestamp: Date.now()
      })
      this.metrics.set(name, metrics)
    }
  }

  private addHistogramValue(name: string, labels: MetricLabel, value: number): void {
    // For simplicity, we'll track histogram as a simple counter of observations
    // In production, you'd want to track buckets, sum, and count
    const histogramName = `${name}_bucket`
    const buckets = [10, 50, 100, 500, 1000, 5000]

    for (const bucket of buckets) {
      if (value <= bucket) {
        const bucketLabels = { ...labels, le: bucket.toString() }
        this.incrementCounter(histogramName, bucketLabels)
      }
    }

    // Also track sum and count
    this.incrementCounter(`${name}_count`, labels)
    const sumMetric = this.findMetric(`${name}_sum`, labels)
    if (sumMetric) {
      sumMetric.value += value
    } else {
      const metrics = this.metrics.get(`${name}_sum`) || []
      metrics.push({
        name: `${name}_sum`,
        type: 'counter',
        value,
        labels,
        timestamp: Date.now()
      })
      this.metrics.set(`${name}_sum`, metrics)
    }
  }

  private findMetric(name: string, labels: MetricLabel): Metric | undefined {
    const metrics = this.metrics.get(name)
    if (!metrics) return undefined

    return metrics.find(m => this.labelsMatch(m.labels, labels))
  }

  private labelsMatch(a: MetricLabel, b: MetricLabel): boolean {
    const keysA = Object.keys(a).sort()
    const keysB = Object.keys(b).sort()

    if (keysA.length !== keysB.length) return false

    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false
      if (a[keysA[i]] !== b[keysB[i]]) return false
    }

    return true
  }

  private formatLabels(labels: MetricLabel): string {
    const entries = Object.entries(labels)
    if (entries.length === 0) return ''

    const labelPairs = entries
      .map(([key, value]) => `${key}="${value}"`)
      .join(',')

    return `{${labelPairs}}`
  }
}

// Singleton instance for global metrics
export const permissionMetrics = new PermissionMetrics()
