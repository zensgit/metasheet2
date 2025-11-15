export interface CoreMetricsSnapshot {
  messagesProcessed: number
  messagesRetried: number
  messagesExpired: number
  rpcTimeouts: number
  eventsEmitted: number
  permissionDenied: number
  startedAt: number
}

export class MetricsCollector {
  private snapshot: CoreMetricsSnapshot = {
    messagesProcessed: 0,
    messagesRetried: 0,
    messagesExpired: 0,
    rpcTimeouts: 0,
    eventsEmitted: 0,
    permissionDenied: 0,
    startedAt: Date.now()
  }

  // Generic metrics storage for custom metrics
  private customMetrics: Map<string, number> = new Map()

  inc(field: keyof CoreMetricsSnapshot, by = 1) {
    if (field === 'startedAt') return
    ;(this.snapshot as any)[field] += by
  }

  get(): CoreMetricsSnapshot {
    return { ...this.snapshot }
  }

  /**
   * Increment a counter metric (Prometheus-style API)
   * @param name Metric name
   * @param valueOrMetadata Increment value (number) or metadata object (any) - if object, increments by 1
   */
  increment(name: string, valueOrMetadata: number | any = 1): void {
    // If metadata object is provided, increment by 1 and ignore the metadata for now
    const incrementValue = typeof valueOrMetadata === 'number' ? valueOrMetadata : 1
    const current = this.customMetrics.get(name) || 0
    this.customMetrics.set(name, current + incrementValue)
  }

  /**
   * Set a gauge metric to a specific value (Prometheus-style API)
   * @param name Metric name
   * @param value Metric value
   * @param metadata Optional metadata (currently ignored)
   */
  gauge(name: string, value: number, metadata?: any): void {
    this.customMetrics.set(name, value)
  }

  /**
   * Record a histogram observation (simplified implementation)
   * @param name Metric name
   * @param value Metric value
   * @param metadata Optional metadata (currently ignored)
   */
  histogram(name: string, value: number, metadata?: any): void {
    // Simple implementation: store as gauge for now
    this.customMetrics.set(name, value)
  }

  /**
   * Get custom metric value
   */
  getCustomMetric(name: string): number | undefined {
    return this.customMetrics.get(name)
  }

  /**
   * Get all custom metrics
   */
  getAllCustomMetrics(): Record<string, number> {
    return Object.fromEntries(this.customMetrics)
  }
}

export const coreMetrics = new MetricsCollector()

// Legacy type alias for backward compatibility
export type CoreMetrics = MetricsCollector
