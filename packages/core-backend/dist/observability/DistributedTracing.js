/**
 * Distributed Tracing System
 * OpenTelemetry-based tracing for distributed system observability
 */
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { EventEmitter } from 'eventemitter3';
export class DistributedTracing extends EventEmitter {
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
        this.tracer = trace.getTracer(config.serviceName, config.serviceVersion);
        this.setupInstrumentations();
        this.emit('tracing:initialized', config);
    }
    /**
     * Initialize the tracer provider
     */
    initializeProvider() {
        const resource = Resource.default().merge(new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
            [SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
            [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment
        }));
        const provider = new NodeTracerProvider({
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
            const consoleExporter = new ConsoleSpanExporter();
            provider.addSpanProcessor(new SimpleSpanProcessor(consoleExporter));
        }
        // Jaeger exporter
        if (exporters.jaeger) {
            const jaegerExporter = new JaegerExporter({
                endpoint: exporters.jaeger.endpoint,
                username: exporters.jaeger.username,
                password: exporters.jaeger.password
            });
            provider.addSpanProcessor(new BatchSpanProcessor(jaegerExporter));
        }
        // Zipkin exporter
        if (exporters.zipkin) {
            const zipkinExporter = new ZipkinExporter({
                url: exporters.zipkin.url,
                serviceName: exporters.zipkin.serviceName || this.config.serviceName
            });
            provider.addSpanProcessor(new BatchSpanProcessor(zipkinExporter));
        }
        // Custom exporter
        if (exporters.custom) {
            provider.addSpanProcessor(new BatchSpanProcessor(exporters.custom));
        }
    }
    /**
     * Setup auto-instrumentations
     */
    setupInstrumentations() {
        const instrumentations = this.config.instrumentations || {};
        const instrumentationList = [];
        if (instrumentations.http !== false) {
            instrumentationList.push(new HttpInstrumentation({
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
            instrumentationList.push(new ExpressInstrumentation({
                requestHook: (span, info) => {
                    span.setAttributes({
                        'express.route': info.route,
                        'express.params': JSON.stringify(info.request.params)
                    });
                }
            }));
        }
        if (instrumentations.redis !== false) {
            instrumentationList.push(new IORedisInstrumentation({
                requestHook: (span, info) => {
                    span.setAttributes({
                        'redis.command': info.command.name,
                        'redis.key': info.command.args?.[0]
                    });
                }
            }));
        }
        registerInstrumentations({
            instrumentations: instrumentationList
        });
    }
    /**
     * Start a new span
     */
    startSpan(name, options) {
        const spanOptions = {
            kind: options?.kind || SpanKind.INTERNAL,
            attributes: options?.attributes
        };
        let span;
        if (options?.parent) {
            const parentContext = 'spanContext' in options.parent
                ? trace.setSpan(context.active(), options.parent)
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
        if (status?.code === SpanStatusCode.ERROR) {
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
                        this.endSpan(span, { code: SpanStatusCode.OK });
                        return value;
                    })
                        .catch((error) => {
                        span.recordException(error);
                        this.endSpan(span, {
                            code: SpanStatusCode.ERROR,
                            message: error.message
                        });
                        throw error;
                    });
                }
                this.endSpan(span, { code: SpanStatusCode.OK });
                return result;
            }
            catch (error) {
                span.recordException(error);
                this.endSpan(span, {
                    code: SpanStatusCode.ERROR,
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
                this.endSpan(span, { code: SpanStatusCode.OK });
                return result;
            }
            catch (error) {
                span.recordException(error);
                this.endSpan(span, {
                    code: SpanStatusCode.ERROR,
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
            kind: SpanKind.CLIENT,
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
            this.endSpan(span, { code: SpanStatusCode.OK });
            return result;
        }
        catch (error) {
            span.recordException(error);
            span.setAttributes({
                'http.error': error.message
            });
            this.endSpan(span, {
                code: SpanStatusCode.ERROR,
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
            kind: SpanKind.CLIENT,
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
            this.endSpan(span, { code: SpanStatusCode.OK });
            return result;
        }
        catch (error) {
            span.recordException(error);
            span.setAttributes({
                'db.error': error.message
            });
            this.endSpan(span, {
                code: SpanStatusCode.ERROR,
                message: error.message
            });
            throw error;
        }
    }
    /**
     * Add event to current span
     */
    addEvent(name, attributes, timestamp) {
        const span = trace.getActiveSpan();
        if (span) {
            span.addEvent(name, attributes, timestamp);
        }
    }
    /**
     * Set attributes on current span
     */
    setAttributes(attributes) {
        const span = trace.getActiveSpan();
        if (span) {
            span.setAttributes(attributes);
        }
    }
    /**
     * Set baggage
     */
    setBaggage(key, value) {
        const baggage = context.active().getValue(Symbol.for('OpenTelemetry Baggage'));
        if (baggage) {
            baggage.setEntry(key, { value });
        }
    }
    /**
     * Get baggage
     */
    getBaggage(key) {
        const baggage = context.active().getValue(Symbol.for('OpenTelemetry Baggage'));
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
        const span = trace.getActiveSpan();
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
        return trace.getActiveSpan();
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
                code: SpanStatusCode.ERROR,
                message: 'Shutdown forced'
            });
        }
        await this.provider.shutdown();
        this.removeAllListeners();
        this.emit('tracing:shutdown');
    }
}
export default DistributedTracing;
//# sourceMappingURL=DistributedTracing.js.map