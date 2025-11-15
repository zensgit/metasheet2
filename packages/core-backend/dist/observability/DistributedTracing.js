"use strict";
/**
 * Distributed Tracing System
 * OpenTelemetry-based tracing for distributed system observability
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DistributedTracing = void 0;
const sdk_trace_node_1 = require("@opentelemetry/sdk-trace-node");
const resources_1 = require("@opentelemetry/resources");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const sdk_trace_base_1 = require("@opentelemetry/sdk-trace-base");
const exporter_jaeger_1 = require("@opentelemetry/exporter-jaeger");
const exporter_zipkin_1 = require("@opentelemetry/exporter-zipkin");
const instrumentation_1 = require("@opentelemetry/instrumentation");
const instrumentation_http_1 = require("@opentelemetry/instrumentation-http");
const instrumentation_express_1 = require("@opentelemetry/instrumentation-express");
const instrumentation_ioredis_1 = require("@opentelemetry/instrumentation-ioredis");
const api_1 = require("@opentelemetry/api");
const eventemitter3_1 = require("eventemitter3");
class DistributedTracing extends eventemitter3_1.EventEmitter {
    provider;
    tracer;
    config;
    activeSpans = new Map();
    spanMetrics = {
        created: 0,
        completed: 0,
        errors: 0,
        active: 0
    };
    constructor(config) {
        super();
        this.config = config;
        this.provider = this.initializeProvider();
        this.tracer = api_1.trace.getTracer(config.serviceName, config.serviceVersion);
        this.setupInstrumentations();
        this.emit('tracing:initialized', config);
    }
    /**
     * Initialize the tracer provider
     */
    initializeProvider() {
        const resource = resources_1.Resource.default().merge(new resources_1.Resource({
            [semantic_conventions_1.SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
            [semantic_conventions_1.SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
            [semantic_conventions_1.SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment
        }));
        const provider = new sdk_trace_node_1.NodeTracerProvider({
            resource,
            forceFlushTimeoutMillis: 10000
        });
        // Add exporters
        this.setupExporters(provider);
        // Register the provider
        provider.register();
        return provider;
    }
    /**
     * Setup span exporters
     */
    setupExporters(provider) {
        const exporters = this.config.exporters || {};
        // Console exporter for development
        if (exporters.console) {
            const consoleExporter = new sdk_trace_base_1.ConsoleSpanExporter();
            provider.addSpanProcessor(new sdk_trace_base_1.SimpleSpanProcessor(consoleExporter));
        }
        // Jaeger exporter
        if (exporters.jaeger) {
            const jaegerExporter = new exporter_jaeger_1.JaegerExporter({
                endpoint: exporters.jaeger.endpoint,
                username: exporters.jaeger.username,
                password: exporters.jaeger.password
            });
            provider.addSpanProcessor(new sdk_trace_base_1.BatchSpanProcessor(jaegerExporter));
        }
        // Zipkin exporter
        if (exporters.zipkin) {
            const zipkinExporter = new exporter_zipkin_1.ZipkinExporter({
                url: exporters.zipkin.url,
                serviceName: exporters.zipkin.serviceName || this.config.serviceName
            });
            provider.addSpanProcessor(new sdk_trace_base_1.BatchSpanProcessor(zipkinExporter));
        }
        // Custom exporter
        if (exporters.custom) {
            provider.addSpanProcessor(new sdk_trace_base_1.BatchSpanProcessor(exporters.custom));
        }
    }
    /**
     * Setup auto-instrumentations
     */
    setupInstrumentations() {
        const instrumentations = this.config.instrumentations || {};
        const instrumentationList = [];
        if (instrumentations.http !== false) {
            instrumentationList.push(new instrumentation_http_1.HttpInstrumentation({
                requestHook: (span, request) => {
                    span.setAttributes({
                        'http.request.body.size': request.headers['content-length'] || 0
                    });
                },
                responseHook: (span, response) => {
                    span.setAttributes({
                        'http.response.body.size': response.headers?.['content-length'] || 0
                    });
                },
                ignoreIncomingPaths: ['/health', '/metrics', '/metrics/prom']
            }));
        }
        if (instrumentations.express !== false) {
            instrumentationList.push(new instrumentation_express_1.ExpressInstrumentation({
                requestHook: (span, info) => {
                    span.setAttributes({
                        'express.route': info.route,
                        'express.params': JSON.stringify(info.request.params)
                    });
                }
            }));
        }
        if (instrumentations.redis !== false) {
            instrumentationList.push(new instrumentation_ioredis_1.IORedisInstrumentation({
                requestHook: (span, info) => {
                    span.setAttributes({
                        'redis.command': info.command.name,
                        'redis.key': info.command.args?.[0]
                    });
                }
            }));
        }
        (0, instrumentation_1.registerInstrumentations)({
            instrumentations: instrumentationList
        });
    }
    /**
     * Start a new span
     */
    startSpan(name, options) {
        const spanOptions = {
            kind: options?.kind || api_1.SpanKind.INTERNAL,
            attributes: options?.attributes
        };
        let span;
        if (options?.parent) {
            const parentContext = 'spanContext' in options.parent
                ? api_1.trace.setSpan(api_1.context.active(), options.parent)
                : options.parent;
            span = this.tracer.startSpan(name, spanOptions, parentContext);
        }
        else {
            span = this.tracer.startSpan(name, spanOptions);
        }
        const spanId = span.spanContext().spanId;
        this.activeSpans.set(spanId, span);
        this.spanMetrics.created++;
        this.spanMetrics.active++;
        this.emit('span:started', {
            name,
            spanId,
            traceId: span.spanContext().traceId
        });
        return span;
    }
    /**
     * End a span
     */
    endSpan(span, status) {
        if (status) {
            span.setStatus(status);
        }
        span.end();
        const spanId = span.spanContext().spanId;
        this.activeSpans.delete(spanId);
        this.spanMetrics.completed++;
        this.spanMetrics.active--;
        if (status?.code === api_1.SpanStatusCode.ERROR) {
            this.spanMetrics.errors++;
        }
        this.emit('span:ended', {
            spanId,
            traceId: span.spanContext().traceId,
            status
        });
    }
    /**
     * Create a traced function
     */
    traceFunction(name, fn, options) {
        return ((...args) => {
            const span = this.startSpan(name, options);
            try {
                const result = fn(...args);
                if (result instanceof Promise) {
                    return result
                        .then((value) => {
                        this.endSpan(span, { code: api_1.SpanStatusCode.OK });
                        return value;
                    })
                        .catch((error) => {
                        span.recordException(error);
                        this.endSpan(span, {
                            code: api_1.SpanStatusCode.ERROR,
                            message: error.message
                        });
                        throw error;
                    });
                }
                this.endSpan(span, { code: api_1.SpanStatusCode.OK });
                return result;
            }
            catch (error) {
                span.recordException(error);
                this.endSpan(span, {
                    code: api_1.SpanStatusCode.ERROR,
                    message: error.message
                });
                throw error;
            }
        });
    }
    /**
     * Create a traced async function
     */
    traceAsyncFunction(name, fn, options) {
        return (async (...args) => {
            const span = this.startSpan(name, options);
            try {
                const result = await fn(...args);
                this.endSpan(span, { code: api_1.SpanStatusCode.OK });
                return result;
            }
            catch (error) {
                span.recordException(error);
                this.endSpan(span, {
                    code: api_1.SpanStatusCode.ERROR,
                    message: error.message
                });
                throw error;
            }
        });
    }
    /**
     * Trace HTTP request
     */
    async traceHttpRequest(method, url, handler, headers) {
        const span = this.startSpan(`HTTP ${method} ${url}`, {
            kind: api_1.SpanKind.CLIENT,
            attributes: {
                'http.method': method,
                'http.url': url,
                'http.headers': JSON.stringify(headers || {})
            }
        });
        try {
            const startTime = Date.now();
            const result = await handler();
            const duration = Date.now() - startTime;
            span.setAttributes({
                'http.status_code': result.status || 200,
                'http.response_time': duration
            });
            this.endSpan(span, { code: api_1.SpanStatusCode.OK });
            return result;
        }
        catch (error) {
            span.recordException(error);
            span.setAttributes({
                'http.error': error.message
            });
            this.endSpan(span, {
                code: api_1.SpanStatusCode.ERROR,
                message: error.message
            });
            throw error;
        }
    }
    /**
     * Trace database query
     */
    async traceDbQuery(operation, query, handler, params) {
        const span = this.startSpan(`DB ${operation}`, {
            kind: api_1.SpanKind.CLIENT,
            attributes: {
                'db.operation': operation,
                'db.statement': query,
                'db.params': JSON.stringify(params || [])
            }
        });
        try {
            const startTime = Date.now();
            const result = await handler();
            const duration = Date.now() - startTime;
            span.setAttributes({
                'db.rows_affected': result.rowCount || 0,
                'db.duration': duration
            });
            this.endSpan(span, { code: api_1.SpanStatusCode.OK });
            return result;
        }
        catch (error) {
            span.recordException(error);
            span.setAttributes({
                'db.error': error.message
            });
            this.endSpan(span, {
                code: api_1.SpanStatusCode.ERROR,
                message: error.message
            });
            throw error;
        }
    }
    /**
     * Add event to current span
     */
    addEvent(name, attributes, timestamp) {
        const span = api_1.trace.getActiveSpan();
        if (span) {
            span.addEvent(name, attributes, timestamp);
        }
    }
    /**
     * Set attributes on current span
     */
    setAttributes(attributes) {
        const span = api_1.trace.getActiveSpan();
        if (span) {
            span.setAttributes(attributes);
        }
    }
    /**
     * Set baggage
     */
    setBaggage(key, value) {
        const baggage = api_1.context.active().getValue(Symbol.for('OpenTelemetry Baggage'));
        if (baggage) {
            baggage.setEntry(key, { value });
        }
    }
    /**
     * Get baggage
     */
    getBaggage(key) {
        const baggage = api_1.context.active().getValue(Symbol.for('OpenTelemetry Baggage'));
        if (baggage) {
            const entry = baggage.getEntry(key);
            return entry?.value;
        }
        return undefined;
    }
    /**
     * Extract trace context from headers
     */
    extractTraceContext(headers) {
        const traceParent = headers['traceparent'] || headers['Traceparent'];
        if (!traceParent)
            return null;
        const parts = traceParent.split('-');
        if (parts.length !== 4)
            return null;
        return {
            traceId: parts[1],
            spanId: parts[2],
            flags: parseInt(parts[3], 16),
            state: headers['tracestate'] || headers['Tracestate']
        };
    }
    /**
     * Inject trace context into headers
     */
    injectTraceContext(headers) {
        const span = api_1.trace.getActiveSpan();
        if (!span)
            return headers;
        const spanContext = span.spanContext();
        headers['traceparent'] = `00-${spanContext.traceId}-${spanContext.spanId}-0${spanContext.traceFlags}`;
        return headers;
    }
    /**
     * Create child span
     */
    createChildSpan(name, parentSpan, options) {
        return this.startSpan(name, {
            ...options,
            parent: parentSpan
        });
    }
    /**
     * Get active span
     */
    getActiveSpan() {
        return api_1.trace.getActiveSpan();
    }
    /**
     * Get span by ID
     */
    getSpan(spanId) {
        return this.activeSpans.get(spanId);
    }
    /**
     * Get metrics
     */
    getMetrics() {
        return {
            ...this.spanMetrics,
            errorRate: this.spanMetrics.completed > 0
                ? (this.spanMetrics.errors / this.spanMetrics.completed) * 100
                : 0
        };
    }
    /**
     * Force flush all spans
     */
    async flush() {
        await this.provider.forceFlush();
    }
    /**
     * Shutdown tracing
     */
    async shutdown() {
        // End all active spans
        for (const [spanId, span] of this.activeSpans) {
            this.endSpan(span, {
                code: api_1.SpanStatusCode.ERROR,
                message: 'Shutdown forced'
            });
        }
        await this.provider.shutdown();
        this.removeAllListeners();
        this.emit('tracing:shutdown');
    }
}
exports.DistributedTracing = DistributedTracing;
exports.default = DistributedTracing;
//# sourceMappingURL=DistributedTracing.js.map