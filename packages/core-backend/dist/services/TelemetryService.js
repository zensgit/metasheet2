"use strict";
/**
 * OpenTelemetry Service
 * Provides distributed tracing, metrics, and structured logging
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
exports.TelemetryService = exports.MetricsCollector = exports.StructuredLogger = exports.TraceContext = void 0;
exports.getTelemetry = getTelemetry;
exports.Trace = Trace;
// Soft dependencies: these imports may be unavailable in minimal setups.
// We keep types via 'any' and only load real modules in initialize().
let NodeSDK, getNodeAutoInstrumentations, Resource, SemanticResourceAttributes;
let PrometheusExporter, PeriodicExportingMetricReader, JaegerExporter, BatchSpanProcessor;
let otelApi;
// Minimal placeholders (no-op) to allow structured logger usage before init
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const trace = {
    getTracer: (_n) => ({
        startActiveSpan: (_name, _opts, fn) => fn({
            addEvent: () => { },
            setStatus: () => { },
            end: () => { },
            spanContext: () => ({ traceId: '', spanId: '' }),
            parentSpanId: ''
        })
    }),
    // no-op placeholders before real API is loaded
    getActiveSpan: () => null,
    setSpanContext: (_ctx, _spanCtx) => ({})
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const context = { active: () => ({}), with: (_s, fn) => fn(), setSpan: (_a, _b) => ({}) };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpanStatusCode = { OK: 1, ERROR: 2 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpanKind = { INTERNAL: 1, SERVER: 2 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const metrics = { getMeter: (_n) => ({ createHistogram: () => ({ record: () => { } }), createCounter: () => ({ add: () => { } }), createUpDownCounter: () => ({ add: () => { } }), createObservableGauge: () => ({ addCallback: () => { } }) }) };
const logger_1 = require("../core/logger");
const crypto = __importStar(require("crypto"));
const logger = new logger_1.Logger('TelemetryService');
/**
 * Context propagation for distributed tracing
 */
class TraceContext {
    static TRACE_HEADER = 'x-trace-id';
    static SPAN_HEADER = 'x-span-id';
    static PARENT_HEADER = 'x-parent-span-id';
    static extract(headers) {
        const traceId = headers[this.TRACE_HEADER];
        const spanId = headers[this.SPAN_HEADER];
        if (!traceId || !spanId) {
            return undefined;
        }
        return {
            traceId,
            spanId,
            traceFlags: 1,
            isRemote: true
        };
    }
    static inject(span) {
        const spanContext = span.spanContext();
        return {
            [this.TRACE_HEADER]: spanContext.traceId,
            [this.SPAN_HEADER]: spanContext.spanId,
            [this.PARENT_HEADER]: span.parentSpanId || ''
        };
    }
}
exports.TraceContext = TraceContext;
/**
 * Structured logger with trace context
 */
class StructuredLogger {
    name;
    telemetry;
    tracer;
    correlationId;
    constructor(name, telemetry) {
        this.name = name;
        this.telemetry = telemetry;
        this.tracer = trace.getTracer(name);
        this.correlationId = crypto.randomUUID();
    }
    getContext() {
        const span = trace?.getActiveSpan?.();
        const spanContext = span?.spanContext();
        return {
            timestamp: new Date().toISOString(),
            service: this.telemetry.config.serviceName,
            environment: this.telemetry.config.environment,
            logger: this.name,
            correlationId: this.correlationId,
            traceId: spanContext?.traceId,
            spanId: spanContext?.spanId,
            parentSpanId: span?.parentSpanId
        };
    }
    log(level, message, metadata) {
        const logEntry = {
            ...this.getContext(),
            level,
            message,
            ...metadata
        };
        // Output structured log
        console.log(JSON.stringify(logEntry));
        // Add event to span if active
        const span = trace?.getActiveSpan?.();
        span?.addEvent(message, {
            level,
            ...metadata
        });
    }
    debug(message, metadata) {
        this.log('debug', message, metadata);
    }
    info(message, metadata) {
        this.log('info', message, metadata);
    }
    warn(message, metadata) {
        this.log('warn', message, metadata);
    }
    error(message, error, metadata) {
        const errorData = error ? {
            error: {
                name: error.name,
                message: error.message,
                stack: error.stack
            }
        } : {};
        this.log('error', message, {
            ...errorData,
            ...metadata
        });
        // Record exception in span
        const span = trace?.getActiveSpan?.();
        if (span && error) {
            span.recordException(error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error.message
            });
        }
    }
    setCorrelationId(id) {
        this.correlationId = id;
    }
}
exports.StructuredLogger = StructuredLogger;
/**
 * Custom metrics collectors
 */
class MetricsCollector {
    httpRequestDuration;
    httpRequestTotal;
    dbQueryDuration;
    cacheHitRate;
    activeConnections;
    memoryUsage;
    constructor() {
        const meter = metrics.getMeter('metasheet-metrics');
        // HTTP metrics
        this.httpRequestDuration = meter.createHistogram('http_request_duration_ms', {
            description: 'HTTP request duration in milliseconds',
            unit: 'ms',
            // valueType: ValueType.DOUBLE
        });
        this.httpRequestTotal = meter.createCounter('http_requests_total', {
            description: 'Total number of HTTP requests'
        });
        // Database metrics
        this.dbQueryDuration = meter.createHistogram('db_query_duration_ms', {
            description: 'Database query duration in milliseconds',
            unit: 'ms',
            // valueType: ValueType.DOUBLE
        });
        // Cache metrics
        this.cacheHitRate = meter.createHistogram('cache_hit_rate', {
            description: 'Cache hit rate',
            // valueType: ValueType.DOUBLE
        });
        // System metrics
        this.activeConnections = meter.createUpDownCounter('active_connections', {
            description: 'Number of active connections'
        });
        this.memoryUsage = meter.createObservableGauge('memory_usage_bytes', {
            description: 'Memory usage in bytes'
        });
        // Register memory observer
        this.memoryUsage.addCallback((observableResult) => {
            const usage = process.memoryUsage();
            observableResult.observe(usage.heapUsed, { type: 'heap_used' });
            observableResult.observe(usage.heapTotal, { type: 'heap_total' });
            observableResult.observe(usage.rss, { type: 'rss' });
            observableResult.observe(usage.external, { type: 'external' });
        });
    }
    recordHttpRequest(method, path, statusCode, duration) {
        const labels = { method, path, status_code: statusCode.toString() };
        this.httpRequestDuration.record(duration, labels);
        this.httpRequestTotal.add(1, labels);
    }
    recordDbQuery(operation, table, duration, success) {
        this.dbQueryDuration.record(duration, {
            operation,
            table,
            success: success.toString()
        });
    }
    recordCacheOperation(operation, hit) {
        this.cacheHitRate.record(hit ? 1 : 0, { operation });
    }
    incrementConnections(delta) {
        this.activeConnections.add(delta);
    }
}
exports.MetricsCollector = MetricsCollector;
/**
 * Main Telemetry Service
 */
class TelemetryService {
    sdk = null;
    tracer;
    metricsCollector;
    loggers = new Map();
    initialized = false;
    config;
    constructor(config) {
        this.config = {
            serviceName: config?.serviceName || 'metasheet',
            serviceVersion: config?.serviceVersion || process.env.VERSION || '1.0.0',
            environment: config?.environment || process.env.NODE_ENV || 'development',
            jaegerEndpoint: config?.jaegerEndpoint || 'http://localhost:14268/api/traces',
            prometheusPort: config?.prometheusPort || 9090,
            enableAutoInstrumentation: config?.enableAutoInstrumentation ?? true,
            enableMetrics: config?.enableMetrics ?? true,
            enableTracing: config?.enableTracing ?? true,
            samplingRate: config?.samplingRate ?? 1.0
        };
        this.tracer = trace.getTracer(this.config.serviceName);
        this.metricsCollector = new MetricsCollector();
    }
    async initialize() {
        if (this.initialized) {
            logger.warn('Telemetry already initialized');
            return;
        }
        try {
            // Load OpenTelemetry modules lazily
            try {
                // Lazy-load with require to avoid tsc module resolution
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                NodeSDK = require('@opentelemetry/sdk-node').NodeSDK;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                getNodeAutoInstrumentations = require('@opentelemetry/auto-instrumentations-node').getNodeAutoInstrumentations;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                Resource = require('@opentelemetry/resources').Resource;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                SemanticResourceAttributes = require('@opentelemetry/semantic-conventions').SemanticResourceAttributes;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                PrometheusExporter = require('@opentelemetry/exporter-prometheus').PrometheusExporter;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                PeriodicExportingMetricReader = require('@opentelemetry/sdk-metrics').PeriodicExportingMetricReader;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                JaegerExporter = require('@opentelemetry/exporter-jaeger').JaegerExporter;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                BatchSpanProcessor = require('@opentelemetry/sdk-trace-base').BatchSpanProcessor;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                otelApi = require('@opentelemetry/api');
            }
            catch (e) {
                logger.warn('OpenTelemetry modules not available; skipping telemetry init');
                return;
            }
            const resource = new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
                [SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
                [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment,
                [SemanticResourceAttributes.HOST_NAME]: require('os').hostname(),
                [SemanticResourceAttributes.PROCESS_PID]: process.pid
            });
            const instrumentations = this.config.enableAutoInstrumentation
                ? [getNodeAutoInstrumentations({
                        '@opentelemetry/instrumentation-fs': {
                            enabled: false // Disable fs instrumentation to reduce noise
                        }
                    })]
                : [];
            // Configure trace exporter
            let traceExporter = undefined;
            if (this.config.enableTracing) {
                traceExporter = new JaegerExporter({
                    endpoint: this.config.jaegerEndpoint
                });
            }
            // Configure metrics exporter
            let metricReader = undefined;
            if (this.config.enableMetrics) {
                const prometheusExporter = new PrometheusExporter({
                    port: this.config.prometheusPort
                }, () => {
                    logger.info(`Prometheus metrics server started on port ${this.config.prometheusPort}`);
                });
                metricReader = new PeriodicExportingMetricReader({
                    exporter: prometheusExporter,
                    exportIntervalMillis: 10000
                });
            }
            // Initialize SDK
            this.sdk = new NodeSDK({
                resource,
                instrumentations,
                traceExporter,
                metricReader
            });
            await this.sdk.start();
            this.initialized = true;
            logger.info('OpenTelemetry initialized', {
                serviceName: this.config.serviceName,
                environment: this.config.environment,
                tracingEnabled: this.config.enableTracing,
                metricsEnabled: this.config.enableMetrics
            });
        }
        catch (error) {
            logger.error('Failed to initialize OpenTelemetry', error);
            throw error;
        }
    }
    async shutdown() {
        if (!this.initialized || !this.sdk) {
            return;
        }
        try {
            await this.sdk.shutdown();
            this.initialized = false;
            logger.info('OpenTelemetry shut down successfully');
        }
        catch (error) {
            logger.error('Error shutting down OpenTelemetry', error);
        }
    }
    getTracer(name) {
        return trace.getTracer(name || this.config.serviceName);
    }
    getLogger(name) {
        if (!this.loggers.has(name)) {
            this.loggers.set(name, new StructuredLogger(name, this));
        }
        return this.loggers.get(name);
    }
    getMetrics() {
        return this.metricsCollector;
    }
    /**
     * Create a traced function wrapper
     */
    trace(fn, options) {
        const tracer = this.tracer;
        const spanName = options?.name || fn.name || 'anonymous';
        return (async function traced(...args) {
            return tracer.startActiveSpan(spanName, {
                kind: options?.kind || SpanKind.INTERNAL,
                attributes: options?.attributes
            }, async (span) => {
                try {
                    const result = await fn.apply(this, args);
                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                }
                catch (error) {
                    span.recordException(error);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: error.message
                    });
                    throw error;
                }
                finally {
                    span.end();
                }
            });
        });
    }
    /**
     * Decorator for tracing class methods
     */
    traceMethod(target, propertyName, descriptor) {
        const originalMethod = descriptor.value;
        const tracer = this.tracer;
        descriptor.value = async function (...args) {
            const spanName = `${target.constructor.name}.${propertyName}`;
            return tracer.startActiveSpan(spanName, async (span) => {
                try {
                    span.setAttributes({
                        'code.function': propertyName,
                        'code.namespace': target.constructor.name
                    });
                    const result = await originalMethod.apply(this, args);
                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                }
                catch (error) {
                    span.recordException(error);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: error.message
                    });
                    throw error;
                }
                finally {
                    span.end();
                }
            });
        };
        return descriptor;
    }
    /**
     * Express middleware for tracing HTTP requests
     */
    expressMiddleware() {
        const tracer = this.tracer;
        const metrics = this.metricsCollector;
        return (req, res, next) => {
            const startTime = Date.now();
            // Extract trace context from headers
            const parentContext = TraceContext.extract(req.headers);
            // Start span
            const span = tracer.startSpan(`HTTP ${req.method} ${req.route?.path || req.path}`, {
                kind: SpanKind.SERVER,
                attributes: {
                    'http.method': req.method,
                    'http.url': req.url,
                    'http.target': req.path,
                    'http.host': req.hostname,
                    'http.scheme': req.protocol,
                    'http.user_agent': req.get('user-agent'),
                    'net.peer.ip': req.ip
                }
            }, parentContext ? trace.setSpanContext(context.active(), parentContext) : undefined);
            // Inject trace context into response headers
            const traceHeaders = TraceContext.inject(span);
            Object.entries(traceHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            // Store span in request for later use
            req.span = span;
            // Hook response end
            const originalEnd = res.end;
            res.end = function (...args) {
                // Set final span attributes
                span.setAttributes({
                    'http.status_code': res.statusCode,
                    'http.response.size': res.get('content-length') || 0
                });
                // Set span status based on HTTP status
                if (res.statusCode >= 400) {
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: `HTTP ${res.statusCode}`
                    });
                }
                else {
                    span.setStatus({ code: SpanStatusCode.OK });
                }
                // Record metrics
                const duration = Date.now() - startTime;
                metrics.recordHttpRequest(req.method, req.route?.path || req.path, res.statusCode, duration);
                // End span
                span.end();
                // Call original end
                return originalEnd.apply(this, args);
            };
            context.with(trace.setSpan(context.active(), span), () => {
                next();
            });
        };
    }
}
exports.TelemetryService = TelemetryService;
// Export singleton instance
let telemetryInstance = null;
function getTelemetry(config) {
    if (!telemetryInstance) {
        telemetryInstance = new TelemetryService(config);
    }
    return telemetryInstance;
}
// Export decorators
function Trace(options) {
    return function (target, propertyName, descriptor) {
        const telemetry = getTelemetry();
        return telemetry.traceMethod(target, propertyName, descriptor);
    };
}
exports.default = getTelemetry;
//# sourceMappingURL=TelemetryService.js.map