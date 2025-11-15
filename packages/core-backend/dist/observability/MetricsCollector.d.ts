/**
 * Advanced Metrics Collector
 * Comprehensive metrics collection for Prometheus and other monitoring systems
 */
import { EventEmitter } from 'eventemitter3';
export interface MetricConfig {
    prefix?: string;
    defaultLabels?: Record<string, string>;
    buckets?: number[];
    percentiles?: number[];
    enableDefaultMetrics?: boolean;
    aggregateInterval?: number;
}
export interface CustomMetric {
    name: string;
    type: 'counter' | 'gauge' | 'histogram' | 'summary';
    help: string;
    labels?: string[];
    buckets?: number[];
    percentiles?: number[];
}
export interface MetricSnapshot {
    timestamp: number;
    metrics: Record<string, any>;
    system: {
        cpu: number;
        memory: {
            used: number;
            total: number;
            percentage: number;
        };
        uptime: number;
        loadAverage: number[];
    };
}
export declare class MetricsCollector extends EventEmitter {
    private registry;
    private config;
    private metrics;
    private customMetrics;
    private aggregateTimer?;
    private snapshots;
    private startTime;
    private httpRequestDuration;
    private httpRequestTotal;
    private httpRequestErrors;
    private httpRequestSize;
    private httpResponseSize;
    private dbQueryDuration;
    private dbQueryTotal;
    private dbQueryErrors;
    private dbConnectionPool;
    private dbTransactionDuration;
    private spreadsheetOperations;
    private workflowExecutions;
    private approvalProcessing;
    private formulaCalculations;
    private cellUpdates;
    private systemCpu;
    private systemMemory;
    private systemDisk;
    private systemNetwork;
    private processMemory;
    private processCpu;
    private eventLoopLag;
    private gcDuration;
    private pluginExecutions;
    private pluginErrors;
    private pluginDuration;
    private pluginMemoryUsage;
    private wsConnections;
    private wsMessages;
    private wsErrors;
    private wsBandwidth;
    private cacheHits;
    private cacheMisses;
    private cacheEvictions;
    private cacheSize;
    constructor(config?: Partial<MetricConfig>);
    /**
     * Initialize all metrics
     */
    private initializeMetrics;
    /**
     * Record HTTP request
     */
    recordHttpRequest(method: string, route: string, status: number, duration: number, requestSize?: number, responseSize?: number): void;
    /**
     * Record database query
     */
    recordDbQuery(operation: string, table: string, duration: number, error?: string): void;
    /**
     * Update connection pool metrics
     */
    updateConnectionPool(active: number, idle: number, waiting: number): void;
    /**
     * Record spreadsheet operation
     */
    recordSpreadsheetOperation(operation: string, spreadsheetId: string): void;
    /**
     * Record workflow execution
     */
    recordWorkflowExecution(workflowId: string, status: 'success' | 'failure'): void;
    /**
     * Record formula calculation
     */
    recordFormulaCalculation(formulaType: string, complexity: 'simple' | 'medium' | 'complex', duration: number): void;
    /**
     * Record plugin execution
     */
    recordPluginExecution(plugin: string, status: 'success' | 'failure', duration: number, memoryUsed?: number): void;
    /**
     * Update WebSocket metrics
     */
    updateWebSocketConnections(count: number): void;
    recordWebSocketMessage(type: string, direction: 'in' | 'out', bytes: number): void;
    /**
     * Record cache operation
     */
    recordCacheOperation(cacheName: string, operation: 'hit' | 'miss' | 'eviction', reason?: string): void;
    /**
     * Update cache size
     */
    updateCacheSize(cacheName: string, sizeBytes: number): void;
    /**
     * Collect system metrics
     */
    private collectSystemMetrics;
    /**
     * Start metrics aggregation
     */
    private startAggregation;
    /**
     * Create metrics snapshot
     */
    private createSnapshot;
    /**
     * Register custom metric
     */
    registerCustomMetric(metric: CustomMetric): void;
    /**
     * Update custom metric
     */
    updateCustomMetric(name: string, value: number, labels?: Record<string, string>, operation?: 'inc' | 'dec' | 'set' | 'observe'): void;
    /**
     * Get metrics in Prometheus format
     */
    getMetrics(): Promise<string>;
    /**
     * Get metrics as JSON
     */
    getMetricsAsJson(): Promise<any>;
    /**
     * Get snapshots
     */
    getSnapshots(limit?: number): MetricSnapshot[];
    /**
     * Get latest snapshot
     */
    getLatestSnapshot(): MetricSnapshot | null;
    /**
     * Reset all metrics
     */
    reset(): void;
    /**
     * Dispose and cleanup
     */
    dispose(): void;
}
export default MetricsCollector;
//# sourceMappingURL=MetricsCollector.d.ts.map