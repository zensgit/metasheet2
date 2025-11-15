/**
 * OpenTelemetry Service
 * Provides distributed tracing, metrics, and structured logging
 */
type Tracer = any;
type Span = any;
type SpanContext = any;
export interface TelemetryConfig {
    serviceName?: string;
    serviceVersion?: string;
    environment?: string;
    jaegerEndpoint?: string;
    prometheusPort?: number;
    enableAutoInstrumentation?: boolean;
    enableMetrics?: boolean;
    enableTracing?: boolean;
    samplingRate?: number;
}
/**
 * Context propagation for distributed tracing
 */
export declare class TraceContext {
    private static readonly TRACE_HEADER;
    private static readonly SPAN_HEADER;
    private static readonly PARENT_HEADER;
    static extract(headers: Record<string, string>): SpanContext | undefined;
    static inject(span: Span): Record<string, string>;
}
/**
 * Structured logger with trace context
 */
export declare class StructuredLogger {
    private name;
    private telemetry;
    private tracer;
    private correlationId;
    constructor(name: string, telemetry: TelemetryService);
    private getContext;
    log(level: string, message: string, metadata?: any): void;
    debug(message: string, metadata?: any): void;
    info(message: string, metadata?: any): void;
    warn(message: string, metadata?: any): void;
    error(message: string, error?: Error, metadata?: any): void;
    setCorrelationId(id: string): void;
}
/**
 * Custom metrics collectors
 */
export declare class MetricsCollector {
    private httpRequestDuration;
    private httpRequestTotal;
    private dbQueryDuration;
    private cacheHitRate;
    private activeConnections;
    private memoryUsage;
    constructor();
    recordHttpRequest(method: string, path: string, statusCode: number, duration: number): void;
    recordDbQuery(operation: string, table: string, duration: number, success: boolean): void;
    recordCacheOperation(operation: string, hit: boolean): void;
    incrementConnections(delta: number): void;
}
/**
 * Main Telemetry Service
 */
export declare class TelemetryService {
    private sdk;
    private tracer;
    private metricsCollector;
    private loggers;
    private initialized;
    readonly config: TelemetryConfig;
    constructor(config?: TelemetryConfig);
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    getTracer(name?: string): Tracer;
    getLogger(name: string): StructuredLogger;
    getMetrics(): MetricsCollector;
    /**
     * Create a traced function wrapper
     */
    trace<T extends (...args: any[]) => any>(fn: T, options?: {
        name?: string;
        kind?: any;
        attributes?: Record<string, any>;
    }): T;
    /**
     * Decorator for tracing class methods
     */
    traceMethod(target: any, propertyName: string, descriptor: PropertyDescriptor): PropertyDescriptor;
    /**
     * Express middleware for tracing HTTP requests
     */
    expressMiddleware(): (req: any, res: any, next: any) => void;
}
export declare function getTelemetry(config?: TelemetryConfig): TelemetryService;
export declare function Trace(options?: {
    name?: string;
    kind?: any;
}): (target: any, propertyName: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
export default getTelemetry;
//# sourceMappingURL=TelemetryService.d.ts.map