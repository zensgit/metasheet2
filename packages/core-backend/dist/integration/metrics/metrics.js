export class MetricsCollector {
    snapshot = {
        messagesProcessed: 0,
        messagesRetried: 0,
        messagesExpired: 0,
        rpcTimeouts: 0,
        eventsEmitted: 0,
        permissionDenied: 0,
        startedAt: Date.now()
    };
    // Generic metrics storage for custom metrics
    customMetrics = new Map();
    inc(field, by = 1) {
        if (field === 'startedAt')
            return;
        this.snapshot[field] += by;
    }
    get() {
        return { ...this.snapshot };
    }
    /**
     * Increment a counter metric (Prometheus-style API)
     * @param name Metric name
     * @param valueOrMetadata Increment value (number) or metadata object (any) - if object, increments by 1
     */
    increment(name, valueOrMetadata = 1) {
        // If metadata object is provided, increment by 1 and ignore the metadata for now
        const incrementValue = typeof valueOrMetadata === 'number' ? valueOrMetadata : 1;
        const current = this.customMetrics.get(name) || 0;
        this.customMetrics.set(name, current + incrementValue);
    }
    /**
     * Set a gauge metric to a specific value (Prometheus-style API)
     * @param name Metric name
     * @param value Metric value
     * @param metadata Optional metadata (currently ignored)
     */
    gauge(name, value, metadata) {
        this.customMetrics.set(name, value);
    }
    /**
     * Record a histogram observation (simplified implementation)
     * @param name Metric name
     * @param value Metric value
     * @param metadata Optional metadata (currently ignored)
     */
    histogram(name, value, metadata) {
        // Simple implementation: store as gauge for now
        this.customMetrics.set(name, value);
    }
    /**
     * Get custom metric value
     */
    getCustomMetric(name) {
        return this.customMetrics.get(name);
    }
    /**
     * Get all custom metrics
     */
    getAllCustomMetrics() {
        return Object.fromEntries(this.customMetrics);
    }
}
export const coreMetrics = new MetricsCollector();
//# sourceMappingURL=metrics.js.map