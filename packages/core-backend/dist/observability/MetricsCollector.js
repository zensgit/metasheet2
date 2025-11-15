"use strict";
/**
 * Advanced Metrics Collector
 * Comprehensive metrics collection for Prometheus and other monitoring systems
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetricsCollector = void 0;
const prom_client_1 = require("prom-client");
const eventemitter3_1 = require("eventemitter3");
const os = __importStar(require("os"));
const DEFAULT_CONFIG = {
    prefix: 'metasheet_',
    defaultLabels: {},
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    percentiles: [0.5, 0.9, 0.95, 0.99],
    enableDefaultMetrics: true,
    aggregateInterval: 60000 // 1 minute
};
class MetricsCollector extends eventemitter3_1.EventEmitter {
    registry;
    config;
    metrics = new Map();
    customMetrics = new Map();
    aggregateTimer;
    snapshots = [];
    startTime;
    // Core application metrics
    httpRequestDuration;
    httpRequestTotal;
    httpRequestErrors;
    httpRequestSize;
    httpResponseSize;
    // Database metrics
    dbQueryDuration;
    dbQueryTotal;
    dbQueryErrors;
    dbConnectionPool;
    dbTransactionDuration;
    // Business metrics
    spreadsheetOperations;
    workflowExecutions;
    approvalProcessing;
    formulaCalculations;
    cellUpdates;
    // System metrics
    systemCpu;
    systemMemory;
    systemDisk;
    systemNetwork;
    processMemory;
    processCpu;
    eventLoopLag;
    gcDuration;
    // Plugin metrics
    pluginExecutions;
    pluginErrors;
    pluginDuration;
    pluginMemoryUsage;
    // WebSocket metrics
    wsConnections;
    wsMessages;
    wsErrors;
    wsBandwidth;
    // Cache metrics
    cacheHits;
    cacheMisses;
    cacheEvictions;
    cacheSize;
    constructor(config) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.registry = new prom_client_1.Registry();
        this.startTime = Date.now();
        this.initializeMetrics();
        this.startAggregation();
    }
    /**
     * Initialize all metrics
     */
    initializeMetrics() {
        // Set default labels
        if (this.config.defaultLabels) {
            this.registry.setDefaultLabels(this.config.defaultLabels);
        }
        // Collect default Node.js metrics
        if (this.config.enableDefaultMetrics) {
            (0, prom_client_1.collectDefaultMetrics)({ register: this.registry, prefix: this.config.prefix });
        }
        // Initialize HTTP metrics
        this.httpRequestDuration = new prom_client_1.Histogram({
            name: `${this.config.prefix}http_request_duration_seconds`,
            help: 'Duration of HTTP requests in seconds',
            labelNames: ['method', 'route', 'status'],
            buckets: this.config.buckets,
            registers: [this.registry]
        });
        this.httpRequestTotal = new prom_client_1.Counter({
            name: `${this.config.prefix}http_requests_total`,
            help: 'Total number of HTTP requests',
            labelNames: ['method', 'route', 'status'],
            registers: [this.registry]
        });
        this.httpRequestErrors = new prom_client_1.Counter({
            name: `${this.config.prefix}http_request_errors_total`,
            help: 'Total number of HTTP request errors',
            labelNames: ['method', 'route', 'error'],
            registers: [this.registry]
        });
        this.httpRequestSize = new prom_client_1.Histogram({
            name: `${this.config.prefix}http_request_size_bytes`,
            help: 'Size of HTTP requests in bytes',
            labelNames: ['method', 'route'],
            buckets: [100, 1000, 10000, 100000, 1000000],
            registers: [this.registry]
        });
        this.httpResponseSize = new prom_client_1.Histogram({
            name: `${this.config.prefix}http_response_size_bytes`,
            help: 'Size of HTTP responses in bytes',
            labelNames: ['method', 'route'],
            buckets: [100, 1000, 10000, 100000, 1000000],
            registers: [this.registry]
        });
        // Initialize Database metrics
        this.dbQueryDuration = new prom_client_1.Histogram({
            name: `${this.config.prefix}db_query_duration_seconds`,
            help: 'Duration of database queries in seconds',
            labelNames: ['operation', 'table'],
            buckets: this.config.buckets,
            registers: [this.registry]
        });
        this.dbQueryTotal = new prom_client_1.Counter({
            name: `${this.config.prefix}db_queries_total`,
            help: 'Total number of database queries',
            labelNames: ['operation', 'table'],
            registers: [this.registry]
        });
        this.dbQueryErrors = new prom_client_1.Counter({
            name: `${this.config.prefix}db_query_errors_total`,
            help: 'Total number of database query errors',
            labelNames: ['operation', 'table', 'error'],
            registers: [this.registry]
        });
        this.dbConnectionPool = new prom_client_1.Gauge({
            name: `${this.config.prefix}db_connection_pool_size`,
            help: 'Database connection pool size',
            labelNames: ['state'],
            registers: [this.registry]
        });
        this.dbTransactionDuration = new prom_client_1.Histogram({
            name: `${this.config.prefix}db_transaction_duration_seconds`,
            help: 'Duration of database transactions in seconds',
            buckets: this.config.buckets,
            registers: [this.registry]
        });
        // Initialize Business metrics
        this.spreadsheetOperations = new prom_client_1.Counter({
            name: `${this.config.prefix}spreadsheet_operations_total`,
            help: 'Total number of spreadsheet operations',
            labelNames: ['operation', 'spreadsheet_id'],
            registers: [this.registry]
        });
        this.workflowExecutions = new prom_client_1.Counter({
            name: `${this.config.prefix}workflow_executions_total`,
            help: 'Total number of workflow executions',
            labelNames: ['workflow_id', 'status'],
            registers: [this.registry]
        });
        this.approvalProcessing = new prom_client_1.Histogram({
            name: `${this.config.prefix}approval_processing_duration_seconds`,
            help: 'Duration of approval processing in seconds',
            labelNames: ['approval_type', 'status'],
            buckets: this.config.buckets,
            registers: [this.registry]
        });
        this.formulaCalculations = new prom_client_1.Histogram({
            name: `${this.config.prefix}formula_calculation_duration_seconds`,
            help: 'Duration of formula calculations in seconds',
            labelNames: ['formula_type', 'complexity'],
            buckets: [0.001, 0.01, 0.1, 1, 10],
            registers: [this.registry]
        });
        this.cellUpdates = new prom_client_1.Counter({
            name: `${this.config.prefix}cell_updates_total`,
            help: 'Total number of cell updates',
            labelNames: ['spreadsheet_id', 'update_type'],
            registers: [this.registry]
        });
        // Initialize System metrics
        this.systemCpu = new prom_client_1.Gauge({
            name: `${this.config.prefix}system_cpu_usage_percent`,
            help: 'System CPU usage percentage',
            registers: [this.registry]
        });
        this.systemMemory = new prom_client_1.Gauge({
            name: `${this.config.prefix}system_memory_usage_bytes`,
            help: 'System memory usage in bytes',
            labelNames: ['type'],
            registers: [this.registry]
        });
        this.systemDisk = new prom_client_1.Gauge({
            name: `${this.config.prefix}system_disk_usage_bytes`,
            help: 'System disk usage in bytes',
            labelNames: ['path', 'type'],
            registers: [this.registry]
        });
        this.systemNetwork = new prom_client_1.Counter({
            name: `${this.config.prefix}system_network_bytes_total`,
            help: 'Total network bytes transferred',
            labelNames: ['direction', 'interface'],
            registers: [this.registry]
        });
        this.processMemory = new prom_client_1.Gauge({
            name: `${this.config.prefix}process_memory_usage_bytes`,
            help: 'Process memory usage in bytes',
            labelNames: ['type'],
            registers: [this.registry]
        });
        this.processCpu = new prom_client_1.Gauge({
            name: `${this.config.prefix}process_cpu_usage_percent`,
            help: 'Process CPU usage percentage',
            registers: [this.registry]
        });
        this.eventLoopLag = new prom_client_1.Histogram({
            name: `${this.config.prefix}event_loop_lag_seconds`,
            help: 'Event loop lag in seconds',
            buckets: [0.001, 0.01, 0.1, 1],
            registers: [this.registry]
        });
        this.gcDuration = new prom_client_1.Histogram({
            name: `${this.config.prefix}gc_duration_seconds`,
            help: 'Garbage collection duration in seconds',
            labelNames: ['type'],
            buckets: [0.001, 0.01, 0.1],
            registers: [this.registry]
        });
        // Initialize Plugin metrics
        this.pluginExecutions = new prom_client_1.Counter({
            name: `${this.config.prefix}plugin_executions_total`,
            help: 'Total number of plugin executions',
            labelNames: ['plugin', 'status'],
            registers: [this.registry]
        });
        this.pluginErrors = new prom_client_1.Counter({
            name: `${this.config.prefix}plugin_errors_total`,
            help: 'Total number of plugin errors',
            labelNames: ['plugin', 'error_type'],
            registers: [this.registry]
        });
        this.pluginDuration = new prom_client_1.Histogram({
            name: `${this.config.prefix}plugin_execution_duration_seconds`,
            help: 'Plugin execution duration in seconds',
            labelNames: ['plugin'],
            buckets: this.config.buckets,
            registers: [this.registry]
        });
        this.pluginMemoryUsage = new prom_client_1.Gauge({
            name: `${this.config.prefix}plugin_memory_usage_bytes`,
            help: 'Plugin memory usage in bytes',
            labelNames: ['plugin'],
            registers: [this.registry]
        });
        // Initialize WebSocket metrics
        this.wsConnections = new prom_client_1.Gauge({
            name: `${this.config.prefix}ws_connections_active`,
            help: 'Number of active WebSocket connections',
            registers: [this.registry]
        });
        this.wsMessages = new prom_client_1.Counter({
            name: `${this.config.prefix}ws_messages_total`,
            help: 'Total number of WebSocket messages',
            labelNames: ['type', 'direction'],
            registers: [this.registry]
        });
        this.wsErrors = new prom_client_1.Counter({
            name: `${this.config.prefix}ws_errors_total`,
            help: 'Total number of WebSocket errors',
            labelNames: ['error_type'],
            registers: [this.registry]
        });
        this.wsBandwidth = new prom_client_1.Counter({
            name: `${this.config.prefix}ws_bandwidth_bytes_total`,
            help: 'Total WebSocket bandwidth in bytes',
            labelNames: ['direction'],
            registers: [this.registry]
        });
        // Initialize Cache metrics
        this.cacheHits = new prom_client_1.Counter({
            name: `${this.config.prefix}cache_hits_total`,
            help: 'Total number of cache hits',
            labelNames: ['cache_name'],
            registers: [this.registry]
        });
        this.cacheMisses = new prom_client_1.Counter({
            name: `${this.config.prefix}cache_misses_total`,
            help: 'Total number of cache misses',
            labelNames: ['cache_name'],
            registers: [this.registry]
        });
        this.cacheEvictions = new prom_client_1.Counter({
            name: `${this.config.prefix}cache_evictions_total`,
            help: 'Total number of cache evictions',
            labelNames: ['cache_name', 'reason'],
            registers: [this.registry]
        });
        this.cacheSize = new prom_client_1.Gauge({
            name: `${this.config.prefix}cache_size_bytes`,
            help: 'Cache size in bytes',
            labelNames: ['cache_name'],
            registers: [this.registry]
        });
        // Store references
        this.metrics.set('http_request_duration', this.httpRequestDuration);
        this.metrics.set('http_requests_total', this.httpRequestTotal);
        this.metrics.set('db_query_duration', this.dbQueryDuration);
        this.metrics.set('db_queries_total', this.dbQueryTotal);
        this.emit('metrics:initialized');
    }
    /**
     * Record HTTP request
     */
    recordHttpRequest(method, route, status, duration, requestSize, responseSize) {
        const labels = { method, route, status: status.toString() };
        this.httpRequestTotal.inc(labels);
        this.httpRequestDuration.observe(labels, duration / 1000);
        if (requestSize) {
            this.httpRequestSize.observe({ method, route }, requestSize);
        }
        if (responseSize) {
            this.httpResponseSize.observe({ method, route }, responseSize);
        }
        if (status >= 400) {
            this.httpRequestErrors.inc({ method, route, error: status.toString() });
        }
    }
    /**
     * Record database query
     */
    recordDbQuery(operation, table, duration, error) {
        const labels = { operation, table };
        this.dbQueryTotal.inc(labels);
        this.dbQueryDuration.observe(labels, duration / 1000);
        if (error) {
            this.dbQueryErrors.inc({ ...labels, error });
        }
    }
    /**
     * Update connection pool metrics
     */
    updateConnectionPool(active, idle, waiting) {
        this.dbConnectionPool.set({ state: 'active' }, active);
        this.dbConnectionPool.set({ state: 'idle' }, idle);
        this.dbConnectionPool.set({ state: 'waiting' }, waiting);
    }
    /**
     * Record spreadsheet operation
     */
    recordSpreadsheetOperation(operation, spreadsheetId) {
        this.spreadsheetOperations.inc({ operation, spreadsheet_id: spreadsheetId });
    }
    /**
     * Record workflow execution
     */
    recordWorkflowExecution(workflowId, status) {
        this.workflowExecutions.inc({ workflow_id: workflowId, status });
    }
    /**
     * Record formula calculation
     */
    recordFormulaCalculation(formulaType, complexity, duration) {
        this.formulaCalculations.observe({ formula_type: formulaType, complexity }, duration / 1000);
    }
    /**
     * Record plugin execution
     */
    recordPluginExecution(plugin, status, duration, memoryUsed) {
        this.pluginExecutions.inc({ plugin, status });
        this.pluginDuration.observe({ plugin }, duration / 1000);
        if (memoryUsed) {
            this.pluginMemoryUsage.set({ plugin }, memoryUsed);
        }
        if (status === 'failure') {
            this.pluginErrors.inc({ plugin, error_type: 'execution' });
        }
    }
    /**
     * Update WebSocket metrics
     */
    updateWebSocketConnections(count) {
        this.wsConnections.set(count);
    }
    recordWebSocketMessage(type, direction, bytes) {
        this.wsMessages.inc({ type, direction });
        this.wsBandwidth.inc({ direction }, bytes);
    }
    /**
     * Record cache operation
     */
    recordCacheOperation(cacheName, operation, reason) {
        switch (operation) {
            case 'hit':
                this.cacheHits.inc({ cache_name: cacheName });
                break;
            case 'miss':
                this.cacheMisses.inc({ cache_name: cacheName });
                break;
            case 'eviction':
                this.cacheEvictions.inc({ cache_name: cacheName, reason: reason || 'unknown' });
                break;
        }
    }
    /**
     * Update cache size
     */
    updateCacheSize(cacheName, sizeBytes) {
        this.cacheSize.set({ cache_name: cacheName }, sizeBytes);
    }
    /**
     * Collect system metrics
     */
    collectSystemMetrics() {
        // CPU usage
        const cpus = os.cpus();
        const cpuUsage = cpus.reduce((acc, cpu) => {
            const total = Object.values(cpu.times).reduce((a, b) => a + b);
            const idle = cpu.times.idle;
            return acc + ((total - idle) / total) * 100;
        }, 0) / cpus.length;
        this.systemCpu.set(cpuUsage);
        // Memory usage
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        this.systemMemory.set({ type: 'total' }, totalMem);
        this.systemMemory.set({ type: 'used' }, usedMem);
        this.systemMemory.set({ type: 'free' }, freeMem);
        // Process memory
        const memUsage = process.memoryUsage();
        this.processMemory.set({ type: 'rss' }, memUsage.rss);
        this.processMemory.set({ type: 'heapTotal' }, memUsage.heapTotal);
        this.processMemory.set({ type: 'heapUsed' }, memUsage.heapUsed);
        this.processMemory.set({ type: 'external' }, memUsage.external);
    }
    /**
     * Start metrics aggregation
     */
    startAggregation() {
        if (this.config.aggregateInterval && this.config.aggregateInterval > 0) {
            this.aggregateTimer = setInterval(() => {
                this.collectSystemMetrics();
                this.createSnapshot();
            }, this.config.aggregateInterval);
        }
        // Collect initial metrics
        this.collectSystemMetrics();
    }
    /**
     * Create metrics snapshot
     */
    createSnapshot() {
        const snapshot = {
            timestamp: Date.now(),
            metrics: {},
            system: {
                cpu: this.systemCpu.get().values[0]?.value || 0,
                memory: {
                    used: this.systemMemory.get({ type: 'used' }).values[0]?.value || 0,
                    total: this.systemMemory.get({ type: 'total' }).values[0]?.value || 0,
                    percentage: 0
                },
                uptime: (Date.now() - this.startTime) / 1000,
                loadAverage: os.loadavg()
            }
        };
        snapshot.system.memory.percentage =
            (snapshot.system.memory.used / snapshot.system.memory.total) * 100;
        // Store snapshot
        this.snapshots.push(snapshot);
        // Keep only last 100 snapshots
        if (this.snapshots.length > 100) {
            this.snapshots = this.snapshots.slice(-100);
        }
        this.emit('snapshot:created', snapshot);
    }
    /**
     * Register custom metric
     */
    registerCustomMetric(metric) {
        if (this.customMetrics.has(metric.name)) {
            throw new Error(`Metric ${metric.name} already registered`);
        }
        let promMetric;
        switch (metric.type) {
            case 'counter':
                promMetric = new prom_client_1.Counter({
                    name: `${this.config.prefix}${metric.name}`,
                    help: metric.help,
                    labelNames: metric.labels,
                    registers: [this.registry]
                });
                break;
            case 'gauge':
                promMetric = new prom_client_1.Gauge({
                    name: `${this.config.prefix}${metric.name}`,
                    help: metric.help,
                    labelNames: metric.labels,
                    registers: [this.registry]
                });
                break;
            case 'histogram':
                promMetric = new prom_client_1.Histogram({
                    name: `${this.config.prefix}${metric.name}`,
                    help: metric.help,
                    labelNames: metric.labels,
                    buckets: metric.buckets || this.config.buckets,
                    registers: [this.registry]
                });
                break;
            case 'summary':
                promMetric = new prom_client_1.Summary({
                    name: `${this.config.prefix}${metric.name}`,
                    help: metric.help,
                    labelNames: metric.labels,
                    percentiles: metric.percentiles || this.config.percentiles,
                    registers: [this.registry]
                });
                break;
        }
        this.metrics.set(metric.name, promMetric);
        this.customMetrics.set(metric.name, metric);
    }
    /**
     * Update custom metric
     */
    updateCustomMetric(name, value, labels, operation) {
        const metric = this.metrics.get(name);
        if (!metric) {
            throw new Error(`Metric ${name} not found`);
        }
        const customMetric = this.customMetrics.get(name);
        if (!customMetric) {
            return;
        }
        switch (customMetric.type) {
            case 'counter':
                if (operation === 'inc' || !operation) {
                    metric.inc(labels, value);
                }
                break;
            case 'gauge':
                const gauge = metric;
                switch (operation) {
                    case 'inc':
                        gauge.inc(labels, value);
                        break;
                    case 'dec':
                        gauge.dec(labels, value);
                        break;
                    case 'set':
                    default:
                        gauge.set(labels || {}, value);
                        break;
                }
                break;
            case 'histogram':
            case 'summary':
                metric.observe(labels || {}, value);
                break;
        }
    }
    /**
     * Get metrics in Prometheus format
     */
    async getMetrics() {
        return await this.registry.metrics();
    }
    /**
     * Get metrics as JSON
     */
    async getMetricsAsJson() {
        return await this.registry.getMetricsAsJSON();
    }
    /**
     * Get snapshots
     */
    getSnapshots(limit) {
        if (limit) {
            return this.snapshots.slice(-limit);
        }
        return [...this.snapshots];
    }
    /**
     * Get latest snapshot
     */
    getLatestSnapshot() {
        return this.snapshots[this.snapshots.length - 1] || null;
    }
    /**
     * Reset all metrics
     */
    reset() {
        this.registry.resetMetrics();
        this.snapshots = [];
        this.emit('metrics:reset');
    }
    /**
     * Dispose and cleanup
     */
    dispose() {
        if (this.aggregateTimer) {
            clearInterval(this.aggregateTimer);
        }
        this.removeAllListeners();
    }
}
exports.MetricsCollector = MetricsCollector;
exports.default = MetricsCollector;
//# sourceMappingURL=MetricsCollector.js.map