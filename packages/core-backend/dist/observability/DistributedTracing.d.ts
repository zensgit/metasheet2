/**
 * Distributed Tracing System
 * OpenTelemetry-based tracing for distributed system observability
 */
import { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Span, SpanKind, SpanStatus, SpanStatusCode, Context } from '@opentelemetry/api';
import { EventEmitter } from 'eventemitter3';
export interface TracingConfig {
    serviceName: string;
    serviceVersion: string;
    environment: string;
    exporters?: {
        console?: boolean;
        jaeger?: {
            endpoint: string;
            username?: string;
            password?: string;
        };
        zipkin?: {
            url: string;
            serviceName?: string;
        };
        custom?: SpanExporter;
    };
    sampling?: {
        probability: number;
    };
    propagators?: string[];
    instrumentations?: {
        http?: boolean;
        express?: boolean;
        database?: boolean;
        redis?: boolean;
        grpc?: boolean;
    };
}
export interface TraceContext {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    flags: number;
    state?: string;
    baggage?: Record<string, string>;
}
export interface SpanMetadata {
    name: string;
    kind: SpanKind;
    attributes?: Record<string, any>;
    events?: Array<{
        name: string;
        attributes?: Record<string, any>;
        timestamp?: number;
    }>;
    links?: Array<{
        context: TraceContext;
        attributes?: Record<string, any>;
    }>;
    status?: {
        code: SpanStatusCode;
        message?: string;
    };
}
export declare class DistributedTracing extends EventEmitter {
    private provider;
    private tracer;
    private config;
    private activeSpans;
    private spanMetrics;
    constructor(config: TracingConfig);
    /**
     * Initialize the tracer provider
     */
    private initializeProvider;
    /**
     * Setup span exporters
     */
    private setupExporters;
    /**
     * Setup auto-instrumentations
     */
    private setupInstrumentations;
    /**
     * Start a new span
     */
    startSpan(name: string, options?: {
        kind?: SpanKind;
        attributes?: Record<string, any>;
        parent?: Context | Span;
    }): Span;
    /**
     * End a span
     */
    endSpan(span: Span, status?: SpanStatus): void;
    /**
     * Create a traced function
     */
    traceFunction<T extends (...args: any[]) => any>(name: string, fn: T, options?: {
        kind?: SpanKind;
        attributes?: Record<string, any>;
    }): T;
    /**
     * Create a traced async function
     */
    traceAsyncFunction<T extends (...args: any[]) => Promise<any>>(name: string, fn: T, options?: {
        kind?: SpanKind;
        attributes?: Record<string, any>;
    }): T;
    /**
     * Trace HTTP request
     */
    traceHttpRequest(method: string, url: string, handler: () => Promise<any>, headers?: Record<string, string>): Promise<any>;
    /**
     * Trace database query
     */
    traceDbQuery(operation: string, query: string, handler: () => Promise<any>, params?: any[]): Promise<any>;
    /**
     * Add event to current span
     */
    addEvent(name: string, attributes?: Record<string, any>, timestamp?: number): void;
    /**
     * Set attributes on current span
     */
    setAttributes(attributes: Record<string, any>): void;
    /**
     * Set baggage
     */
    setBaggage(key: string, value: string): void;
    /**
     * Get baggage
     */
    getBaggage(key: string): string | undefined;
    /**
     * Extract trace context from headers
     */
    extractTraceContext(headers: Record<string, string>): TraceContext | null;
    /**
     * Inject trace context into headers
     */
    injectTraceContext(headers: Record<string, string>): Record<string, string>;
    /**
     * Create child span
     */
    createChildSpan(name: string, parentSpan: Span, options?: {
        kind?: SpanKind;
        attributes?: Record<string, any>;
    }): Span;
    /**
     * Get active span
     */
    getActiveSpan(): Span | undefined;
    /**
     * Get span by ID
     */
    getSpan(spanId: string): Span | undefined;
    /**
     * Get metrics
     */
    getMetrics(): {
        created: number;
        completed: number;
        errors: number;
        active: number;
        errorRate: number;
    };
    /**
     * Force flush all spans
     */
    flush(): Promise<void>;
    /**
     * Shutdown tracing
     */
    shutdown(): Promise<void>;
}
export default DistributedTracing;
//# sourceMappingURL=DistributedTracing.d.ts.map