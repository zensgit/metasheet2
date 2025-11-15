export interface CoreMetricsSnapshot {
    messagesProcessed: number;
    messagesRetried: number;
    messagesExpired: number;
    rpcTimeouts: number;
    eventsEmitted: number;
    permissionDenied: number;
    startedAt: number;
}
export declare class MetricsCollector {
    private snapshot;
    private customMetrics;
    inc(field: keyof CoreMetricsSnapshot, by?: number): void;
    get(): CoreMetricsSnapshot;
    /**
     * Increment a counter metric (Prometheus-style API)
     * @param name Metric name
     * @param valueOrMetadata Increment value (number) or metadata object (any) - if object, increments by 1
     */
    increment(name: string, valueOrMetadata?: number | any): void;
    /**
     * Set a gauge metric to a specific value (Prometheus-style API)
     * @param name Metric name
     * @param value Metric value
     * @param metadata Optional metadata (currently ignored)
     */
    gauge(name: string, value: number, metadata?: any): void;
    /**
     * Record a histogram observation (simplified implementation)
     * @param name Metric name
     * @param value Metric value
     * @param metadata Optional metadata (currently ignored)
     */
    histogram(name: string, value: number, metadata?: any): void;
    /**
     * Get custom metric value
     */
    getCustomMetric(name: string): number | undefined;
    /**
     * Get all custom metrics
     */
    getAllCustomMetrics(): Record<string, number>;
}
export declare const coreMetrics: MetricsCollector;
export type CoreMetrics = MetricsCollector;
//# sourceMappingURL=metrics.d.ts.map